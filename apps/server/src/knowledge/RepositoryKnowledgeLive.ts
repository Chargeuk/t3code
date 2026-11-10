import { SecretResolver } from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as Knowledge from "../../../../packages/contracts/src/knowledge.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Chroma from "./Chroma.ts";
import * as Repository from "./KnowledgeRepository.ts";
import { RepositoryKnowledge } from "./RepositoryKnowledge.ts";
import { parseAstSource } from "./ast/parser.ts";
import { chunkTextStream, hashChunk } from "./chunker.ts";
import * as Discovery from "./discovery.ts";
import * as Embeddings from "./embeddings/EmbeddingModels.ts";

type KnowledgeConfig = Effect.Success<
  Settings.ServerSettingsService["Service"]["getSettings"]
>["knowledge"];
const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const terminal = Schema.is(Knowledge.KnowledgeTerminalRun);
const astExtensions = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "cs",
  "rs",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hxx",
  "h",
]);

function operationError(cause: unknown): Knowledge.KnowledgeError {
  if (Schema.is(Knowledge.KnowledgeError)(cause)) return cause;
  return new Knowledge.KnowledgeOperationError({
    code: Schema.is(Chroma.ChromaError)(cause) ? "vector_store_failed" : "persistence_failed",
    cause,
  });
}

function runFailure(cause: unknown): Knowledge.KnowledgeRunFailure {
  const error = operationError(cause);
  return {
    code: error._tag === "KnowledgeOperationError" ? error.code : "embedding_unavailable",
    message: error.message,
    relPath: error._tag === "KnowledgeOperationError" ? (error.relPath ?? null) : null,
  };
}

const make = Effect.gen(function* () {
  const repository = yield* Repository.KnowledgeRepository;
  const settings = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver;
  const models = yield* Embeddings.EmbeddingModels;
  const random = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const discoveryContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | WorkspacePaths.WorkspacePaths | VcsProcess.VcsProcess
  >();
  const vectors = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  const wake = yield* Queue.sliding<void>(1);
  const active = yield* Ref.make<{
    readonly runId: Knowledge.KnowledgeRunId;
    readonly fiber: Fiber.Fiber<void, Knowledge.KnowledgeError>;
  } | null>(null);
  const publish = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  const config = settings.getSettings.pipe(
    Effect.map((value) => value.knowledge),
    Effect.mapError(operationError),
  );
  const findRoot = Effect.fn("RepositoryKnowledge.findRoot")((root: string) =>
    Discovery.findRepoRoot(root).pipe(Effect.provide(discoveryContext)),
  );
  const chromaFor = Effect.fn("RepositoryKnowledge.chroma")(function* (url: string) {
    return Context.get(yield* Layer.build(Chroma.layer({ url })), Chroma.Chroma);
  });
  const embeddingConfig = Effect.fn("RepositoryKnowledge.embeddingConfig")(function* (
    value: KnowledgeConfig,
    openai: boolean,
  ) {
    const key = openai
      ? yield* requireSettingsSecret(secrets, value.openaiApiKey).pipe(
          Effect.mapError(
            (cause) =>
              new Knowledge.KnowledgeOperationError({ code: "embedding_unavailable", cause }),
          ),
        )
      : undefined;
    return {
      lmStudioBaseUrl: value.lmStudioBaseUrl,
      ...(key ? { openaiApiKey: key } : {}),
      ...(value.openaiBaseUrl ? { openaiBaseUrl: value.openaiBaseUrl } : {}),
    };
  });
  const assertSelection = Effect.fn("RepositoryKnowledge.assertSelection")(function* (
    selection: Knowledge.KnowledgeEmbeddingSelection,
  ) {
    const identity = yield* repository.getEmbeddingIdentity();
    if (
      identity &&
      (identity.selection.provider !== selection.provider ||
        identity.selection.model !== selection.model)
    ) {
      return yield* new Knowledge.KnowledgeEmbeddingMismatchError({
        requested: selection,
        locked: identity,
      });
    }
    return identity;
  });
  const assertRunning = Effect.fn("RepositoryKnowledge.assertRunning")(function* (
    runId: Knowledge.KnowledgeRunId,
  ) {
    const run = yield* repository.getRun(runId);
    if (run.status !== "running") return yield* Effect.interrupt;
  });
  const withRunning = Effect.fn("RepositoryKnowledge.withRunning")(function* <A, E, R>(
    runId: Knowledge.KnowledgeRunId,
    mutation: Effect.Effect<A, E, R>,
  ) {
    // Await in-flight Chroma mutations before releasing the cancellation fence.
    return yield* vectors.withPermit(
      Effect.gen(function* () {
        yield* assertRunning(runId);
        return yield* mutation;
      }).pipe(Effect.uninterruptible),
    );
  });
  const sourceById = Effect.fn("RepositoryKnowledge.sourceById")(function* (
    sourceId: Knowledge.KnowledgeSourceId,
  ) {
    const source = yield* repository.resolve({ sourceId });
    if (!source)
      return yield* new Knowledge.KnowledgeNotFoundError({ entity: "source", id: sourceId });
    return source;
  });

  const cleanup = Effect.fn("RepositoryKnowledge.cleanup")(function* (
    run: Knowledge.KnowledgeRunSummary,
    chroma: Chroma.Chroma["Service"],
  ) {
    const result = yield* vectors
      .withPermit(
        Effect.gen(function* () {
          const current = yield* repository.getRun(run.runId);
          if (current.status !== "cleanup") return;
          if (current.cleanupIntent === "remove") {
            const removed = yield* chroma.removeSource(current.sourceId);
            yield* repository.clearIndexedContent({
              runId: current.runId,
              unlockEmbeddingIdentity: removed !== "retained",
              now: yield* timestamp,
            });
          } else {
            const removed = yield* chroma.cleanupRun({
              sourceId: current.sourceId,
              runId: current.runId,
            });
            if (removed !== "retained") yield* repository.unlockEmbeddingIdentity();
            yield* repository.finish({
              runId: current.runId,
              status: current.cleanupIntent === "cancel" ? "cancelled" : "failed",
              error: current.error,
              now: yield* timestamp,
            });
          }
          yield* publish;
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      const current = yield* repository.getRun(run.runId);
      if (current.status === "cleanup" && current.cleanupIntent) {
        yield* repository.beginCleanup({
          runId: run.runId,
          intent: current.cleanupIntent,
          error: {
            code: "cleanup_failed",
            message:
              "Indexed-content cleanup failed. Restore Chroma access and restart the server to finish cleanup.",
            relPath: null,
          },
          now: yield* timestamp,
        });
        yield* publish;
      }
    }
  });

  const ingest = Effect.fn("RepositoryKnowledge.ingest")(function* (
    run: Knowledge.KnowledgeRunSummary,
    value: KnowledgeConfig,
    chroma: Chroma.Chroma["Service"],
  ) {
    const source = yield* sourceById(run.sourceId);
    const selection = run.embedding;
    if (!selection)
      return yield* new Knowledge.KnowledgeOperationError({
        code: "embedding_unavailable",
        runId: run.runId,
        cause: new Error("Select a Knowledge embedding model in Settings."),
      });
    yield* assertRunning(run.runId);
    let identity = yield* vectors.withPermit(assertSelection(selection));
    // Retried attempts discard only writes carrying their stable run ID.
    const survivingChunks = yield* withRunning(
      run.runId,
      chroma
        .delete({ sourceId: source.sourceId, runId: run.runId })
        .pipe(Effect.andThen(chroma.count(source.sourceId))),
    );
    const found = yield* Discovery.discoverFiles(source.root, {
      includes: value.includes,
      excludes: value.excludes,
    }).pipe(Effect.provide(discoveryContext));
    if (found.root !== source.root)
      return yield* new Knowledge.KnowledgeOperationError({
        code: "source_unavailable",
        sourceId: source.sourceId,
        runId: run.runId,
        cause: new Error("The canonical repository root changed."),
      });
    const previous = yield* repository.files(source.sourceId);
    const discovered = yield* Effect.forEach(found.files, (file) =>
      Discovery.hashFile(file.absPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.map((fileHash) => ({ ...file, fileHash })),
      ),
    );
    const delta = Discovery.buildDeltaPlan({ previous, discovered });
    const changed = new Set([...delta.added, ...delta.changed].map((file) => file.relPath));
    const rebuildAst =
      source.astCoverage === null ||
      [...delta.added, ...delta.changed, ...delta.deleted].some((file) =>
        astExtensions.has(path.extname(file.relPath).slice(1).toLowerCase()),
      );
    const counts = {
      discoveredFiles: discovered.length,
      processedFiles: delta.unchanged.length,
      addedFiles: delta.added.length,
      changedFiles: delta.changed.length,
      deletedFiles: delta.deleted.length,
      unchangedFiles: delta.unchanged.length,
      chunks: survivingChunks,
      embeddedChunks: 0,
    };
    const progress = Effect.fn("RepositoryKnowledge.progress")(function* (
      stage: Knowledge.KnowledgeRunStage,
      currentFile: string | null,
    ) {
      yield* assertRunning(run.runId);
      if (
        yield* repository.progress({
          runId: run.runId,
          stage,
          currentFile,
          counts,
          embeddingIdentity: identity,
          now: yield* timestamp,
        })
      )
        yield* publish;
    });
    yield* progress("discovery", null);
    const model =
      changed.size > 0
        ? yield* models.resolve(
            selection,
            yield* embeddingConfig(value, selection.provider === "openai"),
          )
        : null;
    const astFiles: Repository.KnowledgeAstFile[] = [];
    const coverage: Knowledge.KnowledgeAstCoverage = {
      supportedFileCount: 0,
      skippedFileCount: 0,
      failedFileCount: 0,
      lastIndexedAt: yield* timestamp,
    };
    let supportedFileCount = 0;
    let skippedFileCount = 0;

    for (const deleted of delta.deleted) {
      yield* assertRunning(run.runId);
      const oldChunks = yield* chroma.get({
        sourceIds: [source.sourceId],
        relPath: deleted.relPath,
      });
      yield* withRunning(
        run.runId,
        chroma.delete({ sourceId: source.sourceId, relPath: deleted.relPath }),
      );
      counts.chunks = Math.max(0, counts.chunks - oldChunks.length);
    }
    for (const file of discovered) {
      yield* assertRunning(run.runId);
      if (!changed.has(file.relPath) && !rebuildAst) continue;
      const text = yield* fs.readFileString(file.absPath).pipe(
        Effect.mapError(
          (cause) =>
            new Knowledge.KnowledgeOperationError({
              code: "file_read_failed",
              sourceId: source.sourceId,
              runId: run.runId,
              relPath: file.relPath,
              cause,
            }),
        ),
      );
      const indexed = {
        sourceId: source.sourceId,
        runId: run.runId,
        relPath: file.relPath,
        fileHash: file.fileHash,
      };
      if (rebuildAst) {
        yield* progress("ast", file.relPath);
        const parsed = yield* parseAstSource({ ...indexed, root: source.root, text });
        if (parsed.status === "failed") {
          return yield* new Knowledge.KnowledgeOperationError({
            code: parsed.error.code,
            sourceId: source.sourceId,
            runId: run.runId,
            relPath: file.relPath,
            cause: new Error("AST parsing failed."),
          });
        }
        if (parsed.status === "skipped") skippedFileCount += 1;
        else {
          supportedFileCount += 1;
          astFiles.push({
            ...indexed,
            symbols: parsed.symbols,
            references: parsed.references,
            edges: parsed.edges,
            imports: { ...indexed, imports: parsed.imports.flatMap((module) => module.imports) },
          });
        }
      }
      if (!changed.has(file.relPath) || model === null) continue;
      const oldChunks = yield* chroma.get({ sourceIds: [source.sourceId], relPath: file.relPath });
      yield* withRunning(
        run.runId,
        chroma.delete({ sourceId: source.sourceId, relPath: file.relPath }),
      );
      counts.chunks = Math.max(0, counts.chunks - oldChunks.length);
      let batch: Knowledge.KnowledgeChunkDocument[] = [];
      let tokens = 0;
      const flush = Effect.fn("RepositoryKnowledge.embedBatch")(function* () {
        if (batch.length === 0) return;
        yield* assertRunning(run.runId);
        yield* progress("embedding", file.relPath);
        const input = batch;
        const embedded = yield* model.embedBatch(input.map((chunk) => chunk.text));
        const dimensions = embedded[0]?.length;
        if (
          embedded.length !== input.length ||
          !dimensions ||
          embedded.some(
            (vector) =>
              vector.length !== dimensions ||
              vector.some((component) => !Number.isFinite(component)),
          )
        ) {
          return yield* new Knowledge.KnowledgeOperationError({
            code: "embedding_dimensions_mismatch",
            runId: run.runId,
            cause: new Error("Invalid embedding batch shape."),
          });
        }
        yield* withRunning(
          run.runId,
          Effect.gen(function* () {
            identity = yield* repository.claimEmbeddingIdentity({ selection, dimensions });
            yield* chroma.upsert(
              input.map((chunk, index) => ({ chunk, vector: embedded[index]! })),
            );
          }),
        );
        counts.embeddedChunks += input.length;
        batch = [];
        tokens = 0;
        yield* progress("embedding", file.relPath);
      });
      yield* progress("chunking", file.relPath);
      yield* chunkTextStream(text, model, {
        fileInfo: { relPath: file.relPath, sizeBytes: file.size },
      }).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            yield* assertRunning(run.runId);
            if (
              batch.length >= model.effectiveBatchSize ||
              (selection.provider === "openai" && tokens + chunk.tokenCount > 300_000)
            )
              yield* flush();
            const chunkHash = hashChunk(file.relPath, chunk.chunkIndex, chunk.text);
            batch.push({
              ...indexed,
              ...chunk,
              chunkHash,
              chunkId: `${source.sourceId}:${chunkHash}`,
            });
            tokens += chunk.tokenCount;
            counts.chunks += 1;
          }),
        ),
      );
      yield* flush();
      counts.processedFiles += 1;
      yield* progress("embedding", file.relPath);
    }
    yield* withRunning(
      run.runId,
      Effect.gen(function* () {
        yield* assertSelection(selection);
        yield* repository.finalize({
          runId: run.runId,
          files: discovered.map((file) => ({
            sourceId: source.sourceId,
            runId: run.runId,
            relPath: file.relPath,
            fileHash: file.fileHash,
          })),
          ast: rebuildAst
            ? { files: astFiles, coverage: { ...coverage, supportedFileCount, skippedFileCount } }
            : null,
          counts,
          now: yield* timestamp,
        });
        yield* publish;
      }),
    );
  }, Effect.mapError(operationError));

  const processRun = Effect.fn("RepositoryKnowledge.processRun")(function* (
    run: Knowledge.KnowledgeRunSummary,
  ) {
    const prepared = yield* Effect.gen(function* () {
      const value = yield* config;
      return { value, chroma: yield* chromaFor(value.chromaUrl) };
    }).pipe(Effect.result);
    if (prepared._tag === "Failure") {
      yield* repository.beginCleanup({
        runId: run.runId,
        intent: run.cleanupIntent ?? "failure",
        error: runFailure(prepared.failure),
        now: yield* timestamp,
      });
      yield* publish;
      return;
    }
    const { value, chroma } = prepared.success;
    if (run.status === "cleanup") return yield* cleanup(run, chroma);
    const fiber = yield* ingest(run, value, chroma).pipe(Effect.forkChild);
    yield* Ref.set(active, { runId: run.runId, fiber });
    const result = yield* Fiber.await(fiber);
    yield* Ref.set(active, null);
    const current = yield* repository.getRun(run.runId);
    if (current.status === "running" && Exit.isFailure(result)) {
      yield* repository.beginCleanup({
        runId: run.runId,
        intent: "failure",
        error: runFailure(Cause.squash(result.cause)),
        now: yield* timestamp,
      });
      yield* publish;
    }
    const after = yield* repository.getRun(run.runId);
    if (after.status === "cleanup") yield* cleanup(after, chroma);
  }, Effect.scoped);

  const recovered = yield* repository.recover(yield* timestamp);
  const worker = Effect.gen(function* () {
    for (const run of recovered.filter((row) => row.status === "cleanup")) yield* processRun(run);
    while (true) {
      const run = yield* repository.claimOldest(yield* timestamp);
      if (run) {
        yield* publish;
        yield* processRun(run);
      } else yield* Queue.take(wake);
    }
  });
  yield* worker.pipe(Effect.forkScoped);

  const list: RepositoryKnowledge["Service"]["list"] = () => repository.list();
  const subscribe: RepositoryKnowledge["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(repository.list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => repository.list())),
        );
      }),
    );
  const resolve: RepositoryKnowledge["Service"]["resolve"] = Effect.fn(
    "RepositoryKnowledge.resolve",
  )(function* (input: Knowledge.KnowledgeResolveInput) {
    if ("sourceId" in input) {
      const source = yield* sourceById(input.sourceId);
      return { root: source.root, source };
    }
    const root = yield* findRoot(input.root);
    return { root, source: yield* repository.resolve({ root }) };
  });
  const admit: RepositoryKnowledge["Service"]["admit"] = Effect.fn("RepositoryKnowledge.admit")(
    function* (input: Knowledge.KnowledgeAdmitInput) {
      const target = yield* resolve(input.target);
      const root = "sourceId" in input.target ? yield* findRoot(target.root) : target.root;
      if (root !== target.root)
        return yield* new Knowledge.KnowledgeOperationError({
          code: "source_unavailable",
          cause: new Error("The canonical repository root changed."),
        });
      const value = yield* config;
      const admitted = yield* repository.admit({
        sourceId:
          target.source?.sourceId ?? Knowledge.KnowledgeSourceId.make(yield* random.uuidV4()),
        runId: Knowledge.KnowledgeRunId.make(yield* random.uuidV4()),
        root,
        operation: "ingest",
        embedding: value.embedding,
        now: yield* timestamp,
      });
      if (admitted.changed) {
        yield* publish;
        yield* signal;
      }
      return { run: admitted.run };
    },
  );
  const remove: RepositoryKnowledge["Service"]["remove"] = Effect.fn("RepositoryKnowledge.remove")(
    function* (input: Knowledge.KnowledgeRemoveInput) {
      const source = yield* sourceById(input.sourceId);
      const admitted = yield* repository.admit({
        sourceId: source.sourceId,
        runId: Knowledge.KnowledgeRunId.make(yield* random.uuidV4()),
        root: source.root,
        operation: "remove",
        embedding: null,
        now: yield* timestamp,
      });
      if (admitted.changed) {
        yield* publish;
        yield* signal;
      }
      return { run: admitted.run };
    },
  );
  const cancel: RepositoryKnowledge["Service"]["cancel"] = Effect.fn("RepositoryKnowledge.cancel")(
    function* (input: Knowledge.KnowledgeCancelInput) {
      const applied = yield* vectors.withPermit(
        Effect.gen(function* () {
          const run = yield* repository.getRun(input.runId);
          if (run.status !== "running" || run.operation !== "ingest") return false;
          return yield* repository.beginCleanup({
            runId: run.runId,
            intent: "cancel",
            error: null,
            now: yield* timestamp,
          });
        }),
      );
      if (applied) {
        yield* publish;
        const running = yield* Ref.get(active);
        if (running?.runId === input.runId) yield* Fiber.interrupt(running.fiber);
        yield* signal;
      }
      return { applied, run: yield* repository.getRun(input.runId) };
    },
  );
  const waitTerminal: RepositoryKnowledge["Service"]["waitTerminal"] = Effect.fn(
    "RepositoryKnowledge.waitTerminal",
  )(function* (input: Knowledge.KnowledgeWaitTerminalInput) {
    const subscription = yield* PubSub.subscribe(changes);
    const result = yield* Stream.concat(
      Stream.fromEffect(repository.getRun(input.runId)),
      Stream.fromSubscription(subscription).pipe(
        Stream.mapEffect(() => repository.getRun(input.runId)),
      ),
    ).pipe(Stream.filter(terminal), Stream.runHead);
    if (Option.isNone(result))
      return yield* new Knowledge.KnowledgeNotFoundError({ entity: "run", id: input.runId });
    return yield* Schema.decodeEffect(Knowledge.KnowledgeTerminalRun)(result.value).pipe(
      Effect.mapError(operationError),
    );
  }, Effect.scoped);

  const embeddingModels: RepositoryKnowledge["Service"]["embeddingModels"] = Effect.fn(
    "RepositoryKnowledge.embeddingModels",
  )(function* () {
    const value = yield* config;
    const resolved = yield* embeddingConfig(value, true).pipe(Effect.result);
    const discovered = yield* models.discover(
      resolved._tag === "Success" ? resolved.success : { lmStudioBaseUrl: value.lmStudioBaseUrl },
    );
    return resolved._tag === "Success"
      ? discovered
      : {
          ...discovered,
          failures: [
            ...discovered.failures,
            { provider: "openai" as const, error: runFailure(resolved.failure) },
          ],
        };
  });
  const retrieve: RepositoryKnowledge["Service"]["retrieve"] = Effect.fn(
    "RepositoryKnowledge.retrieve",
  )(
    function* (input: Knowledge.KnowledgeRetrieveInput) {
      if (input.sourceIds.length === 0) return { matches: [] };
      let hasChunks = false;
      for (const sourceId of input.sourceIds) {
        const source = yield* sourceById(sourceId);
        if (source.indexedAt === null)
          return yield* new Knowledge.KnowledgeIndexRequiredError({ sourceId, index: "vectors" });
        if (source.chunkCount > 0) hasChunks = true;
      }
      if (!hasChunks) return { matches: [] };
      const locked = yield* vectors.withPermit(repository.getEmbeddingIdentity());
      if (!locked)
        return yield* new Knowledge.KnowledgeIndexRequiredError({
          sourceId: input.sourceIds[0]!,
          index: "vectors",
        });
      const value = yield* config;
      const model = yield* models.resolve(
        locked.selection,
        yield* embeddingConfig(value, locked.selection.provider === "openai"),
      );
      const embedded = yield* model.embedBatch([input.query]);
      if (embedded.length !== 1 || embedded[0]?.length !== locked.dimensions)
        return yield* new Knowledge.KnowledgeOperationError({
          code: "embedding_dimensions_mismatch",
          cause: new Error("Query embedding dimensions differ from the index."),
        });
      const chroma = yield* chromaFor(value.chromaUrl);
      return yield* vectors.withPermit(
        Effect.gen(function* () {
          const current = yield* repository.getEmbeddingIdentity();
          if (!current)
            return yield* new Knowledge.KnowledgeIndexRequiredError({
              sourceId: input.sourceIds[0]!,
              index: "vectors",
            });
          yield* assertSelection(locked.selection);
          if (current.dimensions !== locked.dimensions)
            return yield* new Knowledge.KnowledgeOperationError({
              code: "embedding_dimensions_mismatch",
              cause: new Error("The embedding identity changed during query embedding."),
            });
          for (const sourceId of input.sourceIds) {
            if ((yield* sourceById(sourceId)).indexedAt === null)
              return yield* new Knowledge.KnowledgeIndexRequiredError({
                sourceId,
                index: "vectors",
              });
          }
          return yield* chroma.query({
            sourceIds: input.sourceIds,
            vector: embedded[0]!,
            limit: input.limit,
          });
        }),
      );
    },
    Effect.scoped,
    Effect.mapError(operationError),
  );

  const astSnapshot = Effect.fn("RepositoryKnowledge.astSnapshot")(function* (
    sourceId: Knowledge.KnowledgeSourceId,
  ) {
    const source = yield* sourceById(sourceId);
    if (!source.astCoverage)
      return yield* new Knowledge.KnowledgeIndexRequiredError({ sourceId, index: "ast" });
    const files = yield* repository.astFiles(sourceId);
    return { coverage: source.astCoverage, files, symbols: files.flatMap((file) => file.symbols) };
  }, vectors.withPermit);
  const astListSymbols: RepositoryKnowledge["Service"]["astListSymbols"] = Effect.fn(
    "RepositoryKnowledge.astListSymbols",
  )(function* (input: Knowledge.KnowledgeAstListSymbolsInput) {
    const snapshot = yield* astSnapshot(input.sourceId);
    const symbols = snapshot.symbols.filter(
      (symbol) => input.kinds === undefined || input.kinds.includes(symbol.kind),
    );
    return { symbols: symbols.slice(0, input.limit ?? 50), coverage: snapshot.coverage };
  });
  const astFindDefinition: RepositoryKnowledge["Service"]["astFindDefinition"] = Effect.fn(
    "RepositoryKnowledge.astFindDefinition",
  )(function* (input: Knowledge.KnowledgeAstFindDefinitionInput) {
    const snapshot = yield* astSnapshot(input.sourceId);
    const selector = input.selector;
    const symbol = snapshot.symbols.find((item) =>
      "symbolId" in selector
        ? item.symbolId === selector.symbolId
        : item.name === selector.name &&
          (selector.kind === undefined || item.kind === selector.kind),
    );
    return { symbol: symbol ?? null, coverage: snapshot.coverage };
  });
  const astFindReferences: RepositoryKnowledge["Service"]["astFindReferences"] = Effect.fn(
    "RepositoryKnowledge.astFindReferences",
  )(function* (input: Knowledge.KnowledgeAstFindReferencesInput) {
    const snapshot = yield* astSnapshot(input.sourceId);
    const selector = input.selector;
    return {
      references: snapshot.files
        .flatMap((file) => file.references)
        .filter((reference) =>
          "symbolId" in selector
            ? reference.symbolId === selector.symbolId
            : reference.name === selector.name,
        ),
      coverage: snapshot.coverage,
    };
  });
  const astCallGraph: RepositoryKnowledge["Service"]["astCallGraph"] = Effect.fn(
    "RepositoryKnowledge.astCallGraph",
  )(function* (input: Knowledge.KnowledgeAstCallGraphInput) {
    const snapshot = yield* astSnapshot(input.sourceId);
    const all = snapshot.files
      .flatMap((file) => file.edges)
      .filter((edge) => edge.type === "CALLS");
    const visited = new Set([input.symbolId]);
    let frontier = new Set([input.symbolId]);
    const edges = new Set<Knowledge.KnowledgeAstEdge>();
    for (let level = 0; level < (input.depth ?? 1) && frontier.size > 0; level += 1) {
      const next = new Set<string>();
      for (const edge of all) {
        if (!frontier.has(edge.fromSymbolId)) continue;
        edges.add(edge);
        if (!visited.has(edge.toSymbolId)) next.add(edge.toSymbolId);
        visited.add(edge.toSymbolId);
      }
      frontier = next;
    }
    return {
      nodes: snapshot.symbols.filter((symbol) => visited.has(symbol.symbolId)),
      edges: [...edges],
      coverage: snapshot.coverage,
    };
  });
  const astModuleImports: RepositoryKnowledge["Service"]["astModuleImports"] = Effect.fn(
    "RepositoryKnowledge.astModuleImports",
  )(function* (input: Knowledge.KnowledgeAstModuleImportsInput) {
    const snapshot = yield* astSnapshot(input.sourceId);
    return {
      modules: snapshot.files
        .filter(
          (file) =>
            file.imports.imports.length > 0 &&
            (input.relPath === undefined || file.relPath === input.relPath),
        )
        .map((file) => file.imports),
      coverage: snapshot.coverage,
    };
  });

  return RepositoryKnowledge.of({
    list,
    resolve,
    admit,
    cancel,
    remove,
    waitTerminal,
    subscribe,
    embeddingModels,
    retrieve,
    astListSymbols,
    astFindDefinition,
    astFindReferences,
    astCallGraph,
    astModuleImports,
  });
});

export const layer = Layer.effect(RepositoryKnowledge, make).pipe(Layer.provide(Repository.layer));

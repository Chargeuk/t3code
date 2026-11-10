import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  KnowledgeRunId,
  KnowledgeSourceId,
  type KnowledgeAdmitInput,
  type KnowledgeAdmitResult,
  type KnowledgeRunSummary,
  type KnowledgeSnapshot,
  type KnowledgeSourceSummary,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { KnowledgePage } from "./KnowledgePage";

const laptopId = EnvironmentId.make("laptop");
const remoteId = EnvironmentId.make("remote");
const now = "2026-11-10T00:00:00.000Z";
type SnapshotAtom = Atom.Writable<AsyncResult.AsyncResult<KnowledgeSnapshot, Error>>;
const state = vi.hoisted(() => ({
  snapshots: new Map<EnvironmentId, SnapshotAtom>(),
  permissions: new Map<EnvironmentId, Atom.Writable<boolean>>(),
  admit: undefined as
    | undefined
    | ((
        registry: AtomRegistry.AtomRegistry,
        target: {
          environmentId: EnvironmentId;
          input: KnowledgeAdmitInput;
        },
      ) => Promise<AtomCommandResult<KnowledgeAdmitResult, never>>),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: environments() }),
  usePrimaryEnvironmentId: () => laptopId,
  useEnvironment: (id: EnvironmentId) => environments().find((entry) => entry.environmentId === id),
}));
vi.mock("../../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
  filesystemEnvironment: { browse: () => folderAtom },
}));
vi.mock("./KnowledgeSettings", () => ({
  KnowledgeSettings: () => null,
}));
vi.mock("../../state/knowledge", () => ({
  knowledgeEnvironment: {
    knowledgeLive: (id: EnvironmentId) => state.snapshots.get(id)!,
    knowledgeResolve: ({ environmentId }: { environmentId: EnvironmentId }) =>
      Atom.make(
        AsyncResult.success({
          root: `/canonical/${environmentId}/repository`,
          source: null,
        }),
      ),
    knowledgeAdmit: {
      label: "admit",
      permissionAtom: (id: EnvironmentId) => state.permissions.get(id)!,
      run: (
        registry: AtomRegistry.AtomRegistry,
        target: { environmentId: EnvironmentId; input: KnowledgeAdmitInput },
      ) => state.admit!(registry, target),
    },
    knowledgeCancel: {
      label: "cancel",
      permissionAtom: (id: EnvironmentId) => state.permissions.get(id)!,
      run: async () =>
        AsyncResult.success({ applied: true, run: source("/active", "running").latestRun }),
    },
    knowledgeRemove: {
      label: "remove",
      permissionAtom: (id: EnvironmentId) => state.permissions.get(id)!,
      run: async () => AsyncResult.success({ run: source("/active", "cleanup").latestRun }),
    },
  },
}));

const folderAtom = Atom.make(
  AsyncResult.success({
    parentPath: "/home/remote",
    entries: [{ name: "repository", fullPath: "/home/remote/repository" }],
  }),
);

function environments() {
  return [
    {
      environmentId: laptopId,
      label: "Laptop",
      connection: { phase: "connected" },
      serverConfig: {},
    },
    {
      environmentId: remoteId,
      label: "Remote",
      connection: { phase: "connected" },
      serverConfig: {},
    },
  ];
}

function source(root: string, status: KnowledgeRunSummary["status"]): KnowledgeSourceSummary {
  return {
    sourceId: KnowledgeSourceId.make(root),
    root,
    createdAt: now,
    updatedAt: now,
    indexedAt: now,
    fileCount: 3,
    chunkCount: 4,
    astCoverage: null,
    latestRun: {
      runId: KnowledgeRunId.make(`run:${root}`),
      sourceId: KnowledgeSourceId.make(root),
      operation: "ingest",
      status,
      admissionOrder: 1,
      queuePosition: status === "queued" ? 1 : null,
      stage: status === "running" ? "embedding" : status === "cleanup" ? "cleanup" : null,
      currentFile: status === "running" ? "src/index.ts" : null,
      cleanupIntent: status === "cleanup" ? "cancel" : null,
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      embeddingIdentity: null,
      counts: {
        discoveredFiles: 3,
        processedFiles: 1,
        addedFiles: 1,
        changedFiles: 0,
        deletedFiles: 0,
        unchangedFiles: 2,
        chunks: 4,
        embeddedChunks: 1,
      },
      error: null,
      admittedAt: now,
      startedAt: status === "queued" ? null : now,
      updatedAt: now,
      finishedAt:
        status === "completed" || status === "failed" || status === "cancelled" ? now : null,
    },
  };
}

function setup() {
  state.snapshots.clear();
  state.permissions.clear();
  for (const id of [laptopId, remoteId]) {
    state.snapshots.set(
      id,
      Atom.make<AsyncResult.AsyncResult<KnowledgeSnapshot, Error>>(
        AsyncResult.success({ sources: [], embeddingIdentity: null }),
      ).pipe(Atom.keepAlive),
    );
    state.permissions.set(id, Atom.make(true));
  }
  state.admit = async (registry, { environmentId, input }) => {
    const atom = state.snapshots.get(environmentId)!;
    const previous = AsyncResult.getOrElse(registry.get(atom), () => ({
      sources: [],
      embeddingIdentity: null,
    }));
    const target = input.target;
    const admitted =
      "root" in target
        ? source(target.root, "queued")
        : previous.sources.find((entry) => entry.sourceId === target.sourceId)!;
    registry.set(
      atom,
      AsyncResult.success({
        ...previous,
        sources: [
          ...previous.sources.filter((entry) => entry.sourceId !== admitted.sourceId),
          admitted,
        ],
      }),
    );
    return AsyncResult.success({ run: admitted.latestRun! });
  };
}

function view(registry: AtomRegistry.AtomRegistry) {
  return (
    <RegistryContext.Provider value={registry}>
      <KnowledgePage />
    </RegistryContext.Provider>
  );
}

it("renders persisted run changes across remount and keeps admission and cleanup acknowledgements nonterminal", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const active = source("/active", "running");
  const queued = source("/waiting", "queued");
  registry.set(
    state.snapshots.get(laptopId)!,
    AsyncResult.success({ sources: [active, queued], embeddingIdentity: null }),
  );
  await using screen = await render(view(registry));
  const activeRow = screen.getByRole("region", { name: "/active", exact: true });
  const queuedRow = screen.getByRole("region", { name: "/waiting", exact: true });
  await expect.element(activeRow.getByText("src/index.ts")).toBeVisible();
  await expect.element(queuedRow.getByRole("status")).toMatchTextContent("Queue position 1");
  await expect
    .element(queuedRow.getByRole("button", { name: "Cancel ingest" }))
    .not.toBeInTheDocument();
  await expect
    .element(queuedRow.getByRole("button", { name: "Remove indexed content" }))
    .not.toBeInTheDocument();
  await activeRow.getByRole("button", { name: "Re-ingest", exact: true }).click();
  await expect.element(activeRow.getByText("running", { exact: true })).toBeVisible();
  await activeRow.getByRole("button", { name: "Cancel ingest" }).click();
  await expect.element(activeRow.getByText("running", { exact: true })).toBeVisible();

  await act(() =>
    registry.set(
      state.snapshots.get(laptopId)!,
      AsyncResult.success({
        sources: [source("/active", "cleanup"), queued],
        embeddingIdentity: null,
      }),
    ),
  );
  await expect
    .element(activeRow.getByRole("button", { name: "Cancel ingest" }))
    .not.toBeInTheDocument();
  await expect
    .element(activeRow.getByRole("button", { name: "Remove indexed content" }))
    .not.toBeInTheDocument();
  const failed = source("/waiting", "failed");
  const failedRun = failed.latestRun!;
  const failedSource = {
    ...failed,
    latestRun: {
      ...failedRun,
      error: {
        code: "embedding_request_failed" as const,
        message: "Restore provider access and re-ingest.",
        relPath: "src/b.ts",
      },
    },
  };
  await act(() =>
    registry.set(
      state.snapshots.get(laptopId)!,
      AsyncResult.success({
        sources: [source("/active", "cancelled"), failedSource],
        embeddingIdentity: null,
      }),
    ),
  );
  await expect
    .element(queuedRow.getByRole("alert"))
    .toHaveTextContent("Restore provider access and re-ingest. (src/b.ts)");
  await screen.unmount();
  await using reopened = await render(view(registry));
  await expect
    .element(reopened.getByRole("region", { name: "/waiting", exact: true }).getByRole("alert"))
    .toMatchTextContent("Restore provider access");
  const retained = reopened.getByRole("region", { name: "/active", exact: true });
  await retained.getByRole("button", { name: "Remove indexed content" }).click();
  await act(() =>
    registry.set(
      state.snapshots.get(laptopId)!,
      AsyncResult.success({
        sources: [
          {
            ...active,
            indexedAt: null,
            fileCount: 0,
            chunkCount: 0,
            latestRun: {
              ...active.latestRun!,
              operation: "remove",
              status: "completed",
              stage: null,
              currentFile: null,
              finishedAt: now,
            },
          },
          failedSource,
        ],
        embeddingIdentity: null,
      }),
    ),
  );
  await expect.element(retained.getByText("0 indexed files · 0 chunks")).toBeVisible();
  await expect.element(retained.getByRole("button", { name: "Ingest", exact: true })).toBeEnabled();
});

it("isolates folder drafts and uses the selected environment's resolved root while another source runs", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  registry.set(
    state.snapshots.get(laptopId)!,
    AsyncResult.success({ sources: [source("/active", "running")], embeddingIdentity: null }),
  );
  await using screen = await render(view(registry));
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Repository folder" }),
    "/unsaved-laptop",
  );
  await expect.element(screen.getByRole("button", { name: "Add and ingest" })).toBeEnabled();
  await screen.getByRole("combobox", { name: "Knowledge environment" }).click();
  await page.getByRole("option", { name: "Remote", exact: true }).click();
  await expect.element(screen.getByRole("textbox", { name: "Repository folder" })).toHaveValue("");
  await screen.getByRole("button", { name: "Browse folders" }).click();
  await screen.getByRole("button", { name: "repository", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Repository folder" }))
    .toHaveValue("/home/remote/repository/");
  await screen.getByRole("button", { name: "Add and ingest" }).click();
  const admitted = screen.getByRole("region", {
    name: "/canonical/remote/repository",
    exact: true,
  });
  await expect.element(admitted.getByText("queued", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Repository folder" })).toHaveValue("");
  await screen.getByRole("combobox", { name: "Knowledge environment" }).click();
  await page.getByRole("option", { name: "Laptop", exact: true }).click();
  await expect.element(screen.getByRole("region", { name: "/active", exact: true })).toBeVisible();
  await expect.element(admitted).not.toBeInTheDocument();
  await expect.element(screen.getByRole("textbox", { name: "Repository folder" })).toHaveValue("");
  await userEvent.fill(screen.getByRole("textbox", { name: "Repository folder" }), "/another-root");
  await screen.getByRole("button", { name: "Add and ingest" }).click();
  await expect
    .element(
      screen
        .getByRole("region", { name: "/canonical/laptop/repository", exact: true })
        .getByText("queued", { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(
      screen
        .getByRole("region", { name: "/active", exact: true })
        .getByText("running", { exact: true }),
    )
    .toBeVisible();
});

it("updates action availability when the selected environment's permission is revoked", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  registry.set(
    state.snapshots.get(laptopId)!,
    AsyncResult.success({
      sources: [source("/active", "running"), source("/finished", "completed")],
      embeddingIdentity: null,
    }),
  );
  await using screen = await render(view(registry));
  await userEvent.fill(screen.getByRole("textbox", { name: "Repository folder" }), "/another");
  const add = screen.getByRole("button", { name: "Add and ingest" });
  const cancel = screen.getByRole("button", { name: "Cancel ingest" });
  const remove = screen.getByRole("button", { name: "Remove indexed content" });
  await expect.element(add).toBeEnabled();
  await expect.element(cancel).toBeEnabled();
  await expect.element(remove).toBeEnabled();
  await act(() => registry.set(state.permissions.get(laptopId)!, false));
  await expect.element(add).toBeDisabled();
  await expect.element(cancel).toBeDisabled();
  await expect.element(remove).toBeDisabled();
  await act(() => registry.set(state.permissions.get(laptopId)!, true));
  await expect.element(add).toBeEnabled();
  await expect.element(cancel).toBeEnabled();
  await expect.element(remove).toBeEnabled();
});

it("hides stale source actions after a subscription failure without adding a gate to permitted admission", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const snapshot: KnowledgeSnapshot = {
    sources: [source("/active", "running")],
    embeddingIdentity: null,
  };
  registry.set(state.snapshots.get(laptopId)!, AsyncResult.success(snapshot));
  await using screen = await render(view(registry));
  await userEvent.fill(screen.getByRole("textbox", { name: "Repository folder" }), "/another");
  await act(() =>
    registry.set(
      state.snapshots.get(laptopId)!,
      AsyncResult.failure(Cause.fail(new Error("This connection requires orchestration:read.")), {
        previousSuccess: Option.some(AsyncResult.success(snapshot)),
      }),
    ),
  );
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("This connection requires orchestration:read.");
  await expect
    .element(screen.getByRole("region", { name: "/active", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Add and ingest" })).toBeEnabled();
});

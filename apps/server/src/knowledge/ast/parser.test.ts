// @effect-diagnostics-next-line nodeBuiltinImport:off -- Asset failure tests spy on Node's real query-file read boundary.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node SHA-256 checks the reference symbol-ID format synchronously.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as Knowledge from "../../../../../packages/contracts/src/knowledge.ts";
import type { KnowledgeAstParseInput, KnowledgeAstParseResult } from "../types.ts";
import { parseAstSource } from "./parser.ts";

vi.mock("node:fs/promises", { spy: true });

function input(relPath: string, text: string): KnowledgeAstParseInput {
  return {
    root: "/repo",
    sourceId: Knowledge.KnowledgeSourceId.make("source"),
    runId: Knowledge.KnowledgeRunId.make("run"),
    fileHash: "file-hash",
    relPath,
    text,
  };
}

function success(result: KnowledgeAstParseResult) {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Expected a successful AST parse");
  return result;
}

function range(startLine: number, startColumn: number, endLine: number, endColumn: number) {
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  };
}

const grammarCases = [
  {
    language: "javascript",
    ext: "js",
    kind: "Function",
    text: 'function greet() {\n  const name = "hi";\n  return name;\n}\n',
    symbolRange: range(1, 1, 4, 2),
    referenceRange: range(3, 10, 3, 14),
    bad: "function {",
  },
  {
    language: "typescript",
    ext: "ts",
    kind: "Function",
    text: 'function greet() {\n  const name = "hi";\n  return name;\n}\n',
    symbolRange: range(1, 1, 4, 2),
    referenceRange: range(3, 10, 3, 14),
    bad: "function {",
  },
  {
    language: "tsx",
    ext: "tsx",
    kind: "Function",
    text: 'function greet() {\n  const name = "hi";\n  return <div>{name}</div>;\n}\n',
    symbolRange: range(1, 1, 4, 2),
    referenceRange: range(3, 16, 3, 20),
    bad: "function {",
  },
  {
    language: "python",
    ext: "py",
    kind: "Function",
    text: 'def greet():\n  name = "hi"\n  print(name)\n',
    symbolRange: range(1, 1, 3, 14),
    referenceRange: range(3, 9, 3, 13),
    bad: "def (",
  },
  {
    language: "c_sharp",
    ext: "cs",
    kind: "Method",
    text: 'class Greeter {\n  void greet() {\n    var name = "hi";\n    System.Console.WriteLine(name);\n  }\n}\n',
    symbolRange: range(2, 3, 5, 4),
    referenceRange: range(4, 30, 4, 34),
    bad: "class {",
  },
  {
    language: "rust",
    ext: "rs",
    kind: "Function",
    text: 'fn greet() {\n  let name = "hi";\n  println!("{}", name);\n}\n',
    symbolRange: range(1, 1, 4, 2),
    referenceRange: range(3, 18, 3, 22),
    bad: "fn {",
  },
  {
    language: "cpp",
    ext: "cpp",
    kind: "Function",
    text: "int greet() {\n  int name = 0;\n  return name;\n}\n",
    symbolRange: range(1, 5, 1, 12),
    referenceRange: range(3, 10, 3, 14),
    bad: "int (",
  },
] as const;

describe("Knowledge AST parser", () => {
  it.effect.each(grammarCases)(
    "extracts real $language tags, locals, exact ranges and ownership",
    (fixture) =>
      Effect.gen(function* () {
        const file = input(`src/sample.${fixture.ext}`, fixture.text);
        const result = success(yield* parseAstSource(file));
        expect(result.language).toBe(fixture.language);
        const symbol = result.symbols.find(
          (item) => item.name === "greet" && item.kind === fixture.kind,
        );
        expect(symbol?.range).toEqual(fixture.symbolRange);
        expect(result.references).toContainEqual(
          expect.objectContaining({
            kind: "local",
            name: "name",
            range: fixture.referenceRange,
          }),
        );
        const module = result.symbols.find(
          (item) => item.name === file.relPath && item.kind === "Module",
        );
        expect(module?.range).toEqual(range(1, 1, fixture.text.split("\n").length, 1));
        expect(result.edges).toContainEqual(
          expect.objectContaining({
            type: "DEFINES",
            fromSymbolId: module?.symbolId,
            toSymbolId: symbol?.symbolId,
          }),
        );
        const metadata = {
          sourceId: file.sourceId,
          runId: file.runId,
          relPath: file.relPath,
          fileHash: file.fileHash,
        };
        for (const record of [
          ...result.symbols,
          ...result.references,
          ...result.edges,
          ...result.imports,
        ]) {
          expect(record).toMatchObject(metadata);
        }
        const ids = new Set(result.symbols.map((item) => item.symbolId));
        for (const edge of result.edges) {
          expect(ids.has(edge.fromSymbolId)).toBe(true);
          expect(ids.has(edge.toSymbolId)).toBe(true);
        }
        if (fixture.language === "rust") {
          const methods = success(
            yield* parseAstSource(
              input(
                "methods.rs",
                [
                  "struct Worker;",
                  "fn helper() {}",
                  "impl Worker {",
                  "  fn run(&self) { helper(); }",
                  "  fn next(&self) { helper(); }",
                  "}",
                  "struct Other;",
                  "impl Other {",
                  "  fn run(&self) { helper(); }",
                  "}",
                  "",
                ].join("\n"),
              ),
            ),
          );
          const methodSymbols = methods.symbols.filter((item) => item.kind === "Method");
          expect(methodSymbols.map((item) => [item.name, item.range])).toEqual([
            ["run", range(4, 3, 4, 30)],
            ["next", range(5, 3, 5, 31)],
            ["run", range(9, 3, 9, 30)],
          ]);
          expect(
            methods.symbols.filter((item) => item.kind === "Function").map((item) => item.name),
          ).toEqual(["helper"]);
          const helper = methods.symbols.find((item) => item.name === "helper");
          for (const method of methodSymbols) {
            expect(
              methods.edges.filter(
                (edge) => edge.type === "CALLS" && edge.fromSymbolId === method.symbolId,
              ),
            ).toEqual([expect.objectContaining({ toSymbolId: helper?.symbolId })]);
          }
        }
        if (fixture.language === "typescript") {
          for (const value of ["a".repeat(40_000), "🧠".repeat(20_000)]) {
            const text = fixture.text.replace('"hi"', JSON.stringify(value));
            const large = success(yield* parseAstSource(input("large.ts", text)));
            expect(large.symbols.find((item) => item.name === "greet")?.range).toEqual(
              fixture.symbolRange,
            );
            expect(large.symbols.find((item) => item.kind === "Module")?.range).toEqual(
              range(1, 1, 5, 1),
            );
          }
          const text = `${"// harmless 🧠\n".repeat(4_000)}${fixture.text}`;
          const large = success(yield* parseAstSource(input("comments.ts", text)));
          expect(large.symbols.find((item) => item.name === "greet")?.range).toEqual(
            range(4_001, 1, 4_004, 2),
          );
          expect(large.references).toContainEqual(
            expect.objectContaining({ name: "name", range: range(4_003, 10, 4_003, 14) }),
          );
          expect(large.symbols.find((item) => item.kind === "Module")?.range).toEqual(
            range(1, 1, 4_005, 1),
          );
        }
      }),
  );

  it.effect.each(grammarCases)(
    "returns a typed $language syntax failure without partial records",
    (fixture) =>
      Effect.gen(function* () {
        const result = yield* parseAstSource(input(`bad.${fixture.ext}`, fixture.bad));
        expect(result).toMatchObject({
          status: "failed",
          language: fixture.language,
          error: { code: "ast_parse_failed", relPath: `bad.${fixture.ext}` },
        });
        if (result.status !== "failed") throw new Error("Expected a syntax failure");
        expect(result.range?.start.line).toBe(1);
        expect(result.range?.start.column).toBeGreaterThanOrEqual(1);
        expect(result.range?.end.column).toBeGreaterThanOrEqual(1);
        if (fixture.bad === "function {") {
          expect(result.range).toEqual(range(1, 1, 1, 11));
        }
        expect(result).not.toHaveProperty("symbols");
      }),
  );

  it.effect.each(["jsx", "cc", "cxx", "hpp", "hxx", "h", "TS"])(
    "retains the supported .%s extension mapping",
    (ext) =>
      Effect.gen(function* () {
        const isCpp = ["cc", "cxx", "hpp", "hxx", "h"].includes(ext);
        const result = success(
          yield* parseAstSource(
            input(`sample.${ext}`, isCpp ? "int greet() { return 0; }" : "function greet() {}"),
          ),
        );
        expect(result.language).toBe(isCpp ? "cpp" : ext === "jsx" ? "javascript" : "typescript");
      }),
  );

  it.effect.each(["c", "mjs", "cjs", "md", "constructor", "", "txt"])(
    "skips unsupported .%s files rather than treating discovery as parser support",
    (ext) =>
      Effect.gen(function* () {
        expect(
          yield* parseAstSource(input(ext ? `file.${ext}` : "Makefile", "function {")),
        ).toEqual({ status: "skipped" });
      }),
  );

  it.effect(
    "preserves call, import, export, heritage and type relationships with exact references",
    () =>
      Effect.gen(function* () {
        const file = input(
          "src/relations.ts",
          [
            "import { external } from './external';",
            "interface Base {}",
            "interface Face {}",
            "export class Child extends Base implements Face {",
            "  method(arg: Base): Face {",
            "    helper();",
            "    external();",
            "    return {} as Face;",
            "  }",
            "}",
            "function helper() {}",
            "export function visible() { helper(); }",
            "function local() {}",
            "function publicAlias() {}",
            "export { local as publicAlias };",
            "export { helper } from './other';",
            "export const named = () => helper(), second = () => helper();",
            "export default function defaultVisible() { helper(); }",
            "class Outer {",
            "  make() {",
            "    class Inner extends Base implements Face {}",
            "    return Inner;",
            "  }",
            "}",
            "interface Arg {}",
            "interface GenericFace<T> {}",
            "class GenericBase<T> {}",
            "class GenericChild extends GenericBase<Arg> implements GenericFace<Arg>, Face {}",
            "class GenericParent extends GenericBase<GenericFace<Arg>> {}",
            "",
          ].join("\n"),
        );
        const result = success(yield* parseAstSource(file));
        const symbols = new Map(result.symbols.map((item) => [item.name, item]));
        expect(
          result.edges
            .filter((edge) => edge.type === "EXPORTS")
            .map(
              (edge) => result.symbols.find((symbol) => symbol.symbolId === edge.toSymbolId)?.name,
            )
            .sort(),
        ).toEqual(["Child", "defaultVisible", "local", "named", "second", "visible"]);
        for (const [type, from, to] of [
          ["IMPORTS", file.relPath, "./external"],
          ["EXPORTS", file.relPath, "Child"],
          ["EXTENDS", "Child", "Base"],
          ["IMPLEMENTS", "Child", "Face"],
          ["EXTENDS", "Inner", "Base"],
          ["IMPLEMENTS", "Inner", "Face"],
          ["REFERENCES_TYPE", "method", "Base"],
          ["CALLS", "method", "helper"],
        ] as const) {
          expect(result.edges).toContainEqual(
            expect.objectContaining({
              type,
              fromSymbolId: symbols.get(from)?.symbolId,
              toSymbolId: symbols.get(to)?.symbolId,
            }),
          );
        }
        expect(
          result.edges.filter(
            (edge) =>
              (edge.type === "EXTENDS" || edge.type === "IMPLEMENTS") &&
              edge.fromSymbolId === symbols.get("Outer")?.symbolId,
          ),
        ).toEqual([]);
        for (const [from, expected] of [
          [
            "GenericChild",
            [
              ["EXTENDS", "GenericBase"],
              ["IMPLEMENTS", "GenericFace"],
              ["IMPLEMENTS", "Face"],
            ],
          ],
          ["GenericParent", [["EXTENDS", "GenericBase"]]],
        ] as const) {
          expect(
            result.edges
              .filter(
                (edge) =>
                  (edge.type === "EXTENDS" || edge.type === "IMPLEMENTS") &&
                  edge.fromSymbolId === symbols.get(from)?.symbolId,
              )
              .map((edge) => [
                edge.type,
                result.symbols.find((symbol) => symbol.symbolId === edge.toSymbolId)?.name,
              ]),
          ).toEqual(expected);
        }
        expect(symbols.get("method")).toMatchObject({
          container: "Child",
          range: range(5, 3, 9, 4),
        });
        expect(result.references).toContainEqual(
          expect.objectContaining({
            name: "helper",
            kind: "call",
            range: range(6, 5, 6, 13),
          }),
        );
        expect(result.references).toContainEqual(
          expect.objectContaining({
            name: "Base",
            kind: "type",
            range: range(5, 13, 5, 19),
          }),
        );
        expect(result.imports).toEqual([
          {
            sourceId: file.sourceId,
            runId: file.runId,
            fileHash: file.fileHash,
            relPath: file.relPath,
            imports: [{ source: "./external", names: ["external"] }],
          },
        ]);
        expect(
          result.edges.filter(
            (edge) =>
              edge.type === "CALLS" && edge.fromSymbolId === symbols.get("method")?.symbolId,
          ),
        ).toHaveLength(1);
        for (const ext of ["js", "jsx"]) {
          const heritage = success(
            yield* parseAstSource(
              input(
                `heritage.${ext}`,
                [
                  "class Base {}",
                  "class Child extends Base {}",
                  "class Outer { make() { class Inner extends Base {} } }",
                  "class Missing extends External {}",
                  "class Dynamic extends factory(Base) {}",
                ].join("\n"),
              ),
            ),
          );
          expect(
            heritage.edges
              .filter((edge) => edge.type === "EXTENDS")
              .map((edge) => [
                heritage.symbols.find((symbol) => symbol.symbolId === edge.fromSymbolId)?.name,
                heritage.symbols.find((symbol) => symbol.symbolId === edge.toSymbolId)?.name,
              ]),
          ).toEqual([
            ["Child", "Base"],
            ["Inner", "Base"],
          ]);
        }
      }),
  );

  it.effect(
    "uses one-based end-exclusive UTF-16 ranges and stable root/path/kind/name/range IDs",
    () =>
      Effect.gen(function* () {
        const file = input("unicode.ts", '/*😀*/ function café() { return "é"; }\r\ncafé();\r\n');
        const first = success(yield* parseAstSource(file));
        const changedRun = success(
          yield* parseAstSource({
            ...file,
            runId: Knowledge.KnowledgeRunId.make("next-run"),
            fileHash: "next-hash",
          }),
        );
        expect(first.symbols.map((item) => item.symbolId)).toEqual(
          changedRun.symbols.map((item) => item.symbolId),
        );
        const symbol = first.symbols.find((item) => item.name === "café");
        expect(symbol?.range).toEqual(range(1, 8, 1, 39));
        expect(first.references).toContainEqual(
          expect.objectContaining({
            name: "café",
            kind: "call",
            range: range(2, 1, 2, 7),
          }),
        );
        const base = "/repo|unicode.ts|Function|café|1|8|1|39";
        expect(symbol?.symbolId).toBe(NodeCrypto.createHash("sha256").update(base).digest("hex"));
        const movedRoot = success(yield* parseAstSource({ ...file, root: "/other" }));
        const movedPath = success(yield* parseAstSource({ ...file, relPath: "other.ts" }));
        expect(movedRoot.symbols.find((item) => item.name === "café")?.symbolId).not.toBe(
          symbol?.symbolId,
        );
        expect(movedPath.symbols.find((item) => item.name === "café")?.symbolId).not.toBe(
          symbol?.symbolId,
        );
      }),
  );

  it.effect.each(["missing", "empty"] as const)("keeps %s query assets actionable", (kind) =>
    Effect.gen(function* () {
      vi.resetModules();
      const fresh = yield* Effect.promise(() => import("./parser.ts"));
      const cause = new Error("query fixture unavailable");
      using readFile = vi.mocked(NodeFSP.readFile);
      if (kind === "missing") readFile.mockRejectedValue(cause);
      else readFile.mockResolvedValue("");
      const file = input("sample.py", "def greet():\n  pass\n");
      const error = yield* fresh.parseAstSource(file).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "KnowledgeOperationError",
        code: "ast_unavailable",
        sourceId: file.sourceId,
        runId: file.runId,
        relPath: file.relPath,
      });
      if (kind === "missing") expect(error.cause).toBe(cause);
      else expect(error.cause).toBeInstanceOf(Error);
    }),
  );
});

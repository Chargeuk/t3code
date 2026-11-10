// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable symbol IDs use synchronous SHA-256 in the pure record builder.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native query assets load through the Promise boundary wrapped by Effect.tryPromise.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native package asset paths and extension detection stay synchronous in the parser boundary.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import * as Knowledge from "../../../../../packages/contracts/src/knowledge.ts";
import type {
  KnowledgeAstParseInput,
  KnowledgeAstParseResult,
  KnowledgeParseAstSource,
} from "../types.ts";

type Position = { row: number; column: number };
type SyntaxNode = {
  type: string;
  text: string;
  startPosition: Position;
  endPosition: Position;
  hasError: boolean;
  parent: SyntaxNode | null;
  childForFieldName: (name: string) => SyntaxNode | null;
  descendantsOfType: (types: string | string[]) => SyntaxNode[];
};
type Tree = { rootNode: SyntaxNode };
type QueryMatch = { captures: { name: string; node: SyntaxNode }[] };
type NativeQuery = { matches: (node: SyntaxNode) => QueryMatch[] };
type ParserModule = {
  new (): { setLanguage: (language: unknown) => void; parse: (text: string) => Tree };
  Query: new (language: unknown, source: string) => NativeQuery;
};
type QueryBundle = { tags: string; locals: string };

const require = NodeModule.createRequire(import.meta.url);
const queryCache = new Map<Knowledge.KnowledgeAstLanguage, QueryBundle>();
const packages = {
  javascript: "tree-sitter-javascript",
  typescript: "tree-sitter-typescript",
  tsx: "tree-sitter-typescript",
  python: "tree-sitter-python",
  c_sharp: "tree-sitter-c-sharp",
  rust: "tree-sitter-rust",
  cpp: "tree-sitter-cpp",
} as const;
const extensions: Readonly<Record<string, Knowledge.KnowledgeAstLanguage>> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  cs: "c_sharp",
  rs: "rust",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  h: "cpp",
};
const definitionKindMap: Readonly<Record<string, Knowledge.KnowledgeAstSymbolKind>> = {
  "definition.class": "Class",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.interface": "Interface",
  "definition.type": "TypeAlias",
  "definition.enum": "Enum",
  "definition.property": "Property",
  "definition.constant": "Property",
  "definition.module": "Module",
};
const referenceKindMap: Readonly<Record<string, Knowledge.KnowledgeAstReference["kind"]>> = {
  "reference.call": "call",
  "reference.class": "class",
  "reference.type": "type",
  "local.reference": "local",
};

function toRange(node: SyntaxNode): Knowledge.KnowledgeAstRange {
  // The Node binding exposes UTF-16 columns; the end position stays exclusive.
  return {
    start: { line: node.startPosition.row + 1, column: node.startPosition.column + 1 },
    end: { line: node.endPosition.row + 1, column: node.endPosition.column + 1 },
  };
}

function sanitizeQuery(source: string) {
  // These tag directives are unsupported by the native Node query implementation.
  return source
    .split("\n")
    .filter((line) => !line.includes("#strip!") && !line.includes("#select-adjacent!"))
    .join("\n");
}

async function readPackageQuery(packageName: string, name: string) {
  const root = NodePath.dirname(require.resolve(`${packageName}/package.json`));
  return readQueryFile(NodePath.join(root, "queries", `${name}.scm`));
}

async function readQueryFile(file: string | URL) {
  const source = await NodeFSP.readFile(file, "utf8");
  if (!source.trim()) throw new Error("Tree-sitter query asset is empty");
  return sanitizeQuery(source);
}

async function loadQueries(language: Knowledge.KnowledgeAstLanguage): Promise<QueryBundle> {
  const cached = queryCache.get(language);
  if (cached) return cached;
  let bundle: QueryBundle;
  if (language === "javascript") {
    bundle = {
      tags: await readPackageQuery(packages.javascript, "tags"),
      locals: await readPackageQuery(packages.javascript, "locals"),
    };
  } else if (language === "typescript" || language === "tsx") {
    bundle = {
      tags: [
        await readPackageQuery(packages.typescript, "tags"),
        await readPackageQuery(packages.javascript, "tags"),
      ].join("\n"),
      locals: [
        await readPackageQuery(packages.typescript, "locals"),
        await readPackageQuery(packages.javascript, "locals"),
      ].join("\n"),
    };
  } else {
    bundle = {
      tags: await readPackageQuery(packages[language], "tags"),
      locals: await readQueryFile(new URL(`./queries/${language}/locals.scm`, import.meta.url)),
    };
  }
  queryCache.set(language, bundle);
  return bundle;
}

function createSymbolIdBase(symbol: {
  root: string;
  relPath: string;
  kind: string;
  name: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}) {
  const { root, relPath, kind, name, range } = symbol;
  return [
    root,
    relPath,
    kind,
    name,
    range.start.line,
    range.start.column,
    range.end.line,
    range.end.column,
  ].join("|");
}

function createSymbolIdFactory() {
  const seen = new Map<string, number>();
  return (base: string) => {
    const hash = NodeCrypto.createHash("sha256").update(base).digest("hex");
    const count = seen.get(hash) ?? 0;
    if (count === 0) {
      seen.set(hash, 1);
      return hash;
    }
    const next = count + 1;
    seen.set(hash, next);
    return `${hash}-${next}`;
  };
}

function getNodeText(node: SyntaxNode | null | undefined) {
  if (!node) return "";
  return node.text ?? "";
}

function findContainerName(node: SyntaxNode) {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class" ||
      current.type === "class_declaration" ||
      current.type === "interface_declaration"
    ) {
      const nameNode = current.childForFieldName("name");
      return getNodeText(nameNode) || undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function isPositionWithinRange(
  position: { line: number; column: number },
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  },
) {
  if (position.line < range.start.line) return false;
  if (position.line > range.end.line) return false;
  if (position.line === range.start.line && position.column < range.start.column) return false;
  if (position.line === range.end.line && position.column >= range.end.column) return false;
  return true;
}

function rangeSpan(range: {
  start: { line: number; column: number };
  end: { line: number; column: number };
}) {
  return (range.end.line - range.start.line) * 10000 + (range.end.column - range.start.column);
}

function distanceFromPosition(
  position: { line: number; column: number },
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  },
) {
  return (
    Math.abs(range.start.line - position.line) * 10000 +
    Math.abs(range.start.column - position.column)
  );
}

function findEnclosingSymbol(
  symbols: Knowledge.KnowledgeAstSymbol[],
  position: { line: number; column: number },
  moduleSymbolId: string,
) {
  const candidates = symbols.filter(
    (symbol) => symbol.symbolId !== moduleSymbolId && isPositionWithinRange(position, symbol.range),
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => rangeSpan(a.range) - rangeSpan(b.range))[0];
}

function findClosestSymbolByName(
  symbols: Knowledge.KnowledgeAstSymbol[],
  name: string,
  position: { line: number; column: number },
  moduleSymbolId: string,
  allowedKinds?: Knowledge.KnowledgeAstSymbolKind[],
) {
  const candidates = symbols.filter((symbol) => {
    if (symbol.symbolId === moduleSymbolId) return false;
    if (symbol.name !== name) return false;
    if (allowedKinds && !allowedKinds.includes(symbol.kind)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => distanceFromPosition(position, a.range) - distanceFromPosition(position, b.range),
  )[0];
}

function buildCallEdges(
  references: Knowledge.KnowledgeAstReference[],
  symbols: Knowledge.KnowledgeAstSymbol[],
  moduleSymbolId: string,
  file: Knowledge.KnowledgeIndexedFile,
): Knowledge.KnowledgeAstEdge[] {
  const edges: Knowledge.KnowledgeAstEdge[] = [];
  for (const reference of references) {
    if (reference.kind !== "call") continue;
    const callee = symbols.find(
      (symbol) => symbol.symbolId !== moduleSymbolId && symbol.name === reference.name,
    );
    if (!callee) continue;
    const caller =
      findEnclosingSymbol(symbols, reference.range.start, moduleSymbolId) ??
      symbols.find((symbol) => symbol.symbolId === moduleSymbolId) ??
      null;
    if (!caller) continue;
    edges.push({
      ...file,
      fromSymbolId: caller.symbolId,
      toSymbolId: callee.symbolId,
      type: "CALLS",
    });
  }
  return edges;
}

function buildExportEdges(
  tree: Tree,
  symbols: Knowledge.KnowledgeAstSymbol[],
  moduleSymbolId: string,
  file: Knowledge.KnowledgeIndexedFile,
): Knowledge.KnowledgeAstEdge[] {
  const exportStatements = tree.rootNode.descendantsOfType("export_statement");
  const edges: Knowledge.KnowledgeAstEdge[] = [];

  for (const statement of exportStatements) {
    const nameNodes = statement.descendantsOfType([
      "identifier",
      "property_identifier",
      "type_identifier",
    ]);
    const names = Array.from(new Set(nameNodes.map((node) => getNodeText(node)).filter(Boolean)));
    for (const name of names) {
      const target = symbols.find(
        (symbol) => symbol.symbolId !== moduleSymbolId && symbol.name === name,
      );
      if (!target) continue;
      edges.push({
        ...file,
        fromSymbolId: moduleSymbolId,
        toSymbolId: target.symbolId,
        type: "EXPORTS",
      });
    }
  }

  return edges;
}

function collectClauseTypeNames(node: SyntaxNode) {
  const nameNodes = node.descendantsOfType([
    "identifier",
    "type_identifier",
    "property_identifier",
  ]);
  return Array.from(new Set(nameNodes.map((nameNode) => getNodeText(nameNode)).filter(Boolean)));
}

function buildHeritageEdges(
  tree: Tree,
  symbols: Knowledge.KnowledgeAstSymbol[],
  moduleSymbolId: string,
  file: Knowledge.KnowledgeIndexedFile,
): Knowledge.KnowledgeAstEdge[] {
  const edges: Knowledge.KnowledgeAstEdge[] = [];
  const declarations = tree.rootNode.descendantsOfType([
    "class_declaration",
    "interface_declaration",
  ]);

  for (const declaration of declarations) {
    const name = getNodeText(declaration.childForFieldName("name"));
    if (!name) continue;
    const allowedKinds: Knowledge.KnowledgeAstSymbolKind[] =
      declaration.type === "interface_declaration" ? ["Interface"] : ["Class"];
    const sourceSymbol = findClosestSymbolByName(
      symbols,
      name,
      toRange(declaration).start,
      moduleSymbolId,
      allowedKinds,
    );
    if (!sourceSymbol) continue;

    const clauseNodes = declaration.descendantsOfType(["extends_clause", "implements_clause"]);
    for (const clause of clauseNodes) {
      const edgeType = clause.type === "implements_clause" ? "IMPLEMENTS" : "EXTENDS";
      const clauseNames = collectClauseTypeNames(clause);
      for (const clauseName of clauseNames) {
        const targetSymbol = findClosestSymbolByName(
          symbols,
          clauseName,
          toRange(clause).start,
          moduleSymbolId,
        );
        if (!targetSymbol) continue;
        if (targetSymbol.symbolId === sourceSymbol.symbolId) continue;
        edges.push({
          ...file,
          fromSymbolId: sourceSymbol.symbolId,
          toSymbolId: targetSymbol.symbolId,
          type: edgeType,
        });
      }
    }
  }

  return edges;
}

function buildTypeReferenceEdges(
  references: Knowledge.KnowledgeAstReference[],
  symbols: Knowledge.KnowledgeAstSymbol[],
  moduleSymbolId: string,
  file: Knowledge.KnowledgeIndexedFile,
): Knowledge.KnowledgeAstEdge[] {
  const edges: Knowledge.KnowledgeAstEdge[] = [];
  const moduleSymbol = symbols.find((symbol) => symbol.symbolId === moduleSymbolId);
  for (const reference of references) {
    if (reference.kind !== "type") continue;
    const target = findClosestSymbolByName(
      symbols,
      reference.name,
      reference.range.start,
      moduleSymbolId,
    );
    if (!target) continue;
    const source =
      findEnclosingSymbol(symbols, reference.range.start, moduleSymbolId) ?? moduleSymbol ?? null;
    if (!source) continue;
    edges.push({
      ...file,
      fromSymbolId: source.symbolId,
      toSymbolId: target.symbolId,
      type: "REFERENCES_TYPE",
    });
  }
  return edges;
}

function collectDefinitions(
  matches: QueryMatch[],
  root: string,
  file: Knowledge.KnowledgeIndexedFile,
  language: Knowledge.KnowledgeAstLanguage,
  symbolIdForBase: (base: string) => string,
): Knowledge.KnowledgeAstSymbol[] {
  const symbols: Knowledge.KnowledgeAstSymbol[] = [];
  for (const match of matches) {
    const definitionCapture = match.captures.find((capture) =>
      capture.name.startsWith("definition."),
    );
    if (!definitionCapture) continue;
    const kind = definitionKindMap[definitionCapture.name];
    if (!kind) continue;
    const nameCapture = match.captures.find((capture) => capture.name === "name");
    const name = getNodeText(nameCapture?.node) || getNodeText(definitionCapture.node);
    if (!name) continue;
    const range = toRange(definitionCapture.node);
    const container = findContainerName(definitionCapture.node);
    const base = createSymbolIdBase({
      root,
      relPath: file.relPath,
      kind,
      name,
      range,
    });
    const symbolId = symbolIdForBase(base);
    symbols.push({
      ...file,
      language,
      kind,
      name,
      range,
      ...(container ? { container } : {}),
      symbolId,
    });
  }
  return symbols;
}

function collectReferences(
  matches: QueryMatch[],
  file: Knowledge.KnowledgeIndexedFile,
): Knowledge.KnowledgeAstReference[] {
  const references: Knowledge.KnowledgeAstReference[] = [];
  for (const match of matches) {
    for (const capture of match.captures) {
      const kind = referenceKindMap[capture.name];
      if (!kind) continue;
      const nameCapture = match.captures.find((item) => item.name === "name");
      const name = getNodeText(nameCapture?.node) || getNodeText(capture.node);
      if (!name) continue;
      references.push({
        ...file,
        name,
        kind,
        range: toRange(capture.node),
      });
    }
  }
  return references;
}

type ImportStatementInfo = {
  source: string;
  names: string[];
  range: ReturnType<typeof toRange>;
};

function collectImportStatements(tree: Tree): ImportStatementInfo[] {
  const importStatements = tree.rootNode.descendantsOfType("import_statement");
  const imports: ImportStatementInfo[] = [];

  for (const statement of importStatements) {
    const sourceNode = statement.childForFieldName("source");
    const sourceText = getNodeText(sourceNode).replace(/^['"]|['"]$/g, "");
    const importClause = statement.descendantsOfType([
      "import_clause",
      "named_imports",
      "namespace_import",
    ])[0];
    const nameNodes = importClause
      ? importClause.descendantsOfType(["identifier", "property_identifier", "type_identifier"])
      : [];
    const names = Array.from(new Set(nameNodes.map((node) => getNodeText(node)).filter(Boolean)));
    if (!sourceText) continue;
    imports.push({ source: sourceText, names, range: toRange(statement) });
  }

  return imports;
}

function buildImportRecords(
  statements: ImportStatementInfo[],
  file: Knowledge.KnowledgeIndexedFile,
): Knowledge.KnowledgeAstModuleImports[] {
  if (statements.length === 0) return [];
  return [
    {
      ...file,
      imports: statements.map((statement) => ({
        source: statement.source,
        names: statement.names,
      })),
    },
  ];
}

function parseTree(
  input: KnowledgeAstParseInput,
  language: Knowledge.KnowledgeAstLanguage,
  tree: Tree,
  tagsQuery: NativeQuery,
  localsQuery: NativeQuery,
): KnowledgeAstParseResult {
  const { root, sourceId, runId, relPath, fileHash } = input;
  const file = { sourceId, runId, relPath, fileHash };
  if (tree.rootNode.hasError) {
    const errorNode = tree.rootNode.descendantsOfType("ERROR")[0] ?? tree.rootNode;
    return {
      status: "failed",
      language,
      error: {
        code: "ast_parse_failed",
        message: "Could not parse a Knowledge source file. Inspect its syntax.",
        relPath: file.relPath,
      },
      range: toRange(errorNode),
    };
  }
  const tagMatches = tagsQuery.matches(tree.rootNode);
  const localMatches = localsQuery.matches(tree.rootNode);
  const symbolIdForBase = createSymbolIdFactory();
  const moduleRange = toRange(tree.rootNode);
  const moduleSymbolId = symbolIdForBase(
    createSymbolIdBase({
      root,
      relPath: file.relPath,
      kind: "Module",
      name: file.relPath,
      range: moduleRange,
    }),
  );
  const moduleSymbol: Knowledge.KnowledgeAstSymbol = {
    ...file,
    language,
    kind: "Module",
    name: file.relPath,
    range: moduleRange,
    symbolId: moduleSymbolId,
  };
  const definitionSymbols = collectDefinitions(tagMatches, root, file, language, symbolIdForBase);
  const importStatements = collectImportStatements(tree);
  const importSymbols: Knowledge.KnowledgeAstSymbol[] = importStatements.map((statement) => ({
    ...file,
    language,
    kind: "Module",
    name: statement.source,
    range: statement.range,
    symbolId: symbolIdForBase(
      createSymbolIdBase({
        root,
        relPath: file.relPath,
        kind: "Module",
        name: statement.source,
        range: statement.range,
      }),
    ),
  }));
  const symbols = [moduleSymbol, ...definitionSymbols, ...importSymbols];
  const defineEdges: Knowledge.KnowledgeAstEdge[] = definitionSymbols.map((symbol) => ({
    ...file,
    fromSymbolId: moduleSymbolId,
    toSymbolId: symbol.symbolId,
    type: "DEFINES",
  }));
  const importEdges: Knowledge.KnowledgeAstEdge[] = importSymbols.map((symbol) => ({
    ...file,
    fromSymbolId: moduleSymbolId,
    toSymbolId: symbol.symbolId,
    type: "IMPORTS",
  }));
  const tagReferences = collectReferences(tagMatches, file);
  const references = [...tagReferences, ...collectReferences(localMatches, file)];
  return {
    status: "ok",
    language,
    symbols,
    references,
    edges: [
      ...defineEdges,
      ...importEdges,
      ...buildCallEdges(tagReferences, symbols, moduleSymbolId, file),
      ...buildExportEdges(tree, symbols, moduleSymbolId, file),
      ...buildHeritageEdges(tree, symbols, moduleSymbolId, file),
      ...buildTypeReferenceEdges(references, symbols, moduleSymbolId, file),
    ],
    imports: buildImportRecords(importStatements, file),
  };
}

export const parseAstSource: KnowledgeParseAstSource = Effect.fn("Knowledge.parseAstSource")(
  function* (input: KnowledgeAstParseInput) {
    const extension = NodePath.extname(input.relPath).slice(1).toLowerCase();
    const language = Object.hasOwn(extensions, extension) ? extensions[extension] : undefined;
    if (!language) return { status: "skipped" } as const;
    const context = { sourceId: input.sourceId, runId: input.runId, relPath: input.relPath };
    const queries = yield* Effect.tryPromise({
      try: () => loadQueries(language),
      catch: (cause) =>
        new Knowledge.KnowledgeOperationError({ ...context, code: "ast_unavailable", cause }),
    });
    const { parser, tags, locals } = yield* Effect.try({
      try: () => {
        const Parser = require("tree-sitter") as ParserModule;
        const binding: unknown = require(packages[language]);
        const grammar =
          language === "typescript" || language === "tsx"
            ? (binding as { typescript: unknown; tsx: unknown })[language]
            : binding;
        const parser = new Parser();
        parser.setLanguage(grammar);
        return {
          parser,
          tags: new Parser.Query(grammar, queries.tags),
          locals: new Parser.Query(grammar, queries.locals),
        };
      },
      catch: (cause) =>
        new Knowledge.KnowledgeOperationError({ ...context, code: "ast_unavailable", cause }),
    });
    return yield* Effect.try({
      try: () => parseTree(input, language, parser.parse(input.text), tags, locals),
      catch: (cause) =>
        new Knowledge.KnowledgeOperationError({ ...context, code: "ast_parse_failed", cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          status: "failed",
          language,
          error: { code: error.code, message: error.message, relPath: input.relPath },
        } as const),
      ),
    );
  },
);

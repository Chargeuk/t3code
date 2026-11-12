import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type KnowledgeEmbeddingModelsResult,
  type KnowledgeSnapshot,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useContext, type ComponentProps, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SecretInput } from "../settings/SecretInput";
import { KnowledgeSettings } from "./KnowledgeSettings";

const laptopId = EnvironmentId.make("laptop");
const remoteId = EnvironmentId.make("remote");
const state = vi.hoisted(() => ({
  settings: new Map<EnvironmentId, Atom.Writable<ServerSettings>>(),
  models: undefined as
    | undefined
    | Atom.Writable<AsyncResult.AsyncResult<KnowledgeEmbeddingModelsResult>>,
  index: undefined as undefined | Atom.Writable<AsyncResult.AsyncResult<KnowledgeSnapshot>>,
}));

vi.mock("../../state/environments", () => ({
  useEnvironment: (id: EnvironmentId) => ({
    label: id,
    connection: { phase: "connected" },
    serverConfig: {},
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (id: EnvironmentId, selector: (value: ServerSettings) => unknown) =>
    selector(useAtomValue(state.settings.get(id)!)),
  useUpdateEnvironmentSettings: (id: EnvironmentId) => {
    const registry = useContext(RegistryContext);
    return (patch: ServerSettingsPatch) => {
      const atom = state.settings.get(id)!;
      const current = registry.get(atom);
      const next = { ...current.knowledge, ...patch.knowledge };
      registry.set(atom, {
        ...current,
        knowledge: {
          ...next,
          openaiApiKey:
            typeof next.openaiApiKey === "string" && next.openaiApiKey.length > 0
              ? "••••••"
              : next.openaiApiKey,
        },
      });
    };
  },
}));
vi.mock("../../state/knowledge", () => ({
  knowledgeEnvironment: {
    knowledgeEmbeddingModels: () => state.models!,
    knowledgeLive: () => state.index!,
  },
}));
vi.mock("../settings/settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      {title}
      <p>{description}</p>
      {control}
    </div>
  ),
}));
vi.mock("../settings/SecretSourceInput", () => ({
  useSecretSources: () => [],
  SecretSourceInput: ({
    sources: _sources,
    onSecretChange: _onSecretChange,
    ...props
  }: ComponentProps<typeof SecretInput> & {
    sources: ReadonlyArray<unknown>;
    onSecretChange: unknown;
  }) => <SecretInput {...props} />,
}));

function setup() {
  state.settings.clear();
  for (const id of [laptopId, remoteId])
    state.settings.set(
      id,
      Atom.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        knowledge: { ...DEFAULT_SERVER_SETTINGS.knowledge, openaiApiKey: "••••••" },
      }).pipe(Atom.keepAlive),
    );
  state.models = Atom.make<AsyncResult.AsyncResult<KnowledgeEmbeddingModelsResult>>(
    AsyncResult.success<KnowledgeEmbeddingModelsResult>({
      models: [{ provider: "lmstudio", model: "local-embedding" }],
      failures: [
        {
          provider: "openai",
          error: { code: "embedding_unavailable", message: "Check the OpenAI key.", relPath: null },
        },
      ],
    }),
  );
  state.index = Atom.make<AsyncResult.AsyncResult<KnowledgeSnapshot>>(
    AsyncResult.success({ sources: [], embeddingIdentity: null }),
  );
}

function view(registry: AtomRegistry.AtomRegistry, id: EnvironmentId) {
  return (
    <RegistryContext.Provider value={registry}>
      <KnowledgeSettings environmentId={id} />
    </RegistryContext.Provider>
  );
}

it("keeps secrets out of drafts, isolates environment edits, and requires explicit clearing", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(view(registry, laptopId));
  const secret = screen.getByLabelText("OpenAI API key");
  await expect.element(secret).toHaveValue("");
  await expect.element(screen.getByRole("button", { name: "Clear API key" })).toBeEnabled();
  await userEvent.fill(secret, "replacement-draft");
  await userEvent.fill(screen.getByRole("textbox", { name: "Included extensions" }), "ts, md");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByRole("textbox", { name: "Included extensions" }))
    .toHaveValue("ts, md");
  await expect.element(secret).toHaveValue("");
  await userEvent.fill(secret, "unsaved-on-laptop");
  await screen.rerender(view(registry, remoteId));
  await expect.element(screen.getByLabelText("OpenAI API key")).toHaveValue("");
  await expect
    .element(screen.getByRole("textbox", { name: "Included extensions" }))
    .toHaveValue("");
  await screen.getByRole("button", { name: "Clear API key" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Clear API key" }))
    .not.toBeInTheDocument();
  await screen.rerender(view(registry, laptopId));
  await expect.element(screen.getByLabelText("OpenAI API key")).toHaveValue("");
  await expect.element(screen.getByRole("button", { name: "Clear API key" })).toBeEnabled();
  await expect
    .element(screen.getByRole("textbox", { name: "Included extensions" }))
    .toHaveValue("ts, md");
});

it("allows an available provider's model despite another discovery failure and retains the configured selection", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(view(registry, laptopId));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("OpenAI: Check the OpenAI key.");
  const picker = screen.getByRole("combobox", { name: "Embedding provider and model" });
  await expect.element(picker).toHaveTextContent("Choose an embedding model");
  await picker.click();
  await page.getByRole("option", { name: "LM Studio / local-embedding", exact: true }).click();
  await expect.element(picker).toHaveTextContent("LM Studio / local-embedding");
  await act(() =>
    registry.set(
      state.models!,
      AsyncResult.success({
        models: [],
        failures: [
          {
            provider: "lmstudio",
            error: {
              code: "embedding_unavailable",
              message: "Reconnect LM Studio.",
              relPath: null,
            },
          },
        ],
      }),
    ),
  );
  await expect.element(picker).toHaveTextContent("lmstudio / local-embedding (configured)");
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("LM Studio: Reconnect LM Studio.");
  await screen.rerender(view(registry, remoteId));
  await expect
    .element(screen.getByRole("combobox", { name: "Embedding provider and model" }))
    .toHaveTextContent("Choose an embedding model");
});

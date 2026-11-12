import { AuthSettingsWriteScope, isSecretReference, type EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironment } from "../../state/environments";
import { knowledgeEnvironment } from "../../state/knowledge";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { SecretSourceInput, useSecretSources } from "../settings/SecretSourceInput";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function KnowledgeSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  return <KnowledgeSettingsForm key={environmentId} environmentId={environmentId} />;
}

function KnowledgeSettingsForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const settings = useEnvironmentSettings(environmentId, (value) => value.knowledge);
  const update = useUpdateEnvironmentSettings(environmentId);
  const sources = useSecretSources(environmentId);
  const modelsQuery = useEnvironmentQuery(
    connected ? knowledgeEnvironment.knowledgeEmbeddingModels({ environmentId, input: {} }) : null,
  );
  const indexQuery = useEnvironmentQuery(
    connected ? knowledgeEnvironment.knowledgeLive(environmentId) : null,
  );
  const models =
    modelsQuery.error === null && !modelsQuery.isPending ? (modelsQuery.data?.models ?? []) : [];
  const selectedKey = settings.embedding === null ? "none" : JSON.stringify(settings.embedding);
  const selectedListed = models.some((model) => JSON.stringify(model) === selectedKey);
  const modelOptions = [
    { value: "none", label: "Choose an embedding model" },
    ...(settings.embedding !== null && !selectedListed
      ? [
          {
            value: selectedKey,
            label: `${settings.embedding.provider} / ${settings.embedding.model} (configured)`,
          },
        ]
      : []),
    ...models.map((model) => ({
      value: JSON.stringify(model),
      label: `${model.provider === "openai" ? "OpenAI" : "LM Studio"} / ${model.model}`,
    })),
  ];
  const reference = isSecretReference(settings.openaiApiKey) ? settings.openaiApiKey : undefined;
  const secretConfigured =
    reference !== undefined ||
    (typeof settings.openaiApiKey === "string" && settings.openaiApiKey.length > 0);
  const identity = indexQuery.error === null ? indexQuery.data?.embeddingIdentity : null;
  const disabled = !connected || !canWrite;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        These settings apply to all Knowledge sources on {environment?.label ?? "this environment"}.
      </p>
      {!connected ? (
        <p role="status">Reconnect this environment to change Knowledge settings.</p>
      ) : null}
      {connected && !canWrite ? (
        <p role="status">This connection cannot change environment settings.</p>
      ) : null}
      <fieldset disabled={disabled} className="min-w-0 space-y-5">
        <SettingsSection title="File filters">
          <SettingsRow
            title={<label htmlFor="knowledge-includes">Included extensions</label>}
            description="Comma-separated extensions without dots. Leave empty to use defaults; a custom list replaces defaults."
            control={
              <div className="w-72 max-w-full">
                <DraftInput
                  id="knowledge-includes"
                  value={settings.includes.join(", ")}
                  placeholder="ts, tsx, md"
                  disabled={disabled}
                  onCommit={(next) =>
                    update({
                      knowledge: {
                        includes: next
                          .split(",")
                          .map((part) => part.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                />
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="knowledge-excludes">Additional exclusions</label>}
            description="Comma-separated path segments or suffix rules, not general globs. Defaults, including .repos, stay excluded."
            control={
              <div className="w-72 max-w-full">
                <DraftInput
                  id="knowledge-excludes"
                  value={settings.excludes.join(", ")}
                  placeholder="generated, *.min.js"
                  disabled={disabled}
                  onCommit={(next) =>
                    update({
                      knowledge: {
                        excludes: next
                          .split(",")
                          .map((part) => part.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                />
              </div>
            }
          />
        </SettingsSection>
        <SettingsSection title="Embeddings">
          <SettingsRow
            title={<label htmlFor="knowledge-model">Embedding provider and model</label>}
            description="One embedding model is shared by all indexed sources on this environment."
            control={
              <div className="w-80 max-w-full">
                <Select
                  items={modelOptions}
                  value={selectedKey}
                  disabled={disabled || modelsQuery.isPending}
                  onValueChange={(key) => {
                    if (key === "none") update({ knowledge: { embedding: null } });
                    else {
                      const embedding = models.find((model) => JSON.stringify(model) === key);
                      if (embedding) update({ knowledge: { embedding } });
                    }
                  }}
                >
                  <SelectTrigger id="knowledge-model" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {modelOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="knowledge-lmstudio-url">LM Studio endpoint</label>}
            description="Address of LM Studio on this environment or its network."
            control={
              <div className="w-80 max-w-full">
                <DraftInput
                  id="knowledge-lmstudio-url"
                  value={settings.lmStudioBaseUrl}
                  disabled={disabled}
                  onCommit={(next) => update({ knowledge: { lmStudioBaseUrl: next.trim() } })}
                />
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="knowledge-openai-url">OpenAI endpoint</label>}
            description="Leave empty to use the standard OpenAI endpoint."
            control={
              <div className="w-80 max-w-full">
                <DraftInput
                  id="knowledge-openai-url"
                  value={settings.openaiBaseUrl}
                  disabled={disabled}
                  onCommit={(next) => update({ knowledge: { openaiBaseUrl: next.trim() } })}
                />
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="knowledge-openai-key">OpenAI API key</label>}
            description="Stored on this environment. Enter a replacement or clear the configured value."
            control={
              <div className="flex w-80 max-w-full items-start gap-2">
                <div className="min-w-0 flex-1">
                  <SecretSourceInput
                    id="knowledge-openai-key"
                    aria-label="OpenAI API key"
                    value={reference ?? ""}
                    configured={reference === undefined && secretConfigured}
                    sources={sources}
                    disabled={disabled}
                    onCommit={(next) => update({ knowledge: { openaiApiKey: next } })}
                    onSecretChange={(secret) =>
                      update({ knowledge: { openaiApiKey: secret ?? "" } })
                    }
                  />
                </div>
                {secretConfigured ? (
                  <Button
                    variant="ghost-destructive"
                    size="sm"
                    disabled={disabled}
                    onClick={() => update({ knowledge: { openaiApiKey: "" } })}
                  >
                    Clear API key
                  </Button>
                ) : null}
              </div>
            }
          />
        </SettingsSection>
        <SettingsSection title="Vector storage">
          <SettingsRow
            title={<label htmlFor="knowledge-chroma-url">Chroma URL</label>}
            description="Address of the persistent Chroma service used by this environment."
            control={
              <div className="w-80 max-w-full">
                <DraftInput
                  id="knowledge-chroma-url"
                  value={settings.chromaUrl}
                  disabled={disabled}
                  onCommit={(next) => update({ knowledge: { chromaUrl: next.trim() } })}
                />
              </div>
            }
          />
        </SettingsSection>
      </fieldset>
      {connected ? (
        <div className="space-y-2">
          <Button
            variant="outline"
            size="sm"
            disabled={modelsQuery.isPending}
            onClick={modelsQuery.refresh}
          >
            Refresh embedding models
          </Button>
          {modelsQuery.isPending ? (
            <p role="status" className="text-sm">
              Loading embedding models…
            </p>
          ) : null}
          {modelsQuery.error ? (
            <p role="alert" className="text-sm text-destructive">
              {modelsQuery.error}
            </p>
          ) : null}
          {!modelsQuery.error && modelsQuery.data
            ? modelsQuery.data.failures.map((failure) => (
                <p key={failure.provider} role="alert" className="text-sm text-destructive">
                  {failure.provider === "openai" ? "OpenAI" : "LM Studio"}: {failure.error.message}
                </p>
              ))
            : null}
          <p className="text-xs text-muted-foreground">
            Refresh models after saving endpoint or credential changes.
          </p>
        </div>
      ) : null}
      {identity ? (
        <p className="text-sm text-muted-foreground">
          The index uses {identity.selection.provider} / {identity.selection.model} (
          {identity.dimensions} dimensions). To change models, remove indexed content from every
          source in Knowledge, select the new model, then ingest again.
        </p>
      ) : null}
      {indexQuery.error ? (
        <p role="alert" className="text-sm text-destructive">
          {indexQuery.error}
        </p>
      ) : null}
    </div>
  );
}

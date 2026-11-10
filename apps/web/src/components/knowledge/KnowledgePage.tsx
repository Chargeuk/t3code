import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KnowledgeRunSummary,
  KnowledgeSourceSummary,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { knowledgeEnvironment } from "../../state/knowledge";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { KnowledgeSettings } from "./KnowledgeSettings";
import { KnowledgeSourceForm } from "./KnowledgeSourceForm";

export function KnowledgePage() {
  const { environments, isReady } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const environmentId =
    environments.find((entry) => entry.environmentId === selectedId)?.environmentId ??
    environments.find((entry) => entry.environmentId === primaryId)?.environmentId ??
    environments[0]?.environmentId ??
    null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-y-auto">
      <WorkspacePageContainer>
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Knowledge</h1>
            <p className="text-sm text-muted-foreground">Index repositories on an environment.</p>
          </div>
          {environmentId !== null ? (
            <div className="w-64 max-w-full">
              <Select
                value={environmentId}
                onValueChange={(id) => {
                  const next = environments.find((entry) => entry.environmentId === id);
                  if (next) setSelectedId(next.environmentId);
                }}
              >
                <SelectTrigger aria-label="Knowledge environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </header>
        {environmentId !== null ? (
          <KnowledgeEnvironmentPage key={environmentId} environmentId={environmentId} />
        ) : (
          <p role="status">
            {isReady ? "Connect an environment to index repositories." : "Loading environments…"}
          </p>
        )}
      </WorkspacePageContainer>
    </SidebarInset>
  );
}

function KnowledgeEnvironmentPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const query = useEnvironmentQuery(
    connected ? knowledgeEnvironment.knowledgeLive(environmentId) : null,
  );
  const snapshot = query.data;

  return (
    <>
      <KnowledgeSourceForm environmentId={environmentId} disabled={!connected} />
      {!connected ? (
        <p role="status">Reconnect {environment?.label ?? "this environment"} to view Knowledge.</p>
      ) : query.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {query.error}
          </p>
          <Button variant="outline" size="sm" onClick={query.refresh}>
            Reload Knowledge
          </Button>
        </div>
      ) : snapshot === null ? (
        <p role="status">Loading Knowledge…</p>
      ) : (
        <>
          {snapshot.embeddingIdentity ? (
            <p className="text-sm text-muted-foreground">
              Indexed with {snapshot.embeddingIdentity.selection.provider} /{" "}
              {snapshot.embeddingIdentity.selection.model}
              {" · "}
              {snapshot.embeddingIdentity.dimensions} dimensions. Remove indexed content from all
              sources before changing the embedding model.
            </p>
          ) : null}
          {snapshot.sources.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              No Knowledge sources yet.
            </p>
          ) : (
            <div className="space-y-4">
              {snapshot.sources.map((source) => (
                <KnowledgeSourceRow
                  key={source.sourceId}
                  environmentId={environmentId}
                  source={source}
                />
              ))}
            </div>
          )}
        </>
      )}
      <KnowledgeSettings environmentId={environmentId} />
    </>
  );
}

function KnowledgeSourceRow({
  environmentId,
  source,
}: {
  readonly environmentId: EnvironmentId;
  readonly source: KnowledgeSourceSummary;
}) {
  const canAdmit = useAtomValue(knowledgeEnvironment.knowledgeAdmit.permissionAtom(environmentId));
  const canCancel = useAtomValue(
    knowledgeEnvironment.knowledgeCancel.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    knowledgeEnvironment.knowledgeRemove.permissionAtom(environmentId),
  );
  const admit = useAtomCommand(knowledgeEnvironment.knowledgeAdmit, { reportFailure: false });
  const cancel = useAtomCommand(knowledgeEnvironment.knowledgeCancel, { reportFailure: false });
  const remove = useAtomCommand(knowledgeEnvironment.knowledgeRemove, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = source.latestRun;
  const active = run?.status === "running" && run.operation === "ingest";
  const unsettled =
    run?.status === "queued" || run?.status === "running" || run?.status === "cleanup";

  const act = async (action: "admit" | "cancel" | "remove") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result =
      action === "admit"
        ? await admit({ environmentId, input: { target: { sourceId: source.sourceId } } })
        : action === "cancel" && run !== null
          ? await cancel({ environmentId, input: { runId: run.runId } })
          : await remove({ environmentId, input: { sourceId: source.sourceId } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(formatEnvironmentQueryError(result.cause));
    }
  };

  return (
    <section aria-label={source.root} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="break-all font-mono text-sm font-medium">{source.root}</h2>
          <p className="text-xs text-muted-foreground">
            {source.fileCount} indexed files · {source.chunkCount} chunks
          </p>
        </div>
        {run ? (
          <Badge variant={run.status === "failed" ? "error" : "secondary"}>{run.status}</Badge>
        ) : null}
      </div>
      {run ? (
        <KnowledgeRunProgress run={run} />
      ) : (
        <p className="text-sm text-muted-foreground">Not indexed.</p>
      )}
      {source.astCoverage ? (
        <p className="text-xs text-muted-foreground">
          AST: {source.astCoverage.supportedFileCount} supported ·{" "}
          {source.astCoverage.skippedFileCount} skipped
          {" · "}
          {source.astCoverage.failedFileCount} failed
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canAdmit}
          onClick={() => void act("admit")}
        >
          {source.indexedAt === null ? "Ingest" : "Re-ingest"}
        </Button>
        {active ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !canCancel}
            onClick={() => void act("cancel")}
          >
            Cancel ingest
          </Button>
        ) : null}
        {!unsettled ? (
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={busy || !canRemove}
            onClick={() => void act("remove")}
          >
            Remove indexed content
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function KnowledgeRunProgress({ run }: { readonly run: KnowledgeRunSummary }) {
  return (
    <div className="space-y-1 text-sm">
      <p role="status">
        {run.operation === "remove" ? "Remove indexed content" : "Ingest"}
        {run.status === "queued" ? ` · Queue position ${run.queuePosition ?? "pending"}` : ""}
        {run.stage ? ` · ${run.stage}` : ""}
      </p>
      {run.currentFile ? <p className="break-all font-mono text-xs">{run.currentFile}</p> : null}
      <p className="text-xs text-muted-foreground">
        {run.counts.processedFiles} / {run.counts.discoveredFiles} files processed
        {" · "}
        {run.counts.addedFiles} added · {run.counts.changedFiles} changed
        {" · "}
        {run.counts.deletedFiles} deleted · {run.counts.unchangedFiles} unchanged
        {" · "}
        {run.counts.embeddedChunks} / {run.counts.chunks} chunks embedded
      </p>
      <p className="text-xs text-muted-foreground">
        Updated <time dateTime={run.updatedAt}>{run.updatedAt}</time>
      </p>
      {run.error ? (
        <p role="alert" className="text-sm text-destructive">
          {run.error.message}
          {run.error.relPath ? ` (${run.error.relPath})` : ""}
        </p>
      ) : null}
    </div>
  );
}

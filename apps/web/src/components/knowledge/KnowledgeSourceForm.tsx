import { useAtomValue } from "@effect/atom-react";
import { getFilesystemBrowsePath } from "@t3tools/client-runtime/state/filesystem";
import { ensureBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useId, useState } from "react";

import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { knowledgeEnvironment } from "../../state/knowledge";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function KnowledgeSourceForm({
  environmentId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const inputId = useId();
  const [root, setRoot] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAdmit = useAtomValue(knowledgeEnvironment.knowledgeAdmit.permissionAtom(environmentId));
  const admit = useAtomCommand(knowledgeEnvironment.knowledgeAdmit, { reportFailure: false });
  const resolve = useAtomQueryRunner(knowledgeEnvironment.knowledgeResolve, {
    reportFailure: false,
    refresh: true,
  });
  const access = useFilesystemReadAccess(environmentId);
  const path = getFilesystemBrowsePath(root, "Linux", browsing);
  const folders = useEnvironmentQuery(
    !disabled && access.canReadFiles && path.isBrowsing
      ? filesystemEnvironment.browse({ environmentId, input: { partialPath: root } })
      : null,
  );

  const start = async () => {
    if (disabled || !canAdmit || busy || root.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const resolved = await resolve({ environmentId, input: { root: root.trim() } });
    if (resolved._tag === "Failure") {
      setBusy(false);
      if (!isAtomCommandInterrupted(resolved))
        setError(formatEnvironmentQueryError(resolved.cause));
      return;
    }
    const result = await admit({ environmentId, input: { target: { root: resolved.value.root } } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    setRoot("");
    setBrowsing(false);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
      className="space-y-3"
    >
      <Label htmlFor={inputId}>Repository folder</Label>
      <div className="flex flex-wrap gap-2">
        <div className="min-w-48 flex-1">
          <Input
            id={inputId}
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            placeholder="/path/to/repository"
            spellCheck={false}
            disabled={disabled || busy}
          />
        </div>
        <Button
          variant="outline"
          disabled={disabled || busy || !access.canReadFiles}
          onClick={() => {
            if (root.trim().length === 0) setRoot("~/");
            setBrowsing(!browsing);
          }}
          aria-expanded={browsing}
        >
          Browse folders
        </Button>
        <Button type="submit" disabled={disabled || busy || !canAdmit || root.trim().length === 0}>
          {busy ? "Starting…" : "Add and ingest"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Choose a folder on this environment. Project registration is optional.
      </p>
      {browsing && !disabled ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          {folders.error || access.error ? (
            <p role="alert" className="text-sm text-destructive">
              {folders.error ?? access.error}
            </p>
          ) : folders.isPending ? (
            <p role="status" className="text-sm">
              Loading folders…
            </p>
          ) : folders.data && path.isBrowsing ? (
            <>
              <p className="break-all font-mono text-xs">{folders.data.parentPath}</p>
              {path.parentPath && path.canBrowseUp ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setRoot(path.parentPath ?? root)}
                >
                  Up one folder
                </Button>
              ) : null}
              <div className="flex max-h-48 flex-col items-start gap-1 overflow-y-auto">
                {folders.data.entries.map((entry) => (
                  <Button
                    key={entry.fullPath}
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setRoot(ensureBrowseDirectoryPath(entry.fullPath))}
                  >
                    {entry.name}
                  </Button>
                ))}
                {folders.data.entries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No matching folders.</p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Enter an absolute path or ~/ to browse.</p>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

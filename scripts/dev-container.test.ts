// @effect-diagnostics nodeBuiltinImport:off -- Exercises the dependency-free Docker launcher as a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 container & spaces "));
  NodeFS.mkdirSync(NodePath.join(root, "scripts"));
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "dev-container.mjs"),
    NodePath.join(root, "scripts/dev-container.mjs"),
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "package.json"),
    JSON.stringify({
      engines: { node: "26.12.1" },
      packageManager: "pnpm@12.14.0",
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "pnpm-workspace.yaml"),
    "catalog:\n  vite-plus: 1.4.0\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "preload.cjs"),
    `const fs = require('node:fs');
const childProcess = require('node:child_process');
const { join } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originalStatSync = fs.statSync;
const originalSpawnSync = childProcess.spawnSync;
fs.statSync = (path, ...args) => path === '/var/run/docker.sock'
  ? { gid: 1234 } : originalStatSync(path, ...args);
childProcess.spawnSync = (command, args, options) => command === 'docker'
  ? originalSpawnSync(process.execPath, [join(__dirname, 'docker-mock.mjs'), ...args], options)
  : originalSpawnSync(command, args, options);
syncBuiltinESMExports();
`,
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "docker-mock.mjs"),
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.T3_CONTAINER_FIXTURE;
const args = process.argv.slice(2);
appendFileSync(root + '/calls', JSON.stringify(args) + '\\n');
if (args[0] === 'container') {
  if (!existsSync(root + '/state')) { console.error('Error: No such container'); process.exit(1); }
  console.log(readFileSync(root + '/state', 'utf8'));
} else if (args[0] === 'image') {
  console.log('sha256:test');
} else if (args[0] === 'run') {
  writeFileSync(root + '/state', JSON.stringify({
    Config: { Labels: { 'dev.t3code.workspace': root } }, Image: 'sha256:test', State: { Running: true },
  }));
} else if (args[0] === 'exec') {
  if (args.includes('.devcontainer/update-content.sh')) process.exit(Number(process.env.T3_SETUP_EXIT || 0));
  process.stdout.write(readFileSync(0, 'utf8'));
  process.exit(Number(process.env.T3_EXEC_EXIT || 0));
}
`,
  );
  return {
    root,
    run(args: string[], env: Record<string, string> = {}, input = "") {
      return NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--require",
          NodePath.join(root, "preload.cjs"),
          NodePath.join(root, "scripts/dev-container.mjs"),
          ...args,
        ],
        {
          env: {
            ...process.env,
            T3_CONTAINER_FIXTURE: root,
            ...env,
          },
          encoding: "utf8",
          input,
        },
      );
    },
    calls: () =>
      NodeFS.readFileSync(NodePath.join(root, "calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

it("waits for setup, preserves argv and stdin, and returns the executed status", () => {
  using f = fixture();
  expect(f.run(["up"]).status).toBe(0);
  const args = ["node", "a file.js", "$(touch unwanted)", "a; b", ""];
  const result = f.run(["exec", ...args], { T3_EXEC_EXIT: "37" }, "stdin payload");
  expect(result.status).toBe(37);
  expect(result.stdout).toBe("stdin payload");
  const calls = f.calls();
  expect(calls.at(-1)?.slice(-args.length)).toEqual(args);
  const run = calls.find((call) => call[0] === "run")!;
  expect(run).toContain(`type=bind,source=${f.root},target=${f.root}`);
  expect(run).toContain(
    `type=volume,source=${run[run.indexOf("--name") + 1]}-node-modules,target=${f.root}/node_modules`,
  );
  expect(run).toContain("host");
});

it("does not report readiness when dependency setup fails", () => {
  using f = fixture();
  const result = f.run(["up"], { T3_SETUP_EXIT: "19" });
  expect(result.status).toBe(19);
  expect(result.stdout).not.toContain("ready at");
});

it("refuses to execute or stop a container owned by another checkout", () => {
  using f = fixture();
  NodeFS.writeFileSync(
    NodePath.join(f.root, "state"),
    JSON.stringify({
      Config: { Labels: { "dev.t3code.workspace": "/another/checkout" } },
      State: { Running: true },
    }),
  );
  expect(f.run(["stop"]).status).toBe(1);
  expect(f.run(["exec", "node", "--version"]).status).toBe(1);
  expect(f.calls().every((call) => call[0] === "container")).toBe(true);
});

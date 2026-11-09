import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeFS.realpathSync(
  NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), ".."),
);
const name = `t3code-dev-${NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
const label = "dev.t3code.workspace";
const [action, ...args] = process.argv.slice(2);

function docker(argv, capture = false, missing = false) {
  const result = NodeChildProcess.spawnSync("docker", argv, {
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (missing && result.status !== 0 && /No such (object|container)/i.test(result.stderr)) {
    return undefined;
  }
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr);
    process.exit(result.status ?? 128 + (NodeOS.constants.signals[result.signal] ?? 0));
  }
  return result.stdout?.trim();
}

function inspect() {
  const json = docker(["container", "inspect", "--format", "{{json .}}", name], true, true);
  if (!json) return undefined;
  const container = JSON.parse(json);
  if (container.Config.Labels?.[label] !== root) {
    throw new Error(`Container ${name} does not belong to ${root}.`);
  }
  return container;
}

function exec(argv) {
  const tty = process.stdin.isTTY && process.stdout.isTTY ? ["--tty"] : [];
  docker(["exec", "--interactive", ...tty, "--workdir", root, name, ...argv]);
}

try {
  if (action === "up" && args.length === 0) {
    const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
    const vp = NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8").match(
      /^  vite-plus: (\d[^\s]*)$/m,
    )?.[1];
    if (!vp) throw new Error("Missing pinned vite-plus version in pnpm-workspace.yaml.");
    const owner = NodeFS.statSync(root);
    docker([
      "build",
      "--tag",
      name,
      "--build-arg",
      `NODE_VERSION=${pkg.engines.node}`,
      "--build-arg",
      `PNPM_VERSION=${pkg.packageManager.split("@")[1]}`,
      "--build-arg",
      `VP_VERSION=${vp}`,
      "--build-arg",
      `WORKSPACE_UID=${owner.uid}`,
      "--build-arg",
      `WORKSPACE_GID=${owner.gid}`,
      NodePath.join(root, ".devcontainer"),
    ]);
    const image = docker(["image", "inspect", "--format", "{{.Id}}", name], true);
    let container = inspect();
    if (container && container.Image !== image) {
      docker(["stop", name]);
      docker(["rm", name]);
      container = undefined;
    }
    if (!container) {
      const volumes = [
        ["node-modules", `${root}/node_modules`],
        ["cache", "/home/vscode/.cache"],
        ["state", `${root}/.t3`],
        ["cargo-registry", "/home/vscode/.cargo/registry"],
        ["cargo-target", `${root}/native/resource-monitor/target`],
      ];
      docker([
        "run",
        "--detach",
        "--init",
        "--name",
        name,
        "--label",
        `${label}=${root}`,
        "--network",
        "host",
        "--group-add",
        String(NodeFS.statSync("/var/run/docker.sock").gid),
        "--workdir",
        root,
        "--env",
        `T3CODE_HOME=${root}/.t3`,
        "--env",
        "T3CODE_DEV_SEED=0",
        "--mount",
        `type=bind,source=${root},target=${root}`,
        "--mount",
        "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
        ...volumes.flatMap(([suffix, target]) => [
          "--mount",
          `type=volume,source=${name}-${suffix},target=${target}`,
        ]),
        name,
        "sleep",
        "infinity",
      ]);
    } else if (!container.State.Running) {
      docker(["start", name]);
    }
    exec(["bash", ".devcontainer/update-content.sh"]);
    console.log(`${name} ready at ${root}. Use npm run container:exec -- <command> [args].`);
  } else if (action === "stop" && args.length === 0) {
    if (inspect()) docker(["stop", name]);
  } else if (action === "exec" || action === "dev") {
    if (!inspect()?.State.Running) {
      throw new Error(`${name} is not running. Run npm run container:up first.`);
    }
    if (action === "exec" && args.length === 0)
      throw new Error("Pass a command to container:exec.");
    exec(action === "dev" ? ["vp", "run", "dev", ...args] : args);
  } else {
    throw new Error(
      "Use container:up, container:exec -- <command> [args], container:dev, or container:stop.",
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

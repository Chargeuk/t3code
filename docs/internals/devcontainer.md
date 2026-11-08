# Linux development container

This is a same-host Linux development mode for a T3 Code checkout used through CodeInfo2. It keeps CodeInfo2's flow, plan helpers, and agents on the host while running T3 Code tools and the app in a repository-shaped container. The host needs Node.js/npm and Docker with access to its daemon; it does not need the T3 Code Node, pnpm, Vite+, Rust, or browser toolchain.

From the T3 Code repository root, start or refresh the dedicated container and run its content setup:

```sh
npm run container:up
```

Run existing commands inside it by passing their arguments unchanged:

```sh
npm run container:exec -- vp test run apps/server/src/serviceLauncher.test.ts
npm run container:exec -- cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
```

To run the regular dev server in the foreground and keep its output attached to the terminal:

```sh
npm run container:dev
```

Use the printed `[dev-runner]` ports and pairing URL. The standalone container uses host networking, so its loopback ports are the host's loopback ports; from CodeInfo2 on that same host, the web and server endpoints are reachable on `127.0.0.1`. Keep the printed pairing URL private and do not replace it with the bare web origin.

For the VS Code/Codespaces entry point, open the repository in VS Code and choose **Dev Containers: Reopen in Container**, or create a Codespace. Its configuration forwards the web and server ports (5733 and 13773). The printed pairing URL works through VS Code's localhost forwarding; in browser Codespaces, if the forwarded origin is rejected, pass that origin through `T3CODE_DEV_ALLOWED_ORIGINS`.

## Host and container boundary

The launcher derives the checkout's absolute real path, owning UID/GID, and a container name from that path. It builds an Ubuntu 24.04 image with the repository's pinned Node, pnpm, and Vite+ versions, Rust stable plus rustfmt, native build tools, Python, pkg-config/libsecret, Docker CLI/Compose, Electron's Linux libraries, and headless Chromium support. The container's user matches the checkout owner. It receives the exact Docker socket group ID and bind-mounts the host Docker socket; this gives container commands access to the host Docker daemon. The socket is not replaced by a nested daemon.

The checkout is bind-mounted at the same absolute path inside the container. This preserves workspace paths used by tools and CodeInfo2 while keeping repository writes owned by the host user. The launcher does not forward the host home or credentials, and sets `T3CODE_HOME` to the checkout's `.t3` with seeding disabled. It does not change Vite's HTTP or WebSocket origins.

Named volumes persist root `node_modules` (including pnpm's content-addressable and virtual stores), the user's cache (including Chromium's headless browser download), `.t3` runtime state, the Cargo registry, and the resource-monitor Cargo target. Electron's installed runtime lives under `node_modules`. `npm run container:stop` stops only this checkout's labeled container; it does not delete these volumes. `npm run container:up` reuses the container and volumes when the image is unchanged. If the image changes, it replaces only the identified container and reuses the volumes. Reopening or recreating the container therefore keeps dependency and runtime state; do not remove its named volumes to restart development.

The Dev Container entry point starts from the Ubuntu 24.04 Dev Containers base and adds Node, Rust, and GitHub CLI through Dev Container features. The standalone Dockerfile builds from the same Ubuntu 24.04 base with pinned toolchain build arguments. Both entry points reuse `on-create.sh` and `update-content.sh`; the standalone launcher runs `update-content.sh` before reporting readiness, so dependency installation, Electron's post-install repair, Chromium installation, and Vite's dependency-cache warmup finish first.

## What works

- Linux web and server development, focused tests, typechecks, lint, and headless browser tests.
- Headless desktop bundle/build work and Rust native builds, including the resource monitor.
- Mobile JavaScript typechecking and static checks that do not require a native mobile SDK.

Windowed Electron development and device interaction remain host-side. iOS builds need macOS/Xcode; Android native builds need the Android SDK. The container does not provide a display or mobile SDK. `vp run dev --share` also needs a tailscale binary and tailnet, which are not provisioned here.

## Stop and state

Stop only processes started for your proof using their retained terminal sessions or captured PIDs. Stop the dedicated workspace container when you want to stop its shell environment:

```sh
npm run container:stop
```

This does not delete dependencies, cache, Cargo artifacts, or `.t3` state. The default workflow leaves the workspace container running for reuse. Avoid database migration or seeding against live `~/.t3/userdata`; this container explicitly uses isolated workspace state and disables automatic seeding.

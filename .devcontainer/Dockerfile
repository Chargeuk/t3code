ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04
ARG PNPM_VERSION
ARG VP_VERSION
ARG WORKSPACE_UID=1000
ARG WORKSPACE_GID=1000
COPY --from=node /usr/local/ /usr/local/
RUN if [ "$(id -g vscode)" != "$WORKSPACE_GID" ]; then groupmod -g "$WORKSPACE_GID" vscode; fi \
    && if [ "$(id -u vscode)" != "$WORKSPACE_UID" ]; then usermod -u "$WORKSPACE_UID" vscode; fi \
    && npm install --global "pnpm@${PNPM_VERSION}"
ENV VP_VERSION=${VP_VERSION}
ENV PATH="/home/vscode/.cargo/bin:/home/vscode/.local/share/vite-plus/bin:${PATH}"
COPY on-create.sh /tmp/t3-on-create.sh
USER vscode
RUN bash /tmp/t3-on-create.sh \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && bash /tmp/rustup.sh -y --profile minimal --default-toolchain stable --component rustfmt \
    && rm /tmp/rustup.sh \
    && mkdir -p /home/vscode/.cargo/registry
CMD ["sleep", "infinity"]

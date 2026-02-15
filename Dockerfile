FROM node:22-bookworm

ARG OPENCLAW_VERSION=v2026.2.14
ARG OPENCLAW_DOCKER_APT_PACKAGES=""

# Install build tools needed by OpenClaw deps and clone source.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      python3 \
      make \
      g++ \
      ripgrep \
      $OPENCLAW_DOCKER_APT_PACKAGES && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# Keep source-of-truth version pinned in Dockerfile.
RUN git clone --depth 1 --branch "$OPENCLAW_VERSION" https://github.com/openclaw/openclaw.git /app && \
    echo "$OPENCLAW_VERSION" > /app/OPENCLAW_VERSION

WORKDIR /app

ENV CI=1
ENV PNPM_WORKSPACE_CONCURRENCY=1
ENV NODE_OPTIONS="--max-old-space-size=2048"

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm ui:build

ENV NODE_ENV=production
ENV OPENCLAW_PREFER_PNPM=1

# Run as non-root for security.
RUN chown -R node:node /app
USER node

# Render injects PORT. We must use it, not hardcode 8080.
CMD ["sh","-lc","node openclaw.mjs gateway --allow-unconfigured --bind lan --port ${PORT}"]

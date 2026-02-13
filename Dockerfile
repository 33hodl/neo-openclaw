FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git \
      python3 \
      make \
      g++ \
      $OPENCLAW_DOCKER_APT_PACKAGES && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

ENV CI=1
ENV PNPM_WORKSPACE_CONCURRENCY=1
ENV NODE_OPTIONS="--max-old-space-size=2048"

RUN pnpm install --frozen-lockfile

COPY . .
RUN bash -lc 'set -euxo pipefail; pnpm --version; node -v; pnpm build --reporter=append-only --loglevel=debug 2>&1 | tee /tmp/pnpm-build.log; echo "PNPM BUILD OK"'
RUN bash -lc 'if [ -f /tmp/pnpm-build.log ]; then echo "==== PNPM BUILD LOG (tail 400) ===="; tail -n 400 /tmp/pnpm-build.log; fi'

# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Run as non-root user for security
USER node

# Render injects PORT. We must use it, not hardcode 8080.
CMD ["sh","-lc","node openclaw.mjs gateway --allow-unconfigured --bind lan --port ${PORT}"]

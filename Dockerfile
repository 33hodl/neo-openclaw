ARG OPENCLAW_VERSION=v2026.2.13

FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

USER root

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git \
      python3 \
      make \
      g++ \
      ripgrep \
      $OPENCLAW_DOCKER_APT_PACKAGES && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

ENV NODE_ENV=production
ENV OPENCLAW_PREFER_PNPM=1

USER node

# Render injects PORT. We must use it, not hardcode 8080.
CMD ["sh","-lc","openclaw gateway --allow-unconfigured --bind lan --port ${PORT}"]

# OpenClaw Deployment Notes

## Pinned OpenClaw Release

This deployment is pinned to a specific OpenClaw release in two places:

- `OPENCLAW_VERSION` (source-of-truth file): currently `v2026.2.13`
- `Dockerfile` (`ARG OPENCLAW_VERSION=...`) used as the Docker image tag in `FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}`

## How to bump next time

1. Update `OPENCLAW_VERSION` to the new tag (example: `v2026.2.14`).
2. Update `Dockerfile` line `ARG OPENCLAW_VERSION=...` to the same tag.
3. Commit and open a PR.

The workflow `.github/workflows/bump-openclaw-release.yml` automates this and opens a PR when a newer release is found.

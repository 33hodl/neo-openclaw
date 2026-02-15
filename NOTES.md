# OpenClaw Deployment Notes

## Pinned OpenClaw Release

This deployment is pinned to a specific OpenClaw release in one place:

- `Dockerfile` (`ARG OPENCLAW_VERSION=...`): currently `v2026.2.14`

## How to bump next time

1. Update `Dockerfile` line `ARG OPENCLAW_VERSION=...` to the new tag (example: `v2026.2.14`).
2. Commit and open a PR.

The workflow `.github/workflows/bump-openclaw-release-daily.yml` automates this and opens a PR when a newer release is found.

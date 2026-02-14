# Render Data Backup Runbook

## What to back up

- `/data/.openclaw`
- `/data/workspace`

## Manual backup (Render Shell)

Run in the web service shell:

```bash
set -euo pipefail
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="/tmp/openclaw-data-${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C / data/.openclaw data/workspace
ls -lh "$ARCHIVE"
echo "$ARCHIVE"
```

Download:

- In Render Shell, download the printed archive path from `/tmp` (or copy it out using your shell/UI download action).

## Restore (Render Shell)

Upload your backup archive to `/tmp` in Render shell, then run:

```bash
set -euo pipefail
ARCHIVE="/tmp/openclaw-data-YYYYMMDD-HHMMSS.tar.gz" # set your filename
tar -xzf "$ARCHIVE" -C /
ls -la /data/.openclaw
ls -la /data/workspace
```

Then restart the web service from Render dashboard.

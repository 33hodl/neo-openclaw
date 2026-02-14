# Render Data Backup Runbook

## What to back up

- `/data/.openclaw`
- `/data/workspace`
- Required env var on Render web service:
  - `OPENCLAW_CONFIG_PATH=/data/.openclaw/openclaw.json`
- Verify in Render web shell:
  - `echo $OPENCLAW_CONFIG_PATH`
- Logs/config path note:
  - Startup logs may show active config path; if not shown, that is expected.

## Cloud backups (recommended)

Required Render env vars:

- `OPENCLAW_BACKUP_S3_ENDPOINT`
- `OPENCLAW_BACKUP_S3_REGION`
- `OPENCLAW_BACKUP_S3_BUCKET`
- `OPENCLAW_BACKUP_S3_PREFIX`
- `OPENCLAW_BACKUP_S3_ACCESS_KEY_ID`
- `OPENCLAW_BACKUP_S3_SECRET_ACCESS_KEY`

Backup command:

```bash
node scripts/backup-to-s3.mjs
```

Restore command:

```bash
node scripts/restore-from-s3.mjs <object-key>
```

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

## First backup drill (do this once)

Run in Render web shell:

```bash
set -euo pipefail
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="/tmp/openclaw-backup-drill-${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C / data/.openclaw data/workspace
ls -lh "$ARCHIVE"
echo "Download this file from Render shell UI: $ARCHIVE"
```

## Restore drill (after uploading archive back to `/tmp`)

Run in Render web shell:

```bash
set -euo pipefail
ARCHIVE="/tmp/openclaw-backup-drill-YYYYMMDD-HHMMSS.tar.gz"
tar -xzf "$ARCHIVE" -C /
ls -la /data/.openclaw
ls -la /data/workspace
```

Then restart the web service.

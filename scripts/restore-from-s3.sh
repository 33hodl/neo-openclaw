#!/usr/bin/env bash
set -euo pipefail
node scripts/restore-from-s3.mjs "$@"

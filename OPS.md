# OPS Runbook

## Service

- Render URL: `https://openclaw-ttrj.onrender.com`

## Render dashboard settings (must match repo)

- Do not set a manual Start Command override in Render dashboard.
- Use repo start command only:
  - `node openclaw.mjs gateway --allow-unconfigured --bind lan --port ${PORT}`
- If a Start Command override exists, delete it in Render service settings.
- Required env var:
  - `OPENCLAW_CONFIG_PATH=/data/.openclaw/openclaw.json`
- Verify in Render web shell:
  - `echo $OPENCLAW_CONFIG_PATH`
- Logs/config path note:
  - Some builds print the active config path at startup; if not printed, this is expected.
  - Primary verification is the env var value in shell.

## Version check

Run in Render shell:

```bash
node /app/dist/index.js --version
```

## Upgrade steps

1. Merge latest changes to `main`.
2. In Render dashboard, open `openclaw` web service.
3. Click `Manual Deploy` -> `Deploy latest commit` (or let auto-deploy run).
4. Watch deploy logs until status is `live`.

## Rollback steps

1. In Render dashboard, open `openclaw` web service.
2. Open `Deploys`.
3. Find the last known good deploy.
4. Click `Redeploy` (or deploy that previous commit).
5. Confirm status returns to `live`.

## Post-deploy smoke tests

- Health endpoint:
  - `GET https://openclaw-ttrj.onrender.com/health` returns success.
- UI:
  - Open service URL and confirm app loads.
- Telegram:
  - Send DM `ping` and confirm immediate `pong`.

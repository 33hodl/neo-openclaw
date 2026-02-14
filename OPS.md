# OPS Runbook

## Service

- Render URL: `https://openclaw-ttrj.onrender.com`

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

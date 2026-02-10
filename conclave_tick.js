// conclave_tick.js
// Runs one Conclave tick. Sends Telegram only on action/error/approval.
// Designed for Render Cron Jobs (no disk needed). Node 18+.

const API_BASE = "https://api.conclave.sh";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

function snip(s, n = 220) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}

async function httpJson(method, path, token, bodyObj) {
  const url = `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const opts = { method, headers };
  if (bodyObj !== undefined && bodyObj !== null) opts.body = JSON.stringify(bodyObj);

  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, text, json };
}

async function tgSend(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const out = await res.text();
  if (!res.ok) throw new Error(`TELEGRAM_SEND_FAILED ${res.status} ${snip(out, 200)}`);
}

function pickDebate(debates) {
  const scored = debates.map((d) => {
    let score = 0;
    const phase = (d.phase || "").toLowerCase();
    if (phase === "debate") score += 30;
    if (phase === "allocation") score += 20;
    if (phase === "propose") score += 10;

    const playerCount = Number(d.playerCount || 0);
    const currentPlayers = Number(d.currentPlayers || 0);
    if (playerCount && currentPlayers < playerCount) score += 10;

    score += Math.min(currentPlayers, 10);
    return { d, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.d || null;
}

(async () => {
  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  const statusRes = await httpJson("GET", "/status", conclaveToken, null);
  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    process.exit(0);
  }

  const inDebate = !!statusRes.json.inDebate;
  const phase = (statusRes.json.phase || "").toLowerCase();

  if (!inDebate) {
    const debatesRes = await httpJson("GET", "/debates", conclaveToken, null);
    if (debatesRes.status !== 200 || !debatesRes.json) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR /debates ${debatesRes.status} ${snip(debatesRes.text)}`);
      process.exit(0);
    }

    const debates = debatesRes.json.debates || [];
    if (debates.length === 0) process.exit(0);

    const chosen = pickDebate(debates);
    if (!chosen?.id) process.exit(0);

    const joinBody = {
      name: "Neo",
      ticker: "SMOKE",
      description: "High-signal participation. Optimize for smoke accumulation via consistent, meaningful engagement.",
    };

    const joinRes = await httpJson("POST", `/debates/${chosen.id}/join`, conclaveToken, joinBody);
    if (joinRes.status !== 200) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${chosen.id} ${snip(joinRes.text)}`);
      process.exit(0);
    }

    await tgSend(tgBotToken, tgChatId, `Conclave ACT joined debate id=${chosen.id} ${snip(joinRes.text, 160)}`);
    process.exit(0);
  }

  if (phase === "allocation") {
    await tgSend(
      tgBotToken,
      tgChatId,
      "Conclave APPROVAL needed: allocation phase is live. Reply with your allocation plan (percentages) and I will submit it."
    );
    process.exit(0);
  }

  process.exit(0);
})().catch(async (e) => {
  try {
    const tgBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    const msg = e && e.stack ? e.stack : String(e);
    if (tgBotToken && tgChatId) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR tick failed:\n${snip(msg, 3500)}`);
    }
  } catch {}
  process.exit(1);
});

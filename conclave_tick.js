// conclave_tick.js
// Runs one Conclave tick. Sends Telegram only on action/error/approval.
// Optional debug: set CONCLAVE_TICK_DEBUG=1 to log to Render.

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

function isOn(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
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

function safeErrMsg(joinRes) {
  const j = joinRes.json;
  if (j && (j.error || j.message)) return String(j.error || j.message);
  return String(joinRes.text || "");
}

function pickDebatesOrdered(debates) {
  const phaseWeight = (p) => {
    p = (p || "").toLowerCase();
    if (p === "debate") return 30;
    if (p === "allocation") return 20;
    if (p === "propose") return 10;
    return 0;
  };

  const scored = debates.map((d) => {
    const score = phaseWeight(d.phase) + Math.min(Number(d.currentPlayers || d.players || d.participants || 0), 10);
    return { d, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.d);
}

(async () => {
  const debug = isOn("CONCLAVE_TICK_DEBUG");

  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  if (debug) console.error(`[conclave_tick] start ${new Date().toISOString()} cwd=${process.cwd()}`);

  const statusRes = await httpJson("GET", "/status", conclaveToken, null);
  if (debug) console.error(`[conclave_tick] /status ${statusRes.status}`);

  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    process.exit(0);
  }

  const inDebate = !!statusRes.json.inDebate;
  const phase = (statusRes.json.phase || "").toLowerCase();
  if (debug) console.error(`[conclave_tick] inDebate=${inDebate} phase=${phase}`);

  if (!inDebate) {
    const debatesRes = await httpJson("GET", "/debates", conclaveToken, null);
    if (debug) console.error(`[conclave_tick] /debates ${debatesRes.status}`);

    if (debatesRes.status !== 200 || !debatesRes.json) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR /debates ${debatesRes.status} ${snip(debatesRes.text)}`);
      process.exit(0);
    }

    const debates = debatesRes.json.debates || [];
    if (debug) console.error(`[conclave_tick] debates=${debates.length}`);
    if (debates.length === 0) process.exit(0);

    const ordered = pickDebatesOrdered(debates);
    const joinBody = {
      name: "Neo",
      ticker: "SMOKE",
      description: "High-signal participation. Optimize for smoke accumulation via consistent, meaningful engagement.",
    };

    const maxAttempts = Math.min(5, ordered.length);
    let fullCount = 0;

    for (let idx = 0; idx < maxAttempts; idx++) {
      const d = ordered[idx];
      if (!d?.id) continue;

      if (debug) console.error(`[conclave_tick] attempt=${idx + 1}/${maxAttempts} id=${d.id}`);

      const joinRes = await httpJson("POST", `/debates/${d.id}/join`, conclaveToken, joinBody);
      if (debug) console.error(`[conclave_tick] join ${joinRes.status} id=${d.id}`);

      if (joinRes.status === 200) {
        await tgSend(tgBotToken, tgChatId, `Conclave ACT joined debate id=${d.id} ${snip(joinRes.text, 160)}`);
        process.exit(0);
      }

      const errMsg = safeErrMsg(joinRes);
      const isFull = errMsg.toLowerCase().includes("full");

      if (isFull) {
        fullCount += 1;
        continue;
      }

      await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${d.id} ${snip(joinRes.text)}`);
      process.exit(0);
    }

    if (fullCount === maxAttempts) {
      // Optional: one message so you know everything is full
      await tgSend(tgBotToken, tgChatId, `Conclave INFO: tried ${maxAttempts} debates, all were full. Will retry next run.`);
    }

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
  const msg = e && e.stack ? e.stack : String(e);
  console.error("Conclave tick failed:", msg);

  try {
    const tgBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    if (tgBotToken && tgChatId) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR tick failed:\n${snip(msg, 3500)}`);
    }
  } catch (err2) {
    const msg2 = err2 && err2.stack ? err2.stack : String(err2);
    console.error("Also failed to send Telegram error:", msg2);
  }

  process.exit(1);
});

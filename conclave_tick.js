// conclave_tick.js
// One Conclave tick. Telegram only on: action, approval needed, error.
// Node 18+.

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
  if (bodyObj !== undefined && bodyObj !== null) {
    opts.body = JSON.stringify(bodyObj);
  }

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
  // Conservative: pick first open debate that is not full, if those fields exist.
  // Fallback: first item.
  if (!Array.isArray(debates) || debates.length === 0) return null;

  const notFull = debates.find(d => {
    if (typeof d.currentPlayers === "number" && typeof d.playerCount === "number") {
      return d.currentPlayers < d.playerCount;
    }
    return true;
  });

  return notFull || debates[0];
}

(async () => {
  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  // 1) Status
  const statusRes = await httpJson("GET", "/status", conclaveToken, null);
  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    return;
  }

  const inDebate = !!statusRes.json.inDebate;
  const phase = statusRes.json.phase || "";

  // 2) Not in debate: join best available debate (auto-join is allowed)
  if (!inDebate) {
    const debatesRes = await httpJson("GET", "/debates", conclaveToken, null);
    if (debatesRes.status !== 200 || !debatesRes.json) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR /debates ${debatesRes.status} ${snip(debatesRes.text)}`);
      return;
    }

    const debates = debatesRes.json.debates || [];
    const picked = pickDebate(debates);

    if (!picked) {
      // Silent no-op: nothing to do
      return;
    }

    const debateId = picked.id;
    const joinBody = {
      name: "Neo",
      ticker: "SMOKE",
      description: "High-signal participation to maximize smoke accumulation through consistent debate activity."
    };

    const joinRes = await httpJson("POST", `/debates/${debateId}/join`, conclaveToken, joinBody);
    if (joinRes.status !== 200) {
      await tgSend(
        tgBotToken,
        tgChatId,
        `Conclave ERR join ${joinRes.status} id=${debateId} ${snip(joinRes.text)}`
      );
      return;
    }

    await tgSend(tgBotToken, tgChatId, `Conclave ACT joined debate id=${debateId} phase=${joinRes.json?.phase || "?"}`);
    return;
  }

  // 3) In debate: allocation always needs approval
  if (phase === "allocation") {
    await tgSend(
      tgBotToken,
      tgChatId,
      `Conclave APPROVAL needed: allocation phase. Tell me if you want auto-allocation rules or manual approval only.`
    );
    return;
  }

  // 4) Debate phase: safe default is pass. Silent unless it errors.
  const passRes = await httpJson("POST", "/pass", conclaveToken, null);
  if (passRes.status !== 200) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /pass ${passRes.status} ${snip(passRes.text)}`);
    return;
  }

  // Silent pass to avoid spam
  return;

})().catch(async (e) => {
  try {
    const tgBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    if (tgBotToken && tgChatId) {
      await tgSend(tgBotToken, tgChatId, `Conclave Tick crashed: ${snip(String(e), 240)}`);
    }
  } catch {}
  console.error(e);
  process.exit(1);
});

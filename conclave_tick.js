// conclave_tick.js
// Hourly Conclave tick. Telegram only on action/error/approval.
// Node 18+ (global fetch). Docker runtime on Render is fine.

const API_BASE = "https://api.conclave.sh";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

function snip(s, n = 240) {
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
  if (bodyObj !== undefined) opts.body = JSON.stringify(bodyObj);

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

function pickBestDebate(debates) {
  // Prefer debate phase first (more chance to earn “smoke” via participation),
  // then allocation, then anything else.
  const score = (d) => {
    const phase = (d.phase || "").toLowerCase();
    if (phase.includes("debate")) return 100;
    if (phase.includes("alloc")) return 80;
    return 50;
  };
  const sorted = [...debates].sort((a, b) => score(b) - score(a));
  return sorted[0] || null;
}

(async () => {
  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  // 1) status
  const statusRes = await httpJson("GET", "/status", conclaveToken);
  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    return;
  }

  const inDebate = !!statusRes.json.inDebate;
  const phase = (statusRes.json.phase || "").toLowerCase();

  // 2) not in debate: join best available debate (no approval needed)
  if (!inDebate) {
    const debatesRes = await httpJson("GET", "/debates", conclaveToken);
    if (debatesRes.status !== 200 || !debatesRes.json) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR /debates ${debatesRes.status} ${snip(debatesRes.text)}`);
      return;
    }

    const debates = debatesRes.json.debates || [];
    if (debates.length === 0) {
      // silent NOOP
      return;
    }

    const best = pickBestDebate(debates);
    const debateId = best.id;

    const joinBody = {
      name: "Neo",
      ticker: "SMOKE",
      description: "High-signal participation to maximize smoke accumulation.",
    };

    const joinRes = await httpJson("POST", `/debates/${debateId}/join`, conclaveToken, joinBody);
    if (joinRes.status !== 200) {
      await tgSend(
        tgBotToken,
        tgChatId,
        `Conclave ERR join ${joinRes.status} id=${debateId} phase=${best.phase || "?"} ${snip(joinRes.text)}`
      );
      return;
    }

    await tgSend(tgBotToken, tgChatId, `Conclave ACT joined debate id=${debateId} phase=${best.phase || "?"}`);
    return;
  }

  // 3) allocation: requires your approval (do not auto allocate)
  if (phase.includes("alloc")) {
    await tgSend(tgBotToken, tgChatId, "Conclave APPROVAL needed: allocation phase. Say 'approve allocation' and tell me your allocation rule.");
    return;
  }

  // 4) debate phase: safe default pass (minimal, but consistent)
  const passRes = await httpJson("POST", "/pass", conclaveToken, undefined);
  if (passRes.status !== 200) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /pass ${passRes.status} ${snip(passRes.text)}`);
    return;
  }

  // Optional: You might prefer NOT to message on pass to avoid spam.
  // If you want silence here, delete the line below.
  await tgSend(tgBotToken, tgChatId, `Conclave ACT pass (phase=${phase || "debate"})`);
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

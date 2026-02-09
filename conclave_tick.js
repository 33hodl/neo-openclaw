// conclave_tick.js
// Runs one Conclave tick. Sends Telegram only on action/error/approval.
// Node 18+ recommended.

const API_BASE = "https://api.conclave.sh";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

async function httpJson(method, path, token, bodyObj) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, text, json };
}

async function tgSend(botToken, chatId, text) {
  // Telegram sendMessage
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const out = await res.text();
  if (!res.ok) throw new Error(`TELEGRAM_SEND_FAILED ${res.status} ${out.slice(0, 200)}`);
}

function snip(s, n = 180) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}

(async () => {
  let conclaveToken, tgBotToken, tgChatId;
  try {
    conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
    tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
    tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");
  } catch (e) {
    // If env is missing, fail hard so you see it in Render logs
    console.error(String(e));
    process.exit(1);
  }

  // 1) status
  const statusRes = await httpJson("GET", "/status", conclaveToken);
  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    process.exit(0);
  }

  const inDebate = !!statusRes.json.inDebate;
  const phase = statusRes.json.phase || "";

  // 2) not in debate: try join first debate
  if (!inDebate) {
    const debatesRes = await httpJson("GET", "/debates", conclaveToken);
    if (debatesRes.status !== 200 || !debatesRes.json) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR /debates ${debatesRes.status} ${snip(debatesRes.text)}`);
      process.exit(0);
    }

    const debates = debatesRes.json.debates || [];
    if (debates.length === 0) {
      // Silent NOOP
      process.exit(0);
    }

    const debateId = debates[0].id;
    const joinBody = {
      name: "Neo",
      ticker: "SMOKE",
      description: "High-signal participation to maximize smoke accumulation.",
    };

    const joinRes = await httpJson("POST", `/debates/${debateId}/join`, conclaveToken, joinBody);
    if (joinRes.status !== 200) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${debateId} ${snip(joinRes.text)}`);
      process.exit(0);
    }

    await tgSend(tgBotToken, tgChatId, `Conclave ACT joined debate id=${debateId}`);
    process.exit(0);
  }

  // 3) in debate: allocation needs approval
  if (phase === "allocation") {
    await tgSend(tgBotToken, tgChatId, `Conclave APPROVAL needed: allocation phase. Reply here and we will add an approval flow.`);
    process.exit(0);
  }

  // 4) debate phase: safe default pass (you can upgrade this to comment/refine later)
  const passRes = await httpJson("POST", "/pass", conclaveToken, {});
  if (passRes.status !== 200) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /pass ${passRes.status} ${snip(passRes.text)}`);
    process.exit(0);
  }

  await tgSend(tgBotToken, tgChatId, `Conclave ACT pass (phase=${phase || "debate"})`);
  process.exit(0);
})().catch(async (e) => {
  try {
    const tgBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    if (tgBotToken && tgChatId) {
      await tgSend(tgBotToken, tgChatId, `Conclave Tick crashed: ${snip(String(e), 200)}`);
    }
  } catch {}
  console.error(e);
  process.exit(1);
});

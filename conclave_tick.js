// conclave_tick.js
// Runs one Conclave tick. Minimal-noise automation.
// Telegram only on: errors, low balance, join/allocate success, optional daily summary at 8pm SGT.
// Optional debug: CONCLAVE_TICK_DEBUG=1

const API_BASE = "https://api.conclave.sh";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

function snip(s, n = 220) {
  if (!s) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n) + "..." : str;
}

function isOn(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function numEnv(name, fallback) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
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

function safeErrMsg(res) {
  const j = res.json;
  if (j && (j.error || j.message)) return String(j.error || j.message);
  return String(res.text || "");
}

function phaseWeight(p) {
  p = (p || "").toLowerCase();
  if (p === "debate") return 30;
  if (p === "allocation") return 20;
  if (p === "proposal" || p === "propose") return 10;
  return 0;
}

function pickDebatesOrdered(debates) {
  const scored = debates.map((d) => {
    const players = Number(d.currentPlayers || d.players || d.participants || 0);
    const score = phaseWeight(d.phase) + Math.min(players, 10);
    return { d, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.d);
}

function nowUtc() {
  return new Date();
}

function shouldSendDailySummaryUtc(now) {
  // 8pm SGT == 12:00 UTC.
  // Your cron runs at minute 0 and 30, so this triggers once daily at 12:00 UTC.
  if (!isOn("CONCLAVE_DAILY_SUMMARY")) return false;
  return now.getUTCHours() === 12 && now.getUTCMinutes() === 0;
}

function formatEth(n) {
  if (!Number.isFinite(n)) return "unknown";
  return n.toFixed(6);
}

function parseBalanceEth(balanceRes) {
  // We do not know Conclave's exact shape, handle common possibilities safely.
  const j = balanceRes.json || {};
  const b =
    j.balanceEth ??
    j.balanceETH ??
    j.balance ??
    j.eth ??
    (typeof j.balance === "string" ? Number(j.balance) : undefined);

  const n = typeof b === "string" ? Number(b) : Number(b);
  return Number.isFinite(n) ? n : null;
}

function buildAutoAllocations(ideas, selfPct) {
  // Conclave rules: must allocate to 2+ ideas, total 100, max 60 per idea.
  // We want low-risk diversified default and a small self-bias for smoke incentives.

  const pctSelf = Math.max(0, Math.min(60, Math.floor(selfPct)));
  const others = (ideas || []).filter((x) => x && (x.ideaId || x.id) && x.ticker);
  if (others.length < 2) return null;

  // Identify self idea by ticker if present
  const selfTicker = (process.env.CONCLAVE_SELF_TICKER || "SMOKE").trim().toUpperCase();
  const selfIdea = others.find((x) => String(x.ticker || "").toUpperCase() === selfTicker) || null;

  // Build candidate list excluding self, then take top 3 others
  const otherIdeas = others.filter((x) => x !== selfIdea);
  const pickOthers = otherIdeas.slice(0, 3);

  // If no self idea in list, we still allocate to 2+ others.
  const allocs = [];

  if (selfIdea && pctSelf > 0) {
    allocs.push({ ideaId: String(selfIdea.ideaId || selfIdea.id), percentage: pctSelf });
  }

  const remaining = 100 - allocs.reduce((s, a) => s + a.percentage, 0);
  const targets = selfIdea ? pickOthers : otherIdeas.slice(0, 4);

  if (targets.length < 2) return null;

  // Distribute remaining equally across first 2-4 ideas, then fix rounding.
  const k = Math.min(4, Math.max(2, targets.length));
  const slice = targets.slice(0, k);
  const base = Math.floor(remaining / k);
  let used = 0;

  for (let i = 0; i < slice.length; i++) {
    const id = String(slice[i].ideaId || slice[i].id);
    let pct = base;
    used += pct;
    allocs.push({ ideaId: id, percentage: pct });
  }

  // Fix remainder due to rounding
  let rem2 = remaining - used;
  let idx = 0;
  while (rem2 > 0 && allocs.length > 0) {
    // Never push any single allocation above 60
    if (allocs[idx].percentage < 60) {
      allocs[idx].percentage += 1;
      rem2 -= 1;
    }
    idx = (idx + 1) % allocs.length;
  }

  // Ensure 2+ ideas and total 100
  const total = allocs.reduce((s, a) => s + a.percentage, 0);
  if (allocs.length < 2 || total !== 100) return null;

  // Ensure max 60
  if (allocs.some((a) => a.percentage > 60)) return null;

  return { allocations: allocs };
}

(async () => {
  const debug = isOn("CONCLAVE_TICK_DEBUG");

  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  const lowBal = numEnv("CONCLAVE_LOW_BALANCE_ETH", null);

  const now = nowUtc();

  if (debug) console.error(`[conclave_tick] start ${now.toISOString()} cwd=${process.cwd()}`);

  // Balance check (used for daily summary and low balance alert)
  const balanceRes = await httpJson("GET", "/balance", conclaveToken, null);
  const balEth = balanceRes.status === 200 ? parseBalanceEth(balanceRes) : null;

  if (lowBal !== null && balEth !== null && balEth <= lowBal) {
    await tgSend(
      tgBotToken,
      tgChatId,
      `Conclave LOW BALANCE: ${formatEth(balEth)} ETH (threshold ${formatEth(lowBal)}).`
    );
  }

  // Daily summary (8pm SGT == 12:00 UTC)
  if (shouldSendDailySummaryUtc(now)) {
    const balLine =
      balanceRes.status === 200
        ? `Balance: ${balEth === null ? "unknown" : `${formatEth(balEth)} ETH`}`
        : `Balance: ERR ${balanceRes.status}`;

    const statusForSummary = await httpJson("GET", "/status", conclaveToken, null);
    const sj = statusForSummary.json || {};
    const inGame = !!(sj.inGame ?? sj.inDebate ?? sj.inGame === true);
    const phase = String(sj.phase || "").toLowerCase() || "unknown";

    await tgSend(
      tgBotToken,
      tgChatId,
      `Neo daily Conclave summary (SGT 8pm)\n` +
        `Status: ${statusForSummary.status} | inGame=${inGame} | phase=${phase}\n` +
        `${balLine}`
    );
  }

  // Main status
  const statusRes = await httpJson("GET", "/status", conclaveToken, null);
  if (debug) console.error(`[conclave_tick] /status ${statusRes.status}`);

  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    process.exit(0);
  }

  const st = statusRes.json;
  const inGame = !!(st.inGame ?? st.inDebate);
  const phase = String(st.phase || "").toLowerCase();

  if (debug) console.error(`[conclave_tick] inGame=${inGame} phase=${phase}`);

  // Not in game: try to join
  if (!inGame) {
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

    const name = (process.env.CONCLAVE_USERNAME || "Neo").trim();
    const ticker = (process.env.CONCLAVE_TICKER || "SMOKE").trim().toUpperCase();
    const description =
      (process.env.CONCLAVE_DESCRIPTION ||
        "High-signal participation. Optimize for smoke accumulation via consistent, meaningful engagement.").trim();

    const joinBody = { name, ticker, description };

    const maxAttempts = Math.min(5, ordered.length);
    let tried = 0;
    let fullOrClosed = 0;

    for (let idx = 0; idx < ordered.length && tried < maxAttempts; idx++) {
      const d = ordered[idx];
      if (!d?.id) continue;

      // Skip clearly ended debates
      const p = String(d.phase || "").toLowerCase();
      if (p === "ended" || p === "results") continue;

      tried += 1;
      if (debug) console.error(`[conclave_tick] attempt=${tried}/${maxAttempts} id=${d.id} phase=${p}`);

      const joinRes = await httpJson("POST", `/debates/${d.id}/join`, conclaveToken, joinBody);
      if (debug) console.error(`[conclave_tick] join ${joinRes.status} id=${d.id}`);

      if (joinRes.status === 200) {
        await tgSend(tgBotToken, tgChatId, `Conclave ACT joined debate id=${d.id}`);
        process.exit(0);
      }

      const errMsg = safeErrMsg(joinRes).toLowerCase();
      const isFull = errMsg.includes("full");
      const notAccepting = errMsg.includes("not accepting") || errMsg.includes("closed") || errMsg.includes("ended");

      if (isFull || notAccepting) {
        fullOrClosed += 1;
        continue;
      }

      // Real error
      await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${d.id} ${snip(joinRes.text)}`);
      process.exit(0);
    }

    if (tried > 0 && fullOrClosed === tried) {
      // Quiet by default unless you want this message
      if (isOn("CONCLAVE_NOTIFY_ALL_FULL")) {
        await tgSend(tgBotToken, tgChatId, `Conclave INFO: tried ${tried} debates, none accepted players.`);
      }
    }

    process.exit(0);
  }

  // In game
  if (phase === "allocation") {
    const selfPct = numEnv("CONCLAVE_SELF_ALLOC_PCT", 5);
    const ideas = st.ideas || [];
    const allocBody = buildAutoAllocations(ideas, selfPct);

    if (!allocBody) {
      await tgSend(tgBotToken, tgChatId, "Conclave ERR: allocation phase but could not build valid allocations.");
      process.exit(0);
    }

    const allocRes = await httpJson("POST", "/allocate", conclaveToken, allocBody);
    if (debug) console.error(`[conclave_tick] /allocate ${allocRes.status}`);

    if (allocRes.status === 200) {
      await tgSend(tgBotToken, tgChatId, `Conclave ACT allocated (self=${Math.min(60, Math.floor(selfPct))}%).`);
      process.exit(0);
    }

    await tgSend(tgBotToken, tgChatId, `Conclave ERR allocate ${allocRes.status} ${snip(allocRes.text)}`);
    process.exit(0);
  }

  // Debate, proposal, etc: do nothing (quiet)
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

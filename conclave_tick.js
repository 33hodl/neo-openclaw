// conclave_tick.js
// Goal: maximize smoke with minimal noise.
// Strategy:
// 1) Join joinable debates (skip ended/full/not accepting).
// 2) Submit a real proposal on join (use debate brief to generate a structured proposal).
// 3) Auto-allocate when allocation phase opens (required to earn).
// Notifications: only on errors and low balance.
// Optional debug: CONCLAVE_TICK_DEBUG=1

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

function numEnv(name, fallback) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function strEnv(name, fallback) {
  const v = (process.env[name] || "").trim();
  return v ? v : fallback;
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

function phaseNorm(p) {
  return String(p || "").trim().toLowerCase();
}

function isJoinableDebate(d) {
  const p = phaseNorm(d.phase);
  if (!p) return true; // some responses omit phase
  if (p === "ended" || p === "results" || p === "closed") return false;

  const pc = Number(d.playerCount || 0);
  const cur = Number(d.currentPlayers || 0);
  if (pc && cur >= pc) return false;

  return true;
}

function pickDebatesOrdered(debates) {
  const phaseWeight = (p) => {
    p = phaseNorm(p);
    if (p === "proposal" || p === "propose") return 40;
    if (p === "debate") return 30;
    if (p === "allocation") return 20;
    return 10;
  };

  const scored = debates
    .filter(isJoinableDebate)
    .map((d) => {
      const cur = Number(d.currentPlayers || d.players || d.participants || 0);
      const score = phaseWeight(d.phase) + Math.min(cur, 10);
      return { d, score };
    });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.d);
}

// Generates a structured proposal from the debate brief.
// Not perfect, but far better than your previous slogan.
function buildProposalFromBrief(brief) {
  const text = String(brief || "").trim();
  const theme = text.slice(0, 140);

  return [
    `Idea: ${theme ? theme : "Practical onchain infrastructure"} (MVP-first, measurable).`,
    "",
    "Problem:",
    "- Current solutions are barcode theater: centralized attestations pretending to be trustless.",
    "- The hardest part is binding a real-world object to a verifiable onchain identity without trusted custody.",
    "",
    "Solution:",
    "- Hybrid design: tamper-evident hardware + cryptographic attestations + incentive-aligned challengers.",
    "- Every physical item gets a rooted identity (device key or secure element). Events are signed and posted onchain.",
    "- Independent verifiers stake to challenge fraudulent events; disputes slash bad actors.",
    "",
    "MVP (4 weeks):",
    "1) Simple object registry + signed event schema",
    "2) Attestation API + open verifier client",
    "3) Challenge flow + slashing rules (testnet)",
    "",
    "Hard parts (address head-on):",
    "- Secure key management for manufacturers",
    "- Verifier incentives and anti-sybil",
    "- Recovery flows for damaged/lost tags",
    "",
    "Why it wins:",
    "- It is specific, shippable, and attacks the core trust problem instead of adding more QR codes.",
  ].join("\n").slice(0, 2950);
}

// Allocation scoring: default is to overweight your own idea if present, then diversify.
// Conclave rules: must allocate to 2+ ideas, total 100, max 60% per idea.
function buildAllocations(ideas, myTicker) {
  const list = Array.isArray(ideas) ? ideas : [];
  if (list.length < 2) return null;

  // Find my idea
  const mine = list.find((x) => String(x.ticker || "").toUpperCase() === String(myTicker || "").toUpperCase());

  // Sort others by crude “activity” if available
  const others = list
    .filter((x) => !mine || x.ideaId !== mine.ideaId)
    .map((x) => {
      const comments = Number(x.commentCount || x.comments || 0);
      const refined = Number(x.refineCount || x.refinedCount || 0);
      const score = comments * 2 + refined * 3;
      return { x, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((k) => k.x);

  const a = [];
  const maxSelf = Math.min(60, Math.max(0, Math.floor(numEnv("CONCLAVE_SELF_ALLOC_PCT", 60))));
  const pickCount = Math.max(2, Math.min(3, 1 + others.length)); // aim for 2-3 ideas

  if (mine && mine.ideaId) {
    a.push({ ideaId: mine.ideaId, percentage: maxSelf });
  }

  // Ensure at least 2 ideas
  const remaining = 100 - (a[0]?.percentage || 0);
  const second = others[0];
  const third = others[1];

  if (!second || !second.ideaId) return null;

  if (!mine) {
    // If we do not have our own idea (should be rare), allocate 60/40 to top 2
    a.push({ ideaId: second.ideaId, percentage: 60 });
    const next = others[1];
    if (next && next.ideaId) a.push({ ideaId: next.ideaId, percentage: 40 });
    else a[0].percentage = 100;
    // Fix rule: must allocate to 2+ ideas, so if only one exists, return null
    return a.length >= 2 ? a : null;
  }

  // We have mine. Split remaining across top 1-2 others.
  if (pickCount >= 3 && third && third.ideaId) {
    const p2 = Math.floor(remaining * 0.7);
    const p3 = remaining - p2;
    a.push({ ideaId: second.ideaId, percentage: p2 });
    a.push({ ideaId: third.ideaId, percentage: p3 });
  } else {
    a.push({ ideaId: second.ideaId, percentage: remaining });
  }

  // Sanity: totals must be 100 and all >0
  const total = a.reduce((s, z) => s + z.percentage, 0);
  if (total !== 100) {
    // Fix rounding drift
    a[a.length - 1].percentage += 100 - total;
  }
  if (a.some((z) => z.percentage <= 0)) return null;
  if (a.length < 2) return null;
  if (a.some((z) => z.percentage > 60)) {
    // Clamp any accidental >60
    for (const z of a) z.percentage = Math.min(z.percentage, 60);
    const t2 = a.reduce((s, z) => s + z.percentage, 0);
    a[a.length - 1].percentage += 100 - t2;
  }

  return { allocations: a };
}

(async () => {
  const debug = isOn("CONCLAVE_TICK_DEBUG");

  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  const username = strEnv("CONCLAVE_USERNAME", "DiamondHandsDig");
  const ticker = strEnv("CONCLAVE_TICKER", "SMOKE");

  const lowBal = numEnv("CONCLAVE_LOW_BALANCE_ETH", 0.001);

  if (debug) console.error(`[conclave_tick] start ${new Date().toISOString()} cwd=${process.cwd()}`);

  // Balance check (notify only if low)
  const balRes = await httpJson("GET", "/balance", conclaveToken, null);
  if (balRes.status === 200 && balRes.json && balRes.json.balance != null) {
    const b = Number(balRes.json.balance);
    if (Number.isFinite(b) && b <= lowBal) {
      await tgSend(tgBotToken, tgChatId, `Conclave LOW BALANCE: ${b} ETH. Top up walletAddress=${balRes.json.walletAddress || "?"}`);
    }
  }

  // Status
  const statusRes = await httpJson("GET", "/status", conclaveToken, null);
  if (debug) console.error(`[conclave_tick] /status ${statusRes.status}`);

  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    process.exit(0);
  }

  const inGame = !!(statusRes.json.inGame || statusRes.json.inDebate); // handle API change
  const phase = phaseNorm(statusRes.json.phase);
  if (debug) console.error(`[conclave_tick] inGame=${inGame} phase=${phase}`);

  // If in game and allocation phase: auto-allocate
  if (inGame && phase === "allocation") {
    const ideas = statusRes.json.ideas || statusRes.json.proposals || [];
    const allocBody = buildAllocations(ideas, ticker);

    if (!allocBody) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR allocate: could not build allocations (ideas=${Array.isArray(ideas) ? ideas.length : "?"}).`);
      process.exit(0);
    }

    const allocRes = await httpJson("POST", "/allocate", conclaveToken, allocBody);
    if (debug) console.error(`[conclave_tick] /allocate ${allocRes.status}`);

    if (allocRes.status !== 200) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR /allocate ${allocRes.status} ${snip(allocRes.text)}`);
    }

    process.exit(0);
  }

  // If in game but not allocation: do nothing (no noise, no spam)
  if (inGame) process.exit(0);

  // Not in game: try join a joinable debate
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
  const maxAttempts = Math.min(numEnv("CONCLAVE_MAX_JOIN_ATTEMPTS", 5), ordered.length);

  for (let idx = 0; idx < maxAttempts; idx++) {
    const d = ordered[idx];
    if (!d?.id) continue;

    const p = phaseNorm(d.phase);
    if (debug) console.error(`[conclave_tick] attempt=${idx + 1}/${maxAttempts} id=${d.id} phase=${p || "?"}`);

    const joinBody = {
      name: username,
      ticker,
      description: buildProposalFromBrief(d.brief?.theme || d.brief?.description || d.brief || ""),
    };

    const joinRes = await httpJson("POST", `/debates/${d.id}/join`, conclaveToken, joinBody);
    if (debug) console.error(`[conclave_tick] join ${joinRes.status} id=${d.id}`);

    if (joinRes.status === 200) {
      // No join notification (noise). Success is visible in Conclave UI.
      process.exit(0);
    }

    const errMsg = safeErrMsg(joinRes).toLowerCase();
    const isFull = errMsg.includes("full");
    const notAccepting = errMsg.includes("not accepting");
    const ended = errMsg.includes("ended");

    // Try next debate if this one is not joinable in practice
    if (isFull || notAccepting || ended) continue;

    // Hard error: notify
    await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${d.id} ${snip(joinRes.text)}`);
    process.exit(0);
  }

  // Silent: nothing joinable
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

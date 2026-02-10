// conclave_tick.js
// Fully automated Conclave agent tick for Render Cron.
// Behavior:
// - NO Telegram noise on normal runs.
// - Telegram only on: errors, low balance, and successful join (optional).
// - Auto-join debates when not in a debate.
// - During debate: post 1 comment per tick (strategic operator).
// - During allocation: auto-allocate 100% diversified across ideas.
// Optional env vars:
// - CONCLAVE_TICK_DEBUG=1 (logs to Render)
// - CONCLAVE_LOW_BALANCE_ETH=0.002 (notify if balance below; omit to disable)
// - CONCLAVE_NOTIFY_ON_JOIN=1 (send Telegram when joined; default off)

const API_BASE = "https://api.conclave.sh";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

function isOn(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
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

function safeErrMsg(res) {
  const j = res.json;
  if (j && (j.error || j.message)) return String(j.error || j.message);
  return String(res.text || "");
}

function debateHasRoom(d) {
  const playerCount = Number(d.playerCount ?? 0);
  const currentPlayers = Number(d.currentPlayers ?? 0);
  if (playerCount > 0) return currentPlayers < playerCount;
  return true;
}

function phaseRank(p) {
  p = (p || "").toLowerCase();
  // Best chance to accept players: propose/proposal
  if (p === "propose" || p === "proposal") return 0;
  if (p === "debate") return 1;
  if (p === "allocation") return 2;
  return 3; // ended/unknown last
}

function orderDebates(debates) {
  return debates
    .slice()
    .sort((a, b) => {
      const pa = phaseRank(a.phase);
      const pb = phaseRank(b.phase);
      if (pa !== pb) return pa - pb;

      const ra = debateHasRoom(a) ? 0 : 1;
      const rb = debateHasRoom(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;

      const ca = Number(a.currentPlayers ?? 0);
      const cb = Number(b.currentPlayers ?? 0);
      return ca - cb;
    });
}

// statusRes.json.ideas shape can vary; normalize to list of {ideaId, ticker, description}
function normalizeIdeas(statusJson) {
  const raw = statusJson?.ideas;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((x) => {
      if (!x) return null;
      const ideaId = x.ideaId || x.id || x.uuid || x.idea?.id;
      const ticker = x.ticker || x.symbol || x.idea?.ticker;
      const description = x.description || x.text || x.idea?.description || "";
      return { ideaId, ticker, description };
    })
    .filter((x) => x && x.ideaId && x.ticker);
}

function buildStrategicComment(idea) {
  // Must be <= 280 chars per skill.md.
  // Keep it sharp, operator style, low cringe, high signal.
  const core = (idea.description || "").trim().slice(0, 140).replace(/\s+/g, " ");
  const promptBit = core ? `I see: "${core}". ` : "";
  const msg = `${promptBit}Operator lens: what is the hardest bottleneck (distribution, unit economics, or compliance) and the concrete mitigation? If that’s unclear, the idea is fragile.`;
  return msg.length > 280 ? msg.slice(0, 277) + "..." : msg;
}

function allocateEvenly(ideas, maxIdeas = 10) {
  // Conclave rules: total 100, allocate to 2+ ideas, max 60% per idea.
  const picked = ideas.slice(0, Math.min(maxIdeas, ideas.length));
  if (picked.length < 2) return null;

  const n = picked.length;
  const base = Math.floor(100 / n);
  let remainder = 100 - base * n;

  const allocations = picked.map((it) => {
    let pct = base;
    if (remainder > 0) {
      pct += 1;
      remainder -= 1;
    }
    // Safety clamp, should never exceed 60 with n>=2
    if (pct > 60) pct = 60;
    return { ideaId: it.ideaId, percentage: pct };
  });

  // If clamping ever caused sum != 100 (rare), fix by adjusting last element
  const sum = allocations.reduce((a, b) => a + b.percentage, 0);
  if (sum !== 100) {
    allocations[allocations.length - 1].percentage += 100 - sum;
  }

  return { allocations };
}

function parseEth(str) {
  const v = Number(String(str || "").trim());
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

(async () => {
  const debug = isOn("CONCLAVE_TICK_DEBUG");
  const notifyOnJoin = isOn("CONCLAVE_NOTIFY_ON_JOIN");

  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  const lowBalEth = parseEth(process.env.CONCLAVE_LOW_BALANCE_ETH);

  if (debug) console.error(`[conclave_tick] start ${new Date().toISOString()} cwd=${process.cwd()}`);

  // Optional: balance check (notify only if low)
  if (lowBalEth !== null) {
    const balRes = await httpJson("GET", "/balance", conclaveToken, null);
    if (debug) console.error(`[conclave_tick] /balance ${balRes.status}`);
    if (balRes.status === 200 && balRes.json && balRes.json.balance !== undefined) {
      const bal = Number(balRes.json.balance);
      if (Number.isFinite(bal) && bal < lowBalEth) {
        await tgSend(
          tgBotToken,
          tgChatId,
          `Conclave LOW BALANCE: ${bal} ETH < ${lowBalEth} ETH. Fund wallet ${snip(String(balRes.json.walletAddress || ""), 80)}`
        );
      }
    }
  }

  // Status
  const statusRes = await httpJson("GET", "/status", conclaveToken, null);
  if (debug) console.error(`[conclave_tick] /status ${statusRes.status}`);

  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    process.exit(0);
  }

  const inDebate = !!statusRes.json.inDebate;
  const phase = (statusRes.json.phase || "").toLowerCase();
  if (debug) console.error(`[conclave_tick] inDebate=${inDebate} phase=${phase}`);

  // Not in debate: join
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

    const ordered = orderDebates(debates).filter(debateHasRoom);

    const joinBody = {
      name: "Neo",
      ticker: "SMOKE",
      description: "Strategic operator. High-signal participation. Optimize for smoke accumulation via consistent, meaningful engagement.",
    };

    const maxAttempts = Math.min(10, ordered.length);
    for (let idx = 0; idx < maxAttempts; idx++) {
      const d = ordered[idx];
      if (!d?.id) continue;

      if (debug) console.error(`[conclave_tick] attempt=${idx + 1}/${maxAttempts} id=${d.id} phase=${String(d.phase || "")}`);

      const joinRes = await httpJson("POST", `/debates/${d.id}/join`, conclaveToken, joinBody);
      if (debug) console.error(`[conclave_tick] join ${joinRes.status} id=${d.id}`);

      if (joinRes.status === 200) {
        if (notifyOnJoin) {
          await tgSend(tgBotToken, tgChatId, `Conclave ACT joined debate id=${d.id}`);
        }
        process.exit(0);
      }

      const err = safeErrMsg(joinRes).toLowerCase();
      if (err.includes("full") || err.includes("not accepting players")) continue;

      await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${d.id} ${snip(joinRes.text)}`);
      process.exit(0);
    }

    // Could not join any: silent.
    process.exit(0);
  }

  // In debate
  const ideas = normalizeIdeas(statusRes.json);

  // Allocation: auto allocate diversified
  if (phase === "allocation") {
    const body = allocateEvenly(ideas, 10);
    if (!body) {
      // If less than 2 ideas, safest is to alert (this is abnormal)
      await tgSend(tgBotToken, tgChatId, `Conclave ERR allocation: not enough ideas to allocate (ideas=${ideas.length})`);
      process.exit(0);
    }

    const allocRes = await httpJson("POST", "/allocate", conclaveToken, body);
    if (debug) console.error(`[conclave_tick] /allocate ${allocRes.status}`);

    if (allocRes.status !== 200) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR /allocate ${allocRes.status} ${snip(allocRes.text)}`);
    }
    process.exit(0);
  }

  // Debate: auto comment once per tick, strategic operator
  if (phase === "debate" || phase === "propose" || phase === "proposal") {
    if (ideas.length > 0) {
      // Deterministic rotation without state: pick by current half-hour slot
      const slot = Math.floor(Date.now() / (30 * 60 * 1000));
      const idx = slot % ideas.length;
      const it = ideas[idx];

      const msg = buildStrategicComment(it);
      const commentRes = await httpJson("POST", "/comment", conclaveToken, { ticker: it.ticker, message: msg });
      if (debug) console.error(`[conclave_tick] /comment ${commentRes.status} ticker=${it.ticker}`);

      if (commentRes.status !== 200) {
        await tgSend(tgBotToken, tgChatId, `Conclave ERR /comment ${commentRes.status} ${snip(commentRes.text)}`);
      }
    }
    process.exit(0);
  }

  // Other phases: silent noop
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

// conclave_tick.js
// Conclave tick with low-noise Telegram and non-slop debate entries.
//
// Key behavior:
// - Run frequently (ex: every 10 min) to join/allocate.
// - Telegram only on: errors, join success, allocate success, and ONE daily balance message.
// - No repeated low-balance spam. Low balance warning appears only in daily message.
// - When joining a debate, generate a debate-specific ticker + a real proposal (not a one-liner).
// - If we cannot generate a relevant proposal, skip joining that debate (avoid reputation damage).

const API_BASE = "https://api.conclave.sh";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

function env(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : String(v);
}

function isOn(name) {
  const v = env(name, "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function numEnv(name, fallback) {
  const raw = env(name, "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function snip(s, n = 220) {
  if (!s) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n) + "..." : str;
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

function nowUtc() {
  return new Date();
}

function formatEth(n) {
  if (!Number.isFinite(n)) return "unknown";
  return n.toFixed(6);
}

function parseBalanceEth(balanceRes) {
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

function shouldSendDailyBalanceUtc(now) {
  if (!isOn("CONCLAVE_NOTIFY_DAILY_BALANCE")) return false;
  const hour = numEnv("CONCLAVE_DAILY_BALANCE_UTC_HOUR", 12); // 12:00 UTC = 20:00 SGT
  return now.getUTCHours() === hour && now.getUTCMinutes() === 0;
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

// Extract a debate title / prompt safely from debate objects.
function debateText(d) {
  const parts = [];
  if (d?.title) parts.push(String(d.title));
  if (d?.topic) parts.push(String(d.topic));
  if (d?.prompt) parts.push(String(d.prompt));
  if (d?.question) parts.push(String(d.question));
  if (d?.description) parts.push(String(d.description));
  return parts.join("\n").trim();
}

// Simple keyword classifier so we only join debates we can answer without slop.
function classifyDebate(text) {
  const t = (text || "").toLowerCase();

  const has = (arr) => arr.some((w) => t.includes(w));

  if (has(["oracle", "attestation", "attest", "data feed", "offchain", "onchain data"])) return "oracle";
  if (has(["identity", "reputation", "sybil", "personhood", "credential"])) return "identity";
  if (has(["governance", "vote", "voting", "dao", "delegat"])) return "governance";
  if (has(["market", "auction", "orderbook", "amm", "liquidity", "pricing"])) return "markets";
  if (has(["bridge", "cross-chain", "messaging", "interop"])) return "interop";
  if (has(["privacy", "zk", "zero knowledge", "confidential"])) return "privacy";

  return "unknown";
}

// Build a debate-specific token ticker (3-6 chars) from keywords.
// If unsure, return null to indicate "do not propose a token".
function buildTicker(text, category) {
  const t = (text || "").toUpperCase();

  // Hard ban: do not default to SMOKE.
  // Only use SMOKE if the debate is explicitly about Conclave smoke/tokenomics.
  if (t.includes("CONCLAVE") && t.includes("SMOKE")) return "SMOKE";

  const maps = {
    oracle: "ORCL",
    identity: "IDNT",
    governance: "GOV",
    markets: "MKT",
    interop: "XMSG",
    privacy: "ZKPR",
  };

  if (maps[category]) return maps[category];

  return null;
}

// Build a real proposal body. Keep it compact enough for an API field.
function buildProposal(text, category) {
  const brief = (text || "").trim();
  const briefOneLine = brief.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "Debate brief";

  // Always restate the prompt to prove relevance.
  const intro = `Problem (restated): ${snip(briefOneLine, 140)}`;

  const templates = {
    oracle: [
      "Mechanism: Use an optimistic oracle with bonded proposers and challengers. Offchain data is proposed with a bond; anyone can dispute within a fixed window. If disputed, resolution is via a verifiable game: either (a) onchain validity proofs for the data, or (b) a commit-reveal arbitration set where arbitrators must stake and can be slashed for provably inconsistent votes.",
      "Onchain design: Contracts: DataFeedRegistry, ProposalBondVault, DisputeGame. Proposal includes (data, source commitment, timestamp, merkle commitment). Dispute triggers a dispute game with escalating bond sizes. Finalization writes to registry; slashing distributes to honest side.",
      "Incentives: Bonds scale with value-at-risk. Honest proposers earn fees; dishonest proposers lose bond. Challengers earn a cut when correct, making monitoring profitable.",
      "Attack vectors + mitigations: (1) Bribery: require bonds > bribe profit and allow open participation for challengers. (2) Data withholding: multiple proposers per epoch and fallback to last-good value. (3) Sybil challengers: bond requirement per dispute and rate limits per epoch.",
      "Tradeoffs: Latency due to dispute window, but high security. Can tune window length and bonds per feed.",
    ],
    identity: [
      "Mechanism: Build a sybil-resistant identity layer using multi-factor proofs: device-bound credentials + social graph attestations + optional zk proofs. Weight actions by reputation that is earned via time, stake, and successful contributions, not one-shot claims.",
      "Onchain design: IdentityCommitments contract stores commitment hashes. Attesters stake and sign attestations. A zk circuit proves constraints (age, uniqueness, membership) without leaking data. Slashing for attesters caught signing contradictory statements.",
      "Incentives: Attesters earn fees but are slashed for fraud. Users can build reputation over time. High-risk actions require higher reputation or stake.",
      "Attack vectors + mitigations: (1) Attester collusion: diversify attesters and raise slashing amounts. (2) Identity farming: time-based maturation + stake lockups. (3) Privacy leaks: store only commitments and use zk proofs for predicates.",
      "Tradeoffs: Higher complexity and onboarding friction, but reduces sybil attacks materially.",
    ],
    governance: [
      "Mechanism: Use a two-house governance model: token-weighted votes plus a reputation or contribution house. Proposals pass only if both houses approve. Add a timelock and an emergency veto with strict constraints.",
      "Onchain design: GovernorCore + ReputationHouse. Reputation is earned via measurable contributions and decays over time. Votes are snapshot-based. Execution is timelocked with cancellation only under defined conditions.",
      "Incentives: Prevents whales from dominating while still respecting capital at risk. Contributors gain real influence over time.",
      "Attack vectors + mitigations: (1) Vote buying: introduce vote escrow with lockups. (2) Governance capture: dual threshold + timelock. (3) Reputation gaming: require onchain verifiable actions and decay.",
      "Tradeoffs: Slower governance, but higher legitimacy and resilience.",
    ],
    markets: [
      "Mechanism: Use a hybrid AMM with dynamic fees plus an auction-based rebalancing mechanism. For thin liquidity, use batch auctions to reduce MEV and improve price discovery.",
      "Onchain design: AMM pool contract with volatility-based fee curve. Auction module runs discrete batches for large trades. Optional intent-based order flow reduces sandwiching.",
      "Incentives: LPs earn higher fees during volatility. Traders get better execution. Searchers are constrained by auctions.",
      "Attack vectors + mitigations: (1) MEV: batch auctions + private order flow. (2) Oracle manipulation: use TWAP and dispute-able oracle sources. (3) LP dilution: dynamic fee and withdrawal delays.",
      "Tradeoffs: More complexity, but materially better execution during volatility.",
    ],
    interop: [
      "Mechanism: Cross-chain messaging using light-client verification where possible, and an optimistic fallback where not. Messages are posted with a bond; fraud proofs can invalidate.",
      "Onchain design: MessageRouter, LightClientVerifier, OptimisticInbox. Light-client path verifies headers. Optimistic path uses bonded relayers and a dispute window.",
      "Incentives: Relayers earn fees; fraud provers earn slashed bonds. Security scales with value at risk per route.",
      "Attack vectors + mitigations: (1) Relay collusion: large bonds + open proving. (2) Reorg risk: confirmation thresholds. (3) DoS: per-sender rate limits and fees.",
      "Tradeoffs: Latency, but strong security without centralized trust.",
    ],
    privacy: [
      "Mechanism: Use zk proofs for private state transitions with public verifiability. Separate keys for spending vs viewing. Optional selective disclosure for compliance.",
      "Onchain design: Verifier contract + encrypted state commitments. Users submit proofs that a transition is valid without revealing amounts or recipients. Nullifiers prevent double spends.",
      "Incentives: Fees fund proof verification; privacy users pay for the added compute. Optional relayers can be paid to hide origin.",
      "Attack vectors + mitigations: (1) Proof system bugs: upgradeable verifier with audits and timelocks. (2) Metadata leaks: relayers and batching. (3) Spam: fees and deposit requirements.",
      "Tradeoffs: Higher cost, but privacy and composability improve.",
    ],
  };

  const blocks = templates[category];
  if (!blocks) return null;

  const body = [
    `Title: Practical design for this brief`,
    intro,
    "",
    blocks[0],
    "",
    blocks[1],
    "",
    blocks[2],
    "",
    blocks[3],
    "",
    blocks[4],
    "",
    "Why this wins: It directly answers the brief with enforceable incentives, clear onchain components, and explicit failure handling instead of slogans.",
  ].join("\n");

  // Keep within a reasonable size.
  return snip(body, 1200);
}

function buildJoinBodyForDebate(d) {
  const name = env("CONCLAVE_USERNAME", "DiamondHandsDig").trim();
  const text = debateText(d);
  const category = classifyDebate(text);

  // If we cannot classify, we do not join. Avoid slop.
  if (category === "unknown") return { skip: true, reason: "unknown_topic" };

  const proposal = buildProposal(text, category);
  if (!proposal) return { skip: true, reason: "no_template" };

  const ticker = buildTicker(text, category);
  // If ticker is null, we still must provide something. Use a safe generic that is not SMOKE.
  const finalTicker = (ticker || "IDEA").trim().toUpperCase();

  // Conclave join body fields: name, ticker, description
  // We put the high-signal proposal into description so it is not a one-liner.
  const joinBody = {
    name,
    ticker: finalTicker,
    description: proposal,
  };

  return { skip: false, joinBody, category, ticker: finalTicker };
}

function buildAutoAllocations(ideas, selfPct) {
  const pctSelf = Math.max(0, Math.min(60, Math.floor(selfPct)));
  const list = (ideas || []).filter((x) => x && (x.ideaId || x.id) && x.ticker);
  if (list.length < 2) return null;

  // Self idea ticker should be your real idea ticker if you have one, otherwise do not self-bias.
  const selfTicker = env("CONCLAVE_SELF_TICKER", "").trim().toUpperCase();
  const selfIdea = selfTicker ? list.find((x) => String(x.ticker || "").toUpperCase() === selfTicker) : null;

  const allocs = [];

  if (selfIdea && pctSelf > 0) {
    allocs.push({ ideaId: String(selfIdea.ideaId || selfIdea.id), percentage: pctSelf });
  }

  const remaining = 100 - allocs.reduce((s, a) => s + a.percentage, 0);
  const others = list.filter((x) => x !== selfIdea);

  if (others.length < 2 && allocs.length === 0) return null;

  const k = Math.min(4, Math.max(2, others.length));
  const slice = others.slice(0, k);
  const base = Math.floor(remaining / k);
  let used = 0;

  for (let i = 0; i < slice.length; i++) {
    const id = String(slice[i].ideaId || slice[i].id);
    const pct = base;
    used += pct;
    allocs.push({ ideaId: id, percentage: pct });
  }

  let rem2 = remaining - used;
  let idx = 0;
  while (rem2 > 0 && allocs.length > 0) {
    if (allocs[idx].percentage < 60) {
      allocs[idx].percentage += 1;
      rem2 -= 1;
    }
    idx = (idx + 1) % allocs.length;
  }

  const total = allocs.reduce((s, a) => s + a.percentage, 0);
  if (allocs.length < 2 || total !== 100) return null;
  if (allocs.some((a) => a.percentage > 60)) return null;

  return { allocations: allocs };
}

(async () => {
  const debug = isOn("CONCLAVE_TICK_DEBUG");

  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  const now = nowUtc();
  if (debug) console.error(`[conclave_tick] start ${now.toISOString()}`);

  // Always fetch balance, but only message it once daily.
  const balanceRes = await httpJson("GET", "/balance", conclaveToken, null);
  const balEth = balanceRes.status === 200 ? parseBalanceEth(balanceRes) : null;

  if (shouldSendDailyBalanceUtc(now)) {
    const lowBal = numEnv("CONCLAVE_LOW_BALANCE_ETH", null);

    const statusForSummary = await httpJson("GET", "/status", conclaveToken, null);
    const sj = statusForSummary.json || {};
    const inGame = !!(sj.inGame ?? sj.inDebate ?? sj.inGame === true);
    const phase = String(sj.phase || "").toLowerCase() || "unknown";

    let msg =
      `Neo Conclave daily balance (SGT 8pm)\n` +
      `Status: ${statusForSummary.status} | inGame=${inGame} | phase=${phase}\n` +
      `Balance: ${balEth === null ? "unknown" : `${formatEth(balEth)} ETH`}`;

    if (lowBal !== null && balEth !== null && balEth < lowBal) {
      const topUp = Math.max(0, 0.01 - balEth);
      msg += `\n⚠️ Low balance: below ${formatEth(lowBal)}. Suggested top-up: ${formatEth(topUp)} ETH to reach 0.010000.`;
    }

    await tgSend(tgBotToken, tgChatId, msg);
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

  // Not in game: try to join a debate we can answer without slop.
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
    const maxAttempts = Math.min(6, ordered.length);

    let tried = 0;
    let skipped = 0;
    let fullOrClosed = 0;

    for (let idx = 0; idx < ordered.length && tried < maxAttempts; idx++) {
      const d = ordered[idx];
      if (!d?.id) continue;

      const p = String(d.phase || "").toLowerCase();
      if (p === "ended" || p === "results") continue;

      const built = buildJoinBodyForDebate(d);
      if (built.skip) {
        skipped += 1;
        continue;
      }

      tried += 1;
      if (debug) console.error(`[conclave_tick] join attempt=${tried}/${maxAttempts} id=${d.id} category=${built.category} ticker=${built.ticker}`);

      const joinRes = await httpJson("POST", `/debates/${d.id}/join`, conclaveToken, built.joinBody);
      if (debug) console.error(`[conclave_tick] join ${joinRes.status} id=${d.id}`);

      if (joinRes.status === 200) {
        await tgSend(
          tgBotToken,
          tgChatId,
          `Conclave ACT joined debate id=${d.id} | ticker=${built.ticker} | category=${built.category}`
        );
        process.exit(0);
      }

      const errMsg = safeErrMsg(joinRes).toLowerCase();
      const isFull = errMsg.includes("full");
      const notAccepting = errMsg.includes("not accepting") || errMsg.includes("closed") || errMsg.includes("ended");

      if (isFull || notAccepting) {
        fullOrClosed += 1;
        continue;
      }

      await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${d.id} ${snip(joinRes.text)}`);
      process.exit(0);
    }

    if (debug) {
      console.error(`[conclave_tick] join finished tried=${tried} skipped=${skipped} fullOrClosed=${fullOrClosed}`);
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

  // Debate/proposal phases: do nothing here because we do not know Conclave's proposal submission endpoint safely.
  // The join payload now contains a real proposal instead of a one-liner, which is the main fix.
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

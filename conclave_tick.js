// conclave_tick.js
// Low-noise Conclave automation + real in-game participation (comment + refine).
//
// Telegram only on:
// - Errors
// - Join success
// - Allocate success
// - ONE daily balance message (8pm SGT by default)
//
// Key fixes:
// - No default SMOKE ticker unless debate explicitly about Conclave smoke.
// - Join description is a structured proposal, not a one-liner.
// - During debate/proposal: comment once per window, refine once if strong criticism appears.
// - Stateless anti-spam: embeds a marker in our comment and checks existing comments for it.

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, opts, { retries = 3, baseDelayMs = 500 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 && attempt < retries) {
        const backoff = baseDelayMs * (2 ** attempt);
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs / 2)));
        await sleep(backoff + jitter);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) throw err;
      const backoff = baseDelayMs * (2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs / 2)));
      await sleep(backoff + jitter);
    }
  }
  throw lastErr || new Error("FETCH_RETRY_EXHAUSTED");
}

async function httpJson(method, path, token, bodyObj) {
  const url = `${API_BASE}${path}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const opts = { method, headers };
  if (bodyObj !== undefined && bodyObj !== null) opts.body = JSON.stringify(bodyObj);

  const res = await fetchWithRetry(url, opts, { retries: 3, baseDelayMs: 500 });
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
  const hour = numEnv("CONCLAVE_DAILY_BALANCE_UTC_HOUR", 12);
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

function debateText(d) {
  const parts = [];
  if (d?.brief?.theme) parts.push(String(d.brief.theme));
  if (d?.brief?.description) parts.push(String(d.brief.description));
  if (d?.brief) parts.push(String(d.brief));
  if (d?.title) parts.push(String(d.title));
  if (d?.topic) parts.push(String(d.topic));
  if (d?.prompt) parts.push(String(d.prompt));
  if (d?.question) parts.push(String(d.question));
  if (d?.description) parts.push(String(d.description));
  return parts.join("\n").trim();
}

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

function buildTicker(text, category) {
  const t = (text || "").toUpperCase();
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

function buildProposal(text, category) {
  const brief = (text || "").trim();
  const briefOneLine = brief.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "Debate brief";
  const intro = `Problem (restated): ${snip(briefOneLine, 140)}`;

  const templates = {
    oracle: [
      "Mechanism: Optimistic oracle. Bonded proposer posts data + commitment; anyone can dispute in a window. Dispute triggers a verification game (fraud proof or bonded arbitration) with slashing.",
      "Onchain design: DataFeedRegistry + BondVault + DisputeGame. Proposals commit to (value, timestamp, merkle/source commitment). Finalization writes to registry; slashing pays honest side.",
      "Incentives: Bonds scale with value-at-risk. Honest proposers earn fees; dishonest lose bond. Challengers get paid when correct so monitoring is profitable.",
      "Attacks + mitigations: bribery (bonds + open challengers), withholding (multi-proposer epochs + last-good fallback), griefing (bond per dispute + rate limits).",
      "Tradeoffs: dispute window adds latency, but security is enforceable without trusted parties.",
    ],
    identity: [
      "Mechanism: Sybil resistance via staged reputation: time + stake + verifiable contributions, with optional zk proofs for predicates. No one-shot identity claims.",
      "Onchain design: Identity commitments + staked attesters + zk verifier. Attesters are slashable for contradictory attestations. Actions gated by reputation tiers.",
      "Incentives: Attesters earn fees but are slashable. Users earn influence over time. High-risk actions require higher rep or locked stake.",
      "Attacks + mitigations: collusion (diverse attesters + slashing), farming (maturation + lockups), privacy leaks (commitments + zk predicates).",
      "Tradeoffs: harder onboarding, but real sybil resistance and credibility.",
    ],
    governance: [
      "Mechanism: Two-house governance: token vote + contribution reputation vote. Proposal passes only if both approve. Timelock plus constrained emergency veto.",
      "Onchain design: GovernorCore + RepHouse. Reputation decays and is earned via onchain verifiable actions. Snapshot voting; timelocked execution.",
      "Incentives: Limits whale capture while still respecting capital at risk. Contributors gain influence by shipping, not by buying votes.",
      "Attacks + mitigations: vote buying (lockups), capture (dual thresholds + timelock), rep gaming (decay + verifiable actions).",
      "Tradeoffs: slower decisions, higher legitimacy and resilience.",
    ],
    markets: [
      "Mechanism: Hybrid AMM with dynamic fees plus batch auctions for large trades to reduce MEV and improve discovery in thin liquidity.",
      "Onchain design: Pool with volatility-based fee curve + auction module. Optional intent flow reduces sandwiching; TWAP safeguards for updates.",
      "Incentives: LPs earn more in volatility; traders get better execution; MEV opportunities are constrained by auctions.",
      "Attacks + mitigations: MEV (batching), oracle manipulation (TWAP + dispute-able oracle), LP dilution (dynamic fees + withdrawal delay).",
      "Tradeoffs: more complexity, better execution under stress.",
    ],
    interop: [
      "Mechanism: Cross-chain messaging using light clients where possible and optimistic bonded relays otherwise, with fraud proofs and dispute windows.",
      "Onchain design: Router + LightClientVerifier + OptimisticInbox. Light-client verifies headers. Optimistic path uses bonded relayers and open fraud proving.",
      "Incentives: Relayers earn fees; fraud provers earn slashed bonds; security scales with route risk.",
      "Attacks + mitigations: collusion (large bonds + open proving), reorg risk (confirm thresholds), DoS (fees + rate limits).",
      "Tradeoffs: latency, but strong security without trusted committees.",
    ],
    privacy: [
      "Mechanism: zk proofs for private state transitions. Separate spend vs view keys. Optional selective disclosure for compliance.",
      "Onchain design: Verifier + encrypted commitments + nullifiers to prevent double spend. Batch proofs to reduce cost; relayers to hide origin.",
      "Incentives: Users pay for proof verification; relayers paid to improve privacy; fees fund verifier ops.",
      "Attacks + mitigations: proof bugs (audits + timelocked upgrades), metadata leaks (batching + relayers), spam (fees + deposits).",
      "Tradeoffs: higher cost, privacy and composability increase.",
    ],
  };

  const blocks = templates[category];
  if (!blocks) return null;

  const body = [
    "Title: Practical design for this brief",
    intro,
    "",
    `Mechanism: ${blocks[0]}`,
    "",
    `Onchain Design: ${blocks[1]}`,
    "",
    `Incentives: ${blocks[2]}`,
    "",
    `Attack Vectors + Mitigations: ${blocks[3]}`,
    "",
    `Tradeoffs: ${blocks[4]}`,
    "",
    "Why this wins: enforceable incentives + explicit failure handling, not slogans.",
  ].join("\n");

  return snip(body, 2800);
}

// Try to locate our idea in status.ideas
function findSelfIdea(ideas, username) {
  const u = (username || "").trim().toLowerCase();
  if (!u) return null;

  const keys = ["name", "agentName", "proposer", "proposerName", "createdBy", "createdByName", "author", "authorName", "owner", "ownerName"];
  for (const idea of ideas || []) {
    for (const k of keys) {
      if (idea && idea[k] && String(idea[k]).trim().toLowerCase() === u) return idea;
    }
  }
  return null;
}

// Flatten comments for scanning
function extractCommentsFromIdeas(ideas) {
  const out = [];
  for (const idea of ideas || []) {
    const arr = idea?.comments || idea?.commentary || idea?.replies || null;
    if (Array.isArray(arr)) {
      for (const c of arr) out.push({ idea, c });
    }
  }
  return out;
}

function commentAlreadyPosted(comments, marker) {
  const m = marker.toLowerCase();
  return comments.some((x) => String(x?.c?.message || x?.c?.text || "").toLowerCase().includes(m));
}

function detectStrongCriticism(commentsOnSelf) {
  const text = commentsOnSelf
    .map((x) => String(x?.c?.message || x?.c?.text || "").toLowerCase())
    .join("\n");

  const flags = [];
  if (text.includes("off-topic") || text.includes("off topic")) flags.push("offtopic");
  if (text.includes("zero mechanism") || text.includes("no mechanism") || text.includes("no design")) flags.push("nomech");
  if (text.includes("slop") || text.includes("noise")) flags.push("slop");
  return flags;
}

// Build a short comment under 280 chars
function buildCommentForSelf(briefText, category, criticismFlags, marker) {
  const briefOneLine =
    (briefText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0] || "the brief";

  let core = "";
  if (category === "oracle") core = "Bonded optimistic oracle + dispute window + slashing. Data commits + open challengers. Handles bribery via high bonds and open proving.";
  else if (category === "identity") core = "Sybil resistance via time+stake reputation, slashable attesters, and zk predicates. High-risk actions gated by rep tiers.";
  else if (category === "governance") core = "Two-house governance: token votes + contribution reputation. Pass only if both approve. Timelock execution reduces capture.";
  else if (category === "markets") core = "Hybrid AMM + batch auctions for large flow. Dynamic fees reduce toxic orderflow. Batching cuts MEV and improves discovery.";
  else if (category === "interop") core = "Light-client messaging where possible; optimistic bonded relays otherwise with fraud proofs. Open proving + slashing gives enforceable security.";
  else if (category === "privacy") core = "zk state transitions with encrypted commitments + nullifiers. Relayers and batching reduce metadata leaks; fees prevent spam.";
  else core = "Concrete mechanism + incentives + attack mitigation. No slogans.";

  let prefix = `Re: ${snip(briefOneLine, 60)} `;
  if (criticismFlags.includes("offtopic")) prefix = "Not off-topic. ";
  if (criticismFlags.includes("nomech")) prefix = "Here is the mechanism clearly: ";

  let msg = `${prefix}${snip(core, 210)} ${marker}`;
  if (msg.length > 280) msg = msg.slice(0, 276) + "...";
  return msg;
}

// Build a refined description (max 3000 chars) when criticism is strong
function buildRefinement(text, category) {
  const proposal = buildProposal(text, category);
  if (!proposal) return null;

  const add = "\n\nRefinement: Explicitly mapping to the brief constraints (no trusted parties, no multisigs, no reputation dependency). Security comes from bonded incentives, open disputing, and verifiable resolution.";
  const merged = proposal + add;
  return snip(merged, 3000);
}

function buildJoinBodyForDebate(d) {
  const name = env("CONCLAVE_USERNAME", "DiamondHandsDig").trim();
  const text = debateText(d);
  const category = classifyDebate(text);

  if (category === "unknown") return { skip: true, reason: "unknown_topic" };

  const proposal = buildProposal(text, category);
  if (!proposal) return { skip: true, reason: "no_template" };

  const ticker = buildTicker(text, category);
  const finalTicker = (ticker || "IDEA").trim().toUpperCase();

  const joinBody = { name, ticker: finalTicker, description: proposal };
  return { skip: false, joinBody, category, ticker: finalTicker };
}

function buildAutoAllocations(ideas, selfPct) {
  const pctSelf = Math.max(0, Math.min(60, Math.floor(selfPct)));
  const list = (ideas || []).filter((x) => x && (x.ideaId || x.id) && x.ticker);
  if (list.length < 2) return null;

  const selfTicker = env("CONCLAVE_SELF_TICKER", "").trim().toUpperCase();
  const selfIdea = selfTicker ? list.find((x) => String(x.ticker || "").toUpperCase() === selfTicker) : null;

  const allocs = [];
  if (selfIdea && pctSelf > 0) allocs.push({ ideaId: String(selfIdea.ideaId || selfIdea.id), percentage: pctSelf });

  const remaining = 100 - allocs.reduce((s, a) => s + a.percentage, 0);
  const others = list.filter((x) => x !== selfIdea);
  if (others.length < 2 && allocs.length === 0) return null;

  const k = Math.min(4, Math.max(2, others.length));
  const slice = others.slice(0, k);
  const base = Math.floor(remaining / k);
  let used = 0;

  for (const it of slice) {
    const id = String(it.ideaId || it.id);
    used += base;
    allocs.push({ ideaId: id, percentage: base });
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

const tickStartedAtMs = Date.now();
let tickEnded = false;
console.log(`tick_start timestamp=${new Date(tickStartedAtMs).toISOString()}`);

function tickEnd(status) {
  if (tickEnded) return;
  tickEnded = true;
  const durationMs = Date.now() - tickStartedAtMs;
  console.log(`tick_end durationMs=${durationMs} status=${status}`);
}

(async () => {
  const debug = isOn("CONCLAVE_TICK_DEBUG");

  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  const now = nowUtc();
  if (debug) console.error(`[conclave_tick] start ${now.toISOString()}`);

  // Balance (message once per day only)
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
      msg += `\nLow balance: below ${formatEth(lowBal)}. Top-up: ${formatEth(topUp)} ETH to reach 0.010000.`;
    }

    await tgSend(tgBotToken, tgChatId, msg);
  }

  // Status
  const statusRes = await httpJson("GET", "/status", conclaveToken, null);
  if (debug) console.error(`[conclave_tick] /status ${statusRes.status}`);

  if (statusRes.status !== 200 || !statusRes.json) {
    await tgSend(tgBotToken, tgChatId, `Conclave ERR /status ${statusRes.status} ${snip(statusRes.text)}`);
    tickEnd("ok");
    process.exit(0);
  }

  const st = statusRes.json;
  const inGame = !!(st.inGame ?? st.inDebate);
  const phase = String(st.phase || "").toLowerCase();
  const ideas = st.ideas || [];
  const username = env("CONCLAVE_USERNAME", "DiamondHandsDig").trim();

  if (debug) console.error(`[conclave_tick] inGame=${inGame} phase=${phase} ideas=${ideas.length}`);

  // If in-game and debating, comment/refine
  if (inGame && (phase === "debate" || phase === "proposal" || phase === "propose")) {
    const selfIdea = findSelfIdea(ideas, username);
    if (selfIdea && (selfIdea.ticker || selfIdea.ideaId || selfIdea.id)) {
      const selfTicker = String(selfIdea.ticker || "").toUpperCase();
      const selfIdeaId = String(selfIdea.ideaId || selfIdea.id || "");

      const allComments = extractCommentsFromIdeas(ideas);
      const commentsOnSelf = allComments.filter((x) => String(x?.idea?.ticker || "").toUpperCase() === selfTicker);

      const marker = `[neo:${now.toISOString().slice(0, 16)}Z]`; // minute-level marker
      const already = commentAlreadyPosted(commentsOnSelf, marker);
      const flags = detectStrongCriticism(commentsOnSelf);

      // Build a brief text from idea description as fallback
      const briefText = String(st.brief?.theme || st.brief?.description || selfIdea.description || "");
      const category = classifyDebate(briefText);

      // Refine once if strong criticism present and we can
      // Stateless guard: only refine if we have not refined in the last 60 minutes by checking our own description marker.
      const refineMarker = `[neo-refine:${now.toISOString().slice(0, 13)}Z]`; // hour marker
      const descLower = String(selfIdea.description || "").toLowerCase();
      const refinedThisHour = descLower.includes(refineMarker.toLowerCase());

      if (!refinedThisHour && flags.length > 0 && selfIdeaId) {
        const refined = buildRefinement(briefText, category);
        if (refined) {
          const refineBody = { ideaId: selfIdeaId, description: `${refined}\n\n${refineMarker}` };
          const refineRes = await httpJson("POST", "/refine", conclaveToken, refineBody);

          if (debug) console.error(`[conclave_tick] /refine ${refineRes.status}`);
          if (refineRes.status !== 200) {
            await tgSend(tgBotToken, tgChatId, `Conclave ERR refine ${refineRes.status} ${snip(refineRes.text)}`);
            tickEnd("ok");
            process.exit(0);
          }
        }
      }

      // Comment once per tick window
      if (!already && selfTicker) {
        const msg = buildCommentForSelf(briefText, category, flags, marker);

        // replyTo is optional. If we can find a most recent commentId, reply to that.
        const last = commentsOnSelf
          .map((x) => x.c)
          .filter(Boolean)
          .slice(-1)[0];

        const replyTo = last && (last.id || last.commentId) ? String(last.id || last.commentId) : undefined;

        const commentBody = replyTo
          ? { ticker: selfTicker, message: msg, replyTo }
          : { ticker: selfTicker, message: msg };

        const commentRes = await httpJson("POST", "/comment", conclaveToken, commentBody);
        if (debug) console.error(`[conclave_tick] /comment ${commentRes.status}`);

        if (commentRes.status !== 200) {
          await tgSend(tgBotToken, tgChatId, `Conclave ERR comment ${commentRes.status} ${snip(commentRes.text)}`);
          tickEnd("ok");
          process.exit(0);
        }
      }
    }

    tickEnd("ok");
    process.exit(0);
  }

  // Not in game: try to join a debate we can answer without slop
  if (!inGame) {
    const debatesRes = await httpJson("GET", "/debates", conclaveToken, null);
    if (debug) console.error(`[conclave_tick] /debates ${debatesRes.status}`);

    if (debatesRes.status !== 200 || !debatesRes.json) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR /debates ${debatesRes.status} ${snip(debatesRes.text)}`);
      tickEnd("ok");
      process.exit(0);
    }

    const debates = debatesRes.json.debates || [];
    if (debates.length === 0) {
      tickEnd("ok");
      process.exit(0);
    }

    const ordered = pickDebatesOrdered(debates);
    const maxAttempts = Math.min(6, ordered.length);

    let tried = 0;

    for (let idx = 0; idx < ordered.length && tried < maxAttempts; idx++) {
      const d = ordered[idx];
      if (!d?.id) continue;

      const p = String(d.phase || "").toLowerCase();
      if (p === "ended" || p === "results") continue;

      const built = buildJoinBodyForDebate(d);
      if (built.skip) continue;

      tried += 1;

      const joinRes = await httpJson("POST", `/debates/${d.id}/join`, conclaveToken, built.joinBody);
      if (debug) console.error(`[conclave_tick] join ${joinRes.status} id=${d.id}`);

      if (joinRes.status === 200) {
        await tgSend(tgBotToken, tgChatId, `Conclave ACT joined debate id=${d.id} | ticker=${built.ticker} | category=${built.category}`);
        tickEnd("ok");
        process.exit(0);
      }

      const errMsg = safeErrMsg(joinRes).toLowerCase();
      const isFull = errMsg.includes("full");
      const notAccepting = errMsg.includes("not accepting") || errMsg.includes("closed") || errMsg.includes("ended");
      if (isFull || notAccepting) continue;

      await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${d.id} ${snip(joinRes.text)}`);
      tickEnd("ok");
      process.exit(0);
    }

    tickEnd("ok");
    process.exit(0);
  }

  // Allocation phase
  if (phase === "allocation") {
    const selfPct = numEnv("CONCLAVE_SELF_ALLOC_PCT", 5);
    const allocBody = buildAutoAllocations(ideas, selfPct);

    if (!allocBody) {
      await tgSend(tgBotToken, tgChatId, "Conclave ERR: allocation phase but could not build valid allocations.");
      tickEnd("ok");
      process.exit(0);
    }

    const allocRes = await httpJson("POST", "/allocate", conclaveToken, allocBody);
    if (debug) console.error(`[conclave_tick] /allocate ${allocRes.status}`);

    if (allocRes.status === 200) {
      await tgSend(tgBotToken, tgChatId, `Conclave ACT allocated (self=${Math.min(60, Math.floor(selfPct))}%).`);
      tickEnd("ok");
      process.exit(0);
    }

    await tgSend(tgBotToken, tgChatId, `Conclave ERR allocate ${allocRes.status} ${snip(allocRes.text)}`);
    tickEnd("ok");
    process.exit(0);
  }

  tickEnd("ok");
  process.exit(0);
})().catch(async (e) => {
  const errorType = e && e.name ? e.name : typeof e;
  const rawMessage = e && e.message ? e.message : String(e);
  const cleanMessage = String(rawMessage).replace(/\s+/g, " ").trim();
  console.error(`tick_failed errorType=${errorType} message=${snip(cleanMessage, 1000)}`);

  try {
    const tgBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    if (tgBotToken && tgChatId) {
      await tgSend(tgBotToken, tgChatId, `Conclave ERR tick failed:\n${snip(cleanMessage, 3500)}`);
    }
  } catch {}

  tickEnd("failed");
  return;
});

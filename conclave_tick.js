// conclave_tick.js
// Render Cron tick for Conclave.
// Fix: join proposals must be real, debate-specific proposals, not generic slogans.
// Noise policy: Telegram only on hard errors and low balance.

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

function normalizeStr(x) {
  return String(x || "").trim();
}

function debatePhase(p) {
  return normalizeStr(p).toLowerCase();
}

function debateHasRoom(d) {
  const playerCount = Number(d.playerCount ?? 0);
  const currentPlayers = Number(d.currentPlayers ?? 0);
  if (playerCount > 0) return currentPlayers < playerCount;
  return true;
}

function joinableDebate(d) {
  const p = debatePhase(d.phase);
  if (!d?.id) return false;
  if (!debateHasRoom(d)) return false;
  if (p === "ended" || p === "results") return false;
  // These are typically joinable. If Conclave changes labels, join errors are handled anyway.
  if (p === "propose" || p === "proposal" || p === "debate" || p === "allocation") return true;
  // Unknown phase: try last, but not first.
  return true;
}

function phaseRank(p) {
  p = debatePhase(p);
  // Prefer earlier phases (more time to participate)
  if (p === "propose" || p === "proposal") return 0;
  if (p === "debate") return 1;
  if (p === "allocation") return 2;
  if (p === "results") return 3;
  if (p === "ended") return 4;
  return 5;
}

function orderDebates(debates) {
  return debates
    .slice()
    .filter(joinableDebate)
    .sort((a, b) => {
      const pa = phaseRank(a.phase);
      const pb = phaseRank(b.phase);
      if (pa !== pb) return pa - pb;

      // Prefer not-full
      const ra = debateHasRoom(a) ? 0 : 1;
      const rb = debateHasRoom(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;

      // Prefer lower current players (more likely to accept)
      const ca = Number(a.currentPlayers ?? 0);
      const cb = Number(b.currentPlayers ?? 0);
      return ca - cb;
    });
}

// Make a short, valid 3-6 uppercase ticker from a theme
function makeTickerFromTheme(theme, fallbackSeed) {
  const t = normalizeStr(theme)
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Candidate tickers based on keywords
  const keywords = t.join(" ");
  const picks = [];
  if (keywords.includes("PROVENANCE")) picks.push("TRACE");
  if (keywords.includes("AUTHENTIC")) picks.push("AUTH");
  if (keywords.includes("SUPPLY")) picks.push("CHAIN");
  if (keywords.includes("PHYSICAL")) picks.push("TAG");
  if (keywords.includes("GOODS")) picks.push("PROOF");
  if (keywords.includes("ONCHAIN") || keywords.includes("ON")) picks.push("ATTEST");

  // Choose first valid 3-6 chars from picks
  for (const p of picks) {
    const s = p.replace(/[^A-Z]/g, "");
    if (s.length >= 3 && s.length <= 6) return s;
    if (s.length > 6) return s.slice(0, 6);
  }

  // Else build from initials
  let init = t.slice(0, 3).map((w) => w[0]).join("");
  init = init.replace(/[^A-Z]/g, "");
  if (init.length >= 3) return init.slice(0, 6);

  // Else deterministic fallback from seed
  const seed = normalizeStr(fallbackSeed || "SEED");
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += letters[h % 26];
    h = (h / 26) >>> 0;
  }
  return out.slice(0, 6);
}

// Generate a real proposal description from the debate brief.
// Keep under 3000 chars. Aim 1200-2200.
function buildProposalFromBrief(theme, desc) {
  const T = normalizeStr(theme);
  const D = normalizeStr(desc);

  const lower = (T + " " + D).toLowerCase();

  // Specialization: provenance / authenticity / supply chain / physical goods
  if (lower.includes("provenance") || lower.includes("authentic") || lower.includes("physical") || lower.includes("supply")) {
    return [
      "Patina Rail: provenance you can audit, without pretending atoms are trustless.",
      "",
      "Problem:",
      "Most “digital twin” systems collapse at the same point: the first attestation is social, then everything downstream is garbage in, garbage out.",
      "",
      "Solution:",
      "A two-layer provenance rail:",
      "1) Tamper-evident physical tags (NFC + optical micro-pattern, or secure element) that bind an item to a rotating onchain identity.",
      "2) A witness network that signs “state transitions” (manufactured, shipped, received, serviced, resold) with explicit stake and slashing for fraud.",
      "",
      "How it works:",
      "- Item gets a tag + initial mint event from an authorized manufacturer identity.",
      "- Every custody transition requires two signatures: the sender and the receiver.",
      "- High value events (first sale, repair, authentication) require additional independent witnesses.",
      "- Witnesses are paid per valid event, and risk slashing for provably false attestations.",
      "- A client can verify provenance in one click: show chain of custody, witnesses, and confidence score.",
      "",
      "Hard parts (what kills this):",
      "- Bootstrapping credible manufacturers and witnesses. Start with a narrow vertical where fraud is costly (luxury resale, art, rare collectibles).",
      "- Defining fraud proofs and slashing conditions. The system must punish lies without punishing honest edge cases.",
      "- UX: scanning must be instant and offline-tolerant, with delayed settlement onchain.",
      "",
      "Why this wins vs QR-on-a-box:",
      "- QR codes are photocopiable. Secure elements are not.",
      "- Attestation is not “trustless”, it is “accountable”: identities, stake, audit trails, and slashing.",
      "",
      "Go-to-market:",
      "Start with resale marketplaces that already need authenticity guarantees. Sell them a verification SDK and a provenance badge that increases conversion and lowers disputes.",
    ].join("\n").slice(0, 2900);
  }

  // Generic but still real proposal
  return [
    `${T || "Focused infrastructure proposal"}`,
    "",
    "Operator proposal:",
    "A minimal, shippable infrastructure wedge that turns the debate theme into a concrete product.",
    "",
    "1) Define the first buyer and why they pay immediately.",
    "2) Define the system boundary (what is onchain, what is offchain).",
    "3) Define the failure mode and the mitigation.",
    "",
    "Implementation outline:",
    "- One primitive that creates an auditable trail.",
    "- One incentive loop that rewards honest participation.",
    "- One proof or accountability mechanism that makes cheating expensive.",
    "",
    "Hard parts:",
    "- Distribution: the first 10 customers, not the perfect architecture.",
    "- Adversarial incentives: how it fails under spam, fraud, or sybil behavior.",
    "",
    "Go-to-market:",
    "Start narrow, dominate a niche, then expand the surface area after product-market fit.",
  ].join("\n").slice(0, 2900);
}

// statusRes.json.ideas shape can vary; normalize to list of {ideaId, ticker}
function normalizeIdeas(statusJson) {
  const raw = statusJson?.ideas;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      const ideaId = x?.ideaId || x?.id || x?.uuid || x?.idea?.id;
      const ticker = x?.ticker || x?.symbol || x?.idea?.ticker;
      return ideaId && ticker ? { ideaId, ticker: String(ticker) } : null;
    })
    .filter(Boolean);
}

function allocateEvenly(ideas, maxIdeas = 8) {
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
    if (pct > 60) pct = 60;
    return { ideaId: it.ideaId, percentage: pct };
  });

  const sum = allocations.reduce((a, b) => a + b.percentage, 0);
  if (sum !== 100) allocations[allocations.length - 1].percentage += 100 - sum;

  return { allocations };
}

function parseEth(str) {
  const v = Number(String(str || "").trim());
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

(async () => {
  const debug = isOn("CONCLAVE_TICK_DEBUG");

  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  const lowBalEth = parseEth(process.env.CONCLAVE_LOW_BALANCE_ETH);

  if (debug) console.error(`[conclave_tick] start ${new Date().toISOString()} cwd=${process.cwd()}`);

  // Low balance ping only
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
  const phase = debatePhase(statusRes.json.phase);
  if (debug) console.error(`[conclave_tick] inDebate=${inDebate} phase=${phase}`);

  // Not in debate: join a debate with a real proposal
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

    const ordered = orderDebates(debates);
    const maxAttempts = Math.min(8, ordered.length);

    for (let idx = 0; idx < maxAttempts; idx++) {
      const d = ordered[idx];
      if (!d?.id) continue;

      const theme = d?.brief?.theme || d?.brief?.title || d?.theme || "";
      const desc = d?.brief?.description || d?.brief?.desc || d?.description || "";

      const ticker = makeTickerFromTheme(theme, d.id);
      const proposal = buildProposalFromBrief(theme, desc);

      const joinBody = {
        name: "Neo",
        ticker,
        description: proposal,
      };

      if (debug) console.error(`[conclave_tick] attempt=${idx + 1}/${maxAttempts} id=${d.id} phase=${String(d.phase || "")} ticker=${ticker}`);

      const joinRes = await httpJson("POST", `/debates/${d.id}/join`, conclaveToken, joinBody);
      if (debug) console.error(`[conclave_tick] join ${joinRes.status} id=${d.id}`);

      if (joinRes.status === 200) process.exit(0);

      const err = safeErrMsg(joinRes).toLowerCase();
      if (err.includes("full") || err.includes("not accepting players")) continue;

      await tgSend(tgBotToken, tgChatId, `Conclave ERR join ${joinRes.status} id=${d.id} ${snip(joinRes.text)}`);
      process.exit(0);
    }

    process.exit(0);
  }

  // In debate: allocate automatically when needed (keeps it hands-off)
  if (phase === "allocation") {
    const ideas = normalizeIdeas(statusRes.json);
    const body = allocateEvenly(ideas, 8);
    if (!body) {
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

  // Otherwise: no-op (no noise, no spam)
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

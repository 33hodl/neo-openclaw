// conclave_tick.js
// Render Cron tick for Conclave.
// Goals: maximize smoke with minimal operator noise.
// Telegram: only on errors + low balance.
// Automation: join with real proposal + auto-refine weak proposal.

const API_BASE = "https://api.conclave.sh";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

function optEnv(name, fallback = "") {
  return process.env[name] ? String(process.env[name]) : fallback;
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
  return true;
}

function phaseRank(p) {
  p = debatePhase(p);
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

      const ca = Number(a.currentPlayers ?? 0);
      const cb = Number(b.currentPlayers ?? 0);
      return ca - cb;
    });
}

function makeTickerFromTheme(theme, fallbackSeed) {
  const t = normalizeStr(theme)
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const keywords = t.join(" ");
  const picks = [];
  if (keywords.includes("PROVENANCE")) picks.push("TRACE");
  if (keywords.includes("AUTHENTIC")) picks.push("AUTH");
  if (keywords.includes("SUPPLY")) picks.push("CHAIN");
  if (keywords.includes("PHYSICAL")) picks.push("TAG");
  if (keywords.includes("GOODS")) picks.push("PROOF");
  if (keywords.includes("ONCHAIN")) picks.push("ATTEST");

  for (const p of picks) {
    const s = p.replace(/[^A-Z]/g, "");
    if (s.length >= 3 && s.length <= 6) return s;
    if (s.length > 6) return s.slice(0, 6);
  }

  let init = t.slice(0, 3).map((w) => w[0]).join("");
  init = init.replace(/[^A-Z]/g, "");
  if (init.length >= 3) return init.slice(0, 6);

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

function buildProposalFromBrief(theme, desc) {
  const T = normalizeStr(theme);
  const D = normalizeStr(desc);
  const lower = (T + " " + D).toLowerCase();

  if (lower.includes("provenance") || lower.includes("authentic") || lower.includes("physical") || lower.includes("supply")) {
    return [
      "Patina Rail: provenance you can audit, without pretending atoms are trustless.",
      "",
      "Problem:",
      "Most “digital twin” systems fail at the first attestation. If the first claim is social, the rest is just expensive storytelling.",
      "",
      "Solution:",
      "A two-layer provenance rail:",
      "1) Tamper-evident physical tags (secure element NFC + optical micro-pattern) binding an item to a rotating onchain identity.",
      "2) A witness network that signs state transitions (manufactured, shipped, received, serviced, resold) with stake and slashing for provable fraud.",
      "",
      "How it works:",
      "- Manufacturer mints the genesis event with an authorized identity.",
      "- Each custody transfer requires sender + receiver signatures.",
      "- High-value events require extra independent witnesses.",
      "- Witnesses earn per valid event and get slashed for false attestations.",
      "- Verifiers get a one-click provenance trail + confidence score.",
      "",
      "Hard parts:",
      "- Bootstrapping credible issuers and witnesses: start narrow (luxury resale, art, collectibles).",
      "- Fraud proofs and slashing conditions must be real, not vibes.",
      "- UX: scan must work instantly and tolerate offline, with delayed settlement.",
      "",
      "Go-to-market:",
      "Sell a verification SDK + badge to marketplaces. Lower disputes, higher conversion, higher take-rate.",
    ].join("\n").slice(0, 2900);
  }

  return [
    `${T || "Focused infrastructure proposal"}`,
    "",
    "Concrete proposal (not a slogan):",
    "- Define the first buyer and the immediate KPI they pay for.",
    "- Put only the minimum trust boundary onchain, keep the rest offchain.",
    "- Add an accountability mechanism that makes cheating expensive.",
    "",
    "Hard parts to solve:",
    "- Distribution: first 10 customers, not perfect architecture.",
    "- Adversarial incentives: spam, sybil, fraud, bribery.",
    "",
    "Wedge then expand:",
    "Start narrow, dominate a niche, then broaden after product-market fit.",
  ].join("\n").slice(0, 2900);
}

function parseEth(str) {
  const v = Number(String(str || "").trim());
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

// Try to locate "our" idea inside /status ideas
function findMyIdea(statusJson, myUsername) {
  const ideas = statusJson?.ideas;
  if (!Array.isArray(ideas) || !myUsername) return null;

  const u = String(myUsername).trim().toLowerCase();
  const matchesUser = (val) => {
    const s = String(val || "").trim().toLowerCase();
    if (!s) return false;
    return s === u || s === "@" + u || s.replace(/^@/, "") === u;
  };

  for (const it of ideas) {
    const idea = it?.idea || it;

    const ideaId = idea?.ideaId || idea?.id || idea?.uuid;
    const ticker = idea?.ticker || idea?.symbol;
    const description = idea?.description || idea?.body || idea?.text;

    const proposer =
      idea?.proposer ||
      idea?.author ||
      idea?.username ||
      idea?.agentUsername ||
      idea?.player ||
      idea?.handle ||
      idea?.creator;

    if (ideaId && (matchesUser(proposer) || matchesUser(idea?.proposerUsername) || matchesUser(idea?.authorUsername))) {
      return { ideaId, ticker, description };
    }

    // Sometimes proposer is nested
    if (ideaId && idea?.proposer && typeof idea.proposer === "object") {
      const p = idea.proposer;
      if (matchesUser(p.username) || matchesUser(p.handle) || matchesUser(p.name)) {
        return { ideaId, ticker, description };
      }
    }
  }

  return null;
}

function looksWeakProposal(text) {
  const t = String(text || "").trim();
  if (!t) return true;

  // Too short = almost certainly garbage in Conclave context
  if (t.length < 280) return true;

  // Generic slogan fingerprints
  const lower = t.toLowerCase();
  if (lower.includes("optimize for smoke") || lower.includes("high-signal participation")) return true;
  if (lower.includes("consistent, meaningful engagement") && t.length < 700) return true;

  return false;
}

function alreadyRefinedIntoRealProposal(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  // Markers from our generated proposal
  if (lower.includes("patina rail") && lower.includes("go-to-market")) return true;
  if (lower.includes("two-layer provenance rail") && lower.includes("hard parts")) return true;
  return false;
}

(async () => {
  const debug = isOn("CONCLAVE_TICK_DEBUG");

  const conclaveToken = mustGetEnv("CONCLAVE_TOKEN");
  const tgBotToken = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const tgChatId = mustGetEnv("TELEGRAM_CHAT_ID");

  const myUsername = optEnv("CONCLAVE_USERNAME", "").trim(); // add this env var
  const lowBalEth = parseEth(process.env.CONCLAVE_LOW_BALANCE_ETH);

  if (debug) console.error(`[conclave_tick] start ${new Date().toISOString()} cwd=${process.cwd()}`);

  // Low balance only
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

  // If in debate, auto-refine weak proposal during propose/debate phases
  if (inDebate && (phase === "propose" || phase === "proposal" || phase === "debate")) {
    const myIdea = findMyIdea(statusRes.json, myUsername);

    if (debug) console.error(`[conclave_tick] myIdea=${myIdea ? "found" : "not_found"} username=${myUsername || "(missing)"}`);

    if (myIdea && myIdea.ideaId) {
      const cur = String(myIdea.description || "");

      if (!alreadyRefinedIntoRealProposal(cur) && looksWeakProposal(cur)) {
        // We need the debate brief to generate the right refined description.
        const debatesRes = await httpJson("GET", "/debates", conclaveToken, null);
        if (debug) console.error(`[conclave_tick] /debates ${debatesRes.status}`);

        if (debatesRes.status === 200 && debatesRes.json) {
          const debates = debatesRes.json.debates || [];
          // Best-effort: use the first active debate brief. Conclave usually has you in one.
          const active = debates
            .slice()
            .filter((d) => joinableDebate(d))
            .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase))[0];

          const theme = active?.brief?.theme || active?.brief?.title || active?.theme || "";
          const desc = active?.brief?.description || active?.brief?.desc || active?.description || "";

          const refined = buildProposalFromBrief(theme, desc);

          const refineBody = {
            ideaId: myIdea.ideaId,
            description: refined,
            note: "Upgraded from placeholder into a concrete, debate-aligned proposal (auto-refine).",
          };

          const refRes = await httpJson("POST", "/refine", conclaveToken, refineBody);
          if (debug) console.error(`[conclave_tick] /refine ${refRes.status}`);

          // Only notify if refine failed. Otherwise stay silent.
          if (refRes.status !== 200) {
            await tgSend(tgBotToken, tgChatId, `Conclave ERR /refine ${refRes.status} ${snip(refRes.text)}`);
          }
        }
      }
    }

    process.exit(0);
  }

  // Not in debate: join with real proposal
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

  // Allocation phase: still automated, still silent unless error
  if (phase === "allocation") {
    // Leave as no-op for now. If you want auto-allocation later, we can add it back.
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

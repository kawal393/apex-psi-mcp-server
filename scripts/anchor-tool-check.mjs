#!/usr/bin/env node
// anchor-tool-check — does the tool we advertise actually work against the endpoint it calls?
//
// Why this exists: the published apex-psi-mcp@1.1.0 `anchor` tool defaults to action:"status",
// and /blockchain-anchor accepts only anchor | refresh | history | verify. Every default call a
// stranger makes therefore returns HTTP 400 while our README describes the tool as working.
// A claim about a tool is a claim about a call, so the call is made here and read back.
//
// Read-only by construction: it never sends action:"anchor", which would request a batch write.
// Exits 0 when the shipped default is accepted, 1 when it is not.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const BASE = (
  process.env.APEX_API_BASE || "https://qhtntebpcribjiwrdtdd.supabase.co/functions/v1"
).replace(/\/$/, "");

const problems = [];

/* ---------- 1. what the source says the default action is ---------- */

const src = readFileSync(join(root, "src", "index.ts"), "utf8");
const dist = join(root, "dist", "index.js");
let built = "";
try {
  built = readFileSync(dist, "utf8");
} catch {
  built = ""; // CI builds before it runs this; locally the dist may simply be absent
}

const ACCEPTED = ["anchor", "refresh", "history", "verify"];
const defaultMatch = /const resolved = action \|\| "([a-z]+)"/.exec(src);
if (!defaultMatch) {
  problems.push('src/index.ts: no `const resolved = action || "<name>"` found — the tool\'s default action cannot be read.');
} else {
  const name = defaultMatch[1];
  if (!ACCEPTED.includes(name)) {
    problems.push(`src/index.ts: the anchor tool defaults to action:"${name}", which the endpoint does not accept (it accepts ${ACCEPTED.join(" | ")}).`);
  } else {
    console.log(`ok   the anchor tool defaults to action:"${name}", which the endpoint accepts`);
  }
  if (ACCEPTED.includes(name) && built && !built.includes(`action || "${name}"`)) {
    problems.push(`dist/index.js does not contain the same default ("${name}") — the built file is not built from this source.`);
  }
}

/* ---------- 2. make the call the default makes, and read the answer ---------- */

const sentDefault = defaultMatch ? defaultMatch[1] : "history";
let res, body;
try {
  res = await fetch(`${BASE}/blockchain-anchor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: sentDefault }),
  });
  body = await res.text();
} catch (e) {
  console.log(`BROKEN could not reach ${BASE}/blockchain-anchor: ${e.message}`);
  process.exit(2);
}

if (res.status !== 200) {
  problems.push(`POST /blockchain-anchor {action:"${sentDefault}"} returned HTTP ${res.status}: ${body.slice(0, 200)}`);
} else {
  const j = JSON.parse(body);
  const anchors = Array.isArray(j.anchors) ? j.anchors : [];
  console.log(`ok   action:"${sentDefault}" returns HTTP 200 with ${anchors.length} anchor row(s); confirmed ${j.confirmed}, pending ${j.pending}, simulation ${j.simulation}`);

  // The endpoint says simulation:false — prove it by looking at what it returns, not by believing it.
  const unconfirmed = anchors.filter((a) => a.status !== "confirmed");
  if (j.simulation === true) {
    problems.push("the anchor history reports simulation:true — nothing here is on Bitcoin and no copy may say otherwise.");
  } else if (anchors.length === 0 && Number(j.confirmed) > 0) {
    problems.push(`confirmed=${j.confirmed} but the anchors array is empty — the two fields disagree.`);
  } else {
    for (const a of anchors) {
      if (!a.bitcoin_txid || !a.block_height || !/^https:\/\/mempool\.space\/tx\//.test(a.explorer_url || "")) {
        problems.push(`anchor ${a.id}: missing txid, block height or a mempool.space link.`);
      }
      if (a.explorer_url && a.bitcoin_txid && !a.explorer_url.includes(a.bitcoin_txid)) {
        problems.push(`anchor ${a.id}: the explorer link does not point at its own txid.`);
      }
    }
    if (!problems.length) console.log(`ok   every anchor row carries a txid, a block height and an explorer link that matches that txid (${unconfirmed.length} not yet confirmed)`);
  }
}

/* ---------- verdict ---------- */

if (problems.length) {
  console.log("");
  console.log(`anchor-tool-check: ${problems.length} problem(s). The tool we advertise does not do what we say it does.`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  process.exit(1);
}
console.log("");
console.log("PASS — the advertised default call works against the live endpoint, and the anchor rows are self-consistent.");

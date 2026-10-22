// roundtrip-check.mjs — the natural agent flow, end to end, against the built server.
//
// An agent does what the README tells it: seal something, then hand the WHOLE seal result to
// verify, to cite, and to verify_chain. Before this guard existed, all three of those reads
// looked for a flat `decision_hash` while `seal` returns the receipt nested under `receipt`,
// so a genuine fresh seal came back as "chain broken" and a citation whose url= was empty.
//
// This guard fails on that build and passes on the fixed one — that is the point of it.
// Run:  node scripts/roundtrip-check.mjs            (uses dist/index.js)
//
// Exit 0 = the flow works. Exit 1 = a public promise is broken. Exit 2 = nothing to talk to.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "index.js");
if (!existsSync(serverEntry)) {
  console.log("cannot run: dist/index.js is missing — run npm run build first");
  process.exit(2);
}

const child = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "pipe"] });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let stderr = "";
child.stderr.on("data", (b) => (stderr += b.toString()));

rl.on("line", (line) => {
  line = line.trim();
  if (!line.startsWith("{")) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function rpc(method, params, timeout = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function tool(name, args, timeout = 90000) {
  const res = await rpc("tools/call", { name, arguments: args }, timeout);
  if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error).slice(0, 200)}`);
  const c = res.result?.content;
  const raw = Array.isArray(c) ? c.map((x) => x.text).filter(Boolean).join("\n") : "";
  let body = null;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { isoError: !!res.result?.isError, body };
}

const problems = [];
const notes = [];
function check(ok, label, detail) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label} — ${detail}`);
  if (!ok) problems.push(label);
}

const marker = `roundtrip-guard ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "roundtrip-check", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 1. seal, and keep the ENTIRE result — that is what an agent has in hand.
  const sealed = await tool("seal", { content: marker, context: "roundtrip-guard" });
  const seal = sealed.body || {};
  const nested = seal.receipt || {};
  const hash = nested.decision_hash || seal.verify_hash;
  check(!!hash, "seal returns a hash", `verify_hash ${String(seal.verify_hash || "").slice(0, 16)}...`);
  if (!hash) throw new Error("nothing sealed, cannot continue");

  const bare = hash.replace(/^sha256:/i, "");

  // 2. verify must accept the whole seal result, not only a hand-picked hash.
  const vWhole = await tool("verify", { receipt: seal });
  check(!vWhole.isoError && /"verified"\s*:\s*true|"found"\s*:\s*true/i.test(JSON.stringify(vWhole.body)), "verify accepts the whole seal result", JSON.stringify(vWhole.body).slice(0, 120));

  const vHash = await tool("verify", { hash: bare });
  check(!vHash.isoError && /"verified"\s*:\s*true|"found"\s*:\s*true/i.test(JSON.stringify(vHash.body)), "verify finds the sealed hash", JSON.stringify(vHash.body).slice(0, 120));

  // 3. the same call must say NO to a hash nobody ever sealed.
  const bogus = "0".repeat(63) + "f";
  const vBad = await tool("verify", { hash: bogus });
  check(/"verified"\s*:\s*false|"found"\s*:\s*false/i.test(JSON.stringify(vBad.body)), "verify says no to an invented hash", JSON.stringify(vBad.body).slice(0, 120));

  // 4. verify_chain over the seal result: a genuine seal must never read as a broken chain.
  const chain = await tool("verify_chain", { receipts: [seal] });
  const rep = chain.body?.verification_report || {};
  check(rep.chainIntact === true && rep.verified === 1, "verify_chain keeps a genuine seal intact", `verified ${rep.verified ?? "?"}/${rep.total ?? "?"} chainIntact ${String(rep.chainIntact)} — ${chain.body?.message || ""}`);
  const first = (rep.results || [])[0] || {};
  check(/^[0-9a-f]{64}$/i.test(String(first.hash || "")), "verify_chain reports the hash it checked", `hash ${String(first.hash || "").slice(0, 16) || "(empty)"}`);

  // 5. cite over the seal result must carry a URL a person can open, and it must
  //    be the URL of THIS record — not an empty hash and not a server endpoint.
  const cited = await tool("cite", { receipt: seal, format: "bibtex" });
  const citation = String(cited.body?.citation || "");
  const citedUrl = (citation.match(/url\s*=\s*\{([^}]*)\}/i) || [])[1] || "";
  const citedHash = (citedUrl.match(/[?&]hash=([0-9a-f]{64})/i) || [])[1] || "";
  check(/^https:\/\/\S+\/verify\?hash=[0-9a-f]{64}$/i.test(citedUrl) && citedHash.toLowerCase() === bare.toLowerCase(), "cite's URL actually points at the record", citedUrl || "no url in the citation");
  check(!/\/functions\/v1\//.test(citedUrl), "cite links a human, not a raw API host", citedUrl.slice(0, 80));
  const algo = String(nested.algorithm || "");
  check(!algo || citation.includes(algo), "cite names the algorithms the receipt carries", `receipt algorithm: ${algo || "not stated"}`);

  // 6. the chain must break when a record is tampered with — otherwise "chainIntact" means nothing.
  const tampered = JSON.parse(JSON.stringify(seal));
  if (tampered.receipt?.decision_hash) tampered.receipt.decision_hash = "f".repeat(64);
  else if (tampered.verify_hash) tampered.verify_hash = "f".repeat(64);
  const broke = await tool("verify_chain", { receipts: [tampered] });
  const bref = broke.body?.verification_report || {};
  check(bref.chainIntact === false || bref.verified === 0, "verify_chain rejects a tampered receipt", `verified ${bref.verified ?? "?"}/${bref.total ?? "?"} chainIntact ${String(bref.chainIntact)}`);
} catch (e) {
  problems.push("session");
  console.log("FAIL  session — " + String(e.message).slice(0, 200));
} finally {
  child.kill();
}

for (const n of notes) console.log("NOTE  " + n);
if (problems.length) {
  console.log(`\n${problems.length} problem(s): ${problems.join(", ")}`);
  if (stderr.trim()) console.log("server stderr: " + stderr.trim().slice(0, 300));
  process.exit(1);
}
console.log("\nPASS — seal to verify to cite to verify_chain works with the whole seal result.");
process.exit(0);

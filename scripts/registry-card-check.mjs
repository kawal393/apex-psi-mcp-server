#!/usr/bin/env node
// registry-card-check — the card we hand the official MCP registry must be publishable AND true.
//
// Why this exists, measured 23/24 Oct: the live registry record `io.github.kawal393/apex-psi-mcp`
// was published on 11 Aug and never refreshed. It pins npm 1.0.1, its description reads
// "Cryptographic truth infrastructure for AI agents: seal, verify, anchor, cite, audit", and
// `audit` is not a tool this server has ever exposed. Two of those three faults were invisible to
// every guard in this repository: card-copy-check.mjs only reads files that exist here, and the
// registry's own limit — description must be 100 characters or fewer — rejected the honest 337
// character card with HTTP 422 the first time it was tried. A card that cannot be published is
// not a guard, and a card that names a tool the server does not have is a promise no code keeps.
//
// So this guard asserts three facts against the machine, not against a note:
//   1. the version fields agree, so the registry can never again freeze behind npm;
//   2. the description fits the registry's published limit (measured against its own validator);
//   3. every tool the card or the README promises is one the BUILT SERVER actually lists.
//
// Run:  node scripts/registry-card-check.mjs
// Exit 0 = publishable and true. Exit 1 = a fault. Exit 2 = nothing built to talk to.
//
// Its failure case is proven by --self-test, which runs the SAME assertions against two cards that
// are known bad: the 1.0.1 record the registry is serving today (it promises an `audit` tool that
// does not exist and a version npm left behind), and the honest 337-character card this repository
// offered the registry on 24 Oct, which the registry's own validator refused with HTTP 422.
// The self-test exits 1 if either known-bad card slips through clean.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const entry = join(root, "dist", "index.js");

// The registry's own limit, returned as HTTP 422 on 24 Oct when the card was 337 characters.
const DESC_MAX = 100;
const REAL_NAME = "io.github.kawal393/apex-psi-mcp";

const card = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Two cards that are known bad, kept here verbatim so the assertions can be proven to bite.
const KNOWN_BAD = [
  {
    label: "the record the registry is serving today (published 11 Aug)",
    version: "1.0.1",
    name: REAL_NAME,
    identifier: "apex-psi-mcp",
    packageVersion: "1.0.1",
    description: "Cryptographic truth infrastructure for AI agents: seal, verify, anchor, cite, audit.",
    promised: ["seal", "verify", "anchor", "cite", "audit"],
  },
  {
    label: "the honest card the registry refused on 24 Oct for length",
    version: "1.1.2",
    name: REAL_NAME,
    identifier: "apex-psi-mcp",
    packageVersion: "1.1.2",
    description:
      "Append-only evidence receipts for AI decisions and documents. Five tools: seal a record into a public ledger, verify any hash against it, check a chain of receipts, generate a citation, and read Bitcoin anchoring status. Anyone can verify, free, with no account. A receipt proves a record existed and was not altered after its timestamp - never that its contents are true.",
    promised: ["seal", "verify", "anchor", "cite"],
  },
];

function checkSource(src, real, { enforceVersion }) {
  const problems = [];

  if (enforceVersion) {
    const pkgVersion = (pkg.version || "").trim();
    const cardVersion = (src.version || "").trim();
    const installed = (src.identifier || "") + "@" + (src.packageVersion || "").trim();
    if (cardVersion !== pkgVersion) {
      problems.push(`the card says ${cardVersion || "nothing"} while this repository builds ${pkgVersion}.`);
    }
    if (src.packageVersion !== pkgVersion) {
      problems.push(`the card tells an agent to install ${installed} while this repository publishes ${pkgVersion}.`);
    }
    if (src.identifier !== pkg.name) {
      problems.push(`the card's package identifier is ${src.identifier}, not ${pkg.name}.`);
    }
    if (src.name !== REAL_NAME) {
      problems.push(`the namespace is ${src.name}; only ${REAL_NAME} is ours to publish from this repository.`);
    }
  }

  const desc = src.description || "";
  if (desc.length > DESC_MAX) {
    problems.push(`description is ${desc.length} characters; the registry validator refuses anything over ${DESC_MAX} (measured HTTP 422).`);
  }
  if (!desc.trim()) problems.push("description is empty — the card would say nothing about what the server does.");

  const promised = new Set(src.promised || []);
  for (const name of promised) {
    if (!real.includes(name)) {
      problems.push(`the card promises a tool called "${name}", but the built server does not list it.`);
    }
  }
  return problems;
}

// ---- what the card and README actually claim (real run only) ---------------------------------
function claimedByOurFiles() {
  const set = new Set();
  const readme = readFileSync(join(root, "README.md"), "utf8");
  // README tool table rows look like: | **seal** | Writes the record's SHA-256 hash ...
  for (const m of readme.matchAll(/^\|\s*\*\*([a-z_]+)\*\*\s*\|/gm)) set.add(m[1]);
  const desc = card.description || "";
  for (const m of desc.matchAll(/\b(seal|verify|verify_hash|verify_chain|anchor|anchor_status|cite|audit|list_attestations|ledger_stats|protocol_info)\b/g)) set.add(m[1]);
  return set;
}

const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
rl.on("line", (line) => {
  line = line.trim();
  if (!line.startsWith("{")) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`no answer to ${method} in 8s`)); } }, 8000);
});

async function main() {
  if (!existsSync(entry)) {
    console.log("cannot run the tool check: dist/index.js is missing — run npm run build first");
    process.exit(2);
  }
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "registry-card-check", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await rpc("tools/list", {});
  const real = (listed.result?.tools || []).map((t) => t.name);
  child.stdin.end();
  child.kill();

  const selfTest = process.argv.includes("--self-test");
  let failures = 0;

  if (selfTest) {
    console.log(`SELF-TEST — the built server really exposes: ${real.join(", ")}`);
    for (const bad of KNOWN_BAD) {
      const found = checkSource(bad, real, { enforceVersion: true });
      if (found.length) {
        console.log(`  caught  [${bad.label}] — ${found.length} fault(s):`);
        for (const p of found) console.log(`     · ${p}`);
      } else {
        console.log(`  ESCAPED [${bad.label}] — a known-bad card passed the guard, so the guard is broken.`);
        failures++;
      }
    }
    if (failures) process.exit(1);
    console.log(`PASS — both known-bad cards are refused, so the assertions bite.`);
    process.exit(0);
  }

  const ours = {
    name: card.name,
    version: card.version,
    identifier: card.packages?.[0]?.identifier,
    packageVersion: card.packages?.[0]?.version,
    description: card.description,
    promised: [...claimedByOurFiles()],
  };
  const problems = checkSource(ours, real, { enforceVersion: true });
  if (problems.length) {
    console.log(`registry-card-check [server.json + README vs the built server]: ${problems.length} problem(s).`);
    for (const p of problems) console.log(`  FAIL ${p}`);
    console.log(`  real tools measured: ${real.join(", ")}`);
    process.exit(1);
  }
  console.log(`PASS — version fields agree with package.json ${pkg.version}, the description is ${ours.description.length}/${DESC_MAX} characters, and the ${real.length} tool(s) the card and README name (${real.join(", ")}) are the ones the built server exposes.`);
}

main().catch((e) => {
  console.log("registry-card-check could not talk to the built server:", e.message);
  child.kill();
  process.exit(2);
});

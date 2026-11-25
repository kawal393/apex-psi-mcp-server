#!/usr/bin/env node
// card-copy-check — the words we put in front of strangers must be the words the repository
// has agreed to keep.
//
// Why this exists: on 21 Oct the directory submission sheet in this estate still named a GitHub
// repository, an npm package and a homepage that do not exist, and introduced the server as
// "Cryptographic truth infrastructure" — a phrase the repository itself cut on 19 Oct because a
// seal proves a record was made, not that its contents are true. A card that promises an install
// that cannot happen costs more than a card nobody reads.
//
// Exits 0 when every checked file is clean, 1 when a file is missing or carries a banned phrase.
// Pass files as arguments to check something else (that is how its own failure case is proven).

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const self = fileURLToPath(import.meta.url);

const DEFAULT_FILES = [
  "README.md",
  "server.json",
  "package.json",
  "src/index.ts",
  "src/gate.ts",
  "src/agent.ts",
  "src/receiver.ts",
  "src/sender.ts",
  "src/payment.ts",
  "docs/LOVABLE-BRIEF.md",
  "docs/AGENT-PAYMENT-GATE.md",
  "conformance/agent-03-example.json",
];

// Each of these has been public at some point and is no longer true. The pattern is what we said,
// the note is why it was cut, and the sample is a phrase the guard must refuse to accept.
const BANNED = [
  {
    pattern: /cryptographic truth/i,
    why: "a seal is an audit trail, not the truth of the contents",
    sample: "Cryptographic truth for every agent",
  },
  {
    pattern: /truth[- ]infrastructure/i,
    why: "same reason; the phrase was cut from npm and PyPI copy on 19-21 Oct",
    sample: "Truth-infrastructure for AI agents",
  },
  {
    pattern: /digital truth/i,
    why: "same reason",
    sample: "Digital truth, verifiable by anyone",
  },
  {
    pattern: /trustless/i,
    why: "the notary, the ledger and the explorer are trusted parties; the verifier is what removes the need to trust the answer",
    sample: "A trustless ledger for every decision",
  },
  {
    pattern: /black box/i,
    why: "the metaphor is false on the public web — black box recorders exist, and this is not one",
    sample: "The black box recorder for AI agents",
  },
  {
    pattern: /flight recorder/i,
    why: "a recorder records what happened; it cannot stop an action it was never told about. The gate is the mechanism and it is named for what it does",
    sample: "Your agent's flight recorder",
  },
  {
    pattern: /world'?s first|world first|first ever/i,
    why: "the claim is provably false and cannot be made",
    sample: "The world's first evidence ledger",
  },
  {
    pattern: /tamper-?proof/i,
    why: "a hash chain is tamper-evident, not tamper-proof; no absolute survives an audit",
    sample: "Tamper-proof receipts",
  },
  {
    pattern: /\bimmutable\b/i,
    why: "the ledger is append-only; immutability is a stronger claim than the mechanism supports",
    sample: "An immutable record of every decision",
  },
  {
    pattern: /multi-?party computation|\bMPC\b/i,
    why: "this server runs on one host, not across parties; the words describe something else",
    sample: "Multi-party computation for agents",
  },
  {
    pattern: /@apex\/psi-mcp-server/,
    why: "no such package exists on npm; the published name is apex-psi-mcp",
    sample: "npm i @apex/psi-mcp-server",
  },
  {
    pattern: /github\.com\/apex-psi\//,
    why: "no such repository exists; the published repository is github.com/kawal393/apex-psi-mcp-server",
    sample: "github.com/apex-psi/apex-psi-mcp-server",
  },
  {
    pattern: /sovereign-ai\.services/,
    why: "a domain this estate does not serve",
    sample: "https://sovereign-ai.services/mcp",
  },
  {
    pattern: /apex-infrastructure\.com/,
    why: "the secondary domain is not the canonical one; cite ai-governance-standard.com",
    sample: "https://apex-infrastructure.com/mcp",
  },
  {
    pattern: /\binstantly\b|\balways available\b|\bguaranteed\b/i,
    why: "an absolute about service levels the code does not enforce",
    sample: "Receipts guaranteed instantly",
  },
];

const argv = process.argv.slice(2);
const selfTest = argv.includes("--self-test");
const files = argv.filter((a) => !a.startsWith("--")).length
  ? argv.filter((a) => !a.startsWith("--"))
  : DEFAULT_FILES;

const problems = [];
let checked = 0;

for (const rel of files) {
  const path = isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) ? rel : join(root, rel);
  if (!existsSync(path)) {
    problems.push(`${rel}: the file the card is supposed to live in does not exist.`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  checked++;
  for (const { pattern, why } of BANNED) {
    const hits = text.match(new RegExp(pattern, "gi"));
    if (hits) {
      problems.push(`${rel}: says "${hits[0]}" (x${hits.length}) — ${why}`);
    }
  }
}

// A guard nobody has seen fail is not a guard. Every banned phrase gets a throwaway file that
// carries it, and the guard must refuse that file; one clean file must pass.
if (selfTest) {
  const dir = mkdtempSync(join(tmpdir(), "card-copy-"));
  const failures = [];
  let bites = 0;
  for (const { sample } of BANNED) {
    const probe = join(dir, "probe.md");
    writeFileSync(probe, `The server is the ${sample}.\n`);
    const run = spawnSync(process.execPath, [self, probe], { encoding: "utf8" });
    if (run.status === 0) failures.push(`the guard accepted a file carrying "${sample}"`);
    else bites++;
  }
  const clean = join(dir, "clean.md");
  writeFileSync(clean, "Integrity, not truth. A seal proves a record was made, never that it is correct.\n");
  const cleanRun = spawnSync(process.execPath, [self, clean], { encoding: "utf8" });
  if (cleanRun.status !== 0) failures.push("the guard refused a file that carries no banned phrase");
  rmSync(dir, { recursive: true, force: true });
  if (failures.length) {
    console.error(`card-copy-check self-test: ${failures.length} failure(s).`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`PASS — the guard refuses ${bites} banned phrase(s) and accepts a clean file.`);
  process.exit(0);
}

if (problems.length) {
  console.log(`card-copy-check: ${problems.length} problem(s) across ${checked} file(s).`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  process.exit(1);
}
console.log(`PASS — ${checked} file(s) carry no phrase the repository has cut and no identifier that does not exist.`);

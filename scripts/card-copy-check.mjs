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

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const DEFAULT_FILES = ["README.md", "server.json", "package.json", "src/index.ts"];

// Each of these has been public at some point and is no longer true. The pattern is what we said,
// the note is why it was cut.
const BANNED = [
  [/cryptographic truth/i, "a seal is an audit trail, not the truth of the contents"],
  [/truth[- ]infrastructure/i, "same reason; the phrase was cut from npm and PyPI copy on 19-21 Oct"],
  [/digital truth/i, "same reason"],
  [/trustless/i, "the notary, the ledger and the explorer are trusted parties; the verifier is what removes the need to trust the answer"],
  [/@apex\/psi-mcp-server/, "no such package exists on npm; the published name is apex-psi-mcp"],
  [/github\.com\/apex-psi\//, "no such repository exists; the published repository is github.com/kawal393/apex-psi-mcp-server"],
  [/sovereign-ai\.services/, "a domain this estate does not serve"],
  [/apex-infrastructure\.com/, "the secondary domain is not the canonical one; cite ai-governance-standard.com"],
  [/\binstantly\b|\balways available\b|\bguaranteed\b/i, "an absolute about service levels the code does not enforce"],
];

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;

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
  for (const [pattern, why] of BANNED) {
    const hits = text.match(new RegExp(pattern, "gi"));
    if (hits) {
      problems.push(`${rel}: says "${hits[0]}" (x${hits.length}) — ${why}`);
    }
  }
}

if (problems.length) {
  console.log(`card-copy-check: ${problems.length} problem(s) across ${checked} file(s).`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  process.exit(1);
}
console.log(`PASS — ${checked} file(s) carry no phrase the repository has cut and no identifier that does not exist.`);

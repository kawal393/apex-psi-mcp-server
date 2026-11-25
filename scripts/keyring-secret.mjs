#!/usr/bin/env node
// keyring-secret.mjs — prints the exact value to paste into the receiver's
// keyring secret, and the fingerprint to check it against.
//
// The keyring in the signed example holds PUBLIC keys only. Pasting it into a
// server secret proves nothing about the private halves: those were generated
// for the example file and discarded when it was written.
//
// Run:  node scripts/keyring-secret.mjs
// Exit 0 = the example is present and printable. Exit 2 = it is not.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const examplePath = join(root, "conformance", "agent-03-example.json");

if (!existsSync(examplePath)) {
  console.error("STOP: conformance/agent-03-example.json is missing — run node scripts/make-signed-example.mjs");
  process.exit(2);
}

const doc = JSON.parse(readFileSync(examplePath, "utf8"));
const keyring = doc.keyring ?? {};
if (Object.keys(keyring).length === 0) {
  console.error("STOP: the example carries no keyring");
  process.exit(2);
}

const canonical = JSON.stringify(
  Object.fromEntries(Object.entries(keyring).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
);
const fingerprint = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;

if (doc.keyring_fingerprint && doc.keyring_fingerprint !== fingerprint) {
  console.error(`STOP: the file's fingerprint (${doc.keyring_fingerprint}) is not this keyring (${fingerprint})`);
  process.exit(2);
}

console.log("PASTE THIS JSON INTO PSI_GATE_KEYRING (public keys only):");
console.log(canonical);
console.log("");
console.log(`FINGERPRINT (must equal the file's keyring_fingerprint): ${fingerprint}`);
console.log("");
console.log("Regenerating the example makes new keys. Re-run this and re-paste, or the door");
console.log("will refuse every request from the new file with key_unresolved.");
process.exit(0);

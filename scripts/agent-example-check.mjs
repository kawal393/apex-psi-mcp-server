#!/usr/bin/env node
// agent-example-check.mjs — proves the committed signed example still holds.
//
// conformance/agent-03-example.json is what a stranger is handed: one signed
// run, plus the request bodies that must be refused and the reason each one
// must be refused for. If the gate changes its mind about any of them, the file
// is lying and this guard fails.
//
// Run:  node scripts/agent-example-check.mjs
// Exit 0 = the example matches the code. Exit 1 = it does not. Exit 2 = nothing to check.

import { existsSync, readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
for (const file of ["agent.js", "receiver.js"]) {
  if (!existsSync(join(root, "dist", file))) {
    console.error(`STOP: dist/${file} is not built — run \`npm run build\` first`);
    process.exit(2);
  }
}
const examplePath = join(root, "conformance", "agent-03-example.json");
if (!existsSync(examplePath)) {
  console.error("STOP: conformance/agent-03-example.json is missing — run node scripts/make-signed-example.mjs");
  process.exit(2);
}

const { verifyRunPackage } = await import(`file://${join(root, "dist", "agent.js").replace(/\\/g, "/")}`);
const { createReceiverGate } = await import(`file://${join(root, "dist", "receiver.js").replace(/\\/g, "/")}`);

const doc = JSON.parse(readFileSync(examplePath, "utf8"));

const keyring = {};
for (const [kid, spki] of Object.entries(doc.keyring ?? {})) {
  keyring[kid] = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
}
const resolveKey = (kid) => keyring[kid] ?? null;

let failures = 0;
function pass(what, detail) {
  console.log(`PASS ${what}${detail ? ": " + detail : ""}`);
}
function fail(what, detail) {
  failures++;
  console.error(`FAIL ${what}${detail ? ": " + detail : ""}`);
}

// 1. the allow case must be permitted.
{
  const gate = createReceiverGate({ resolveKey, mode: "enforce" });
  const result = await gate.authorize(doc.allow.request);
  if (result.allowed && result.permit?.decision === doc.allow.request.decision.did) {
    pass("the example's valid run is permitted", result.permit.header);
  } else {
    fail("the example's valid run is permitted", `allowed=${result.allowed} reason=${result.reason}`);
  }
}

// 2. every refusal case must still be refused, with the stated reason.
for (const entry of doc.refusals ?? []) {
  if (entry.case === "replayed proposal") {
    const gate = createReceiverGate({ resolveKey, mode: "enforce" });
    const first = await gate.authorize(entry.request);
    const second = await gate.authorize(entry.request);
    if (first.allowed && !second.allowed && second.reason === entry.expected_reason) {
      pass(`refuses ${entry.case}`, entry.expected_reason);
    } else {
      fail(`refuses ${entry.case}`, `first=${first.allowed} second=${second.reason}`);
    }
    continue;
  }
  const gate = createReceiverGate({ resolveKey, mode: "enforce" });
  const result = await gate.authorize(entry.request);
  if (!result.allowed && result.reason === entry.expected_reason) {
    pass(`refuses ${entry.case}`, entry.expected_reason);
  } else {
    fail(`refuses ${entry.case}`, `allowed=${result.allowed} reason=${result.reason} wanted=${entry.expected_reason}`);
  }
}

// 3. the settled run must verify clean.
{
  const report = verifyRunPackage(doc.settled_run.package, resolveKey);
  if (report.ok) pass("the settled run verifies clean", `checks ${Object.keys(report.checks).length}`);
  else {
    const failure = Object.values(report.checks).find((c) => c.status === "invalid");
    fail("the settled run verifies clean", failure ? `${failure.reason} (${failure.detail ?? ""})` : "unknown");
  }
}

// 4. the file must not carry a private key.
{
  const text = readFileSync(examplePath, "utf8");
  const privates = text.match(/PRIVATE KEY/g) ?? [];
  if (privates.length === 0) pass("the example carries no private key");
  else fail("the example carries no private key", `${privates.length} marker(s)`);
}

if (failures) {
  console.error(`\nEXAMPLE FAILED: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nEXAMPLE OK: the signed example matches the gate.");
process.exit(0);

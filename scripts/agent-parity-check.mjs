#!/usr/bin/env node
// agent-parity-check — Node and Python must fingerprint the same bytes.
//
// The PSI-ACT/1 identifier of a statement is the SHA-256 of its signed bytes.
// If the Node signer and a Python verifier canonicalise differently, a
// statement one side accepted is rejected by the other, and the run breaks in
// a way nobody can read. This drives both sides over the same payloads and
// compares the bytes and the digests.
//
// The Python side is the estate's RFC 8785 implementation (psi_jcs), loaded
// from PSI_JCS_PATH or the known estate path. If it cannot be loaded, the run
// reports "not measured" and exits 2 — it never reports a pass it did not
// earn.
//
// Run:  node scripts/agent-parity-check.mjs
// Exit 0 = both sides agree. Exit 1 = they disagree. Exit 2 = no oracle.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

if (!existsSync(join(root, "dist", "agent.js"))) {
  console.error("STOP: dist/agent.js is not built — run `npm run build` first");
  process.exit(2);
}

const { signedBytes } = await import(
  `file://${join(root, "dist", "agent.js").replace(/\\/g, "/")}`
);
const { canonicalize } = await import(
  `file://${join(root, "dist", "gate.js").replace(/\\/g, "/")}`
);

const payloads = [
  {
    name: "mandate",
    kind: "mandate",
    statement: {
      ver: "1",
      run: "9f2c1a4b7d3e5f6081a2b3c4d5e6f7081a2b3c4d5e6f708192a3b4c5d6e7f809",
      principal: "principal-1",
      purpose: "settle one transfer",
      scope: ["transfer"],
      limits: { max_actions: "4", max_spend: "100.00", currencies: ["AUD"] },
      not_before: "2026-01-01T00:00:00Z",
      not_after: "2026-12-31T00:00:00Z",
      alg: "ed25519",
      kid: "mandate-key",
      mid: "sha256:" + "0".repeat(64),
      sig: "ignored-by-both-sides",
    },
  },
  {
    name: "proposal",
    kind: "proposal",
    statement: {
      ver: "1",
      run: "9f2c1a4b7d3e5f6081a2b3c4d5e6f7081a2b3c4d5e6f708192a3b4c5d6e7f809",
      mid: "sha256:" + "1".repeat(64),
      proposer: "planner-1",
      intent: "transfer 10.00 AUD",
      args_digest: "sha256:" + "2".repeat(64),
      alg: "ed25519",
      kid: "proposer-key",
      pid: "sha256:" + "3".repeat(64),
      sig: "ignored-by-both-sides",
    },
  },
  {
    name: "decision",
    kind: "decision",
    statement: {
      ver: "1",
      run: "9f2c1a4b7d3e5f6081a2b3c4d5e6f7081a2b3c4d5e6f708192a3b4c5d6e7f809",
      pid: "sha256:" + "3".repeat(64),
      verdict: "allow",
      policy_digest: "sha256:" + "4".repeat(64),
      decided_by: "policy-engine-1",
      reason: "within limits",
      alg: "ed25519",
      kid: "decision-key",
      did: "sha256:" + "5".repeat(64),
      sig: "ignored-by-both-sides",
    },
  },
  {
    name: "settlement",
    kind: "settlement",
    statement: {
      ver: "1",
      run: "9f2c1a4b7d3e5f6081a2b3c4d5e6f7081a2b3c4d5e6f708192a3b4c5d6e7f809",
      did: "sha256:" + "5".repeat(64),
      payer: "payer-1",
      payee: "payee-1",
      amount: "10.00",
      asset: "AUD",
      status: "settled",
      ref: "provider-ref-1",
      scheme: "test-scheme",
      observed_at: "2026-06-01T00:00:00Z",
      alg: "ed25519",
      kid: "provider-key",
      sid: "sha256:" + "6".repeat(64),
      sig: "ignored-by-both-sides",
    },
  },
  {
    name: "envelope",
    kind: "envelope",
    statement: {
      ver: "1",
      run: "9f2c1a4b7d3e5f6081a2b3c4d5e6f7081a2b3c4d5e6f708192a3b4c5d6e7f809",
      mandate: "sha256:" + "0".repeat(64),
      proposal: "sha256:" + "3".repeat(64),
      decision: "sha256:" + "5".repeat(64),
      action_root: "absent",
      settlement: "absent",
      issued: "2026-06-01T00:00:00Z",
      anchor: {
        merkle_profile: "RFC6962-SHA256",
        leaf_index: 0,
        tree_size: 1,
        audit_path: [],
        root: "7".repeat(64),
      },
      alg: "ed25519",
      kid: "assembler-key",
      eid: "sha256:" + "7".repeat(64),
      sig: "ignored-by-both-sides",
    },
  },
  {
    name: "non_ascii_value",
    kind: "proposal",
    statement: {
      ver: "1",
      run: "9f2c1a4b7d3e5f6081a2b3c4d5e6f7081a2b3c4d5e6f708192a3b4c5d6e7f809",
      mid: "sha256:" + "1".repeat(64),
      proposer: "planneur-1",
      intent: "virement de 10,00 € — café ☕",
      args_digest: "sha256:" + "2".repeat(64),
      alg: "ed25519",
      kid: "proposer-key",
      pid: "sha256:" + "3".repeat(64),
      sig: "ignored-by-both-sides",
    },
  },
];

let failures = 0;
for (const payload of payloads) {
  const nodeBytes = signedBytes(payload.statement, payload.kind);
  const python = spawnSync("python", [join(here, "psi-act-parity.py")], {
    input: JSON.stringify([payload]),
    encoding: "utf8",
    env: process.env,
  });
  if (python.status !== 0) {
    console.error(`NOT MEASURED ${payload.name}: ${python.stdout.trim() || python.stderr.trim()}`);
    process.exit(2);
  }
  const parsed = JSON.parse(python.stdout);
  const result = parsed.results[0];
  const nodeHex = nodeBytes.toString("hex");
  if (nodeHex === result.signed_hex) {
    console.log(`PASS ${payload.name}: Node and Python sign the same bytes`);
  } else {
    failures++;
    console.error(`FAIL ${payload.name}: Node and Python sign different bytes`);
    console.error(`  node  : ${nodeHex}`);
    console.error(`  python: ${result.signed_hex}`);
  }
  void canonicalize;
}

console.log(`\n${failures === 0 ? "PARITY OK" : "PARITY FAILED"}: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

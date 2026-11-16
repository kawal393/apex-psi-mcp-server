#!/usr/bin/env node
// gate-check — proves the execution gate actually refuses to let an action through.
//
// Why this exists: a gate that cannot fail is not a gate. This script drives the
// BUILT module in dist/, not the source, because that is the file a stranger
// installs. It proves five facts, all offline:
//
//   1. the action runs only after the seal exists (order, not decoration);
//   2. a sealer that fails leaves the action uncalled;
//   3. a gate with no sealer is closed — every action is refused;
//   4. a sealer that returns no hash is refused;
//   5. a payout needs somebody else's receipt.
//
// It also pins the canonical form against a fingerprint computed by the Python
// runtime, so the two languages agree byte for byte on what they sealed.
//
// Run:  node scripts/gate-check.mjs
// Exit 0 = the gate holds. Exit 1 = it does not.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const built = join(root, "dist", "gate.js");

if (!existsSync(built)) {
  console.error("STOP: dist/gate.js is not built — run `npm run build` first");
  process.exit(2);
}

const { createGate, createLocalSealer, GateClosedError, requireReceipt, fingerprint } = await import(
  `file://${built.replace(/\\/g, "/")}`
);

let failures = 0;
function pass(what, detail) {
  console.log(`PASS ${what}${detail ? ": " + detail : ""}`);
}
function fail(what, detail) {
  failures++;
  console.error(`FAIL ${what}${detail ? ": " + detail : ""}`);
}

// 1. order: the seal happens first.
{
  const order = [];
  const sealer = async (action) => {
    order.push("seal");
    return { receipt_id: "R-1", decision_hash: `sha256:${"a".repeat(64)}` };
  };
  const gate = createGate({ sealer });
  const result = await gate.run(() => {
    order.push("act");
    return "done";
  }, { tool: "transfer" });
  if (order.join(",") === "seal,act" && result.value === "done") {
    pass("the action runs only after the seal exists", order.join(" -> "));
  } else {
    fail("the action runs only after the seal exists", order.join(","));
  }
}

// 2. a failing sealer leaves the action uncalled.
{
  let ran = 0;
  const gate = createGate({
    sealer: async () => {
      throw new Error("notary unreachable");
    },
  });
  try {
    await gate.run(() => {
      ran++;
    }, { tool: "transfer" });
    fail("a failed seal refuses the action", "the gate let the action through");
  } catch (error) {
    if (error instanceof GateClosedError && ran === 0) {
      pass("a failed seal refuses the action", "the action was never called");
    } else {
      fail("a failed seal refuses the action", `${error?.name}: ${error?.message}`);
    }
  }
}

// 3. no sealer means the gate is closed.
{
  let ran = 0;
  const gate = createGate();
  try {
    await gate.run(() => {
      ran++;
    }, { tool: "transfer" });
    fail("an unconfigured gate refuses the action", "the gate let the action through");
  } catch (error) {
    if (error instanceof GateClosedError && ran === 0) {
      pass("an unconfigured gate refuses the action", "the action was never called");
    } else {
      fail("an unconfigured gate refuses the action", `${error?.name}: ${error?.message}`);
    }
  }
}

// 4. a seal that carries no hash is not a receipt.
{
  let ran = 0;
  const gate = createGate({ sealer: async () => ({ receipt_id: "no-hash" }) });
  try {
    await gate.run(() => {
      ran++;
    }, { tool: "transfer" });
    fail("a seal without a hash refuses the action", "the gate accepted it");
  } catch (error) {
    if (error instanceof GateClosedError && ran === 0) {
      pass("a seal without a hash refuses the action", "the action was never called");
    } else {
      fail("a seal without a hash refuses the action", `${error?.name}: ${error?.message}`);
    }
  }
}

// 5. a payout needs a receipt.
{
  const good = { decision_hash: `sha256:${"b".repeat(64)}` };
  let refused = 0;
  for (const bad of [null, {}, { receipt_id: "R-2" }, "sha256:x"]) {
    try {
      requireReceipt(bad);
    } catch (error) {
      if (error instanceof GateClosedError) refused++;
    }
  }
  if (refused === 4 && requireReceipt(good) === good) {
    pass("a payout needs somebody else's receipt", "4 bad receipts refused");
  } else {
    fail("a payout needs somebody else's receipt", `refused ${refused} of 4`);
  }
}

// 6. the local sealer chains, needs no network, and keeps the action's text out.
{
  const sealer = createLocalSealer({ label: "payments-bot" });
  const gate = createGate({ sealer });
  const first = await gate.permit({ tool: "transfer", amount: 500, to: "acct-42" });
  const second = await gate.permit({ tool: "transfer", amount: 900, to: "acct-42" });
  const e1 = first.entry;
  const e2 = second.entry;
  const chained = e1 && e2 && e1.prev === "0".repeat(64) && e2.prev === e1.entry_hash;
  const noText = !JSON.stringify([first, second]).includes("acct-42");
  if (chained && noText && first.scope === "local") {
    pass("the local sealer chains and keeps the action's text out", `entries linked`);
  } else {
    fail("the local sealer chains and keeps the action's text out", `chained=${chained} noText=${noText}`);
  }
}

// 7. cross-language parity: this fingerprint was computed by the Python runtime
//    (apex_psi.client.fingerprint) and pinned here so the two cannot drift apart.
{
  const payload = { b: 1, a: [1, 2], c: "x" };
  const expected =
    "95c12ab4ca0e8f3c485ea1b1b1a2b24976d07180baf5ecad0d81b5bbaf07532b";
  const got = fingerprint(payload);
  if (got === expected) {
    pass("Node and Python fingerprint the same bytes", got);
  } else {
    fail("Node and Python fingerprint the same bytes", `node=${got} python=${expected}`);
  }
}

console.log(`\n${failures === 0 ? "GATE OK" : "GATE FAILED"}: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
// agent-gate-check — proves the PSI-ACT/1 receiver refuses what it must refuse.
//
// A gate that cannot fail is not a gate. This drives the BUILT modules in
// dist/, not the source, because dist/ is what a stranger installs.
//
// Every case below must produce exactly one refusal reason. If a case that
// should be refused is allowed, the run fails. Zero false accepts.
//
// Run:  node scripts/agent-gate-check.mjs
// Exit 0 = the gate holds. Exit 1 = it does not.

import { existsSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

for (const file of ["agent.js", "receiver.js", "sender.js", "gate.js"]) {
  if (!existsSync(join(root, "dist", file))) {
    console.error(`STOP: dist/${file} is not built — run \`npm run build\` first`);
    process.exit(2);
  }
}

const { signStatement, digestRef, compareDecimal, verifyRunPackage, GENESIS_REF } = await import(
  `file://${join(root, "dist", "agent.js").replace(/\\/g, "/")}`
);
const { createReceiverGate } = await import(
  `file://${join(root, "dist", "receiver.js").replace(/\\/g, "/")}`
);
const { createMandatedSender } = await import(
  `file://${join(root, "dist", "sender.js").replace(/\\/g, "/")}`
);
const { GateClosedError } = await import(
  `file://${join(root, "dist", "gate.js").replace(/\\/g, "/")}`
);

const vectors = JSON.parse(readFileSync(join(root, "conformance", "agent-03.json"), "utf8"));

let failures = 0;
function pass(what, detail) {
  console.log(`PASS ${what}${detail ? ": " + detail : ""}`);
}
function fail(what, detail) {
  failures++;
  console.error(`FAIL ${what}${detail ? ": " + detail : ""}`);
}

const RUN = "9f2c1a4b7d3e5f6081a2b3c4d5e6f7081a2b3c4d5e6f708192a3b4c5d6e7f809";
const ARGS = { amount: "10.00", to: "acct-42" };

const keys = {
  mandate: generateKeyPairSync("ed25519"),
  proposer: generateKeyPairSync("ed25519"),
  decision: generateKeyPairSync("ed25519"),
  actor: generateKeyPairSync("ed25519"),
  assembler: generateKeyPairSync("ed25519"),
};

const keyring = {
  "mandate-key": keys.mandate.publicKey,
  "proposer-key": keys.proposer.publicKey,
  "decision-key": keys.decision.publicKey,
  "actor-key": keys.actor.publicKey,
  "assembler-key": keys.assembler.publicKey,
};
const resolveKey = (kid) => keyring[kid] ?? null;

function sign(statement, kind, key) {
  return signStatement(statement, kind, key);
}

function build(options = {}) {
  const limits = options.limits ?? { max_actions: "4", max_spend: "100.00", currencies: ["AUD"] };
  const notBefore = options.notBefore ?? "2026-01-01T00:00:00Z";
  const notAfter = options.notAfter ?? "2026-12-31T00:00:00Z";
  const run = options.run ?? RUN;
  const scope = options.scope ?? ["transfer"];

  const mandate = sign(
    {
      ver: "1",
      run,
      principal: options.principal ?? "principal-1",
      purpose: "settle one transfer",
      scope,
      limits,
      not_before: notBefore,
      not_after: notAfter,
      alg: "ed25519",
      kid: options.mandateKid ?? "mandate-key",
    },
    "mandate",
    options.mandateKey ?? keys.mandate.privateKey,
  );

  const proposal = sign(
    {
      ver: "1",
      run,
      mid: options.proposalMid ?? mandate.mid,
      proposer: "planner-1",
      intent: "transfer 10.00 AUD",
      args_digest: options.argsDigest ?? digestRef(ARGS),
      alg: "ed25519",
      kid: "proposer-key",
    },
    "proposal",
    keys.proposer.privateKey,
  );

  const decision = sign(
    {
      ver: "1",
      run: options.decisionRun ?? run,
      pid: options.decisionPid ?? proposal.pid,
      verdict: options.verdict ?? "allow",
      policy_digest: digestRef({ policy: "transfer-policy-v1" }),
      decided_by: "policy-engine-1",
      reason: "within limits",
      alg: options.alg ?? "ed25519",
      kid: options.decisionKid ?? "decision-key",
    },
    "decision",
    options.decisionKey ?? keys.decision.privateKey,
  );

  const settlement = options.settlement
    ? sign(
        {
          ver: "1",
          run,
          did: options.settlementDid ?? decision.did,
          payer: "payer-1",
          payee: "payee-1",
          amount: options.amount ?? "10.00",
          asset: options.asset ?? "AUD",
          status: options.status ?? "settled",
          ref: "provider-ref-1",
          scheme: "test-scheme",
          observed_at: "2026-06-01T00:00:00Z",
          alg: "ed25519",
          kid: "provider-key",
        },
        "settlement",
        keys.assembler.privateKey,
      )
    : undefined;

  const envelope = sign(
    {
      ver: "1",
      run,
      mandate: options.envelopeMandate ?? mandate.mid,
      proposal: options.envelopeProposal ?? proposal.pid,
      decision: options.envelopeDecision ?? decision.did,
      action_root: options.actionRoot ?? "absent",
      settlement: options.envelopeSettlement ?? (settlement ? settlement.sid : "absent"),
      issued: "2026-06-01T00:00:00Z",
      alg: "ed25519",
      kid: "assembler-key",
    },
    "envelope",
    keys.assembler.privateKey,
  );

  return { mandate, proposal, decision, settlement, envelope };
}

function request(pkg, overrides = {}) {
  return {
    envelope: pkg.envelope,
    mandate: pkg.mandate,
    proposal: pkg.proposal,
    decision: pkg.decision,
    settlement: pkg.settlement,
    actions: [],
    tool: "transfer",
    args: ARGS,
    actorKid: "actor-key",
    ...overrides,
  };
}

async function expectRefusal(name, req, reason, options = {}) {
  const gate = createReceiverGate({
    resolveKey,
    mode: "enforce",
    now: () => new Date("2026-06-01T12:00:00Z"),
    ...options,
  });
  const result = await gate.authorize(req);
  if (!result.allowed && result.reason === reason) {
    pass(`refuses ${name}`, reason);
  } else {
    fail(`refuses ${name}`, `allowed=${result.allowed} reason=${result.reason} wanted=${reason}`);
  }
}

// 1. a valid allow passes and carries a permit.
{
  const pkg = build();
  const gate = createReceiverGate({
    resolveKey,
    mode: "enforce",
    now: () => new Date("2026-06-01T12:00:00Z"),
  });
  const result = await gate.authorize(request(pkg));
  if (result.allowed && result.permit?.decision === pkg.decision.did) {
    pass("allows a valid run", result.permit.header);
  } else {
    fail("allows a valid run", `allowed=${result.allowed} reason=${result.reason}`);
  }
}

// 2. missing mandate.
{
  const pkg = build();
  await expectRefusal("a run with no mandate", request(pkg, { mandate: undefined }), "missing_authority");
}

// 3. expired mandate.
{
  const pkg = build({ notBefore: "2025-01-01T00:00:00Z", notAfter: "2025-06-01T00:00:00Z" });
  await expectRefusal("an expired mandate", request(pkg), "outside_window");
}

// 4. over spend.
{
  const pkg = build({ settlement: true, amount: "250.00" });
  const report = verifyRunPackage(
    { envelope: pkg.envelope, mandate: pkg.mandate, proposal: pkg.proposal, decision: pkg.decision, settlement: pkg.settlement },
    resolveKey,
  );
  if (!report.ok && report.checks.settlement_spend?.reason === "over_spend") pass("refuses over spend", "over_spend");
  else fail("refuses over spend", JSON.stringify(report.checks.settlement_spend));
}

// 5. over actions.
{
  const pkg = build({ limits: { max_actions: "1", max_spend: "100.00", currencies: ["AUD"] } });
  const record = {
    event: "action",
    name: "transfer",
    args: ARGS,
    result: "ok",
    prev: GENESIS_REF,
    did: pkg.decision.did,
    kid: "actor-key",
    at: "2026-06-01T00:00:00Z",
  };
  const root = digestRef(record);
  const pkg2 = build({ limits: { max_actions: "1", max_spend: "100.00", currencies: ["AUD"] } });
  const record2 = { ...record, did: pkg2.decision.did };
  const root2 = digestRef(record2);
  const withRoot = build({
    limits: { max_actions: "1", max_spend: "100.00", currencies: ["AUD"] },
    actionRoot: root2,
  });
  const signedRecord = { ...record2, did: withRoot.decision.did };
  await expectRefusal(
    "a run past its action limit",
    request(withRoot, { actions: [{ ...signedRecord, did: withRoot.decision.did }] }),
    "over_actions",
  );
  void pkg;
  void root;
}

// 6. replay.
{
  const pkg = build();
  const gate = createReceiverGate({
    resolveKey,
    mode: "enforce",
    now: () => new Date("2026-06-01T12:00:00Z"),
  });
  const first = await gate.authorize(request(pkg));
  const second = await gate.authorize(request(pkg));
  if (first.allowed && !second.allowed && second.reason === "replay") pass("refuses a replayed proposal", "replay");
  else fail("refuses a replayed proposal", `first=${first.allowed} second=${second.reason}`);
}

// 7. bad signature.
{
  const pkg = build();
  const tampered = { ...pkg.decision, sig: pkg.decision.sig.slice(0, -4) + "AAAA" };
  await expectRefusal("a forged signature", request(pkg, { decision: tampered }), "signature_invalid");
}

// 8. wrong run.
{
  const pkg = build({ decisionRun: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" });
  await expectRefusal("a statement from another run", request(pkg), "run_mismatch");
}

// 9. proposal points at another mandate.
{
  const other = build({ principal: "principal-2" });
  const pkg = build({ proposalMid: other.mandate.mid });
  await expectRefusal("a proposal bound to another mandate", request(pkg), "proposal_mid_mismatch");
}

// 10. decision points at another proposal.
{
  const other = build({ principal: "principal-2" });
  const pkg = build({ decisionPid: other.proposal.pid });
  await expectRefusal("a decision bound to another proposal", request(pkg), "decision_pid_mismatch");
}

// 11. settlement points at another decision.
{
  const other = build({ principal: "principal-2" });
  const pkg = build({ settlement: true, settlementDid: other.decision.did });
  const report = verifyRunPackage(
    { envelope: pkg.envelope, mandate: pkg.mandate, proposal: pkg.proposal, decision: pkg.decision, settlement: pkg.settlement },
    resolveKey,
  );
  if (!report.ok && report.checks.settlement_binding?.reason === "settlement_did_mismatch") {
    pass("refuses a settlement bound to another decision", "settlement_did_mismatch");
  } else {
    fail("refuses a settlement bound to another decision", JSON.stringify(report.checks.settlement_binding));
  }
}

// 12. currency outside the mandate.
{
  const pkg = build({ settlement: true, asset: "USD" });
  const report = verifyRunPackage(
    { envelope: pkg.envelope, mandate: pkg.mandate, proposal: pkg.proposal, decision: pkg.decision, settlement: pkg.settlement },
    resolveKey,
  );
  if (!report.ok && report.checks.settlement_currency?.reason === "currency_not_permitted") {
    pass("refuses a currency the mandate does not permit", "currency_not_permitted");
  } else {
    fail("refuses a currency the mandate does not permit", JSON.stringify(report.checks.settlement_currency));
  }
}

// 13. denied but executed.
{
  const pkg = build({ verdict: "deny", settlement: true });
  const record = {
    event: "action",
    name: "transfer",
    args: ARGS,
    result: "ok",
    prev: GENESIS_REF,
    did: pkg.decision.did,
    kid: "actor-key",
    at: "2026-06-01T00:00:00Z",
  };
  const pkgWithRoot = build({ verdict: "deny", actionRoot: digestRef(record) });
  const report = verifyRunPackage(
    {
      envelope: pkgWithRoot.envelope,
      mandate: pkgWithRoot.mandate,
      proposal: pkgWithRoot.proposal,
      decision: pkgWithRoot.decision,
      actions: [{ ...record, did: pkgWithRoot.decision.did }],
    },
    resolveKey,
  );
  if (!report.ok && report.checks.denied_binding?.reason === "denied_but_executed") {
    pass("refuses a denied decision that executed anyway", "denied_but_executed");
  } else {
    fail("refuses a denied decision that executed anyway", JSON.stringify(report.checks.denied_binding));
  }
  void pkg;
}

// 14. the decision key is the acting key.
{
  const pkg = build();
  const record = {
    event: "action",
    name: "transfer",
    args: ARGS,
    result: "ok",
    prev: GENESIS_REF,
    did: pkg.decision.did,
    kid: "decision-key",
    at: "2026-06-01T00:00:00Z",
  };
  const pkgWithRoot = build({ actionRoot: digestRef(record) });
  const report = verifyRunPackage(
    {
      envelope: pkgWithRoot.envelope,
      mandate: pkgWithRoot.mandate,
      proposal: pkgWithRoot.proposal,
      decision: pkgWithRoot.decision,
      actions: [{ ...record, did: pkgWithRoot.decision.did }],
    },
    resolveKey,
  );
  if (!report.ok && report.checks.decision_key?.reason === "decision_key_is_action_key") {
    pass("refuses the decision key acting on its own decision", "decision_key_is_action_key");
  } else {
    fail("refuses the decision key acting on its own decision", JSON.stringify(report.checks.decision_key));
  }
}

// 15. the mandate key is the decision key.
{
  const pkg = build({ decisionKid: "mandate-key", decisionKey: keys.mandate.privateKey });
  await expectRefusal("the mandate key signing the decision", request(pkg), "mandate_key_is_decision_key");
}

// 16. the mandate key is the acting key.
{
  const pkg = build();
  const record = {
    event: "action",
    name: "transfer",
    args: ARGS,
    result: "ok",
    prev: GENESIS_REF,
    did: pkg.decision.did,
    kid: "mandate-key",
    at: "2026-06-01T00:00:00Z",
  };
  const pkgWithRoot = build({ actionRoot: digestRef(record) });
  const report = verifyRunPackage(
    {
      envelope: pkgWithRoot.envelope,
      mandate: pkgWithRoot.mandate,
      proposal: pkgWithRoot.proposal,
      decision: pkgWithRoot.decision,
      actions: [{ ...record, did: pkgWithRoot.decision.did }],
    },
    resolveKey,
  );
  if (!report.ok && report.checks.mandate_action_key?.reason === "mandate_key_is_action_key") {
    pass("refuses the mandate key acting on its own mandate", "mandate_key_is_action_key");
  } else {
    fail("refuses the mandate key acting on its own mandate", JSON.stringify(report.checks.mandate_action_key));
  }
}

// 17. the action arguments do not match the proposal.
{
  const pkg = build();
  await expectRefusal(
    "arguments the proposal never described",
    request(pkg, { args: { amount: "5000.00", to: "acct-42" } }),
    "args_mismatch",
  );
}

// 18. an algorithm this verifier does not implement.
{
  const pkg = build({ alg: "ml-dsa-65" });
  await expectRefusal("an algorithm it cannot check", request(pkg), "algorithm_unavailable");
}

// 19. a key it cannot resolve.
{
  const pkg = build({ decisionKid: "ghost-key" });
  await expectRefusal("a key it cannot resolve", request(pkg), "key_unresolved");
}

// 20. shadow mode observes the refusal but does not block.
{
  const pkg = build();
  const gate = createReceiverGate({
    resolveKey,
    mode: "shadow",
    now: () => new Date("2026-06-01T12:00:00Z"),
  });
  const result = await gate.authorize(request(pkg, { args: { amount: "5000.00", to: "acct-42" } }));
  if (result.allowed && result.wouldAllow === false && result.reason === "args_mismatch") {
    pass("shadow mode observes without blocking", result.reason);
  } else {
    fail("shadow mode observes without blocking", `allowed=${result.allowed} wouldAllow=${result.wouldAllow}`);
  }
}

// 21. a denied decision never reaches the action.
{
  const pkg = build({ verdict: "deny" });
  const gate = createReceiverGate({
    resolveKey,
    mode: "enforce",
    now: () => new Date("2026-06-01T12:00:00Z"),
  });
  let ran = 0;
  try {
    await gate.run(request(pkg), () => {
      ran++;
    });
    fail("a denied decision never reaches the action", "the action ran");
  } catch (error) {
    if (ran === 0 && error?.name === "ReceiverRefusedError") pass("a denied decision never reaches the action", error.reason);
    else fail("a denied decision never reaches the action", `${error?.name} ran=${ran}`);
  }
}

// 22. the sender seals before the action runs.
{
  const pkg = build();
  const order = [];
  const sender = createMandatedSender({
    mandate: pkg.mandate,
    proposal: pkg.proposal,
    decision: pkg.decision,
    actorKid: "actor-key",
    sealer: async () => {
      order.push("seal");
      return { receipt_id: "R-1", decision_hash: `sha256:${"c".repeat(64)}` };
    },
  });
  const result = await sender.execute("transfer", ARGS, () => {
    order.push("act");
    return "done";
  });
  if (order.join(",") === "seal,act" && result.value === "done" && result.chainRoot.startsWith("sha256:")) {
    pass("the sender seals before the action runs", order.join(" -> "));
  } else {
    fail("the sender seals before the action runs", order.join(","));
  }
}

// 23. a failed seal leaves the action uncalled.
{
  const pkg = build();
  let ran = 0;
  const sender = createMandatedSender({
    mandate: pkg.mandate,
    proposal: pkg.proposal,
    decision: pkg.decision,
    actorKid: "actor-key",
    sealer: async () => {
      throw new Error("notary unreachable");
    },
  });
  try {
    await sender.execute("transfer", ARGS, () => {
      ran++;
    });
    fail("a failed seal leaves the action uncalled", "the action ran");
  } catch (error) {
    if (ran === 0 && error instanceof GateClosedError) pass("a failed seal leaves the action uncalled", error.name);
    else fail("a failed seal leaves the action uncalled", `${error?.name} ran=${ran}`);
  }
}

// 24. a retry of the same proposal runs the action once.
{
  const pkg = build();
  let calls = 0;
  const sender = createMandatedSender({
    mandate: pkg.mandate,
    proposal: pkg.proposal,
    decision: pkg.decision,
    actorKid: "actor-key",
    sealer: async () => ({ receipt_id: "R-2", decision_hash: `sha256:${"d".repeat(64)}` }),
  });
  const first = await sender.execute("transfer", ARGS, () => {
    calls++;
    return "done";
  });
  const second = await sender.execute("transfer", ARGS, () => {
    calls++;
    return "done";
  });
  if (calls === 1 && first.chainRoot === second.chainRoot) pass("a retry runs the action once", `calls=${calls}`);
  else fail("a retry runs the action once", `calls=${calls}`);
}

// 25. the sender refuses arguments the proposal never described.
{
  const pkg = build();
  let ran = 0;
  const sender = createMandatedSender({
    mandate: pkg.mandate,
    proposal: pkg.proposal,
    decision: pkg.decision,
    actorKid: "actor-key",
    sealer: async () => ({ receipt_id: "R-3", decision_hash: `sha256:${"e".repeat(64)}` }),
  });
  try {
    await sender.execute("transfer", { amount: "5000.00", to: "acct-42" }, () => {
      ran++;
    });
    fail("the sender refuses arguments the proposal never described", "the action ran");
  } catch (error) {
    if (ran === 0 && error?.name === "SenderBindingError") {
      pass("the sender refuses arguments the proposal never described", error.reason);
    } else {
      fail("the sender refuses arguments the proposal never described", `${error?.name} ran=${ran}`);
    }
  }
}

// 26. the sender refuses to bind a settlement over the limit.
{
  const pkg = build({ settlement: true, amount: "500.00" });
  const sender = createMandatedSender({
    mandate: pkg.mandate,
    proposal: pkg.proposal,
    decision: pkg.decision,
    actorKid: "actor-key",
    sealer: async () => ({ receipt_id: "R-4", decision_hash: `sha256:${"f".repeat(64)}` }),
  });
  try {
    sender.bindSettlement(pkg.settlement);
    fail("the sender refuses a settlement over the limit", "it bound the settlement");
  } catch (error) {
    if (error?.reason === "over_spend") pass("the sender refuses a settlement over the limit", error.reason);
    else fail("the sender refuses a settlement over the limit", String(error?.reason));
  }
}

// 27. decimal comparison is exact, never floating point.
{
  const cases = [
    ["1.10", "1.1", 0],
    ["10.00", "9.99", 1],
    ["0.1", "0.10", 0],
    ["-5", "-4", -1],
    ["100", "100.00", 0],
    ["2", "10", -1],
  ];
  let bad = 0;
  for (const [left, right, wanted] of cases) {
    const got = compareDecimal(left, right);
    if (got !== wanted) bad++;
  }
  if (bad === 0) pass("decimal comparison is exact", `${cases.length} cases`);
  else fail("decimal comparison is exact", `${bad} mismatches`);
}

// 28. the frozen conformance file is the contract this run was checked against.
{
  const names = vectors.cases.map((entry) => entry.name);
  const covered = [
    "valid_allow",
    "missing_mandate",
    "expired_mandate",
    "over_spend",
    "over_actions",
    "replay",
    "bad_signature",
    "wrong_run",
    "wrong_proposal_mandate",
    "wrong_decision_proposal",
    "wrong_settlement_decision",
    "currency_mismatch",
    "denied_but_executed",
    "decision_key_is_action_key",
    "mandate_key_is_decision_key",
    "mandate_key_is_action_key",
    "args_mismatch",
    "unknown_algorithm",
    "unknown_key",
    "shadow_observes_but_allows",
  ];
  const missing = covered.filter((name) => !names.includes(name));
  if (missing.length === 0) pass("the conformance file covers every refusal case", `${covered.length} cases`);
  else fail("the conformance file covers every refusal case", missing.join(","));
}

console.log(`\n${failures === 0 ? "AGENT GATE OK" : "AGENT GATE FAILED"}: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

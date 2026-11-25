#!/usr/bin/env node
// make-signed-example.mjs — writes conformance/agent-03-example.json.
//
// One signed run a stranger can verify, plus the exact request bodies that must
// be refused. The refusal reasons in the file are MEASURED: this script runs the
// built gate over every case and writes down what the gate actually answered.
// Nothing here is written by hand, so the file cannot drift from the code.
//
// The keys are test keys, generated for this file and discarded the moment it is
// written. They sign nothing outside this file. No private key and no seed is
// written to disk.
//
// Run:  node scripts/make-signed-example.mjs

import { existsSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
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

const { signStatement, digestRef, GENESIS_REF } = await import(
  `file://${join(root, "dist", "agent.js").replace(/\\/g, "/")}`
);
const { createReceiverGate } = await import(
  `file://${join(root, "dist", "receiver.js").replace(/\\/g, "/")}`
);
const { evaluatePayment } = await import(
  `file://${join(root, "dist", "payment.js").replace(/\\/g, "/")}`
);

const RUN = randomBytes(32).toString("hex");

// Every case gets its own run, and therefore its own proposal id. A case that
// shares a proposal id with another case shares its one use: on a door with a
// durable replay store, the first case to be posted spends the proposal and the
// second is refused as a replay. Each case must be spendable on its own.
let runCounter = 0;
function nextRun() {
  runCounter += 1;
  return `${RUN.slice(0, 30)}${runCounter.toString(16).padStart(2, "0")}`;
}
const ARGS = { amount: "10.00", to: "acct-42" };
const ISSUED = "2026-11-20T00:00:00Z";

const keys = {
  mandate: generateKeyPairSync("ed25519"),
  proposer: generateKeyPairSync("ed25519"),
  decision: generateKeyPairSync("ed25519"),
  actor: generateKeyPairSync("ed25519"),
  provider: generateKeyPairSync("ed25519"),
};

const keyring = {
  "mandate-key": keys.mandate.publicKey,
  "proposer-key": keys.proposer.publicKey,
  "decision-key": keys.decision.publicKey,
  "actor-key": keys.actor.publicKey,
  "provider-key": keys.provider.publicKey,
};
const resolveKey = (kid) => keyring[kid] ?? null;

const spki = Object.fromEntries(
  Object.entries(keyring).map(([kid, key]) => [kid, key.export({ type: "spki", format: "der" }).toString("base64")]),
);

// The fingerprint of the keyring, so an operator can check that the secret they
// installed is the keyring of the file they published, without printing a key.
function keyringFingerprint() {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(spki).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function sign(statement, kind, key) {
  return signStatement(statement, kind, key);
}

function build(options = {}) {
  const limits = options.limits ?? { max_actions: "4", max_spend: "100.00", currencies: ["AUD"] };
  const notBefore = options.notBefore ?? "2026-01-01T00:00:00Z";
  const notAfter = options.notAfter ?? "2027-12-31T00:00:00Z";
  const run = options.run ?? nextRun();
  const scope = options.scope ?? ["transfer"];
  const args = options.args ?? ARGS;

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
      intent: options.intent ?? "transfer 10.00 AUD",
      args_digest: options.argsDigest ?? digestRef(args),
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
          observed_at: ISSUED,
          alg: "ed25519",
          kid: "provider-key",
        },
        "settlement",
        keys.provider.privateKey,
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
      issued: ISSUED,
      alg: "ed25519",
      kid: "assembler-key",
    },
    "envelope",
    keys.assembler.privateKey,
  );

  return { run, mandate, proposal, decision, settlement, envelope };
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

function actionRecord(pkg, extra = {}) {
  return {
    event: "action",
    name: "transfer",
    args: ARGS,
    result: "ok",
    prev: GENESIS_REF,
    did: pkg.decision.did,
    kid: "actor-key",
    at: ISSUED,
    ...extra,
  };
}

async function measure(req) {
  const gate = createReceiverGate({ resolveKey, mode: "enforce" });
  const result = await gate.authorize(req);
  return result;
}

// The assembler key is a sixth key: it signs the envelope, and the envelope is
// what names the other four.
keys.assembler = generateKeyPairSync("ed25519");
keyring["assembler-key"] = keys.assembler.publicKey;
spki["assembler-key"] = keys.assembler.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64");

const allowPkg = build();
const allowReq = request(allowPkg);
const allowResult = await measure(allowReq);
if (!allowResult.allowed) {
  console.error(`STOP: the example run was refused — ${allowResult.reason}`);
  process.exit(2);
}

// The settled run: the same decision, one action record, and a settlement.
const settledPkg = build({ settlement: true });
const settledRecord = actionRecord(settledPkg);
const settledPkgWithRoot = build({
  settlement: true,
  actionRoot: digestRef(settledRecord),
  settlementDid: settledPkg.decision.did,
  run: settledPkg.run,
});
const settledRecordBound = { ...settledRecord, did: settledPkgWithRoot.decision.did };

const cases = [];

// 1. no mandate at all.
// Every case gets its own package: a case that borrows another case's proposal
// spends that proposal's one use, and is then refused as a replay at a door
// with a durable replay store.
cases.push({
  case: "no mandate",
  why: "the request carries no authority",
  expected_reason: "missing_authority",
  request: request(build(), { mandate: undefined }),
});

// 2. the mandate's window closed.
cases.push({
  case: "expired mandate",
  why: "the mandate's not_after is in the past",
  expected_reason: "outside_window",
  request: request(build({ notAfter: "2026-06-01T00:00:00Z" })),
});

// 3. the decision said no.
cases.push({
  case: "denied decision",
  why: "the decision verdict is deny",
  expected_reason: "decision_not_allow",
  request: request(build({ verdict: "deny" })),
});

// 4. the arguments are not the ones the proposal described.
cases.push({
  case: "arguments the proposal never described",
  why: "the request's args do not match the proposal's args_digest",
  expected_reason: "args_mismatch",
  request: request(build(), { args: { amount: "999.00", to: "acct-42" } }),
});

// 5. the tool is outside the mandate's scope.
cases.push({
  case: "tool outside the mandate scope",
  why: "the mandate permits transfer, the request asks for withdraw",
  expected_reason: "scope_not_permitted",
  request: request(build(), { tool: "withdraw" }),
});

// 6. the decision was signed by the key that would act.
{
  const pkg = build({ decisionKid: "actor-key", decisionKey: keys.actor.privateKey });
  cases.push({
    case: "the decision key is the acting key",
    why: "the same key signed the decision and would sign the action",
    expected_reason: "decision_key_is_action_key",
    request: request(pkg, { actorKid: "actor-key" }),
  });
}

// 7. the mandate key signed the decision.
{
  const pkg = build({ decisionKid: "mandate-key", decisionKey: keys.mandate.privateKey });
  cases.push({
    case: "the mandate key signed the decision",
    why: "the key that granted the authority also granted itself permission",
    expected_reason: "mandate_key_is_decision_key",
    request: request(pkg),
  });
}

// 8. the proposal names another mandate.
{
  const other = build({ principal: "principal-2" });
  const pkg = build({ proposalMid: other.mandate.mid });
  cases.push({
    case: "proposal bound to another mandate",
    why: "the proposal's mid does not match the mandate it travels with",
    expected_reason: "proposal_mid_mismatch",
    request: request(pkg),
  });
}

// 9. the decision names another proposal.
{
  const other = build({ principal: "principal-2" });
  const pkg = build({ decisionPid: other.proposal.pid });
  cases.push({
    case: "decision bound to another proposal",
    why: "the decision's pid does not match the proposal it travels with",
    expected_reason: "decision_pid_mismatch",
    request: request(pkg),
  });
}

// 10. a signature was altered.
{
  const pkg = build();
  const tampered = { ...pkg.decision, sig: pkg.decision.sig.slice(0, -4) + "AAAA" };
  cases.push({
    case: "forged signature",
    why: "the last characters of the decision signature were changed",
    expected_reason: "signature_invalid",
    request: request(pkg, { decision: tampered }),
  });
}

// 11. a key the receiver cannot resolve.
{
  const pkg = build({ decisionKid: "unknown-key" });
  cases.push({
    case: "unknown key",
    why: "the decision names a kid that is not in the keyring",
    expected_reason: "key_unresolved",
    request: request(pkg),
  });
}

// 12. an algorithm the receiver does not implement.
{
  const pkg = build({ alg: "ed448" });
  cases.push({
    case: "unknown algorithm",
    why: "the decision names an algorithm this receiver does not check",
    expected_reason: "algorithm_unavailable",
    request: request(pkg),
  });
}

// 13. more money than the mandate allows.
cases.push({
  case: "amount above the mandate limit",
  why: "the settlement is 250.00 and the mandate caps spending at 100.00",
  expected_reason: "over_spend",
  request: request(build({ settlement: true, amount: "250.00" })),
});

// 14. a currency the mandate does not permit.
cases.push({
  case: "currency the mandate does not permit",
  why: "the settlement is in USD and the mandate permits AUD only",
  expected_reason: "currency_not_permitted",
  request: request(build({ settlement: true, asset: "USD" })),
});

// 15. a denied decision that executed anyway.
{
  const pkg = build({ verdict: "deny" });
  const record = actionRecord(pkg);
  const withRoot = build({ verdict: "deny", actionRoot: digestRef(record), run: pkg.run });
  cases.push({
    case: "denied but executed",
    why: "the decision said deny and the envelope still names an action",
    expected_reason: "denied_but_executed",
    request: request(withRoot, { actions: [{ ...record, did: withRoot.decision.did }] }),
  });
}

// 16. more actions than the mandate allows.
{
  const limited = build({ limits: { max_actions: "1", max_spend: "100.00", currencies: ["AUD"] } });
  const record = actionRecord(limited);
  const withRoot = build({
    limits: { max_actions: "1", max_spend: "100.00", currencies: ["AUD"] },
    actionRoot: digestRef(record),
    run: limited.run,
  });
  cases.push({
    case: "action count used up",
    why: "the mandate allows one action and one is already on the chain",
    expected_reason: "over_actions",
    request: request(withRoot, { actions: [{ ...record, did: withRoot.decision.did }] }),
  });
}

// 17. the same proposal posted twice.
{
  const pkg = build();
  const gate = createReceiverGate({ resolveKey, mode: "enforce" });
  const first = await gate.authorize(request(pkg));
  const second = await gate.authorize(request(pkg));
  if (first.allowed !== true || second.allowed !== false || second.reason !== "replay") {
    console.error(
      `STOP: the replay case measured first=${first.allowed} second=${second.reason} — it must be allowed then replay`,
    );
    process.exit(2);
  }
  cases.push({
    case: "replayed proposal",
    why: "the same proposal was accepted once already",
    expected_reason: "replay",
    remeasure: false,
    request: request(pkg),
    measured_note: `first post allowed=${first.allowed}, second post allowed=${second.allowed}`,
  });
}

const measured = [];
for (const entry of cases) {
  if (entry.remeasure === false) {
    measured.push({
      case: entry.case,
      why: entry.why,
      expected_reason: entry.expected_reason,
      measured: true,
      request: entry.request,
      ...(entry.measured_note ? { note: entry.measured_note } : {}),
    });
    continue;
  }
  const result = await measure(entry.request);
  if (result.allowed) {
    console.error(`STOP: the case "${entry.case}" was ALLOWED — it must be refused`);
    process.exit(2);
  }
  if (result.reason !== entry.expected_reason) {
    const bad = Object.values(result.report?.checks ?? {}).filter((c) => c.status === "invalid");
    console.error(
      `STOP: the case "${entry.case}" was refused as "${result.reason}", not "${entry.expected_reason}"` +
        (bad.length ? ` — ${bad.map((c) => `${c.reason} (${c.detail ?? ""})`).join("; ")}` : ""),
    );
    process.exit(2);
  }
  measured.push({
    case: entry.case,
    why: entry.why,
    expected_reason: result.reason,
    measured: true,
    request: entry.request,
    ...(entry.measured_note ? { note: entry.measured_note } : {}),
  });
}

// The payment section: one permitted payment, and the refusals a payment door
// must make. Two of them are the gate's; the rest are the door's own money
// rules, because a spend limit belongs to the mandate and the gate cannot read
// a limit out of a request. Both are measured here, against the built code.
const PAY_TIERS = {
  pro: { priceId: "price_pro_placeholder", label: "Pro", currency: "USD", maxMinor: 200000 },
  ultra: { priceId: "price_ultra_placeholder", label: "Ultra", currency: "USD", maxMinor: 2000000 },
};
const PAY_ARGS = { tier: "pro", amount_minor: 1100 };
const PAY_LIMITS = { max_actions: "1", max_spend: "11.00", currencies: ["USD"] };

function payPackage(overrides = {}) {
  return build({
    scope: ["checkout"],
    limits: PAY_LIMITS,
    args: PAY_ARGS,
    intent: "start the Pro subscription",
    ...overrides,
  });
}

function payReq(pkg, args = PAY_ARGS, overrides = {}) {
  return request(pkg, { tool: "checkout", args, ...overrides });
}

async function measurePayment(req, args) {
  const gate = createReceiverGate({ resolveKey, mode: "enforce" });
  const gateResult = await gate.authorize(req);
  const verdict = evaluatePayment(
    { tool: req.tool, args: args ?? req.args, mandate: req.mandate },
    PAY_TIERS,
  );
  return { gateResult, verdict };
}

const payAllowPkg = payPackage();
const payAllowReq = payReq(payAllowPkg);
const payAllow = await measurePayment(payAllowReq, PAY_ARGS);
if (!payAllow.gateResult.allowed || !payAllow.verdict.allowed) {
  console.error(
    `STOP: the payment example was refused — gate=${payAllow.gateResult.reason} door=${payAllow.verdict.reason}`,
  );
  process.exit(2);
}

const payCases = [];

// 1. no mandate.
payCases.push({
  case: "a payment with no mandate",
  why: "the request carries no authority to spend",
  expected_reason: "missing_authority",
  checked_by: "gate",
  request: payReq(payPackage(), PAY_ARGS, { mandate: undefined }),
});

// 2. the same proposal posted twice.
{
  const pkg = payPackage();
  const req = payReq(pkg);
  const gate = createReceiverGate({ resolveKey, mode: "enforce" });
  const first = await gate.authorize(req);
  const second = await gate.authorize(req);
  if (first.allowed !== true || second.allowed !== false || second.reason !== "replay") {
    console.error(
      `STOP: the payment replay case measured first=${first.allowed} second=${second.reason}`,
    );
    process.exit(2);
  }
  payCases.push({
    case: "the same payment proposal posted twice",
    why: "one proposal buys one payment",
    expected_reason: "replay",
    checked_by: "gate",
    post_twice: true,
    request: req,
  });
}

// 3. a forged signature.
{
  const pkg = payPackage();
  const tampered = { ...pkg.decision, sig: pkg.decision.sig.slice(0, -4) + "AAAA" };
  payCases.push({
    case: "a payment with a forged signature",
    why: "the last characters of the decision signature were changed",
    expected_reason: "signature_invalid",
    checked_by: "gate",
    request: payReq(pkg, PAY_ARGS, { decision: tampered }),
  });
}

// 4. a tier the door does not sell.
{
  const args = { tier: "platinum", amount_minor: 1100 };
  const pkg = payPackage({ args });
  const req = payReq(pkg, args);
  const measured = await measurePayment(req, args);
  if (!measured.gateResult.allowed) {
    console.error(`STOP: the tier case was refused by the gate — ${measured.gateResult.reason}`);
    process.exit(2);
  }
  payCases.push({
    case: "a tier the door does not sell",
    why: "the price list is the server's, and this tier is not on it",
    expected_reason: "tier_not_permitted",
    checked_by: "door",
    request: req,
  });
}

// 5. an amount above the mandate's spend limit.
{
  const args = { tier: "ultra", amount_minor: 2000000 };
  const pkg = payPackage({ args });
  const req = payReq(pkg, args);
  const measured = await measurePayment(req, args);
  if (!measured.gateResult.allowed) {
    console.error(`STOP: the over-spend case was refused by the gate — ${measured.gateResult.reason}`);
    process.exit(2);
  }
  payCases.push({
    case: "an amount above the mandate limit",
    why: "the mandate caps spending at 11.00 and this asks for 20000.00",
    expected_reason: "over_spend",
    checked_by: "door",
    request: req,
  });
}

// 6. a currency the mandate does not permit.
{
  const pkg = payPackage({
    limits: { max_actions: "1", max_spend: "11.00", currencies: ["AUD"] },
  });
  const req = payReq(pkg);
  const measured = await measurePayment(req, PAY_ARGS);
  if (!measured.gateResult.allowed) {
    console.error(`STOP: the currency case was refused by the gate — ${measured.gateResult.reason}`);
    process.exit(2);
  }
  payCases.push({
    case: "a currency the mandate does not permit",
    why: "the mandate permits AUD and the price list sells USD",
    expected_reason: "currency_not_permitted",
    checked_by: "door",
    request: req,
  });
}

// 7. a payment made through another tool.
{
  const pkg = payPackage({ scope: ["checkout", "transfer"] });
  const req = payReq(pkg, PAY_ARGS, { tool: "transfer" });
  const measured = await measurePayment(req, PAY_ARGS);
  if (!measured.gateResult.allowed) {
    console.error(`STOP: the tool case was refused by the gate — ${measured.gateResult.reason}`);
    process.exit(2);
  }
  payCases.push({
    case: "a payment made through another tool",
    why: "a permission for one tool is not a permission for the payment door",
    expected_reason: "tool_not_permitted",
    checked_by: "door",
    request: req,
  });
}

const document = {
  profile: "PSI-ACT/1",
  source: "draft-singh-psi-agent-03",
  generated_by: "scripts/make-signed-example.mjs",
  generated_at: new Date().toISOString(),
  note:
    "A signed test run for the receiver gate. The keys below are test keys, made for this file " +
    "and discarded when it was written: they sign nothing outside this file. The refusal reasons " +
    "are measured, not asserted — scripts/agent-example-check.mjs re-runs the gate over every case " +
    "and fails if the answer changes.",
  run: RUN,
  keyring: spki,
  keyring_fingerprint: `sha256:${keyringFingerprint()}`,
  keyring_note:
    "kid -> Ed25519 public key, base64 SPKI. A receiver builds its keyring from the server environment, never from the browser. " +
    "The fingerprint is the SHA-256 of this object with its keys in sorted order; a receiver prints it so an operator can confirm " +
    "the keyring it trusts is the keyring of the file a stranger downloaded.",
  allow: {
    case: "a valid run",
    expected: { allowed: true },
    request: allowReq,
  },
  refusals: measured,
  payment: {
    note:
      "One permitted payment and the refusals a payment door must make. The gate proves the permission was " +
      "signed; the door's own rules apply the mandate's spend limit and currency to the amount about to be " +
      "charged, because a limit belongs to the mandate and cannot be read out of a request. The price ids " +
      "below are placeholders: a live door uses its own price ids from the server environment.",
    tiers: PAY_TIERS,
    tool: "checkout",
    allow: {
      case: "a permitted payment",
      expected: { allowed: true },
      request: payAllowReq,
    },
    refusals: payCases,
  },
  settled_run: {
    note:
      "The same contract after the action ran: one action record on the chain and a settlement bound to the decision. " +
      "This is what the breach pack and the settlement path verify.",
    package: {
      envelope: settledPkgWithRoot.envelope,
      mandate: settledPkgWithRoot.mandate,
      proposal: settledPkgWithRoot.proposal,
      decision: settledPkgWithRoot.decision,
      settlement: settledPkgWithRoot.settlement,
      actions: [settledRecordBound],
    },
  },
  how_to_check: [
    "npm run build && npm run check:example — re-runs the gate over every case in this file and fails if an answer changes",
    "POST the `request` object of any refusal case to the receiver: the answer must be refused with the stated reason",
    "The `allow` case must be permitted; the `settled_run` package must verify clean with the keyring above",
    "The `payment.allow` request must be permitted by the gate and by the payment rules; each `payment.refusals` entry carries `checked_by`: `gate` means the gate refuses it, `door` means the gate permits it and the door's money rules refuse it",
    "The case marked `post_twice` must be posted twice: the first post is permitted, the second is refused as `replay`",
  ],
};

const outPath = join(root, "conformance", "agent-03-example.json");
writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath}`);
console.log(`allow case: allowed, permit ${allowResult.permit?.header ?? "(none)"}`);
console.log(`refusal cases: ${measured.length}, every one measured against the built gate`);
console.log(`payment cases: 1 permitted + ${payCases.length} refused, every one measured`);
console.log(`keyring fingerprint: sha256:${keyringFingerprint()}`);

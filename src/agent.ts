import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalize, fingerprint } from "./gate.js";

export const PSI_ACT_PROFILE = "PSI-ACT/1";
export const GENESIS_REF = `sha256:${"0".repeat(64)}`;

export type DigestRef = string;
export type KeyInput = KeyObject | string | Buffer;
export type KeyResolver = (kid: string) => KeyInput | null | undefined;
export type StatementKind = "mandate" | "proposal" | "decision" | "settlement" | "envelope";

export interface MandateLimits {
  max_actions?: string;
  max_spend?: string;
  currencies?: string[];
}

export interface Mandate {
  ver: string;
  mid: DigestRef;
  run: string;
  principal: string;
  purpose?: string;
  scope?: string[];
  limits?: MandateLimits;
  not_before?: string;
  not_after?: string;
  alg: string;
  kid: string;
  sig: string;
  [key: string]: unknown;
}

export interface Proposal {
  ver: string;
  pid: DigestRef;
  run: string;
  mid: DigestRef;
  proposer: string;
  intent: string;
  args_digest: DigestRef;
  alg: string;
  kid: string;
  sig: string;
  [key: string]: unknown;
}

export type Verdict = "allow" | "deny" | "require_human";

export interface Decision {
  ver: string;
  did: DigestRef;
  run: string;
  pid: DigestRef;
  verdict: Verdict;
  policy_digest: DigestRef;
  decided_by: string;
  reason?: string;
  alg: string;
  kid: string;
  sig: string;
  [key: string]: unknown;
}

export type SettlementStatus =
  | "initiated"
  | "authorised"
  | "captured"
  | "settled"
  | "failed"
  | "refunded"
  | "reversed"
  | "disputed";

export interface Settlement {
  ver: string;
  sid: DigestRef;
  run: string;
  did: DigestRef | "absent";
  payer: string;
  payee: string;
  amount: string;
  asset: string;
  status: SettlementStatus;
  ref?: string;
  scheme?: string;
  observed_at?: string;
  alg: string;
  kid: string;
  sig: string;
  [key: string]: unknown;
}

export interface EnvelopeAnchor {
  merkle_profile: "RFC6962-SHA256";
  leaf_index: number;
  tree_size: number;
  audit_path: string[];
  root: string;
}

export interface Envelope {
  ver: string;
  eid: DigestRef;
  run: string;
  mandate: DigestRef | "absent";
  proposal: DigestRef | "absent";
  decision: DigestRef | "absent";
  action_root: DigestRef | "absent";
  settlement: DigestRef | "absent";
  replaces?: DigestRef;
  issued: string;
  anchor?: EnvelopeAnchor;
  alg: string;
  kid: string;
  sig: string;
  [key: string]: unknown;
}

export interface ActionRecord {
  event: string;
  name: string;
  result?: unknown;
  outputs?: unknown;
  args?: unknown;
  prev: DigestRef;
  did: DigestRef;
  kid: string;
  at: string;
  [key: string]: unknown;
}

export interface RunPackage {
  envelope: Envelope;
  mandate?: Mandate;
  proposal?: Proposal;
  decision?: Decision;
  settlement?: Settlement;
  actions?: ActionRecord[];
}

export type CheckStatus =
  | "ok"
  | "absent"
  | "invalid"
  | "algorithm_unavailable"
  | "key_unresolved"
  | "not_anchored";

export interface CheckResult {
  status: CheckStatus;
  reason?: string;
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  checks: Record<string, CheckResult>;
  actions: ActionRecord[];
}

const ID_FIELD: Record<StatementKind, string> = {
  mandate: "mid",
  proposal: "pid",
  decision: "did",
  settlement: "sid",
  envelope: "eid",
};

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const DIGEST_REF = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{32,}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasStrings(record: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof record[field] === "string" && record[field] !== "");
}

export function isDigestRef(value: unknown): value is DigestRef {
  return typeof value === "string" && DIGEST_REF.test(value);
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value);
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

export function isRFC3339(value: unknown): value is string {
  return typeof value === "string" && RFC3339.test(value) && Number.isFinite(Date.parse(value));
}

export function digestRef(value: unknown): DigestRef {
  return `sha256:${fingerprint(value)}`;
}

function withoutMembers(
  value: Record<string, unknown>,
  members: string[],
): Record<string, unknown> {
  const copy = { ...value };
  for (const member of members) delete copy[member];
  return copy;
}

export function signedBytes(
  statement: Record<string, unknown>,
  kind: StatementKind,
): Buffer {
  const excluded = kind === "envelope" ? ["sig", ID_FIELD[kind], "anchor"] : ["sig", ID_FIELD[kind]];
  return Buffer.from(canonicalize(withoutMembers(statement, excluded)), "utf8");
}

export function signStatement<T extends Record<string, unknown>>(
  statement: T,
  kind: StatementKind,
  privateKey: KeyInput,
): T & { sig: string } {
  const bytes = signedBytes(statement, kind);
  const signature = sign(null, bytes, privateKey).toString("base64url");
  return {
    ...statement,
    [ID_FIELD[kind]]: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sig: signature,
  } as T & { sig: string };
}

function publicKeyOf(key: KeyInput): KeyObject | string | Buffer {
  if (
    typeof key === "object" &&
    key !== null &&
    !Array.isArray(key) &&
    typeof (key as { type?: unknown }).type === "string"
  ) {
    const candidate = key as KeyObject;
    if (candidate.type === "public") return candidate;
    return createPublicKey(candidate);
  }
  return createPublicKey(key);
}

export function verifyStatement(
  statement: Record<string, unknown>,
  kind: StatementKind,
  resolveKey: KeyResolver,
): CheckResult {
  const idField = ID_FIELD[kind];
  if (
    statement.ver !== "1" ||
    !isDigestRef(statement[idField]) ||
    !hasStrings(statement, ["run", "alg", "kid", "sig"]) ||
    !BASE64URL.test(String(statement.sig))
  ) {
    return { status: "invalid", reason: "malformed_statement", detail: kind };
  }

  const bytes = signedBytes(statement, kind);
  const computed = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (computed !== statement[idField]) {
    return { status: "invalid", reason: "id_mismatch", detail: kind };
  }
  if (statement.alg !== "ed25519") {
    return { status: "algorithm_unavailable", detail: String(statement.alg) };
  }

  const key = resolveKey(String(statement.kid));
  if (!key) return { status: "key_unresolved", detail: String(statement.kid) };

  let valid = false;
  try {
    valid = verify(null, bytes, publicKeyOf(key), Buffer.from(String(statement.sig), "base64url"));
  } catch {
    valid = false;
  }
  return valid
    ? { status: "ok" }
    : { status: "invalid", reason: "signature_invalid", detail: kind };
}

function decimalParts(value: string): { negative: boolean; units: bigint; scale: number } {
  const negative = value.startsWith("-");
  const bare = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = bare.split(".");
  return {
    negative,
    units: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

export function compareDecimal(left: string, right: string): number {
  if (!isDecimalString(left) || !isDecimalString(right)) {
    throw new TypeError("decimal comparison requires decimal strings");
  }
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const av = (a.negative ? -a.units : a.units) * 10n ** BigInt(scale - a.scale);
  const bv = (b.negative ? -b.units : b.units) * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function validMandateShape(value: Record<string, unknown>): boolean {
  if (!hasStrings(value, ["mid", "run", "principal", "alg", "kid", "sig"])) return false;
  if (value.scope !== undefined && (!Array.isArray(value.scope) || !value.scope.every((v) => typeof v === "string"))) return false;
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) return false;
    const limits = value.limits;
    if (limits.max_actions !== undefined && !isDecimalString(limits.max_actions)) return false;
    if (limits.max_spend !== undefined && !isDecimalString(limits.max_spend)) return false;
    if (limits.currencies !== undefined && (!Array.isArray(limits.currencies) || !limits.currencies.every((v) => typeof v === "string"))) return false;
  }
  if (value.not_before !== undefined && !isRFC3339(value.not_before)) return false;
  if (value.not_after !== undefined && !isRFC3339(value.not_after)) return false;
  return true;
}

function validProposalShape(value: Record<string, unknown>): boolean {
  return (
    hasStrings(value, ["pid", "run", "mid", "proposer", "intent", "args_digest", "alg", "kid", "sig"]) &&
    isDigestRef(value.mid) &&
    isDigestRef(value.args_digest)
  );
}

function validDecisionShape(value: Record<string, unknown>): boolean {
  return (
    hasStrings(value, ["did", "run", "pid", "verdict", "policy_digest", "decided_by", "alg", "kid", "sig"]) &&
    isDigestRef(value.pid) &&
    isDigestRef(value.policy_digest) &&
    ["allow", "deny", "require_human"].includes(String(value.verdict))
  );
}

function validSettlementShape(value: Record<string, unknown>): boolean {
  return (
    hasStrings(value, ["sid", "run", "did", "payer", "payee", "amount", "asset", "status", "alg", "kid", "sig"]) &&
    (value.did === "absent" || isDigestRef(value.did)) &&
    isDecimalString(value.amount) &&
    ["initiated", "authorised", "captured", "settled", "failed", "refunded", "reversed", "disputed"].includes(String(value.status)) &&
    (value.observed_at === undefined || isRFC3339(value.observed_at))
  );
}

function validEnvelopeShape(value: Record<string, unknown>): boolean {
  const refs = ["mandate", "proposal", "decision", "action_root", "settlement"];
  return (
    hasStrings(value, ["eid", "run", "issued", "alg", "kid", "sig"]) &&
    isDigestRef(value.eid) &&
    isRFC3339(value.issued) &&
    refs.every((field) => value[field] === "absent" || isDigestRef(value[field])) &&
    (value.replaces === undefined || isDigestRef(value.replaces))
  );
}

function shapeValid(statement: Record<string, unknown>, kind: StatementKind): boolean {
  if (statement.ver !== "1") return false;
  if (kind === "mandate") return validMandateShape(statement);
  if (kind === "proposal") return validProposalShape(statement);
  if (kind === "decision") return validDecisionShape(statement);
  if (kind === "settlement") return validSettlementShape(statement);
  return validEnvelopeShape(statement);
}

function actionDigest(record: ActionRecord): DigestRef {
  return digestRef(record);
}

function validActionShape(record: Record<string, unknown>): boolean {
  return (
    hasStrings(record, ["event", "name", "prev", "did", "kid", "at"]) &&
    ("result" in record || "outputs" in record) &&
    isDigestRef(record.prev) &&
    isDigestRef(record.did) &&
    isRFC3339(record.at)
  );
}

export function walkActionChain(records: ActionRecord[], actionRoot: DigestRef): CheckResult & { actions?: ActionRecord[] } {
  if (records.length === 0) return { status: "invalid", reason: "chain_broken", detail: "no records" };
  const byDigest = new Map<string, ActionRecord>();
  for (const record of records) {
    if (!validActionShape(record)) {
      return { status: "invalid", reason: "chain_broken", detail: "malformed action record" };
    }
    const digest = actionDigest(record);
    if (byDigest.has(digest)) {
      return { status: "invalid", reason: "chain_broken", detail: "duplicate action record" };
    }
    byDigest.set(digest, record);
  }

  const reversed: ActionRecord[] = [];
  const seen = new Set<string>();
  let next: DigestRef | undefined = actionRoot;
  while (next !== GENESIS_REF) {
    if (!next || seen.has(next)) {
      return { status: "invalid", reason: "chain_broken", detail: "repeat or missing predecessor" };
    }
    seen.add(next);
    const record = byDigest.get(next);
    if (!record) return { status: "invalid", reason: "chain_broken", detail: `missing ${next}` };
    reversed.push(record);
    next = record.prev;
  }
  return { status: "ok", actions: reversed.reverse() };
}

function hashPair(left: Buffer, right: Buffer): Buffer {
  return createHash("sha256").update(Buffer.concat([Buffer.from([1]), left, right])).digest();
}

function rootFromAuditPath(leaf: Buffer, leafIndex: number, treeSize: number, path: Buffer[]): Buffer | null {
  if (leafIndex < 0 || treeSize <= 0 || leafIndex >= treeSize) return null;
  let index = leafIndex;
  let last = treeSize - 1;
  let root = leaf;
  for (const sibling of path) {
    if (last === 0) return null;
    if ((index & 1) === 1 || index === last) {
      root = hashPair(root, sibling);
      while (index !== 0 && (index & 1) === 0) {
        index >>= 1;
        last >>= 1;
      }
    } else {
      root = hashPair(sibling, root);
    }
    index >>= 1;
    last >>= 1;
  }
  return last === 0 ? root : null;
}

export function verifyAnchor(envelope: Envelope, trustedRoot?: string): CheckResult {
  if (!envelope.anchor) return { status: "not_anchored" };
  const anchor = envelope.anchor;
  if (
    anchor.merkle_profile !== "RFC6962-SHA256" ||
    !Number.isSafeInteger(anchor.leaf_index) ||
    !Number.isSafeInteger(anchor.tree_size) ||
    !Array.isArray(anchor.audit_path) ||
    !anchor.audit_path.every((value) => /^[0-9a-f]{64}$/.test(value)) ||
    !/^[0-9a-f]{64}$/.test(anchor.root)
  ) {
    return { status: "invalid", reason: "inclusion_failed", detail: "malformed anchor" };
  }
  if (!trustedRoot) {
    return { status: "invalid", reason: "inclusion_failed", detail: "no trusted tree head supplied" };
  }
  const leafBytes = Buffer.from(envelope.eid.slice("sha256:".length), "hex");
  const leaf = createHash("sha256").update(Buffer.concat([Buffer.from([0]), leafBytes])).digest();
  const path = anchor.audit_path.map((value) => Buffer.from(value, "hex"));
  const computed = rootFromAuditPath(leaf, anchor.leaf_index, anchor.tree_size, path);
  if (!computed || computed.toString("hex") !== anchor.root || anchor.root !== trustedRoot) {
    return { status: "invalid", reason: "inclusion_failed" };
  }
  return { status: "ok" };
}

export function firstFailure(report: VerificationReport): CheckResult | undefined {
  for (const check of Object.values(report.checks)) {
    if (check.status === "invalid" || check.status === "algorithm_unavailable" || check.status === "key_unresolved") {
      return check;
    }
  }
  return undefined;
}

export function verifyRunPackage(
  input: RunPackage,
  resolveKey: KeyResolver,
  options: { trustedRoot?: string } = {},
): VerificationReport {
  const checks: Record<string, CheckResult> = {};
  const envelope = input.envelope;
  const statements: Array<{ kind: StatementKind; value?: Record<string, unknown>; ref?: string }> = [
    { kind: "mandate", value: input.mandate, ref: envelope?.mandate },
    { kind: "proposal", value: input.proposal, ref: envelope?.proposal },
    { kind: "decision", value: input.decision, ref: envelope?.decision },
    { kind: "settlement", value: input.settlement, ref: envelope?.settlement },
  ];

  if (!isRecord(envelope) || !shapeValid(envelope, "envelope")) {
    checks.envelope = { status: "invalid", reason: "malformed_statement", detail: "envelope" };
    return { ok: false, checks, actions: [] };
  }

  for (const { kind, value, ref } of statements) {
    if (!value) {
      checks[kind] = { status: "absent" };
      continue;
    }
    if (!isRecord(value) || !shapeValid(value, kind)) {
      checks[kind] = { status: "invalid", reason: "malformed_statement", detail: kind };
      continue;
    }
    checks[kind] = verifyStatement(value, kind, resolveKey);
  }
  checks.envelope = verifyStatement(envelope, "envelope", resolveKey);

  for (const { kind, value, ref } of statements) {
    if (!value) continue;
    const id = value[ID_FIELD[kind]];
    if (ref === "absent") {
      checks[`${kind}_ref`] = { status: "invalid", reason: "held_but_envelope_says_absent", detail: kind };
    } else if (id !== ref) {
      checks[`${kind}_ref`] = { status: "invalid", reason: "envelope_ref_mismatch", detail: kind };
    }
  }

  for (const { kind, value } of statements) {
    if (value && value.run !== envelope.run) {
      checks[`${kind}_run`] = { status: "invalid", reason: "run_mismatch", detail: kind };
    }
  }

  if (input.proposal && input.mandate && input.proposal.mid !== input.mandate.mid) {
    checks.proposal_binding = { status: "invalid", reason: "proposal_mid_mismatch" };
  }
  if (input.decision && input.proposal && input.decision.pid !== input.proposal.pid) {
    checks.decision_binding = { status: "invalid", reason: "decision_pid_mismatch" };
  }
  if (input.settlement && input.settlement.did !== "absent" && input.settlement.did !== envelope.decision) {
    checks.settlement_binding = { status: "invalid", reason: "settlement_did_mismatch" };
  }
  if (
    input.decision?.verdict === "deny" &&
    (envelope.action_root !== "absent" || envelope.settlement !== "absent")
  ) {
    checks.denied_binding = { status: "invalid", reason: "denied_but_executed" };
  }

  let actions: ActionRecord[] = [];
  if (envelope.action_root === "absent") {
    if (input.actions?.length) checks.chain = { status: "invalid", reason: "chain_broken", detail: "records with absent root" };
    else checks.chain = { status: "absent" };
  } else {
    const chain = walkActionChain(input.actions ?? [], envelope.action_root);
    checks.chain = { status: chain.status, reason: chain.reason, detail: chain.detail };
    actions = chain.actions ?? [];
  }

  for (const record of actions) {
    if (record.did !== envelope.decision) {
      checks.action_binding = { status: "invalid", reason: "action_did_mismatch" };
      break;
    }
  }
  if (input.decision && actions.some((record) => record.kid === input.decision?.kid)) {
    checks.decision_key = { status: "invalid", reason: "decision_key_is_action_key" };
  }
  if (input.mandate && input.decision && input.mandate.kid === input.decision.kid) {
    checks.mandate_decision_key = { status: "invalid", reason: "mandate_key_is_decision_key" };
  }
  if (input.mandate && actions.some((record) => record.kid === input.mandate?.kid)) {
    checks.mandate_action_key = { status: "invalid", reason: "mandate_key_is_action_key" };
  }

  if (input.mandate?.limits?.max_actions !== undefined && compareDecimal(String(actions.length), input.mandate.limits.max_actions) > 0) {
    checks.action_limit = { status: "invalid", reason: "over_actions" };
  }
  if (input.mandate?.not_before || input.mandate?.not_after) {
    const outside = actions.some((record) => {
      const at = Date.parse(record.at);
      return (
        (input.mandate?.not_before !== undefined && at < Date.parse(input.mandate.not_before)) ||
        (input.mandate?.not_after !== undefined && at > Date.parse(input.mandate.not_after))
      );
    });
    if (outside) checks.window = { status: "invalid", reason: "outside_window" };
  }
  if (
    input.settlement &&
    input.mandate?.limits?.max_spend !== undefined &&
    input.mandate.limits.currencies !== undefined
  ) {
    if (!input.mandate.limits.currencies.includes(input.settlement.asset)) {
      checks.settlement_currency = { status: "invalid", reason: "currency_not_permitted" };
    }
    if (compareDecimal(input.settlement.amount, input.mandate.limits.max_spend) > 0) {
      checks.settlement_spend = { status: "invalid", reason: "over_spend" };
    }
  }

  checks.anchor = verifyAnchor(envelope, options.trustedRoot);
  const report: VerificationReport = { ok: false, checks, actions };
  report.ok = firstFailure(report) === undefined;
  return report;
}

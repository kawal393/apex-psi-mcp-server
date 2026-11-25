import { type KeyObject } from "node:crypto";
export declare const PSI_ACT_PROFILE = "PSI-ACT/1";
export declare const GENESIS_REF: string;
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
export type SettlementStatus = "initiated" | "authorised" | "captured" | "settled" | "failed" | "refunded" | "reversed" | "disputed";
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
export type CheckStatus = "ok" | "absent" | "invalid" | "algorithm_unavailable" | "key_unresolved" | "not_anchored";
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
export declare function isDigestRef(value: unknown): value is DigestRef;
export declare function isRunId(value: unknown): value is string;
export declare function isDecimalString(value: unknown): value is string;
export declare function isRFC3339(value: unknown): value is string;
export declare function digestRef(value: unknown): DigestRef;
export declare function signedBytes(statement: Record<string, unknown>, kind: StatementKind): Buffer;
export declare function signStatement<T extends Record<string, unknown>>(statement: T, kind: StatementKind, privateKey: KeyInput): T & {
    sig: string;
};
export declare function verifyStatement(statement: Record<string, unknown>, kind: StatementKind, resolveKey: KeyResolver): CheckResult;
export declare function compareDecimal(left: string, right: string): number;
export declare function walkActionChain(records: ActionRecord[], actionRoot: DigestRef): CheckResult & {
    actions?: ActionRecord[];
};
export declare function verifyAnchor(envelope: Envelope, trustedRoot?: string): CheckResult;
export declare function firstFailure(report: VerificationReport): CheckResult | undefined;
export declare function verifyRunPackage(input: RunPackage, resolveKey: KeyResolver, options?: {
    trustedRoot?: string;
}): VerificationReport;

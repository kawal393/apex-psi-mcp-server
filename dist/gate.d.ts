/**
 * APEX PSI execution gate — seal before you act.
 *
 * Why this exists: the five tools in this server are available to an agent, but
 * nothing in the protocol makes an agent call them. An agent that never calls
 * `seal` leaves no gap in the ledger — the ledger is complete and says nothing.
 * That is the "voluntary confession" problem: the record is only as complete as
 * the caller's discipline.
 *
 * The gate is the mechanical answer, and it lives in one place only: inside the
 * process that performs the side effect. `gate.run()` seals first and calls the
 * action second, so the action cannot happen without a receipt that already
 * exists. If the seal fails, the action is never called.
 *
 * What it does NOT do, stated plainly:
 *   - it cannot reach a process that never routes its side effect through it;
 *   - it cannot attest what a model did inside a GPU;
 *   - the receipt covers the action as the caller declared it, plus the order in
 *     which the receipt and the action happened.
 *
 * Two sealers:
 *   createLocalSealer()  — in-process SHA-256 chain, no network, no account.
 *   createNotarySealer()  — the hosted APEX PSI notary; returns a ledger receipt.
 *
 * Usage:
 *   import { createGate, createNotarySealer } from "apex-psi-mcp/gate";
 *
 *   const gate = createGate({ sealer: createNotarySealer(), label: "payments-bot" });
 *   const { value, receipt } = await gate.run(
 *     () => payments.transfer({ amount: 500, to: "acct-42" }),
 *     { tool: "transfer", amount: 500, to: "acct-42" },
 *   );
 */
export declare const GENESIS: string;
export interface GateReceipt {
    receipt_id?: string;
    decision_hash: string;
    algorithm?: string;
    scope?: "local" | "ledger";
    entry?: Record<string, unknown>;
    [key: string]: unknown;
}
export type Sealer = (action: unknown) => Promise<GateReceipt>;
export declare class GateClosedError extends Error {
    readonly reason: string;
    readonly action?: unknown;
    constructor(reason: string, action?: unknown);
}
export interface GateResult<T> {
    value: T;
    receipt: GateReceipt;
    action: unknown;
}
export interface Gate {
    /** Seal an action and return the receipt. Throws GateClosedError if it cannot. */
    permit(action: unknown): Promise<GateReceipt>;
    /** Seal first, then call `fn`. `fn` is never called if the seal fails. */
    run<T>(fn: () => T | Promise<T>, action: unknown): Promise<GateResult<T>>;
    /** Throw unless the receipt carries a hash. Use before a payout. */
    requireReceipt(receipt: unknown): GateReceipt;
    /** The value to put on an outbound request so the other side can look the receipt up. */
    permitHeader(receipt: unknown): string;
}
/**
 * Stable JSON: sorted keys, no whitespace. Matches Python's
 * json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) for
 * every value a receipt is built from, so a fingerprint computed here and one
 * computed by the Python runtime agree byte for byte. One divergence remains:
 * a whole number written as a float (1.0) prints "1" here and "1.0" there.
 */
export declare function canonicalize(value: unknown): string;
/** The SHA-256 of the canonical form, hex. */
export declare function fingerprint(value: unknown): string;
/**
 * Seals into an in-process hash chain. No network, no account, no clock anyone
 * else can check. A local permit: it proves order and arguments, and it is not
 * a ledger receipt.
 */
export declare function createLocalSealer(options?: {
    label?: string;
}): Sealer;
/**
 * Seals the fingerprint of the action in the hosted APEX PSI ledger. Only the
 * SHA-256 fingerprint is sent, so the notary never sees the contents.
 */
export declare function createNotarySealer(options?: {
    endpoint?: string;
    apiKey?: string;
    label?: string;
    modelId?: string;
}): Sealer;
/**
 * The gate. Without a sealer it is closed: every action is refused. A gate
 * nobody configured must not look like a gate that is working.
 */
export declare function createGate(options?: {
    sealer?: Sealer;
    label?: string;
}): Gate;
/** Module-level form of `gate.requireReceipt`. */
export declare function requireReceipt(receipt: unknown): GateReceipt;

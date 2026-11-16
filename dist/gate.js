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
import { createHash } from "node:crypto";
const APEX_API_BASE = (process.env.APEX_API_BASE || "https://qhtntebpcribjiwrdtdd.supabase.co/functions/v1").replace(/\/$/, "");
const APEX_API_KEY = process.env.APEX_API_KEY || "";
export const GENESIS = "0".repeat(64);
export class GateClosedError extends Error {
    reason;
    action;
    constructor(reason, action) {
        super(reason);
        this.name = "GateClosedError";
        this.reason = reason;
        this.action = action;
    }
}
/**
 * Stable JSON: sorted keys, no whitespace. Matches Python's
 * json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) for
 * every value a receipt is built from, so a fingerprint computed here and one
 * computed by the Python runtime agree byte for byte. One divergence remains:
 * a whole number written as a float (1.0) prints "1" here and "1.0" there.
 */
export function canonicalize(value) {
    if (value === null)
        return "null";
    if (value === undefined)
        return "null";
    if (typeof value === "number")
        return Number.isFinite(value) ? JSON.stringify(value) : "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "string")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalize).join(",")}]`;
    if (typeof value === "object") {
        const obj = value;
        const keys = Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(String(value));
}
/** The SHA-256 of the canonical form, hex. */
export function fingerprint(value) {
    return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
function entryHash(entry) {
    const canonical = canonicalize({
        seq: entry.seq,
        ts: entry.ts,
        kind: entry.kind,
        payload_sha256: entry.payload_sha256,
        prev: entry.prev,
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
}
/**
 * Seals into an in-process hash chain. No network, no account, no clock anyone
 * else can check. A local permit: it proves order and arguments, and it is not
 * a ledger receipt.
 */
export function createLocalSealer(options = {}) {
    const entries = [];
    return async (action) => {
        const seq = entries.length;
        const ts = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
        const prev = entries.length ? String(entries[entries.length - 1].entry_hash) : GENESIS;
        const payload = fingerprint(action);
        const entry = {
            seq,
            ts,
            kind: "gate",
            payload_sha256: payload,
            prev,
        };
        entry.entry_hash = entryHash(entry);
        entries.push(entry);
        return {
            receipt_id: `LOCAL-${String(entry.entry_hash).slice(0, 16)}`,
            decision_hash: `sha256:${payload}`,
            algorithm: "sha256-local-chain",
            scope: "local",
            entry,
        };
    };
}
/**
 * Seals the fingerprint of the action in the hosted APEX PSI ledger. Only the
 * SHA-256 fingerprint is sent, so the notary never sees the contents.
 */
export function createNotarySealer(options = {}) {
    const endpoint = options.endpoint || APEX_API_BASE;
    const apiKey = options.apiKey ?? APEX_API_KEY;
    const label = options.label || "gate";
    const modelId = options.modelId || "apex-psi-mcp/gate";
    return async (action) => {
        const digest = fingerprint(action);
        const headers = { "Content-Type": "application/json" };
        if (apiKey)
            headers["Authorization"] = `Bearer ${apiKey}`;
        const response = await fetch(`${endpoint}/notarize`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                decision: `sha256:${digest}`,
                context: label,
                predicate: "sealed-before-execution",
                model_id: modelId,
            }),
        });
        if (!response.ok) {
            let detail = "";
            try {
                detail = (await response.text()).slice(0, 300);
            }
            catch {
                /* ignore */
            }
            throw new Error(`notary refused the seal: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
        }
        const receipt = (await response.json());
        if (!receipt.decision_hash)
            receipt.decision_hash = `sha256:${digest}`;
        receipt.scope = "ledger";
        return receipt;
    };
}
/**
 * The gate. Without a sealer it is closed: every action is refused. A gate
 * nobody configured must not look like a gate that is working.
 */
export function createGate(options = {}) {
    const sealer = options.sealer;
    const label = options.label;
    const permit = async (action) => {
        if (!sealer) {
            throw new GateClosedError("no sealer is configured, so no receipt can exist, so the action is refused", action);
        }
        let receipt;
        try {
            receipt = await sealer(action);
        }
        catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            throw new GateClosedError(`sealing failed (${why}), so the action is refused`, action);
        }
        if (!receipt || typeof receipt !== "object" || !receipt.decision_hash) {
            throw new GateClosedError("the sealer returned no receipt carrying a hash, so the action is refused", action);
        }
        return receipt;
    };
    const requireReceipt = (receipt) => {
        if (!receipt || typeof receipt !== "object" || !receipt.decision_hash) {
            throw new GateClosedError("no receipt with a hash was supplied, so the action is refused");
        }
        return receipt;
    };
    return {
        permit,
        requireReceipt,
        async run(fn, action) {
            const described = action && typeof action === "object" && !Array.isArray(action)
                ? { label, ...action }
                : { label, action };
            const receipt = await permit(described);
            const value = await fn();
            return { value, receipt, action: described };
        },
        permitHeader(receipt) {
            return requireReceipt(receipt).decision_hash;
        },
    };
}
/** Module-level form of `gate.requireReceipt`. */
export function requireReceipt(receipt) {
    if (!receipt || typeof receipt !== "object" || !receipt.decision_hash) {
        throw new GateClosedError("no receipt with a hash was supplied, so the action is refused");
    }
    return receipt;
}

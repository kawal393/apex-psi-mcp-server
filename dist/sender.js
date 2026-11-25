import { compareDecimal, digestRef, GENESIS_REF, } from "./agent.js";
import { createGate, GateClosedError } from "./gate.js";
export class SenderBindingError extends GateClosedError {
    constructor(reason, action) {
        super(reason, action);
        this.name = "SenderBindingError";
    }
}
export class SenderOutcomeUnknownError extends GateClosedError {
    constructor(action) {
        super("the previous attempt has an unknown outcome, so a retry is refused", action);
        this.name = "SenderOutcomeUnknownError";
    }
}
export function createMandatedSender(options) {
    const { mandate, proposal, decision, sealer, actorKid } = options;
    const now = options.now ?? (() => new Date());
    const gate = createGate({ sealer, label: options.label });
    const records = [];
    const completed = new Map();
    const uncertain = new Map();
    const inflight = new Map();
    function assertBinding(tool, args) {
        if (decision.verdict !== "allow")
            throw new SenderBindingError("decision_not_allow", args);
        if (mandate.run !== proposal.run || mandate.run !== decision.run) {
            throw new SenderBindingError("run_mismatch", args);
        }
        if (proposal.mid !== mandate.mid)
            throw new SenderBindingError("proposal_mid_mismatch", args);
        if (decision.pid !== proposal.pid)
            throw new SenderBindingError("decision_pid_mismatch", args);
        if (decision.kid === mandate.kid)
            throw new SenderBindingError("mandate_key_is_decision_key", args);
        if (actorKid === decision.kid)
            throw new SenderBindingError("decision_key_is_action_key", args);
        if (actorKid === mandate.kid)
            throw new SenderBindingError("mandate_key_is_action_key", args);
        if (proposal.args_digest !== digestRef(args))
            throw new SenderBindingError("args_mismatch", args);
        if (mandate.scope !== undefined && !mandate.scope.includes(tool)) {
            throw new SenderBindingError("scope_not_permitted", args);
        }
    }
    async function execute(tool, args, fn) {
        assertBinding(tool, args);
        const argsDigest = digestRef(args);
        const prior = completed.get(proposal.pid);
        if (prior) {
            if (prior.argsDigest !== argsDigest)
                throw new SenderBindingError("args_mismatch", args);
            return prior.result;
        }
        if (uncertain.has(proposal.pid))
            throw new SenderOutcomeUnknownError(args);
        const running = inflight.get(proposal.pid);
        if (running) {
            if (running.argsDigest !== argsDigest)
                throw new SenderBindingError("args_mismatch", args);
            return running.promise;
        }
        const operation = (async () => {
            const described = {
                tool,
                args,
                mandate: mandate.mid,
                proposal: proposal.pid,
                decision: decision.did,
            };
            let sealed;
            try {
                sealed = await gate.run(fn, described);
            }
            catch (error) {
                if (!(error instanceof GateClosedError))
                    uncertain.set(proposal.pid, argsDigest);
                throw error;
            }
            const prev = records.length ? digestRef(records[records.length - 1]) : GENESIS_REF;
            const actionRecord = {
                event: "action",
                name: tool,
                args,
                result: sealed.value === undefined ? null : sealed.value,
                prev,
                did: decision.did,
                kid: actorKid,
                at: now().toISOString(),
            };
            records.push(actionRecord);
            const result = {
                value: sealed.value,
                receipt: sealed.receipt,
                action: sealed.action,
                actionRecord,
                chainRoot: digestRef(actionRecord),
            };
            completed.set(proposal.pid, { argsDigest, result });
            return result;
        })();
        inflight.set(proposal.pid, { argsDigest, promise: operation });
        try {
            return (await operation);
        }
        finally {
            inflight.delete(proposal.pid);
        }
    }
    return {
        execute,
        bindSettlement(settlement) {
            if (settlement.run !== mandate.run)
                throw new SenderBindingError("run_mismatch", settlement);
            if (settlement.did !== decision.did)
                throw new SenderBindingError("settlement_did_mismatch", settlement);
            if (mandate.limits?.max_spend !== undefined && mandate.limits.currencies !== undefined) {
                if (!mandate.limits.currencies.includes(settlement.asset)) {
                    throw new SenderBindingError("currency_not_permitted", settlement);
                }
                if (compareDecimal(settlement.amount, mandate.limits.max_spend) > 0) {
                    throw new SenderBindingError("over_spend", settlement);
                }
            }
            return settlement;
        },
        chainRoot() {
            return records.length ? digestRef(records[records.length - 1]) : "absent";
        },
    };
}

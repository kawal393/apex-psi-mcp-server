import { compareDecimal, digestRef, firstFailure, isRFC3339, verifyRunPackage, } from "./agent.js";
import { GateClosedError } from "./gate.js";
export class ReceiverRefusedError extends GateClosedError {
    constructor(reason, action) {
        super(reason, action);
        this.name = "ReceiverRefusedError";
    }
}
class MemoryReplayStore {
    seen = new Set();
    consume(key) {
        if (this.seen.has(key))
            return false;
        this.seen.add(key);
        return true;
    }
}
function refused(report, reason, mode) {
    return {
        allowed: mode === "shadow",
        enforced: mode === "enforce",
        wouldAllow: false,
        reason,
        report,
    };
}
function permitFor(mandate, proposal, decision, envelope) {
    return {
        header: envelope.eid,
        run: envelope.run,
        mandate: mandate.mid,
        proposal: proposal.pid,
        decision: decision.did,
    };
}
export function createReceiverGate(options) {
    const mode = options.mode ?? "enforce";
    const now = options.now ?? (() => new Date());
    const replayStore = options.replayStore ?? new MemoryReplayStore();
    const authorize = async (request) => {
        const report = verifyRunPackage(request, options.resolveKey, {
            trustedRoot: options.trustedRoot,
        });
        const failure = firstFailure(report);
        if (failure)
            return refused(report, failure.reason ?? failure.status, mode);
        if (!request.mandate || !request.proposal || !request.decision) {
            return refused(report, "missing_authority", mode);
        }
        if (request.envelope.mandate === "absent" ||
            request.envelope.proposal === "absent" ||
            request.envelope.decision === "absent") {
            return refused(report, "missing_authority", mode);
        }
        if (request.decision.verdict !== "allow") {
            return refused(report, "decision_not_allow", mode);
        }
        if (request.proposal.args_digest !== digestRef(request.args)) {
            return refused(report, "args_mismatch", mode);
        }
        if (request.mandate.scope !== undefined && !request.mandate.scope.includes(request.tool)) {
            return refused(report, "scope_not_permitted", mode);
        }
        if (request.actorKid === request.decision.kid) {
            return refused(report, "decision_key_is_action_key", mode);
        }
        if (request.actorKid === request.mandate.kid) {
            return refused(report, "mandate_key_is_action_key", mode);
        }
        const at = now().getTime();
        if (!Number.isFinite(at))
            return refused(report, "invalid_clock", mode);
        if (request.mandate.not_before !== undefined) {
            if (!isRFC3339(request.mandate.not_before) || at < Date.parse(request.mandate.not_before)) {
                return refused(report, "outside_window", mode);
            }
        }
        if (request.mandate.not_after !== undefined) {
            if (!isRFC3339(request.mandate.not_after) || at > Date.parse(request.mandate.not_after)) {
                return refused(report, "outside_window", mode);
            }
        }
        if (request.mandate.limits?.max_actions !== undefined &&
            compareDecimal(String(report.actions.length + 1), request.mandate.limits.max_actions) > 0) {
            return refused(report, "over_actions", mode);
        }
        if (mode === "enforce") {
            const fresh = await replayStore.consume(request.proposal.pid);
            if (!fresh)
                return refused(report, "replay", mode);
        }
        return {
            allowed: true,
            enforced: mode === "enforce",
            wouldAllow: true,
            report,
            permit: permitFor(request.mandate, request.proposal, request.decision, request.envelope),
        };
    };
    return {
        authorize,
        async run(request, fn) {
            const result = await authorize(request);
            if (!result.allowed) {
                throw new ReceiverRefusedError(result.reason ?? "action_refused", request);
            }
            const value = await fn();
            return { ...result, value };
        },
        authorizeSettlement(input) {
            const report = verifyRunPackage(input, options.resolveKey, {
                trustedRoot: options.trustedRoot,
            });
            const failure = firstFailure(report);
            if (failure)
                return refused(report, failure.reason ?? failure.status, mode);
            if (!input.settlement)
                return refused(report, "missing_settlement", mode);
            if (!input.decision || input.decision.verdict !== "allow") {
                return refused(report, "decision_not_allow", mode);
            }
            if (input.settlement.did !== input.decision.did) {
                return refused(report, "settlement_did_mismatch", mode);
            }
            if (input.envelope.settlement === "absent") {
                return refused(report, "held_but_envelope_says_absent", mode);
            }
            return { allowed: mode !== "enforce" || report.ok, enforced: mode === "enforce", wouldAllow: report.ok, report };
        },
    };
}

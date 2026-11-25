import {
  compareDecimal,
  digestRef,
  GENESIS_REF,
  type ActionRecord,
  type Decision,
  type Mandate,
  type Proposal,
  type Settlement,
} from "./agent.js";
import { createGate, GateClosedError, type GateReceipt, type GateResult, type Sealer } from "./gate.js";

export interface SenderExecution<T> {
  value: T;
  receipt: GateReceipt;
  action: unknown;
  actionRecord: ActionRecord;
  chainRoot: string;
}

export interface MandatedSenderOptions {
  mandate: Mandate;
  proposal: Proposal;
  decision: Decision;
  sealer: Sealer;
  actorKid: string;
  label?: string;
  now?: () => Date;
}

export interface MandatedSender {
  execute<T>(tool: string, args: unknown, fn: () => T | Promise<T>): Promise<SenderExecution<T>>;
  bindSettlement(settlement: Settlement): Settlement;
  chainRoot(): string;
}

export class SenderBindingError extends GateClosedError {
  constructor(reason: string, action?: unknown) {
    super(reason, action);
    this.name = "SenderBindingError";
  }
}

export class SenderOutcomeUnknownError extends GateClosedError {
  constructor(action?: unknown) {
    super("the previous attempt has an unknown outcome, so a retry is refused", action);
    this.name = "SenderOutcomeUnknownError";
  }
}

export function createMandatedSender(options: MandatedSenderOptions): MandatedSender {
  const { mandate, proposal, decision, sealer, actorKid } = options;
  const now = options.now ?? (() => new Date());
  const gate = createGate({ sealer, label: options.label });
  const records: ActionRecord[] = [];
  const completed = new Map<string, { argsDigest: string; result: SenderExecution<unknown> }>();
  const uncertain = new Map<string, string>();
  const inflight = new Map<string, { argsDigest: string; promise: Promise<SenderExecution<unknown>> }>();

  function assertBinding(tool: string, args: unknown): void {
    if (decision.verdict !== "allow") throw new SenderBindingError("decision_not_allow", args);
    if (mandate.run !== proposal.run || mandate.run !== decision.run) {
      throw new SenderBindingError("run_mismatch", args);
    }
    if (proposal.mid !== mandate.mid) throw new SenderBindingError("proposal_mid_mismatch", args);
    if (decision.pid !== proposal.pid) throw new SenderBindingError("decision_pid_mismatch", args);
    if (decision.kid === mandate.kid) throw new SenderBindingError("mandate_key_is_decision_key", args);
    if (actorKid === decision.kid) throw new SenderBindingError("decision_key_is_action_key", args);
    if (actorKid === mandate.kid) throw new SenderBindingError("mandate_key_is_action_key", args);
    if (proposal.args_digest !== digestRef(args)) throw new SenderBindingError("args_mismatch", args);
    if (mandate.scope !== undefined && !mandate.scope.includes(tool)) {
      throw new SenderBindingError("scope_not_permitted", args);
    }
  }

  async function execute<T>(tool: string, args: unknown, fn: () => T | Promise<T>): Promise<SenderExecution<T>> {
    assertBinding(tool, args);
    const argsDigest = digestRef(args);
    const prior = completed.get(proposal.pid);
    if (prior) {
      if (prior.argsDigest !== argsDigest) throw new SenderBindingError("args_mismatch", args);
      return prior.result as SenderExecution<T>;
    }
    if (uncertain.has(proposal.pid)) throw new SenderOutcomeUnknownError(args);
    const running = inflight.get(proposal.pid);
    if (running) {
      if (running.argsDigest !== argsDigest) throw new SenderBindingError("args_mismatch", args);
      return running.promise as Promise<SenderExecution<T>>;
    }

    const operation = (async (): Promise<SenderExecution<unknown>> => {
      const described = {
        tool,
        args,
        mandate: mandate.mid,
        proposal: proposal.pid,
        decision: decision.did,
      };
      let sealed: GateResult<T>;
      try {
        sealed = await gate.run(fn, described);
      } catch (error) {
        if (!(error instanceof GateClosedError)) uncertain.set(proposal.pid, argsDigest);
        throw error;
      }

      const prev = records.length ? digestRef(records[records.length - 1]) : GENESIS_REF;
      const actionRecord: ActionRecord = {
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
      const result: SenderExecution<unknown> = {
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
      return (await operation) as SenderExecution<T>;
    } finally {
      inflight.delete(proposal.pid);
    }
  }

  return {
    execute,
    bindSettlement(settlement: Settlement): Settlement {
      if (settlement.run !== mandate.run) throw new SenderBindingError("run_mismatch", settlement);
      if (settlement.did !== decision.did) throw new SenderBindingError("settlement_did_mismatch", settlement);
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
    chainRoot(): string {
      return records.length ? digestRef(records[records.length - 1]) : "absent";
    },
  };
}

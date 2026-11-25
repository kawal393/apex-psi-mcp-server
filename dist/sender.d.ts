import { type ActionRecord, type Decision, type Mandate, type Proposal, type Settlement } from "./agent.js";
import { GateClosedError, type GateReceipt, type Sealer } from "./gate.js";
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
export declare class SenderBindingError extends GateClosedError {
    constructor(reason: string, action?: unknown);
}
export declare class SenderOutcomeUnknownError extends GateClosedError {
    constructor(action?: unknown);
}
export declare function createMandatedSender(options: MandatedSenderOptions): MandatedSender;

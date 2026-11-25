import { type KeyResolver, type RunPackage, type VerificationReport } from "./agent.js";
import { GateClosedError } from "./gate.js";
export interface ReceiverRequest extends RunPackage {
    tool: string;
    args: unknown;
    actorKid: string;
}
export interface ReplayStore {
    consume(key: string): boolean | Promise<boolean>;
}
export interface ReceiverPermit {
    header: string;
    run: string;
    mandate: string;
    proposal: string;
    decision: string;
}
export interface ReceiverResult<T = unknown> {
    allowed: boolean;
    enforced: boolean;
    wouldAllow: boolean;
    reason?: string;
    report: VerificationReport;
    permit?: ReceiverPermit;
    value?: T;
}
export interface ReceiverGateOptions {
    resolveKey: KeyResolver;
    mode?: "enforce" | "shadow";
    now?: () => Date;
    replayStore?: ReplayStore;
    trustedRoot?: string;
}
export interface ReceiverGate {
    authorize(request: ReceiverRequest): Promise<ReceiverResult>;
    run<T>(request: ReceiverRequest, fn: () => T | Promise<T>): Promise<ReceiverResult<T>>;
    authorizeSettlement(input: RunPackage): ReceiverResult;
}
export declare class ReceiverRefusedError extends GateClosedError {
    constructor(reason: string, action?: unknown);
}
export declare function createReceiverGate(options: ReceiverGateOptions): ReceiverGate;

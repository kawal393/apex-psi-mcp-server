import { type Mandate } from "./agent.js";
export declare const PAYMENT_TOOL = "checkout";
export interface PaymentTier {
    priceId: string;
    label: string;
    currency: string;
    maxMinor: number;
}
export interface PaymentRequest {
    tool?: string;
    args?: Record<string, unknown>;
    mandate?: Mandate | null;
}
export interface PaymentVerdict {
    allowed: boolean;
    reason?: string;
    tier?: string;
    amountMinor?: number;
    currency?: string;
}
export type TierCatalog = Record<string, PaymentTier>;
/**
 * The money rules of a payment door, in one place so both the door and its
 * tests use the same code. The receiver gate proves that a permission was
 * signed; it does not read a spend limit out of the request, because a limit
 * is a property of the mandate, and a request carries no limit of its own.
 * These rules are where the mandate's limit is applied to the amount that is
 * about to be charged.
 */
export declare function evaluatePayment(request: PaymentRequest, tiers: TierCatalog, options?: {
    expectedTool?: string;
}): PaymentVerdict;
export declare function minorToDecimal(minor: number): string;

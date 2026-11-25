import { compareDecimal } from "./agent.js";
export const PAYMENT_TOOL = "checkout";
/**
 * The money rules of a payment door, in one place so both the door and its
 * tests use the same code. The receiver gate proves that a permission was
 * signed; it does not read a spend limit out of the request, because a limit
 * is a property of the mandate, and a request carries no limit of its own.
 * These rules are where the mandate's limit is applied to the amount that is
 * about to be charged.
 */
export function evaluatePayment(request, tiers, options = {}) {
    const expectedTool = options.expectedTool ?? PAYMENT_TOOL;
    if (!request.mandate)
        return { allowed: false, reason: "missing_authority" };
    if (request.tool !== expectedTool)
        return { allowed: false, reason: "tool_not_permitted" };
    const args = request.args ?? {};
    const tierName = typeof args.tier === "string" ? args.tier : "";
    const tier = tiers[tierName];
    if (!tier)
        return { allowed: false, reason: "tier_not_permitted" };
    const amountMinor = args.amount_minor;
    if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        return { allowed: false, reason: "args_mismatch" };
    }
    if (amountMinor > tier.maxMinor)
        return { allowed: false, reason: "over_spend" };
    const limits = request.mandate.limits;
    const maxSpend = limits?.max_spend;
    if (typeof maxSpend !== "string")
        return { allowed: false, reason: "missing_limit" };
    if (compareDecimal(minorToDecimal(amountMinor), maxSpend) > 0) {
        return { allowed: false, reason: "over_spend" };
    }
    const currencies = limits?.currencies;
    if (!Array.isArray(currencies) || currencies.length === 0)
        return { allowed: false, reason: "missing_limit" };
    if (!currencies.includes(tier.currency))
        return { allowed: false, reason: "currency_not_permitted" };
    return { allowed: true, tier: tierName, amountMinor, currency: tier.currency };
}
export function minorToDecimal(minor) {
    const whole = Math.floor(minor / 100);
    const fraction = String(minor % 100).padStart(2, "0");
    return `${whole}.${fraction}`;
}

#!/usr/bin/env node
// payment-check — proves the money rules of a payment door.
//
// The receiver gate proves that a permission was signed. It does not read a
// spend limit out of a request, because a limit belongs to the mandate. These
// rules are where the mandate's limit is applied to the amount about to be
// charged, and they are the difference between a permission and a blank cheque.
//
// The door and this check must run the same code, so this drives the BUILT
// module in dist/, which is what a stranger installs.
//
// Run:  node scripts/payment-check.mjs
// Exit 0 = the rules hold. Exit 1 = they do not.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

if (!existsSync(join(root, "dist", "payment.js"))) {
  console.error("STOP: dist/payment.js is not built — run `npm run build` first");
  process.exit(2);
}

const { evaluatePayment, minorToDecimal } = await import(
  `file://${join(root, "dist", "payment.js").replace(/\\/g, "/")}`
);

let failures = 0;
function pass(what, detail) {
  console.log(`PASS ${what}${detail ? ": " + detail : ""}`);
}
function fail(what, detail) {
  failures++;
  console.error(`FAIL ${what}${detail ? ": " + detail : ""}`);
}

const TIERS = {
  pro: { priceId: "price_pro", label: "Pro", currency: "USD", maxMinor: 200000 },
  ultra: { priceId: "price_ultra", label: "Ultra", currency: "USD", maxMinor: 2000000 },
};

const mandate = (over = {}) => ({
  ver: "1",
  mid: "sha256:" + "a".repeat(64),
  run: "b".repeat(64),
  principal: "principal-1",
  scope: ["checkout"],
  limits: { max_actions: "1", max_spend: "11.00", currencies: ["USD"] },
  alg: "ed25519",
  kid: "mandate-key",
  sig: "",
  ...over,
});

const payment = (over = {}) => ({
  tool: "checkout",
  args: { tier: "pro", amount_minor: 1100 },
  mandate: mandate(),
  ...over,
});

function expectRefusal(name, request, reason) {
  const verdict = evaluatePayment(request, TIERS);
  if (!verdict.allowed && verdict.reason === reason) pass(`refuses ${name}`, reason);
  else fail(`refuses ${name}`, `allowed=${verdict.allowed} reason=${verdict.reason} wanted=${reason}`);
}

// 1. a permitted payment.
{
  const verdict = evaluatePayment(payment(), TIERS);
  if (verdict.allowed && verdict.tier === "pro" && verdict.amountMinor === 1100) {
    pass("allows a permitted payment", `${verdict.tier} ${verdict.amountMinor}`);
  } else {
    fail("allows a permitted payment", JSON.stringify(verdict));
  }
}

// 2. no mandate at all.
expectRefusal("a payment with no mandate", payment({ mandate: null }), "missing_authority");

// 3. the tool is not this door's tool.
expectRefusal("a payment made through another tool", payment({ tool: "transfer" }), "tool_not_permitted");

// 4. a tier that is not on the price list.
expectRefusal("a tier the door does not sell", payment({ args: { tier: "platinum", amount_minor: 1100 } }), "tier_not_permitted");

// 5. an amount that is not a number of minor units.
expectRefusal("an amount that is not minor units", payment({ args: { tier: "pro", amount_minor: "11.00" } }), "args_mismatch");
expectRefusal("a negative amount", payment({ args: { tier: "pro", amount_minor: -100 } }), "args_mismatch");
expectRefusal("a fractional amount", payment({ args: { tier: "pro", amount_minor: 1100.5 } }), "args_mismatch");

// 6. an amount above the tier's own ceiling.
expectRefusal("an amount above the tier ceiling", payment({ args: { tier: "pro", amount_minor: 200001 } }), "over_spend");

// 7. an amount above the mandate's spend limit. The gate does not read this
// limit out of a request, so the door must.
expectRefusal(
  "an amount above the mandate limit",
  payment({ args: { tier: "ultra", amount_minor: 2000000 } }),
  "over_spend",
);

// 8. a currency the mandate does not permit.
expectRefusal(
  "a currency the mandate does not permit",
  payment({ mandate: mandate({ limits: { max_actions: "1", max_spend: "11.00", currencies: ["AUD"] } }) }),
  "currency_not_permitted",
);

// 9. a mandate that states no limit at all.
expectRefusal(
  "a mandate with no spend limit",
  payment({ mandate: mandate({ limits: { max_actions: "1" } }) }),
  "missing_limit",
);
expectRefusal(
  "a mandate with no currency list",
  payment({ mandate: mandate({ limits: { max_actions: "1", max_spend: "11.00" } }) }),
  "missing_limit",
);

// 10. the decimal conversion is exact, never floating point.
{
  const cases = [
    [1100, "11.00"],
    [2000000, "20000.00"],
    [1, "0.01"],
    [105, "1.05"],
    [99, "0.99"],
    [100, "1.00"],
  ];
  let bad = 0;
  for (const [minor, wanted] of cases) {
    if (minorToDecimal(minor) !== wanted) bad++;
  }
  if (bad === 0) pass("minor units convert exactly", `${cases.length} cases`);
  else fail("minor units convert exactly", `${bad} mismatches`);
}

// 11. the comparison bites at the boundary: one minor unit over the limit is
// refused, and one under is permitted. A check that cannot fail is not a check.
{
  const over = evaluatePayment(payment({ args: { tier: "pro", amount_minor: 1101 } }), TIERS);
  const under = evaluatePayment(payment({ args: { tier: "pro", amount_minor: 1099 } }), TIERS);
  if (!over.allowed && over.reason === "over_spend" && under.allowed) {
    pass("the limit is exact at the minor unit", "1101 refused, 1099 permitted");
  } else {
    fail("the limit is exact at the minor unit", `over=${JSON.stringify(over)} under=${JSON.stringify(under)}`);
  }
}

// 12. a tier's ceiling is the server's, and the mandate's limit is the
// client's: both must hold. The tighter one wins.
{
  const tightMandate = payment({
    mandate: mandate({ limits: { max_actions: "1", max_spend: "5.00", currencies: ["USD"] } }),
    args: { tier: "pro", amount_minor: 1100 },
  });
  const verdict = evaluatePayment(tightMandate, TIERS);
  if (!verdict.allowed && verdict.reason === "over_spend") {
    pass("the tighter of the two limits wins", "mandate 5.00 below tier 2000.00");
  } else {
    fail("the tighter of the two limits wins", JSON.stringify(verdict));
  }
}

// 13. the module must be reachable by the people who need it: the export map
// must name it, and the published tarball must carry it.
{
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const exported = pkg.exports?.["./payment"];
  const ships = Array.isArray(pkg.files) && pkg.files.includes("dist");
  if (exported === "./dist/payment.js" && ships) {
    pass("the package exports the payment rules", exported);
  } else {
    fail("the package exports the payment rules", `exports=${exported} ships_dist=${ships}`);
  }
}

console.log(`\n${failures === 0 ? "PAYMENT RULES OK" : "PAYMENT RULES FAILED"}: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

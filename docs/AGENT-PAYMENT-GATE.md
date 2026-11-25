# The agent payment gate — make the gate load-bearing

Revision 2 — 25 November 2026, after the first round of the Lovable build.
Every number and every refusal reason below was measured against the built
package and the live site; nothing here is estimated.

## 1. What is now true

Lovable's round one built and deployed `supabase/functions/agent-checkout`,
added the date index on `gate_replay`, and left `create-checkout` alone. I read
the deployed sources and measured:

- **The agent door exists and is dormant.** No `PSI_GATE_KEYRING` means every
  request answers `503 gate_dormant` and no Stripe session is created. That is
  the right answer for a door with no trust anchor.
- **The replay key is fixed in the agent door.** `gate_replay` is written with
  `replay_key: pid` — the proposal id alone, with the scope as a separate
  column. Session A gets a permit, session A again gets `replay`, and session B
  also gets `replay`. That is the guarantee we want on the money door.
- **`/breach-pack` exists** and the recipe page links the conformance files.

Two holes are still open, and **both are mine, not Lovable's** — they are in
the source I wrote and Lovable pasted faithfully.

## 2. The two holes in my own spec

**Hole A — the payment tool was never bound.** The door never compared
`body.tool` with its own tool. A signed permission for another tool inside the
mandate's scope — `transfer`, say — would pass the gate and start a Stripe
session. A permission for one action is not a permission for another.

**Hole B — the mandate's spend limit was never applied to the amount.**
Measured in `src/agent.ts`: the receiver gate checks `limits.max_spend` and
`limits.currencies` **only against a settlement**. A request that carries no
settlement carries no limit at all. So the door as written would charge up to
the tier's own ceiling no matter what the mandate said. A mandate limited to
`11.00` could have been charged `2000.00` — the Ultra ceiling — and the gate
would have permitted it, because the gate never looked.

The fix is code both sides import, so the door and its tests cannot drift:
`apex-psi-mcp/payment` (`src/payment.ts`), with twelve offline cases in
`scripts/payment-check.mjs`. It binds the tool, reads the tier from the server
catalogue, and applies the mandate's own limit and currency to the amount
about to be charged.

## 3. The rule — two doors, never merged

**The human door stays exactly as it is.** `create-checkout` is a person
clicking a button while signed in. Its permission is the session. A gate in
front of it would refuse every purchase, because no human will ever produce a
mandate. Do not put it there.

**The agent door is the only path an agent may use to start a payment.** It
asks the gate first, then applies the money rules, and creates a Stripe session
only if both permit the exact action.

**The conformance door is a test bed, not a door.** It answers whether a
request carries a valid permission. It creates no session and moves no money.
Its permits are test results, not authority.

## 4. The three doors and their replay keys

| Door | Creates a Stripe session? | Replay key | Guarantee |
|------|--------------------------|------------|-----------|
| `create-checkout` (human) | yes | none — the session is the permission | a signed-in person may buy |
| `agent-checkout` (agent, money) | yes | **the proposal id alone** | a proposal is spent once, on every instance, forever |
| `machine-checkout?conformance=agent-03` (test bed) | never | `conformance:${session}:${pid}` | a replay is refused inside a session |

The conformance door is session-scoped on purpose: the published example must
stay runnable by anyone, forever, without anyone being able to mint money. The
session id is required — a request without one is refused with
`400 session_required`, so nobody can read "posted twice with no session, both
allowed" as the guarantee.

**What is deployed today is the opposite.** The conformance door keys on the
proposal id alone, so the example's one valid case has been spent for good and
every later visitor is told `replay`. And without a session the door keeps no
replay memory at all — I posted the same signed request six times with no
session and all six returned `200 ok=true`.

Change the conformance store to key on `conformance:${session}:${pid}`, require
the session, and leave the agent door on the bare proposal id. Do not change
the npm package: `scripts/agent-gate-check.mjs` case 6b pins the package's key
to the proposal id exactly, and the package must stay that way.

## 5. The function — paste this

Create `supabase/functions/agent-checkout/index.ts`. The gate code is already
vendored at `supabase/functions/_shared/psi-agent/receiver.ts`; copy it
unchanged, the same way `machine-checkout` does it. Add the money rules beside
it at `supabase/functions/_shared/psi-agent/payment.ts`, copied from
`src/payment.ts` in the package with its `./agent.js` import left as it is —
the vendored `receiver.ts` already resolves that way in Deno.

```ts
// agent-checkout — the agent door. The receiver gate is consulted first, the
// door's own money rules second, and a Stripe session is created only if both
// permit the exact action.
//
// The human door (create-checkout) is untouched: a person's signed-in session
// is that permission. This door exists for agents, which must carry a signed
// mandate, a signed proposal and a signed decision.
import { createPublicKey, createHash, type KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReceiverGate, type ReceiverGate } from "../_shared/psi-agent/receiver.ts";
import { evaluatePayment, PAYMENT_TOOL } from "../_shared/psi-agent/payment.ts";
import type { Mandate } from "../_shared/psi-agent/agent.ts";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const MAX_BODY = 256 * 1024;

// One price per tier, on the server. The request never chooses a price.
const TIERS = {
  pro: { priceId: Deno.env.get("STRIPE_PRICE_PRO") ?? "", label: "Pro", currency: "USD", maxMinor: 200000 },
  ultra: { priceId: Deno.env.get("STRIPE_PRICE_ULTRA") ?? "", label: "Ultra", currency: "USD", maxMinor: 2000000 },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function keyringFrom(map: Record<string, string>) {
  const ring: Record<string, KeyObject> = {};
  for (const [kid, spki] of Object.entries(map)) {
    ring[kid] = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
  }
  return (kid: string) => ring[kid] ?? null;
}

// The fingerprint of the keyring this door trusts. An operator compares it with
// the keyring_fingerprint in the published example file, so a mismatch is
// visible without printing a key.
function fingerprintOf(map: Record<string, string>) {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

// Durable replay store for the MONEY door. The key is the PROPOSAL ID ALONE —
// no session, no scope prefix. A proposal is spent once, on every instance,
// forever. Prefixing the key lets the same signed proposal through again,
// which is the replay this store exists to refuse.
function durableReplay() {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  return {
    async consume(pid: string) {
      const { error } = await db.from("gate_replay").insert({ replay_key: pid, scope: "agent-checkout" });
      if (!error) return true;
      if (error.code === "23505") return false;
      throw new Error("replay_store_unavailable");
    },
  };
}

let gate: ReceiverGate | null = null;
let trustedFingerprint: string | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const ringRaw = Deno.env.get("PSI_GATE_KEYRING");
    return json({
      profile: "PSI-ACT/1",
      door: "agent-checkout",
      live_mode: ringRaw ? (Deno.env.get("PSI_GATE_MODE") ?? "shadow") : "dormant",
      keyring_fingerprint: ringRaw ? fingerprintOf(JSON.parse(ringRaw)) : null,
      note: "An agent payment needs a signed mandate, proposal and decision. A refusal creates no Stripe session.",
    });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: "body_too_large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const ringRaw = Deno.env.get("PSI_GATE_KEYRING");
  if (!ringRaw) {
    return json({ ok: false, dormant: true, reason: "gate_dormant", detail: "No receiver keyring is configured." }, 503);
  }
  try {
    const ring = JSON.parse(ringRaw) as Record<string, string>;
    trustedFingerprint = fingerprintOf(ring);
    gate ??= createReceiverGate({
      resolveKey: keyringFrom(ring),
      mode: (Deno.env.get("PSI_GATE_MODE") ?? "shadow") === "enforce" ? "enforce" : "shadow",
      replayStore: durableReplay(),
    });
  } catch {
    return json({ ok: false, reason: "keyring_misconfigured" }, 500);
  }

  // 1. the gate decides. Everything below it runs only on a permit.
  let result;
  try {
    // deno-lint-ignore no-explicit-any
    result = await gate.authorize({ ...(body as any), actions: (body.actions as unknown[]) ?? [] });
  } catch {
    return json({ ok: false, refused: true, reason: "malformed_request" }, 400);
  }
  if (!result) return json({ ok: false, refused: true, reason: "malformed_request" }, 400);
  if (!result.wouldAllow) {
    console.log(JSON.stringify({ gate: "agent-checkout", refused: result.reason }));
    return json({ ok: false, refused: true, reason: result.reason, mode: Deno.env.get("PSI_GATE_MODE") ?? "shadow" }, 403);
  }

  // 2. the door's money rules. The mandate is the one the gate just verified:
  // the gate refuses a proposal that names another mandate (proposal_mid_mismatch),
  // and it refuses args that are not the digest the proposal signed (args_mismatch).
  const verdict = evaluatePayment(
    {
      tool: body.tool as string | undefined,
      args: body.args as Record<string, unknown>,
      mandate: body.mandate as Mandate | undefined,
    },
    TIERS,
    { expectedTool: PAYMENT_TOOL },
  );
  if (!verdict.allowed) {
    console.log(JSON.stringify({ door: "agent-checkout", refused: verdict.reason }));
    return json({ ok: false, refused: true, reason: verdict.reason, mode: Deno.env.get("PSI_GATE_MODE") ?? "shadow" }, 403);
  }

  // 3. the amount and the tier are the signed ones, and the price is the server's.
  const tier = TIERS[verdict.tier as keyof typeof TIERS];
  if (!tier.priceId) return json({ ok: false, refused: true, reason: "tier_not_permitted" }, 403);

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { httpClient: Stripe.createFetchHttpClient() });
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: tier.priceId, quantity: 1 }],
    success_url: `${url.origin}/upgrade?status=success&tier=${tier.label.toLowerCase()}`,
    cancel_url: `${url.origin}/upgrade?status=cancelled&tier=${tier.label.toLowerCase()}`,
  });
  return json({
    ok: true,
    url: session.url,
    tier: tier.label.toLowerCase(),
    amount_minor: verdict.amountMinor,
    currency: verdict.currency,
    permit: result.permit,
    header: result.permit?.header,
    keyring_fingerprint: trustedFingerprint,
  });
});
```

Four things in that source are load-bearing and must not change:

- `consume(pid)` — the key is the proposal id alone. The money door spends a
  proposal once, forever.
- `evaluatePayment(...)` — the tool is bound to the door and the mandate's own
  `max_spend` and `currencies` are applied to the amount about to be charged.
- The tier and the amount are read from `body.args` *after* the gate permitted
  it, and the gate has already proved `args` is the digest the signed proposal
  describes. A price chosen by the caller is not permitted; a price proven by a
  signature is.
- The Stripe session is created last, after both gates. A refusal creates
  nothing.

## 6. The conformance door — the two changes it needs

```ts
// Before: the key was the proposal id alone, so the published example's one
// valid case was spent for good. After: the key carries the session, so the
// example stays runnable by anyone, and the session is required, so nobody
// reads "no session, always allowed" as the guarantee.
function durableReplay(session: string) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  return {
    async consume(pid: string) {
      const { error } = await db.from("gate_replay").insert({
        replay_key: `conformance:${session}:${pid}`,
        scope: "conformance",
      });
      if (!error) return true;
      if (error.code === "23505") return false;
      throw new Error("replay_store_unavailable");
    },
  };
}

function getConformanceGate(session: string | null) {
  if (!session) throw new Error("session_required");
  return createReceiverGate({
    resolveKey: conformanceKeys,
    mode: "enforce",
    replayStore: durableReplay(session),
  });
}
```

And the request handler answers `400 session_required` when the session is
missing. The conformance door still creates no Stripe session and still moves
no money; that is what makes a re-runnable example safe to publish.

## 7. The table — add it to the repository

The table is live but untracked. Add this file as
`supabase/migrations/20261125000000_gate_replay.sql`:

```sql
-- The durable replay store for the receiver gate. A proposal id is spent once.
create table if not exists public.gate_replay (
  replay_key text primary key,
  scope text,
  created_at timestamptz not null default now()
);

create index if not exists gate_replay_created_at_idx on public.gate_replay (created_at);
```

Then apply it. Until it is in the repository, a restore of this project comes
back without the table and the gate cannot enforce.

## 8. The secrets

| Secret | Value | Who sets it |
|--------|-------|-------------|
| `PSI_GATE_KEYRING` | JSON, `{"kid": "<base64 SPKI>"}` for every signer the gate must trust | Master |
| `PSI_GATE_MODE` | `shadow` first, then `enforce` | Master |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA` | the price ids | Master |

**One command prints the exact value to paste.** In the package repo:

```
node scripts/keyring-secret.mjs
```

It prints the JSON to paste into `PSI_GATE_KEYRING` and the fingerprint to
check against. The keys are public keys only, from the signed example file; the
private halves were generated for that file and discarded when it was written,
so nothing else can be signed with them.

**Regenerating the example makes new keys.** The example's keyring is created
per run. If the file is regenerated, the secret must be re-pasted or the door
refuses every request from the new file with `key_unresolved`. The door reports
the fingerprint of the keyring it trusts; the file carries `keyring_fingerprint`.
Equal fingerprints mean the door trusts exactly the published keyring.

Two keyrings exist on purpose. The conformance harness trusts the keyring in
its own copy of the example file. The money door trusts `PSI_GATE_KEYRING`.
Today, with no production signers yet, the same test keyring goes in both. When
the real signers exist, the secret is replaced with them and the published
example then tests the conformance harness only — which is the intended end
state.

## 9. The acceptance checks — every one must pass

The example is live at
`https://www.ai-governance-standard.com/conformance/agent-03-example.json`
and ships in the npm package. Its `payment` section holds one permitted
payment and seven refusals; every reason in it was measured, not asserted.

1. **Fingerprint.** GET the agent door. Expect `live_mode` and a
   `keyring_fingerprint` equal to the file's `keyring_fingerprint`.
2. **Permit.** POST `payment.allow.request` to the agent door. Expect 200, a
   `permit` whose `decision` is the decision id, `tier` `pro`,
   `amount_minor` 1100, and a Stripe session URL.
3. **Replay, same body.** POST the same body again. Expect **403 `replay`**
   and no session URL.
4. **Replay, new session.** POST the same body under a different session id.
   Expect **403 `replay`** again. This is the check the money door must never
   fail.
5. **Another tool.** POST `payment.refusals` → "a payment made through another
   tool". Expect 403 `tool_not_permitted`.
6. **Over the mandate's limit.** Expect 403 `over_spend`.
7. **Tier not sold.** Expect 403 `tier_not_permitted`.
8. **Currency not permitted.** Expect 403 `currency_not_permitted`.
9. **No mandate.** Expect 403 `missing_authority`.
10. **Forged signature.** Change one byte of the decision signature. Expect 403
    `signature_invalid`.
11. **Refusal creates nothing.** Every 403 body must contain no `url`, no
    session id and no Stripe reference. A refusal that still creates a session
    is a failed gate.
12. **Human door untouched.** `create-checkout` still answers 200 for a
    signed-in buyer and still creates a Stripe session. If this check fails,
    the gate has been put in front of the human door and every purchase is now
    refused.
13. **Conformance door, runnable twice.** With a session id, post the example's
    `allow.request`: 200. Post it again in the same session: 403 `replay`. Post
    it again under a new session: 200. Without a session: 400
    `session_required`.

## 10. The copy that goes with it

The recipe page links the two conformance files, which are live and reachable
today. The breach pack shows whether an action was permitted or refused, the
reason, every check, and a fingerprint, with JSON and PDF downloads.

One sentence in the breach pack's own words: the conformance door is a test
bed, and a permit from it is a test result, not authority to spend money.

## 11. What stays out of the site for now

- The gate's address stays off the public site until `PSI_GATE_KEYRING` exists
  and the door answers in `enforce` mode. The address of a dormant door is a
  promise the door cannot keep.

# The agent payment gate — make the gate load-bearing

Measured 25 November 2026 against `kawal393/APEX-PSI` @ main and the live site.
Every number below was measured; nothing here is estimated.

## 1. What I measured

**The gate answers, but nothing calls it.** Ten functions in the live repo that
move money or commit an action carry zero references to it. Grep for
`machine-checkout`, `psi-agent`, `createReceiverGate`, `permit`, `PSI_GATE`:

| Function | What it does | Gate references |
|----------|--------------|-----------------|
| `create-checkout` | starts a Stripe subscription session | 0 |
| `stripe-webhook` | Stripe events in | 0 |
| `sync-subscription` | writes the subscription row | 0 |
| `create-api-key` | issues an API key | 0 |
| `api-keys` | lists and revokes keys | 0 |
| `authorize` | authorises a request | 0 |
| `commit-action` | commits an action | 0 |
| `challenge-action` | issues a challenge | 0 |
| `prove-action` | proves an action | 0 |
| `notarize` | writes a record to the ledger | 0 |

A gate that no money path consults refuses nothing that matters. It is a
measuring instrument, not a lock.

**A replay is accepted under a new session id.** Live, today:

```
POST ?conformance=agent-03&session=A   -> 200  ok=true    (permit issued)
POST ?conformance=agent-03&session=A   -> 403  reason=replay
POST ?conformance=agent-03&session=B   -> 200  ok=true    <-- same signed proposal, accepted again
```

`npm apex-psi-mcp@1.3.0` keys its replay store on the proposal id alone
(`replayStore.consume(request.proposal.pid)` — pinned by
`scripts/agent-gate-check.mjs`, case 6b). The edge function prefixes the key
with a scope, `conformance:${session}:${pid}`, so the same proposal is fresh
under a new prefix. The session prefix was added to keep the example
re-runnable. It also makes the guarantee weaker than the one the package
offers, and a stranger running the example twice gets two permits for one
signed proposal.

**The replay table is not in the repository.** The `gate_replay` table exists in
the live database — the `23505` duplicate is the only reason a replay is
refused — but it is in none of the 68 files in `supabase/migrations`. A
restored or fresh database has no table, which is exactly why the function
answers `enforce_unavailable` and refuses to enforce.

**What is already true and should not be touched:**

- `/conformance/agent-03.json` and `/conformance/agent-03-example.json` are
  live and return 200 with the right bytes.
- The `-03` draft, our copy, the registry copy and its fingerprint are on the
  site, and the Agent Payment Recipe is in the nav.
- The gate function itself is correct: 18 of 18 signed cases answered as
  recorded, and the vendored gate code is byte-identical to the npm package
  apart from a header comment that pins the commit.
- The gate address is printed nowhere on the site, and `/breach-pack` does not
  exist yet (0 hits in the 2.75 MB live bundle). Keep the address off the site
  until the keyring secret exists.

## 2. The rule — two doors, never merged

**The human door stays exactly as it is.** `create-checkout` is a person
clicking a button while signed in. Its permission is the session. If the
receiver gate stood in front of it, every purchase would be refused, because
no mandate exists for a human click and no human will ever produce one. That
would kill the revenue leg to secure nothing. Do not put the gate there.

**The agent door is new, and it is the only path an agent may use to start a
payment.** It asks the receiver gate first. If the gate refuses, no payment
session is created. The amount, the currency and the tier come from the
*signed* proposal — the gate recomputes the argument digest and compares it —
never from an unsigned field in the request body.

An agent that cannot produce a mandate, a proposal and a decision does not
get to spend money. That is the product.

## 3. The function — paste this

Create `supabase/functions/agent-checkout/index.ts`. The gate code is already
vendored at `supabase/functions/_shared/psi-agent/receiver.ts`; copy it
unchanged, the same way `machine-checkout` does it.

```ts
// agent-checkout — the agent door. The receiver gate is consulted first, and
// the Stripe session is created only if the gate permits the exact action.
//
// The human door (create-checkout) is untouched: a person's signed-in session
// is that permission. This door exists for agents, which must carry a signed
// mandate, a signed proposal and a signed decision.
import { createPublicKey, type KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReceiverGate, type ReceiverGate } from "../_shared/psi-agent/receiver.ts";
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
const TIERS: Record<string, { priceId: string; label: string; maxMinor: number }> = {
  pro: { priceId: Deno.env.get("STRIPE_PRICE_PRO") ?? "", label: "Pro", maxMinor: 200000 },
  ultra: { priceId: Deno.env.get("STRIPE_PRICE_ULTRA") ?? "", label: "Ultra", maxMinor: 2000000 },
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

// Durable replay store. The key is the PROPOSAL ID ALONE — no session, no
// scope. A proposal is spent once, on every instance, forever. Prefixing the
// key with anything lets the same signed proposal through again under a new
// prefix, which is the replay this store exists to refuse.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);

  if (req.method === "GET") {
    return json({
      profile: "PSI-ACT/1",
      door: "agent-checkout",
      live_mode: Deno.env.get("PSI_GATE_KEYRING") ? (Deno.env.get("PSI_GATE_MODE") ?? "shadow") : "dormant",
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
    gate ??= createReceiverGate({
      resolveKey: keyringFrom(JSON.parse(ringRaw)),
      mode: (Deno.env.get("PSI_GATE_MODE") ?? "shadow") === "enforce" ? "enforce" : "shadow",
      replayStore: durableReplay(),
    });
  } catch {
    return json({ ok: false, reason: "keyring_misconfigured" }, 500);
  }

  // The gate decides. Everything below it runs only on a permit.
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

  // The tier and the amount come from the SIGNED proposal, not from the body.
  const args = (body.args ?? {}) as { tier?: string; amount_minor?: number };
  const tier = TIERS[String(args.tier ?? "")];
  if (!tier || !tier.priceId) return json({ ok: false, refused: true, reason: "tier_not_permitted" }, 403);
  const amount = Number(args.amount_minor ?? 0);
  if (!Number.isInteger(amount) || amount <= 0 || amount > tier.maxMinor) {
    return json({ ok: false, refused: true, reason: "over_spend" }, 403);
  }

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
    permit: result.permit,
    header: result.permit?.header,
  });
});
```

Two things in that source are load-bearing and must not be changed:

- `consume(pid)` — the key is the proposal id alone. See the case above.
- The tier and the amount are read from `body.args` *after* the gate permitted
  it, and the gate has already proved that `args` is the digest the signed
  proposal describes. A price chosen by the caller is not permitted; a price
  proven by a signature is.

## 4. The table — add it to the repository

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

## 5. The secrets

| Secret | Value | Who sets it |
|--------|-------|-------------|
| `PSI_GATE_KEYRING` | JSON, `{"kid": "<base64 SPKI>"}` for every signer the gate must trust | Master, in the project secrets |
| `PSI_GATE_MODE` | `shadow` first, then `enforce` | Master |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA` | the price ids | Master |

Never write a key into the repository. The keyring holds public keys only, and
the project secret is where they belong.

## 6. The acceptance checks — every one must pass

Run the signed example's own cases against the new door. The example is live
at `https://www.ai-governance-standard.com/conformance/agent-03-example.json`
and ships in the npm package.

1. **Permit.** POST `allow.request` with a body containing the envelope,
   mandate, proposal, decision, `tool`, `args` and `actorKid`. Expect 200, a
   permit whose `decision` is the decision id, and a Stripe session URL.
2. **Replay, new session.** POST the same body again with a different session
   id. Expect **403 `replay`**, and no session URL. This check fails today and
   is the reason the key must be the proposal id alone.
3. **Replay, same session.** Expect 403 `replay` again.
4. **Forged signature.** Change one byte of the decision signature. Expect
   403 `signature_invalid` and no session URL.
5. **Over spend.** Ask for an amount above the mandate's `max_spend`. Expect
   403 `over_spend` and no session URL.
6. **Wrong currency.** Expect 403 `currency_not_permitted`.
7. **Scope.** Ask for a tool the mandate does not list. Expect 403
   `scope_not_permitted`.
8. **Refusal creates nothing.** Every 403 response must contain no
   `url`, no session id and no Stripe reference. A refusal that still creates
   a session is a failed gate.
9. **Human door untouched.** `create-checkout` still answers 200 for a signed-in
   buyer and still creates a Stripe session. If this check fails, the gate has
   been put in front of the human door and every purchase is now refused.

## 7. The copy that goes with it

The Agent Payment Recipe page should link the two conformance files, which are
live and reachable today but linked from nowhere:

- `/conformance/agent-03.json` — the frozen contract
- `/conformance/agent-03-example.json` — one signed run and seventeen refusals

One line each, with what the reader gets for the download. A visitor who never
clones the repository should be able to check the gate in two minutes.

## 8. What stays out of the site for now

- The gate's address stays off the public site until `PSI_GATE_KEYRING` exists
  and the door answers in `enforce` mode. The address of a dormant door is a
  promise the door cannot keep.
- `/breach-pack` is the next page. When it exists it must say what a breach
  pack is in one sentence, from the same measured facts as this document.

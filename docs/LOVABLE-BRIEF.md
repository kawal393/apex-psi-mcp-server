# Lovable brief — the receiver gate on `/machine-checkout`, and `/breach-pack`

Paste this whole file to the Lovable agent working on the APEX PSI project
(`kawal393/APEX-PSI`, live at https://www.ai-governance-standard.com).

## 1. What already exists, and where it lives

The portable core is the npm package `apex-psi-mcp`
(https://github.com/kawal393/apex-psi-mcp-server). It carries three new entry
points that did not exist in the published 1.2.2:

| Import | What it is |
|---|---|
| `apex-psi-mcp/agent` | the contract: types, canonical signed bytes, statement digests, signature verification, exact decimal comparison, action-chain walking, Merkle inclusion check |
| `apex-psi-mcp/receiver` | the gate that refuses an action nobody permitted |
| `apex-psi-mcp/sender` | the wrapper that seals before the action and binds the settlement to the decision |

The npm registry still serves 1.2.2, which does not carry these three entry
points. Install straight from the repository, which carries the same code and
the same tests:

```
npm i github:kawal393/apex-psi-mcp-server
```

When a release carrying them reaches npm, the install becomes:

```
npm i apex-psi-mcp@<version>
```

The frozen contract is `conformance/agent-03.json` in that repository. It
follows `draft-singh-psi-agent-03` (PSI-ACT/1).

## 2. The shape of the contract

A run is four signed statements and one envelope that names them:

```
mandate   who is allowed to do what, how much, until when
proposal  what the agent wants to do, bound to the mandate and to the arguments
decision  allow | deny | require_human, signed by a key that is not the acting key
envelope  names the mandate, the proposal, the decision, the action chain and the settlement
```

Every statement carries `ver`, `run`, its own identifier (`mid`, `pid`, `did`,
`sid`), `alg`, `kid` and `sig`. The identifier is the SHA-256 of the statement's
signed bytes: canonical JSON with `sig` and the identifier removed (and
`anchor` removed for the envelope). Amounts are decimal strings and are
compared exactly — never as floating point. Assets are compared as exact,
case-sensitive strings.

## 3. `/machine-checkout` — the receiver

`/machine-checkout` is where an agent asks the site to move money. The gate
runs on the server, in the edge function that performs the side effect, never
in the browser.

```ts
import { createReceiverGate } from "apex-psi-mcp/receiver";

const gate = createReceiverGate({
  resolveKey: (kid) => keyring[kid],   // kid -> Ed25519 public key (SPKI base64)
  mode: "enforce",                      // "shadow" while you wire it up
  now: () => new Date(),
});

export default async function machineCheckout(request: Request) {
  const body = await request.json();

  const result = await gate.run(
    {
      envelope: body.envelope,
      mandate: body.mandate,
      proposal: body.proposal,
      decision: body.decision,
      settlement: body.settlement,
      actions: body.actions ?? [],
      tool: "checkout",
      args: body.args,
      actorKid: body.actorKid,
    },
    () => performCheckout(body.args),
  );

  return Response.json({ ok: true, permit: result.permit });
}
```

`gate.run` seals nothing and moves nothing until the request is permitted. When
the request is refused it throws `ReceiverRefusedError` and `performCheckout`
is never called. Catch it and answer with the reason code, not a stack trace:

```ts
catch (error) {
  if (error?.name === "ReceiverRefusedError") {
    return Response.json(
      { ok: false, refused: true, reason: error.reason },
      { status: 403 },
    );
  }
  throw error;
}
```

The reason codes are stable and machine-readable:

```
missing_authority        no mandate, no proposal or no decision
decision_not_allow       the decision said deny or require_human
outside_window           the mandate's not_before / not_after does not cover now
over_spend               the amount is above the mandate's limit
currency_not_permitted   the asset is not one the mandate permits
over_actions             the mandate's action count is used up
replay                   this proposal was already accepted once
args_mismatch            the arguments differ from the ones the proposal described
scope_not_permitted      the tool is not in the mandate's scope
signature_invalid        a signature does not verify
key_unresolved           the key id cannot be resolved
algorithm_unavailable    the named algorithm is not implemented here
decision_key_is_action_key          the decision key is also the acting key
mandate_key_is_decision_key         the mandate key signed the decision
mandate_key_is_action_key           the mandate key is also the acting key
run_mismatch, proposal_mid_mismatch, decision_pid_mismatch,
settlement_did_mismatch, denied_but_executed, id_mismatch,
envelope_ref_mismatch, held_but_envelope_says_absent, chain_broken
```

## 4. `/breach-pack` — the evidence bundle for a refused action

When the gate refuses, the site must be able to show why, in a form a stranger
can check.

`/breach-pack` takes the refused request plus the report the gate produced and
renders:

1. the envelope and every statement the site held, verbatim;
2. the reason code and the check-by-check result (`ok`, `absent`, `invalid`,
   `algorithm_unavailable`, `key_unresolved`, `not_anchored`);
3. the identifiers, so anyone can recompute them: the signed bytes are the
   canonical JSON of the statement minus `sig` and minus its own identifier;
4. the SHA-256 of the refusal itself, sealed through the notary, so the refusal
   is on the same ledger as the actions.

Rules for the bundle:

- no private key, no credential, no card number, no request body that carries
  personal data — the reason codes and the digests are enough;
- nothing in the copy may say a seal proves the claim is true. A seal proves a
  record was made at a time and has not changed since. Integrity, not truth;
- settlement statuses stay distinct on the page: `authorised` means a limit was
  reserved, not that money moved.

## 5. Keys, environment, and what must never be committed

- The receiver holds **public** keys only. One entry per `kid`, base64 SPKI,
  read from the server environment (a Supabase edge function secret, not a
  `VITE_` variable, because `VITE_` ships to the browser).
- No private key in the repository, in the client bundle, in a screenshot, or
  in any prompt. The signing key stays with whoever signs the mandate.
- The acting key, the decision key and the mandate key are three different
  keys. The gate refuses a run where they are not.

## 6. The order of work

1. Install the package and import `apex-psi-mcp/receiver` in the checkout edge
   function.
2. Run the gate in `shadow` mode first: it reports every refusal and lets the
   action through. Wire the log so each refusal is visible.
3. Flip to `enforce` only after shadow has shown the refusals are the ones you
   expect.
4. Build `/breach-pack` from the report the gate already produces.
5. Add a route or script that serves the conformance file
   (`conformance/agent-03.json`) so the refusal vocabulary is discoverable
   without cloning the repository.

## 7. Acceptance checklist — five minutes, by eye

| # | Do this | You must see |
|---|---|---|
| 1 | Post a checkout request with no mandate | `403` and `reason: missing_authority`; no charge, no order row |
| 2 | Post a request whose mandate expired | `reason: outside_window`; nothing charged |
| 3 | Post an amount above the mandate limit | `reason: over_spend`; nothing charged |
| 4 | Post the same valid request twice | first succeeds, second is `reason: replay` |
| 5 | Change one character of a signature | `reason: signature_invalid` |
| 6 | Post a decision signed by the acting key | `reason: decision_key_is_action_key` |
| 7 | Read the Stripe dashboard after 1–6 | no charge and no order row from any refused request |
| 8 | Open `/breach-pack` for a refusal | the envelope, the statements, the reason code and the check list, and no secret in the bundle |

## 8. What not to do

- Do not run the gate in the browser. A gate the client can switch off is not a
  gate.
- Do not weaken the gate to make a flow work. If it refuses something valid,
  fix the request or the mandate; do not lower the check.
- Do not describe the gate as proving anything is true. It proves that a
  permitted decision existed for a specific action, and that the action did not
  happen without it.
- Do not add a "trust us" badge. The receipt and the refusal code are the
  proof, and they are checkable by a stranger.

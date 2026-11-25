<p align="center"><img src="https://raw.githubusercontent.com/kawal393/apex-psi-mcp-server/main/assets/apex-psi-icon.png" alt="APEX PSI mark: a check inside a hexagonal seal" width="96" height="96"></p>

# APEX PSI MCP server

[![APEX PSI MCP server](https://mcprush.com/badge/apex-psi-mcp/card.svg)](https://mcprush.com/to/apex-psi-mcp?ref=badge)

> **Apex PSI is not a tool and not a product. It is the verification substrate — the layer beneath proof. It does not judge. It does not certify. It only remembers.** This server is one application built on that layer.

Machine-readable setup for agents and directory scrapers: [llms-install.md](https://github.com/kawal393/apex-psi-mcp-server/blob/main/llms-install.md).

One config line gives any MCP-capable agent (Claude, Cursor, Qoder, Cline, Windsurf, and the rest) five evidence tools: `seal`, `verify`, `anchor`, `cite`, `verify_chain`.

A seal records the SHA-256 hash of a decision, document or artefact in a public append-only ledger and returns a receipt. Anyone can look that hash up again — free, forever, with no account, no key and no cooperation from us.

**What a receipt proves:** that this exact content existed at this timestamp, and has not changed since.
**What it never proves:** that the content is true. A seal is an audit trail, not a verdict.

## Tools

| Tool | What it actually does |
|------|-------------|
| **seal** | Writes the record's SHA-256 hash to the ledger and returns a receipt carrying an Ed25519 signature over the Merkle leaf, an ML-DSA-65 post-quantum signature, and — when a slot is available — an LMS-W4-SHA256 signature. The receipt's own `algorithm` field states which of those it got. |
| **verify** | Looks a hash (or a whole receipt) up in the ledger and reports whether it is present and unchanged. Integrity, not truth. |
| **anchor** | Reads the Bitcoin/OpenTimestamps anchoring state of the ledger's pending Merkle roots. Pass `action: "anchor"` explicitly to request that pending roots be submitted — an anchor is confirmed only when a real block is found. |
| **cite** | Turns a receipt into a citation (APA, BibTeX, MLA) that points at a public, independently checkable record. |
| **verify_chain** | Recomputes each hash's presence and Merkle continuity across a chain of receipts. A recomputation result, not an opinion. |

## Install

Add to your MCP client config:

```json
{
  "mcpServers": {
    "apex-psi": {
      "command": "npx",
      "args": ["-y", "apex-psi-mcp"]
    }
  }
}
```

Or locally: `npm install apex-psi-mcp`.

## Prove it works in two minutes

1. Ask the agent: *"Seal the sentence 'hello psi' with APEX PSI."*
2. Take the `decision_hash` from the receipt and paste it into the public verifier:
   <https://www.ai-governance-standard.com/verify>

If the site returns the record, the seal is real. You never had to trust this server, our npm
package, or our word — which is the entire point of the protocol.

## Limits, stated plainly

Free use needs no account and no key: **20 operations per minute and 100 per day**, enforced per
server instance — a flood guard rather than a subscription quota. Above that, an API key raises the
ceiling; capacity is priced, **the finding never is**. Verification itself is unlimited and free:
running the verifier locally costs nothing at all —
[`apex-psi-verifier`](https://www.npmjs.com/package/apex-psi-verifier) on npm,
[`psi-verifier`](https://pypi.org/project/psi-verifier/) on PyPI.

## Make the seal unavoidable: the execution gate

The five tools above are available to an agent, but nothing in MCP makes an agent call them. An
agent that never calls `seal` leaves no gap in the ledger — the ledger stays complete and says
nothing about that action. If your agent can move money, send a request or write to a system, that
gap is the whole problem.

So this package also ships a **gate**: a small module that seals first and acts second, inside the
process that performs the side effect.

```js
import { createGate, createNotarySealer } from "apex-psi-mcp/gate";

const gate = createGate({ sealer: createNotarySealer(), label: "payments-bot" });

const { value, receipt } = await gate.run(
  () => payments.transfer({ amount: 500, to: "acct-42" }),
  { tool: "transfer", amount: 500, to: "acct-42" },
);
```

If the seal fails, `payments.transfer` is never called — the gate throws `GateClosedError`. A gate
with no sealer configured refuses every action, because a gate nobody configured must not look like
a gate that is working.

What the gate does and does not do, stated plainly:

- It enforces the **order**: the receipt exists before the action runs.
- It cannot reach a process that never routes its side effect through it.
- It cannot attest what a model did inside a GPU; the receipt covers the action as you declared it
  and the order in which the two happened.
- `createLocalSealer()` seals into an in-process hash chain with no network and no account — a local
  permit, not a ledger receipt. `createNotarySealer()` returns a ledger receipt.

The same gate exists in the Python runtime as `apex_psi.ExecutionGate`. The two implementations
fingerprint the same bytes: `fingerprint({"b":1,"a":[1,2],"c":"x"})` is
`95c12ab4ca0e8f3c485ea1b1b1a2b24976d07180baf5ecad0d81b5bbaf07532b` in both, and a CI check on each
side pins that number.

## The receiver gate: refusing an action that was not permitted

The gate above lives on the sender's side, and it is optional: an agent that
never calls `seal` leaves no gap in the ledger, and the ledger stays complete
and says nothing about that action. The receiver gate is the half that is not
optional, because it sits in the process that performs the side effect.

```js
import { createReceiverGate } from "apex-psi-mcp/receiver";

const gate = createReceiverGate({
  resolveKey: (kid) => keyring[kid],   // kid -> Ed25519 public key
  mode: "enforce",                      // "shadow" observes without blocking
});

const result = await gate.authorize({
  envelope,
  mandate,
  proposal,
  decision,
  tool: "transfer",
  args: { amount: "10.00", to: "acct-42" },
  actorKid: "agent-key",
});
```

`authorize` returns `{ allowed, enforced, wouldAllow, reason, report, permit }`.
In `enforce` mode a refused action never runs: `gate.run(request, fn)` throws
`ReceiverRefusedError` and `fn` is not called. `reason` is a stable code —
`missing_authority`, `decision_not_allow`, `outside_window`, `over_spend`,
`over_actions`, `replay`, `args_mismatch`, `scope_not_permitted`,
`currency_not_permitted`, `settlement_did_mismatch`, `signature_invalid`,
`key_unresolved`, `algorithm_unavailable`, `decision_key_is_action_key`,
`mandate_key_is_decision_key`, `mandate_key_is_action_key` — and the report
carries the reason codes of `draft-singh-psi-agent-03` for the checks the
contract defines.

`shadow` mode turns the gate on without breaking anything: it reports the same
reasons and lets the action through, recording what would have been refused.
It does not refuse.

What the receiver recomputes, from `draft-singh-psi-agent-03`:

- The mandate, proposal, decision and envelope each recompute to the identifier
  they carry, and each signature verifies under the key it names. An algorithm
  this server does not implement is reported, never guessed at.
- Every statement carries the run identifier of the envelope. The proposal
  names the mandate, and the decision names the proposal.
- Amounts are decimal strings compared exactly — never as floating point — and
  the asset is compared as an exact, case-sensitive string.
- The mandate's window, action count and spend limit hold.
- A proposal already accepted once is a replay and is refused.
- The acting key is neither the decision key nor the mandate key.

Settlement statuses stay distinct. `authorised` records that a limit was
reserved; it does not record that money moved, and nothing here reports it as
money moved.

## The sender: seal first, act second, bind the settlement

`createMandatedSender` wraps an action in the mandate that permitted it:

```js
import { createNotarySealer } from "apex-psi-mcp/gate";
import { createMandatedSender } from "apex-psi-mcp/sender";

const sender = createMandatedSender({
  mandate,
  proposal,
  decision,
  sealer: createNotarySealer(),
  actorKid: "agent-key",
});

const { value, receipt, actionRecord, chainRoot } = await sender.execute(
  "transfer",
  { amount: "10.00", to: "acct-42" },
  () => payments.transfer({ amount: "10.00", to: "acct-42" }),
);
```

The sender refuses arguments the proposal never described, a decision that did
not say `allow`, and a tool outside the mandate's scope. The seal happens
before the action, so a failed seal leaves the action uncalled. A retry of the
same proposal runs the action once. `bindSettlement` refuses a settlement whose
decision does not match, whose currency the mandate does not permit, or whose
amount exceeds the mandate's limit.

## The money rules of a payment door

The receiver gate checks a spend limit only against a settlement, and a
payment request carries no settlement. A limit belongs to the mandate, so
applying it to the amount about to be charged is a separate rule, and it
lives in its own module so the door and its tests run the same code:

```ts
import { evaluatePayment } from "apex-psi-mcp/payment";

const verdict = evaluatePayment({ tool, args, mandate }, tiers, {
  expectedTool: "checkout",
});
```

It refuses a request that names another tool, a tier the server does not sell,
an amount that is not minor units, an amount above the tier's ceiling or above
the mandate's `max_spend`, and a currency the mandate does not permit. The
comparison is exact decimal: `1101` is over `11.00` and `1099` is under it.

## Prove the gate in two commands

```
npm run check:agent     # the built receiver refuses every case it must refuse
npm run check:parity    # Node and Python sign the same bytes
```

`conformance/agent-03.json` holds the frozen contract: the profile, the signed
bytes rule, the decimal rule, and the refusal cases the suite proves.

`conformance/agent-03-example.json` holds one signed run you can verify
yourself: the statements, the public keyring, one request that must be
permitted, and seventeen requests that must each be refused for a stated reason.
Those reasons were measured against the built gate, and
`npm run check:example` fails if the gate ever answers differently. The keys in
that file are test keys, made for the file and discarded when it was written;
they sign nothing outside the file.

It also carries a `payment` section: one permitted payment, with the tier and
the amount in it, and seven refusals a payment door must make. Each one names
whether the gate refuses it or the door's own money rules do, so a reader can
tell the two halves apart. `npm run check:payment` proves both halves against
the built modules.

## Configuration

Environment variables (both optional):

- `APEX_API_BASE` — override the notary endpoint. Default:
  `https://qhtntebpcribjiwrdtdd.supabase.co/functions/v1`
- `APEX_API_KEY` — raises the daily ceiling for a workload. Never required to seal or verify.

## What this server does not do

- It does not store your content. Only the hash leaves your machine.
- It does not certify, grade, score or approve anything.
- It exposes no edit or delete path: the interface this server uses is write-once sealing plus
  read-only lookup. The check that matters is yours to run — re-verify any receipt at any time, and
  any change shows up as a failed lookup.
- It is not a legal opinion, and no court has agreed to accept a receipt in advance.

## Links

- **Protocol and standard:** <https://www.ai-governance-standard.com>
- **Public verifier:** <https://www.ai-governance-standard.com/verify>
- **Machine-readable summary for AI answers:** <https://www.ai-governance-standard.com/llms.txt>
- **npm:** <https://www.npmjs.com/package/apex-psi-mcp>

## License

MIT

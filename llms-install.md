# APEX PSI MCP — install instructions for AI agents and MCP clients

Package: `apex-psi-mcp` on npm (current: 1.3.0) — stdio, no account, no key.
Source: https://github.com/kawal393/apex-psi-mcp-server
Registry name: `io.github.kawal393/apex-psi-mcp`
Site: https://www.ai-governance-standard.com
License: MIT

## What it is

An append-only evidence ledger for AI records. It gives an agent five tools:

| Tool | What it does |
|------|--------------|
| `seal` | Writes the SHA-256 hash of a decision, document or artefact to the public ledger and returns a signed receipt. |
| `verify` | Looks a hash or a receipt up in the ledger and reports whether it is present and unchanged. |
| `anchor` | Reads the Bitcoin / OpenTimestamps anchoring state of pending Merkle roots. |
| `cite` | Turns a receipt into an APA, BibTeX or MLA citation pointing at a public record. |
| `verify_chain` | Recomputes presence and Merkle continuity across a chain of receipts. |

A receipt proves the content existed at a timestamp and has not changed since. It never proves the
content is true. A seal is an audit trail, not a verdict.

## Install — stdio (recommended, no account)

Any MCP client that runs a local command:

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

Claude Desktop: put that block in `claude_desktop_config.json`.
Cursor / VS Code / Windsurf / Cline / Qoder: same object in the client's MCP settings.
CLI form: `npx -y @modelcontextprotocol/inspector npx -y apex-psi-mcp` to poke it by hand.

Optional environment variables (both optional, never required to seal or verify):

- `APEX_API_BASE` — override the notary base URL. Default: `https://qhtntebpcribjiwrdtdd.supabase.co/functions/v1`
- `APEX_API_KEY` — raises the daily ceiling for a workload. It cannot change what a receipt claims.

Free tier without any key: 20 operations per minute, 100 per day. Verification is unlimited and free.

## Install — hosted (Streamable HTTP + OAuth)

For clients that connect to a remote MCP server instead of spawning one:

```json
{
  "mcpServers": {
    "apex-psi-remote": {
      "type": "streamable-http",
      "url": "https://qhtntebpcribjiwrdtdd.supabase.co/functions/v1/mcp"
    }
  }
}
```

This door is OAuth-protected and exposes a different, read-oriented tool set: `seal`, `verify_hash`,
`anchor_status`, `list_attestations`, `ledger_stats`, `protocol_info`. An anonymous request returns
`401` with a `WWW-Authenticate` challenge — that is the server asking you to sign in, not a failure.

## Make the seal unavoidable — the execution gate

The five tools are available to an agent, but nothing in MCP makes an agent call them. An agent
that never calls `seal` leaves no gap in the ledger. If your agent can move money, send a request
or write to a system, this package also ships a gate that seals first and acts second, inside the
process that performs the side effect:

```js
import { createGate, createNotarySealer } from "apex-psi-mcp/gate";

const gate = createGate({ sealer: createNotarySealer(), label: "payments-bot" });
const { value, receipt } = await gate.run(
  () => payments.transfer({ amount: 500, to: "acct-42" }),
  { tool: "transfer", amount: 500, to: "acct-42" },
);
```

If the seal fails the transfer is never called. A gate with no sealer refuses every action. The
Python runtime has the same gate: `apex_psi.ExecutionGate`.

The gate enforces the order. It cannot reach a process that never routes its side effect through
it, and it cannot attest what a model did inside a GPU.

## The receiver gate — refuse an action nobody permitted (1.3.0)

A second gate, on the other side: the process that performs the side effect asks "was this
action permitted?" and refuses the answer it was not given. It is the same idea from the
receiving end, and it is what a payment or admin API should run.

```js
import { createReceiverGate } from "apex-psi-mcp/receiver";

const gate = createReceiverGate({
  resolveKey: (kid) => keyring[kid],   // kid -> Ed25519 public key
  mode: "enforce",                      // "shadow" while you wire it up
});

const result = await gate.run(
  { envelope, mandate, proposal, decision, settlement, actions, tool: "checkout", args, actorKid },
  () => performCheckout(args),
);
```

`gate.run` refuses before `performCheckout` is called, and answers with a stable reason code
(`missing_authority`, `decision_not_allow`, `over_spend`, `currency_not_permitted`,
`over_actions`, `replay`, `args_mismatch`, `scope_not_permitted`, `outside_window`,
`signature_invalid`, `key_unresolved`, `algorithm_unavailable`, `decision_key_is_action_key`,
`mandate_key_is_decision_key`, `mandate_key_is_action_key`, and the binding and chain codes).
Three more entry points come with it: `apex-psi-mcp/agent` (the contract, types and
verification) and `apex-psi-mcp/sender` (seal first, act second, bind the settlement).

A frozen contract and a signed test run ship with the package, in `conformance/`:
`agent-03.json` (the rules) and `agent-03-example.json` (one signed run, plus 17 requests that
must each be refused, each with the reason). The reasons were measured against the built code.

## Accept it works in two minutes

1. Ask the agent: *"Seal the sentence 'hello psi' with APEX PSI."*
2. Take the `decision_hash` from the receipt and paste it into https://www.ai-governance-standard.com/verify

If the site returns the record, the seal is real. You did not have to trust this server, the npm
package, or our word.

## Verify without any server at all

The same check runs locally with no network and no account:
[`apex-psi-verifier`](https://www.npmjs.com/package/apex-psi-verifier) on npm,
[`psi-verifier`](https://pypi.org/project/psi-verifier/) on PyPI.

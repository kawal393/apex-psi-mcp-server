# APEX PSI MCP server

> **Apex PSI is not a tool and not a product. It is the verification substrate — the layer beneath proof. It does not judge. It does not certify. It only remembers.** This server is one application built on that layer.

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

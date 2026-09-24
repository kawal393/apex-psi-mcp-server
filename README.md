# APEX PSI MCP Server

> **Apex PSI is not a tool and not a product. It is the verification substrate — the layer beneath proof. It does not judge. It does not certify. It only remembers.** This server is an application built on that layer.

Cryptographic truth infrastructure for AI agents.

One config line gives any MCP-capable AI agent (Claude, Cursor, Qoder, Cline, Windsurf, and more) five provenance tools: seal, verify, anchor, cite, verify_chain.

This server proves the existence and integrity of a record at a point in time. It does not judge the truth of a record's contents. It is an independent verification service, not advice.

## Tools

| Tool | Description |
|------|-------------|
| **seal** | Stamp a cryptographic receipt on content (SHA-256 + Ed25519 + post-quantum LMS-W4) |
| **verify** | Confirm a receipt's integrity (hash present in the append-only ledger) |
| **anchor** | Read Bitcoin anchoring status (default), or request anchoring of pending roots |
| **cite** | Generate a citation for a receipt (APA, BibTeX, MLA) |
| **verify_chain** | Independently verify a chain of receipts for integrity |

## Installation

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

Or install locally:

```bash
npm install apex-psi-mcp
```

## Configuration

Environment variables (optional):

- `APEX_API_BASE` — API endpoint (default: `https://apex-infrastructure.com/api`)
- `APEX_API_KEY` — API key for authenticated access

## Usage

Once installed, your AI agent can:

1. **Seal content** — "Seal this document with APEX PSI"
2. **Verify receipts** — "Verify this receipt against the ledger"
3. **Check anchoring** — "What is the Bitcoin anchor status of this seal?"
4. **Generate citations** — "Cite this receipt in APA format"
5. **Verify a chain** — "Independently verify this chain of receipts"

Every receipt carries a verify link to `https://apex-infrastructure.com/verify` — sealed arithmetic, public provenance.

## Links

- **Website:** https://apex-infrastructure.com
- **Public Verifier:** https://apex-infrastructure.com/verify
- **npm:** https://www.npmjs.com/package/apex-psi-mcp

## License

MIT

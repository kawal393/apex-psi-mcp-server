# APEX PSI MCP Server

Cryptographic truth infrastructure for AI agents.

One config line gives any MCP-capable AI agent (Claude, Cursor, Qoder, Cline, Windsurf, and more) five provenance tools: seal, verify, anchor, cite, audit.

## Tools

| Tool | Description |
|------|-------------|
| **seal** | Stamp a cryptographic receipt on content (SHA-256 + Ed25519) |
| **verify** | Verify a receipt is authentic |
| **anchor** | Anchor a receipt to Bitcoin via OpenTimestamps |
| **cite** | Generate a citation for a receipt (APA, BibTeX, MLA) |
| **audit** | Audit a chain of receipts for integrity |

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
2. **Verify receipts** — "Verify this receipt is authentic"
3. **Anchor to Bitcoin** — "Anchor this receipt to the Bitcoin blockchain"
4. **Generate citations** — "Cite this receipt in APA format"
5. **Audit chains** — "Audit this chain of receipts"

Every receipt carries a verify link to `https://apex-infrastructure.com/verify` — sealed arithmetic, public provenance.

## Links

- **Website:** https://apex-infrastructure.com
- **Public Verifier:** https://apex-infrastructure.com/verify
- **npm:** https://www.npmjs.com/package/apex-psi-mcp

## License

MIT

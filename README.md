# APEX PSI MCP Server

Cryptographic truth infrastructure for AI agents.

## What It Does

This MCP server provides 5 tools that let any AI agent (Claude, Cursor, Copilot, etc.) stamp cryptographic receipts on content, verify them, anchor them to Bitcoin, generate citations, and audit chains of receipts.

## Tools

| Tool | Description |
|------|-------------|
| **seal** | Stamp a cryptographic receipt on content (SHA-256 + Ed25519) |
| **verify** | Verify a receipt is authentic |
| **anchor** | Anchor a receipt to Bitcoin via OpenTimestamps |
| **cite** | Generate a citation for a receipt (APA, BibTeX, MLA) |
| **audit** | Audit a chain of receipts for integrity |

## Installation

### For AI Agents (MCP Clients)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "apex-psi": {
      "command": "npx",
      "args": ["-y", "@apex/psi-mcp-server"]
    }
  }
}
```

### For Developers

```bash
npm install @apex/psi-mcp-server
```

## Configuration

Set these environment variables:

- `APEX_API_BASE` — API endpoint (default: `https://sovereign-ai.services/api`)
- `APEX_API_KEY` — API key for authenticated access (optional)

## Usage

Once installed, your AI agent can:

1. **Seal content** — "Seal this document with APEX PSI"
2. **Verify receipts** — "Verify this receipt is authentic"
3. **Anchor to Bitcoin** — "Anchor this receipt to the Bitcoin blockchain"
4. **Generate citations** — "Cite this receipt in APA format"
5. **Audit chains** — "Audit this chain of receipts"

## Links

- **Website:** https://sovereign-ai.services
- **MCP Registry:** https://registry.modelcontextprotocol.io (search: apex-psi)
- **GitHub:** https://github.com/apex-psi/mcp-server
- **npm:** https://www.npmjs.com/package/@apex/psi-mcp-server

## License

MIT

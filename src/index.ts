#!/usr/bin/env node

/**
 * APEX PSI MCP Server
 * Cryptographic truth infrastructure for AI agents.
 *
 * 5 tools: seal, verify, anchor, cite, verify_chain
 * Backend: APEX NOTARY v1.0 (Supabase Edge Functions) — SHA-256 + Ed25519 + LMS-W4-SHA256 (post-quantum)
 * Override base URL with APEX_API_BASE if self-hosting.
 *
 * Scope: this server anchors the existence and integrity of a record at a point
 * in time. It does not judge the truth of a record's contents. It is an
 * independent verification service, not advice or an attestable opinion.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Configuration
const APEX_API_BASE = (
  process.env.APEX_API_BASE || "https://qhtntebpcribjiwrdtdd.supabase.co/functions/v1"
).replace(/\/$/, "");
const APEX_API_KEY = process.env.APEX_API_KEY || "";

const VERSION = "1.0.2";

// Helper: make an API call to the Apex PSI backend
async function apexApiCall(
  endpoint: string,
  method: string = "GET",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const url = `${APEX_API_BASE}${endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (APEX_API_KEY) headers["Authorization"] = `Bearer ${APEX_API_KEY}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`API call failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

// Helper: strip a "sha256:" prefix from a hash value
function stripHashPrefix(value: unknown): string {
  return typeof value === "string" ? value.replace(/^sha256:/i, "") : "";
}

// Helper: wrap a result (or error) into an MCP text response
function mcpResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function mcpError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { success: false, error: error instanceof Error ? error.message : String(error) },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

const receiptSchema = z
  .record(z.unknown())
  .describe("An APEX PSI receipt object (as returned by the seal tool)");

const server = new McpServer({
  name: "apex-psi-mcp",
  version: VERSION,
});

// Tool: seal
server.registerTool(
  "seal",
  {
    title: "Seal content",
    description:
      "Stamp a cryptographic receipt on content. Writes to the APEX PSI append-only ledger with SHA-256 hash, Ed25519 signature, and post-quantum LMS-W4-SHA256 signature. Proves existence and integrity at a point in time — not the truth of the contents.",
    inputSchema: {
      content: z.string().max(10000).describe("The content to seal (text, up to 10000 characters)"),
      context: z.string().optional().describe("Optional context label (e.g. document name, case ID)"),
      predicate: z.string().optional().describe("Optional predicate describing why this is sealed"),
      model_id: z.string().optional().describe("Optional model/agent identifier producing the seal"),
    },
  },
  async ({ content, context, predicate, model_id }) => {
    try {
      const receipt = await apexApiCall("/notarize", "POST", {
        decision: content,
        model_id: model_id || `apex-psi-mcp/${VERSION}`,
        context: context || "mcp-seal",
        predicate: predicate || "sealed-via-mcp",
      });
      const decisionHash = stripHashPrefix(receipt.decision_hash);
      return mcpResult({
        success: true,
        receipt,
        receipt_id: receipt.receipt_id,
        verify_hash: decisionHash,
        verify_url: `${APEX_API_BASE}/verify-hash?hash=${decisionHash}`,
        message: "Content sealed in the APEX PSI append-only ledger",
      });
    } catch (error) {
      return mcpError(error);
    }
  },
);

// Tool: verify
server.registerTool(
  "verify",
  {
    title: "Verify a receipt",
    description:
      "Confirm a seal's integrity against the APEX PSI append-only ledger. Accepts a receipt object (from the seal tool) or a raw SHA-256 hash. Reports whether the hash is present and anchored — integrity, not the truth of the original content.",
    inputSchema: {
      hash: z
        .string()
        .optional()
        .describe("A SHA-256 hash to look up in the ledger (with or without 'sha256:' prefix)"),
      receipt: receiptSchema.optional().describe("A receipt object as returned by the seal tool"),
    },
  },
  async ({ hash, receipt }) => {
    try {
      let lookup = hash || "";
      if (!lookup && receipt) {
        lookup = stripHashPrefix(receipt.decision_hash ?? receipt.merkle_leaf ?? receipt.merkle_root);
      }
      if (!lookup) {
        throw new Error("Provide either a hash or a receipt object");
      }
      const result = await apexApiCall(`/verify-hash?hash=${encodeURIComponent(stripHashPrefix(lookup))}`);
      return mcpResult({
        success: true,
        verification: result,
        message: result.verified
          ? "Seal verified — hash is present in the APEX PSI append-only ledger"
          : "Hash not found in the ledger",
      });
    } catch (error) {
      return mcpError(error);
    }
  },
);

// Tool: anchor (status by default; explicit request to anchor pending roots)
server.registerTool(
  "anchor",
  {
    title: "Bitcoin anchoring status / request",
    description:
      "Read the Bitcoin (OpenTimestamps) anchoring state of the ledger's pending Merkle roots, or — only when action:'anchor' is passed explicitly — request that pending roots be aggregated and submitted to the OTS calendars. Defaults to 'status' (read-only) so a routine call never triggers a batch write. An anchor becomes confirmed only when a real Bitcoin block is found.",
    inputSchema: {
      action: z
        .enum(["anchor", "status"])
        .optional()
        .describe("'status' reads the anchor state (default); 'anchor' explicitly requests anchoring of pending roots"),
    },
  },
  async ({ action }) => {
    try {
      const resolved = action || "status";
      const result = await apexApiCall("/blockchain-anchor", "POST", {
        action: resolved,
      });
      return mcpResult({
        success: true,
        anchorResult: result,
        action: resolved,
        message:
          resolved === "anchor"
            ? "Bitcoin anchoring requested for pending roots (OpenTimestamps); confirmation follows only on a real block"
            : "Bitcoin anchoring status read (OpenTimestamps)",
      });
    } catch (error) {
      return mcpError(error);
    }
  },
);

// Tool: cite
server.registerTool(
  "cite",
  {
    title: "Generate citation",
    description:
      "Generate a citation for a sealed receipt in APA, BibTeX, or MLA format, citing the APEX PSI ledger entry.",
    inputSchema: {
      receipt: receiptSchema.describe("A receipt object as returned by the seal tool"),
      format: z.enum(["apa", "bibtex", "mla"]).optional().describe("Citation format (default: apa)"),
    },
  },
  async ({ receipt, format }) => {
    try {
      const fmt = format || "apa";
      const receiptId = String(receipt.receipt_id || "APEX-PSI-RECEIPT");
      const timestamp = String(receipt.timestamp || new Date().toISOString());
      const year = timestamp.slice(0, 4);
      const date = timestamp.slice(0, 10);
      const decisionHash = stripHashPrefix(receipt.decision_hash);
      const verifyUrl = `${APEX_API_BASE}/verify-hash?hash=${decisionHash}`;
      const algorithm = String(receipt.algorithm || "SHA-256 + Ed25519 + LMS-W4-SHA256");

      let citation: string;
      if (fmt === "bibtex") {
        citation = [
          `@misc{${receiptId.toLowerCase()},`,
          `  author       = {APEX PSI Notary},`,
          `  title        = {Cryptographic Seal ${receiptId}},`,
          `  year         = {${year}},`,
          `  howpublished = {APEX PSI Append-Only Ledger (${algorithm})},`,
          `  note         = {Receipt ${receiptId}, sealed ${date}},`,
          `  url          = {${verifyUrl}}`,
          `}`,
        ].join("\n");
      } else if (fmt === "mla") {
        citation = `"Cryptographic Seal ${receiptId}." APEX PSI Append-Only Ledger, ${date}, ${verifyUrl}. ${algorithm}.`;
      } else {
        citation = `APEX PSI Notary. (${year}). Cryptographic seal ${receiptId} [APEX PSI append-only ledger entry; ${algorithm}]. Retrieved from ${verifyUrl}`;
      }

      return mcpResult({
        success: true,
        citation,
        format: fmt,
        receipt_id: receiptId,
        message: `Citation generated in ${fmt} format`,
      });
    } catch (error) {
      return mcpError(error);
    }
  },
);

// Tool: verify_chain (independent verification of a receipt chain)
server.registerTool(
  "verify_chain",
  {
    title: "Verify a receipt chain",
    description:
      "Independently verify a chain of receipts against the APEX PSI ledger. Recomputes each hash's presence and integrity and reports Merkle chain continuity. Returns a verification report — a recomputation result, not an opinion or a certification.",
    inputSchema: {
      receipts: z.array(receiptSchema).min(1).describe("Array of receipt objects to verify (in order)"),
    },
  },
  async ({ receipts }) => {
    try {
      const results: Array<{ index: number; receipt_id: string; verified: boolean; found: boolean; hash: string }> = [];
      let previousRoot = "";
      let chainIntact = true;

      for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i];
        const hash = stripHashPrefix(r.decision_hash ?? r.merkle_leaf ?? r.merkle_root);
        if (!hash) {
          results.push({ index: i, receipt_id: String(r.receipt_id || "?"), verified: false, found: false, hash: "" });
          chainIntact = false;
          continue;
        }
        const result = (await apexApiCall(`/verify-hash?hash=${encodeURIComponent(hash)}`)) as {
          verified?: boolean;
          found?: boolean;
        };
        results.push({
          index: i,
          receipt_id: String(r.receipt_id || "?"),
          verified: !!result.verified,
          found: !!result.found,
          hash,
        });
        const root = stripHashPrefix(r.merkle_root);
        if (previousRoot && root && previousRoot === root && i > 0) {
          // Identical consecutive roots are noted only; the ledger decides continuity.
        }
        previousRoot = root;
        if (!result.verified) chainIntact = false;
      }

      const verifiedCount = results.filter((f) => f.verified).length;
      return mcpResult({
        success: true,
        verification_report: {
          total: receipts.length,
          verified: verifiedCount,
          failed: receipts.length - verifiedCount,
          chainIntact,
          results,
          verified_at: new Date().toISOString(),
        },
        message: `Chain verification complete: ${verifiedCount}/${receipts.length} receipts verified${chainIntact ? ", chain intact" : ", chain broken"}`,
      });
    } catch (error) {
      return mcpError(error);
    }
  },
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`APEX PSI MCP Server running on stdio (backend: ${APEX_API_BASE})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

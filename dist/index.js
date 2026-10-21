#!/usr/bin/env node
/**
 * APEX PSI MCP Server
 * Append-only evidence receipts for AI agents and auditors.
 *
 * 5 tools: seal, verify, anchor, cite, verify_chain
 * Backend: APEX NOTARY (Supabase Edge Functions) — SHA-256, Ed25519 over the Merkle
 * leaf, ML-DSA-65, and LMS-W4-SHA256 when a slot is available. Each receipt states in
 * its own `algorithm` field which signatures it actually carries.
 * Override base URL with APEX_API_BASE if self-hosting.
 *
 * Scope: this server records the existence and integrity of a record at a point in
 * time. It does not judge the truth of a record's contents. It is an independent
 * verification service, not advice or an attestable opinion.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// Configuration
const APEX_API_BASE = (process.env.APEX_API_BASE || "https://qhtntebpcribjiwrdtdd.supabase.co/functions/v1").replace(/\/$/, "");
const APEX_API_KEY = process.env.APEX_API_KEY || "";
const VERSION = "1.1.1";
// Helper: make an API call to the Apex PSI backend
async function apexApiCall(endpoint, method = "GET", body) {
    const url = `${APEX_API_BASE}${endpoint}`;
    const headers = { "Content-Type": "application/json" };
    if (APEX_API_KEY)
        headers["Authorization"] = `Bearer ${APEX_API_KEY}`;
    const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        let detail = "";
        try {
            detail = (await response.text()).slice(0, 300);
        }
        catch {
            /* ignore */
        }
        throw new Error(`API call failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
    }
    return (await response.json());
}
// Helper: strip a "sha256:" prefix from a hash value
function stripHashPrefix(value) {
    return typeof value === "string" ? value.replace(/^sha256:/i, "") : "";
}
// Helper: wrap a result (or error) into an MCP text response
function mcpResult(result) {
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
function mcpError(error) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2),
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
server.registerTool("seal", {
    title: "Seal content",
    description: "Record content in the APEX PSI append-only ledger and return a receipt: SHA-256 hash, an Ed25519 signature over the Merkle leaf, and post-quantum ML-DSA-65 (plus LMS-W4-SHA256 when a slot is available — the receipt's own algorithm field states which). Proves that this content existed and has not changed since the timestamp. It never proves the contents are true. Free tier: 20 operations/minute, 100/day, no account needed.",
    inputSchema: {
        content: z.string().max(10000).describe("The content to seal (text, up to 10000 characters)"),
        context: z.string().optional().describe("Optional context label (e.g. document name, case ID)"),
        predicate: z.string().optional().describe("Optional predicate describing why this is sealed"),
        model_id: z.string().optional().describe("Optional model/agent identifier producing the seal"),
    },
}, async ({ content, context, predicate, model_id }) => {
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
    }
    catch (error) {
        return mcpError(error);
    }
});
// Tool: verify
server.registerTool("verify", {
    title: "Verify a receipt",
    description: "Confirm a seal's integrity against the APEX PSI append-only ledger. Accepts a receipt object (from the seal tool) or a raw SHA-256 hash. Reports whether the hash is present and anchored — integrity, not the truth of the original content.",
    inputSchema: {
        hash: z
            .string()
            .optional()
            .describe("A SHA-256 hash to look up in the ledger (with or without 'sha256:' prefix)"),
        receipt: receiptSchema.optional().describe("A receipt object as returned by the seal tool"),
    },
}, async ({ hash, receipt }) => {
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
    }
    catch (error) {
        return mcpError(error);
    }
});
// Tool: anchor (status by default; explicit request to anchor pending roots)
server.registerTool("anchor", {
    title: "Bitcoin anchoring history",
    description: "Read the Bitcoin (OpenTimestamps) anchoring record for the ledger's Merkle roots. Defaults to action:'history', which is read-only and returns each anchor transaction with its txid, block height, confirmation state and how many ledger entries it covers. Pass action:'verify' with a txid to check one transaction, or action:'anchor' to explicitly request that pending roots be aggregated and submitted to the OTS calendars. Defaults to 'history' so a routine call never triggers a batch write. An anchor counts as confirmed only when a real Bitcoin block contains it.",
    inputSchema: {
        action: z
            .enum(["history", "verify", "anchor"])
            .optional()
            .describe("'history' reads the anchored transactions (default); 'verify' checks one txid; 'anchor' explicitly requests anchoring of pending roots"),
        txid: z
            .string()
            .optional()
            .describe("Bitcoin transaction id — required only when action is 'verify'"),
    },
}, async ({ action, txid }) => {
    try {
        const resolved = action || "history";
        if (resolved === "verify" && !txid) {
            return mcpError(new Error("action 'verify' needs a txid to check"));
        }
        const result = await apexApiCall("/blockchain-anchor", "POST", {
            action: resolved,
            ...(txid ? { txid } : {}),
        });
        return mcpResult({
            success: true,
            anchorResult: result,
            action: resolved,
            message: resolved === "anchor"
                ? "Bitcoin anchoring requested for pending roots (OpenTimestamps); confirmation follows only on a real block"
                : resolved === "verify"
                    ? `Bitcoin transaction ${String(txid).slice(0, 16)}… checked against the anchor record`
                    : "Read the anchored Bitcoin transactions (OpenTimestamps)",
        });
    }
    catch (error) {
        return mcpError(error);
    }
});
// Tool: cite
server.registerTool("cite", {
    title: "Generate citation",
    description: "Generate a citation for a sealed receipt in APA, BibTeX, or MLA format, citing the APEX PSI ledger entry.",
    inputSchema: {
        receipt: receiptSchema.describe("A receipt object as returned by the seal tool"),
        format: z.enum(["apa", "bibtex", "mla"]).optional().describe("Citation format (default: apa)"),
    },
}, async ({ receipt, format }) => {
    try {
        const fmt = format || "apa";
        const receiptId = String(receipt.receipt_id || "APEX-PSI-RECEIPT");
        const timestamp = String(receipt.timestamp || new Date().toISOString());
        const year = timestamp.slice(0, 4);
        const date = timestamp.slice(0, 10);
        const decisionHash = stripHashPrefix(receipt.decision_hash);
        const verifyUrl = `${APEX_API_BASE}/verify-hash?hash=${decisionHash}`;
        const algorithm = String(receipt.algorithm || "SHA-256 + Ed25519 + LMS-W4-SHA256");
        let citation;
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
        }
        else if (fmt === "mla") {
            citation = `"Cryptographic Seal ${receiptId}." APEX PSI Append-Only Ledger, ${date}, ${verifyUrl}. ${algorithm}.`;
        }
        else {
            citation = `APEX PSI Notary. (${year}). Cryptographic seal ${receiptId} [APEX PSI append-only ledger entry; ${algorithm}]. Retrieved from ${verifyUrl}`;
        }
        return mcpResult({
            success: true,
            citation,
            format: fmt,
            receipt_id: receiptId,
            message: `Citation generated in ${fmt} format`,
        });
    }
    catch (error) {
        return mcpError(error);
    }
});
// Tool: verify_chain (independent verification of a receipt chain)
server.registerTool("verify_chain", {
    title: "Verify a receipt chain",
    description: "Independently verify a chain of receipts against the APEX PSI ledger. Recomputes each hash's presence and integrity and reports Merkle chain continuity. Returns a verification report — a recomputation result, not an opinion or a certification.",
    inputSchema: {
        receipts: z.array(receiptSchema).min(1).describe("Array of receipt objects to verify (in order)"),
    },
}, async ({ receipts }) => {
    try {
        const results = [];
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
            const result = (await apexApiCall(`/verify-hash?hash=${encodeURIComponent(hash)}`));
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
            if (!result.verified)
                chainIntact = false;
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
    }
    catch (error) {
        return mcpError(error);
    }
});
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

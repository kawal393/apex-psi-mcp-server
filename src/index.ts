#!/usr/bin/env node

/**
 * APEX PSI MCP Server
 * Cryptographic truth infrastructure for AI agents
 * 
 * 5 tools: seal, verify, anchor, cite, audit
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

// Configuration
const APEX_API_BASE = process.env.APEX_API_BASE || "https://sovereign-ai.services/api";
const APEX_API_KEY = process.env.APEX_API_KEY || "";

// Helper: Make API call to Apex PSI
async function apexApiCall(endpoint: string, method: string = "GET", body?: any) {
  const url = `${APEX_API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (APEX_API_KEY) {
    headers["Authorization"] = `Bearer ${APEX_API_KEY}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`API call failed: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

// Tool: seal
async function sealContent(content: string, metadata?: Record<string, any>) {
  try {
    const result = await apexApiCall("/seal", "POST", {
      content,
      metadata: metadata || {},
      timestamp: new Date().toISOString(),
    });
    
    return {
      success: true,
      receipt: result,
      message: "Content sealed successfully",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Tool: verify
async function verifyReceipt(receipt: any, content?: string) {
  try {
    const result = await apexApiCall("/verify", "POST", {
      receipt,
      content,
    });
    
    return {
      success: true,
      verification: result,
      message: result.valid ? "Receipt is valid" : "Receipt verification failed",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Tool: anchor
async function anchorReceipt(receipt: any) {
  try {
    const result = await apexApiCall("/anchor", "POST", {
      receipt,
    });
    
    return {
      success: true,
      anchorProof: result,
      message: "Receipt anchored to Bitcoin via OpenTimestamps",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Tool: cite
async function citeReceipt(receipt: any, format: string = "apa") {
  try {
    const result = await apexApiCall("/cite", "POST", {
      receipt,
      format,
    });
    
    return {
      success: true,
      citation: result.citation,
      format: result.format,
      message: `Citation generated in ${format} format`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Tool: audit
async function auditChain(receipts: any[], checkAnchoring: boolean = false) {
  try {
    const result = await apexApiCall("/audit", "POST", {
      receipts,
      checkAnchoring,
    });
    
    return {
      success: true,
      auditReport: result,
      message: `Audit complete: ${result.findings.length} findings`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Main server
const server = new Server(
  {
    name: "apex-psi-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "seal",
      description: "Stamp a cryptographic receipt on content. Creates a tamper-evident seal with SHA-256 hash and Ed25519 signature.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The content to seal (text, JSON, or any string)",
          },
          metadata: {
            type: "object",
            description: "Optional metadata to include in the receipt",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "verify",
      description: "Verify a receipt is authentic. Checks the cryptographic signature and hash integrity.",
      inputSchema: {
        type: "object",
        properties: {
          receipt: {
            type: "object",
            description: "The receipt object to verify",
          },
          content: {
            type: "string",
            description: "Optional content to verify against the receipt",
          },
        },
        required: ["receipt"],
      },
    },
    {
      name: "anchor",
      description: "Anchor a receipt to Bitcoin via OpenTimestamps. Creates an immutable timestamp proof on the Bitcoin blockchain.",
      inputSchema: {
        type: "object",
        properties: {
          receipt: {
            type: "object",
            description: "The receipt to anchor",
          },
        },
        required: ["receipt"],
      },
    },
    {
      name: "cite",
      description: "Generate a citation for a receipt in various formats (APA, BibTeX, MLA).",
      inputSchema: {
        type: "object",
        properties: {
          receipt: {
            type: "object",
            description: "The receipt to cite",
          },
          format: {
            type: "string",
            enum: ["apa", "bibtex", "mla"],
            description: "Citation format (default: apa)",
          },
        },
        required: ["receipt"],
      },
    },
    {
      name: "audit",
      description: "Audit a chain of receipts. Checks integrity, continuity, and optionally verifies anchoring.",
      inputSchema: {
        type: "object",
        properties: {
          receipts: {
            type: "array",
            items: { type: "object" },
            description: "Array of receipts to audit",
          },
          checkAnchoring: {
            type: "boolean",
            description: "Whether to verify Bitcoin anchoring (default: false)",
          },
        },
        required: ["receipts"],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: any;

    switch (name) {
      case "seal":
        result = await sealContent(args.content as string, args.metadata as Record<string, any>);
        break;
      case "verify":
        result = await verifyReceipt(args.receipt, args.content as string);
        break;
      case "anchor":
        result = await anchorReceipt(args.receipt);
        break;
      case "cite":
        result = await citeReceipt(args.receipt, (args.format as string) || "apa");
        break;
      case "audit":
        result = await auditChain(args.receipts as any[], args.checkAnchoring as boolean);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("APEX PSI MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

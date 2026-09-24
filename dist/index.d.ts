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
export {};

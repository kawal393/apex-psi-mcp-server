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
export {};

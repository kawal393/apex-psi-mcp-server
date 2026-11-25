#!/usr/bin/env node
// paste-check — the source in the spec must compile, and must still be the
// source the spec claims it is.
//
// A brief that carries code is only worth something if the code runs. This
// pulls the TypeScript blocks out of docs/AGENT-PAYMENT-GATE.md, puts them
// next to the real vendored modules with the Deno and npm imports stubbed,
// and type-checks them with the repository's own compiler. It also checks that
// the blocks still carry the four rules that make the door safe.
//
// Run:  node scripts/paste-check.mjs
// Exit 0 = the paste compiles and holds the rules. Exit 1 = it does not.
// Exit 2 = the spec could not be read.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const specPath = join(root, "docs", "AGENT-PAYMENT-GATE.md");
const work = join(root, ".paste-check");

let failures = 0;
function pass(what, detail) {
  console.log(`PASS ${what}${detail ? ": " + detail : ""}`);
}
function fail(what, detail) {
  failures++;
  console.error(`FAIL ${what}${detail ? ": " + detail : ""}`);
}

if (!existsSync(specPath)) {
  console.error("STOP: docs/AGENT-PAYMENT-GATE.md is missing");
  process.exit(2);
}
const spec = readFileSync(specPath, "utf8");
const blocks = [...spec.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length < 2) {
  console.error(`STOP: the spec carries ${blocks.length} TypeScript block(s), expected at least 2`);
  process.exit(2);
}
const door = blocks[0];
const conformance = blocks[1];

// The rules the door must keep, whatever the prose says.
const doorRules = [
  ["calls the payment rules", "evaluatePayment("],
  ["binds the payment tool", "PAYMENT_TOOL"],
  ["spends the proposal id alone", "replay_key: pid"],
  ["reports the keyring fingerprint", "keyring_fingerprint"],
  ["creates the session last", "stripe.checkout.sessions.create"],
];
for (const [what, needle] of doorRules) {
  if (door.includes(needle)) pass(`the pasted door ${what}`);
  else fail(`the pasted door ${what}`, `no "${needle}" in the spec`);
}
if (conformance.includes("conformance:${session}:${pid}")) {
  pass("the conformance key carries the session");
} else {
  fail("the conformance key carries the session", "no session-scoped key in the spec");
}
if (conformance.includes("session_required")) {
  pass("the conformance door requires a session");
} else {
  fail("the conformance door requires a session", "no session_required in the spec");
}
if (!spec.includes("gate_replay_created_at_idx")) {
  fail("the spec carries the migration", "no gate_replay index in the spec");
} else {
  pass("the spec carries the migration");
}

// Now the compiler. The vendored modules come from src/ unchanged.
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "agent-checkout"), { recursive: true });
mkdirSync(join(work, "conformance-check"), { recursive: true });
mkdirSync(join(work, "_shared", "psi-agent"), { recursive: true });

for (const file of ["agent.ts", "gate.ts", "receiver.ts", "payment.ts"]) {
  writeFileSync(join(work, "_shared", "psi-agent", file), readFileSync(join(root, "src", file)), "utf8");
}
writeFileSync(join(work, "agent-checkout", "index.ts"), door, "utf8");
writeFileSync(
  join(work, "conformance-check", "index.ts"),
  [
    'import { createClient } from "npm:@supabase/supabase-js@2";',
    'import { createReceiverGate } from "../_shared/psi-agent/receiver.ts";',
    "const conformanceKeys = (kid: string) => null;",
    "",
    conformance,
  ].join("\n"),
  "utf8",
);
writeFileSync(
  join(work, "stubs.d.ts"),
  `declare namespace Deno {
  export const env: { get(name: string): string | undefined };
  export function serve(handler: (req: Request) => Promise<Response> | Response): void;
}

declare module "npm:@supabase/supabase-js@2" {
  export function createClient(
    url: string,
    key: string,
    opts?: unknown,
  ): {
    from(table: string): {
      insert(row: Record<string, unknown>): Promise<{ error: { code?: string } | null }>;
    };
  };
}

declare module "https://esm.sh/stripe@14?target=deno" {
  export default class Stripe {
    constructor(key: string, opts?: unknown);
    static createFetchHttpClient(): unknown;
    checkout: {
      sessions: {
        create(params: Record<string, unknown>): Promise<{ id: string; url: string }>;
      };
    };
  }
}
`,
  "utf8",
);
writeFileSync(
  join(work, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        typeRoots: [join(root, "node_modules", "@types")],
      },
      include: ["agent-checkout/index.ts", "conformance-check/index.ts", "stubs.d.ts", "_shared/psi-agent/*.ts"],
    },
    null,
    2,
  ),
  "utf8",
);

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  console.error(`STOP: the compiler is missing at ${tsc}`);
  process.exit(2);
}
const run = spawnSync(process.execPath, [tsc, "-p", join(work, "tsconfig.json")], {
  encoding: "utf8",
  cwd: root,
});
rmSync(work, { recursive: true, force: true });

if (run.status === 0) {
  pass("the pasted source compiles", "strict mode, the repository's own compiler");
} else {
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(0, 8).join(" | ");
  fail("the pasted source compiles", out || `tsc exit ${run.status}`);
}

if (failures) {
  console.error(`\nPASTE FAILED: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nPASTE OK: the spec's source compiles and keeps the rules.");
process.exit(0);

#!/usr/bin/env node
// server-version-check — the version the server announces must be the version that ships.
//
// Why this exists: on 16 Nov the package apex-psi-mcp@1.2.0 was published while
// src/index.ts still held the literal "1.1.2". Every MCP client was therefore told the
// server was 1.1.2, while npm and the official registry said 1.2.0. A client that pins on
// serverInfo.version sees a stale server, a directory scraper sees a different one, and
// both are reading the same published package.
//
// The version is now read from package.json at runtime, and this guard proves the two
// agree by asking the BUILT server over stdio exactly as a client would. It also refuses a
// hardcoded version literal in the source, because a literal is how the two drift apart.
//
// Usage: node scripts/server-version-check.mjs [--server <entry>] [--package <pkg.json>]
//        node scripts/server-version-check.mjs --self-test

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const self = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SERVER = resolve(root, argOf("--server", "dist/index.js"));
const PACKAGE = resolve(root, argOf("--package", "package.json"));
const SOURCE = resolve(root, argOf("--source", "src/index.ts"));

// Ask the server what version it announces, the way a client does.
function askServerVersion(entry) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("the server did not answer initialize within 20 seconds"));
    }, 20000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(msg.result.serverInfo?.version || "");
          return;
        }
      }
    });
    child.stderr.resume();
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "version-check", version: "1" },
        },
      }) + "\n",
    );
  });
}

async function check(entry, pkgPath, sourcePath) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const shipped = pkg.version;

  if (!existsSync(entry)) {
    problems.push(`the built server is missing: ${entry} (run npm run build first)`);
    return { shipped, announced: null, problems };
  }

  let announced = null;
  try {
    announced = await askServerVersion(entry);
  } catch (e) {
    problems.push(`the server did not answer initialize: ${e.message}`);
  }

  if (announced !== null && announced !== shipped) {
    problems.push(
      `the server announces ${announced} but the package ships ${shipped} — a client reading serverInfo.version sees a stale server`,
    );
  }

  if (existsSync(sourcePath)) {
    const src = readFileSync(sourcePath, "utf8");
    const literal = src.match(/VERSION\s*=\s*["'`](\d[^"'`]*)["'`]/);
    if (literal) {
      problems.push(
        `src/index.ts hardcodes VERSION = "${literal[1]}" — the version must be read from package.json so it cannot drift`,
      );
    }
  }

  return { shipped, announced, problems };
}

// A guard nobody has seen fail is not a guard. Two fake servers stand in: one that
// announces the wrong version, which must be refused, and one that announces the right
// one, which must pass.
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "version-check-"));
  const failures = [];
  const fakeServer = (announced) => {
    const path = join(dir, `fake-${announced}.mjs`);
    writeFileSync(
      path,
      `let b = "";\n` +
        `process.stdin.on("data", (c) => {\n` +
        `  b += c.toString();\n` +
        `  if (!b.includes("\\n")) return;\n` +
        `  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "${announced}" } } }) + "\\n");\n` +
        `  process.exit(0);\n` +
        `});\n`,
    );
    return path;
  };
  const pkgPath = join(dir, "package.json");
  writeFileSync(pkgPath, JSON.stringify({ name: "fake", version: "1.2.1" }));
  const srcPath = join(dir, "index.ts");
  writeFileSync(srcPath, 'const VERSION = readPackageVersion();\n');

  const run = (server) =>
    spawnSyncExit(
      process.execPath,
      [self, "--server", server, "--package", pkgPath, "--source", srcPath],
    );

  const wrong = run(fakeServer("1.2.0"));
  if (wrong !== 1) failures.push(`the guard accepted a server announcing 1.2.0 while the package ships 1.2.1 (exit ${wrong})`);
  const right = run(fakeServer("1.2.1"));
  if (right !== 0) failures.push(`the guard refused a server announcing the shipped version (exit ${right})`);

  rmSync(dir, { recursive: true, force: true });
  if (failures.length) {
    console.error(`server-version-check self-test: ${failures.length} failure(s).`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log("PASS — the guard refuses a stale announced version and accepts the shipped one.");
  process.exit(0);
}

function spawnSyncExit(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" }).status;
}

const result = await check(SERVER, PACKAGE, SOURCE);
if (result.problems.length) {
  console.error(`server-version-check: ${result.problems.length} problem(s).`);
  for (const p of result.problems) console.error(`  FAIL ${p}`);
  process.exit(1);
}
console.log(
  `PASS — the built server announces ${result.announced} and the package ships ${result.shipped}.`,
);

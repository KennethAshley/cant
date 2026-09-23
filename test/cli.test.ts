import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import http from "node:http";
import { defaultConfig } from "../src/config.ts";
import { generateNsec } from "../src/nostr.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cli = path.join(import.meta.dirname, "../src/cli.ts");

test("init --yes --owner writes config and whoami prints an npub", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-cli-"));
  // Keep CLI tests off public relays while exercising the real profile-publish path.
  const offline = path.join(home, "offline.mjs");
  fs.writeFileSync(offline, `import { __setWebSocketForTests } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "../src/nostr.ts")).href)};
    class Socket {
      static OPEN = 1; readyState = 1;
      constructor() { setTimeout(() => this.onopen?.(), 0); }
      send(raw) { const [verb, event] = JSON.parse(raw); if (verb === 'EVENT') setTimeout(() => this.onmessage?.({ data: JSON.stringify(['OK', event.id, true, '']) }), 0); }
      close() { this.readyState = 3; this.onclose?.({}); }
    }
    __setWebSocketForTests(Socket);`);
  const env = { ...process.env, SIDECAR_HOME: home };
  const out = execFileSync(process.execPath, ["--import", offline, cli, "init", "--yes", "--owner", "--name", "ken"], { env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /npub1/);
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(config.name, "ken");
  assert.equal(config.handler, "");
  const who = execFileSync(process.execPath, [cli, "whoami"], { env, encoding: "utf8" });
  assert.match(who, /^npub1/);
  assert.throws(() => execFileSync(process.execPath, [cli, "init", "--yes", "--owner"], { env, encoding: "utf8", stdio: "pipe" }), /already exists/);
  assert.equal(execFileSync(process.execPath, [cli, "whoami"], { env, encoding: "utf8" }), who);
  execFileSync(process.execPath, ["--import", offline, cli, "--agent", "second", "init", "--yes", "--owner", "--name", "second"], { env, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
  assert.notEqual(execFileSync(process.execPath, [cli, "--agent", "second", "whoami"], { env, encoding: "utf8" }), who);
  assert.equal(execFileSync(process.execPath, [cli, "whoami"], { env, encoding: "utf8" }), who);
});

test("no command prints usage and exits 0", () => {
  const out = execFileSync(process.execPath, [cli], { encoding: "utf8" });
  assert.match(out, /usage/);
});

test("a command for a named agent never changes another identity on its configured port", async t => {
  let mutations = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST") mutations++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.method === "GET" ? { ok: true, npub: "different-identity" } : { result: { allowed: true } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-cli-identity-"));
  const dir = path.join(root, "agents", "second");
  fs.mkdirSync(dir, { recursive: true });
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(defaultConfig({ name: "second", nsec: generateNsec(), port })));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, "--agent", "second", "allow", "npub1example"], { env: { ...process.env, SIDECAR_HOME: root } }), /another service/);
  assert.equal(mutations, 0);
});

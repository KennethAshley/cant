import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
});

test("no command prints usage and exits 0", () => {
  const out = execFileSync(process.execPath, [cli], { encoding: "utf8" });
  assert.match(out, /usage/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SIDECAR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-test-"));
const { defaultConfig, loadConfig, saveConfig, home } = await import("../src/config.ts");

test("defaults are the spec defaults", () => {
  const c = defaultConfig({ nsec: "nsec1test", name: "a" });
  assert.deepEqual(c.relays, ["wss://relay.fez.chat"]);
  assert.equal(c.handler, "npx -y @agentclientprotocol/claude-agent-acp");
  assert.equal(c.respond_to, "allowlist");
  assert.deepEqual(c.thresholds, { act: 0.85, ask: 0.5, route: 0.6 });
  assert.equal(c.timeoutMs, 20 * 60_000);
  assert.equal(c.port, 7777);
  assert.equal(c.depthLimit, 3);
});

test("save then load round-trips and file is mode 600", () => {
  const c = defaultConfig({ nsec: "nsec1test", name: "a", owner: "npub1owner" });
  saveConfig(c);
  const back = loadConfig();
  assert.deepEqual(back, c);
  const mode = fs.statSync(path.join(home(), "config.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("loadConfig throws a readable error when missing", () => {
  fs.rmSync(path.join(home(), "config.json"));
  assert.throws(() => loadConfig(), /sidecar init/);
});

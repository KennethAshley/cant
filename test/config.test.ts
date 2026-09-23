import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

test("named agents keep their keys and inboxes separate from the legacy default", () => {
  const root = home();
  saveConfig(defaultConfig({ nsec: "legacy-key", name: "legacy" }));
  try {
    process.env.SIDECAR_AGENT = "mini-pi";
    assert.equal(home(), path.join(root, "agents", "mini-pi"));
    saveConfig(defaultConfig({ nsec: "pi-key", name: "mini-pi" }));
    process.env.SIDECAR_AGENT = "mini-claude";
    assert.throws(() => loadConfig());
    saveConfig(defaultConfig({ nsec: "claude-key", name: "mini-claude" }));
    process.env.SIDECAR_AGENT = "mini-pi";
    assert.equal(loadConfig().nsec, "pi-key");
    delete process.env.SIDECAR_AGENT;
    assert.equal(loadConfig().nsec, "legacy-key");
  } finally { delete process.env.SIDECAR_AGENT; }
});

test("an agent name cannot escape its configuration directory", () => {
  try {
    for (const name of ["../other", "a/b", "/tmp/other", "..", "", "has spaces"]) {
      process.env.SIDECAR_AGENT = name;
      assert.throws(() => home(), /agent name/i);
    }
  } finally { delete process.env.SIDECAR_AGENT; }
});

test("macOS notification text reaches AppleScript literally, including quotes and shell syntax", {skip: process.platform !== "darwin"}, () => {
  const command = defaultConfig({nsec: "test", name: "test"}).notify;
  // Evaluate the real configured body expression without showing a test banner.
  const readBody = command.replace("display notification", "return").replace(' with title "sidecar"', "");
  const message = 'Ken says "bonjour"\n$MSG $(echo should-not-run) `whoami` Montréal';
  const result = execFileSync("/bin/sh", ["-c", readBody], {encoding: "utf8", env: {...process.env, MSG: message}});
  assert.equal(result.trimEnd(), message);
});

test("loading the legacy Mac notification default fixes its literal MSG bug and preserves custom hooks", () => {
  const legacy = `osascript -e 'display notification "$MSG" with title "sidecar"'`;
  saveConfig(defaultConfig({nsec: "test", name: "test", notify: legacy}));
  assert.notEqual(loadConfig().notify, legacy);
  for (const notify of ["", "my-notify-command"]) {
    saveConfig(defaultConfig({nsec: "test", name: "test", notify}));
    assert.equal(loadConfig().notify, notify);
  }
});

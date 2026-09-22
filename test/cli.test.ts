import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.join(import.meta.dirname, "../src/cli.ts");

test("init --yes --owner writes config and whoami prints an npub", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-"));
  // relays that never answer, so init exercises its publish timeout instead of the network
  const env = { ...process.env, RELAYD_HOME: home };
  const out = execFileSync(process.execPath, [cli, "init", "--yes", "--owner", "--name", "ken"], { env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
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

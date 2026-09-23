import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PiHandler } from "../src/pi.ts";

const command = [process.execPath, path.join(import.meta.dirname, "fake-pi.ts")];

test("Pi preserves separate conversations, Unicode framing, and waits through retries", async t => {
  const h = new PiHandler(command, { permissions: "deny", timeoutMs: 2000 });
  t.after(() => h.close());
  await h.start();
  assert.equal((await h.prompt("a", "hello\u2028world")).text, "1: hello\u2028world");
  assert.equal((await h.prompt("b", "other")).text, "1: other");
  assert.equal((await h.prompt("a", "again")).text, "2: again");
  assert.notEqual(h.sessionIds().a, h.sessionIds().b);
  assert.equal((await h.prompt("a", "RETRY")).text, "retried successfully");
  assert.equal((await h.prompt("a", "TOOLS")).text, "true");
});

test("Pi cancellation and failures settle without leaking output into the next prompt", async t => {
  const h = new PiHandler(command, { permissions: "allow", timeoutMs: 300 });
  t.after(() => h.close());
  await h.start();
  await h.prompt("a", "ready");
  const pending = h.prompt("a", "SLEEP");
  await new Promise(r => setTimeout(r, 60));
  assert.equal(await h.cancel("a"), true);
  assert.equal((await pending).stopReason, "cancelled");
  assert.equal((await h.prompt("a", "after cancel")).text, "2: after cancel");
  await assert.rejects(h.prompt("a", "REJECT"), /No model/);
  await assert.rejects(h.prompt("a", "FAIL"), /provider failed/);
  await assert.rejects(h.prompt("a", "SLEEP"), /timed out/);
  assert.equal((await h.prompt("a", "fresh")).text, "1: fresh");
  await assert.rejects(h.prompt("a", "EXIT"), /exited/);
});

test("cancelling Pi during preflight prevents it from beginning work later", async t => {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-pi-cancel-")), "executed");
  const h = new PiHandler(command, { permissions: "allow", timeoutMs: 1000 });
  t.after(() => h.close());
  await h.start();
  const pending = h.prompt("a", `PREFLIGHT ${output}`);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await h.cancel("a"), true);
  assert.equal((await pending).stopReason, "cancelled");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fs.existsSync(output), false, "cancelled preflight must never execute");
  assert.equal((await h.prompt("a", "new work")).text, "1: new work");
});

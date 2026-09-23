import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Handler } from "../src/acp.ts";

const fake = `${process.execPath} ${path.join(import.meta.dirname, "fake-acp-agent.ts")}`;

test("handler opens one session per thread and returns the reply text", async () => {
  const h = new Handler(fake, { permissions: "allow", timeoutMs: 5000 });
  await h.start();
  const r1 = await h.prompt("t1", "hello");
  assert.equal(r1.text, "echo: hello");
  assert.equal(r1.stopReason, "end_turn");
  await h.prompt("t2", "again");
  const ids = h.sessionIds();
  assert.equal(Object.keys(ids).length, 2);
  assert.notEqual(ids.t1, ids.t2);
  await h.prompt("t1", "second");
  assert.equal(Object.keys(h.sessionIds()).length, 2, "same thread reuses its session");
  h.close();
});

test("cancel stops a running turn", async () => {
  const h = new Handler(fake, { permissions: "allow", timeoutMs: 5000 });
  await h.start();
  const p = h.prompt("t1", "SLEEP");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await h.cancel("t1"), true);
  const r = await p;
  assert.equal(r.stopReason, "cancelled");
  assert.equal((await h.prompt("t1", "corrected request")).text, "echo: corrected request");
  h.close();
});

test("cancel during session creation prevents the prompt and leaves the session reusable", async () => {
  const h = new Handler(fake, { permissions: "deny", timeoutMs: 5000 });
  await h.start();
  const p = h.prompt("fresh", "obsolete request");
  p.catch(() => {});
  try {
    assert.equal(await h.cancel("fresh"), true);
    assert.deepEqual(await p, {text: "", stopReason: "cancelled"});
    assert.equal((await h.prompt("fresh", "new request")).text, "echo: new request");
  } finally { h.close(); }
});

test("timeout rejects with a readable error", async () => {
  const h = new Handler(fake, { permissions: "allow", timeoutMs: 200 });
  await h.start();
  await assert.rejects(h.prompt("t1", "SLEEP"), /timed out/);
  h.close();
});

test("a missing command rejects start", async () => {
  const h = new Handler("definitely-not-a-real-binary-xyz", { permissions: "allow", timeoutMs: 1000 });
  await assert.rejects(h.start());
});

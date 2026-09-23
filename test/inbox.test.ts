import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Inbox } from "../src/inbox.ts";
import type { Message } from "../src/nostr.ts";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-inbox-"));
const m = (id: string, extra: Partial<Message> = {}): Message =>
  ({ id, thread: extra.thread ?? id, from: "a", to: "b", type: "ask", text: id, depth: 0, ts: 1, ...extra });

test("append, unread, markRead persist across instances", () => {
  const d = dir();
  const box = new Inbox(d);
  box.append(m("1"));
  box.append(m("2"));
  assert.equal(box.unread().length, 2);
  box.markRead(["1"]);
  const again = new Inbox(d);
  assert.deepEqual(again.unread().map((s) => s.id), ["2"]);
  assert.equal(again.has("1"), true);
});

test("thread returns messages in ts order", () => {
  const box = new Inbox(dir());
  box.append(m("r", { ts: 5 }));
  box.append(m("x", { thread: "r", ts: 7 }));
  box.append(m("y", { thread: "r", ts: 6 }));
  assert.deepEqual(box.thread("r").map((s) => s.id), ["r", "y", "x"]);
});

test("park and unpark by sender", () => {
  const box = new Inbox(dir());
  box.append(m("p1", { from: "stranger" }));
  box.park("p1");
  box.append(m("ok", { from: "friend" }));
  assert.deepEqual(box.parked().map((s) => s.id), ["p1"]);
  const resumed = box.unpark("stranger");
  assert.deepEqual(resumed.map((s) => s.id), ["p1"]);
  assert.equal(box.parked().length, 0);
});

test("lastSeen is the newest ts, sessions round-trip", () => {
  const d = dir();
  const box = new Inbox(d);
  assert.equal(box.lastSeen(), 0);
  box.append(m("a", { ts: 10 }));
  box.append(m("b", { ts: 4 }));
  assert.equal(box.lastSeen(), 10);
  box.saveSessions({ t1: "s1" });
  assert.deepEqual(new Inbox(d).sessions(), { t1: "s1" });
});

test("shared observations never become handler thread context", () => {
  const box = new Inbox(dir());
  box.append(m("copy", { thread: "task", type: "activity", text: "observation only" }));
  box.append(m("ask", { thread: "task", text: "real request" }));
  assert.deepEqual(box.thread("task").map(s => s.text), ["real request"]);
});

test("an interrupted final append does not lose earlier records or corrupt the next write", () => {
  const d = dir(), file = path.join(d, "inbox.jsonl");
  new Inbox(d).append(m("before", {text: "日本語"}));
  fs.appendFileSync(file, '{"id":"partial');
  const box = new Inbox(d);
  assert.deepEqual(box.all().map(s => s.id), ["before"]);
  box.append(m("after"));
  assert.deepEqual(new Inbox(d).all().map(s => s.id), ["before", "after"]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a complete final record without a newline is preserved; earlier corruption is reported", () => {
  const d = dir(), file = path.join(d, "inbox.jsonl");
  new Inbox(d).append(m("first"));
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").trimEnd());
  new Inbox(d).append(m("second"));
  assert.equal(new Inbox(d).all().length, 2);
  fs.appendFileSync(file, 'broken\n');
  assert.throws(() => new Inbox(d), /JSON|Unexpected/i);
});

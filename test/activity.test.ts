import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTimeline, attentionOf } from "../src/activity.ts";
import type { Stored } from "../src/inbox.ts";
import { npubOf } from "../src/nostr.ts";

test("encrypted owner copies preserve the author's title through receiver updates", () => {
  const message = {id: "d".repeat(64), thread: "d".repeat(64), from: "a".repeat(64), to: "b".repeat(64), type: "done", text: "Visit Mount Royal.", depth: 0, ts: 1};
  const copy = (from: string, title: string): Stored => ({...message, id: from, from, to: "c".repeat(64), type: "activity", read: true, receivedAt: 1,
    text: JSON.stringify({version: 1, updatedAt: 1, message: {...message, title}})});
  const author = copy(message.from, "Montréal chat"), receiver = copy(message.to, "Changed title");
  for (const records of [[author, receiver], [receiver, author]]) assert.equal(projectTimeline(records)[0].title, "Montréal chat");
  assert.equal(projectTimeline([copy(message.from, "x".repeat(81))])[0]?.text, message.text, "bad optional metadata cannot hide the reply");
});

test("old automatic judge-error escalations fold into the matching message's diagnostics", () => {
  const original: Stored = {id: "a".repeat(64), thread: "a".repeat(64), from: "b".repeat(64), to: "c".repeat(64),
    text: "Thanks for the chat!", type: "answer", depth: 0, ts: 1, receivedAt: 1, read: true,
    triage: {action: "escalate", confidence: 0, urgency: 1, inScope: 0, reason: "jev failed: Judge HTTP 504"}};
  const escalation: Stored = {...original, id: "d".repeat(64), from: original.to, to: "e".repeat(64), type: "escalate", triage: undefined,
    text: `escalated: jev failed: Judge HTTP 504\nfrom ${npubOf(original.from)}\nthread ${original.thread}\n\n${original.text}`};
  const human = {...escalation, id: "f".repeat(64), text: "Please investigate: jev failed: Judge HTTP 504"};
  for (const records of [[original, escalation, human], [escalation, human, original]]) {
    const messages = projectTimeline(records);
    assert.deepEqual(messages.map(m => m.id).sort(), [original.id, human.id].sort());
    assert.equal(messages.find(m => m.id === original.id)?.text, original.text);
    assert.equal(messages.find(m => m.id === original.id)?.triage?.action, "unavailable");
  }
  assert.equal(original.triage?.action, "escalate", "projection must not rewrite persisted records");
  assert.equal(projectTimeline([escalation]).length, 1, "keep an error when the affected message is missing");
  assert.equal(projectTimeline([original, {...escalation, from: "f".repeat(64)}]).length, 2, "only the actual receiver's automatic copy is folded");
});

test("owner attention preserves blockers and defaults old messages to visible", () => {
  assert.equal(attentionOf({type: "done"}), "now");
  assert.equal(attentionOf({type: "done", attention: "later"}), "later");
  assert.equal(attentionOf({type: "answer", attention: "none"}), "none");
  for (const type of ["ack", "reaction", "activity", "cancel"] as const) assert.equal(attentionOf({type}), "none");
  for (const type of ["cant", "escalate"] as const) assert.equal(attentionOf({type, attention: "none"}), "now");
  assert.equal(attentionOf({type: "ask", attention: "none", triage: {action: "escalate", confidence: 1, urgency: 1, inScope: 1, reason: "contradiction"}}), "now");
});

test("the author's attention survives receiver copies in either order", () => {
  for (const type of ["ask", "done"] as const) {
    const message = {id: "d".repeat(64), thread: "d".repeat(64), from: "a".repeat(64), to: "b".repeat(64), type, text: "result", depth: 0, ts: 1};
    const copy = (from: string, attention: string): Stored => ({...message, id: from, from, to: "c".repeat(64), type: "activity", read: true, receivedAt: 1,
      text: JSON.stringify({version: 1, updatedAt: 1, message: {...message, attention}})});
    const author = copy(message.from, "later"), receiver = copy(message.to, "none");
    assert.equal(projectTimeline([receiver])[0].attention, undefined, "a receiver cannot hide an author's message");
    for (const records of [[author, receiver], [receiver, author]]) assert.equal(projectTimeline(records)[0].attention, "later");
    const direct: Stored = {...message, attention: "now", read: false, receivedAt: 1};
    for (const records of [[direct, receiver], [receiver, direct]]) assert.equal(projectTimeline(records)[0].attention, "now");
  }
});

test("receiver's Jev decision survives two agents sharing the same request and delayed delivery", () => {
  const sender = "a".repeat(64), receiver = "b".repeat(64), owner = "c".repeat(64);
  const message = { id: "d".repeat(64), thread: "d".repeat(64), from: sender, to: receiver, type: "ask", text: "review", depth: 0, ts: 1 };
  const triage = { action: "ask", confidence: 0.99, urgency: 0, inScope: 0.97, reason: "missing code" };
  const copy = (from: string, updatedAt: number, includeDecision: boolean): Stored => ({
    id: from + updatedAt, thread: message.thread, from, to: owner, type: "activity", depth: 0, ts: 1, read: true, receivedAt: updatedAt,
    text: JSON.stringify({ version: 1, updatedAt, message: { ...message, ...(includeDecision ? { triage } : {}) } }),
  });
  const records = [copy(sender, 10, false), copy(receiver, 20, true), copy(receiver, 15, false), copy(sender, 30, false)];
  const messages = projectTimeline(records);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].triage, triage);
  assert.equal(messages[0].observedBy, sender);
});

test("invalid stored and copied timestamps cannot break the conversation view", () => {
  const invalid: Stored = { id: "a".repeat(64), thread: "a".repeat(64), from: "b".repeat(64), to: "c".repeat(64), type: "answer", text: "bad date", depth: 0, ts: 8640000000001, receivedAt: 1, read: false };
  const copy: Stored = { ...invalid, id: "d".repeat(64), type: "activity", ts: 1, text: JSON.stringify({version: 1, updatedAt: 1, message: invalid}) };
  assert.deepEqual(projectTimeline([invalid, copy]), []);
});

test("a late triage update does not move the request after its completed result", () => {
  const sender = "a".repeat(64), receiver = "b".repeat(64), owner = "c".repeat(64);
  const request = { id: "d".repeat(64), thread: "d".repeat(64), from: sender, to: receiver, type: "ask", text: "review", depth: 0, ts: 1 };
  const result = { ...request, id: "e".repeat(64), from: receiver, to: sender, type: "done", text: "finished" };
  const copy = (message: object, receivedAt: number): Stored => ({
    id: String(receivedAt), thread: request.thread, from: receiver, to: owner, type: "activity", depth: 0, ts: 1, read: true, receivedAt,
    text: JSON.stringify({version: 1, updatedAt: receivedAt, message}),
  });
  const messages = projectTimeline([copy(request, 10), copy(result, 20), copy({...request, triage: {action: "act", confidence: 1, urgency: 0, inScope: 1, reason: "clear"}}, 30)]);
  assert.deepEqual(messages.map(m => m.type), ["ask", "done"]);
});

test("a receiver's quiet decision on a result survives later author copies", () => {
  const sender = "a".repeat(64), receiver = "b".repeat(64), owner = "c".repeat(64);
  const message = { id: "d".repeat(64), thread: "e".repeat(64), from: sender, to: receiver, type: "done", text: "finished", depth: 1, ts: 1,
    verification: {status: "passed", probability: 0.9} };
  const triage = { action: "ignore", confidence: 0.99, urgency: 0, inScope: 0.9, reason: "resolved" };
  const copy = (from: string, updatedAt: number, decision?: object): Stored => ({
    id: from + updatedAt, thread: message.thread, from, to: owner, type: "activity", depth: 0, ts: 1, read: true, receivedAt: updatedAt,
    text: JSON.stringify({version: 1, updatedAt, message: {...message, ...(decision ? {triage: decision} : {})}}),
  });
  const [result] = projectTimeline([copy(sender, 10), copy(receiver, 20, triage), copy(receiver, 15, {...triage, action: "act"}), copy(sender, 30)]);
  assert.deepEqual(result.triage, triage);
  assert.deepEqual(result.verification, {status: "passed", probability: 0.9});
});

test("direct messages retain receiver decisions in either delivery order without replacing their content", () => {
  const direct: Stored = { id: "d".repeat(64), thread: "d".repeat(64), from: "a".repeat(64), to: "b".repeat(64),
    type: "answer", text: "Thanks", depth: 0, ts: 1, read: true, receivedAt: 1 };
  const triage = { action: "ignore", confidence: 0.99, urgency: 0, inScope: 0.9, reason: "resolved" };
  const steering = { action: "queue", probability: 0.1, reason: "unrelated" };
  const copy: Stored = { ...direct, id: "e".repeat(64), from: direct.to, to: direct.from, type: "activity",
    text: JSON.stringify({version: 1, updatedAt: 2, message: {...direct, text: "altered", triage, steering}}) };
  const older = { ...copy, text: JSON.stringify({version: 1, updatedAt: 1, message: {...direct, triage: {...triage, action: "act"}}}) };
  for (const records of [[direct, copy, older], [copy, older, direct]]) {
    assert.deepEqual(projectTimeline(records), [{...direct, triage, steering}]);
  }
  const forged = { ...copy, from: "f".repeat(64), text: JSON.stringify({version: 1, updatedAt: 3, message: {...direct, to: "f".repeat(64), triage}}) };
  for (const records of [[direct, forged], [forged, direct]]) {
    assert.equal(projectTimeline(records)[0].triage, undefined, "an unrelated reporter cannot claim to be the receiver");
  }
});


test("a receiver cannot disguise an author's request as a quiet control event", () => {
  const message = {id: "d".repeat(64), thread: "d".repeat(64), from: "a".repeat(64), to: "b".repeat(64), type: "ask", text: "review needed", depth: 0, ts: 1, attention: "now"};
  const triage = {action: "ask", confidence: 0.99, urgency: 1, inScope: 0.9, reason: "need details"};
  const copy = (from: string, body: object): Stored => ({...message, id: from, from, to: "c".repeat(64), type: "activity", read: true, receivedAt: 1,
    text: JSON.stringify({version: 1, updatedAt: 1, message: body}), attention: "none"});
  const author = copy(message.from, message), receiver = copy(message.to, {...message, type: "cancel", text: "hidden", triage});
  for (const records of [[author, receiver], [receiver, author]]) {
    const [result] = projectTimeline(records);
    assert.equal(result.type, "ask");
    assert.equal(result.text, "review needed");
    assert.equal(attentionOf(result), "now");
    assert.deepEqual(result.triage, triage);
  }
});

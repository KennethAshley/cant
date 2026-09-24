import { test } from "node:test";
import assert from "node:assert/strict";
import { InteractivePiHandler, type PiMessage } from "../src/pi.ts";

test("interactive Pi queues behind the owner and exports only an explicit, current request reply", async () => {
  // The bridge must not copy assistant messages or accept a reply for a cancelled request.
  let idle = false, aborts = 0;
  const received: PiMessage[] = [];
  const pi = {sendMessage: (message: PiMessage) => { received.push(message); idle = false; }};
  const ctx = {isIdle: () => idle, hasPendingMessages: () => false, abort: () => { aborts++; }, sessionManager: {getSessionId: () => "native-session"}};
  const h = new InteractivePiHandler(pi, ctx, 5000);
  try {
    await h.start();
    const first = h.prompt("thread-a", "What is Montreal known for?");
    h.flush();
    assert.equal(received.length, 0, "owner's active turn is left alone");
    idle = true; h.flush();
    assert.equal(received.length, 1);
    assert.equal(received[0].display, true);
    const request = received[0].details.request;
    assert.throws(() => h.reply("wrong-id", "private text"), /active request/);
    h.reply(request, "A city in Quebec.");
    assert.deepEqual(await first, {text: "A city in Quebec.", stopReason: "end_turn"});
    assert.throws(() => h.reply(request, "duplicate"), /active request/);
    assert.equal(await h.cancel("thread-a"), true, "Stop still aborts Pi while its submitted reply is being verified");
    assert.equal(aborts, 1);
    const next = h.prompt("thread-b", "Queued task");
    await h.cancel("thread-b");
    assert.equal((await next).stopReason, "cancelled");
    assert.equal(aborts, 1, "cancelling a queued DM does not abort the owner");
    idle = true; h.settled(); h.flush();
    const third = h.prompt("thread-c", "Cancelled task"); h.flush();
    const cancelledId = received[1].details.request;
    await h.cancel("thread-c");
    assert.equal((await third).stopReason, "cancelled");
    assert.equal(aborts, 2);
    assert.throws(() => h.reply(cancelledId, "late reply"), /active request/);
    idle = true; h.settled();
    const silent = h.prompt("thread-d", "No explicit reply"); h.flush();
    idle = true; h.settled();
    assert.deepEqual(await silent, {text: "", stopReason: "no_reply"});
    assert.equal(h.sessionIds()["thread-a"], "native-session");
  } finally { h.close(); }
});

test("interactive Pi disconnect rejects outstanding work instead of silently replaying it", async () => {
  const h = new InteractivePiHandler({sendMessage() {}}, {isIdle: () => false, hasPendingMessages: () => false, abort() {}, sessionManager: {getSessionId: () => "session"}}, 5000);
  await h.start();
  const pending = h.prompt("thread", "Waiting");
  const rejected = assert.rejects(pending, /Pi disconnected/);
  h.close();
  await rejected;
});

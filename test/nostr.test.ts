import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateNsec, secretFromNsec, pubkeyOf, npubOf, pubkeyFromNpub,
  wrap, unwrap, profileEvent, parseProfile,
} from "../src/nostr.ts";

test("nsec and npub round-trip", () => {
  const nsec = generateNsec();
  const secret = secretFromNsec(nsec);
  const pk = pubkeyOf(secret);
  assert.equal(pubkeyFromNpub(npubOf(pk)), pk);
});

test("wrap then unwrap keeps text and every tag", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const { wraps, id } = wrap(a, pubkeyOf(b), { text: "hi", type: "ask", thread: "root1", depth: 2 });
  assert.equal(wraps.length, 2, "one wrap to peer, one to self");
  const got = unwrap(wraps[0], b);
  assert.ok(got);
  assert.equal(got.id, id);
  assert.equal(got.text, "hi");
  assert.equal(got.type, "ask");
  assert.equal(got.thread, "root1");
  assert.equal(got.depth, 2);
  assert.equal(got.from, pubkeyOf(a));
  assert.equal(got.to, pubkeyOf(b));
  const self = unwrap(wraps[1], a);
  assert.equal(self?.id, id);
});

test("first message of a thread uses its own id as thread", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const { wraps, id } = wrap(a, pubkeyOf(b), { text: "start", type: "ask" });
  const got = unwrap(wraps[0], b);
  assert.equal(got?.thread, id);
  assert.equal(got?.depth, 0);
});

test("unwrap returns undefined for a wrap not addressed to me", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const c = secretFromNsec(generateNsec());
  const { wraps } = wrap(a, pubkeyOf(b), { text: "x", type: "ask" });
  assert.equal(unwrap(wraps[0], c), undefined);
});

test("unwrap rejects an unknown type", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const { wraps } = wrap(a, pubkeyOf(b), { text: "x", type: "bogus" as never });
  assert.equal(unwrap(wraps[0], b), undefined);
});

test("profile event round-trips and carries the t tag", () => {
  const a = secretFromNsec(generateNsec());
  const ev = profileEvent(a, { name: "bot", about: "does things", capabilities: ["review", "docs"] });
  assert.equal(ev.kind, 0);
  assert.ok(ev.tags.some((t) => t[0] === "t" && t[1] === "relayd"));
  const p = parseProfile(ev);
  assert.deepEqual(p, { pubkey: pubkeyOf(a), name: "bot", about: "does things", capabilities: ["review", "docs"] });
});

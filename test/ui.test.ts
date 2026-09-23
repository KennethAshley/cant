import {test} from "node:test";
import assert from "node:assert/strict";
import {threadTitle} from "../src/ui.ts";

test("thread labels use the first title, with readable opening words for old conversations", () => {
  const first = {thread: "26a7a66b", type: "ask" as const, text: "Hey Claude! Ken wants to have a little chat about Montréal."};
  assert.equal(threadTitle([first]), "Hey Claude! Ken wants to have a…");
  assert.equal(threadTitle([first, {...first, type: "done", title: "Montréal chat"}, {...first, title: "Changed"}]), "Montréal chat");
  assert.equal(threadTitle([{...first, text: "  Short\nchat  "}]), "Short chat");
  assert.equal(threadTitle([{...first, text: " "}]), "26a7a66b");
  assert.equal(threadTitle([{...first, type: "reaction", title: "Wrong", text: "👍"}, first]), "Hey Claude! Ken wants to have a…");
});

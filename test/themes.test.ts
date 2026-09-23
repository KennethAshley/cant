import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { appearanceJs, themes } from "../src/themes.ts";

function page(saved?: string, blocked = false) {
  const root = { dataset: {} as Record<string, string> };
  const controls = new Map(["theme", "color-mode", "appearance-note"].map(id => [id, Object.assign(new EventTarget(), { value: "", textContent: "" })]));
  const document = Object.assign(new EventTarget(), { documentElement: root, getElementById: (id: string) => controls.get(id) });
  const window = new EventTarget();
  const media = Object.assign(new EventTarget(), { matches: false });
  const storage = { getItem() { if (blocked) throw Error("storage unavailable"); return saved; }, setItem(_key: string, value: string) { if (blocked) throw Error("storage unavailable"); saved = value; } };
  vm.runInNewContext(appearanceJs, { document, window, localStorage: storage, matchMedia: () => media });
  return { root, controls, document, window, media, saved: () => saved };
}

test("saved appearance is restored before the page loads; invalid or blocked storage falls back", () => {
  const p = page('{"theme":"nord","mode":"light"}');
  assert.deepEqual(p.root.dataset, { theme: "nord", mode: "light" });
  for (const saved of [undefined, "broken", "null", '{"theme":"__proto__","mode":"wrong"}']) {
    assert.deepEqual(page(saved).root.dataset, { theme: "gruvbox", mode: "dark" });
  }
  assert.deepEqual(page(undefined, true).root.dataset, { theme: "gruvbox", mode: "dark" });
});

test("theme controls persist changes and System follows OS changes without losing the selected theme", () => {
  const p = page();
  p.document.dispatchEvent(new Event("DOMContentLoaded"));
  const theme = p.controls.get("theme")!, mode = p.controls.get("color-mode")!;
  theme.value = "catppuccin"; mode.value = "system";
  theme.dispatchEvent(new Event("change"));
  assert.equal(p.root.dataset.theme, "catppuccin");
  assert.equal(p.root.dataset.mode, "light");
  assert.deepEqual(JSON.parse(p.saved()!), { theme: "catppuccin", mode: "system" });
  p.media.matches = true; p.media.dispatchEvent(new Event("change"));
  assert.equal(p.root.dataset.mode, "dark");
  assert.equal(mode.value, "system");
  const blocked = page(undefined, true);
  blocked.document.dispatchEvent(new Event("DOMContentLoaded"));
  blocked.controls.get("theme")!.value = "nord";
  blocked.controls.get("theme")!.dispatchEvent(new Event("change"));
  assert.equal(blocked.root.dataset.theme, "nord");
  assert.match(blocked.controls.get("appearance-note")!.textContent, /could not.*save/i);
});

test("small text stays readable on every theme's conversation and sidebar surfaces", () => {
  const luminance = (hex: string) => {
    const c = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  };
  for (const [name, theme] of Object.entries(themes)) for (const mode of ["light", "dark"] as const) {
    const colors = theme[mode];
    for (const background of colors.slice(0, 3)) for (const text of colors.slice(4)) {
      const a = luminance(background), b = luminance(text);
      assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${name}/${mode}: ${text} on ${background}`);
    }
  }
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { baseHome, home, defaultConfig, loadConfig, saveConfig, PKG, type Config } from "./config.ts";
import { generateNsec, npubOf, pubkeyOf, secretFromNsec } from "./nostr.ts";
import { PiHandler } from "./pi.ts";

type Agent = { id: string; label: string; detail: string; handler: string; protocol: NonNullable<Config["protocol"]> };

export function discoverAgents(searchPath = process.env.PATH ?? "", piDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")): Agent[] {
  const executable = (name: string) => searchPath.split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
  });
  let model = "existing configuration";
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(piDir, "settings.json"), "utf8"));
    if (typeof settings.defaultModel === "string") model = settings.defaultModel;
  } catch { /* Pi can also be configured through environment variables. */ }
  return [
    { id: "pi", label: "Pi", detail: `${model} · interactive`, handler: "pi", protocol: "pi-interactive" as const },
    { id: "claude", label: "Claude", detail: "existing login", handler: "npx -y @agentclientprotocol/claude-agent-acp", protocol: "acp" as const },
  ].filter(a => executable(a.id));
}

export function savedAgents(root = baseHome()): { id: string; config: Config }[] {
  const entries = [{ id: "default", dir: root }];
  const dir = path.join(root, "agents");
  if (fs.existsSync(dir)) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.name) && item.name !== "default") entries.push({ id: item.name, dir: path.join(dir, item.name) });
    }
  }
  return entries.filter(e => fs.existsSync(path.join(e.dir, "config.json"))).map(e => ({ id: e.id, config: JSON.parse(fs.readFileSync(path.join(e.dir, "config.json"), "utf8")) as Config }));
}

function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function availablePort(reserved = new Set<number>(), start = 7777): Promise<number> {
  for (let port = start; port <= 65535; port++) if (!reserved.has(port) && await portFree(port)) return port;
  throw new Error("No local port available");
}

export async function agentStatus(config: Config): Promise<"running" | "starting" | "stopped" | "occupied"> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(750) });
    const health = await response.json() as { ok?: boolean; npub?: string };
    if (health.npub !== npubOf(pubkeyOf(secretFromNsec(config.nsec)))) return "occupied";
    return response.ok && health.ok ? "running" : response.status === 503 && health.ok === false ? "starting" : "occupied";
  } catch { return await portFree(config.port) ? "stopped" : "occupied"; }
}

export async function launchPi(config: Config): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive Pi needs a terminal. Run the Cant picker in your terminal.");
  if (await agentStatus(config) !== "stopped") throw new Error("This Cant identity is already running. Use its existing Pi terminal, or connect another agent.");
  await new PiHandler([config.handler], {permissions: config.acp.permissions, timeoutMs: config.timeoutMs, cwd: config.cwd}).start();
  const extension = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./pi-extension.ts" : "./pi-extension.js", import.meta.url));
  const args = ["--extension", extension];
  try {
    const session = fs.readFileSync(path.join(home(), "pi-session"), "utf8").trim();
    if (session && fs.existsSync(session)) args.push("--session", session);
  } catch { /* First launch starts a normal saved Pi session. */ }
  console.log(`\n  Opening Pi · ${plain(config.name)}\n  Identity  ${npubOf(pubkeyOf(secretFromNsec(config.nsec)))}\n  Viewer    http://localhost:${config.port}\n  Cant stays connected while this Pi session is open.\n`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.handler, args, {cwd: config.cwd, stdio: "inherit", env: {...process.env, SIDECAR_HOME: path.resolve(baseHome())}});
    // Pi owns Ctrl-C while attached to the terminal; the launcher must not exit first.
    const waitForPi = () => {};
    process.on("SIGINT", waitForPi);
    child.once("error", error => { process.off("SIGINT", waitForPi); reject(error); });
    child.once("exit", code => {
      process.off("SIGINT", waitForPi);
      if (code) reject(new Error(`Pi exited with code ${code}`)); else resolve();
    });
  });
}

// Strip control sequences from saved names/model labels before rendering them in a terminal.
const plain = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
const ochre = (s: string) => process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[38;2;215;153;33m${s}\x1b[0m` : s;

export async function choose(title: string, labels: string[]): Promise<number | undefined> {
  let selected = 0;
  const input = process.stdin;
  const output = process.stdout;
  const raw = input.isRaw;
  const render = () => {
    output.write("\r\x1b[0J");
    output.write(labels.map((s, i) => `${i === selected ? ochre("  › ") : "    "}${plain(s).slice(0, Math.max(12, (output.columns || 80) - 6))}\n`).join(""));
    output.write("\n  ↑↓ select · enter connect · esc cancel\n");
    output.write(`\x1b[${labels.length + 2}A`);
  };
  output.write(`\n  ${plain(title)}\n\n\x1b[?25l`);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  try {
    render();
    return await new Promise(resolve => {
      const onKey = (_str: string, key: { name?: string; ctrl?: boolean }) => {
        if (key.name === "up") selected = (selected + labels.length - 1) % labels.length;
        else if (key.name === "down") selected = (selected + 1) % labels.length;
        else if (key.name === "return" || key.name === "escape" || (key.ctrl && key.name === "c")) {
          input.off("keypress", onKey);
          resolve(key.name === "return" ? selected : undefined);
          return;
        }
        render();
      };
      input.on("keypress", onKey);
    });
  } finally {
    input.setRawMode(raw);
    input.pause();
    output.write("\r\x1b[0J\x1b[?25h");
  }
}

export async function picker(start: () => Promise<void>): Promise<void> {
  console.log(ochre("\n  fez / cant"));
  const saved = savedAgents();
  let selected: typeof saved[number] | undefined;
  if (process.env.SIDECAR_AGENT !== undefined) selected = saved.find(a => a.id === process.env.SIDECAR_AGENT);
  if (!selected && saved.length) {
    const statuses = await Promise.all(saved.map(a => agentStatus(a.config)));
    const index = await choose("Your agents", [...saved.map((a, i) => `${statuses[i] === "running" ? "Open" : "Start"} ${a.config.name}  ·  ${statuses[i] === "occupied" ? "port busy" : statuses[i]}`), "+ Connect another agent"]);
    if (index === undefined) return;
    selected = saved[index];
  }
  if (selected) process.env.SIDECAR_AGENT = selected.id;
  else {
    const agents = discoverAgents();
    const index = await choose("Connect an agent on this computer", [...agents.map(a => `${a.label}  ·  ${a.detail}`), "Custom ACP command…"]);
    if (index === undefined) return;
    const agent = agents[index];
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const handler = agent?.handler ?? (await rl.question("  ACP command: ")).trim();
      if (!handler) throw new Error("An ACP command is required");
      const stem = `${os.hostname().split(".")[0]}-${agent?.id ?? "agent"}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 58) || "agent";
      let suggested = stem;
      for (let suffix = 2; saved.some(a => a.id === suggested); suffix++) suggested = `${stem}-${suffix}`;
      while (true) {
        const id = (await rl.question(`  Name [${suggested}]: `)).trim() || suggested;
        try {
          if (id === "default") throw new Error("default is reserved for the original Cant");
          home(id);
          if (fs.existsSync(home(id))) throw new Error("That agent already exists; choose another name");
          process.env.SIDECAR_AGENT = id;
          break;
        } catch (e) { console.error(`  ${e instanceof Error ? e.message : e}`); }
      }
      const port = await availablePort(new Set(saved.map(a => a.config.port)));
      saveConfig(defaultConfig({ nsec: generateNsec(), name: process.env.SIDECAR_AGENT!, handler, protocol: agent?.protocol ?? "acp", cwd: process.cwd(), port }), { exclusive: true });
    } finally { rl.close(); }
  }
  const config = loadConfig();
  if (await agentStatus(config) === "occupied") {
    config.port = await availablePort(new Set(saved.map(a => a.config.port)));
    saveConfig(config);
  }
  console.log(`\n  Connecting ${plain(config.name)}…`);
  if (config.protocol === "pi-interactive") { await launchPi(config); return; }
  await start();
  const url = `http://localhost:${config.port}`;
  console.log(`\n  Name      ${plain(config.name)}\n  Identity  ${npubOf(pubkeyOf(secretFromNsec(config.nsec)))}\n  Relay     ${config.relays.join(", ")}\n  Chat      ${url}\n\n  ${ochre("●")} Running\n`);
  console.log(`  Manage: npx ${PKG} --agent ${process.env.SIDECAR_AGENT} inbox\n`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (opener) { const child = spawn(opener, [url], { stdio: "ignore", detached: true }); child.on("error", () => {}); child.unref(); }
}

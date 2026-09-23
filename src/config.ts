import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NAME = "sidecar";
export const PKG = "@fezchat/sidecar";

export type RespondTo = "owner" | "allowlist" | "anyone" | "nobody";

export interface Config {
  nsec: string;
  relays: string[];
  name: string;
  about: string;
  capabilities: string[];
  owner?: string;
  /** Explicitly share encrypted conversation copies with the configured owner. */
  share_activity?: boolean;
  /** Shared Jev gateway; this is a client credential, never the TypeSafe provider key. */
  judge?: { url: string; key: string };
  handler: string;
  protocol?: "acp" | "pi";
  /** Working directory captured during interactive setup. */
  cwd?: string;
  acp: { permissions: "allow" | "deny" };
  notify: string;
  respond_to: RespondTo;
  allow: string[];
  thresholds: { act: number; ask: number; route: number };
  depthLimit: number;
  timeoutMs: number;
  port: number;
}

export function baseHome(): string {
  return process.env.SIDECAR_HOME ?? path.join(os.homedir(), `.${NAME}`);
}

export function home(agent = process.env.SIDECAR_AGENT): string {
  if (agent === undefined || agent === "default") return baseHome();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent)) throw new Error("agent name must be 1–64 lowercase letters, numbers, hyphens or underscores");
  return path.join(baseHome(), "agents", agent);
}

export function defaultConfig(overrides: Partial<Config> & { nsec: string; name: string }): Config {
  return {
    relays: ["wss://relay.fez.chat"],
    about: "",
    capabilities: [],
    handler: "npx -y @agentclientprotocol/claude-agent-acp",
    acp: { permissions: "allow" },
    notify:
      process.platform === "darwin"
        ? `osascript -e 'display notification "$MSG" with title "${NAME}"'`
        : "",
    respond_to: "allowlist",
    allow: [],
    thresholds: { act: 0.85, ask: 0.5, route: 0.6 },
    depthLimit: 3,
    timeoutMs: 20 * 60_000,
    port: 7777,
    ...overrides,
  };
}

const file = () => path.join(home(), "config.json");

export function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Config;
  } catch {
    throw new Error(`no config at ${file()}. Run: npx ${PKG} init`);
  }
}

export function saveConfig(c: Config, options: { exclusive?: boolean } = {}): void {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(c, null, 2) + "\n", { mode: 0o600, flag: options.exclusive ? "wx" : "w" });
  fs.chmodSync(file(), 0o600);
}

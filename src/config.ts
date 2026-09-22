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
  handler: string;
  acp: { permissions: "allow" | "deny" };
  notify: string;
  respond_to: RespondTo;
  allow: string[];
  thresholds: { act: number; ask: number; route: number };
  depthLimit: number;
  timeoutMs: number;
  port: number;
}

export function home(): string {
  return process.env.SIDECAR_HOME ?? path.join(os.homedir(), `.${NAME}`);
}

export function defaultConfig(overrides: Partial<Config> & { nsec: string; name: string }): Config {
  return {
    relays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"],
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

export function saveConfig(c: Config): void {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file(), 0o600);
}

import fs from "node:fs";
import path from "node:path";
import { home } from "./config.ts";
import type { Message } from "./nostr.ts";
import type { Triage } from "./decide.ts";

export interface Stored extends Message {
  receivedAt: number;
  read: boolean;
  parked?: boolean;
  triage?: Triage;
}

type Line = Stored | { id: string; patch: Partial<Stored> };

/** Append-only inbox.jsonl: full records plus {id, patch} lines folded in on load. Safe for concurrent CLI reads. */
export class Inbox {
  private file: string;
  private sessionsFile: string;
  private items = new Map<string, Stored>();

  constructor(dir: string = home()) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "inbox.jsonl");
    this.sessionsFile = path.join(dir, "sessions.json");
    if (fs.existsSync(this.file)) {
      for (const raw of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!raw) continue;
        const line = JSON.parse(raw) as Line;
        if ("patch" in line) {
          const cur = this.items.get(line.id);
          if (cur) Object.assign(cur, line.patch);
        } else {
          this.items.set(line.id, line);
        }
      }
    }
  }

  private write(line: Line): void {
    fs.appendFileSync(this.file, JSON.stringify(line) + "\n");
  }

  append(m: Message, extra: Partial<Stored> = {}): Stored {
    const s: Stored = { ...m, receivedAt: Date.now(), read: false, ...extra };
    this.items.set(s.id, s);
    this.write(s);
    return s;
  }

  private patch(id: string, patch: Partial<Stored>): void {
    const cur = this.items.get(id);
    if (!cur) return;
    Object.assign(cur, patch);
    this.write({ id, patch });
  }

  has(id: string): boolean { return this.items.has(id); }
  all(): Stored[] { return [...this.items.values()].sort((a, b) => a.ts - b.ts); }
  unread(): Stored[] { return this.all().filter((s) => !s.read); }
  markRead(ids: string[]): void { for (const id of ids) this.patch(id, { read: true }); }
  setTriage(id: string, triage: Triage): void { this.patch(id, { triage }); }
  park(id: string): void { this.patch(id, { parked: true }); }
  thread(id: string): Stored[] { return this.all().filter((s) => s.thread === id); }
  parked(): Stored[] { return this.all().filter((s) => s.parked); }
  unpark(from: string): Stored[] {
    const out = this.parked().filter((s) => s.from === from);
    for (const s of out) this.patch(s.id, { parked: false });
    return out;
  }
  lastSeen(): number { return Math.max(0, ...[...this.items.values()].map((s) => s.ts)); }

  sessions(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.sessionsFile, "utf8")); } catch { return {}; }
  }
  saveSessions(s: Record<string, string>): void {
    fs.writeFileSync(this.sessionsFile, JSON.stringify(s));
  }
}

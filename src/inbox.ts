import fs from "node:fs";
import path from "node:path";
import { home } from "./config.ts";
import type { Message } from "./nostr.ts";
import type { Event } from "nostr-tools/pure";
import type { Triage, Steering } from "./decide.ts";

export interface Stored extends Message {
  receivedAt: number;
  read: boolean;
  parked?: boolean;
  triage?: Triage;
  steering?: Steering;
  delivery?: "pending" | "sent";
  work?: "pending" | "preparing" | "running" | "finished" | "interrupted";
}

type Completion = { id: string; state: "finished" | "interrupted" };
type Line = Stored | { id: string; patch: Partial<Stored> } | { outgoing: Stored; wraps: Event[]; complete?: Completion };

/** Append-only inbox.jsonl: full records plus {id, patch} lines folded in on load. Safe for concurrent CLI reads. */
export class Inbox {
  private file: string;
  private sessionsFile: string;
  private items = new Map<string, Stored>();
  private pending = new Map<string, Event[]>();
  private tail?: { size: number; truncate?: number; newline?: boolean };

  constructor(dir: string = home()) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "inbox.jsonl");
    this.sessionsFile = path.join(dir, "sessions.json");
    if (fs.existsSync(this.file)) {
      const data = fs.readFileSync(this.file);
      const lines = data.toString("utf8").split("\n");
      for (const [index, raw] of lines.entries()) {
        if (!raw) continue;
        let line: Line;
        try { line = JSON.parse(raw) as Line; }
        catch (error) {
          if (index !== lines.length - 1) throw error;
          // Readers ignore only an incomplete tail. The single writer repairs it before appending.
          this.tail = { size: data.length, truncate: data.lastIndexOf(10) + 1 };
          break;
        }
        if (index === lines.length - 1) this.tail = { size: data.length, newline: true };
        this.apply(line);
      }
    }
  }

  private apply(line: Line): void {
    if ("outgoing" in line) {
      this.items.set(line.outgoing.id, line.outgoing);
      this.pending.set(line.outgoing.id, line.wraps);
      if (line.complete) {
        const source = this.items.get(line.complete.id);
        if (source) source.work = line.complete.state;
      }
    } else if ("patch" in line) {
      const cur = this.items.get(line.id);
      if (cur) Object.assign(cur, line.patch);
      if (line.patch.delivery === "sent") this.pending.delete(line.id);
    } else this.items.set(line.id, line);
  }

  private write(line: Line): void {
    if (this.tail && fs.statSync(this.file).size !== this.tail.size) throw new Error("inbox changed while recovering its final record; reopen it");
    if (this.tail?.truncate !== undefined) fs.truncateSync(this.file, this.tail.truncate);
    fs.appendFileSync(this.file, (this.tail?.newline ? "\n" : "") + JSON.stringify(line) + "\n", { mode: 0o600, flush: true });
    this.tail = undefined;
    this.apply(line);
  }

  append(m: Message, extra: Partial<Stored> = {}): Stored {
    const s: Stored = { ...m, receivedAt: Date.now(), read: false, ...extra };
    this.write(s);
    return s;
  }

  private patch(id: string, patch: Partial<Stored>): void {
    const cur = this.items.get(id);
    if (!cur) return;
    if (Object.entries(patch).every(([key, value]) => cur[key as keyof Stored] === value)) return;
    this.write({ id, patch });
  }

  /** Result, original ciphertext, and work completion share one durable log record. */
  enqueue(m: Message, wraps: Event[], complete?: Completion): void {
    this.write({ outgoing: { ...m, receivedAt: Date.now(), read: true, delivery: "pending" }, wraps, complete });
  }
  outbox(): [string, Event[]][] { return [...this.pending]; }
  delivered(id: string): void { this.patch(id, { delivery: "sent" }); }
  setWork(id: string, work: Stored["work"]): void { this.patch(id, { work }); }

  has(id: string): boolean { return this.items.has(id); }
  get(id: string): Stored | undefined { return this.items.get(id); }
  all(): Stored[] { return [...this.items.values()].sort((a, b) => a.ts - b.ts); }
  unread(): Stored[] { return this.all().filter((s) => !s.read); }
  markRead(ids: string[]): void { for (const id of ids) this.patch(id, { read: true }); }
  setTriage(id: string, triage: Triage): void { this.patch(id, { triage }); }
  setSteering(id: string, steering: Steering): void { this.patch(id, { steering }); }
  park(id: string): void { this.patch(id, { parked: true }); }
  thread(id: string): Stored[] { return this.all().filter((s) => s.thread === id && s.type !== "activity"); }
  parked(): Stored[] { return this.all().filter((s) => s.parked); }
  unpark(from: string): Stored[] {
    const out = this.parked().filter((s) => s.from === from && s.work !== "finished" && s.work !== "interrupted");
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

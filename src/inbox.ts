import fs from "node:fs";
import path from "node:path";
import { home } from "./config.ts";
import type { Message, ReviewAction } from "./nostr.ts";
import type { Event } from "nostr-tools/pure";
import type { Triage, Steering } from "./decide.ts";

export interface Stored extends Message {
  receivedAt: number;
  read: boolean;
  parked?: boolean;
  triage?: Triage;
  steering?: Steering;
  withheld?: {text: string; reason: string};
  review?: {action: ReviewAction; by: string};
  delivery?: "pending" | "sent";
  work?: "pending" | "preparing" | "running" | "finished" | "interrupted";
}

type Completion = { id: string; state: "finished" | "interrupted" };
type ControlState = { thread: string; from: string; at: number; id: string; paused: boolean; work?: {id: string; work: Stored["work"]}[] };
type Line = Stored | { id: string; patch: Partial<Stored> } | { outgoing: Stored; wraps: Event[]; complete?: Completion } | {threadControl: ControlState};

/** Append-only inbox.jsonl: full records plus {id, patch} lines folded in on load. Safe for concurrent CLI reads. */
export class Inbox {
  private file: string;
  private sessionsFile: string;
  private items = new Map<string, Stored>();
  private pending = new Map<string, Event[]>();
  private controls = new Map<string, {paused: boolean; versions: Map<string, {at: number; id: string}>}>();
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
    if ("threadControl" in line) {
      const c = line.threadControl;
      const state = this.controls.get(c.thread) ?? {paused: false, versions: new Map()};
      state.paused = c.paused;
      state.versions.set(c.from, {at: c.at, id: c.id});
      this.controls.set(c.thread, state);
      for (const update of c.work ?? []) {
        const message = this.items.get(update.id);
        if (message) message.work = update.work;
      }
      const command = this.items.get(c.id);
      if (command) command.work = "finished";
    } else if ("outgoing" in line) {
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
  setReview(id: string, review: NonNullable<Stored["review"]>): void {
    // Approval and pending work share one durable write; replay cannot grant another turn.
    this.patch(id, {review, parked: false, work: review.action === "approve" ? "pending" : "finished"});
  }

  isPaused(thread: string): boolean { return this.controls.get(thread)?.paused ?? false; }
  setThreadControl(thread: string, from: string, at: number, id: string, paused: boolean, action?: "stop" | "pause" | "resume"): boolean {
    const previous = this.controls.get(thread)?.versions.get(from);
    if (previous && (at < previous.at || (at === previous.at && id <= previous.id))) return false;
    // State and cancellation are one durable write: a crash must not revive stopped work.
    const work = action && action !== "resume" ? this.thread(thread)
      .filter(s => ["pending", "preparing", "running"].includes(s.work ?? ""))
      .map(s => ({id: s.id, work: action === "pause" && s.work !== "running" ? "pending" as const : "finished" as const})) : [];
    this.write({threadControl: {thread, from, at, id, paused, work}});
    return true;
  }

  has(id: string): boolean { return this.items.has(id); }
  get(id: string): Stored | undefined { return this.items.get(id); }
  all(): Stored[] { return [...this.items.values()].sort((a, b) => a.ts - b.ts); }
  unread(): Stored[] { return this.all().filter((s) => !s.read); }
  markRead(ids: string[]): void { for (const id of ids) this.patch(id, { read: true }); }
  setTriage(id: string, triage: Triage): void { this.patch(id, { triage }); }
  setSteering(id: string, steering: Steering): void { this.patch(id, { steering }); }
  setWithheld(id: string, withheld: Stored["withheld"]): void { this.patch(id, { withheld }); }
  park(id: string): void { this.patch(id, { parked: true }); }
  thread(id: string): Stored[] { return this.all().filter((s) => s.thread === id && !["activity", "control"].includes(s.type)); }
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

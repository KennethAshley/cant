import { z } from "zod";
import { MESSAGE_TYPES, verificationSchema, attentionSchema, validTimestamp, type Attention } from "./nostr.ts";
import type { Stored } from "./inbox.ts";

const key = z.string().regex(/^[0-9a-f]{64}$/);
const probability = z.number().min(0).max(1);
const activitySchema = z.object({
  version: z.literal(1), updatedAt: z.number().int().nonnegative(),
  message: z.object({
    id: key, thread: z.string().min(1).max(128), from: key, to: key,
    type: z.enum([...MESSAGE_TYPES, "reaction"]), text: z.string().max(131072),
    depth: z.number().int().nonnegative(), ts: z.number().refine(validTimestamp),
    reactionTo: key.optional(), verification: verificationSchema.optional(), attention: attentionSchema.catch("now").optional(),
    triage: z.object({
      action: z.enum(["act", "ask", "ignore", "escalate"]), confidence: probability,
      urgency: z.number().int().min(0).max(3), inScope: probability, contradiction: probability.optional(), reason: z.string().max(2000),
    }).optional(),
    steering: z.object({
      action: z.enum(["interrupt", "queue"]), probability: probability.optional(), reason: z.string().max(2000),
    }).optional(),
  }),
});

export type TimelineMessage = Stored & { observedBy?: string };

/** Owner presentation only. Missing labels stay visible; blockers cannot be silenced. */
export function attentionOf(m: Pick<Stored, "type" | "attention" | "triage" | "parked" | "verification">): Attention {
  if (m.type === "cant" || m.type === "escalate" || m.parked || m.triage?.action === "escalate" || ["failed", "unavailable"].includes(m.verification?.status ?? "")) return "now";
  if (["ack", "reaction", "activity", "cancel"].includes(m.type)) return "none";
  return m.attention ?? "now";
}

/** Copies stay observations: never insert them into the recipient's dispatch inbox. */
export function projectTimeline(records: Stored[]): TimelineMessage[] {
  const messages = new Map<string, TimelineMessage>();
  const revisions = new Map<string, number>();
  for (const record of records) {
    if (!validTimestamp(record.ts)) continue;
    if (record.type !== "activity") {
      const observed = messages.get(record.id);
      const matches = observed?.from === record.from && observed.to === record.to && observed.thread === record.thread;
      const triage = record.triage ?? (matches ? observed.triage : undefined);
      const steering = record.steering ?? (matches ? observed.steering : undefined);
      messages.set(record.id, { ...record, ...(triage ? {triage} : {}), ...(steering ? {steering} : {}) });
      continue;
    }
    try {
      const { message, updatedAt } = activitySchema.parse(JSON.parse(record.text));
      if (message.thread !== record.thread || (record.from !== message.from && record.from !== message.to)) continue;
      const existing = messages.get(message.id);
      if (existing && (existing.from !== message.from || existing.to !== message.to || existing.thread !== message.thread)) continue;
      // The receiver owns decisions; the author owns content, type, and attention.
      const preferredReporter = message.from;
      const revisionKey = message.id + ":" + record.from;
      if (updatedAt < (revisions.get(revisionKey) ?? 0)) continue;
      revisions.set(revisionKey, updatedAt);
      const triage = record.from === message.to ? message.triage : existing?.triage;
      const steering = record.from === message.to ? message.steering ?? existing?.steering : existing?.steering;
      const attention = record.from === message.from ? message.attention : existing?.attention;
      const decisions = { ...(triage ? {triage} : {}), ...(steering ? {steering} : {}) };
      if (existing && !existing.observedBy) {
        if (record.from === existing.to) messages.set(message.id, { ...existing, ...decisions });
        continue;
      }
      if (existing?.observedBy !== undefined && existing.observedBy !== record.from && record.from !== preferredReporter) {
        messages.set(message.id, { ...existing, ...decisions, attention });
        continue;
      }
      messages.set(message.id, { ...message, triage, steering, attention, read: true, receivedAt: existing?.receivedAt ?? record.receivedAt, observedBy: record.from });
    } catch { /* Unknown versions and malformed copies are not conversation messages. */ }
  }
  return [...messages.values()].sort((a, b) => a.ts - b.ts || a.receivedAt - b.receivedAt);
}

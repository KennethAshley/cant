import { z } from "zod";
import { MESSAGE_TYPES, verificationSchema, attentionSchema, titleSchema, reviewActionSchema, validTimestamp, npubOf, type Attention } from "./nostr.ts";
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
    title: titleSchema.optional().catch(undefined),
    withheld: z.object({text: z.string().max(100_000), reason: z.string().max(2000)}).optional(),
    review: z.object({action: reviewActionSchema, by: key}).optional(),
    triage: z.object({
      action: z.enum(["act", "ask", "ignore", "escalate", "unavailable"]), confidence: probability,
      urgency: z.number().int().min(0).max(3), inScope: probability, contradiction: probability.optional(), reason: z.string().max(2000),
    }).optional(),
    steering: z.object({
      action: z.enum(["interrupt", "queue"]), probability: probability.optional(), reason: z.string().max(2000),
    }).optional(),
  }),
});

export type TimelineMessage = Stored & { observedBy?: string };

export function needsReview(m: Stored): boolean {
  return ["ask", "answer"].includes(m.type) && !m.review && !m.withheld && !["preparing", "running", "interrupted"].includes(m.work ?? "") &&
    !!(m.parked || ["escalate", "unavailable"].includes(m.triage?.action ?? ""));
}

/** Owner presentation only. Missing labels stay visible; blockers cannot be silenced. */
export function attentionOf(m: Pick<Stored, "type" | "attention" | "triage" | "parked" | "verification" | "work" | "withheld">): Attention {
  if (m.withheld || m.type === "cant" || m.type === "escalate" || m.parked || m.work === "interrupted" || ["escalate", "unavailable"].includes(m.triage?.action ?? "") || ["failed", "unavailable"].includes(m.verification?.status ?? "")) return "now";
  if (["ack", "reaction", "activity", "control", "cancel"].includes(m.type)) return "none";
  return m.attention ?? "now";
}

/** Copies stay observations: never insert them into the recipient's dispatch inbox. */
export function projectTimeline(records: Stored[]): TimelineMessage[] {
  const messages = new Map<string, TimelineMessage>();
  const revisions = new Map<string, number>();
  for (const record of records) {
    if (record.type === "control") continue;
    if (!validTimestamp(record.ts)) continue;
    if (record.type !== "activity") {
      const observed = messages.get(record.id);
      const matches = observed?.from === record.from && observed.to === record.to && observed.thread === record.thread;
      const triage = record.triage ?? (matches ? observed.triage : undefined);
      const steering = record.steering ?? (matches ? observed.steering : undefined);
      const withheld = record.withheld ?? (matches ? observed.withheld : undefined);
      const review = record.review ?? (matches ? observed.review : undefined);
      messages.set(record.id, { ...record, ...(review ? {review} : {}), ...(withheld ? {withheld} : {}), ...(triage ? {triage} : {}), ...(steering ? {steering} : {}) });
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
      const withheld = record.from === message.to ? message.withheld ?? existing?.withheld : existing?.withheld;
      const review = record.from === message.to ? existing?.review ?? message.review : existing?.review;
      const attention = record.from === message.from ? message.attention : existing?.attention;
      const decisions = { ...(review ? {review} : {}), ...(withheld ? {withheld} : {}), ...(triage ? {triage} : {}), ...(steering ? {steering} : {}) };
      if (existing && !existing.observedBy) {
        if (record.from === existing.to) messages.set(message.id, { ...existing, ...decisions });
        continue;
      }
      if (existing?.observedBy !== undefined && existing.observedBy !== record.from && record.from !== preferredReporter) {
        messages.set(message.id, { ...existing, ...decisions, attention });
        continue;
      }
      messages.set(message.id, { ...message, triage, steering, withheld, review, attention, read: true, receivedAt: existing?.receivedAt ?? record.receivedAt, observedBy: record.from });
    } catch { /* Unknown versions and malformed copies are not conversation messages. */ }
  }
  // Older clients sent the same diagnostic as an owner DM. Fold only exact
  // receiver-authored copies into the affected message; keep the stored events.
  const legacyErrors = new Set<string>();
  for (const message of messages.values()) {
    const t = message.triage;
    if (t?.action !== "escalate" || !t.reason.startsWith("jev failed: ")) continue;
    message.triage = {...t, action: "unavailable"};
    legacyErrors.add(`${message.to}\n${message.thread}\nescalated: ${t.reason}\nfrom ${npubOf(message.from)}\nthread ${message.thread}\n\n${message.text}`);
  }
  return [...messages.values()]
    .filter(m => m.type !== "escalate" || !legacyErrors.has(`${m.from}\n${m.thread}\n${m.text}`))
    .sort((a, b) => a.ts - b.ts || a.receivedAt - b.receivedAt);
}

// Append-only audit log (ARCHITECTURE §27). Important rows are mirrored to #audit-log.
import { type Actor, actorId, actorKind } from '../core/types.js';
import type { Q } from '../db/pool.js';
import { enqueue } from './jobs.js';

export interface AuditEntry {
  actor: Actor;
  action: string;
  objectType: string;
  objectId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  source: 'DISCORD' | 'WEBHOOK' | 'JOB' | 'CLAUDEBOT' | 'CLI';
  important?: boolean;
  requestId?: string | null;
}

export async function audit(q: Q, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (actor_user_id, actor_kind, action, object_type, object_id, old_value, new_value, reason, source, request_id, important)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [actorId(e.actor), actorKind(e.actor), e.action, e.objectType, e.objectId ?? null, json(e.oldValue), json(e.newValue), e.reason ?? null, e.source, e.requestId ?? null, !!e.important],
  );
  if (e.important) {
    await enqueue(q, 'discord.audit', { action: e.action, objectType: e.objectType, objectId: e.objectId ?? null, actorKind: actorKind(e.actor), actorUserId: actorId(e.actor), reason: e.reason ?? null, newValue: e.newValue ?? null });
  }
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

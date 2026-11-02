/**
 * Fila de envio: processa eventos pendentes com novas tentativas e backoff.
 */
import type { DB } from './db.js';
import { now } from './db.js';
import { sendEvent, type EventContext, type SendResult } from './integrations/platforms.js';
import type { Click, Client, Contact, Sale, TrackEvent } from './types.js';

const BACKOFF_S = [60, 300, 1800, 7200, 21600];

export function loadContext(db: DB, event: TrackEvent): EventContext | null {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(event.client_id) as Client | undefined;
  const contact = event.contact_id
    ? (db.prepare('SELECT * FROM contacts WHERE id = ?').get(event.contact_id) as Contact | undefined)
    : undefined;
  if (!client || !contact) return null;
  const click = contact.click_id
    ? ((db.prepare('SELECT * FROM clicks WHERE id = ?').get(contact.click_id) as Click | undefined) ?? null)
    : null;
  const sale = event.sale_id ? ((db.prepare('SELECT * FROM sales WHERE id = ?').get(event.sale_id) as Sale | undefined) ?? null) : null;
  return { event, client, contact, click, sale };
}

function save(db: DB, ev: TrackEvent, r: SendResult): void {
  const attempts = ev.attempts + 1;
  let status: TrackEvent['status'] = r.status;
  let next = now();
  if (r.status === 'error' && !r.permanent && attempts <= BACKOFF_S.length) {
    status = 'pending';
    next = now() + BACKOFF_S[attempts - 1];
  }
  db.prepare(
    `UPDATE events SET status = ?, attempts = ?, next_attempt_at = ?, detail = ?, request = ?, response = ?,
       sent_at = CASE WHEN ? = 'sent' THEN unixepoch() ELSE sent_at END
     WHERE id = ?`,
  ).run(
    status, attempts, next, r.detail ?? null,
    r.request ? JSON.stringify(r.request) : null,
    r.response ? JSON.stringify(r.response) : null,
    status, ev.id,
  );
}

export async function processEvent(db: DB, ev: TrackEvent): Promise<SendResult> {
  const ctx = loadContext(db, ev);
  let result: SendResult;
  if (!ctx) result = { status: 'skipped', detail: 'Contato/cliente removido' };
  else if (!ctx.client.active) result = { status: 'skipped', detail: 'Cliente inativo' };
  else {
    try {
      result = await sendEvent(ctx);
    } catch (err) {
      result = { status: 'error', detail: (err as Error).message };
    }
  }
  save(db, ev, result);
  return result;
}

export async function runDispatcherOnce(db: DB, limit = 50): Promise<number> {
  const pending = db
    .prepare(`SELECT * FROM events WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`)
    .all(now(), limit) as TrackEvent[];
  for (const ev of pending) await processEvent(db, ev);
  return pending.length;
}

export function startDispatcher(db: DB, intervalMs: number, log: (msg: string) => void): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await runDispatcherOnce(db);
      if (n) log(`dispatcher: ${n} evento(s) processado(s)`);
    } catch (err) {
      log(`dispatcher erro: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

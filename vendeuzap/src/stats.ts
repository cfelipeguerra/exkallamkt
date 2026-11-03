import type { DB } from './db.js';
import { now } from './db.js';

export interface Breakdown {
  name: string;
  leads: number;
  sales: number;
  revenue: number;
}

export interface ClientStats {
  days: number;
  leads: number;
  qualified: number;
  customers: number;
  sales: number;
  revenue: number;
  ticket: number;
  conversion: number;
  bySource: (Breakdown & { source: string })[];
  byCampaign: Breakdown[];
  eventsSent: number;
  eventsFailed: number;
  eventsPending: number;
}

export function clientStats(db: DB, clientId: number, days = 30): ClientStats {
  const since = now() - days * 86400;
  const funnel = db
    .prepare(
      `SELECT COUNT(*) leads,
              SUM(CASE WHEN status IN ('qualified','customer') THEN 1 ELSE 0 END) qualified
       FROM contacts WHERE client_id = ? AND first_message_at >= ? AND messages_in > 0`,
    )
    .get(clientId, since) as { leads: number; qualified: number | null };
  const s = db
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(value),0) v, COUNT(DISTINCT contact_id) c
       FROM sales WHERE client_id = ? AND created_at >= ?`,
    )
    .get(clientId, since) as { n: number; v: number; c: number };

  const bySource = db
    .prepare(
      `SELECT c.source, c.source name, COUNT(DISTINCT c.id) leads, COUNT(s.id) sales, COALESCE(SUM(s.value),0) revenue
       FROM contacts c LEFT JOIN sales s ON s.contact_id = c.id AND s.created_at >= ?
       WHERE c.client_id = ? AND (c.first_message_at >= ? OR s.id IS NOT NULL) AND c.messages_in > 0
       GROUP BY c.source ORDER BY revenue DESC, leads DESC`,
    )
    .all(since, clientId, since) as ClientStats['bySource'];

  // Campanha: utm_campaign do clique ou título/ID do anúncio (CTWA)
  const byCampaign = db
    .prepare(
      `SELECT COALESCE(k.utm_campaign, c.ad_title, c.ad_source_id) name,
              COUNT(DISTINCT c.id) leads, COUNT(s.id) sales, COALESCE(SUM(s.value),0) revenue
       FROM contacts c
       LEFT JOIN clicks k ON k.id = c.click_id
       LEFT JOIN sales s ON s.contact_id = c.id AND s.created_at >= ?
       WHERE c.client_id = ? AND (c.first_message_at >= ? OR s.id IS NOT NULL) AND c.messages_in > 0
         AND COALESCE(k.utm_campaign, c.ad_title, c.ad_source_id) IS NOT NULL
       GROUP BY name ORDER BY revenue DESC, leads DESC LIMIT 8`,
    )
    .all(since, clientId, since) as Breakdown[];

  const ev = db
    .prepare(
      `SELECT SUM(status = 'sent') sent, SUM(status = 'error') failed, SUM(status = 'pending') pending
       FROM events WHERE client_id = ? AND created_at >= ?`,
    )
    .get(clientId, since) as { sent: number | null; failed: number | null; pending: number | null };

  return {
    days,
    leads: funnel.leads,
    qualified: funnel.qualified ?? 0,
    customers: s.c,
    sales: s.n,
    revenue: s.v,
    ticket: s.n ? s.v / s.n : 0,
    conversion: funnel.leads ? Math.min(1, s.c / funnel.leads) : 0,
    bySource,
    byCampaign,
    eventsSent: ev.sent ?? 0,
    eventsFailed: ev.failed ?? 0,
    eventsPending: ev.pending ?? 0,
  };
}

/** Conversões com falha que ainda não foram resolvidas (todas as datas). */
export const failedEvents = (db: DB, clientId: number): number =>
  (db.prepare(`SELECT COUNT(DISTINCT event_id) n FROM events WHERE client_id = ? AND status = 'error'`).get(clientId) as { n: number }).n;

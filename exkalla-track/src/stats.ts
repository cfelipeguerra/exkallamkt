import type { DB } from './db.js';
import { now } from './db.js';

export interface ClientStats {
  leads: number;
  customers: number;
  sales: number;
  revenue: number;
  conversion: number;
  bySource: { source: string; leads: number; sales: number; revenue: number }[];
  byCampaign: { campaign: string; leads: number; sales: number; revenue: number }[];
  events: { status: string; n: number }[];
}

export function clientStats(db: DB, clientId: number, days = 30): ClientStats {
  const since = now() - days * 86400;
  const leads = (
    db.prepare(`SELECT COUNT(*) n FROM contacts WHERE client_id = ? AND first_message_at >= ? AND messages_in > 0`).get(clientId, since) as { n: number }
  ).n;
  const s = db
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(value),0) v, COUNT(DISTINCT contact_id) c FROM sales WHERE client_id = ? AND created_at >= ?`)
    .get(clientId, since) as { n: number; v: number; c: number };

  const bySource = db
    .prepare(
      `SELECT c.source, COUNT(DISTINCT c.id) leads,
              COUNT(s.id) sales, COALESCE(SUM(s.value),0) revenue
       FROM contacts c LEFT JOIN sales s ON s.contact_id = c.id AND s.created_at >= ?
       WHERE c.client_id = ? AND (c.first_message_at >= ? OR s.id IS NOT NULL) AND c.messages_in > 0
       GROUP BY c.source ORDER BY revenue DESC, leads DESC`,
    )
    .all(since, clientId, since) as ClientStats['bySource'];

  // Campanha: utm_campaign do clique ou título/ID do anúncio (CTWA)
  const byCampaign = db
    .prepare(
      `SELECT COALESCE(k.utm_campaign, c.ad_title, c.ad_source_id, '(sem campanha)') campaign,
              COUNT(DISTINCT c.id) leads, COUNT(s.id) sales, COALESCE(SUM(s.value),0) revenue
       FROM contacts c
       LEFT JOIN clicks k ON k.id = c.click_id
       LEFT JOIN sales s ON s.contact_id = c.id AND s.created_at >= ?
       WHERE c.client_id = ? AND (c.first_message_at >= ? OR s.id IS NOT NULL) AND c.messages_in > 0 AND c.source <> 'organic'
       GROUP BY campaign ORDER BY revenue DESC, leads DESC LIMIT 20`,
    )
    .all(since, clientId, since) as ClientStats['byCampaign'];

  const events = db
    .prepare(`SELECT status, COUNT(*) n FROM events WHERE client_id = ? AND created_at >= ? GROUP BY status`)
    .all(clientId, since) as ClientStats['events'];

  return {
    leads,
    customers: s.c,
    sales: s.n,
    revenue: s.v,
    conversion: leads ? s.c / leads : 0,
    bySource,
    byCampaign,
    events,
  };
}

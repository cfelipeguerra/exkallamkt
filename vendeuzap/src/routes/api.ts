import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { DB } from '../db.js';
import { now } from '../db.js';
import { parseEvolutionWebhook } from '../integrations/evolution.js';
import { normalizePhone, parseMoney } from '../lib/util.js';
import { handleEvolutionEvent, registerSale } from '../tracking.js';
import type { Client, Contact } from '../types.js';

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function clientByApiToken(db: DB, req: FastifyRequest): Client | undefined {
  const auth = String(req.headers.authorization || '');
  const tokenValue = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-token'] || '');
  if (!tokenValue) return undefined;
  const c = db.prepare('SELECT * FROM clients WHERE api_token = ?').get(tokenValue) as Client | undefined;
  return c && safeEq(c.api_token, tokenValue) ? c : undefined;
}

/** Horário em UTC sem sufixo; o fuso vai na linha "Parameters:TimeZone=+0000". */
const csvTime = (epochS: number): string => new Date(epochS * 1000).toISOString().slice(0, 19).replace('T', ' ');

const csvCell = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function registerApiRoutes(app: FastifyInstance, db: DB): void {
  /** Webhook da Evolution API. A URL contém um token secreto por cliente. */
  app.post('/webhooks/evolution/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const client = db.prepare('SELECT * FROM clients WHERE webhook_token = ?').get(token) as Client | undefined;
    if (!client) return reply.code(404).send({ ok: false });
    if (!client.active) return { ok: true, skipped: 'cliente inativo' };
    db.prepare('UPDATE clients SET last_webhook_at = unixepoch() WHERE id = ?').run(client.id);

    const body = req.body as { instance?: string };
    if (body?.instance && body.instance !== client.evolution_instance) {
      req.log.warn({ instance: body.instance, expected: client.evolution_instance }, 'instância diferente da cadastrada');
    }
    const results = parseEvolutionWebhook(body).map((ev) => {
      try {
        return handleEvolutionEvent(db, client, ev).action;
      } catch (err) {
        req.log.error({ err }, 'falha ao processar evento da Evolution');
        return 'erro';
      }
    });
    return { ok: true, results };
  });

  /**
   * Registro de venda por integração (n8n, CRM, checkout, planilha).
   * POST /api/v1/sales  Authorization: Bearer <api_token do cliente>
   * { "phone": "5511999999999", "value": 199.9, "currency": "BRL", "external_ref": "pedido-123", "note": "..." }
   */
  app.post('/api/v1/sales', async (req, reply) => {
    const client = clientByApiToken(db, req);
    if (!client) return reply.code(401).send({ ok: false, error: 'token inválido' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const phone = normalizePhone(String(b.phone || ''));
    const value = typeof b.value === 'number' ? b.value : parseMoney(String(b.value ?? ''));
    if (!phone || value === null || value < 0) {
      return reply.code(400).send({ ok: false, error: 'informe phone e value' });
    }
    let contact = db.prepare('SELECT * FROM contacts WHERE client_id = ? AND phone = ?').get(client.id, phone) as Contact | undefined;
    if (!contact && b.create_contact === true) {
      const info = db
        .prepare(`INSERT INTO contacts (client_id, phone, source, messages_in) VALUES (?, ?, 'organic', 0)`)
        .run(client.id, phone);
      contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid) as Contact;
    }
    if (!contact) return reply.code(404).send({ ok: false, error: 'contato não encontrado (use create_contact: true)' });
    const sale = registerSale(db, client, contact, {
      value,
      detectedBy: 'api',
      currency: typeof b.currency === 'string' ? b.currency.toUpperCase().slice(0, 3) : undefined,
      externalRef: typeof b.external_ref === 'string' ? b.external_ref.slice(0, 120) : null,
      note: typeof b.note === 'string' ? b.note.slice(0, 500) : null,
    });
    return { ok: true, sale, attribution: { source: contact.source, ctwa: Boolean(contact.ctwa_clid) } };
  });

  /** Consulta a origem de um contato (útil para CRMs). */
  app.get('/api/v1/contacts/:phone', async (req, reply) => {
    const client = clientByApiToken(db, req);
    if (!client) return reply.code(401).send({ ok: false, error: 'token inválido' });
    const phone = normalizePhone((req.params as { phone: string }).phone);
    const c = db
      .prepare(
        `SELECT c.phone, c.push_name, c.source, c.status, c.ad_source_id, c.ad_title, c.ad_source_url, c.first_message_at,
                k.utm_source, k.utm_medium, k.utm_campaign, k.utm_content, k.utm_term, k.gclid IS NOT NULL has_gclid
         FROM contacts c LEFT JOIN clicks k ON k.id = c.click_id WHERE c.client_id = ? AND c.phone = ?`,
      )
      .get(client.id, phone);
    if (!c) return reply.code(404).send({ ok: false });
    return { ok: true, contact: c };
  });

  /**
   * Feed CSV para "Uploads agendados" de conversões offline no Google Ads
   * (Ferramentas > Conversões > Uploads > Agendar > HTTPS). Lista conversões dos últimos 60 dias
   * de leads com GCLID. O Google Ads ignora conversões já importadas com o mesmo GCLID+nome+hora.
   */
  app.get('/feeds/google-ads/:token.csv', async (req, reply) => {
    const { token } = req.params as { token: string };
    const client = db.prepare('SELECT * FROM clients WHERE api_token = ?').get(token) as Client | undefined;
    if (!client) return reply.code(404).send('not found');
    const since = now() - 60 * 86400;
    const lines = ['Parameters:TimeZone=+0000', 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency'];
    if (client.gads_purchase_action_name) {
      const rows = db
        .prepare(
          `SELECT k.gclid, s.created_at, s.value, s.currency FROM sales s
           JOIN contacts c ON c.id = s.contact_id JOIN clicks k ON k.id = c.click_id
           WHERE s.client_id = ? AND s.created_at >= ? AND k.gclid IS NOT NULL ORDER BY s.id`,
        )
        .all(client.id, since) as { gclid: string; created_at: number; value: number; currency: string }[];
      for (const r of rows) {
        lines.push([r.gclid, client.gads_purchase_action_name, csvTime(r.created_at), r.value, r.currency].map(csvCell).join(','));
      }
    }
    if (client.gads_lead_action_name) {
      const rows = db
        .prepare(
          `SELECT k.gclid, c.first_message_at FROM contacts c JOIN clicks k ON k.id = c.click_id
           WHERE c.client_id = ? AND c.first_message_at >= ? AND k.gclid IS NOT NULL AND c.messages_in > 0 ORDER BY c.id`,
        )
        .all(client.id, since) as { gclid: string; first_message_at: number }[];
      for (const r of rows) {
        lines.push([r.gclid, client.gads_lead_action_name, csvTime(r.first_message_at), '', ''].map(csvCell).join(','));
      }
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Cache-Control', 'no-store');
    return lines.join('\n') + '\n';
  });
}

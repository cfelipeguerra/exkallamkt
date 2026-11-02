import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { DB } from '../db.js';
import { appendRef, isRefCode, newRefCode, normalizePhone } from '../lib/util.js';
import type { Client, TrackingLink } from '../types.js';

const TAG_JS = readFileSync(fileURLToPath(new URL('../../public/tag.js', import.meta.url)), 'utf8');

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

interface ClickData {
  fbclid?: string | null; fbc?: string | null; fbp?: string | null;
  gclid?: string | null; gbraid?: string | null; wbraid?: string | null;
  ga_client_id?: string | null; ga_session_id?: string | null;
  utm_source?: string | null; utm_medium?: string | null; utm_campaign?: string | null;
  utm_content?: string | null; utm_term?: string | null;
  page_url?: string | null; referrer?: string | null;
}

export function insertClick(
  db: DB,
  clientId: number,
  linkId: number | null,
  ref: string,
  origin: 'link' | 'tag',
  d: ClickData,
  req: FastifyRequest,
): boolean {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO clicks (client_id, link_id, ref_code, origin, fbclid, fbc, fbp, gclid, gbraid, wbraid,
         ga_client_id, ga_session_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, page_url, referrer, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      clientId, linkId, ref, origin, str(d.fbclid), str(d.fbc), str(d.fbp), str(d.gclid), str(d.gbraid), str(d.wbraid),
      str(d.ga_client_id, 100), str(d.ga_session_id, 100), str(d.utm_source, 200), str(d.utm_medium, 200),
      str(d.utm_campaign, 200), str(d.utm_content, 200), str(d.utm_term, 200), str(d.page_url, 2000), str(d.referrer, 2000),
      req.ip, str(req.headers['user-agent'], 500),
    );
  return r.changes > 0;
}

export function registerPublicRoutes(app: FastifyInstance, db: DB): void {
  app.get('/health', async () => ({ ok: true }));

  app.get('/t.js', async (_req, reply) => {
    reply.header('Content-Type', 'application/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=3600');
    return TAG_JS;
  });

  /** Recebe o clique enviado pela tag do site (sendBeacon com text/plain). */
  app.post('/api/click', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    let body: Record<string, unknown>;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : ((req.body as Record<string, unknown>) ?? {});
    } catch {
      return reply.code(400).send({ ok: false });
    }
    const client = db.prepare('SELECT * FROM clients WHERE slug = ? AND active = 1').get(String(body.client || '')) as
      | Client
      | undefined;
    if (!client || !isRefCode(body.ref)) return reply.code(400).send({ ok: false });
    insertClick(db, client.id, null, body.ref, 'tag', body as ClickData, req);
    return { ok: true };
  });

  /** Link rastreável: registra o clique e redireciona para o WhatsApp com o código na mensagem. */
  app.get('/r/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const link = db.prepare('SELECT * FROM tracking_links WHERE slug = ?').get(slug) as TrackingLink | undefined;
    const client = link
      ? (db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(link.client_id) as Client | undefined)
      : undefined;
    if (!link || !client) return reply.code(404).type('text/plain').send('Link não encontrado');

    const q = req.query as Record<string, string | undefined>;
    const fbclid = str(q.fbclid);
    let ref = newRefCode();
    for (let i = 0; i < 5; i++) {
      const ok = insertClick(db, client.id, link.id, ref, 'link', {
        fbclid,
        fbc: str(q.fbc) || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : null),
        fbp: q.fbp,
        gclid: q.gclid, gbraid: q.gbraid, wbraid: q.wbraid,
        utm_source: q.utm_source || link.utm_source,
        utm_medium: q.utm_medium || link.utm_medium,
        utm_campaign: q.utm_campaign || link.utm_campaign,
        utm_content: q.utm_content || link.utm_content,
        utm_term: q.utm_term || link.utm_term,
        page_url: `${config.baseUrl}${req.url}`,
        referrer: req.headers.referer || null,
      }, req);
      if (ok) break;
      ref = newRefCode();
    }
    const number = normalizePhone(client.whatsapp_number);
    const text = appendRef(q.msg ? String(q.msg).slice(0, 500) : link.message, ref, Boolean(client.invisible_ref));
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, 302);
  });
}

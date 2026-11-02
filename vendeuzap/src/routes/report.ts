import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { clientStats } from '../stats.js';
import type { Client } from '../types.js';
import { brl, dt, html, layout, SOURCE_LABEL } from '../views/html.js';
import { breakdownTables, kpis } from './admin.js';

/** Relatório somente leitura para o cliente final (link com token secreto). */
export function registerReportRoutes(app: FastifyInstance, db: DB): void {
  app.get('/report/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const c = db.prepare('SELECT * FROM clients WHERE report_token = ?').get(token) as Client | undefined;
    if (!c) return reply.code(404).type('text/plain').send('Relatório não encontrado');
    const days = Math.min(365, Math.max(1, Number((req.query as { d?: string }).d) || 30));
    const s = clientStats(db, c.id, days);
    const sales = db
      .prepare(
        `SELECT s.value, s.currency, s.created_at, c.source, c.push_name FROM sales s JOIN contacts c ON c.id = s.contact_id
         WHERE s.client_id = ? ORDER BY s.id DESC LIMIT 20`,
      )
      .all(c.id) as { value: number; currency: string; created_at: number; source: string; push_name: string | null }[];
    reply.header('X-Robots-Tag', 'noindex').type('text/html').send(
      layout(`Relatório ${c.name}`, html`<h1>${c.name} · últimos ${days} dias</h1>
      <p>${[7, 30, 90].map((d) => html`<a class="chip" href="?d=${d}">${d} dias</a> `)}</p>
      ${kpis(s, c.currency, days)}
      ${breakdownTables(s, c.currency)}
      <h2>Últimas vendas</h2><div class="card wrap"><table><tr><th>Data</th><th>Cliente</th><th>Origem</th><th class="num">Valor</th></tr>
      ${sales.map((r) => html`<tr><td>${dt(r.created_at)}</td><td>${r.push_name ? r.push_name.split(' ')[0] : '—'}</td><td>${SOURCE_LABEL[r.source]}</td><td class="num">${brl(r.value, r.currency)}</td></tr>`)}
      </table></div>`, { nav: false }),
    );
  });
}

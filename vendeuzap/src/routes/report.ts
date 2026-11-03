import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { clientStats } from '../stats.js';
import type { Client } from '../types.js';
import { campaignsCard, funnelCard, kpiRow, sourcesCard } from '../views/components.js';
import { ago, brl, dt, html, initials, layout, sourceChip } from '../views/html.js';

/** Relatório somente leitura para o cliente final (link com token secreto). */
export function registerReportRoutes(app: FastifyInstance, db: DB): void {
  app.get('/report/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const c = db.prepare('SELECT * FROM clients WHERE report_token = ?').get(token) as Client | undefined;
    if (!c) return reply.code(404).type('text/plain').send('Relatório não encontrado');
    const days = [7, 30, 90].includes(Number((req.query as { d?: string }).d)) ? Number((req.query as { d?: string }).d) : 30;
    const s = clientStats(db, c.id, days);
    const sales = db
      .prepare(
        `SELECT s.value, s.currency, s.created_at, c.source, c.push_name FROM sales s JOIN contacts c ON c.id = s.contact_id
         WHERE s.client_id = ? ORDER BY s.created_at DESC LIMIT 10`,
      )
      .all(c.id) as { value: number; currency: string; created_at: number; source: string; push_name: string | null }[];

    const body = html`
    <div class="page-head"><div><h1>${c.name}</h1><p class="sub">Vendas pelo WhatsApp · atualizado em tempo real</p></div>
      <div class="seg">${[7, 30, 90].map((d) => html`<a class="${d === days ? 'on' : ''}" href="?d=${d}">${d} dias</a>`)}</div></div>
    ${kpiRow(s, c.currency)}
    <div class="grid g2" style="margin-top:16px">${sourcesCard(s, c.currency)}${funnelCard(s)}</div>
    <div style="margin-top:16px">${campaignsCard(s, c.currency)}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Últimas vendas</h2></div>
      ${sales.length ? html`<div class="table-wrap"><table>
        ${sales.map((r) => {
          const first = r.push_name ? r.push_name.split(' ')[0] : null;
          return html`<tr><td><div class="person"><span class="avatar">${initials(first)}</span><div><b>${first || 'Cliente'}</b><span title="${dt(r.created_at)}">${ago(r.created_at)}</span><div style="margin-top:4px">${sourceChip(r.source)}</div></div></div></td><td class="num"><b>${brl(r.value, r.currency)}</b></td></tr>`;
        })}</table></div>`
      : html`<div class="empty"><b>Nenhuma venda registrada ainda</b></div>`}
    </div>
    <p class="help" style="text-align:center;margin-top:20px">Por privacidade, mostramos apenas o primeiro nome dos compradores.</p>`;
    reply.header('X-Robots-Tag', 'noindex').type('text/html').send(layout(`Relatório ${c.name}`, body, { nav: false }));
  });
}

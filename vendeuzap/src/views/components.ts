import type { ClientStats } from '../stats.js';
import { brl, html, pct, type Raw, SOURCE_LABEL, sourceChip } from './html.js';

export function kpiRow(s: ClientStats, currency: string): Raw {
  return html`<div class="grid g4">
    <div class="card kpi"><div class="l">Conversas novas</div><div class="v">${s.leads}</div><div class="h">pessoas que chamaram no WhatsApp</div></div>
    <div class="card kpi"><div class="l">Vendas</div><div class="v">${s.sales}</div><div class="h">${pct(s.conversion)} das conversas viraram venda</div></div>
    <div class="card kpi"><div class="l">Faturamento</div><div class="v">${brl(s.revenue, currency)}</div><div class="h">vendas fechadas no WhatsApp</div></div>
    <div class="card kpi"><div class="l">Ticket médio</div><div class="v">${brl(s.ticket, currency)}</div><div class="h">valor médio por venda</div></div>
  </div>`;
}

export function funnelCard(s: ClientStats): Raw {
  const max = Math.max(1, s.leads);
  const step = (label: string, v: number) =>
    html`<div class="bar"><span>${label}</span><div class="track"><div class="fill" style="width:${Math.max(2, (v / max) * 100)}%"></div></div>
      <span class="val"><b>${v}</b>${v !== s.leads && s.leads ? ` · ${pct(v / s.leads)}` : ''}</span></div>`;
  return html`<div class="card"><div class="card-head"><h2>Funil</h2><span class="muted small">últimos ${s.days} dias</span></div>
    <div class="funnel">${step('Conversas', s.leads)}${step('Qualificados', Math.max(s.qualified, s.customers))}${step('Compraram', s.customers)}</div>
    <p class="help" style="margin-top:12px">"Qualificados" usa a etiqueta de qualificação do WhatsApp Business (configurável).</p></div>`;
}

export function sourcesCard(s: ClientStats, currency: string): Raw {
  const maxRev = Math.max(1, ...s.bySource.map((r) => r.revenue));
  return html`<div class="card"><div class="card-head"><h2>De onde vêm as vendas</h2></div>
    ${s.bySource.length
      ? html`<div class="rank">${s.bySource.map(
          (r) => html`<div class="rank-row"><div>${sourceChip(r.source)}<div class="meta" style="margin-top:4px">${r.leads} conversa${r.leads === 1 ? '' : 's'} · ${r.sales} venda${r.sales === 1 ? '' : 's'}</div></div>
          <div class="money">${brl(r.revenue, currency)}</div>
          <div class="track"><div class="fill" style="width:${(r.revenue / maxRev) * 100}%"></div></div></div>`,
        )}</div>`
      : html`<div class="empty"><b>Ainda sem dados</b>As origens aparecem quando chegarem as primeiras conversas.</div>`}
  </div>`;
}

export function campaignsCard(s: ClientStats, currency: string): Raw {
  return html`<div class="card"><div class="card-head"><h2>Campanhas e anúncios que mais venderam</h2></div>
    ${s.byCampaign.length
      ? html`<div class="table-wrap"><table><tr><th>Campanha ou anúncio</th><th class="num hide-sm">Conversas</th><th class="num">Vendas</th><th class="num">Faturamento</th></tr>
        ${s.byCampaign.map((r) => html`<tr><td>${r.name}</td><td class="num hide-sm">${r.leads}</td><td class="num">${r.sales}</td><td class="num"><b>${brl(r.revenue, currency)}</b></td></tr>`)}
        </table></div>`
      : html`<div class="empty"><b>Nenhuma campanha identificada ainda</b>Aparecem aqui anúncios de WhatsApp da Meta e links/site com utm_campaign.</div>`}
  </div>`;
}

export { SOURCE_LABEL };

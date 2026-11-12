import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import type { DB } from '../db.js';
import { now } from '../db.js';
import { processEvent } from '../dispatcher.js';
import {
  connectInstance, createInstance, evolutionConfigured, fetchLabels, findInstanceWebhook, getInstanceState,
  type InstanceState, logoutInstance, setInstanceWebhook,
} from '../integrations/evolution.js';
import { googleAdsApiEnabled } from '../integrations/platforms.js';
import { encrypt, normalizePhone, parseMoney, slugify, token } from '../lib/util.js';
import { clientStats, failedEvents } from '../stats.js';
import { platformsFor, registerSale } from '../tracking.js';
import type { Client, Contact, Sale, TrackEvent, TrackingLink } from '../types.js';
import { campaignsCard, funnelCard, kpiRow, sourcesCard } from '../views/components.js';
import {
  ago, brl, copyable, dt, html, initials, layout, raw, type Raw, SOURCE_LABEL, sourceChip, STATUS_PILL,
} from '../views/html.js';

type Form = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function checkAuth(req: FastifyRequest): boolean {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const pass = rest.join(':');
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return eq(user, config.admin.user) && eq(pass, config.admin.password);
}

const getClient = (db: DB, id: unknown): Client | undefined =>
  db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(id)) as Client | undefined;

const notFound = (reply: FastifyReply) =>
  reply.code(404).type('text/html').send(layout('Não encontrado', html`<div class="card empty"><b>Página não encontrada</b><a href="/admin">Voltar para clientes</a></div>`));

const back = (reply: FastifyReply, url: string, msg?: string) =>
  reply.redirect(msg ? `${url}${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : url, 303);

/** Só aceita voltar para páginas do próprio painel. */
const safeBack = (v: string | undefined, fallback: string) => (v && /^\/admin(\/|$)/.test(v) ? v : fallback);

const flashOf = (req: FastifyRequest) => ((req.query as Form).msg as string | undefined) ?? null;

export function formatPhone(p: string): string {
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${p}`;
}

function connection(c: Client): Raw {
  if (!c.active) return html`<span class="pill"><span class="dot"></span>Pausado</span>`;
  if (!c.last_webhook_at) return html`<span class="pill pill-warn"><span class="dot"></span>Aguardando conexão</span>`;
  const idle = now() - c.last_webhook_at;
  if (idle < 2 * 86400) return html`<span class="pill pill-ok"><span class="dot"></span>Conectado</span>`;
  return html`<span class="pill pill-warn" title="Última mensagem recebida ${ago(c.last_webhook_at)}"><span class="dot"></span>Sem mensagens ${ago(c.last_webhook_at)}</span>`;
}

const PLATFORM_LABEL: Record<string, string> = { meta: 'Meta', ga4: 'Google Analytics', gads: 'Google Ads' };
const DETECTED_LABEL: Record<string, string> = {
  manual: 'Marcada no painel',
  keyword: 'Mensagem de confirmação',
  label: 'Etiqueta do WhatsApp',
  api: 'Integração (API)',
};

// ---------------------------------------------------------------------------
// Estrutura da página do cliente
// ---------------------------------------------------------------------------

type Tab = 'overview' | 'contacts' | 'sales' | 'events' | 'links' | 'setup' | 'edit';

function clientPage(db: DB, c: Client, tab: Tab, body: Raw, flash: string | null): string {
  const failed = failedEvents(db, c.id);
  const tabs: [Tab, string, string][] = [
    ['overview', 'Visão geral', ''],
    ['contacts', 'Conversas', '/contacts'],
    ['sales', 'Vendas', '/sales'],
    ['events', 'Envios', '/events'],
    ['links', 'Links', '/links'],
    ['setup', 'Instalação', '/setup'],
    ['edit', 'Configurações', '/edit'],
  ];
  const head = html`
  <a class="back" href="/admin">← Clientes</a>
  <div class="page-head"><div><h1>${c.name}</h1>
    <div class="row sub">${connection(c)}<span>WhatsApp ${formatPhone(c.whatsapp_number)}</span></div></div>
    <a class="btn ghost" href="/report/${c.report_token}" target="_blank" rel="noopener">Relatório do cliente ↗</a></div>
  <nav class="tabs">${tabs.map(
    ([key, label, path]) =>
      html`<a class="${tab === key ? 'on' : ''}" href="/admin/clients/${c.id}${path}">${label}${key === 'events' && failed ? html`<span class="count" title="Envios com falha">${failed}</span>` : ''}</a>`,
  )}</nav>`;
  return layout(c.name, html`${head}${body}`, { flash });
}

// ---------------------------------------------------------------------------
// Componentes
// ---------------------------------------------------------------------------

function saleButton(contact: Contact, client: Client, backUrl: string): Raw {
  const suggested = contact.last_quoted_value ?? client.default_sale_value;
  return html`<details class="pop"><summary class="btn ghost sm">${contact.status === 'customer' ? '+ Nova venda' : 'Registrar venda'}</summary>
    <div class="pop-body"><form method="post" action="/admin/contacts/${contact.id}/sale">
      <input type="hidden" name="back" value="${backUrl}">
      <label for="v${contact.id}">Valor da venda (${client.currency})</label>
      <input id="v${contact.id}" name="value" inputmode="decimal" value="${String(suggested || '').replace('.', ',')}" required>
      ${contact.last_quoted_value ? html`<p class="help">Sugerido a partir do último valor enviado na conversa.</p>` : ''}
      <div class="row" style="margin-top:12px"><button>Confirmar venda</button></div>
    </form></div></details>`;
}

type ContactRow = Contact & { campaign: string | null; sales_total: number | null };

function contactsTable(rows: ContactRow[], client: Client, backUrl: string): Raw {
  if (!rows.length) {
    return html`<div class="empty"><b>Nenhuma conversa encontrada</b>As conversas aparecem aqui assim que o WhatsApp do cliente receber mensagens.</div>`;
  }
  return html`<div class="table-wrap"><table>
  <tr><th>Contato</th><th>Origem</th><th>Situação</th><th>Última mensagem</th><th class="num">Comprou</th><th></th></tr>
  ${rows.map(
    (c) => html`<tr>
      <td><div class="person"><span class="avatar">${initials(c.push_name)}</span><div><b>${c.push_name || 'Sem nome'}</b><span>${formatPhone(c.phone)}</span></div></div></td>
      <td>${sourceChip(c.source)}${c.campaign ? html`<div class="muted small" style="margin-top:3px">${c.campaign}</div>` : ''}</td>
      <td>${STATUS_PILL[c.status]}</td>
      <td class="muted" title="${dt(c.last_message_at)}">${ago(c.last_message_at)}</td>
      <td class="num">${c.sales_total ? html`<b>${brl(c.sales_total, client.currency)}</b>` : html`<span class="muted">—</span>`}</td>
      <td class="num">${saleButton(c, client, backUrl)}</td></tr>`,
  )}</table></div>`;
}

const CONTACT_SELECT = `SELECT c.*, COALESCE(k.utm_campaign, c.ad_title) campaign,
  (SELECT SUM(value) FROM sales s WHERE s.contact_id = c.id) sales_total
  FROM contacts c LEFT JOIN clicks k ON k.id = c.click_id`;

interface EventGroup {
  event_id: string;
  kind: TrackEvent['kind'];
  created_at: number;
  phone: string | null;
  push_name: string | null;
  value: number | null;
  currency: string | null;
  rows: TrackEvent[];
}

function loadEventGroups(db: DB, clientId: number, status: string, limit: number): EventGroup[] {
  const ids = db
    .prepare(
      `SELECT event_id FROM events WHERE client_id = ?
       GROUP BY event_id HAVING (? = '' OR SUM(status = ?) > 0) ORDER BY MAX(id) DESC LIMIT ?`,
    )
    .all(clientId, status, status, limit) as { event_id: string }[];
  const rowsStmt = db.prepare(
    `SELECT e.*, c.phone, c.push_name, s.value, s.currency FROM events e
     LEFT JOIN contacts c ON c.id = e.contact_id LEFT JOIN sales s ON s.id = e.sale_id
     WHERE e.client_id = ? AND e.event_id = ? ORDER BY CASE e.platform WHEN 'meta' THEN 1 WHEN 'ga4' THEN 2 ELSE 3 END`,
  );
  return ids.map(({ event_id }) => {
    const rows = rowsStmt.all(clientId, event_id) as (TrackEvent & { phone: string; push_name: string; value: number; currency: string })[];
    const f = rows[0];
    return { event_id, kind: f.kind, created_at: f.created_at, phone: f.phone, push_name: f.push_name, value: f.value, currency: f.currency, rows };
  });
}

function platformPill(e: TrackEvent): Raw {
  const name = PLATFORM_LABEL[e.platform];
  switch (e.status) {
    case 'sent':
      return html`<span class="pill pill-ok" title="Enviado ${dt(e.sent_at)}">✓ ${name}</span>`;
    case 'error':
      return html`<span class="pill pill-err" title="${e.detail || 'Falhou'}">✕ ${name}</span>`;
    case 'pending':
      return html`<span class="pill pill-warn" title="${e.attempts ? `Nova tentativa ${ago(e.next_attempt_at)}` : 'Na fila'}">… ${name}</span>`;
    default:
      return html`<span class="pill" title="Não se aplica: ${e.detail || ''}">– ${name}</span>`;
  }
}

function eventsTable(groups: EventGroup[], clientId: number, compact = false): Raw {
  if (!groups.length) {
    return html`<div class="empty"><b>Nenhuma conversão enviada ainda</b>Cada conversa nova e cada venda gera um envio para as plataformas configuradas.</div>`;
  }
  return html`<div class="table-wrap"><table>
  <tr><th>Quando</th><th>Conversão</th><th>Contato</th><th>Enviado para</th><th></th></tr>
  ${groups.map((g) => {
    const failed = g.rows.some((r) => r.status === 'error');
    const kind = g.kind === 'purchase'
      ? html`<b>Venda</b> <span class="muted">${g.value !== null ? brl(g.value, g.currency || 'BRL') : ''}</span>`
      : g.kind === 'qualified' ? html`Lead qualificado` : html`Nova conversa`;
    return html`<tr>
      <td class="muted" title="${dt(g.created_at)}">${ago(g.created_at)}</td>
      <td>${kind}</td>
      <td>${g.push_name || (g.phone ? formatPhone(g.phone) : '—')}</td>
      <td><div class="platforms">${g.rows.map(platformPill)}</div>
        ${compact ? '' : html`<details class="tech"><summary>Detalhes técnicos</summary>
          ${g.rows.map((r) => html`<div class="small" style="margin-top:8px"><b>${PLATFORM_LABEL[r.platform]}</b>: ${r.detail || r.status}${r.attempts > 1 ? ` (${r.attempts} tentativas)` : ''}
            ${r.request ? html`<pre>${r.request}</pre>` : ''}${r.response ? html`<pre>${r.response}</pre>` : ''}</div>`)}
        </details>`}</td>
      <td class="num">${failed ? html`<form method="post" action="/admin/events/${g.rows.find((r) => r.status === 'error')!.id}/retry"><input type="hidden" name="back" value="/admin/clients/${clientId}/events"><button class="ghost sm">Tentar de novo</button></form>` : ''}</td></tr>`;
  })}</table></div>`;
}

// ---------------------------------------------------------------------------
// Conexão do WhatsApp (instância na Evolution API)
// ---------------------------------------------------------------------------

interface WaStep {
  state: InstanceState | 'unconfigured' | 'error';
  linked: boolean;
  pill: Raw;
  content: Raw;
}

const QR_SCRIPT = `(function(){var box=document.querySelector('[data-qr]');if(!box)return;var url=box.getAttribute('data-qr');
var img=box.querySelector('img'),wait=box.querySelector('.qr-wait'),pc=box.querySelector('.pair-code'),stopped=false;
function show(d){if(d.state==='open'){stopped=true;location.href=location.pathname+'?msg='+encodeURIComponent('WhatsApp conectado! Envie uma mensagem de teste para o número do cliente.');return}
if(d.error){wait.textContent='Não foi possível falar com o WhatsApp Manager: '+d.error;wait.hidden=false;return}
if(d.base64){img.src=d.base64;img.hidden=false;wait.hidden=true}
if(d.pairingCode&&pc){pc.textContent=d.pairingCode.replace(/(.{4})(.{4})/,'$1-$2');pc.hidden=false}}
function poll(q){fetch(url+(q||''),{credentials:'same-origin'}).then(function(r){return r.json()}).then(show).catch(function(){})}
poll();setInterval(function(){if(!stopped)poll()},5000);
var f=box.querySelector('form.pair');if(f)f.addEventListener('submit',function(e){e.preventDefault();var n=f.querySelector('input').value.replace(/\\D/g,'');if(n.length<10)return;if(n.length<=11)n='55'+n;poll('?number='+n)});})();`;

function qrPanel(c: Client, statusUrl: string): Raw {
  return html`<div class="qr" data-qr="${statusUrl}">
    <div class="qr-box"><img alt="QR Code para conectar o WhatsApp" hidden><span class="qr-wait muted small">Gerando QR Code…</span></div>
    <div>
      <ol class="qr-steps">
        <li>No celular do cliente, abra o <b>WhatsApp</b>.</li>
        <li>Toque em <b>⋮</b> (Android) ou <b>Configurações</b> (iPhone) › <b>Aparelhos conectados</b> › <b>Conectar um aparelho</b>.</li>
        <li>Aponte a câmera para o código ao lado.</li>
      </ol>
      <p class="help">O código se renova sozinho. Quando a conexão for feita, esta página atualiza automaticamente.</p>
      <details class="more"><summary>Conectar com um código no lugar do QR Code</summary>
        <form class="row pair" style="margin-top:10px"><input name="number" inputmode="tel" value="${formatPhone(c.whatsapp_number)}" style="max-width:220px" aria-label="Número do WhatsApp"><button class="ghost sm">Gerar código</button></form>
        <p class="pair-code" hidden></p>
        <p class="help">No celular: Aparelhos conectados › Conectar um aparelho › <b>Conectar com número de telefone</b>, e digite o código.</p>
      </details>
    </div>
  </div><script>${raw(QR_SCRIPT)}</script>`;
}

async function whatsappStep(c: Client, webhookUrl: string): Promise<WaStep> {
  const base = `/admin/clients/${c.id}/whatsapp`;
  const lastMsg = c.last_webhook_at
    ? html`<span class="pill pill-ok">Recebendo mensagens · última ${ago(c.last_webhook_at)}</span>`
    : html`<span class="pill pill-warn">Aguardando a primeira mensagem</span>`;

  if (!evolutionConfigured()) {
    return {
      state: 'unconfigured', linked: Boolean(c.last_webhook_at), pill: lastMsg,
      content: html`<p class="muted">Para conectar o WhatsApp por aqui, o servidor precisa das variáveis EVOLUTION_URL e EVOLUTION_API_KEY. Enquanto isso, use a configuração manual abaixo.</p>`,
    };
  }

  let state: InstanceState;
  let hook: { url: string | null; enabled: boolean } | null = null;
  try {
    state = await getInstanceState(c.evolution_instance);
    if (state !== 'missing') hook = await findInstanceWebhook(c.evolution_instance);
  } catch (err) {
    return {
      state: 'error', linked: false,
      pill: html`<span class="pill pill-err">WhatsApp Manager indisponível</span>`,
      content: html`<p class="muted">Não foi possível consultar o WhatsApp Manager: ${(err as Error).message}</p>
        <p class="help">Confira se a Evolution está no ar e se EVOLUTION_URL e EVOLUTION_API_KEY estão corretas no Coolify.</p>`,
    };
  }

  const linked = Boolean(hook?.enabled && hook.url === webhookUrl);
  const otherHook = hook?.enabled && hook.url && hook.url !== webhookUrl ? hook.url : null;

  if (state === 'missing') {
    return {
      state, linked: false, pill: html`<span class="pill pill-warn">Não conectado</span>`,
      content: html`<p class="muted">Vamos criar a instância <b>${c.evolution_instance}</b> no WhatsApp Manager e mostrar o QR Code para o cliente ler com o celular.</p>
        <form method="post" action="${base}/create"><button>Criar e mostrar QR Code</button></form>
        <p class="help">Se este número já está conectado no Manager com outro nome, corrija o nome da instância em Configurações em vez de criar outra.</p>`,
    };
  }

  if (state !== 'open') {
    return {
      state, linked, pill: html`<span class="pill pill-warn">Aguardando leitura do QR Code</span>`,
      content: html`${qrPanel(c, `${base}/status`)}
        ${!linked ? html`<p class="help" style="margin-top:12px">Assim que conectar, clique em "Ligar ao Vendeuzap" se o passo não ficar verde sozinho.</p>` : ''}`,
    };
  }

  const logout = html`<details class="more"><summary>Desconectar este WhatsApp</summary>
    <form method="post" action="${base}/logout" style="margin-top:10px" onsubmit="return confirm('Desconectar o WhatsApp deste cliente? Para voltar, será preciso ler o QR Code de novo.')">
      <button class="danger sm">Desconectar</button></form></details>`;

  if (linked) {
    return {
      state, linked, pill: lastMsg,
      content: html`<p class="muted">WhatsApp do cliente conectado e ligado ao Vendeuzap (instância <b>${c.evolution_instance}</b>).
        ${c.last_webhook_at ? '' : ' Mande uma mensagem de teste de outro celular para confirmar.'}</p>${logout}`,
    };
  }

  return {
    state, linked, pill: html`<span class="pill pill-warn">Conectado, falta ligar ao Vendeuzap</span>`,
    content: html`<p class="muted">O WhatsApp está conectado na instância <b>${c.evolution_instance}</b>, mas ainda não envia as mensagens para o Vendeuzap.</p>
      ${otherHook ? html`<div class="notice">⚠️ Esta instância já envia mensagens para outra ferramenta:<br><code>${otherHook}</code><br>
        A Evolution aceita um webhook por instância. Ligar ao Vendeuzap <b>desliga essa outra integração</b>.</div>` : ''}
      <form method="post" action="/admin/clients/${c.id}/evolution-webhook" ${otherHook ? raw(`onsubmit="return confirm('A outra integração desta instância vai parar de receber mensagens. Continuar?')"`) : ''}>
        <button>Ligar ao Vendeuzap</button></form>${logout}`,
  };
}

// ---------------------------------------------------------------------------
// Formulário de cliente
// ---------------------------------------------------------------------------

function clientForm(c: Partial<Client>, action: string, submitLabel: string): Raw {
  const v = (k: keyof Client) => (c[k] ?? '') as string | number;
  const saved = (k: keyof Client) => (c[k] ? '•••••••• (salvo, deixe em branco para manter)' : '');
  const check = (k: keyof Client) => (c[k] ? raw('checked') : '');
  const section = (title: string, desc: string, fields: Raw) =>
    html`<div class="section"><div><h3>${title}</h3><p>${desc}</p></div><div>${fields}</div></div>`;

  return html`<form method="post" action="${action}" class="card">
  ${section('Dados do cliente', 'Identificação e o número de WhatsApp que será acompanhado.', html`
    <label for="f-name">Nome do cliente</label><input id="f-name" name="name" required value="${v('name')}" placeholder="Ex.: Ótica Visão Clara">
    <div class="form-cols">
      <div><label for="f-wa">WhatsApp</label><input id="f-wa" name="whatsapp_number" required placeholder="(11) 99999-9999" value="${c.whatsapp_number ? formatPhone(c.whatsapp_number) : ''}"></div>
      <div><label for="f-inst">Instância no WhatsApp Manager</label><input id="f-inst" name="evolution_instance" value="${v('evolution_instance')}" placeholder="${'id' in c && c.id ? '' : 'Deixe em branco para criar uma nova'}">
        <p class="help">${'id' in c && c.id ? 'Exatamente como aparece no WhatsApp Manager.' : 'Número novo: deixe em branco e o Vendeuzap cria a instância e mostra o QR Code. Número já conectado no Manager: coloque o nome exato da instância.'}</p></div>
    </div>`)}

  ${section('Como identificar uma venda', 'O Vendeuzap marca a venda automaticamente quando uma destas coisas acontece na conversa.', html`
    <label for="f-kw">Frases de confirmação enviadas pela equipe</label>
    <textarea id="f-kw" name="sale_keywords" rows="2">${v('sale_keywords')}</textarea>
    <p class="help">Separe por "|". Ex.: pagamento confirmado|pedido confirmado. O valor é lido da própria conversa ("Total: R$ 150,00").</p>
    <div class="form-cols">
      <div><label for="f-sl">Etiqueta de venda no WhatsApp Business</label><input id="f-sl" name="sale_labels" value="${v('sale_labels')}" placeholder="Venda"></div>
      <div><label for="f-ql">Etiqueta de lead qualificado</label><input id="f-ql" name="qualified_labels" value="${v('qualified_labels')}" placeholder="Qualificado"></div>
    </div>
    <label for="f-dv">Valor usado quando a conversa não informa o valor</label>
    <input id="f-dv" name="default_sale_value" inputmode="decimal" value="${String(v('default_sale_value') || 0).replace('.', ',')}" style="max-width:200px">
    <details class="more"><summary>Mais opções</summary>
      <label for="f-cur">Moeda</label><input id="f-cur" name="currency" maxlength="3" value="${v('currency') || 'BRL'}" style="max-width:120px">
      <label class="check"><input type="checkbox" name="send_lead_event" value="1" ${check('send_lead_event')}> <span>Avisar as plataformas também quando chega uma conversa nova (evento de Lead)</span></label>
      <label class="check"><input type="checkbox" name="invisible_ref" value="1" ${check('invisible_ref')}> <span>Esconder o código de rastreio na mensagem<br><span class="help">Mais discreto, porém o código pode se perder se o lead reescrever a mensagem. Sem esta opção, aparece um código curto como "(cód. VZ-AB12CD)".</span></span></label>
    </details>`)}

  ${section('Meta (Facebook e Instagram)', 'Para enviar leads e vendas ao Pixel / Conversions API e otimizar campanhas.', html`
    <div class="form-cols">
      <div><label for="f-px">ID do Pixel (conjunto de dados)</label><input id="f-px" name="meta_pixel_id" value="${v('meta_pixel_id')}" placeholder="Ex.: 123456789012345"></div>
      <div><label for="f-tk">Token da API de Conversões</label><input id="f-tk" name="meta_access_token" type="password" autocomplete="off" placeholder="${saved('meta_access_token')}">
        <p class="help">Gerado no Gerenciador de Eventos, em Configurações do pixel.</p></div>
    </div>
    <details class="more"><summary>Opções avançadas</summary>
      <label for="f-tc">Código de evento de teste</label><input id="f-tc" name="meta_test_event_code" value="${v('meta_test_event_code')}" placeholder="TEST12345">
      <p class="help">Use durante a homologação para ver os eventos em "Testar eventos". Apague depois.</p>
      <label for="f-waba">ID da conta do WhatsApp Business Platform (WABA)</label><input id="f-waba" name="meta_waba_id" value="${v('meta_waba_id')}">
      <p class="help">Só preencha se o número estiver na API oficial da Meta e o pixel estiver vinculado a essa conta. Números conectados pelo WhatsApp Manager normalmente não têm WABA.</p>
    </details>`)}

  ${section('Google Analytics 4', 'Registra leads e vendas no GA4 do cliente.', html`
    <div class="form-cols">
      <div><label for="f-ga">ID da métrica</label><input id="f-ga" name="ga4_measurement_id" placeholder="G-XXXXXXXXXX" value="${v('ga4_measurement_id')}"></div>
      <div><label for="f-gs">Chave secreta da API</label><input id="f-gs" name="ga4_api_secret" type="password" autocomplete="off" placeholder="${saved('ga4_api_secret')}">
        <p class="help">GA4 › Administrador › Fluxos de dados › Chaves secretas da API do Measurement Protocol.</p></div>
    </div>`)}

  ${section('Google Ads', 'Envia vendas de quem clicou em anúncios do Google (precisa do link rastreável ou da tag no site).', html`
    <div class="form-cols">
      <div><label for="f-gc">ID do cliente Google Ads</label><input id="f-gc" name="gads_customer_id" placeholder="123-456-7890" value="${v('gads_customer_id')}"></div>
      <div><label for="f-gpn">Nome da conversão de venda</label><input id="f-gpn" name="gads_purchase_action_name" value="${v('gads_purchase_action_name')}" placeholder="Venda WhatsApp">
        <p class="help">Exatamente como foi criada no Google Ads (tipo "Importação").</p></div>
    </div>
    <details class="more"><summary>Opções avançadas</summary>
      <label for="f-gln">Nome da conversão de lead (opcional)</label><input id="f-gln" name="gads_lead_action_name" value="${v('gads_lead_action_name')}">
      <div class="form-cols">
        <div><label for="f-gpi">ID da conversão de venda (envio pela API)</label><input id="f-gpi" name="gads_purchase_action_id" value="${v('gads_purchase_action_id')}"></div>
        <div><label for="f-gli">ID da conversão de lead (envio pela API)</label><input id="f-gli" name="gads_lead_action_id" value="${v('gads_lead_action_id')}"></div>
      </div>
      <p class="help">${googleAdsApiEnabled() ? 'O servidor tem acesso à API do Google Ads: com os IDs preenchidos, o envio é automático.' : 'O servidor não tem credenciais da API do Google Ads. Use a importação agendada (link na aba Instalação), que só precisa do nome da conversão.'}</p>
    </details>`)}

  ${'id' in c && c.id ? section('Status', 'Clientes pausados deixam de registrar conversas e enviar conversões.', html`
    <label class="check"><input type="checkbox" name="active" value="1" ${check('active')}> <span>Cliente ativo</span></label>`) : ''}
  <div class="row" style="justify-content:flex-end;border-top:1px solid var(--line);padding-top:16px"><button>${submitLabel}</button></div>
  </form>`;
}

function readClientForm(f: Form, existing?: Client): Record<string, unknown> {
  const t = (k: string) => (f[k] ?? '').trim() || null;
  const secret = (k: string, cur: string | null | undefined) => (t(k) ? encrypt(t(k)) : cur ?? null);
  return {
    name: t('name') || 'Sem nome',
    whatsapp_number: normalizePhone(t('whatsapp_number')) || '',
    evolution_instance: t('evolution_instance') || '',
    currency: (t('currency') || 'BRL').toUpperCase().slice(0, 3),
    default_sale_value: parseMoney(t('default_sale_value') || '0') ?? 0,
    sale_keywords: t('sale_keywords') || '',
    sale_labels: t('sale_labels') || '',
    qualified_labels: t('qualified_labels') || '',
    send_lead_event: f.send_lead_event ? 1 : 0,
    invisible_ref: f.invisible_ref ? 1 : 0,
    meta_pixel_id: t('meta_pixel_id'),
    meta_access_token: secret('meta_access_token', existing?.meta_access_token),
    meta_test_event_code: t('meta_test_event_code'),
    meta_waba_id: t('meta_waba_id'),
    ga4_measurement_id: t('ga4_measurement_id'),
    ga4_api_secret: secret('ga4_api_secret', existing?.ga4_api_secret),
    gads_customer_id: t('gads_customer_id'),
    gads_purchase_action_id: t('gads_purchase_action_id'),
    gads_lead_action_id: t('gads_lead_action_id'),
    gads_purchase_action_name: t('gads_purchase_action_name'),
    gads_lead_action_name: t('gads_lead_action_name'),
    ...(existing ? { active: f.active ? 1 : 0 } : {}),
  };
}

const NEW_CLIENT_DEFAULTS: Partial<Client> = {
  send_lead_event: 1,
  currency: 'BRL',
  sale_keywords: 'pagamento confirmado|pedido confirmado|compra confirmada|venda confirmada',
  sale_labels: 'Venda',
  qualified_labels: 'Qualificado',
};

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export function registerAdminRoutes(app: FastifyInstance, db: DB): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin')) return;
    if (!checkAuth(req)) {
      reply.header('WWW-Authenticate', 'Basic realm="Vendeuzap"').code(401).send('Autenticação necessária');
    }
  });

  const send = (reply: FastifyReply, page: string) => reply.type('text/html').send(page);

  // ----- Lista de clientes -------------------------------------------------
  app.get('/admin', async (req, reply) => {
    const clients = db.prepare('SELECT * FROM clients ORDER BY active DESC, name').all() as Client[];
    const items = clients.map((c) => ({ c, s: clientStats(db, c.id), failed: failedEvents(db, c.id) }));
    const total = items.reduce((a, { s }) => ({ leads: a.leads + s.leads, sales: a.sales + s.sales }), { leads: 0, sales: 0 });
    const revenueByCurrency = new Map<string, number>();
    for (const { c, s } of items) revenueByCurrency.set(c.currency, (revenueByCurrency.get(c.currency) ?? 0) + s.revenue);
    const revenueText = [...revenueByCurrency].map(([cur, v]) => brl(v, cur)).join(' + ') || brl(0);

    const body = html`
    <div class="page-head"><div><h1>Clientes</h1><p class="sub">Resultados dos últimos 30 dias</p></div>
      <a class="btn" href="/admin/clients/new">+ Novo cliente</a></div>
    ${clients.length ? html`
    <div class="grid g4" style="margin-bottom:22px">
      <div class="card kpi"><div class="l">Clientes ativos</div><div class="v">${clients.filter((c) => c.active).length}</div></div>
      <div class="card kpi"><div class="l">Conversas novas</div><div class="v">${total.leads}</div></div>
      <div class="card kpi"><div class="l">Vendas rastreadas</div><div class="v">${total.sales}</div></div>
      <div class="card kpi"><div class="l">Faturamento rastreado</div><div class="v" style="font-size:${revenueByCurrency.size > 1 ? '20px' : ''}">${revenueText}</div></div>
    </div>
    <div class="grid g3">${items.map(({ c, s, failed }) => html`
      <a class="card client-card" href="/admin/clients/${c.id}">
        <div class="top"><h3 style="margin:0">${c.name}</h3><span class="muted small">${formatPhone(c.whatsapp_number)}</span>${connection(c)}</div>
        <div class="nums"><div><b>${s.leads}</b><span>conversas</span></div><div><b>${s.sales}</b><span>vendas</span></div><div><b>${brl(s.revenue, c.currency).replace(/,\d{2}$/, '')}</b><span>faturado</span></div></div>
        <div class="foot">${platformsFor(c).length ? platformsFor(c).map((p) => html`<span class="chip">${PLATFORM_LABEL[p]}</span>`) : html`<span class="pill pill-warn">Nenhum destino configurado</span>`}
          ${failed ? html`<span class="pill pill-err">${failed} envio${failed > 1 ? 's' : ''} com falha</span>` : ''}</div>
      </a>`)}</div>`
    : html`<div class="card empty"><b>Nenhum cliente ainda</b><p>Cadastre o primeiro cliente para começar a rastrear as vendas do WhatsApp.</p><a class="btn" href="/admin/clients/new">+ Cadastrar cliente</a></div>`}`;
    send(reply, layout('Clientes', body, { flash: flashOf(req) }));
  });

  // ----- Cadastro ----------------------------------------------------------
  app.get('/admin/clients/new', async (_req, reply) => {
    send(reply, layout('Novo cliente', html`<a class="back" href="/admin">← Clientes</a>
      <div class="page-head"><div><h1>Novo cliente</h1><p class="sub">Só os dados do cliente são obrigatórios. Plataformas podem ser configuradas depois.</p></div></div>
      ${clientForm(NEW_CLIENT_DEFAULTS, '/admin/clients', 'Cadastrar e ir para a instalação')}`));
  });

  app.post('/admin/clients', async (req, reply) => {
    const data = readClientForm(req.body as Form);
    let slug = slugify(String(data.name)) || 'cliente';
    while (db.prepare('SELECT 1 FROM clients WHERE slug = ?').get(slug)) slug = `${slug}-${token(2).toLowerCase()}`;
    const full = {
      ...data,
      evolution_instance: data.evolution_instance || `vz-${slug}`,
      slug, webhook_token: token(), report_token: token(), api_token: token(),
    };
    const keys = Object.keys(full);
    try {
      const info = db.prepare(`INSERT INTO clients (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`).run(full);
      return back(reply, `/admin/clients/${info.lastInsertRowid}/setup`, 'Cliente cadastrado! Agora siga os passos da instalação.');
    } catch (err) {
      const msg = /UNIQUE.*evolution_instance/.test((err as Error).message)
        ? 'Erro: já existe um cliente com essa instância do WhatsApp Manager.'
        : `Erro ao salvar: ${(err as Error).message}`;
      return back(reply, '/admin', msg);
    }
  });

  // ----- Visão geral -------------------------------------------------------
  app.get('/admin/clients/:id', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const s = clientStats(db, c.id);
    const recent = db
      .prepare(`${CONTACT_SELECT} WHERE c.client_id = ? AND c.messages_in > 0 ORDER BY c.last_message_at DESC LIMIT 6`)
      .all(c.id) as ContactRow[];
    const setupPending = !c.last_webhook_at || !platformsFor(c).length;
    const body = html`
      ${setupPending ? html`<div class="card" style="border-color:var(--warn);margin-bottom:16px"><div class="row"><div class="spacer"><h3>Instalação incompleta</h3>
        <p class="muted small" style="margin:0">${!c.last_webhook_at ? 'Ainda não recebemos mensagens deste WhatsApp.' : 'Nenhuma plataforma (Meta, GA4 ou Google Ads) foi configurada.'}</p></div>
        <a class="btn" href="/admin/clients/${c.id}/setup">Ver o que falta</a></div></div>` : ''}
      ${kpiRow(s, c.currency)}
      <div class="grid g2" style="margin-top:16px">${sourcesCard(s, c.currency)}${funnelCard(s)}</div>
      <div style="margin-top:16px">${campaignsCard(s, c.currency)}</div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Conversas recentes</h2><a href="/admin/clients/${c.id}/contacts">Ver todas →</a></div>
        ${contactsTable(recent, c, `/admin/clients/${c.id}`)}</div>`;
    send(reply, clientPage(db, c, 'overview', body, flashOf(req)));
  });

  // ----- Conversas ---------------------------------------------------------
  app.get('/admin/clients/:id/contacts', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const qs = req.query as Form;
    const q = (qs.q || '').trim();
    const status = ['lead', 'qualified', 'customer'].includes(qs.status || '') ? qs.status! : '';
    const source = Object.keys(SOURCE_LABEL).includes(qs.source || '') ? qs.source! : '';
    const like = `%${q}%`;
    const rows = db
      .prepare(
        `${CONTACT_SELECT} WHERE c.client_id = ? AND c.messages_in > 0
         AND (? = '' OR c.phone LIKE ? OR c.push_name LIKE ?) AND (? = '' OR c.status = ?) AND (? = '' OR c.source = ?)
         ORDER BY c.last_message_at DESC LIMIT 300`,
      )
      .all(c.id, q, like, like, status, status, source, source) as ContactRow[];
    const link = (st: string) => {
      const p = new URLSearchParams({ ...(q ? { q } : {}), ...(st ? { status: st } : {}), ...(source ? { source } : {}) });
      return `/admin/clients/${c.id}/contacts${p.size ? `?${p}` : ''}`;
    };
    const backUrl = req.url;
    const body = html`<div class="card">
      <form class="filters" method="get">
        <div class="seg">${[['', 'Todas'], ['lead', 'Leads'], ['qualified', 'Qualificados'], ['customer', 'Clientes']].map(([k, l]) => html`<a class="${status === k ? 'on' : ''}" href="${link(k)}">${l}</a>`)}</div>
        ${status ? html`<input type="hidden" name="status" value="${status}">` : ''}
        <select name="source" onchange="this.form.submit()" aria-label="Origem"><option value="">Todas as origens</option>
          ${Object.entries(SOURCE_LABEL).map(([k, l]) => html`<option value="${k}" ${source === k ? raw('selected') : ''}>${l}</option>`)}</select>
        <input name="q" value="${q}" placeholder="Buscar nome ou telefone" aria-label="Buscar">
      </form>
      ${contactsTable(rows, c, backUrl)}</div>`;
    send(reply, clientPage(db, c, 'contacts', body, flashOf(req)));
  });

  // ----- Vendas ------------------------------------------------------------
  app.get('/admin/clients/:id/sales', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const rows = db
      .prepare(
        `SELECT s.*, ct.push_name, ct.phone, ct.source FROM sales s JOIN contacts ct ON ct.id = s.contact_id
         WHERE s.client_id = ? ORDER BY s.created_at DESC LIMIT 300`,
      )
      .all(c.id) as (Sale & { push_name: string | null; phone: string; source: string })[];
    const total = rows.reduce((a, r) => a + r.value, 0);
    const body = html`<div class="card">
      <div class="card-head"><div><h2>Vendas registradas</h2><p class="muted small" style="margin:0">${rows.length} venda${rows.length === 1 ? '' : 's'} · ${brl(total, c.currency)}</p></div></div>
      ${rows.length ? html`<div class="table-wrap"><table>
        <tr><th>Data</th><th>Cliente</th><th>Origem</th><th>Como foi identificada</th><th class="num">Valor</th><th></th></tr>
        ${rows.map((r) => html`<tr>
          <td class="muted">${dt(r.created_at)}</td>
          <td><div class="person"><span class="avatar">${initials(r.push_name)}</span><div><b>${r.push_name || 'Sem nome'}</b><span>${formatPhone(r.phone)}</span></div></div></td>
          <td>${sourceChip(r.source)}</td>
          <td class="muted">${DETECTED_LABEL[r.detected_by]}${r.note ? html`<div class="small">${r.note}</div>` : ''}</td>
          <td class="num"><b>${brl(r.value, r.currency)}</b></td>
          <td class="num"><form method="post" action="/admin/sales/${r.id}/delete" onsubmit="return confirm('Excluir esta venda? Conversões que já foram enviadas para Meta e Google não são desfeitas.')"><button class="danger sm">Excluir</button></form></td>
        </tr>`)}</table></div>`
      : html`<div class="empty"><b>Nenhuma venda ainda</b>As vendas são identificadas pelas frases de confirmação, pela etiqueta do WhatsApp ou marcadas manualmente em Conversas.</div>`}
    </div>`;
    send(reply, clientPage(db, c, 'sales', body, flashOf(req)));
  });

  // ----- Envios (eventos) --------------------------------------------------
  app.get('/admin/clients/:id/events', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const status = ['error', 'pending', 'sent'].includes((req.query as Form).status || '') ? (req.query as Form).status! : '';
    const groups = loadEventGroups(db, c.id, status, 200);
    const s = clientStats(db, c.id);
    const body = html`
      <div class="grid g3" style="margin-bottom:16px">
        <div class="card kpi"><div class="l">Enviados com sucesso</div><div class="v" style="color:var(--ok)">${s.eventsSent}</div><div class="h">últimos 30 dias</div></div>
        <div class="card kpi"><div class="l">Com falha</div><div class="v" style="color:${s.eventsFailed ? 'var(--err)' : 'inherit'}">${s.eventsFailed}</div><div class="h">verifique as credenciais em Configurações</div></div>
        <div class="card kpi"><div class="l">Na fila</div><div class="v">${s.eventsPending}</div><div class="h">serão enviados em instantes</div></div>
      </div>
      <div class="card">
        <div class="filters"><div class="seg">${[['', 'Todos'], ['error', 'Com falha'], ['pending', 'Na fila'], ['sent', 'Enviados']].map(([k, l]) => html`<a class="${status === k ? 'on' : ''}" href="/admin/clients/${c.id}/events${k ? `?status=${k}` : ''}">${l}</a>`)}</div></div>
        <p class="help" style="margin:0 0 10px">✓ enviado · ✕ falhou · … na fila · – não se aplica (ex.: lead que não veio de anúncio do Google). Passe o mouse sobre cada item para ver o motivo.</p>
        ${eventsTable(groups, c.id)}</div>`;
    send(reply, clientPage(db, c, 'events', body, flashOf(req)));
  });

  // ----- Links -------------------------------------------------------------
  app.get('/admin/clients/:id/links', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const links = db
      .prepare(
        `SELECT l.*, (SELECT COUNT(*) FROM clicks k WHERE k.link_id = l.id) clicks,
                (SELECT COUNT(*) FROM clicks k WHERE k.link_id = l.id AND k.matched_contact_id IS NOT NULL) leads
         FROM tracking_links l WHERE l.client_id = ? ORDER BY l.id DESC`,
      )
      .all(c.id) as (TrackingLink & { clicks: number; leads: number })[];
    const body = html`<div class="grid g2">
      <div class="stack">
        ${links.length ? links.map((l) => html`<div class="card">
          <div class="card-head"><div><h3>${l.name}</h3><span class="muted small">${l.clicks} clique${l.clicks === 1 ? '' : 's'} · ${l.leads} conversa${l.leads === 1 ? '' : 's'}</span></div>
            <form method="post" action="/admin/links/${l.id}/delete" onsubmit="return confirm('Excluir este link? Quem clicar nele verá uma página de erro.')"><button class="danger sm">Excluir</button></form></div>
          ${copyable(`${config.baseUrl}/r/${l.slug}`)}
          <p class="muted small" style="margin:0">Mensagem: "${l.message}"${l.utm_campaign ? html` · campanha <b>${l.utm_campaign}</b>` : ''}</p>
        </div>`)
        : html`<div class="card empty"><b>Nenhum link criado</b>Crie links para bio do Instagram, Google, QR codes e anúncios que levam ao site.</div>`}
      </div>
      <form class="card" method="post" action="/admin/clients/${c.id}/links" style="align-self:start">
        <h2>Criar link rastreável</h2>
        <p class="muted small">Quem clicar abre o WhatsApp do cliente com a mensagem pronta. O Vendeuzap identifica a origem automaticamente.</p>
        <label for="l-name">Onde o link será usado</label><input id="l-name" name="name" required placeholder="Ex.: Bio do Instagram">
        <label for="l-msg">Mensagem que o lead vai enviar</label><input id="l-msg" name="message" value="Olá! Gostaria de mais informações.">
        <details class="more"><summary>Parâmetros UTM (opcional)</summary>
          <div class="form-cols"><div><label for="l-src">utm_source</label><input id="l-src" name="utm_source" placeholder="instagram"></div>
          <div><label for="l-med">utm_medium</label><input id="l-med" name="utm_medium" placeholder="bio"></div></div>
          <label for="l-camp">utm_campaign</label><input id="l-camp" name="utm_campaign" placeholder="black-friday">
        </details>
        <div class="row" style="margin-top:16px"><button>Criar link</button></div>
      </form></div>`;
    send(reply, clientPage(db, c, 'links', body, flashOf(req)));
  });

  // ----- Instalação --------------------------------------------------------
  app.get('/admin/clients/:id/setup', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const labels = db.prepare('SELECT name FROM labels WHERE client_id = ? ORDER BY name').all(c.id) as { name: string }[];
    const tagClick = db.prepare(`SELECT MAX(created_at) t FROM clicks WHERE client_id = ? AND origin = 'tag'`).get(c.id) as { t: number | null };
    const linkCount = (db.prepare('SELECT COUNT(*) n FROM tracking_links WHERE client_id = ?').get(c.id) as { n: number }).n;
    const platforms = platformsFor(c);
    const webhookUrl = `${config.baseUrl}/webhooks/evolution/${c.webhook_token}`;
    const tag = `<script src="${config.baseUrl}/t.js?c=${c.slug}${c.invisible_ref ? '&inv=1' : ''}" async></script>`;
    const evolutionReady = evolutionConfigured();
    const wa = await whatsappStep(c, webhookUrl);

    const step = (n: number, done: boolean, title: string, status: Raw, content: Raw, optional = false) =>
      html`<li class="step ${done ? 'done' : ''}"><span class="n">${done ? '✓' : n}</span><div>
        <div class="step-head"><h3 style="margin:0">${title}</h3>${optional ? html`<span class="chip">opcional</span>` : ''}${status}</div>${content}</div></li>`;

    const body = html`<div class="card"><ol class="steps">
      ${step(1, wa.state === 'open' && wa.linked && Boolean(c.last_webhook_at), 'Conectar o WhatsApp', wa.pill, html`${wa.content}
        <details class="more"><summary>Configuração manual do webhook</summary>
          <p class="small muted" style="margin-top:8px">Na Evolution, em Webhook da instância, cole a URL abaixo e ative os eventos MESSAGES_UPSERT, SEND_MESSAGE, LABELS_EDIT e LABELS_ASSOCIATION.</p>
          ${copyable(webhookUrl)}</details>`)}

      ${step(2, platforms.length > 0, 'Escolher para onde enviar as conversões',
        platforms.length ? html`<span class="pill pill-ok">${platforms.map((p) => PLATFORM_LABEL[p]).join(', ')}</span>` : html`<span class="pill pill-warn">Nenhuma plataforma</span>`,
        html`<p class="muted">Informe o Pixel da Meta, o GA4 e/ou o Google Ads do cliente.</p>
        <a class="btn ghost" href="/admin/clients/${c.id}/edit">Abrir configurações</a>`)}

      ${step(3, labels.length > 0, 'Usar etiquetas do WhatsApp Business',
        labels.length ? html`<span class="pill pill-ok">${labels.length} etiqueta${labels.length > 1 ? 's' : ''}</span>` : html``,
        html`<p class="muted">Se a equipe marca conversas com etiquetas, a etiqueta <b>${c.sale_labels || 'Venda'}</b> registra a venda e <b>${c.qualified_labels || 'Qualificado'}</b> marca o lead como qualificado.</p>
        ${labels.length ? html`<p class="small muted">Etiquetas encontradas: ${labels.map((l) => l.name).join(', ')}</p>` : ''}
        ${evolutionReady ? html`<form method="post" action="/admin/clients/${c.id}/sync-labels"><button class="ghost">Buscar etiquetas</button></form>` : html`<p class="help">As etiquetas também são aprendidas sozinhas quando alguém cria ou edita uma etiqueta no app.</p>`}`, true)}

      ${step(4, Boolean(tagClick.t), 'Instalar o código no site',
        tagClick.t ? html`<span class="pill pill-ok">Último clique ${ago(tagClick.t)}</span>` : html``,
        html`<p class="muted">Faz os botões de WhatsApp do site informarem de qual anúncio ou campanha o visitante veio. Cole antes de &lt;/body&gt; ou no Google Tag Manager (tag "HTML personalizado").</p>
        ${copyable(tag)}`, true)}

      ${step(5, linkCount > 0, 'Criar links rastreáveis',
        linkCount ? html`<span class="pill pill-ok">${linkCount} link${linkCount > 1 ? 's' : ''}</span>` : html``,
        html`<p class="muted">Para bio do Instagram, QR codes e anúncios do Google sem site.</p>
        <a class="btn ghost" href="/admin/clients/${c.id}/links">Criar link</a>`, true)}

      ${step(6, false, 'Compartilhar o relatório com o cliente', html``,
        html`<p class="muted">Página só de leitura, sem login, com conversas, vendas e faturamento por origem.</p>${copyable(`${config.baseUrl}/report/${c.report_token}`)}`)}
    </ol></div>

    <details class="card more" style="margin-top:16px"><summary>Integrações avançadas (API e Google Ads)</summary>
      <h3 style="margin-top:14px">Registrar vendas por API (n8n, CRM, checkout)</h3>
      <pre>curl -X POST ${config.baseUrl}/api/v1/sales \\
  -H "Authorization: Bearer ${c.api_token}" -H "Content-Type: application/json" \\
  -d '{"phone":"5511999999999","value":199.90,"external_ref":"pedido-123"}'</pre>
      <h3 style="margin-top:14px">Importação agendada no Google Ads</h3>
      ${c.gads_purchase_action_name || c.gads_lead_action_name
        ? html`<p class="muted small">No Google Ads: Metas › Conversões › Uploads › Programações › nova programação por HTTPS, com esta URL:</p>${copyable(`${config.baseUrl}/feeds/google-ads/${c.api_token}.csv`)}
          <p class="help">O Google pede <b>nome de usuário</b> e <b>senha</b>: preencha <code>vendeuzap</code> nos dois. O Vendeuzap não confere esses campos, porque a proteção é o token secreto que já está na URL.</p>`
        : html`<p class="muted small">Preencha o nome da conversão de venda do Google Ads em Configurações para liberar a URL de importação.</p>`}
    </details>`;
    send(reply, clientPage(db, c, 'setup', body, flashOf(req)));
  });

  // ----- Configurações -----------------------------------------------------
  app.get('/admin/clients/:id/edit', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    send(reply, clientPage(db, c, 'edit', clientForm(c, `/admin/clients/${c.id}`, 'Salvar alterações'), flashOf(req)));
  });

  app.post('/admin/clients/:id', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const data = readClientForm(req.body as Form, c);
    if (!data.evolution_instance) data.evolution_instance = c.evolution_instance;
    const sets = Object.keys(data).map((k) => `${k} = @${k}`).join(', ');
    try {
      db.prepare(`UPDATE clients SET ${sets} WHERE id = @id`).run({ ...data, id: c.id });
      return back(reply, `/admin/clients/${c.id}/edit`, 'Configurações salvas.');
    } catch (err) {
      return back(reply, `/admin/clients/${c.id}/edit`, `Erro ao salvar: ${(err as Error).message}`);
    }
  });

  // ----- Ações -------------------------------------------------------------
  app.post('/admin/contacts/:id/sale', async (req, reply) => {
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number((req.params as Form).id)) as Contact | undefined;
    if (!contact) return notFound(reply);
    const client = getClient(db, contact.client_id)!;
    const f = req.body as Form;
    const typed = parseMoney(f.value || '');
    const value = typed ?? contact.last_quoted_value ?? client.default_sale_value;
    registerSale(db, client, contact, { value, detectedBy: 'manual' });
    return back(reply, safeBack(f.back, `/admin/clients/${client.id}`), `Venda de ${brl(value, client.currency)} registrada para ${contact.push_name || formatPhone(contact.phone)}.`);
  });

  app.post('/admin/sales/:id/delete', async (req, reply) => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(Number((req.params as Form).id)) as Sale | undefined;
    if (!sale) return notFound(reply);
    db.transaction(() => {
      // Envios que ainda não saíram são cancelados junto com a venda
      db.prepare(`DELETE FROM events WHERE sale_id = ? AND status IN ('pending','error')`).run(sale.id);
      db.prepare('UPDATE events SET sale_id = NULL WHERE sale_id = ?').run(sale.id);
      db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id);
      const left = db.prepare('SELECT 1 FROM sales WHERE contact_id = ?').get(sale.contact_id);
      if (!left) db.prepare(`UPDATE contacts SET status = 'lead' WHERE id = ? AND status = 'customer'`).run(sale.contact_id);
    })();
    return back(reply, `/admin/clients/${sale.client_id}/sales`, 'Venda excluída.');
  });

  app.post('/admin/events/:id/retry', async (req, reply) => {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number((req.params as Form).id)) as TrackEvent | undefined;
    if (!ev) return notFound(reply);
    const failed = db
      .prepare(`SELECT * FROM events WHERE client_id = ? AND event_id = ? AND status = 'error'`)
      .all(ev.client_id, ev.event_id) as TrackEvent[];
    const results = [];
    for (const e of failed) results.push(await processEvent(db, e));
    const ok = results.every((r) => r.status === 'sent' || r.status === 'skipped');
    const target = safeBack((req.body as Form)?.back, `/admin/clients/${ev.client_id}/events`);
    return back(reply, target, ok ? 'Reenviado com sucesso.' : `Falha ao reenviar: ${results.find((r) => r.status === 'error')?.detail ?? 'erro desconhecido'}`);
  });

  app.post('/admin/clients/:id/links', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const f = req.body as Form;
    const t = (k: string) => (f[k] || '').trim() || null;
    let slug = `${c.slug.slice(0, 20)}-${slugify(t('name') || 'link').slice(0, 20)}`;
    while (db.prepare('SELECT 1 FROM tracking_links WHERE slug = ?').get(slug)) slug = `${slug}-${token(2).toLowerCase()}`;
    db.prepare(
      `INSERT INTO tracking_links (client_id, slug, name, message, utm_source, utm_medium, utm_campaign) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, slug, t('name') || 'Link', t('message') || 'Olá!', t('utm_source'), t('utm_medium'), t('utm_campaign'));
    return back(reply, `/admin/clients/${c.id}/links`, 'Link criado. Copie e use onde quiser.');
  });

  app.post('/admin/links/:id/delete', async (req, reply) => {
    const l = db.prepare('SELECT * FROM tracking_links WHERE id = ?').get(Number((req.params as Form).id)) as TrackingLink | undefined;
    if (!l) return notFound(reply);
    db.prepare('DELETE FROM tracking_links WHERE id = ?').run(l.id);
    return back(reply, `/admin/clients/${l.client_id}/links`, 'Link excluído.');
  });

  // ----- Conexão do WhatsApp pela Evolution --------------------------------
  app.get('/admin/clients/:id/whatsapp/status', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return reply.code(404).send({ error: 'cliente não encontrado' });
    reply.header('Cache-Control', 'no-store');
    try {
      const state = await getInstanceState(c.evolution_instance);
      if (state === 'missing' || state === 'open') return { state };
      return await connectInstance(c.evolution_instance, normalizePhone((req.query as Form).number || ''));
    } catch (err) {
      return { state: 'error', error: (err as Error).message.slice(0, 200) };
    }
  });

  app.post('/admin/clients/:id/whatsapp/create', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const setup = `/admin/clients/${c.id}/setup`;
    try {
      if ((await getInstanceState(c.evolution_instance)) === 'missing') await createInstance(c.evolution_instance);
      // Webhook configurado já na criação: as mensagens chegam assim que o QR Code for lido
      await setInstanceWebhook(c.evolution_instance, `${config.baseUrl}/webhooks/evolution/${c.webhook_token}`);
      return back(reply, setup, 'Instância criada. Agora leia o QR Code com o celular do cliente.');
    } catch (err) {
      return back(reply, setup, `Falha ao criar a instância: ${(err as Error).message}`);
    }
  });

  app.post('/admin/clients/:id/whatsapp/logout', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    try {
      await logoutInstance(c.evolution_instance);
      return back(reply, `/admin/clients/${c.id}/setup`, 'WhatsApp desconectado.');
    } catch (err) {
      return back(reply, `/admin/clients/${c.id}/setup`, `Falha ao desconectar: ${(err as Error).message}`);
    }
  });

  app.post('/admin/clients/:id/evolution-webhook', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    try {
      await setInstanceWebhook(c.evolution_instance, `${config.baseUrl}/webhooks/evolution/${c.webhook_token}`);
      return back(reply, `/admin/clients/${c.id}/setup`, 'WhatsApp ligado ao Vendeuzap. Envie uma mensagem de teste para confirmar.');
    } catch (err) {
      return back(reply, `/admin/clients/${c.id}/setup`, `Falha ao conectar: ${(err as Error).message}`);
    }
  });

  app.post('/admin/clients/:id/sync-labels', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    try {
      const labels = await fetchLabels(c.evolution_instance);
      const up = db.prepare(
        `INSERT INTO labels (client_id, label_id, name) VALUES (?, ?, ?) ON CONFLICT(client_id, label_id) DO UPDATE SET name = excluded.name`,
      );
      db.transaction(() => labels.forEach((l) => l.id && up.run(c.id, l.id, l.name)))();
      return back(reply, `/admin/clients/${c.id}/setup`, `${labels.length} etiqueta(s) encontrada(s).`);
    } catch (err) {
      return back(reply, `/admin/clients/${c.id}/setup`, `Falha ao buscar etiquetas: ${(err as Error).message}`);
    }
  });
}

export { eventsTable, loadEventGroups };

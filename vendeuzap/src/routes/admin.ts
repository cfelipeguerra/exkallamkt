import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import type { DB } from '../db.js';
import { fetchLabels, setInstanceWebhook } from '../integrations/evolution.js';
import { googleAdsApiEnabled } from '../integrations/platforms.js';
import { processEvent } from '../dispatcher.js';
import { encrypt, normalizePhone, parseMoney, slugify, token } from '../lib/util.js';
import { clientStats } from '../stats.js';
import { platformsFor, registerSale } from '../tracking.js';
import type { Client, Contact, TrackEvent, TrackingLink } from '../types.js';
import { brl, dt, html, layout, raw, SOURCE_LABEL, type Raw } from '../views/html.js';

type Form = Record<string, string | undefined>;

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

const notFound = (reply: FastifyReply) => reply.code(404).type('text/html').send(layout('Não encontrado', html`<h1>Não encontrado</h1>`));
const back = (reply: FastifyReply, url: string, msg?: string) =>
  reply.redirect(msg ? `${url}${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : url, 303);
const flashOf = (req: FastifyRequest) => ((req.query as Form).msg as string | undefined) ?? null;

const STATUS_CLASS: Record<string, string> = { sent: 'ok', pending: 'warn', error: 'err', skipped: 'muted' };
const STATUS_LABEL: Record<string, string> = { sent: 'enviado', pending: 'pendente', error: 'erro', skipped: 'ignorado' };
const KIND_LABEL: Record<string, string> = { lead: 'Lead', qualified: 'Lead qualificado', purchase: 'Compra' };
const PLATFORM_LABEL: Record<string, string> = { meta: 'Meta', ga4: 'GA4', gads: 'Google Ads' };

// ---------------------------------------------------------------------------
// Formulário de cliente
// ---------------------------------------------------------------------------

function clientForm(c: Partial<Client>, action: string): Raw {
  const v = (k: keyof Client) => (c[k] ?? '') as string | number;
  const secret = (k: keyof Client) => (c[k] ? 'configurado — deixe em branco para manter' : '');
  const check = (k: keyof Client) => (c[k] ? raw('checked') : '');
  return html`<form method="post" action="${action}">
  <fieldset><legend>Cliente</legend><div class="cols">
    <div><label>Nome</label><input name="name" required value="${v('name')}"></div>
    <div><label>Número do WhatsApp (com DDI)</label><input name="whatsapp_number" required placeholder="5511999999999" value="${v('whatsapp_number')}"></div>
    <div><label>Nome da instância na Evolution</label><input name="evolution_instance" required value="${v('evolution_instance')}"></div>
    <div><label>Moeda</label><input name="currency" maxlength="3" value="${v('currency') || 'BRL'}"></div>
    <div><label>Ticket padrão (quando a venda não tiver valor)</label><input name="default_sale_value" value="${v('default_sale_value') || 0}"></div>
  </div></fieldset>

  <fieldset><legend>Detecção de vendas</legend><div class="cols">
    <div><label>Palavras-chave (mensagens enviadas pela empresa)</label><textarea name="sale_keywords" rows="3">${v('sale_keywords')}</textarea>
      <div class="hint">Separe por | ou vírgula. Ex.: pagamento confirmado|pedido confirmado. O valor é lido da própria mensagem ("R$ 150,00", "total: 150") ou do último valor citado pela empresa na conversa.</div></div>
    <div><label>Etiquetas do WhatsApp Business que indicam venda</label><input name="sale_labels" value="${v('sale_labels')}">
      <label>Etiquetas que indicam lead qualificado</label><input name="qualified_labels" value="${v('qualified_labels')}"></div>
    <div><label><input type="checkbox" name="send_lead_event" value="1" ${check('send_lead_event')} style="width:auto"> Enviar evento de Lead na primeira mensagem</label>
      <label><input type="checkbox" name="invisible_ref" value="1" ${check('invisible_ref')} style="width:auto"> Código de rastreio invisível na mensagem</label>
      <div class="hint">O modo invisível usa caracteres de largura zero. É mais discreto, mas alguns teclados/apps podem removê-los se o lead editar a mensagem; o modo visível ("cód. VZ-…") é mais robusto.</div></div>
  </div></fieldset>

  <fieldset><legend>Meta (Conversions API)</legend><div class="cols">
    <div><label>ID do Pixel / Dataset</label><input name="meta_pixel_id" value="${v('meta_pixel_id')}"></div>
    <div><label>Token de acesso (CAPI)</label><input name="meta_access_token" type="password" autocomplete="off" placeholder="${secret('meta_access_token')}"></div>
    <div><label>Código de evento de teste (opcional)</label><input name="meta_test_event_code" value="${v('meta_test_event_code')}"></div>
    <div><label>ID da conta WhatsApp Business (WABA) — opcional</label><input name="meta_waba_id" value="${v('meta_waba_id')}">
      <div class="hint">Preencha somente se o número estiver na WhatsApp Business Platform e o dataset estiver vinculado à WABA. Com isso, leads de anúncio CTWA são enviados no modo oficial "business_messaging" com ctwa_clid.</div></div>
  </div></fieldset>

  <fieldset><legend>Google Analytics 4 (Measurement Protocol)</legend><div class="cols">
    <div><label>Measurement ID</label><input name="ga4_measurement_id" placeholder="G-XXXXXXX" value="${v('ga4_measurement_id')}"></div>
    <div><label>API secret</label><input name="ga4_api_secret" type="password" autocomplete="off" placeholder="${secret('ga4_api_secret')}"></div>
  </div></fieldset>

  <fieldset><legend>Google Ads (conversões offline por GCLID)</legend><div class="cols">
    <div><label>Customer ID</label><input name="gads_customer_id" placeholder="123-456-7890" value="${v('gads_customer_id')}"></div>
    <div><label>ID da ação de conversão — Compra (API)</label><input name="gads_purchase_action_id" value="${v('gads_purchase_action_id')}"></div>
    <div><label>ID da ação de conversão — Lead (API)</label><input name="gads_lead_action_id" value="${v('gads_lead_action_id')}"></div>
    <div><label>Nome da ação — Compra (feed CSV)</label><input name="gads_purchase_action_name" value="${v('gads_purchase_action_name')}"></div>
    <div><label>Nome da ação — Lead (feed CSV)</label><input name="gads_lead_action_name" value="${v('gads_lead_action_name')}"></div>
  </div>
  <div class="hint">${googleAdsApiEnabled() ? 'Credenciais da API do Google Ads configuradas no servidor: envio automático ativo.' : 'Sem credenciais da API do Google Ads no servidor: use o feed CSV com upload agendado (funciona sem developer token).'}</div>
  </fieldset>
  ${'id' in c && c.id ? html`<label><input type="checkbox" name="active" value="1" ${check('active')} style="width:auto"> Cliente ativo</label>` : ''}
  <p><button>Salvar</button></p></form>`;
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

// ---------------------------------------------------------------------------
// Componentes
// ---------------------------------------------------------------------------

export function kpis(s: ReturnType<typeof clientStats>, currency: string, days = 30): Raw {
  return html`<div class="grid">
    <div class="card kpi"><div class="v">${s.leads}</div><div class="l">Leads (${days} dias)</div></div>
    <div class="card kpi"><div class="v">${s.sales}</div><div class="l">Vendas</div></div>
    <div class="card kpi"><div class="v">${brl(s.revenue, currency)}</div><div class="l">Receita rastreada</div></div>
    <div class="card kpi"><div class="v">${(s.conversion * 100).toFixed(1)}%</div><div class="l">Conversão lead → cliente</div></div>
  </div>`;
}

export function breakdownTables(s: ReturnType<typeof clientStats>, currency: string): Raw {
  return html`<div class="cols">
  <div class="card wrap"><h2 style="margin-top:0">Por origem</h2><table><tr><th>Origem</th><th class="num">Leads</th><th class="num">Vendas</th><th class="num">Receita</th></tr>
    ${s.bySource.map((r) => html`<tr><td>${SOURCE_LABEL[r.source] ?? r.source}</td><td class="num">${r.leads}</td><td class="num">${r.sales}</td><td class="num">${brl(r.revenue, currency)}</td></tr>`)}
    ${s.bySource.length ? '' : html`<tr><td colspan="4" class="muted">Sem dados ainda.</td></tr>`}</table></div>
  <div class="card wrap"><h2 style="margin-top:0">Por campanha / anúncio</h2><table><tr><th>Campanha</th><th class="num">Leads</th><th class="num">Vendas</th><th class="num">Receita</th></tr>
    ${s.byCampaign.map((r) => html`<tr><td>${r.campaign}</td><td class="num">${r.leads}</td><td class="num">${r.sales}</td><td class="num">${brl(r.revenue, currency)}</td></tr>`)}
    ${s.byCampaign.length ? '' : html`<tr><td colspan="4" class="muted">Sem dados ainda.</td></tr>`}</table></div>
  </div>`;
}

function contactsTable(contacts: (Contact & { utm_campaign?: string | null; sales_total?: number })[], client: Client): Raw {
  return html`<div class="wrap"><table><tr><th>Contato</th><th>Origem</th><th>Campanha/anúncio</th><th>Status</th><th>1ª mensagem</th><th class="num">Vendas</th><th>Registrar venda</th></tr>
  ${contacts.map(
    (c) => html`<tr>
      <td><b>${c.push_name || '—'}</b><br><span class="muted">+${c.phone}</span></td>
      <td><span class="chip">${SOURCE_LABEL[c.source]}</span>${c.ctwa_clid ? html` <span class="chip" title="ctwa_clid recebido">clid</span>` : ''}</td>
      <td>${c.utm_campaign || c.ad_title || c.ad_source_id || '—'}</td>
      <td>${c.status === 'customer' ? html`<span class="ok">cliente</span>` : c.status === 'qualified' ? 'qualificado' : 'lead'}</td>
      <td>${dt(c.first_message_at)}</td>
      <td class="num">${c.sales_total ? brl(c.sales_total, client.currency) : '—'}</td>
      <td><form class="inline" method="post" action="/admin/contacts/${c.id}/sale">
        <input name="value" placeholder="${String(c.last_quoted_value ?? client.default_sale_value).replace('.', ',')}" size="8" inputmode="decimal">
        <button>Venda</button></form></td></tr>`,
  )}
  ${contacts.length ? '' : html`<tr><td colspan="7" class="muted">Nenhum contato ainda.</td></tr>`}</table></div>`;
}

function eventsTable(events: (TrackEvent & { phone?: string })[]): Raw {
  return html`<div class="wrap"><table><tr><th>Quando</th><th>Evento</th><th>Plataforma</th><th>Contato</th><th>Status</th><th>Detalhe</th><th></th></tr>
  ${events.map(
    (e) => html`<tr><td>${dt(e.created_at)}</td><td>${KIND_LABEL[e.kind]}</td><td>${PLATFORM_LABEL[e.platform]}</td>
      <td>${e.phone ? `+${e.phone}` : '—'}</td>
      <td class="${STATUS_CLASS[e.status]}">${STATUS_LABEL[e.status]}${e.attempts > 1 ? ` (${e.attempts}x)` : ''}</td>
      <td style="max-width:360px">${e.detail || ''}${e.request ? html`<details><summary class="muted">payload</summary><pre>${e.request}</pre>${e.response ? html`<pre>${e.response}</pre>` : ''}</details>` : ''}</td>
      <td>${e.status !== 'sent' ? html`<form method="post" action="/admin/events/${e.id}/retry"><button class="secondary">Reenviar</button></form>` : ''}</td></tr>`,
  )}
  ${events.length ? '' : html`<tr><td colspan="7" class="muted">Nenhum evento ainda.</td></tr>`}</table></div>`;
}

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

  app.get('/admin', async (req, reply) => {
    const clients = db.prepare('SELECT * FROM clients ORDER BY active DESC, name').all() as Client[];
    const rows = clients.map((c) => {
      const s = clientStats(db, c.id);
      const errors = s.events.find((e) => e.status === 'error')?.n ?? 0;
      return html`<tr><td><a href="/admin/clients/${c.id}"><b>${c.name}</b></a>${c.active ? '' : html` <span class="chip">inativo</span>`}</td>
        <td>${platformsFor(c).map((p) => html`<span class="chip">${PLATFORM_LABEL[p]}</span> `)}</td>
        <td class="num">${s.leads}</td><td class="num">${s.sales}</td><td class="num">${brl(s.revenue, c.currency)}</td>
        <td class="num ${errors ? 'err' : ''}">${errors}</td></tr>`;
    });
    reply.type('text/html').send(
      layout('Clientes', html`<h1>Clientes</h1><div class="card wrap"><table>
      <tr><th>Cliente</th><th>Destinos</th><th class="num">Leads 30d</th><th class="num">Vendas 30d</th><th class="num">Receita 30d</th><th class="num">Erros de envio</th></tr>
      ${rows}${clients.length ? '' : html`<tr><td colspan="6" class="muted">Nenhum cliente. <a href="/admin/clients/new">Cadastre o primeiro</a>.</td></tr>`}
      </table></div>`, { flash: flashOf(req) }),
    );
  });

  app.get('/admin/clients/new', async (_req, reply) => {
    reply.type('text/html').send(
      layout('Novo cliente', html`<h1>Novo cliente</h1>${clientForm({ send_lead_event: 1, currency: 'BRL', sale_keywords: 'pagamento confirmado|pedido confirmado|compra confirmada|venda confirmada', sale_labels: 'Venda|Comprou|Pago', qualified_labels: 'Qualificado|Lead quente' }, '/admin/clients')}`),
    );
  });

  app.post('/admin/clients', async (req, reply) => {
    const data = readClientForm(req.body as Form);
    let slug = slugify(String(data.name)) || 'cliente';
    while (db.prepare('SELECT 1 FROM clients WHERE slug = ?').get(slug)) slug = `${slug}-${token(2).toLowerCase()}`;
    const full = { ...data, slug, webhook_token: token(), report_token: token(), api_token: token() };
    const keys = Object.keys(full);
    try {
      const info = db
        .prepare(`INSERT INTO clients (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`)
        .run(full);
      return back(reply, `/admin/clients/${info.lastInsertRowid}`, 'Cliente criado. Configure o webhook da Evolution abaixo.');
    } catch (err) {
      return back(reply, '/admin', `Erro ao salvar: ${(err as Error).message}`);
    }
  });

  app.get('/admin/clients/:id/edit', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    reply.type('text/html').send(layout(`Editar ${c.name}`, html`<h1>Editar ${c.name}</h1>${clientForm(c, `/admin/clients/${c.id}`)}`));
  });

  app.post('/admin/clients/:id', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const data = readClientForm(req.body as Form, c);
    const sets = Object.keys(data).map((k) => `${k} = @${k}`).join(', ');
    try {
      db.prepare(`UPDATE clients SET ${sets} WHERE id = @id`).run({ ...data, id: c.id });
      return back(reply, `/admin/clients/${c.id}`, 'Configurações salvas.');
    } catch (err) {
      return back(reply, `/admin/clients/${c.id}/edit`, `Erro: ${(err as Error).message}`);
    }
  });

  app.get('/admin/clients/:id', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const s = clientStats(db, c.id);
    const links = db.prepare('SELECT * FROM tracking_links WHERE client_id = ? ORDER BY id DESC').all(c.id) as TrackingLink[];
    const contacts = db
      .prepare(
        `SELECT c.*, k.utm_campaign, (SELECT SUM(value) FROM sales s WHERE s.contact_id = c.id) sales_total
         FROM contacts c LEFT JOIN clicks k ON k.id = c.click_id
         WHERE c.client_id = ? AND c.messages_in > 0 ORDER BY c.last_message_at DESC LIMIT 25`,
      )
      .all(c.id) as (Contact & { utm_campaign: string | null; sales_total: number })[];
    const events = db
      .prepare(`SELECT e.*, c.phone FROM events e LEFT JOIN contacts c ON c.id = e.contact_id WHERE e.client_id = ? ORDER BY e.id DESC LIMIT 15`)
      .all(c.id) as (TrackEvent & { phone: string })[];
    const labels = db.prepare('SELECT name FROM labels WHERE client_id = ? ORDER BY name').all(c.id) as { name: string }[];
    const webhookUrl = `${config.baseUrl}/webhooks/evolution/${c.webhook_token}`;
    const tag = `<script src="${config.baseUrl}/t.js?c=${c.slug}${c.invisible_ref ? '&inv=1' : ''}" async></script>`;

    reply.type('text/html').send(
      layout(c.name, html`
      <h1>${c.name} <a class="btn secondary" href="/admin/clients/${c.id}/edit" style="font-size:13px;vertical-align:middle">Configurações</a></h1>
      ${kpis(s, c.currency)}
      ${breakdownTables(s, c.currency)}

      <h2>Conversas recentes</h2>
      <div class="card"><form class="inline" method="get" action="/admin/clients/${c.id}/contacts" style="margin-bottom:10px">
        <input name="q" placeholder="Buscar por nome ou telefone"><button class="secondary">Buscar</button>
        <a href="/admin/clients/${c.id}/contacts">ver todas</a></form>
        ${contactsTable(contacts, c)}</div>

      <h2>Eventos enviados</h2>
      <div class="card">${eventsTable(events)}<p><a href="/admin/clients/${c.id}/events">ver todos</a></p></div>

      <h2>Links rastreáveis</h2>
      <div class="card">
        <p class="muted" style="margin-top:0">Use em bio, botões de anúncios para site, QR codes e campanhas do Google. Os parâmetros fbclid, gclid e UTMs da URL são capturados automaticamente.</p>
        <div class="wrap"><table><tr><th>Nome</th><th>URL</th><th>Mensagem</th><th></th></tr>
        ${links.map((l) => html`<tr><td>${l.name}</td><td><code>${config.baseUrl}/r/${l.slug}</code></td><td>${l.message}</td>
          <td><form method="post" action="/admin/links/${l.id}/delete" onsubmit="return confirm('Excluir link?')"><button class="secondary">Excluir</button></form></td></tr>`)}
        </table></div>
        <form method="post" action="/admin/clients/${c.id}/links"><div class="cols">
          <div><label>Nome</label><input name="name" required placeholder="Bio Instagram"></div>
          <div><label>Mensagem inicial</label><input name="message" value="Olá! Gostaria de mais informações."></div>
          <div><label>utm_source</label><input name="utm_source"></div><div><label>utm_medium</label><input name="utm_medium"></div>
          <div><label>utm_campaign</label><input name="utm_campaign"></div>
        </div><p><button>Criar link</button></p></form>
      </div>

      <h2>Instalação</h2>
      <div class="card">
        <p><b>1. Webhook da Evolution</b> (eventos: MESSAGES_UPSERT, SEND_MESSAGE, LABELS_EDIT, LABELS_ASSOCIATION)</p>
        <pre>${webhookUrl}</pre>
        <form class="inline" method="post" action="/admin/clients/${c.id}/evolution-webhook"><button>Configurar automaticamente na instância "${c.evolution_instance}"</button></form>
        <form class="inline" method="post" action="/admin/clients/${c.id}/sync-labels"><button class="secondary">Sincronizar etiquetas</button></form>
        <p class="muted">Etiquetas conhecidas: ${labels.length ? labels.map((l) => l.name).join(', ') : 'nenhuma (sincronize ou edite uma etiqueta no app)'}</p>
        <p><b>2. Tag no site do cliente</b> (antes de &lt;/body&gt; ou via Google Tag Manager, como HTML personalizado)</p>
        <pre>${tag}</pre>
        <p><b>3. Registro de vendas via API</b> (n8n, CRM, checkout)</p>
        <pre>curl -X POST ${config.baseUrl}/api/v1/sales \\
  -H "Authorization: Bearer ${c.api_token}" -H "Content-Type: application/json" \\
  -d '{"phone":"5511999999999","value":199.90,"external_ref":"pedido-123"}'</pre>
        <p><b>4. Relatório para o cliente</b> (somente leitura)</p><pre>${config.baseUrl}/report/${c.report_token}</pre>
        ${c.gads_purchase_action_name || c.gads_lead_action_name ? html`<p><b>5. Feed CSV do Google Ads</b> (upload agendado via HTTPS)</p><pre>${config.baseUrl}/feeds/google-ads/${c.api_token}.csv</pre>` : ''}
      </div>`, { flash: flashOf(req) }),
    );
  });

  app.get('/admin/clients/:id/contacts', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const q = ((req.query as Form).q || '').trim();
    const like = `%${q}%`;
    const contacts = db
      .prepare(
        `SELECT c.*, k.utm_campaign, (SELECT SUM(value) FROM sales s WHERE s.contact_id = c.id) sales_total
         FROM contacts c LEFT JOIN clicks k ON k.id = c.click_id
         WHERE c.client_id = ? AND (? = '' OR c.phone LIKE ? OR c.push_name LIKE ?)
         ORDER BY c.last_message_at DESC LIMIT 300`,
      )
      .all(c.id, q, like, like) as (Contact & { utm_campaign: string | null; sales_total: number })[];
    reply.type('text/html').send(
      layout(`Contatos · ${c.name}`, html`<h1><a href="/admin/clients/${c.id}">${c.name}</a> · Contatos</h1>
      <div class="card"><form class="inline" method="get" style="margin-bottom:10px"><input name="q" value="${q}" placeholder="Nome ou telefone"><button class="secondary">Buscar</button></form>
      ${contactsTable(contacts, c)}</div>`, { flash: flashOf(req) }),
    );
  });

  app.get('/admin/clients/:id/events', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    const status = (req.query as Form).status || '';
    const events = db
      .prepare(
        `SELECT e.*, c.phone FROM events e LEFT JOIN contacts c ON c.id = e.contact_id
         WHERE e.client_id = ? AND (? = '' OR e.status = ?) ORDER BY e.id DESC LIMIT 300`,
      )
      .all(c.id, status, status) as (TrackEvent & { phone: string })[];
    reply.type('text/html').send(
      layout(`Eventos · ${c.name}`, html`<h1><a href="/admin/clients/${c.id}">${c.name}</a> · Eventos</h1>
      <p>${['', 'sent', 'pending', 'error', 'skipped'].map((s) => html`<a class="chip" href="?status=${s}">${s ? STATUS_LABEL[s] : 'todos'}</a> `)}</p>
      <div class="card">${eventsTable(events)}</div>`, { flash: flashOf(req) }),
    );
  });

  app.post('/admin/contacts/:id/sale', async (req, reply) => {
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number((req.params as Form).id)) as Contact | undefined;
    if (!contact) return notFound(reply);
    const client = getClient(db, contact.client_id)!;
    const typed = parseMoney((req.body as Form).value || '');
    const value = typed ?? contact.last_quoted_value ?? client.default_sale_value;
    registerSale(db, client, contact, { value, detectedBy: 'manual' });
    return back(reply, `/admin/clients/${client.id}`, `Venda de ${brl(value, client.currency)} registrada para +${contact.phone}.`);
  });

  app.post('/admin/events/:id/retry', async (req, reply) => {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number((req.params as Form).id)) as TrackEvent | undefined;
    if (!ev) return notFound(reply);
    const r = await processEvent(db, ev);
    return back(reply, `/admin/clients/${ev.client_id}/events`, `Reenvio: ${STATUS_LABEL[r.status]}${r.detail ? ` — ${r.detail}` : ''}`);
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
    return back(reply, `/admin/clients/${c.id}`, 'Link criado.');
  });

  app.post('/admin/links/:id/delete', async (req, reply) => {
    const l = db.prepare('SELECT * FROM tracking_links WHERE id = ?').get(Number((req.params as Form).id)) as TrackingLink | undefined;
    if (!l) return notFound(reply);
    db.prepare('DELETE FROM tracking_links WHERE id = ?').run(l.id);
    return back(reply, `/admin/clients/${l.client_id}`, 'Link excluído.');
  });

  app.post('/admin/clients/:id/evolution-webhook', async (req, reply) => {
    const c = getClient(db, (req.params as Form).id);
    if (!c) return notFound(reply);
    try {
      await setInstanceWebhook(c.evolution_instance, `${config.baseUrl}/webhooks/evolution/${c.webhook_token}`);
      return back(reply, `/admin/clients/${c.id}`, 'Webhook configurado na Evolution API.');
    } catch (err) {
      return back(reply, `/admin/clients/${c.id}`, `Falha ao configurar webhook: ${(err as Error).message}`);
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
      return back(reply, `/admin/clients/${c.id}`, `${labels.length} etiqueta(s) sincronizada(s).`);
    } catch (err) {
      return back(reply, `/admin/clients/${c.id}`, `Falha ao buscar etiquetas: ${(err as Error).message}`);
    }
  });
}

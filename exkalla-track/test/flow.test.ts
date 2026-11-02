import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { runDispatcherOnce } from '../src/dispatcher.js';
import { encrypt, extractRef } from '../src/lib/util.js';
import type { Contact, Sale, TrackEvent } from '../src/types.js';

let db: DB;
let app: FastifyInstance;
const WEBHOOK = '/webhooks/evolution/wh-token';
const auth = { authorization: `Basic ${Buffer.from('admin:test').toString('base64')}` };

const msg = (phone: string, text: string, extra: Record<string, unknown> = {}, fromMe = false, id = Math.random().toString(36)) => ({
  event: 'messages.upsert',
  instance: 'loja-teste',
  data: {
    key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe, id },
    pushName: fromMe ? 'Você' : 'Cliente Teste',
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...extra,
  },
});

before(async () => {
  // Simula credenciais da API do Google Ads (DRY_RUN impede chamadas reais)
  Object.assign(config.googleAds, { developerToken: 'dev', clientId: 'id', clientSecret: 'sec', refreshToken: 'ref' });
  db = openDb(':memory:');
  db.prepare(
    `INSERT INTO clients (name, slug, whatsapp_number, evolution_instance, webhook_token, report_token, api_token,
       meta_pixel_id, meta_access_token, ga4_measurement_id, ga4_api_secret, gads_customer_id, gads_purchase_action_id,
       gads_lead_action_id, gads_purchase_action_name, default_sale_value)
     VALUES ('Loja Teste', 'loja', '5511900000000', 'loja-teste', 'wh-token', 'rep-token', 'api-token',
       '123456', ?, 'G-TEST', ?, '123-456-7890', '999', '998', 'Venda WhatsApp', 100)`,
  ).run(encrypt('meta-token'), encrypt('ga-secret'));
  db.prepare(`INSERT INTO tracking_links (client_id, slug, name, message, utm_campaign) VALUES (1, 'loja-bio', 'Bio', 'Olá!', 'black-friday')`).run();
  app = await buildApp(db);
});

test('link rastreável -> lead -> venda por palavra-chave -> eventos enviados', async () => {
  const r = await app.inject({ method: 'GET', url: '/r/loja-bio?fbclid=FBCLID123&gclid=GCLID456', headers: { 'user-agent': 'Mozilla/5.0 Teste' } });
  assert.equal(r.statusCode, 302);
  const loc = new URL(r.headers.location as string);
  assert.equal(loc.host, 'wa.me');
  assert.equal(loc.pathname, '/5511900000000');
  const text = loc.searchParams.get('text')!;
  const ref = extractRef(text);
  assert.ok(ref, 'mensagem deve conter o código');

  // Lead envia a mensagem pré-preenchida
  let w = await app.inject({ method: 'POST', url: WEBHOOK, payload: msg('5511987654321', text) });
  assert.equal(w.statusCode, 200);
  assert.match(JSON.stringify(w.json()), /lead criado \(link\)/);
  const contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get('5511987654321') as Contact;
  assert.equal(contact.source, 'link');
  assert.ok(contact.click_id);

  // Empresa passa o orçamento e depois confirma o pagamento
  await app.inject({ method: 'POST', url: WEBHOOK, payload: msg('5511987654321', 'Fica R$ 1.250,00 no pix', {}, true) });
  w = await app.inject({ method: 'POST', url: WEBHOOK, payload: msg('5511987654321', 'Pagamento confirmado! Obrigado 🙏', {}, true) });
  assert.match(JSON.stringify(w.json()), /venda por palavra-chave/);
  const sale = db.prepare('SELECT * FROM sales WHERE contact_id = ?').get(contact.id) as Sale;
  assert.equal(sale.value, 1250);

  // Mensagem duplicada (mesmo id) não gera nova venda
  const dup = msg('5511987654321', 'pagamento confirmado', {}, true, 'same-id');
  await app.inject({ method: 'POST', url: WEBHOOK, payload: dup });
  await app.inject({ method: 'POST', url: WEBHOOK, payload: dup });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sales').get() as { n: number }).n, 1);

  const n = await runDispatcherOnce(db);
  assert.equal(n, 6); // lead + compra em 3 plataformas
  const events = db.prepare('SELECT * FROM events ORDER BY id').all() as TrackEvent[];
  assert.ok(events.every((e) => e.status === 'sent'), JSON.stringify(events.map((e) => [e.platform, e.status, e.detail])));

  const metaPurchase = JSON.parse(events.find((e) => e.platform === 'meta' && e.kind === 'purchase')!.request!);
  const d = metaPurchase.data[0];
  assert.equal(d.event_name, 'Purchase');
  assert.equal(d.action_source, 'website');
  assert.match(d.user_data.fbc, /^fb\.1\.\d+\.FBCLID123$/);
  assert.equal(d.user_data.ph.length, 2); // com e sem 9º dígito
  assert.equal(d.custom_data.value, 1250);

  const gads = JSON.parse(events.find((e) => e.platform === 'gads' && e.kind === 'purchase')!.request!);
  assert.equal(gads.conversions[0].gclid, 'GCLID456');
  assert.equal(gads.conversions[0].conversionAction, 'customers/1234567890/conversionActions/999');

  const ga = JSON.parse(events.find((e) => e.platform === 'ga4' && e.kind === 'purchase')!.request!);
  assert.equal(ga.events[0].name, 'purchase');
  assert.equal(ga.events[0].params.transaction_id, `sale-${sale.id}`);
});

test('anúncio CTWA (sem WABA) usa CAPI padrão; com WABA usa business_messaging', async () => {
  const ctwa = { contextInfo: { externalAdReply: { sourceType: 'ad', sourceId: 'AD1', title: 'Anúncio X', ctwaClid: 'CLID-1' } } };
  await app.inject({ method: 'POST', url: WEBHOOK, payload: msg('5521988887777', 'Olá, vi o anúncio', ctwa) });
  const c = db.prepare('SELECT * FROM contacts WHERE phone = ?').get('5521988887777') as Contact;
  assert.equal(c.source, 'ctwa');
  assert.equal(c.ctwa_clid, 'CLID-1');
  await runDispatcherOnce(db);
  const lead = db.prepare(`SELECT * FROM events WHERE contact_id = ? AND platform = 'meta'`).get(c.id) as TrackEvent;
  const p1 = JSON.parse(lead.request!).data[0];
  assert.equal(p1.action_source, 'chat');
  assert.equal(p1.event_name, 'Lead');
  const gads = db.prepare(`SELECT * FROM events WHERE contact_id = ? AND platform = 'gads'`).get(c.id) as TrackEvent;
  assert.equal(gads.status, 'skipped');

  db.prepare(`UPDATE clients SET meta_waba_id = 'WABA9' WHERE id = 1`).run();
  // Venda via etiqueta do WhatsApp Business
  await app.inject({ method: 'POST', url: WEBHOOK, payload: { event: 'labels.edit', instance: 'loja-teste', data: { id: '5', name: 'Venda', color: 1 } } });
  await app.inject({ method: 'POST', url: WEBHOOK, payload: msg('5521988887777', 'Total: R$ 300,00', {}, true) });
  const w = await app.inject({
    method: 'POST', url: WEBHOOK,
    payload: { event: 'labels.association', instance: 'loja-teste', data: { instance: 'loja-teste', type: 'add', chatId: '5521988887777@s.whatsapp.net', labelId: '5' } },
  });
  assert.match(JSON.stringify(w.json()), /venda por etiqueta/);
  await runDispatcherOnce(db);
  const purchase = db.prepare(`SELECT * FROM events WHERE contact_id = ? AND platform = 'meta' AND kind = 'purchase'`).get(c.id) as TrackEvent;
  const p2 = JSON.parse(purchase.request!).data[0];
  assert.equal(p2.action_source, 'business_messaging');
  assert.equal(p2.messaging_channel, 'whatsapp');
  assert.deepEqual(p2.user_data, { whatsapp_business_account_id: 'WABA9', ctwa_clid: 'CLID-1' });
  assert.equal(p2.custom_data.value, 300);
  db.prepare(`UPDATE clients SET meta_waba_id = NULL WHERE id = 1`).run();
});

test('tag do site: clique via sendBeacon (text/plain) e atribuição', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/click', headers: { 'content-type': 'text/plain' },
    payload: JSON.stringify({ client: 'loja', ref: 'ABCDEF', fbp: 'fb.1.1.2', ga_client_id: '111.222', utm_campaign: 'site-camp', page_url: 'https://loja.com/produto' }),
  });
  assert.equal(r.statusCode, 200);
  await app.inject({ method: 'POST', url: WEBHOOK, payload: msg('5531977776666', 'Olá! (cód. XK-ABCDEF)') });
  const c = db.prepare('SELECT * FROM contacts WHERE phone = ?').get('5531977776666') as Contact;
  assert.equal(c.source, 'tag');
  const bad = await app.inject({ method: 'POST', url: '/api/click', headers: { 'content-type': 'text/plain' }, payload: '{"client":"nao-existe","ref":"ABCDEF"}' });
  assert.equal(bad.statusCode, 400);
});

test('API de vendas, feed CSV e relatório', async () => {
  const unauth = await app.inject({ method: 'POST', url: '/api/v1/sales', payload: { phone: '5531977776666', value: 10 } });
  assert.equal(unauth.statusCode, 401);
  const ok = await app.inject({
    method: 'POST', url: '/api/v1/sales', headers: { authorization: 'Bearer api-token' },
    payload: { phone: '31977776666', value: '89,90', external_ref: 'ped-1' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().sale.value, 89.9);
  const again = await app.inject({
    method: 'POST', url: '/api/v1/sales', headers: { authorization: 'Bearer api-token' },
    payload: { phone: '31977776666', value: 89.9, external_ref: 'ped-1' },
  });
  assert.equal(again.json().sale.id, ok.json().sale.id, 'external_ref idempotente');

  const csv = await app.inject({ method: 'GET', url: '/feeds/google-ads/api-token.csv' });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body, /GCLID456,Venda WhatsApp,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},1250,BRL/);

  const rep = await app.inject({ method: 'GET', url: '/report/rep-token' });
  assert.equal(rep.statusCode, 200);
  assert.match(rep.body, /Loja Teste/);
});

test('painel exige autenticação e renderiza', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/admin' })).statusCode, 401);
  const home = await app.inject({ method: 'GET', url: '/admin', headers: auth });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /Loja Teste/);
  const page = await app.inject({ method: 'GET', url: '/admin/clients/1', headers: auth });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /webhooks\/evolution\/wh-token/);
  const create = await app.inject({
    method: 'POST', url: '/admin/clients', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'name=Cl%C3%ADnica+Sorriso&whatsapp_number=(11)+98888-7777&evolution_instance=clinica&send_lead_event=1',
  });
  assert.equal(create.statusCode, 303);
  const row = db.prepare(`SELECT * FROM clients WHERE evolution_instance = 'clinica'`).get() as { slug: string; whatsapp_number: string };
  assert.equal(row.slug, 'clinica-sorriso');
  assert.equal(row.whatsapp_number, '5511988887777');
  const sale = await app.inject({
    method: 'POST', url: '/admin/contacts/1/sale', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'value=49%2C90',
  });
  assert.equal(sale.statusCode, 303);
});

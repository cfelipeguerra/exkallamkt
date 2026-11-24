import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { verifyStripeSignature } from '../src/billing.js';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { outbox } from '../src/email.js';
import type { Account, Client, User } from '../src/types.js';

const SECRET = 'whsec_teste';
let db: DB;
let app: FastifyInstance;
let n = 0;

/** Envia um evento como a Stripe envia: corpo JSON assinado no cabeçalho Stripe-Signature. */
async function stripe(type: string, object: unknown, opts: { secret?: string; id?: string } = {}) {
  const body = JSON.stringify({ id: opts.id ?? `evt_${++n}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${t}.${body}`).digest('hex');
  return app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, payload: body });
}

const checkout = (over: Record<string, unknown> = {}) => ({
  object: 'checkout.session', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1',
  metadata: { app: 'vendeuzap', plano: 'profissional', ciclo: 'mensal' },
  customer_details: { email: 'Ana@Otica.com.br', name: 'Ana Souza', business_name: 'Ótica Visão', phone: '+5511900001111' },
  custom_fields: [{ key: 'whatsapp', text: { value: '(11) 98888-7777' } }],
  ...over,
});
const subscription = (status: string, extras = 0, id = 'sub_1') => ({
  id, object: 'subscription', status, customer: 'cus_1', metadata: { app: 'vendeuzap', plano: 'profissional', ciclo: 'mensal' },
  items: { data: [
    { quantity: 1, price: { lookup_key: 'vendeuzap_profissional_mensal', recurring: { interval: 'month' } } },
    ...(extras ? [{ quantity: extras, price: { lookup_key: 'vendeuzap_numero_extra_mensal', recurring: { interval: 'month' } } }] : []),
  ] },
});

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
const linkIn = (text: string) => text.match(/\/entrar\/([A-Za-z0-9_-]+)/)![0];

before(async () => {
  config.stripe.webhookSecret = SECRET;
  config.email.notify = 'equipe@agencia.com.br';
  db = openDb(':memory:');
  app = await buildApp(db);
});

test('assinatura do webhook: aceita só o corpo assinado com o segredo certo e recente', () => {
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  const sig = (s: string, ts = t) => `t=${ts},v1=${createHmac('sha256', s).update(`${ts}.${body}`).digest('hex')}`;
  assert.ok(verifyStripeSignature(body, sig(SECRET), SECRET));
  assert.ok(!verifyStripeSignature(body, sig('outro'), SECRET));
  assert.ok(!verifyStripeSignature(body + ' ', sig(SECRET), SECRET));
  assert.ok(!verifyStripeSignature(body, sig(SECRET, t - 3600), SECRET), 'assinatura antiga');
  assert.ok(!verifyStripeSignature(body, undefined, SECRET));
});

test('compra: cria conta, acesso, primeiro número e envia boas-vindas', async () => {
  const bad = await stripe('checkout.session.completed', checkout(), { secret: 'errado' });
  assert.equal(bad.statusCode, 400);

  // A Stripe pode mandar a assinatura antes do checkout: a ordem não importa
  assert.equal((await stripe('customer.subscription.created', subscription('active', 2))).statusCode, 200);
  const r = await stripe('checkout.session.completed', checkout());
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.json().result, /conta criada/);

  const acc = db.prepare(`SELECT * FROM accounts WHERE stripe_subscription_id = 'sub_1'`).get() as Account;
  assert.equal(acc.plan, 'profissional');
  assert.equal(acc.numbers_allowed, 5, '3 do plano + 2 extras');
  const user = db.prepare('SELECT * FROM users').get() as User;
  assert.equal(user.email, 'ana@otica.com.br');
  const c = db.prepare('SELECT * FROM clients WHERE account_id = ?').get(acc.id) as Client;
  assert.equal(c.name, 'Ótica Visão');
  assert.equal(c.whatsapp_number, '5511988887777', 'WhatsApp do campo do checkout');
  assert.match(c.evolution_instance, /^vz-otica-visao/);

  const welcome = outbox.find((e) => e.to === 'ana@otica.com.br')!;
  assert.match(welcome.subject, /Bem-vindo/);
  const notice = outbox.find((e) => e.to === 'equipe@agencia.com.br')!;
  assert.match(notice.text, /Profissional/);

  // Evento repetido não duplica nada
  await stripe('checkout.session.completed', checkout(), { id: 'evt_rep' });
  await stripe('checkout.session.completed', checkout(), { id: 'evt_rep' });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM clients').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n, 1);

  // Assinatura de outro produto da mesma conta Stripe é ignorada
  const other = await stripe('checkout.session.completed', checkout({ subscription: 'sub_x', metadata: {} }));
  assert.match(other.json().result, /ignorado/);
});

test('acesso pelo link: entra, vê só os próprios números e não reaproveita o link', async () => {
  const welcome = outbox.find((e) => e.to === 'ana@otica.com.br')!;
  const link = linkIn(welcome.text);
  const login = await app.inject({ method: 'GET', url: link });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, '/admin');
  const cookie = cookieOf(login);
  assert.match(String(login.headers['set-cookie']), /HttpOnly/);
  assert.equal((await app.inject({ method: 'GET', url: link })).headers.location, '/entrar?erro=link', 'link de uso único');

  // Cliente de outra empresa, cadastrado pela agência
  db.prepare(`INSERT INTO clients (name, slug, whatsapp_number, evolution_instance, webhook_token, report_token, api_token)
              VALUES ('Outra Loja', 'outra', '5511900000000', 'outra', 'w-o', 'r-o', 'a-o')`).run();
  const otherId = (db.prepare(`SELECT id FROM clients WHERE slug = 'outra'`).get() as { id: number }).id;
  const mine = (db.prepare(`SELECT id FROM clients WHERE account_id IS NOT NULL`).get() as { id: number }).id;

  const home = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /Meus números de WhatsApp/);
  assert.match(home.body, /Plano Profissional · 1 de 5 números/);
  assert.match(home.body, /Ótica Visão/);
  assert.ok(!home.body.includes('Outra Loja'), 'não vê clientes de outras empresas');
  assert.match(home.body, /action="\/sair"/);

  for (const url of [`/admin/clients/${otherId}`, `/admin/clients/${otherId}/setup`, `/admin/clients/${otherId}/edit`]) {
    assert.equal((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/admin/clients/${otherId}/whatsapp/create`, headers: { cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/admin/clients/${mine}/setup`, headers: { cookie } })).statusCode, 200);

  // Formulário do cliente não mostra instância nem status
  const edit = await app.inject({ method: 'GET', url: `/admin/clients/${mine}/edit`, headers: { cookie } });
  assert.ok(!edit.body.includes('name="evolution_instance"') && !edit.body.includes('name="active"'));

  // Tentar trocar a instância pelo formulário não tem efeito
  const form = { cookie, 'content-type': 'application/x-www-form-urlencoded' };
  await app.inject({ method: 'POST', url: `/admin/clients/${mine}`, headers: form, payload: 'name=Ótica+Visão&whatsapp_number=11988887777&evolution_instance=outra-instancia' });
  assert.match((db.prepare('SELECT evolution_instance FROM clients WHERE id = ?').get(mine) as Client).evolution_instance, /^vz-otica-visao/);

  // Adiciona números até o limite do plano
  for (let i = 2; i <= 5; i++) {
    const r = await app.inject({ method: 'POST', url: '/admin/clients', headers: form, payload: `name=Filial+${i}&whatsapp_number=1197777000${i}&evolution_instance=roubada` });
    assert.equal(r.statusCode, 303);
  }
  const mineNow = db.prepare('SELECT * FROM clients WHERE account_id IS NOT NULL').all() as Client[];
  assert.equal(mineNow.length, 5);
  assert.ok(mineNow.every((c) => c.evolution_instance.startsWith('vz-')), 'instância sempre gerada pelo Vendeuzap');
  const over = await app.inject({ method: 'POST', url: '/admin/clients', headers: form, payload: 'name=Sexta&whatsapp_number=11977770006' });
  assert.match(decodeURIComponent(String(over.headers.location)), /não permite adicionar/);

  // Sair
  const out = await app.inject({ method: 'POST', url: '/sair', headers: { cookie } });
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
});

test('pedir novo link: mesma resposta para quem é e quem não é cliente', async () => {
  const before = outbox.length;
  const a = await app.inject({ method: 'POST', url: '/entrar', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'email=ana%40otica.com.br' });
  const b = await app.inject({ method: 'POST', url: '/entrar', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'email=ninguem%40x.com' });
  assert.equal(outbox.length, before + 1, 'só o cliente recebe e-mail');
  assert.match(a.body, /o link de acesso chega em instantes/);
  assert.match(b.body, /o link de acesso chega em instantes/);
  const link = linkIn(outbox[outbox.length - 1].text);
  assert.equal((await app.inject({ method: 'GET', url: link })).headers.location, '/admin');
});

test('cancelamento pausa os números; pagamento em dia reativa', async () => {
  await stripe('customer.subscription.updated', subscription('past_due', 2));
  let active = db.prepare('SELECT DISTINCT active FROM clients WHERE account_id IS NOT NULL').all() as { active: number }[];
  assert.deepEqual(active, [{ active: 1 }], 'atraso não pausa de imediato');

  const del = await stripe('customer.subscription.deleted', subscription('canceled', 2));
  assert.match(del.json().result, /canceled/);
  active = db.prepare('SELECT DISTINCT active FROM clients WHERE account_id IS NOT NULL').all() as { active: number }[];
  assert.deepEqual(active, [{ active: 0 }]);
  assert.ok(outbox.some((e) => /encerrada/.test(e.subject)));

  await stripe('customer.subscription.updated', subscription('active', 2));
  active = db.prepare('SELECT DISTINCT active FROM clients WHERE account_id IS NOT NULL').all() as { active: number }[];
  assert.deepEqual(active, [{ active: 1 }]);
});

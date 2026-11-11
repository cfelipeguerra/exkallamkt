import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';

/** Evolution API falsa, com as mesmas rotas e formatos de resposta da v2. */
const fake = {
  instances: new Map<string, { state: string; webhook: { url: string; enabled: boolean } | null }>(),
  calls: [] as string[],
};

let evo: Server;
let db: DB;
let app: FastifyInstance;
const auth = { authorization: `Basic ${Buffer.from('admin:test').toString('base64')}` };
const QR = 'data:image/png;base64,iVBORw0KGgo=';

before(async () => {
  evo = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.apikey !== 'chave-teste') return send(401, { error: 'Unauthorized' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      fake.calls.push(`${req.method} ${url.pathname}${url.search}`);
      const [, area, action, name] = url.pathname.split('/');
      const inst = name ? fake.instances.get(decodeURIComponent(name)) : undefined;
      if (area === 'instance' && action === 'create') {
        const { instanceName } = JSON.parse(body);
        fake.instances.set(instanceName, { state: 'connecting', webhook: null });
        return send(201, { instance: { instanceName, status: 'connecting' }, qrcode: { base64: QR, code: 'abc', count: 1 } });
      }
      if (!inst) return send(404, { status: 404, error: 'Not Found', response: { message: [`The "${name}" instance does not exist`] } });
      if (area === 'instance' && action === 'connectionState') return send(200, { instance: { instanceName: name, state: inst.state } });
      if (area === 'instance' && action === 'connect') {
        return send(200, { pairingCode: url.searchParams.get('number') ? 'ABCD1234' : null, code: 'abc', base64: QR, count: 2 });
      }
      if (area === 'instance' && action === 'logout') {
        inst.state = 'close';
        return send(200, { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } });
      }
      if (area === 'webhook' && action === 'find') return send(200, inst.webhook);
      if (area === 'webhook' && action === 'set') {
        const w = JSON.parse(body).webhook;
        inst.webhook = { url: w.url, enabled: w.enabled };
        return send(201, inst.webhook);
      }
      return send(404, {});
    });
  });
  await new Promise<void>((r) => evo.listen(0, '127.0.0.1', () => r()));
  config.evolution.url = `http://127.0.0.1:${(evo.address() as AddressInfo).port}`;
  config.evolution.apiKey = 'chave-teste';

  db = openDb(':memory:');
  app = await buildApp(db);
});

after(() => evo.close());

const form = { ...auth, 'content-type': 'application/x-www-form-urlencoded' };
const setupOf = async (id: number) => (await app.inject({ method: 'GET', url: `/admin/clients/${id}/setup`, headers: auth })).body;

test('cliente novo sem instância: cria, mostra QR Code, conecta e liga o webhook', async () => {
  // Instância em branco: o Vendeuzap gera o nome a partir do cliente
  const r = await app.inject({ method: 'POST', url: '/admin/clients', headers: form, payload: 'name=Loja+Nova&whatsapp_number=11988887777' });
  assert.equal(r.statusCode, 303);
  const c = db.prepare(`SELECT * FROM clients WHERE slug = 'loja-nova'`).get() as { id: number; evolution_instance: string; webhook_token: string };
  assert.equal(c.evolution_instance, 'vz-loja-nova');

  assert.match(await setupOf(c.id), /Criar e mostrar QR Code/);

  const created = await app.inject({ method: 'POST', url: `/admin/clients/${c.id}/whatsapp/create`, headers: auth });
  assert.equal(created.statusCode, 303);
  assert.match(decodeURIComponent(String(created.headers.location)), /Instância criada/);
  const inst = fake.instances.get('vz-loja-nova')!;
  assert.ok(inst, 'instância criada na Evolution');
  assert.equal(inst.webhook?.url, `${config.baseUrl}/webhooks/evolution/${c.webhook_token}`, 'webhook já configurado na criação');

  // Enquanto não lê o QR Code, a página mostra o painel e o status devolve a imagem
  assert.match(await setupOf(c.id), /Aguardando leitura do QR Code/);
  const st = await app.inject({ method: 'GET', url: `/admin/clients/${c.id}/whatsapp/status`, headers: auth });
  assert.equal(st.json().base64, QR);
  const pair = await app.inject({ method: 'GET', url: `/admin/clients/${c.id}/whatsapp/status?number=11988887777`, headers: auth });
  assert.equal(pair.json().pairingCode, 'ABCD1234');
  assert.ok(fake.calls.some((x) => x.includes('/instance/connect/vz-loja-nova?number=5511988887777')), 'número enviado com DDI');

  // Cliente leu o QR Code
  inst.state = 'open';
  assert.equal((await app.inject({ method: 'GET', url: `/admin/clients/${c.id}/whatsapp/status`, headers: auth })).json().state, 'open');
  assert.match(await setupOf(c.id), /ligado ao Vendeuzap/);

  // Desconectar
  const out = await app.inject({ method: 'POST', url: `/admin/clients/${c.id}/whatsapp/logout`, headers: auth });
  assert.equal(out.statusCode, 303);
  assert.equal(inst.state, 'close');
});

test('instância já conectada com webhook de outra ferramenta: avisa antes de substituir', async () => {
  fake.instances.set('loja-antiga', { state: 'open', webhook: { url: 'https://n8n.exemplo.com/webhook/bot', enabled: true } });
  await app.inject({ method: 'POST', url: '/admin/clients', headers: form, payload: 'name=Loja+Antiga&whatsapp_number=11977776666&evolution_instance=loja-antiga' });
  const c = db.prepare(`SELECT id FROM clients WHERE evolution_instance = 'loja-antiga'`).get() as { id: number };
  const page = await setupOf(c.id);
  assert.match(page, /falta ligar ao Vendeuzap/);
  assert.match(page, /n8n\.exemplo\.com/);
  assert.match(page, /desliga essa outra integração/);
});

test('Evolution fora do ar ou chave errada: mostra o problema sem quebrar a página', async () => {
  const key = config.evolution.apiKey;
  config.evolution.apiKey = 'errada';
  const page = await app.inject({ method: 'GET', url: '/admin/clients/1/setup', headers: auth });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /WhatsApp Manager indisponível/);
  config.evolution.apiKey = key;
});

test('editar cliente com instância em branco mantém a instância atual', async () => {
  await app.inject({ method: 'POST', url: '/admin/clients/1', headers: form, payload: 'name=Loja+Nova&whatsapp_number=11988887777&evolution_instance=&active=1' });
  const c = db.prepare('SELECT evolution_instance FROM clients WHERE id = 1').get() as { evolution_instance: string };
  assert.equal(c.evolution_instance, 'vz-loja-nova');
});

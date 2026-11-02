import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decrypt, encrypt, extractRef, extractValue, invisibleRef, appendRef, newRefCode, normalizePhone, phoneVariants, matchesAny } from '../src/lib/util.js';
import { extractAdReferral, parseEvolutionWebhook } from '../src/integrations/evolution.js';

test('código de rastreio visível e invisível ida e volta', () => {
  for (let i = 0; i < 50; i++) {
    const code = newRefCode();
    assert.equal(extractRef(appendRef('Olá! Quero saber mais', code, false)), code);
    assert.equal(extractRef(appendRef('Olá! Quero saber mais', code, true)), code);
    assert.equal(extractRef(`texto ${invisibleRef(code)} editado depois`), code);
  }
  assert.equal(extractRef('Olá, quero comprar'), null);
  assert.equal(extractRef('oi (cód. xk-abcdef)'), 'ABCDEF');
});

test('extração de valores em reais', () => {
  assert.equal(extractValue('Seu pedido ficou em R$ 1.234,56'), 1234.56);
  assert.equal(extractValue('Item A R$ 50,00 + Item B R$ 30,00. Total: R$ 80,00'), 80);
  assert.equal(extractValue('total 150'), 150);
  assert.equal(extractValue('R$1500.50 no pix'), 1500.5);
  assert.equal(extractValue('R$ 2.500'), 2500);
  assert.equal(extractValue('sem valor aqui'), null);
});

test('telefones e variações do 9º dígito', () => {
  assert.equal(normalizePhone('5511987654321@s.whatsapp.net'), '5511987654321');
  assert.equal(normalizePhone('(11) 98765-4321'), '5511987654321');
  assert.deepEqual(phoneVariants('551187654321').sort(), ['551187654321', '5511987654321'].sort());
  assert.deepEqual(phoneVariants('5511987654321').sort(), ['551187654321', '5511987654321'].sort());
  assert.deepEqual(phoneVariants('14155552671'), ['14155552671']);
});

test('criptografia de segredos', () => {
  const enc = encrypt('EAAB-token')!;
  assert.notEqual(enc, 'EAAB-token');
  assert.equal(decrypt(enc), 'EAAB-token');
  assert.equal(encrypt(''), null);
});

test('palavras-chave sem acento/maiúsculas', () => {
  assert.equal(matchesAny('PAGAMENTO CONFIRMADO, obrigado!', ['pagamento confirmado']), 'pagamento confirmado');
  assert.equal(matchesAny('Pedido confirmádo', ['pedido confirmado']), 'pedido confirmado');
  assert.equal(matchesAny('ainda aguardando', ['pagamento confirmado']), null);
});

test('parser da Evolution: mensagem de anúncio CTWA', () => {
  const evs = parseEvolutionWebhook({
    event: 'messages.upsert',
    instance: 'loja',
    data: {
      key: { remoteJid: '5511987654321@s.whatsapp.net', fromMe: false, id: 'ABC' },
      pushName: 'Maria',
      message: { conversation: 'Olá! Vi o anúncio' },
      contextInfo: {
        externalAdReply: { title: 'Promo', sourceType: 'ad', sourceId: '120200', sourceUrl: 'https://fb.me/x', ctwaClid: 'ARAkxyz' },
        conversionSource: 'FB_Ads',
      },
      messageTimestamp: 1760000000,
    },
  });
  assert.equal(evs.length, 1);
  const ev = evs[0];
  assert.equal(ev.type, 'message');
  if (ev.type !== 'message') return;
  assert.equal(ev.phone, '5511987654321');
  assert.equal(ev.ad?.ctwaClid, 'ARAkxyz');
  assert.equal(ev.ad?.sourceId, '120200');
});

test('parser da Evolution: LID usa remoteJidAlt, grupos ignorados', () => {
  const [lid] = parseEvolutionWebhook({
    event: 'MESSAGES_UPSERT',
    instance: 'x',
    data: { key: { remoteJid: '123456@lid', remoteJidAlt: '5521999998888@s.whatsapp.net', fromMe: false }, message: { conversation: 'oi' } },
  });
  assert.equal(lid.type, 'message');
  if (lid.type === 'message') {
    assert.equal(lid.phone, '5521999998888');
    assert.equal(lid.lid, '123456@lid');
  }
  const [grp] = parseEvolutionWebhook({ event: 'messages.upsert', data: { key: { remoteJid: '123@g.us' }, message: {} } });
  assert.equal(grp.type, 'ignored');
});

test('referral via extendedTextMessage.contextInfo', () => {
  const ad = extractAdReferral({
    message: { extendedTextMessage: { text: 'oi', contextInfo: { externalAdReply: { ctwaClid: 'C1', sourceType: 'ad' } } } },
  });
  assert.equal(ad?.ctwaClid, 'C1');
});

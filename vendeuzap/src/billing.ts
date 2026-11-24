/**
 * Assinaturas pela Stripe. O webhook recebe os eventos e, sem intervenção da equipe:
 * - checkout.session.completed: cria a conta, o acesso do cliente e o primeiro número, e envia as boas-vindas;
 * - customer.subscription.created/updated: atualiza plano, quantidade de números e status;
 * - customer.subscription.deleted: pausa os números e avisa o cliente.
 * A ordem de chegada dos eventos não importa: todos atualizam a mesma conta pelo ID da assinatura.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLoginToken, loginUrl } from './auth.js';
import { config } from './config.js';
import type { DB } from './db.js';
import { now } from './db.js';
import { type Email, newSubscriptionNotice, sendEmail, subscriptionEndedEmail, welcomeEmail } from './email.js';
import { normalizePhone, sha256, slugify, token } from './lib/util.js';
import type { Account, User } from './types.js';

const SIGNATURE_TOLERANCE_S = 300;
const WELCOME_LINK_S = 7 * 86400;
const BASE_NUMBERS: Record<string, number> = { essencial: 1, profissional: 3, agencia: 5 };

/** Confere o cabeçalho Stripe-Signature (t=...,v1=...) com o segredo do webhook. */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, at = now()): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(at - t) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Outcome {
  action: string;
  emails: Email[];
}

function upsertAccount(db: DB, subscriptionId: string, fields: Partial<Account>): Account {
  let acc = db.prepare('SELECT * FROM accounts WHERE stripe_subscription_id = ?').get(subscriptionId) as Account | undefined;
  if (!acc) {
    const info = db.prepare('INSERT INTO accounts (stripe_subscription_id) VALUES (?)').run(subscriptionId);
    acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid) as Account;
  }
  const keys = Object.keys(fields).filter((k) => (fields as any)[k] !== undefined && (fields as any)[k] !== null);
  if (keys.length) {
    db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id: acc.id });
  }
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc.id) as Account;
}

/** Números liberados: os do plano mais os "números extras" comprados na assinatura. */
function planFromSubscription(sub: any): { plan?: string; cycle?: string; numbers?: number } {
  const items: any[] = sub?.items?.data ?? [];
  let plan: string | undefined = sub?.metadata?.plano;
  let extras = 0;
  for (const it of items) {
    const key: string = it?.price?.lookup_key || '';
    if (key.startsWith('vendeuzap_numero_extra')) extras += Number(it.quantity) || 0;
    else if (!plan) plan = key.match(/^vendeuzap_([a-z]+)_/)?.[1];
  }
  const interval = items[0]?.price?.recurring?.interval;
  const cycle = sub?.metadata?.ciclo || (interval === 'year' ? 'anual' : interval === 'month' ? 'mensal' : undefined);
  return { plan, cycle, numbers: plan ? (BASE_NUMBERS[plan] ?? 1) + extras : undefined };
}

/** Pausa ou reativa os números conforme o status da assinatura. */
function applyStatus(db: DB, account: Account): void {
  if (['active', 'trialing'].includes(account.status)) {
    db.prepare('UPDATE clients SET active = 1 WHERE account_id = ?').run(account.id);
  } else if (['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(account.status)) {
    db.prepare('UPDATE clients SET active = 0 WHERE account_id = ?').run(account.id);
  }
}

function createFirstClient(db: DB, account: Account, name: string, whatsapp: string | null): number {
  let slug = slugify(name) || 'cliente';
  while (db.prepare('SELECT 1 FROM clients WHERE slug = ?').get(slug)) slug = `${slug}-${token(2).toLowerCase()}`;
  let instance = `vz-${slug}`;
  while (db.prepare('SELECT 1 FROM clients WHERE evolution_instance = ?').get(instance)) instance = `${instance}-${token(2).toLowerCase()}`;
  const info = db
    .prepare(
      `INSERT INTO clients (name, slug, whatsapp_number, evolution_instance, webhook_token, report_token, api_token, account_id, sale_labels, qualified_labels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Venda', 'Qualificado')`,
    )
    .run(name, slug, whatsapp || '', instance, token(), token(), token(), account.id);
  return Number(info.lastInsertRowid);
}

function onCheckoutCompleted(db: DB, s: any): Outcome {
  if (s?.mode !== 'subscription' || s?.metadata?.app !== 'vendeuzap' || !s?.subscription) {
    return { action: 'checkout ignorado (não é assinatura do Vendeuzap)', emails: [] };
  }
  const subscriptionId = typeof s.subscription === 'string' ? s.subscription : s.subscription.id;
  const d = s.customer_details || {};
  const email = String(d.email || s.customer_email || '').trim().toLowerCase();
  if (!email) return { action: 'checkout sem e-mail', emails: [] };
  const personName: string | null = d.individual_name || d.name || null;
  const businessName: string | null = d.business_name || null;
  const whatsField = (s.custom_fields || []).find((f: any) => f.key === 'whatsapp');
  const whatsapp = normalizePhone(whatsField?.text?.value || '') || normalizePhone(d.phone || '') || null;
  const plan = s.metadata?.plano || 'essencial';

  // Dados da compra para a página de obrigado (sem dados pessoais em texto aberto)
  if (s.id) db.prepare(
    `INSERT OR IGNORE INTO checkouts (session_id, amount_total, currency, plan, cycle, email_sha256, phone_sha256, phone_e164_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    String(s.id || ''),
    (Number(s.amount_total) || 0) / 100,
    String(s.currency || 'brl').toUpperCase(),
    plan,
    s.metadata?.ciclo ?? null,
    sha256(email),
    // Meta: só dígitos com DDI; Google: formato E.164 (com +)
    whatsapp ? sha256(whatsapp) : null,
    whatsapp ? sha256(`+${whatsapp}`) : null,
  );

  const account = upsertAccount(db, subscriptionId, {
    plan,
    cycle: s.metadata?.ciclo,
    stripe_customer_id: typeof s.customer === 'string' ? s.customer : s.customer?.id,
  });
  if (account.numbers_allowed < (BASE_NUMBERS[plan] ?? 1)) {
    db.prepare('UPDATE accounts SET numbers_allowed = ? WHERE id = ?').run(BASE_NUMBERS[plan] ?? 1, account.id);
  }

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
  if (!user) {
    const info = db.prepare('INSERT INTO users (email, name, account_id) VALUES (?, ?, ?)').run(email, personName, account.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as User;
  } else {
    db.prepare('UPDATE users SET account_id = ?, name = COALESCE(name, ?) WHERE id = ?').run(account.id, personName, user.id);
  }

  const hasClient = db.prepare('SELECT 1 FROM clients WHERE account_id = ?').get(account.id);
  const clientName = businessName || personName || email.split('@')[0];
  const clientId = hasClient ? null : createFirstClient(db, account, clientName, whatsapp);

  const emails: Email[] = [welcomeEmail(email, personName, plan, loginUrl(createLoginToken(db, user.id, WELCOME_LINK_S)))];
  if (config.email.notify) {
    emails.push(
      newSubscriptionNotice(config.email.notify, {
        name: clientName,
        email,
        plan,
        cycle: s.metadata?.ciclo ?? null,
        whatsapp,
        panelUrl: clientId ? `${config.baseUrl}/admin/clients/${clientId}` : `${config.baseUrl}/admin`,
      }),
    );
  }
  return { action: `conta criada para ${email}`, emails };
}

function onSubscriptionChanged(db: DB, sub: any, deleted: boolean): Outcome {
  if (!sub?.id) return { action: 'assinatura sem id', emails: [] };
  const exists = db.prepare('SELECT 1 FROM accounts WHERE stripe_subscription_id = ?').get(sub.id);
  const p = planFromSubscription(sub);
  // Assinaturas de outros produtos da mesma conta Stripe não criam conta no Vendeuzap
  if (!exists && !p.plan && sub?.metadata?.app !== 'vendeuzap') return { action: 'assinatura de outro produto', emails: [] };
  const before = exists ? (db.prepare('SELECT status FROM accounts WHERE stripe_subscription_id = ?').get(sub.id) as { status: string }).status : null;
  const account = upsertAccount(db, sub.id, {
    plan: p.plan,
    cycle: p.cycle,
    numbers_allowed: p.numbers,
    status: deleted ? 'canceled' : sub.status,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
  });
  applyStatus(db, account);
  const emails: Email[] = [];
  if (account.status === 'canceled' && before !== 'canceled') {
    const users = db.prepare('SELECT email FROM users WHERE account_id = ?').all(account.id) as { email: string }[];
    for (const u of users) emails.push(subscriptionEndedEmail(u.email));
  }
  return { action: `assinatura ${account.status} (${account.numbers_allowed} número(s))`, emails };
}

/** Processa um evento já verificado. Eventos repetidos (a Stripe reenvia) são ignorados. */
export async function handleStripeEvent(db: DB, event: any, log: (m: string) => void = console.log): Promise<string> {
  if (!event?.id || !event?.type) return 'evento inválido';
  const outcome = db.transaction((): Outcome => {
    const fresh = db.prepare('INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)').run(event.id, event.type).changes > 0;
    if (!fresh) return { action: 'evento repetido', emails: [] };
    const obj = event.data?.object;
    switch (event.type) {
      case 'checkout.session.completed':
        return onCheckoutCompleted(db, obj);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return onSubscriptionChanged(db, obj, false);
      case 'customer.subscription.deleted':
        return onSubscriptionChanged(db, obj, true);
      default:
        return { action: `evento ${event.type} não utilizado`, emails: [] };
    }
  })();
  for (const e of outcome.emails) await sendEmail(e, log);
  return outcome.action;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

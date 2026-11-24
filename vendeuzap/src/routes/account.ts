import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clearSession, consumeLoginToken, createLoginToken, customerViewer, loginUrl, setSession } from '../auth.js';
import { handleStripeEvent, verifyStripeSignature } from '../billing.js';
import { config } from '../config.js';
import type { DB } from '../db.js';
import { loginEmail, sendEmail } from '../email.js';
import type { User } from '../types.js';
import { html, layout } from '../views/html.js';

const LOGIN_LINK_S = 30 * 60;
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function loginPage(message: string | null, kind: 'ok' | 'err' | null, email = ''): string {
  return layout('Entrar', html`
    <div class="card" style="max-width:460px;margin:40px auto 0">
      <h1 style="font-size:24px">Entrar no Vendeuzap</h1>
      <p class="sub" style="margin-bottom:18px">Digite o e-mail usado na assinatura. Enviamos um link de acesso, sem senha.</p>
      ${message ? html`<div class="flash ${kind === 'err' ? 'err' : ''}" style="margin-bottom:14px">${message}</div>` : ''}
      <form method="post" action="/entrar">
        <label for="login-email">E-mail</label>
        <input id="login-email" name="email" type="email" required autocomplete="email" value="${email}" placeholder="voce@empresa.com.br">
        <div class="row" style="margin-top:16px"><button>Enviar link de acesso</button></div>
      </form>
      <p class="help" style="margin-top:22px">É da equipe da agência? <a href="/admin?agencia=1">Acesso da agência</a></p>
    </div>`, { nav: false });
}

export function registerAccountRoutes(app: FastifyInstance, db: DB): void {
  app.get('/entrar', async (req, reply) => {
    if (customerViewer(db, req)) return reply.redirect('/admin', 303);
    const q = req.query as { erro?: string };
    const msg = q.erro === 'link' ? 'Esse link expirou ou já foi usado. Peça um novo abaixo.' : null;
    reply.type('text/html').send(loginPage(msg, msg ? 'err' : null));
  });

  app.post('/entrar', async (req, reply) => {
    const email = String((req.body as { email?: string })?.email || '').trim().toLowerCase();
    if (!emailOk(email)) return reply.type('text/html').send(loginPage('Digite um e-mail válido.', 'err', email));
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
    if (user) await sendEmail(loginEmail(email, loginUrl(createLoginToken(db, user.id, LOGIN_LINK_S))), (m) => req.log.warn(m));
    // Mesma resposta exista ou não a conta, para não revelar quais e-mails são clientes
    reply.type('text/html').send(loginPage(`Se ${email} tiver uma assinatura, o link de acesso chega em instantes. Confira também a caixa de spam.`, 'ok'));
  });

  app.get('/entrar/:token', async (req, reply) => {
    const user = consumeLoginToken(db, (req.params as { token: string }).token);
    if (!user) return reply.redirect('/entrar?erro=link', 303);
    setSession(reply, user.id);
    return reply.redirect('/admin', 303);
  });

  app.post('/sair', async (_req, reply) => {
    clearSession(reply);
    return reply.redirect('/entrar', 303);
  });

  /** Webhook da Stripe: Stripe › Desenvolvedores › Webhooks, apontando para esta URL. */
  app.post('/webhooks/stripe', async (req: FastifyRequest, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    if (!config.stripe.webhookSecret) return reply.code(503).send({ error: 'STRIPE_WEBHOOK_SECRET não configurado' });
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'] as string | undefined, config.stripe.webhookSecret)) {
      return reply.code(400).send({ error: 'assinatura inválida' });
    }
    try {
      const result = await handleStripeEvent(db, req.body, (m) => req.log.warn(m));
      req.log.info({ stripe: result }, 'evento da Stripe processado');
      return { received: true, result };
    } catch (err) {
      req.log.error({ err }, 'falha ao processar evento da Stripe');
      return reply.code(500).send({ error: 'falha ao processar' });
    }
  });
}

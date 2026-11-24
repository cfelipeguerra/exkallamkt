import { randomBytes } from 'node:crypto';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return v;
}

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  /** URL pública desta aplicação, usada para montar links e o webhook da Evolution. */
  baseUrl: env('BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
  /** Sites que podem consultar a compra na página de obrigado */
  siteOrigins: env('SITE_ORIGINS', 'https://www.vendeuzap.com.br,https://vendeuzap.com.br')
    .split(',')
    .map((v) => v.trim().replace(/\/$/, ''))
    .filter(Boolean),
  dbPath: env('DB_PATH', isTest ? ':memory:' : './data/vendeuzap.db'),

  admin: {
    user: env('ADMIN_USER', 'admin'),
    password: env('ADMIN_PASSWORD', isTest ? 'test' : ''),
  },

  /** Chave de 32 bytes (hex ou base64) usada para criptografar tokens de clientes no banco. */
  encryptionKey: env('ENCRYPTION_KEY', isTest ? randomBytes(32).toString('hex') : ''),

  evolution: {
    url: env('EVOLUTION_URL', '').replace(/\/$/, ''),
    apiKey: env('EVOLUTION_API_KEY', ''),
  },

  meta: {
    graphVersion: env('META_GRAPH_VERSION', 'v25.0'),
  },

  /** Credenciais Google Ads da agência (MCC). Opcional: sem elas, use o feed CSV. */
  googleAds: {
    apiVersion: env('GOOGLE_ADS_API_VERSION', 'v25'),
    developerToken: env('GOOGLE_ADS_DEVELOPER_TOKEN', ''),
    loginCustomerId: env('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '').replace(/-/g, ''),
    clientId: env('GOOGLE_ADS_CLIENT_ID', ''),
    clientSecret: env('GOOGLE_ADS_CLIENT_SECRET', ''),
    refreshToken: env('GOOGLE_ADS_REFRESH_TOKEN', ''),
  },

  /** Assinaturas pela Stripe (o webhook cria a conta do cliente automaticamente). */
  stripe: {
    webhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),
    /** Link de login do portal do cliente (Stripe › Configurações › Portal do cliente). */
    portalUrl: env('STRIPE_PORTAL_URL', ''),
  },

  /** E-mails transacionais (boas-vindas, link de acesso). Sem chave, os e-mails só vão para o log. */
  email: {
    resendApiKey: env('RESEND_API_KEY', ''),
    from: env('EMAIL_FROM', 'Vendeuzap <ola@vendeuzap.com.br>'),
    replyTo: env('EMAIL_REPLY_TO', ''),
    /** Quem recebe o aviso de cada nova assinatura. */
    notify: env('NOTIFY_EMAIL', ''),
  },

  /** Quando true, nenhum evento é enviado de fato às plataformas (útil para homologação). */
  dryRun: env('DRY_RUN', isTest ? 'true' : 'false') === 'true',
  dispatcherIntervalMs: Number(env('DISPATCHER_INTERVAL_MS', '10000')),
  defaultCountryCode: env('DEFAULT_COUNTRY_CODE', '55'),
  timezone: env('TIMEZONE', 'America/Sao_Paulo'),
};

export function assertProductionConfig(): void {
  const missing: string[] = [];
  if (!config.admin.password) missing.push('ADMIN_PASSWORD');
  if (!config.encryptionKey) missing.push('ENCRYPTION_KEY');
  if (missing.length) {
    throw new Error(`Configure as variáveis: ${missing.join(', ')} (veja .env.example)`);
  }
}

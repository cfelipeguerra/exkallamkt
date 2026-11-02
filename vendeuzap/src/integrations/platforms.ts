/**
 * Montagem e envio dos eventos de conversão para Meta (Conversions API),
 * Google Analytics 4 (Measurement Protocol) e Google Ads (upload de conversões offline).
 */
import { config } from '../config.js';
import { decrypt, phoneVariants, sha256 } from '../lib/util.js';
import type { Click, Client, Contact, EventKind, Sale, TrackEvent } from '../types.js';

export interface EventContext {
  event: TrackEvent;
  client: Client;
  contact: Contact;
  click: Click | null;
  sale: Sale | null;
}

export interface SendResult {
  status: 'sent' | 'skipped' | 'error';
  detail?: string;
  request?: unknown;
  response?: unknown;
  /** Erros definitivos (ex.: 400 por dado inválido) não são re-tentados. */
  permanent?: boolean;
}

// ---------------------------------------------------------------------------
// Meta Conversions API
// ---------------------------------------------------------------------------

const META_STANDARD_NAMES: Record<EventKind, string> = { lead: 'Lead', qualified: 'QualifiedLead', purchase: 'Purchase' };
/** Nomes usados no modo "business_messaging" (Conversions API for Business Messaging). */
const META_BM_NAMES: Record<EventKind, string> = { lead: 'LeadSubmitted', qualified: 'QualifiedLead', purchase: 'Purchase' };

export function buildMetaPayload(ctx: EventContext): Record<string, unknown> {
  const { event, client, contact, click, sale } = ctx;
  const businessMessaging = Boolean(client.meta_waba_id && contact.ctwa_clid);

  const custom: Record<string, unknown> = {};
  if (sale) {
    custom.currency = sale.currency;
    custom.value = sale.value;
    custom.order_id = `sale-${sale.id}`;
  }
  custom.lead_source = contact.source;
  if (contact.ad_source_id) custom.ad_id = contact.ad_source_id;

  let data: Record<string, unknown>;
  if (businessMessaging) {
    data = {
      event_name: META_BM_NAMES[event.kind],
      event_time: event.event_time,
      event_id: event.event_id,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: {
        whatsapp_business_account_id: client.meta_waba_id,
        ctwa_clid: contact.ctwa_clid,
      },
      custom_data: custom,
    };
  } else {
    const user: Record<string, unknown> = {
      ph: phoneVariants(contact.phone).map(sha256),
      external_id: [sha256(`${client.id}:${contact.phone}`)],
    };
    if (contact.phone.startsWith('55')) user.country = [sha256('br')];
    if (click?.fbc) user.fbc = click.fbc;
    if (click?.fbp) user.fbp = click.fbp;
    if (click?.ip) user.client_ip_address = click.ip;
    if (click?.user_agent) user.client_user_agent = click.user_agent;

    const website = Boolean(click?.user_agent && click?.page_url);
    data = {
      event_name: META_STANDARD_NAMES[event.kind],
      event_time: event.event_time,
      event_id: event.event_id,
      action_source: website ? 'website' : 'chat',
      ...(website ? { event_source_url: click!.page_url } : {}),
      user_data: user,
      custom_data: custom,
    };
  }
  const body: Record<string, unknown> = { data: [data] };
  if (client.meta_test_event_code) body.test_event_code = client.meta_test_event_code;
  return body;
}

async function sendMeta(ctx: EventContext): Promise<SendResult> {
  const token = decrypt(ctx.client.meta_access_token);
  if (!ctx.client.meta_pixel_id || !token) return { status: 'skipped', detail: 'Meta não configurada' };
  if (ctx.event.event_time < Math.floor(Date.now() / 1000) - 7 * 86400) {
    return { status: 'error', permanent: true, detail: 'Evento com mais de 7 dias: a Meta não aceita' };
  }
  const body = buildMetaPayload(ctx);
  if (config.dryRun) return { status: 'sent', detail: 'DRY_RUN', request: body };
  const url = `https://graph.facebook.com/${config.meta.graphVersion}/${ctx.client.meta_pixel_id}/events`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => null);
  if (res.ok) return { status: 'sent', request: body, response: json };
  return {
    status: 'error',
    permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
    detail: `Meta HTTP ${res.status}`,
    request: body,
    response: json,
  };
}

// ---------------------------------------------------------------------------
// GA4 Measurement Protocol
// ---------------------------------------------------------------------------

const GA4_NAMES: Record<EventKind, string> = { lead: 'generate_lead', qualified: 'qualify_lead', purchase: 'purchase' };

/** client_id do GA4: usa o cookie _ga capturado no clique, ou um id estável por contato. */
export function ga4ClientId(ctx: EventContext): string {
  if (ctx.click?.ga_client_id) return ctx.click.ga_client_id;
  const h = sha256(`${ctx.client.id}:${ctx.contact.phone}`);
  return `${parseInt(h.slice(0, 8), 16)}.${ctx.contact.first_message_at}`;
}

export function buildGa4Payload(ctx: EventContext): Record<string, unknown> {
  const { event, contact, click, sale } = ctx;
  const params: Record<string, unknown> = { lead_source: contact.source, engagement_time_msec: 1 };
  if (click?.ga_session_id) params.session_id = click.ga_session_id;
  if (sale) {
    params.currency = sale.currency;
    params.value = sale.value;
    params.transaction_id = `sale-${sale.id}`;
  }
  if (click?.utm_campaign) params.campaign = click.utm_campaign;
  return {
    client_id: ga4ClientId(ctx),
    timestamp_micros: event.event_time * 1_000_000,
    events: [{ name: GA4_NAMES[event.kind], params }],
  };
}

async function sendGa4(ctx: EventContext): Promise<SendResult> {
  const secret = decrypt(ctx.client.ga4_api_secret);
  if (!ctx.client.ga4_measurement_id || !secret) return { status: 'skipped', detail: 'GA4 não configurado' };
  if (ctx.event.event_time < Math.floor(Date.now() / 1000) - 72 * 3600) {
    return { status: 'error', permanent: true, detail: 'GA4 aceita eventos de até 72h atrás' };
  }
  const body = buildGa4Payload(ctx);
  if (config.dryRun) return { status: 'sent', detail: 'DRY_RUN', request: body };
  const qs = new URLSearchParams({ measurement_id: ctx.client.ga4_measurement_id, api_secret: secret });
  const res = await fetch(`https://www.google-analytics.com/mp/collect?${qs}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  // O endpoint de produção responde 2xx mesmo para payloads inválidos; valide com /debug/mp/collect.
  if (res.ok) return { status: 'sent', request: body, response: { http: res.status } };
  return { status: 'error', detail: `GA4 HTTP ${res.status}`, request: body };
}

// ---------------------------------------------------------------------------
// Google Ads — upload de conversões de clique (ConversionUploadService)
// ---------------------------------------------------------------------------

/** "yyyy-mm-dd hh:mm:ss+00:00" em UTC, formato exigido pela API e pelo CSV. */
export function gadsDateTime(epochS: number): string {
  return `${new Date(epochS * 1000).toISOString().slice(0, 19).replace('T', ' ')}+00:00`;
}

let cachedToken: { value: string; exp: number } | null = null;
async function googleAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const g = config.googleAds;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: g.refreshToken,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`OAuth Google falhou: ${json.error || res.status}`);
  cachedToken = { value: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

export function googleAdsApiEnabled(): boolean {
  const g = config.googleAds;
  return Boolean(g.developerToken && g.clientId && g.clientSecret && g.refreshToken);
}

export function buildGadsPayload(ctx: EventContext): Record<string, unknown> | null {
  const { client, click, sale, event } = ctx;
  const actionId = event.kind === 'purchase' ? client.gads_purchase_action_id : event.kind === 'lead' ? client.gads_lead_action_id : null;
  const customer = (client.gads_customer_id || '').replace(/-/g, '');
  if (!actionId || !customer) return null;
  const conv: Record<string, unknown> = {
    conversionAction: `customers/${customer}/conversionActions/${actionId}`,
    conversionDateTime: gadsDateTime(event.event_time),
    orderId: event.event_id,
  };
  if (click?.gclid) conv.gclid = click.gclid;
  else if (click?.gbraid) conv.gbraid = click.gbraid;
  else if (click?.wbraid) conv.wbraid = click.wbraid;
  if (sale) {
    conv.conversionValue = sale.value;
    conv.currencyCode = sale.currency;
  }
  return { conversions: [conv], partialFailure: true };
}

async function sendGads(ctx: EventContext): Promise<SendResult> {
  const { click } = ctx;
  if (ctx.event.kind === 'qualified') return { status: 'skipped', detail: 'Sem ação de conversão para lead qualificado' };
  if (!click?.gclid && !click?.gbraid && !click?.wbraid) {
    return { status: 'skipped', detail: 'Lead sem gclid/gbraid/wbraid (não veio de clique no Google Ads)' };
  }
  const body = buildGadsPayload(ctx);
  if (!body || !googleAdsApiEnabled()) {
    return { status: 'skipped', detail: 'Disponível no feed CSV de importação agendada do Google Ads' };
  }
  if (config.dryRun) return { status: 'sent', detail: 'DRY_RUN', request: body };
  const g = config.googleAds;
  const customer = (ctx.client.gads_customer_id || '').replace(/-/g, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await googleAccessToken()}`,
    'developer-token': g.developerToken,
  };
  if (g.loginCustomerId) headers['login-customer-id'] = g.loginCustomerId;
  const res = await fetch(
    `https://googleads.googleapis.com/${g.apiVersion}/customers/${customer}:uploadClickConversions`,
    { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) },
  );
  const json = (await res.json().catch(() => null)) as { partialFailureError?: { message?: string } } | null;
  if (res.ok && !json?.partialFailureError) return { status: 'sent', request: body, response: json };
  return {
    status: 'error',
    permanent: res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429),
    detail: json?.partialFailureError?.message || `Google Ads HTTP ${res.status}`,
    request: body,
    response: json,
  };
}

export async function sendEvent(ctx: EventContext): Promise<SendResult> {
  switch (ctx.event.platform) {
    case 'meta':
      return sendMeta(ctx);
    case 'ga4':
      return sendGa4(ctx);
    case 'gads':
      return sendGads(ctx);
  }
}

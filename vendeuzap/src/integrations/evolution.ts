/**
 * Normalização dos webhooks da Evolution API (v2) e chamadas à API de administração.
 *
 * Formato do envelope (conferido no código-fonte da Evolution API, webhook.controller.ts):
 *   { event, instance, data, destination, date_time, sender, server_url, apikey }
 *
 * messages.upsert -> data = { key: {remoteJid, remoteJidAlt?, fromMe, id}, pushName,
 *                             message: {...}, contextInfo, messageType, messageTimestamp }
 * labels.association -> data = { instance, type: 'add'|'remove', chatId, labelId }
 * labels.edit -> data = { id, name, color, deleted?, predefinedId, instance }
 */
import { config } from '../config.js';
import { normalizePhone } from '../lib/util.js';

export interface AdReferral {
  ctwaClid: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  sourceApp: string | null;
  title: string | null;
}

export type EvolutionEvent =
  | {
      type: 'message';
      instance: string;
      fromMe: boolean;
      phone: string;
      jid: string;
      lid: string | null;
      pushName: string | null;
      messageId: string | null;
      timestamp: number;
      text: string;
      ad: AdReferral | null;
    }
  | { type: 'label_association'; instance: string; chatId: string; labelId: string; action: 'add' | 'remove' }
  | { type: 'label_edit'; instance: string; labelId: string; name: string; deleted: boolean }
  | { type: 'ignored'; reason: string };

const normEvent = (e: unknown): string => String(e || '').toLowerCase().replace(/_/g, '.');

/* eslint-disable @typescript-eslint/no-explicit-any */
function messageText(message: any): string {
  if (!message || typeof message !== 'object') return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    message.ephemeralMessage?.message?.conversation ||
    message.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ''
  );
}

function findContextInfo(data: any): any {
  if (data?.contextInfo) return data.contextInfo;
  const msg = data?.message;
  if (msg && typeof msg === 'object') {
    for (const v of Object.values(msg) as any[]) {
      if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
    }
  }
  return null;
}

export function extractAdReferral(data: any): AdReferral | null {
  const ctx = findContextInfo(data);
  const ext = ctx?.externalAdReply;
  // Formato da Cloud API oficial (caso a mensagem venha repassada de lá)
  const ref = data?.referral || data?.message?.referral;
  if (ext && (ext.ctwaClid || ext.sourceType === 'ad' || ext.sourceId)) {
    return {
      ctwaClid: ext.ctwaClid || null,
      sourceId: ext.sourceId || null,
      sourceUrl: ext.sourceUrl || null,
      sourceType: ext.sourceType || null,
      sourceApp: ext.sourceApp || ctx?.entryPointConversionApp || null,
      title: ext.title || null,
    };
  }
  if (ref && (ref.ctwa_clid || ref.source_id)) {
    return {
      ctwaClid: ref.ctwa_clid || null,
      sourceId: ref.source_id || null,
      sourceUrl: ref.source_url || null,
      sourceType: ref.source_type || null,
      sourceApp: null,
      title: ref.headline || null,
    };
  }
  // Algumas versões só marcam a origem, sem externalAdReply
  if (ctx && /ad/i.test(String(ctx.entryPointConversionSource || ctx.conversionSource || ''))) {
    return {
      ctwaClid: null,
      sourceId: null,
      sourceUrl: null,
      sourceType: String(ctx.entryPointConversionSource || ctx.conversionSource),
      sourceApp: ctx.entryPointConversionApp || null,
      title: null,
    };
  }
  return null;
}

function parseMessage(instance: string, data: any): EvolutionEvent {
  const key = data?.key;
  if (!key?.remoteJid) return { type: 'ignored', reason: 'mensagem sem remoteJid' };
  const remote: string = key.remoteJid;
  if (remote.endsWith('@g.us') || remote === 'status@broadcast' || remote.endsWith('@newsletter') || remote.endsWith('@broadcast')) {
    return { type: 'ignored', reason: 'grupo/status/canal' };
  }
  // Endereçamento LID: o número real vem em remoteJidAlt (ou senderPn em versões antigas)
  let jid = remote;
  let lid: string | null = null;
  if (remote.endsWith('@lid')) {
    lid = remote;
    const alt = key.remoteJidAlt || key.senderPn || data?.senderPn;
    if (!alt) return { type: 'ignored', reason: 'LID sem número alternativo' };
    jid = alt;
  } else if (key.remoteJidAlt?.endsWith?.('@lid')) {
    lid = key.remoteJidAlt;
  }
  const phone = normalizePhone(jid);
  if (!phone) return { type: 'ignored', reason: 'número inválido' };
  return {
    type: 'message',
    instance,
    fromMe: Boolean(key.fromMe),
    phone,
    jid,
    lid,
    pushName: key.fromMe ? null : data.pushName || null,
    messageId: key.id || null,
    timestamp: Number(data.messageTimestamp) || Math.floor(Date.now() / 1000),
    text: messageText(data.message),
    ad: key.fromMe ? null : extractAdReferral(data),
  };
}

export function parseEvolutionWebhook(body: any): EvolutionEvent[] {
  const event = normEvent(body?.event);
  const instance = String(body?.instance || body?.data?.instance || '');
  const data = body?.data;
  if (!event || !data) return [{ type: 'ignored', reason: 'payload sem event/data' }];

  if (event === 'messages.upsert' || event === 'send.message') {
    const list = Array.isArray(data) ? data : Array.isArray(data.messages) ? data.messages : [data];
    return list.map((m: any) => parseMessage(instance, m));
  }
  if (event === 'labels.association') {
    if (!data.chatId || data.labelId === undefined) return [{ type: 'ignored', reason: 'associação incompleta' }];
    return [
      {
        type: 'label_association',
        instance,
        chatId: String(data.chatId),
        labelId: String(data.labelId),
        action: data.type === 'remove' ? 'remove' : 'add',
      },
    ];
  }
  if (event === 'labels.edit') {
    return [
      { type: 'label_edit', instance, labelId: String(data.id), name: String(data.name || ''), deleted: Boolean(data.deleted) },
    ];
  }
  return [{ type: 'ignored', reason: `evento ${event} não utilizado` }];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Chamadas à Evolution API (configurar webhook, buscar etiquetas)
// ---------------------------------------------------------------------------

export const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'LABELS_EDIT', 'LABELS_ASSOCIATION'];

export class EvolutionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export const evolutionConfigured = (): boolean => Boolean(config.evolution.url && config.evolution.apiKey);

async function evo(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!evolutionConfigured()) {
    throw new EvolutionError(0, 'EVOLUTION_URL e EVOLUTION_API_KEY não configurados');
  }
  const res = await fetch(`${config.evolution.url}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new EvolutionError(res.status, `Evolution ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Instâncias (criar, conectar por QR Code / código, status, desconectar)
// Rotas conferidas no código-fonte da Evolution API v2 (instance.router.ts).
// ---------------------------------------------------------------------------

export type InstanceState = 'open' | 'connecting' | 'close' | 'missing';

export interface QrInfo {
  state: InstanceState;
  base64: string | null;
  pairingCode: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getInstanceState(instance: string): Promise<InstanceState> {
  try {
    const res = (await evo(`/instance/connectionState/${encodeURIComponent(instance)}`)) as any;
    const state = res?.instance?.state ?? res?.state;
    return state === 'open' || state === 'connecting' || state === 'close' ? state : 'missing';
  } catch (err) {
    if (err instanceof EvolutionError && err.status === 404) return 'missing';
    throw err;
  }
}

/** Cria a instância (WhatsApp via Baileys) e já pede o QR Code. */
export async function createInstance(instance: string): Promise<QrInfo> {
  const res = (await evo('/instance/create', {
    method: 'POST',
    body: JSON.stringify({ instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true }),
  })) as any;
  return { state: 'connecting', base64: res?.qrcode?.base64 ?? null, pairingCode: res?.qrcode?.pairingCode ?? null };
}

/**
 * Pede um QR Code novo. Com o número (somente dígitos, com DDI), a Evolution também
 * devolve um código de pareamento para digitar no celular, sem precisar ler o QR.
 */
export async function connectInstance(instance: string, number?: string | null): Promise<QrInfo> {
  const qs = number ? `?number=${encodeURIComponent(number)}` : '';
  const res = (await evo(`/instance/connect/${encodeURIComponent(instance)}${qs}`)) as any;
  const state = res?.instance?.state ?? res?.instance?.status;
  if (state === 'open') return { state: 'open', base64: null, pairingCode: null };
  return { state: 'connecting', base64: res?.base64 ?? res?.qrcode?.base64 ?? null, pairingCode: res?.pairingCode ?? null };
}

export async function logoutInstance(instance: string): Promise<void> {
  await evo(`/instance/logout/${encodeURIComponent(instance)}`, { method: 'DELETE' });
}

/** Webhook atual da instância (para avisar antes de substituir o de outra ferramenta). */
export async function findInstanceWebhook(instance: string): Promise<{ url: string | null; enabled: boolean } | null> {
  try {
    const res = (await evo(`/webhook/find/${encodeURIComponent(instance)}`)) as any;
    if (!res || typeof res !== 'object') return null;
    return { url: res.url || null, enabled: Boolean(res.enabled) };
  } catch (err) {
    if (err instanceof EvolutionError && err.status === 404) return null;
    throw err;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function setInstanceWebhook(instance: string, url: string): Promise<unknown> {
  return evo(`/webhook/set/${encodeURIComponent(instance)}`, {
    method: 'POST',
    body: JSON.stringify({
      webhook: { enabled: true, url, byEvents: false, base64: false, events: WEBHOOK_EVENTS },
    }),
  });
}

export async function fetchLabels(instance: string): Promise<{ id: string; name: string }[]> {
  const res = await evo(`/label/findLabels/${encodeURIComponent(instance)}`);
  if (!Array.isArray(res)) return [];
  return res.map((l: { labelId?: string; id?: string; name?: string }) => ({
    id: String(l.labelId ?? l.id ?? ''),
    name: String(l.name ?? ''),
  }));
}

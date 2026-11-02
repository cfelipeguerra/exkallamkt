import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Criptografia de segredos (tokens dos clientes) — AES-256-GCM
// ---------------------------------------------------------------------------

function key(): Buffer {
  const raw = config.encryptionKey;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY deve ter 32 bytes (64 caracteres hex ou base64)');
  return buf;
}

export function encrypt(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith('v1:')) return stored;
  const [, iv, tag, data] = stored.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
export const token = (bytes = 24): string => randomBytes(bytes).toString('base64url');

// ---------------------------------------------------------------------------
// Código de rastreio que viaja dentro da primeira mensagem do WhatsApp
// ---------------------------------------------------------------------------

/** 32 símbolos sem caracteres ambíguos (sem I, O, 0, 1). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REF_LENGTH = 6;
const ZW0 = '​'; // zero width space      -> bit 0
const ZW1 = '‌'; // zero width non-joiner -> bit 1
const ZWB = '⁠'; // word joiner            -> delimitador

export function newRefCode(): string {
  let s = '';
  for (let i = 0; i < REF_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export function isRefCode(v: unknown): v is string {
  return typeof v === 'string' && new RegExp(`^[${ALPHABET}]{${REF_LENGTH}}$`).test(v);
}

/** Texto visível anexado à mensagem: "(cód. XK-ABC234)". */
export function visibleRef(code: string): string {
  return `(cód. XK-${code})`;
}

/** Codifica o código em caracteres invisíveis (zero-width). */
export function invisibleRef(code: string): string {
  let bits = '';
  for (const ch of code) bits += ALPHABET.indexOf(ch).toString(2).padStart(5, '0');
  return ZWB + bits.replace(/0/g, ZW0).replace(/1/g, ZW1) + ZWB;
}

export function appendRef(message: string, code: string, invisible: boolean): string {
  return invisible ? `${message}${invisibleRef(code)}` : `${message} ${visibleRef(code)}`;
}

/** Procura o código (visível ou invisível) dentro de um texto recebido. */
export function extractRef(text: string | null | undefined): string | null {
  if (!text) return null;
  const visible = text.match(new RegExp(`XK-([${ALPHABET}]{${REF_LENGTH}})`, 'i'));
  if (visible) return visible[1].toUpperCase();
  const zw = text.match(new RegExp(`${ZWB}([${ZW0}${ZW1}]{${REF_LENGTH * 5}})${ZWB}`));
  if (zw) {
    const bits = zw[1].replace(new RegExp(ZW0, 'g'), '0').replace(new RegExp(ZW1, 'g'), '1');
    let code = '';
    for (let i = 0; i < bits.length; i += 5) code += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
    return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Telefones
// ---------------------------------------------------------------------------

/** Extrai o número (somente dígitos) de um JID do WhatsApp ou de um telefone digitado. */
export function normalizePhone(input: string | null | undefined, defaultCc = config.defaultCountryCode): string | null {
  if (!input) return null;
  const base = input.split('@')[0].split(':')[0];
  let digits = base.replace(/\D/g, '');
  if (!digits) return null;
  if (defaultCc === '55' && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`;
  return digits;
}

/**
 * Variações do número para envio com hash à Meta. Números de celular brasileiros
 * às vezes chegam do WhatsApp sem o 9º dígito (ex.: 55 11 8xxx-xxxx). Enviamos as
 * duas formas para aumentar a chance de correspondência.
 */
export function phoneVariants(phone: string): string[] {
  const out = new Set<string>([phone]);
  if (phone.startsWith('55')) {
    const ddd = phone.slice(2, 4);
    const rest = phone.slice(4);
    if (rest.length === 8 && /^[6-9]/.test(rest)) out.add(`55${ddd}9${rest}`);
    if (rest.length === 9 && rest.startsWith('9')) out.add(`55${ddd}${rest.slice(1)}`);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Valores monetários em mensagens ("R$ 1.234,56", "total: 150")
// ---------------------------------------------------------------------------

export function parseMoney(raw: string): number | null {
  let s = raw.trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/\.\d{1,2}$/.test(s) && (s.match(/\./g) || []).length === 1) {
    // "1500.50" -> decimal com ponto
  } else {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Retorna o valor mais provável de uma venda citado na mensagem, priorizando "total". */
export function extractValue(text: string | null | undefined): number | null {
  if (!text) return null;
  const num = '(\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?(?!\\d)|\\d+(?:[.,]\\d{1,2})?(?!\\d))';
  const total = [...text.matchAll(new RegExp(`total[^\\d\\n]{0,15}?(?:R\\$\\s*)?${num}`, 'gi'))];
  if (total.length) return parseMoney(total[total.length - 1][1]);
  const brl = [...text.matchAll(new RegExp(`R\\$\\s*${num}`, 'gi'))];
  if (brl.length) return parseMoney(brl[brl.length - 1][1]);
  return null;
}

export function splitList(v: string | null | undefined): string[] {
  return (v || '')
    .split(/[|,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeText(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Verifica se algum termo (sem acento, sem maiúsculas) aparece no texto. */
export function matchesAny(text: string, terms: string[]): string | null {
  const t = normalizeText(text);
  for (const term of terms) if (t.includes(normalizeText(term))) return term;
  return null;
}

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugify(v: string): string {
  return normalizeText(v)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

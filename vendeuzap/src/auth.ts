/**
 * Acesso ao painel:
 * - agência: usuário e senha do ADMIN_USER/ADMIN_PASSWORD (Basic Auth), vê todos os clientes;
 * - cliente: link de acesso por e-mail (sem senha) e cookie de sessão assinado; vê só os números da própria conta.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { DB } from './db.js';
import { now } from './db.js';
import type { Account, User } from './types.js';

export type Viewer =
  | { role: 'admin' }
  | { role: 'customer'; user: User; account: Account | null; clientIds: Set<number> };

/** Quem está vendo a página atual (usado pelo layout para montar o menu). */
export const viewerStore = new AsyncLocalStorage<Viewer>();
export const currentViewer = (): Viewer | undefined => viewerStore.getStore();

const COOKIE = 'vz_sessao';
const SESSION_DAYS = 30;

const sessionKey = () => createHmac('sha256', config.encryptionKey).update('vendeuzap-sessao').digest();
const sign = (v: string) => createHmac('sha256', sessionKey()).update(v).digest('base64url');
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function checkAdminAuth(req: FastifyRequest): boolean {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return safeEq(user, config.admin.user) && safeEq(rest.join(':'), config.admin.password);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setSession(reply: FastifyReply, userId: number): void {
  const exp = now() + SESSION_DAYS * 86400;
  const value = `${userId}.${exp}`;
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  reply.header('Set-Cookie', `${COOKIE}=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

export function clearSession(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function customerViewer(db: DB, req: FastifyRequest): Viewer | null {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const [uid, exp, sig] = raw.split('.');
  if (!uid || !exp || !sig || !safeEq(sig, sign(`${uid}.${exp}`)) || Number(exp) < now()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(uid)) as User | undefined;
  if (!user) return null;
  const account = user.account_id
    ? ((db.prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id) as Account | undefined) ?? null)
    : null;
  const ids = account
    ? (db.prepare('SELECT id FROM clients WHERE account_id = ?').all(account.id) as { id: number }[]).map((r) => r.id)
    : [];
  return { role: 'customer', user, account, clientIds: new Set(ids) };
}

/** O visitante pode ver este cliente? A agência vê todos; o cliente só os da própria conta. */
export function canSee(viewer: Viewer | undefined, clientId: number): boolean {
  if (!viewer) return false;
  return viewer.role === 'admin' || viewer.clientIds.has(clientId);
}

// ---------------------------------------------------------------------------
// Links de acesso (uso único, guardados só como hash)
// ---------------------------------------------------------------------------

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function createLoginToken(db: DB, userId: number, validSeconds: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, now() + validSeconds);
  db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now() - 86400);
  return token;
}

export const loginUrl = (token: string) => `${config.baseUrl}/entrar/${token}`;

/** Consome o link: devolve o usuário se o link existe, não expirou e ainda não foi usado. */
export function consumeLoginToken(db: DB, token: string): User | null {
  const row = db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(hashToken(token)) as
    | { user_id: number; expires_at: number; used_at: number | null }
    | undefined;
  if (!row || row.used_at || row.expires_at < now()) return null;
  db.prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?').run(now(), hashToken(token));
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.user_id);
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as User | undefined) ?? null;
}

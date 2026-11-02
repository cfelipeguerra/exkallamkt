/**
 * Motor de atribuição: liga cliques/anúncios às conversas, detecta vendas e
 * enfileira os eventos de conversão para cada plataforma configurada.
 */
import type { DB } from './db.js';
import { now } from './db.js';
import type { EvolutionEvent } from './integrations/evolution.js';
import { extractRef, extractValue, matchesAny, normalizePhone, splitList } from './lib/util.js';
import type { Click, Client, Contact, EventKind, Platform, Sale } from './types.js';

/** Evita duplicar vendas automáticas (palavra-chave/etiqueta) do mesmo contato. */
const AUTO_SALE_DEDUP_S = 60 * 60 * 12;

const seenMessages = new Map<string, number>();
function alreadySeen(id: string | null): boolean {
  if (!id) return false;
  if (seenMessages.has(id)) return true;
  seenMessages.set(id, Date.now());
  if (seenMessages.size > 5000) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, t] of seenMessages) if (t < cutoff) seenMessages.delete(k);
  }
  return false;
}

export function platformsFor(client: Client): Platform[] {
  const out: Platform[] = [];
  if (client.meta_pixel_id && client.meta_access_token) out.push('meta');
  if (client.ga4_measurement_id && client.ga4_api_secret) out.push('ga4');
  if (client.gads_customer_id || client.gads_purchase_action_name || client.gads_lead_action_name) out.push('gads');
  return out;
}

export function enqueueEvents(
  db: DB,
  client: Client,
  kind: EventKind,
  contactId: number,
  saleId: number | null,
  eventTime = now(),
): number {
  const base = saleId ? `sale-${saleId}` : `${kind}-${contactId}`;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO events (client_id, contact_id, sale_id, kind, platform, event_id, event_time)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const p of platformsFor(client)) {
    n += stmt.run(client.id, contactId, saleId, kind, p, `${client.id}-${base}`, eventTime).changes;
  }
  return n;
}

function findContact(db: DB, clientId: number, phone: string, lid: string | null): Contact | undefined {
  const byPhone = db.prepare('SELECT * FROM contacts WHERE client_id = ? AND phone = ?').get(clientId, phone) as Contact | undefined;
  if (byPhone || !lid) return byPhone;
  return db.prepare('SELECT * FROM contacts WHERE client_id = ? AND lid = ?').get(clientId, lid) as Contact | undefined;
}

/**
 * Localiza o clique pelo código embutido na primeira mensagem. Não associamos
 * cliques "sem código" por proximidade de horário, pois isso gera atribuições
 * falsas quando há vários leads simultâneos.
 */
function findClickForFirstMessage(db: DB, clientId: number, text: string): Click | undefined {
  const ref = extractRef(text);
  if (!ref) return undefined;
  return db
    .prepare('SELECT * FROM clicks WHERE client_id = ? AND ref_code = ? AND matched_contact_id IS NULL')
    .get(clientId, ref) as Click | undefined;
}

export interface ProcessResult {
  action: string;
  contactId?: number;
  saleId?: number;
}

export function handleEvolutionEvent(db: DB, client: Client, ev: EvolutionEvent): ProcessResult {
  switch (ev.type) {
    case 'ignored':
      return { action: `ignorado: ${ev.reason}` };
    case 'label_edit':
      if (ev.deleted) db.prepare('DELETE FROM labels WHERE client_id = ? AND label_id = ?').run(client.id, ev.labelId);
      else
        db.prepare(
          `INSERT INTO labels (client_id, label_id, name) VALUES (?, ?, ?)
           ON CONFLICT(client_id, label_id) DO UPDATE SET name = excluded.name`,
        ).run(client.id, ev.labelId, ev.name);
      return { action: 'etiqueta atualizada' };
    case 'label_association':
      return handleLabel(db, client, ev.chatId, ev.labelId, ev.action);
    case 'message':
      return handleMessage(db, client, ev);
  }
}

function handleMessage(db: DB, client: Client, ev: Extract<EvolutionEvent, { type: 'message' }>): ProcessResult {
  if (alreadySeen(ev.messageId ? `${client.id}:${ev.messageId}` : null)) return { action: 'duplicada' };
  // Mensagens para o próprio número da empresa (ex.: notas pessoais) são ignoradas
  if (ev.phone === normalizePhone(client.whatsapp_number)) return { action: 'ignorado: próprio número' };

  return db.transaction((): ProcessResult => {
    let contact = findContact(db, client.id, ev.phone, ev.lid);

    if (!contact) {
      // Conversa iniciada pela empresa (prospecção ativa) não conta como lead de mídia
      if (ev.fromMe) {
        const info = db
          .prepare(
            `INSERT INTO contacts (client_id, phone, jid, lid, source, status, messages_out, first_message_at, last_message_at)
             VALUES (?, ?, ?, ?, 'organic', 'lead', 1, ?, ?)`,
          )
          .run(client.id, ev.phone, ev.jid, ev.lid, ev.timestamp, ev.timestamp);
        return { action: 'contato criado (saída)', contactId: Number(info.lastInsertRowid) };
      }

      let source: Contact['source'] = 'organic';
      let clickId: number | null = null;
      if (ev.ad) source = 'ctwa';
      const click = findClickForFirstMessage(db, client.id, ev.text);
      if (click) {
        clickId = click.id;
        if (!ev.ad) source = click.origin === 'tag' ? 'tag' : 'link';
      }
      const info = db
        .prepare(
          `INSERT INTO contacts (client_id, phone, jid, lid, push_name, source, click_id, ctwa_clid,
             ad_source_id, ad_source_url, ad_title, ad_source_app, messages_in, first_message_at, last_message_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          client.id, ev.phone, ev.jid, ev.lid, ev.pushName, source, clickId, ev.ad?.ctwaClid ?? null,
          ev.ad?.sourceId ?? null, ev.ad?.sourceUrl ?? null, ev.ad?.title ?? null, ev.ad?.sourceApp ?? null,
          ev.timestamp, ev.timestamp,
        );
      const contactId = Number(info.lastInsertRowid);
      if (click) db.prepare('UPDATE clicks SET matched_contact_id = ? WHERE id = ?').run(contactId, click.id);
      if (client.send_lead_event) enqueueEvents(db, client, 'lead', contactId, null);
      return { action: `lead criado (${source})`, contactId };
    }

    // Contato existente
    const updates: string[] = ['last_message_at = ?'];
    const params: unknown[] = [Math.max(ev.timestamp, contact.last_message_at)];
    updates.push(ev.fromMe ? 'messages_out = messages_out + 1' : 'messages_in = messages_in + 1');
    if (!contact.lid && ev.lid) updates.push('lid = ?'), params.push(ev.lid);
    if (!ev.fromMe && ev.pushName && !contact.push_name) updates.push('push_name = ?'), params.push(ev.pushName);

    // Primeiro contato foi da empresa e o cliente respondeu vindo de um anúncio: atualiza origem
    if (!ev.fromMe && ev.ad && contact.source === 'organic') {
      updates.push("source = 'ctwa'", 'ctwa_clid = ?', 'ad_source_id = ?', 'ad_source_url = ?', 'ad_title = ?');
      params.push(ev.ad.ctwaClid, ev.ad.sourceId, ev.ad.sourceUrl, ev.ad.title);
    }

    let quoted: number | null = null;
    if (ev.fromMe) {
      quoted = extractValue(ev.text);
      if (quoted) updates.push('last_quoted_value = ?'), params.push(quoted);
    }
    db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...params, contact.id);

    // Detecção de venda por palavra-chave (somente mensagens enviadas pela empresa)
    if (ev.fromMe && ev.text) {
      const hit = matchesAny(ev.text, splitList(client.sale_keywords));
      if (hit) {
        contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) as Contact;
        const sale = registerSale(db, client, contact, {
          value: quoted ?? contact.last_quoted_value ?? client.default_sale_value,
          detectedBy: 'keyword',
          note: `Palavra-chave: "${hit}"`,
        });
        if (sale) return { action: 'venda por palavra-chave', contactId: contact.id, saleId: sale.id };
      }
    }
    return { action: 'mensagem registrada', contactId: contact.id };
  })();
}

function handleLabel(db: DB, client: Client, chatId: string, labelId: string, action: 'add' | 'remove'): ProcessResult {
  if (action !== 'add') return { action: 'etiqueta removida (sem ação)' };
  const label = db.prepare('SELECT name FROM labels WHERE client_id = ? AND label_id = ?').get(client.id, labelId) as
    | { name: string }
    | undefined;
  if (!label) return { action: `etiqueta ${labelId} desconhecida (sincronize as etiquetas)` };

  const isLid = chatId.endsWith('@lid');
  const phone = isLid ? null : normalizePhone(chatId);
  const contact = (
    isLid
      ? db.prepare('SELECT * FROM contacts WHERE client_id = ? AND lid = ?').get(client.id, chatId)
      : db.prepare('SELECT * FROM contacts WHERE client_id = ? AND phone = ?').get(client.id, phone)
  ) as Contact | undefined;
  if (!contact) return { action: 'etiqueta em contato não rastreado' };

  if (normEq(label.name, client.sale_labels)) {
    const sale = registerSale(db, client, contact, {
      value: contact.last_quoted_value ?? client.default_sale_value,
      detectedBy: 'label',
      note: `Etiqueta: "${label.name}"`,
    });
    return sale ? { action: 'venda por etiqueta', contactId: contact.id, saleId: sale.id } : { action: 'venda duplicada ignorada' };
  }
  if (normEq(label.name, client.qualified_labels)) {
    if (contact.status === 'lead') {
      db.prepare("UPDATE contacts SET status = 'qualified' WHERE id = ?").run(contact.id);
      enqueueEvents(db, client, 'qualified', contact.id, null);
    }
    return { action: 'lead qualificado', contactId: contact.id };
  }
  return { action: `etiqueta "${label.name}" sem regra` };
}

/** Compara o nome da etiqueta com a lista configurada (igualdade, sem acento/maiúsculas). */
function normEq(name: string, list: string): boolean {
  const n = name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  return splitList(list).some((t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase() === n);
}

export interface SaleInput {
  value: number;
  detectedBy: Sale['detected_by'];
  externalRef?: string | null;
  note?: string | null;
  currency?: string;
  createdAt?: number;
}

/** Registra a venda, marca o contato como cliente e enfileira os eventos de compra. */
export function registerSale(db: DB, client: Client, contact: Contact, input: SaleInput): Sale | null {
  const run = (): Sale | null => {
    if (input.detectedBy === 'keyword' || input.detectedBy === 'label') {
      const recent = db
        .prepare(
          `SELECT id FROM sales WHERE contact_id = ? AND detected_by IN ('keyword','label') AND created_at > ?`,
        )
        .get(contact.id, now() - AUTO_SALE_DEDUP_S);
      if (recent) return null;
    }
    if (input.externalRef) {
      const dup = db.prepare('SELECT * FROM sales WHERE client_id = ? AND external_ref = ?').get(client.id, input.externalRef);
      if (dup) return dup as Sale;
    }
    const createdAt = input.createdAt ?? now();
    const info = db
      .prepare(
        `INSERT INTO sales (client_id, contact_id, value, currency, detected_by, external_ref, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client.id, contact.id, Math.max(0, input.value || 0), input.currency || client.currency,
        input.detectedBy, input.externalRef ?? null, input.note ?? null, createdAt,
      );
    const saleId = Number(info.lastInsertRowid);
    db.prepare("UPDATE contacts SET status = 'customer' WHERE id = ?").run(contact.id);
    enqueueEvents(db, client, 'purchase', contact.id, saleId, createdAt);
    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as Sale;
  };
  return db.inTransaction ? run() : db.transaction(run)();
}

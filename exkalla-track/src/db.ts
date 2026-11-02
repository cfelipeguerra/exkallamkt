import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    whatsapp_number TEXT NOT NULL,
    evolution_instance TEXT NOT NULL UNIQUE,
    webhook_token TEXT NOT NULL UNIQUE,
    report_token TEXT NOT NULL UNIQUE,
    api_token TEXT NOT NULL UNIQUE,
    currency TEXT NOT NULL DEFAULT 'BRL',
    default_sale_value REAL NOT NULL DEFAULT 0,
    -- Regras de detecção
    sale_keywords TEXT NOT NULL DEFAULT 'pagamento confirmado|pedido confirmado|compra confirmada|venda confirmada',
    sale_labels TEXT NOT NULL DEFAULT 'Venda|Comprou|Pago',
    qualified_labels TEXT NOT NULL DEFAULT 'Qualificado|Lead quente',
    send_lead_event INTEGER NOT NULL DEFAULT 1,
    invisible_ref INTEGER NOT NULL DEFAULT 0,
    -- Meta
    meta_pixel_id TEXT,
    meta_access_token TEXT,
    meta_test_event_code TEXT,
    meta_waba_id TEXT,
    -- GA4
    ga4_measurement_id TEXT,
    ga4_api_secret TEXT,
    -- Google Ads
    gads_customer_id TEXT,
    gads_purchase_action_id TEXT,
    gads_lead_action_id TEXT,
    gads_purchase_action_name TEXT,
    gads_lead_action_name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE tracking_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT 'Olá! Gostaria de mais informações.',
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    link_id INTEGER REFERENCES tracking_links(id) ON DELETE SET NULL,
    ref_code TEXT NOT NULL,
    origin TEXT NOT NULL,            -- 'link' (redirecionador) | 'tag' (script no site)
    fbclid TEXT, fbc TEXT, fbp TEXT,
    gclid TEXT, gbraid TEXT, wbraid TEXT, ga_client_id TEXT, ga_session_id TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
    page_url TEXT, referrer TEXT, ip TEXT, user_agent TEXT,
    matched_contact_id INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX clicks_client_ref ON clicks(client_id, ref_code);

  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,             -- somente dígitos, com DDI
    jid TEXT, lid TEXT,
    push_name TEXT,
    source TEXT NOT NULL DEFAULT 'organic',  -- 'ctwa' | 'link' | 'tag' | 'organic'
    click_id INTEGER REFERENCES clicks(id) ON DELETE SET NULL,
    ctwa_clid TEXT,
    ad_source_id TEXT, ad_source_url TEXT, ad_title TEXT, ad_source_app TEXT,
    status TEXT NOT NULL DEFAULT 'lead',      -- 'lead' | 'qualified' | 'customer'
    last_quoted_value REAL,
    messages_in INTEGER NOT NULL DEFAULT 0,
    messages_out INTEGER NOT NULL DEFAULT 0,
    first_message_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_message_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX contacts_client_phone ON contacts(client_id, phone);
  CREATE INDEX contacts_client_lid ON contacts(client_id, lid);

  CREATE TABLE labels (
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (client_id, label_id)
  );

  CREATE TABLE sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    value REAL NOT NULL,
    currency TEXT NOT NULL,
    detected_by TEXT NOT NULL,       -- 'manual' | 'keyword' | 'label' | 'api'
    external_ref TEXT,
    note TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX sales_external_ref ON sales(client_id, external_ref) WHERE external_ref IS NOT NULL;

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- 'lead' | 'qualified' | 'purchase'
    platform TEXT NOT NULL,          -- 'meta' | 'ga4' | 'gads'
    event_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'error' | 'skipped'
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
    event_time INTEGER NOT NULL DEFAULT (unixepoch()),
    detail TEXT,
    request TEXT,
    response TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    sent_at INTEGER
  );
  CREATE UNIQUE INDEX events_unique ON events(platform, event_id);
  CREATE INDEX events_pending ON events(status, next_attempt_at);
  `,
];

export function openDb(path = config.dbPath): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const now = (): number => Math.floor(Date.now() / 1000);

import { escapeHtml } from '../lib/util.js';

export class Raw {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}
export const raw = (v: string): Raw => new Raw(v);

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(v);
}

/** Template HTML com escape automático das interpolações (use raw() para HTML confiável). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

export const brl = (v: number, currency = 'BRL'): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(v || 0);

export const dt = (epochS: number | null | undefined): string =>
  epochS
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(
        new Date(epochS * 1000),
      )
    : '—';

export const SOURCE_LABEL: Record<string, string> = {
  ctwa: 'Anúncio Meta (CTWA)',
  link: 'Link rastreável',
  tag: 'Site (tag)',
  organic: 'Orgânico / sem origem',
};

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5d6472;--line:#e3e6eb;--accent:#0f9d58;--accent-ink:#fff;--warn:#b26a00;--err:#c62828;--chip:#eef1f4}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--text:#e8eaee;--muted:#9aa2b1;--line:#2c3139;--accent:#34c47c;--accent-ink:#06210f;--warn:#f0a43a;--err:#ff6b6b;--chip:#252a31}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
a{color:inherit}header{display:flex;gap:16px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card)}
header b{font-size:16px}header nav{display:flex;gap:14px;font-size:14px;color:var(--muted)}
main{max-width:1180px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:4px 0 16px}h2{font-size:17px;margin:28px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.kpi .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}.kpi .l{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--chip);font-size:12px;white-space:nowrap}
.ok{color:var(--accent)}.warn{color:var(--warn)}.err{color:var(--err)}.muted{color:var(--muted)}
form.inline{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input,select,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:7px 9px;width:100%}
form.inline input{width:auto}
button,.btn{font:inherit;cursor:pointer;border:0;border-radius:7px;padding:8px 14px;background:var(--accent);color:var(--accent-ink);text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:var(--chip);color:var(--text)}
fieldset{border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:0 0 16px}legend{font-weight:600;padding:0 6px}
.cols{display:grid;gap:0 16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--chip);padding:10px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;background:var(--chip)}
.hint{font-size:12px;color:var(--muted);margin-top:3px}
`;

export function layout(title: string, body: Raw, opts: { nav?: boolean; flash?: string | null } = {}): string {
  const nav = opts.nav !== false;
  return html`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Exkalla Track</title>
<style>${raw(CSS)}</style></head><body>
<header><b>Exkalla Track</b>${nav ? html`<nav><a href="/admin">Clientes</a><a href="/admin/clients/new">Novo cliente</a></nav>` : ''}</header>
<main>${opts.flash ? html`<div class="flash">${opts.flash}</div>` : ''}${body}</main></body></html>`.value;
}

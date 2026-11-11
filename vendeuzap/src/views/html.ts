import { config } from '../config.js';
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

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

export const brl = (v: number, currency = 'BRL'): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(v || 0);

export const dt = (epochS: number | null | undefined): string =>
  epochS
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: config.timezone }).format(
        new Date(epochS * 1000),
      )
    : '—';

/** "agora", "há 5 min", "há 3 h", "ontem", "há 4 dias", ou a data. */
export function ago(epochS: number | null | undefined): string {
  if (!epochS) return '—';
  const s = Math.floor(Date.now() / 1000) - epochS;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return 'ontem';
  if (s < 30 * 86400) return `há ${Math.floor(s / 86400)} dias`;
  return dt(epochS).split(',')[0];
}

export const initials = (name: string | null | undefined): string => {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

export const pct = (v: number): string => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`;

// ---------------------------------------------------------------------------
// Vocabulário da interface
// ---------------------------------------------------------------------------

export const SOURCE_LABEL: Record<string, string> = {
  ctwa: 'Anúncio no WhatsApp',
  link: 'Link rastreável',
  tag: 'Site',
  organic: 'Sem origem',
};

export const SOURCE_HINT: Record<string, string> = {
  ctwa: 'O lead clicou em um anúncio da Meta que abre o WhatsApp',
  link: 'O lead clicou em um link rastreável (bio, Google, QR code)',
  tag: 'O lead clicou no botão de WhatsApp do site',
  organic: 'Não foi possível identificar de onde o lead veio',
};

export const sourceChip = (source: string): Raw =>
  html`<span class="chip src-${source}" title="${SOURCE_HINT[source] ?? ''}">${SOURCE_LABEL[source] ?? source}</span>`;

export const STATUS_PILL: Record<string, Raw> = {
  lead: html`<span class="pill">Lead</span>`,
  qualified: html`<span class="pill pill-info">Qualificado</span>`,
  customer: html`<span class="pill pill-ok">Cliente</span>`,
};

// ---------------------------------------------------------------------------
// Estilos
// ---------------------------------------------------------------------------

const CSS = `
:root{
  --bg:#f3f5f9;--surface:#fff;--surface-2:#eef1f6;--text:#08213d;--muted:#56657c;--line:#dfe4ec;
  --brand:#fe7e01;--brand-strong:#b45309;--brand-soft:#fff1e3;--on-brand:#08213d;
  --navy:#08213d;--on-navy:#fff;--on-navy-muted:rgba(255,255,255,.72);
  --ok:#15803d;--ok-soft:#e3f5e9;
  --info:#2563eb;--info-soft:#e6eefc;--warn:#946200;--warn-soft:#fdf3d3;--err:#c42b2b;--err-soft:#fde8e8;
  --meta:#1d5bd8;--meta-soft:#e7eefc;--link:#7c3aed;--link-soft:#efe8fd;--site:#0f8a8a;--site-soft:#e0f4f4;
  --shadow:0 1px 2px rgba(8,33,61,.05),0 1px 3px rgba(8,33,61,.07);--radius:12px
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#061629;--surface:#0b2240;--surface-2:#12305a;--text:#eef2f8;--muted:#9fb0c8;--line:#1c3a63;
  --brand:#ff8a1a;--brand-strong:#ffb066;--brand-soft:#3a2310;--on-brand:#08213d;
  --navy:#041120;
  --ok:#4ade80;--ok-soft:#12321f;
  --info:#7aa5ff;--info-soft:#1b2740;--warn:#facc15;--warn-soft:#3a3010;--err:#ff7b7b;--err-soft:#3d1c1c;
  --meta:#86a8ff;--meta-soft:#1c2744;--link:#b99bff;--link-soft:#2a2142;--site:#5fd1d1;--site-soft:#163333;
  --shadow:none}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font:15px/1.5 "Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
a{color:inherit}
.topbar{position:sticky;top:0;z-index:5;display:flex;gap:20px;align-items:center;padding:0 20px;height:60px;background:var(--navy);color:var(--on-navy);border-bottom:3px solid var(--brand)}
.logo{display:flex;align-items:center;gap:8px;font-weight:750;font-size:17px;text-decoration:none;letter-spacing:-.01em}
.logo{color:var(--on-navy)}
.logo img{width:34px;height:34px;border-radius:9px;display:block}
.topbar nav{display:flex;gap:4px;margin-left:auto}
.topbar nav a{padding:7px 12px;border-radius:8px;text-decoration:none;color:var(--on-navy-muted);font-size:14px;font-weight:550}
.topbar nav a:hover{background:rgba(255,255,255,.1);color:var(--on-navy)}
main{max-width:1120px;margin:0 auto;padding:24px 16px 72px}
h1{font-size:24px;line-height:1.25;margin:0;letter-spacing:-.015em}
h2{font-size:17px;margin:0 0 4px}
h3{font-size:15px;margin:0 0 4px}
p{margin:0 0 10px}
.sub{color:var(--muted);font-size:14px;margin:4px 0 0}
.muted{color:var(--muted)}.small{font-size:13px}
.page-head{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;margin-bottom:18px}
.back{display:inline-block;color:var(--muted);text-decoration:none;font-size:14px;margin-bottom:6px}
.back:hover{color:var(--text)}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 0 22px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs a{padding:10px 14px;text-decoration:none;color:var(--muted);font-size:14px;font-weight:550;border-bottom:2px solid transparent;white-space:nowrap}
.tabs a:hover{color:var(--text)}
.tabs a.on{color:var(--text);border-color:var(--brand)}
.tabs .count{display:inline-block;min-width:18px;padding:0 6px;margin-left:4px;border-radius:99px;background:var(--err);color:#fff;font-size:11px;line-height:18px;text-align:center}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow)}
.stack > * + *{margin-top:16px}
.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:12px}
.card-head a{font-size:13px;color:var(--muted)}
.grid{display:grid;gap:16px}
.g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.kpi{padding:16px 18px}
.kpi .l{color:var(--muted);font-size:13px;font-weight:550}
.kpi .v{font-size:28px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:2px}
.kpi .h{color:var(--muted);font-size:12px}
.funnel{display:flex;flex-direction:column;gap:12px}
.bar{display:grid;grid-template-columns:140px 1fr 90px;gap:12px;align-items:center;font-size:14px}
.bar .track{height:12px;background:var(--surface-2);border-radius:99px;overflow:hidden}
.bar .fill{height:100%;border-radius:99px;background:var(--brand)}
.bar .val{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.bar .val b{color:var(--text)}
.rank{display:flex;flex-direction:column}
.rank-row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:10px 0;border-top:1px solid var(--line)}
.rank-row:first-child{border-top:0;padding-top:0}
.rank-row .meta{color:var(--muted);font-size:13px}
.rank-row .money{font-weight:650;font-variant-numeric:tabular-nums;text-align:right}
.rank-row .track{grid-column:1/-1;height:6px;background:var(--surface-2);border-radius:99px;overflow:hidden}
.rank-row .fill{height:100%;background:var(--brand);border-radius:99px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:0}
th{color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.table-wrap{overflow-x:auto;margin:0 -18px;padding:0 18px}
.person{display:flex;gap:10px;align-items:center;min-width:180px}
.avatar{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:var(--brand-soft);color:var(--brand-strong);font-weight:700;font-size:13px}
.person b{display:block;font-weight:600}
.person span{color:var(--muted);font-size:13px}
.chip{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:550;background:var(--surface-2);color:var(--muted);white-space:nowrap}
.src-ctwa{background:var(--meta-soft);color:var(--meta)}.src-link{background:var(--link-soft);color:var(--link)}
.src-tag{background:var(--site-soft);color:var(--site)}.src-organic{background:var(--surface-2);color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;background:var(--surface-2);color:var(--muted);white-space:nowrap}
.pill-ok{background:var(--ok-soft);color:var(--ok)}.pill-info{background:var(--info-soft);color:var(--info)}
.pill-warn{background:var(--warn-soft);color:var(--warn)}.pill-err{background:var(--err-soft);color:var(--err)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block}
.btn,button{font:inherit;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent;border-radius:9px;padding:8px 14px;background:var(--brand);color:var(--on-brand);text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.btn:hover,button:hover{filter:brightness(.95)}
.btn.ghost,button.ghost{background:var(--surface);color:var(--text);border-color:var(--line)}
.btn.ghost:hover,button.ghost:hover{background:var(--surface-2);filter:none}
.btn.danger,button.danger{background:var(--surface);color:var(--err);border-color:var(--line)}
.btn.sm,button.sm{padding:5px 10px;font-size:13px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.spacer{flex:1}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 5px}
.help{font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.45}
input,select,textarea{font:inherit;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:9px 11px;width:100%}
input:focus,select:focus,textarea:focus{outline:2px solid var(--brand);outline-offset:-1px;border-color:transparent}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:500;font-size:14px;margin:12px 0 0}
.check input{width:auto;margin-top:4px}
.form-cols{display:grid;gap:0 16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.section{display:grid;grid-template-columns:260px 1fr;gap:24px;padding:22px 0;border-top:1px solid var(--line)}
.section:first-of-type{border-top:0;padding-top:0}
.section > div:first-child p{color:var(--muted);font-size:13.5px}
@media (max-width:760px){.section{grid-template-columns:1fr;gap:4px}.bar{grid-template-columns:100px 1fr 70px}}
details.more{margin-top:14px}
details.more > summary{cursor:pointer;color:var(--muted);font-size:13.5px;font-weight:600;list-style:none}
details.more > summary::before{content:"▸ ";}
details.more[open] > summary::before{content:"▾ ";}
.code{display:flex;gap:8px;align-items:center;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:6px 6px 6px 12px;margin:8px 0}
.code code{flex:1;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;white-space:nowrap}
pre{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:10px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:6px 0}
.flash{display:flex;gap:10px;align-items:center;padding:12px 16px;border-radius:10px;margin-bottom:18px;background:var(--ok-soft);color:var(--ok);font-weight:550}
.flash.err{background:var(--err-soft);color:var(--err)}
.banner{padding:10px 16px;background:var(--warn-soft);color:var(--warn);font-size:13.5px;text-align:center;font-weight:550}
.steps{list-style:none;margin:0;padding:0}
.step{display:grid;grid-template-columns:36px 1fr;gap:14px;padding:18px 0;border-top:1px solid var(--line)}
.step:first-child{border-top:0;padding-top:4px}
.step .n{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--surface-2);color:var(--muted);font-weight:700}
.step.done .n{background:var(--brand);color:var(--on-brand)}
.step-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.empty{text-align:center;padding:36px 16px;color:var(--muted)}
.empty b{display:block;color:var(--text);font-size:15px;margin-bottom:4px}
.client-card{display:block;text-decoration:none;transition:border-color .15s}
.client-card:hover{border-color:var(--brand)}
.client-card .top{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-bottom:14px}
.client-card .top .muted{white-space:nowrap}
.client-card .nums{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.client-card .nums b{display:block;font-size:19px;font-variant-numeric:tabular-nums}
.client-card .nums span{font-size:12px;color:var(--muted)}
.client-card .foot{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.seg{display:inline-flex;background:var(--surface-2);border-radius:9px;padding:3px}
.seg a{padding:5px 12px;border-radius:7px;text-decoration:none;font-size:13px;font-weight:600;color:var(--muted)}
.seg a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.filters input{max-width:260px}
.filters select{width:auto}
.pop{position:relative;display:inline-block}
.pop > summary{list-style:none}
.pop > summary::-webkit-details-marker{display:none}
.pop[open] > .pop-body{position:absolute;right:0;top:calc(100% + 6px);z-index:4;width:260px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:0 8px 28px rgba(0,0,0,.14)}
.pop-body{text-align:left;white-space:normal}
.pop-body label{margin-top:0}
.platforms{display:flex;gap:6px;flex-wrap:wrap}
.tech{margin-top:6px}
.tech summary{cursor:pointer;color:var(--muted);font-size:12.5px}
.qr{display:grid;grid-template-columns:248px 1fr;gap:20px;align-items:start;margin-top:8px}
.qr-box{width:248px;height:248px;display:grid;place-items:center;background:#fff;border:1px solid var(--line);border-radius:12px;padding:8px}
.qr-box img{width:100%;height:100%;object-fit:contain}
.qr-box .qr-wait{text-align:center;padding:12px;color:#56657c}
.qr-steps{margin:0 0 8px;padding-left:20px;font-size:14px}.qr-steps li{margin-bottom:4px}
.pair-code{font:700 26px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;margin:12px 0 4px;color:var(--text)}
.notice{background:var(--warn-soft);color:var(--text);border-radius:10px;padding:10px 14px;margin:10px 0;font-size:13.5px}
.notice code{font-size:12.5px;word-break:break-all}
@media (max-width:640px){.qr{grid-template-columns:1fr}.qr-box{margin:0 auto}}
@media (max-width:600px){
  main{padding:16px 12px 48px}h1{font-size:21px}
  .g4{grid-template-columns:1fr 1fr;gap:10px}
  .kpi{padding:12px 14px}.kpi .v{font-size:21px}.kpi .h{display:none}
  .card{padding:14px}.table-wrap{margin:0 -14px;padding:0 14px}
  .hide-sm{display:none}
  th,td{padding:10px 6px}
  .filters input{max-width:none}
}
`;

const COPY_JS = `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;var t=b.getAttribute('data-copy');
navigator.clipboard&&navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent='Copiado!';setTimeout(function(){b.textContent=o},1400)})});`;

export const copyable = (value: string): Raw =>
  html`<div class="code"><code>${value}</code><button type="button" class="ghost sm" data-copy="${value}">Copiar</button></div>`;

export interface LayoutOpts {
  nav?: boolean;
  flash?: string | null;
}

export function layout(title: string, body: Raw, opts: LayoutOpts = {}): string {
  const nav = opts.nav !== false;
  const flash = opts.flash;
  const isErr = flash ? /^(erro|falha)/i.test(flash) : false;
  return html`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Vendeuzap</title>
<link rel="icon" type="image/png" href="/favicon.png"><meta name="theme-color" content="#08213d">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${raw(CSS)}</style></head><body>
${nav && config.dryRun ? html`<div class="banner">Modo simulação ativo: as conversões aparecem aqui, mas não estão sendo enviadas para Meta e Google.</div>` : ''}
<header class="topbar"><a class="logo" href="${nav ? '/admin' : '#'}"><img src="/logo.png" alt="" width="34" height="34">Vendeuzap</a>
${nav ? html`<nav><a href="/admin">Clientes</a><a href="/admin/clients/new">+ Novo cliente</a></nav>` : ''}</header>
<main>${flash ? html`<div class="flash ${isErr ? 'err' : ''}">${isErr ? '⚠' : '✓'} ${flash}</div>` : ''}${body}</main>
<script>${raw(COPY_JS)}</script></body></html>`.value;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { renderMarkdown } from '../src/lib/markdown.js';

test('markdown: títulos com âncora, listas, tabela, citação e escape de HTML', () => {
  const { html, headings } = renderMarkdown(
    '# Título\n\n## Meta\n\n1. Um **forte**\n2. Dois `code`\n   - sub\n\n| A | B |\n|---|---|\n| x | y |\n\n> aviso\n\n6. continua\n\n<script>alert(1)</script>',
  );
  assert.deepEqual(headings.map((h) => h.id), ['titulo', 'meta']);
  assert.match(html, /<h2 id="meta">Meta<\/h2>/);
  assert.match(html, /<ol><li>Um <b>forte<\/b><\/li><li>Dois <code>code<\/code><ul><li>sub<\/li><\/ul><\/li><\/ol>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<blockquote>aviso<\/blockquote>/);
  assert.match(html, /<ol start="6">/);
  assert.ok(!html.includes('<script>'), 'HTML do arquivo é escapado');
});

test('central de ajuda: abre no painel com Meta, GA4 e Google Ads', async () => {
  const app = await buildApp(openDb(':memory:'));
  const auth = { authorization: `Basic ${Buffer.from('admin:test').toString('base64')}` };
  assert.equal((await app.inject({ method: 'GET', url: '/admin/ajuda' })).statusCode, 401);
  const r = await app.inject({ method: 'GET', url: '/admin/ajuda', headers: auth });
  assert.equal(r.statusCode, 200);
  for (const id of ['meta', 'google-analytics-4', 'google-ads', 'problemas-comuns']) assert.match(r.body, new RegExp(`id="${id}"`));
  assert.match(r.body, /href="\/admin\/ajuda"/, 'link Ajuda na barra do topo');
  // Todo o conteúdo do arquivo vira HTML (nenhuma linha de tabela ou lista fica crua)
  assert.ok(!/\n\|/.test(r.body) && !r.body.includes('**'));
  assert.ok(readFileSync(new URL('../public/ajuda.md', import.meta.url), 'utf8').includes('## Google Ads'));
});

/**
 * Conversor de Markdown simples, só para o conteúdo da central de ajuda (public/ajuda.md).
 * Suporta: títulos (#, ##, ###), parágrafos, listas numeradas e com marcador (com um nível
 * de lista dentro de item), tabelas, citações (>), linha (---), **negrito**, `código` e [links](url).
 * O texto é sempre escapado antes da formatação, então o arquivo não injeta HTML.
 */
import { escapeHtml, slugify } from './util.js';

function inline(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const safe = /^(https?:\/\/|\/|#)/.test(url) ? url : '#';
    const ext = /^https?:/.test(url) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${safe}"${ext}>${label}</a>`;
  });
  return s;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export function renderMarkdown(md: string): { html: string; headings: Heading[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  const used = new Set<string>();
  let i = 0;

  const listItem = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      let id = slugify(text) || 'secao';
      while (used.has(id)) id = `${id}-2`;
      used.add(id);
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (/^-{3,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    if (line.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    const li = line.match(listItem);
    if (li && li[1].length === 0) {
      const ordered = /\d+\./.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items: { text: string; sub: string[]; subOrdered: boolean }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(listItem);
        if (!m) {
          // linha de continuação recuada pertence ao item anterior
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1].text += ' ' + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        if (m[1].length === 0) {
          if (/\d+\./.test(m[2]) !== ordered) break;
          items.push({ text: m[3], sub: [], subOrdered: false });
        } else if (items.length) {
          const last = items[items.length - 1];
          last.subOrdered = /\d+\./.test(m[2]);
          last.sub.push(m[3]);
        }
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(
        `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>` +
          items
            .map((it) => {
              const subTag = it.subOrdered ? 'ol' : 'ul';
              const sub = it.sub.length ? `<${subTag}>${it.sub.map((x) => `<li>${inline(x)}</li>`).join('')}</${subTag}>` : '';
              return `<li>${inline(it.text)}${sub}</li>`;
            })
            .join('') +
          `</${tag}>`,
      );
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|>|\||-{3,}\s*$)/.test(lines[i]) && !listItem.test(lines[i])) {
      buf.push(lines[i++].trim());
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return { html: out.join('\n'), headings };
}

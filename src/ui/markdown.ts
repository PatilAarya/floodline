/**
 * A tiny Markdown renderer for the Viva page (which shows docs/VIVA.md).
 * Hand-written and deliberately small: only what that file uses.
 *
 *   Blocks:  # to ###### headings, paragraphs, - and 1. lists,
 *            ``` fenced code, | tables | with a separator row.
 *   Inline:  `code`, **bold**, *emphasis*, [text](link), \* escapes.
 *
 * Everything is HTML-escaped first, so the file cannot inject markup. Links
 * are only kept for in-site (#...) and http(s) addresses.
 */

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) {
      flush();
      const level = hd[1].length;
      const text = hd[2].trim();
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      continue;
    }
    if (/^\|/.test(line)) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      out.push(table(rows));
      continue;
    }
    if (/^(\s*)(-|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*(-|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*(-|\d+\.)\s+/, '');
        // Continuation lines (indented, not a new item).
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*(-|\d+\.)\s+/.test(lines[i + 1])) item += ' ' + lines[++i].trim();
        items.push(`<li>${inline(item)}</li>`);
        i++;
      }
      i--;
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

function table(rows: string[]): string {
  const cells = (r: string) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(/^\|[\s:|-]+\|$/.test(rows[1] ?? '') ? 2 : 1).map(cells);
  return `<div class="table-scroll"><table class="data"><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** Inline markup on one line of text. */
export function inline(text: string): string {
  const codes: string[] = [];
  let s = esc(text.replace(/\\\*/g, '\u0001'));
  s = s.replace(/`([^`]+)`/g, (_, c: string) => `\u0002${codes.push(c) - 1}\u0002`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, href: string) => (/^(#|https?:\/\/)/.test(href) ? `<a href="${href}">${t}</a>` : t));
  s = s.replace(/\u0002(\d+)\u0002/g, (_, k: string) => `<code>${codes[Number(k)].replace(/\u0001/g, '*')}</code>`);
  return s.replace(/\u0001/g, '*');
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\\\*/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

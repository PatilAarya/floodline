/**
 * Viva: revision notes for every algorithm, straight from docs/VIVA.md (so
 * the page and the document can never disagree). Each `##` heading becomes a
 * section; a contents list stays beside the text on wide screens, and a
 * filter narrows the sections to those mentioning a word.
 */
import vivaMd from '../../docs/VIVA.md?raw';
import { replaceParams, type Page } from '../core/router';
import { announce, h } from '../ui/dom';
import { renderMarkdown } from '../ui/markdown';
import { pageHead } from './_shared';

const page: Page = {
  title: 'Viva',
  mount({ root, params }) {
    const holder = h('div');
    holder.innerHTML = renderMarkdown(vivaMd);
    // Split the rendered document into sections at each h2 (the h1 is the page head).
    const intro: Element[] = [];
    const sections: { id: string; title: string; el: HTMLElement; text: string }[] = [];
    let current: HTMLElement | null = null;
    for (const node of [...holder.children]) {
      if (node.tagName === 'H1') continue;
      if (node.tagName === 'H2') {
        current = h('section', { class: 'viva-section', id: `viva-${node.id}`, 'aria-labelledby': node.id });
        sections.push({ id: node.id, title: node.textContent ?? '', el: current, text: '' });
      }
      if (current) current.append(node);
      else intro.push(node);
    }
    for (const s of sections) s.text = (s.el.textContent ?? '').toLowerCase();

    const toc = h('ol', { class: 'viva-toc' });
    const tocLinks = sections.map((s) => {
      const a = h('a', { href: `#/viva?topic=${s.id}` }, s.title);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        go(s.id, true);
      });
      toc.append(h('li', null, a));
      return a;
    });

    const filter = h('input', { type: 'search', id: 'viva-filter', placeholder: 'e.g. admissible, wipeout, cooling', autocomplete: 'off', spellcheck: 'false' });
    const filterNote = h('p', { class: 'small muted', 'aria-live': 'polite' });
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      let shown = 0;
      sections.forEach((s, i) => {
        const hit = !q || s.text.includes(q) || s.title.toLowerCase().includes(q);
        s.el.hidden = !hit;
        tocLinks[i].parentElement!.hidden = !hit;
        if (hit) shown++;
      });
      filterNote.textContent = q ? `${shown} of ${sections.length} sections mention "${filter.value.trim()}".` : '';
    });

    root.append(
      h(
        'div',
        { class: 'page page-enter' },
        pageHead('Revision', 'Viva notes', 'Every algorithm in Floodline: the idea, pseudocode, cost, why it is here and not something else, where it lives in the code, and short answers to likely questions.'),
        h(
          'div',
          { class: 'viva-layout' },
          h(
            'nav',
            { class: 'viva-nav', 'aria-label': 'Viva topics' },
            h('div', { class: 'field' }, h('label', { class: 'ctl-label', for: 'viva-filter' }, 'Find a topic'), filter),
            filterNote,
            toc,
          ),
          h('article', { class: 'viva-body' }, h('div', { class: 'viva-intro' }, ...intro), ...sections.map((s) => s.el), h('p', { class: 'small muted viva-source' }, 'This page shows docs/VIVA.md from the repository.')),
        ),
      ),
    );

    function go(id: string, smooth: boolean) {
      const s = sections.find((x) => x.id === id);
      if (!s) return;
      if (s.el.hidden) {
        filter.value = '';
        filter.dispatchEvent(new Event('input'));
      }
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      s.el.scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' });
      const heading = s.el.querySelector('h2') as HTMLElement | null;
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
      replaceParams({ topic: id });
      announce(s.title);
    }

    const topic = params.get('topic');
    // After the page wipe has laid the page out (a timer, so it also works in background tabs).
    if (topic && /^[a-z0-9-]{1,80}$/.test(topic)) setTimeout(() => go(topic, false), 80);
  },
};

export default page;

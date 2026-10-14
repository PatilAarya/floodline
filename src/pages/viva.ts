import type { Page } from '../core/router';
import { h } from '../ui/dom';
import { comingInPhase, pageHead } from './_shared';

const page: Page = {
  title: 'Viva',
  mount({ root }) {
    root.append(
      h('div', { class: 'page page-enter' }, pageHead('Revision', 'Viva', 'Every algorithm in brief: what it does, why it is here, and what to say when asked.'), comingInPhase(9, [
    'Per-algorithm explanations, pseudocode and complexity',
    'Design decisions and why-not-X answers',
    'Likely viva questions with short answers',
  ])),
    );
  },
};

export default page;

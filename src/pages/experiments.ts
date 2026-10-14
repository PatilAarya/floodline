import type { Page } from '../core/router';
import { h } from '../ui/dom';
import { comingInPhase, pageHead } from './_shared';

const page: Page = {
  title: 'Experiments',
  mount({ root }) {
    root.append(
      h('div', { class: 'page page-enter' }, pageHead('Evidence', 'Experiments', 'Many seeded floods, three strategies, real numbers.'), comingInPhase(8, [
    'Batch runs in a worker with progress, without freezing the page',
    'Paired comparison charts and a plain-language conclusion',
    'CSV export',
  ])),
    );
  },
};

export default page;

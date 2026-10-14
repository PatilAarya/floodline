import type { Page } from '../core/router';
import { h } from '../ui/dom';
import { comingInPhase, pageHead } from './_shared';

const page: Page = {
  title: 'Bayes',
  mount({ root }) {
    root.append(
      h('div', { class: 'page page-enter' }, pageHead('Reasoning under uncertainty', 'Bayes', 'A Bayesian network turns noisy gauge readings into flood risk for each neighbourhood.'), comingInPhase(5, [
    'The network drawn as a graph; click a node to set evidence',
    'Exact inference (enumeration, variable elimination) and likelihood weighting',
    'A d-separation explainer',
  ])),
    );
  },
};

export default page;

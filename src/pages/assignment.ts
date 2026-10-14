import type { Page } from '../core/router';
import { h } from '../ui/dom';
import { comingInPhase, pageHead } from './_shared';

const page: Page = {
  title: 'Assignment',
  mount({ root }) {
    root.append(
      h('div', { class: 'page page-enter' }, pageHead('Constraint satisfaction and local search', 'Assignment', 'Evacuee groups are assigned to shelters by a CSP, then improved by simulated annealing.'), comingInPhase(6, [
    'Backtracking with forward checking, MRV, degree and LCV toggles',
    'An animated search tree with pruned branches and wipeouts',
    'Simulated annealing against hill climbing, with an energy plot',
  ])),
    );
  },
};

export default page;

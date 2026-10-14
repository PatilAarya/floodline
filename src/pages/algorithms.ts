import type { Page } from '../core/router';
import { h } from '../ui/dom';
import { comingInPhase, pageHead } from './_shared';

const page: Page = {
  title: 'Algorithms',
  mount({ root }) {
    root.append(
      h('div', { class: 'page page-enter' }, pageHead('Search', 'Algorithms', 'BFS, DFS, Uniform Cost, Greedy Best-First and A* race on the same flooded road graph.'), comingInPhase(4, [
    'Pick a start and goal, then race all five searches side by side',
    'Live counters: nodes expanded, frontier size, path cost, time',
    'A bad-heuristic toggle to show A* losing optimality',
  ])),
    );
  },
};

export default page;

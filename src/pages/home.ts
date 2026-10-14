import type { Page } from '../core/router';
import { h, fromHTML } from '../ui/dom';
import { glyph } from '../ui/glyphs';

const chapters = [
  { n: '01', title: 'Rain becomes risk', body: 'A Bayesian network turns noisy rain and Mithi River gauges into a flood-risk posterior for every neighbourhood, from Dharavi to Kurla.', href: '#/bayes', cta: 'Explore the network' },
  { n: '02', title: 'People meet shelters', body: 'A constraint solver assigns evacuee groups to relief centres on high ground within capacity and deadline, then simulated annealing improves the plan.', href: '#/assignment', cta: 'Open the assignment lab' },
  { n: '03', title: 'Roads disappear', body: 'Rain, tide and the Mithi spread water across real Mumbai terrain. Subways fill, bridges close, roads go under. A* re-plans every group from where it stands.', href: '#/algorithms', cta: 'Race the search algorithms' },
  { n: '04', title: 'Evidence, not claims', body: 'Fifty seeded monsoon storms, three strategies, real numbers: risk-aware dynamic re-planning against naive static routing.', href: '#/experiments', cta: 'See the experiments' },
];

const page: Page = {
  title: 'Floodline',
  mount({ root }) {
    root.append(
      h(
        'div',
        { class: 'page page-enter' },
        h(
          'section',
          { class: 'section', 'aria-labelledby': 'home-title' },
          h('p', { class: 'eyebrow' }, 'Dynamic flood evacuation planner · Mithi River basin, Mumbai'),
          h('h1', { class: 'display', id: 'home-title' }, 'Floodline'),
          h('p', { class: 'lede' }, 'Navigation apps assume the road network is fixed. Floodline handles roads that disappear and risk that is uncertain.'),
          h('p', null, h('a', { class: 'btn btn-primary btn-large', href: '#/simulator' }, 'Flood Mumbai', fromHTML(glyph('arrow')))),
        ),
        h(
          'section',
          { class: 'section', 'aria-label': 'How it works' },
          h('p', { class: 'eyebrow' }, 'How it works'),
          ...chapters.map((c) =>
            h(
              'div',
              { class: 'margin-grid', style: 'padding: var(--s-5) 0; border-top: 1px solid var(--hairline)' },
              h('p', { class: 'marker figure', style: 'font-size: var(--step-3)' }, c.n),
              h('div', null, h('h2', { style: 'font-size: var(--step-2)' }, c.title), h('p', null, c.body), h('a', { class: 'btn', href: c.href }, c.cta, fromHTML(glyph('arrow')))),
            ),
          ),
        ),
      ),
    );
  },
};

export default page;

/**
 * Controls kit (unlisted route #/kit): every custom control in one place so
 * they can be checked by mouse, touch and keyboard.
 */
import type { Page } from '../core/router';
import { fmtMinutes } from '../core/units';
import { createScrubber } from '../ui/controls/scrubber';
import { createSegmented } from '../ui/controls/segmented';
import { createSlider } from '../ui/controls/slider';
import { createToggle } from '../ui/controls/toggle';
import { h, fromHTML } from '../ui/dom';
import { glyphs, type GlyphName } from '../ui/glyphs';
import { pageHead } from './_shared';

const page: Page = {
  title: 'Controls kit',
  mount({ root }) {
    const log = h('p', { class: 'mono small muted', 'aria-live': 'polite' }, 'Interact with a control.');
    const say = (s: string) => (log.textContent = s);

    const rain = createSlider({ label: 'Rain intensity', min: 0, max: 120, step: 1, value: 45, format: (v) => `${v} mm/h`, onInput: (v) => say(`rain = ${v}`), ticks: 7 });
    const lambda = createSlider({ label: 'Risk weight lambda', min: 0, max: 10, step: 0.1, value: 2.5, format: (v) => v.toFixed(1), onChange: (v) => say(`lambda committed = ${v}`) });
    const toggle = createToggle({ label: 'Show contours', value: true, onChange: (v) => say(`contours = ${v}`) });
    const strategy = createSegmented({
      label: 'Strategy',
      value: 'risk',
      options: [
        { value: 'naive', label: 'Naive static' },
        { value: 'dynamic', label: 'Dynamic A*' },
        { value: 'risk', label: 'Risk-aware + CSP + SA' },
      ],
      onChange: (v) => say(`strategy = ${v}`),
    });
    const quality = createSegmented({
      label: 'Quality',
      value: 'auto',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'high', label: 'High' },
        { value: 'low', label: 'Low' },
      ],
      onChange: (v) => say(`quality = ${v}`),
    });

    // A plausible storm hydrograph: rainfall and a lagged river stage.
    const n = 200;
    const rainS = new Float32Array(n), river = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      rainS[i] = Math.exp(-Math.pow((t - 0.3) / 0.12, 2));
      river[i] = Math.exp(-Math.pow((t - 0.45) / 0.18, 2));
    }
    const scrub = createScrubber({ label: 'Timeline', duration: 360, value: 90, onScrub: (t, final) => say(`t = ${fmtMinutes(t)}${final ? ' (released)' : ''}`) });
    scrub.setHydrograph(river, rainS);
    scrub.setBuffered(0.7);

    const glyphRow = h(
      'div',
      { class: 'cluster', style: 'font-size: 1.6rem' },
      ...(Object.keys(glyphs) as GlyphName[]).map((g) =>
        h('figure', { style: 'margin:0; display:flex; flex-direction:column; align-items:center; gap:.4rem' }, fromHTML(glyphs[g]()), h('figcaption', { class: 'mono small muted' }, g)),
      ),
    );

    root.append(
      h(
        'div',
        { class: 'page page-enter' },
        pageHead('Unlisted', 'Controls kit', 'Every custom control, for checking with mouse, touch and keyboard.'),
        h(
          'div',
          { class: 'margin-grid' },
          h('p', { class: 'marker' }, 'controls'),
          h('div', { style: 'max-width: 26rem' }, rain.el, lambda.el, toggle.el, strategy.el, quality.el),
          h('p', { class: 'annot' }, 'Tab to each control. Sliders take arrows, Page Up/Down, Home and End. Segmented controls take arrows. Toggles take Space or Enter.'),
          h('p', { class: 'marker' }, 'timeline'),
          h('div', { style: 'padding-top: 2rem' }, scrub.el),
          h('p', { class: 'annot' }, 'Solid line: river stage. Dashed: rainfall. The thick base bar shows how far the simulation has been computed; you cannot scrub past it.'),
          h('p', { class: 'marker' }, 'output'),
          log,
          h('p', { class: 'marker' }, 'glyphs'),
          glyphRow,
          h('p', { class: 'marker' }, 'buttons'),
          h('div', { class: 'cluster' }, h('button', { class: 'btn btn-primary', type: 'button' }, 'Play'), h('button', { class: 'btn', type: 'button' }, 'Pause'), h('button', { class: 'btn', type: 'button' }, 'Reset'), h('button', { class: 'btn', type: 'button', disabled: true }, 'Disabled')),
        ),
      ),
    );

    return () => scrub.destroy();
  },
};

export default page;

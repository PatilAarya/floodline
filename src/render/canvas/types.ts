import type { Camera } from '../camera';
import type { Palette } from '../theme';

/** Everything a canvas layer needs to draw one frame. */
export interface DrawCtx {
  ctx: CanvasRenderingContext2D;
  cam: Camera;
  pal: Palette;
  /** Seconds since the view started, for pulses and dashes. */
  time: number;
  reducedMotion: boolean;
}

/** Road state per edge, filled in by the flood model from phase 3 on. */
export const EdgeState = { Open: 0, Degraded: 1, Blocked: 2 } as const;
export type EdgeStateValue = (typeof EdgeState)[keyof typeof EdgeState];

export const FONT_BODY = '"Instrument Sans", system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

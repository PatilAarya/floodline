/**
 * WebGL2 terrain + water renderer (raw WebGL, no library).
 *
 * The flood depth field arrives as a Float32Array every simulated minute;
 * it is uploaded into one of two R16F textures (A = previous, B = current)
 * and the shader interpolates between them, so motion is smooth even though
 * frames arrive at the simulation rate, not the display rate.
 *
 * Context loss is handled: `onLost` lets the map fall back to Canvas 2D, and
 * `onRestored` rebuilds every GL resource from the data kept on the CPU.
 */
import fragSrc from './shaders/flood.frag.glsl?raw';
import vertSrc from './shaders/quad.vert.glsl?raw';
import type { Camera } from '../camera';
import { rgbToOklab, type Palette } from '../theme';

export interface GLDrawOptions {
  time: number;
  mix: number;
  rain: number;
  motion: boolean;
  terrain: boolean;
  water: boolean;
  contours: boolean;
}

export class FloodGL {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private tex: { bed: WebGLTexture | null; a: WebGLTexture | null; b: WebGLTexture | null; flow: WebGLTexture | null } = { bed: null, a: null, b: null, flow: null };
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private n = 0;
  private size = 1;
  private range: [number, number] = [0, 1];
  private bed: Float32Array | null = null;
  private depthB: Float32Array | null = null;
  private flow: Float32Array | null = null;
  lost = false;
  onLost: () => void = () => {};
  onRestored: () => void = () => {};

  static create(canvas: HTMLCanvasElement): FloodGL | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    const r = new FloodGL(gl, canvas);
    return r.prog ? r : null;
  }

  private constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement) {
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLost();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.initResources();
      if (this.bed) this.uploadWorld();
      if (this.depthB) this.uploadDepth(this.depthB, this.flow, true);
      this.onRestored();
    });
    this.initResources();
  }

  private initResources(): void {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, vertSrc), fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) {
      this.prog = null;
      return;
    }
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(p));
      this.prog = null;
      return;
    }
    this.prog = p;
    this.vao = gl.createVertexArray();
    for (const name of ['uBed', 'uDepthA', 'uDepthB', 'uFlow', 'uView', 'uRatio', 'uCenter', 'uScale', 'uSize', 'uTexel', 'uRange', 'uMix', 'uTime', 'uRain', 'uMotion', 'uShowTerrain', 'uShowWater', 'uShowContours', 'uText', 'uBg', 'uPri', 'uSec', 'uAcc']) {
      this.loc[name] = gl.getUniformLocation(p, name);
    }
    const mk = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tex = { bed: mk(), a: mk(), b: mk(), flow: mk() };
  }

  /** Upload the terrain once per world. */
  setWorld(bed: Float32Array, n: number, size: number, minH: number, maxH: number): void {
    this.bed = bed;
    this.n = n;
    this.size = size;
    this.range = [minH, Math.min(maxH, minH + 60)];
    this.depthB = null;
    this.uploadWorld();
    const zero = new Float32Array(n * n);
    this.uploadDepth(zero, new Float32Array(n * n * 2), true);
  }

  private uploadWorld(): void {
    const gl = this.gl;
    if (!this.bed || this.lost) return;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.bed);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, this.n, this.n, 0, gl.RED, gl.FLOAT, this.bed);
  }

  /** New depth frame: previous B becomes A. `reset` sets both (after a seek). */
  uploadDepth(depth: Float32Array, flow: Float32Array | null, reset = false): void {
    const gl = this.gl;
    if (this.lost || !this.n) return;
    if (!this.depthB) reset = true;
    this.depthB = depth;
    if (flow) this.flow = flow;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Swap texture roles instead of copying: A <- old B.
    if (!reset) {
      const t = this.tex.a;
      this.tex.a = this.tex.b;
      this.tex.b = t;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.tex.a);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, this.n, this.n, 0, gl.RED, gl.FLOAT, depth);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex.b);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, this.n, this.n, 0, gl.RED, gl.FLOAT, depth);
    if (this.flow) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex.flow);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, this.n, this.n, 0, gl.RG, gl.FLOAT, this.flow);
    }
  }

  render(canvas: HTMLCanvasElement, cam: Camera, pal: Palette, o: GLDrawOptions): void {
    const gl = this.gl;
    if (this.lost || !this.prog || !this.n) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const L = this.loc;
    const bind = (unit: number, tex: WebGLTexture | null, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(L[name], unit);
    };
    bind(0, this.tex.bed, 'uBed');
    bind(1, this.tex.a, 'uDepthA');
    bind(2, this.tex.b, 'uDepthB');
    bind(3, this.tex.flow, 'uFlow');
    gl.uniform2f(L.uView, cam.width, cam.height);
    gl.uniform1f(L.uRatio, canvas.width / Math.max(1, cam.width));
    gl.uniform2f(L.uCenter, cam.cx, cam.cy);
    gl.uniform1f(L.uScale, cam.scale);
    gl.uniform1f(L.uSize, this.size);
    gl.uniform1f(L.uTexel, 1 / this.n);
    gl.uniform2f(L.uRange, this.range[0], this.range[1]);
    gl.uniform1f(L.uMix, Math.min(1, Math.max(0, o.mix)));
    gl.uniform1f(L.uTime, o.time);
    gl.uniform1f(L.uRain, o.rain);
    gl.uniform1f(L.uMotion, o.motion ? 1 : 0);
    gl.uniform1f(L.uShowTerrain, o.terrain ? 1 : 0);
    gl.uniform1f(L.uShowWater, o.water ? 1 : 0);
    gl.uniform1f(L.uShowContours, o.contours ? 1 : 0);
    const set = (name: string, c: readonly [number, number, number]) => {
      const lab = rgbToOklab(c);
      gl.uniform3f(L[name], lab[0], lab[1], lab[2]);
    };
    set('uText', pal.text);
    set('uBg', pal.background);
    set('uPri', pal.primary);
    set('uSec', pal.secondary);
    set('uAcc', pal.accent);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

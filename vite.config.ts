import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Base path. Defaults to './' (relative), which works on any static host
 * because routing is hash-based. Override with BASE_PATH, e.g.
 *   BASE_PATH=/floodline/ npm run build
 */
const base = process.env.BASE_PATH && process.env.BASE_PATH.trim() !== '' ? process.env.BASE_PATH : './';

/** Inject <link rel="preload"> for the two main font weights after bundling. */
function preloadFonts(): Plugin {
  const wanted = /(instrument-sans-latin-400-normal|bricolage-grotesque-latin-700-normal)[^/]*\.woff2$/;
  return {
    name: 'floodline-preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => wanted.test(f));
        const prefix = base.endsWith('/') ? base : base + '/';
        return files.map((f) => ({
          tag: 'link',
          attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: prefix + f, crossorigin: '' },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}

export default defineConfig({
  base,
  plugins: [preloadFonts()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});

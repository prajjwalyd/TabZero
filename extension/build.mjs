import { build, context } from 'esbuild';
import { Resvg } from '@resvg/resvg-js';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');

function copyStatic() {
  cpSync('manifest.json', 'dist/manifest.json');
  cpSync('src/popup.html', 'dist/popup.html');
  cpSync('src/popup.css', 'dist/popup.css');
  cpSync('src/zero.html', 'dist/zero.html');
}

function genIcons() {
  const svg = readFileSync('src/icon.svg', 'utf8');
  mkdirSync('dist/icons', { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' });
    writeFileSync(`dist/icons/${size}.png`, r.render().asPng());
  }
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
copyStatic();
genIcons();

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: { background: 'src/background.ts', popup: 'src/popup.ts', zero: 'src/zero.ts' },
  bundle: true,
  format: 'esm',
  target: 'chrome114',
  outdir: 'dist',
  logLevel: 'info',
};

// Content scripts declared in the manifest are CLASSIC scripts — no ES modules — so this
// one is bundled as an IIFE separately from the module entry points above.
/** @type {import('esbuild').BuildOptions} */
const contentOpts = {
  entryPoints: { content: 'src/content.ts' },
  bundle: true,
  format: 'iife',
  target: 'chrome114',
  outdir: 'dist',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(opts);
  const cctx = await context(contentOpts);
  await ctx.watch();
  await cctx.watch();
  console.log('Tab Zero extension: watching src/ …');
} else {
  await Promise.all([build(opts), build(contentOpts)]);
  console.log('Tab Zero extension built -> extension/dist/');
}

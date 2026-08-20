// Why this exists instead of a plain `tsc && node build.mjs` prepare script.
//
// EVERY install path that packs this package runs `prepare`, and not one of them guarantees a compiler.
// npm's git-dep preparation (npm 11.13.0, confirmed in its own debug log) builds an ideal tree for the
// TARGET directory and then runs `prepare` with the freshly cloned repo as cwd — without ever installing
// that clone's devDependencies. So `tsc` is not on PATH, the script exits 127, and the whole install
// fails. `npx` does not take that path, which is exactly why `npx github:...` worked while
// `npm i -g github:...` could never succeed, however many times it was retried.
//
// So: build when there is a compiler (a dev clone), and otherwise verify the prebuilt output that ships
// in the package and exit cleanly. A missing compiler is not an error. Missing OUTPUT is.
//
// The compiler is also invoked by absolute path rather than by name, so this does not rely on npm having
// put `node_modules/.bin` on PATH either.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => join(root, p);
const has = (p) => existsSync(at(p));

/** The files the CLI and the daemon cannot run without. */
const BUILT = ['server/dist/cli.js', 'server/dist/index.js', 'extension/dist/popup.js'];

const tsc = 'node_modules/typescript/bin/tsc';

if (has(tsc)) {
  const run = (args, cwd) => {
    const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  run([at(tsc), '-p', 'server/tsconfig.json'], root);
  run(['build.mjs'], at('extension'));
} else {
  const missing = BUILT.filter((f) => !has(f));
  if (missing.length) {
    console.error(
      `[tabzero] no compiler and no prebuilt output (missing ${missing.join(', ')}).\n` +
        '[tabzero] This package is incomplete — please report it.',
    );
    process.exit(1);
  }
  console.log('[tabzero] no devDependencies present; using the build that ships in the package.');
}

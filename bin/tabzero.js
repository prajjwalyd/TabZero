#!/usr/bin/env node
// Thin launcher — the real CLI is the compiled TypeScript. Relative import resolves against this
// file, so it works no matter what directory `tabzero` / `npx tabzero` is invoked from.
import '../server/dist/cli.js';

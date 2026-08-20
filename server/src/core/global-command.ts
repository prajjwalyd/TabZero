// Making `tabzero` a bare command: deciding whether to even try, and explaining npm when it refuses.
//
// Its own module for the same reason as extension/src/truncate.ts: this is pure, and reaching it inside
// cli.ts is impossible from a test — cli.ts dispatches on argv at the top level, so importing it runs
// the setup wizard.

/**
 * Explain why a global install failed.
 *
 * The wizard used to run npm with `stdio: 'ignore'` and then assert the failure "needs different
 * permissions" — a guess, and usually the wrong one. The common real cause is a leftover `npm link`
 * from a clone: npm cannot rename a symlink into place, fails ENOTDIR, and permissions are nowhere
 * involved. That message then offered the identical command as the remedy, which fails identically.
 *
 * `cmd` is the command that just failed, so a branch can hand it back as a *retry* after a real fix.
 */
export function explainGlobalFailure(output: string, cmd: string): { reason: string; fix: string[] } {
  // ENOTDIR on the global path means something that is not a directory already sits there — in practice
  // the symlink `npm link` leaves behind. Worth naming, because that link is also what `tabzero`
  // currently resolves to: the command appears to work while running a different copy of the code.
  if (/ENOTDIR|EEXIST/.test(output) && /node_modules[/\\]\.?tabzero/.test(output)) {
    return {
      reason:
        "a `tabzero` link from a local clone already occupies npm's global folder, and npm will" +
        ' not replace a link with an install.\nThat link is also what `tabzero` runs today.',
      fix: ['npm rm -g tabzero', cmd],
    };
  }
  if (/EACCES|EPERM/.test(output)) {
    return {
      reason: "npm's global folder is not writable by you.",
      fix: [`sudo ${cmd}`, '# or give npm a prefix you own: npm config set prefix ~/.npm-global'],
    };
  }
  // Anything else: quote npm instead of inventing a cause. npm prefixes every line — twice over when a
  // nested install is what failed — and the first lines are bookkeeping: the exit code, the command it
  // ran, the log path.
  const line = output
    .split('\n')
    .map((l) => l.replace(/^(npm (error|ERR!|warn|notice)\s*)+/i, '').trim())
    .find((l) => l && !/^(code \S+$|command |A complete log|using --force)/i.test(l));
  return {
    reason: line ? `npm reported: ${line}` : 'npm exited with an error.',
    fix: [cmd, '# full detail is in the npm log printed above'],
  };
}

export type GlobalPlan =
  | { action: 'install' }
  | { action: 'skip'; message: string; fix?: string[] };

/**
 * Decide whether a global install is worth attempting at all.
 *
 * `npm i -g` a git spec clones and builds: roughly forty seconds. Spending that only to fail is the
 * worst outcome the wizard had — the user answered yes, waited, and got an error. And there is one case
 * where the failure is knowable up front and instant to detect: something already holds npm's global
 * `tabzero` slot as a SYMLINK, left by `npm link` in a checkout. npm cannot rename a link out of the
 * way, so the install is doomed before it starts — while the command the user wanted already works.
 *
 * `link` is the symlink's resolved target, or null when the slot is empty or holds a real directory (npm
 * replaces those itself, so those go straight to install — including reinstalls and upgrades).
 */
export function planGlobalInstall(o: {
  link: string | null;
  pkgRoot: string;
  isRepo: boolean;
  spec: string;
}): GlobalPlan {
  const { link, pkgRoot, isRepo, spec } = o;
  if (!link) return { action: 'install' };
  // Linked to this very copy: the command already does exactly what was asked for.
  if (link === pkgRoot) {
    return { action: 'skip', message: '`tabzero` already runs this copy — nothing to install.' };
  }
  // From a checkout the command is `npm link`, which happily replaces an older link.
  if (isRepo) return { action: 'install' };
  // Linked elsewhere. `tabzero` works, but it is someone's dev checkout, not this install — say so
  // rather than silently leaving them on code they did not just fetch, and never clobber it for them.
  return {
    action: 'skip',
    message: `\`tabzero\` already works — it resolves to ${link}, linked there with \`npm link\`.`,
    fix: ['npm rm -g tabzero', `npm i -g ${spec}`],
  };
}

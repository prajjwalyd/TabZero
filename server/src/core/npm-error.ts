// Turning a failed `npm` run into the one command that will actually fix it.
//
// Its own module for the same reason as extension/src/truncate.ts: it is pure, and reaching it inside
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

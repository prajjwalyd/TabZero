// The name that scopes everything.
//
// `user_id` is the partition key for the whole product: every trail, every Engram memory, every
// interest. Left unset, db.ts mints `u_<uuid>` — correct, but unrecognisable in the Engram console and
// impossible to reproduce deliberately on a second machine. So setup asks, the same way it asks for the
// Engram key.
//
// Pure and separate so it is testable: cli.ts dispatches on argv at the top level, so importing it from
// a test would run the setup wizard.

/** Lowercase, starts alphanumeric, 2-64 chars of [a-z0-9._-]. Conservative on purpose: this value ends up
 *  in URLs and JSON bodies sent to Engram, and in a SQLite scope column. */
export const USER_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function isValidUserId(v: string): boolean {
  return USER_ID_RE.test(v);
}

/** What the user typed, in the canonical form we store. */
export function normalizeUserId(raw: string): string {
  return (raw || '').trim().toLowerCase();
}

/**
 * A default derived from the OS account, so the common case is one keystroke.
 *
 * Anything unusable collapses to 'me' rather than to an invalid id: a machine account like `_www`, a
 * Windows `DOMAIN\user`, or a name that is entirely punctuation would otherwise produce something the
 * validator rejects, and offering a default that fails validation is worse than offering none.
 */
export function suggestUserId(osUsername: string | undefined): string {
  const cleaned = (osUsername || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-') // spaces, backslashes, accents
    .replace(/^[^a-z0-9]+/, '') // must start alphanumeric
    .replace(/-+$/, '')
    .slice(0, 64);
  return isValidUserId(cleaned) ? cleaned : 'me';
}

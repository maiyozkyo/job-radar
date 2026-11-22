import { readFileSync } from 'node:fs';

// The real profile is not in this public repo: Actions writes it from the
// PROFILE_MD secret, a local clone keeps its own ignored copy. No fallback to
// the example, or a proposal could go out with made-up facts.
export function readProfile() {
  return readFileSync(process.env.PROFILE_FILE || new URL('../profile.md', import.meta.url), 'utf8');
}

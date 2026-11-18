// A message the user sends the bot that is not a Freelancer link: Claude
// either says it is a job post (scored as usual) or answers it as chat.
import { readFileSync } from 'node:fs';
import { defaultRunClaude } from './claude.js';

const JOB = '[[JOB]]';
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

export function chatPrompt(text) {
  // Function replacers: a `$&` in the user's text must stay as typed.
  return read('prompts/chat.md')
    .replace('{{PROFILE}}', () => read('profile.md'))
    .replace('{{MESSAGE}}', () => text);
}

/** @returns {Promise<{ job: true } | { reply: string }>} */
export async function chatOrJob(text, runClaude = defaultRunClaude) {
  const out = String(await runClaude(chatPrompt(text))).trim();
  if (out.startsWith(JOB)) return { job: true };
  if (!out) throw new Error('claude gave an empty chat reply');
  return { reply: out };
}

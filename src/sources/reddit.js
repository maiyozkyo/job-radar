import { makeJob } from '../job.js';

// Reddit blocks anonymous requests from GitHub's runners, so this source uses
// the official API with the user's own "script" app (application-only OAuth).
// Without REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET the source is not run at all.
const SUBREDDITS = ['forhire', 'freelance_forhire', 'jobbit'];
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const LISTING_URL = `https://oauth.reddit.com/r/${SUBREDDITS.join('+')}/new?limit=100&raw_json=1`;
// Reddit asks for "<platform>:<app id>:<version>"; a generic UA gets throttled.
const USER_AGENT = 'github-actions:job-radar:1.0 (github.com/maiyozkyo/job-radar)';

const HIRING = /\[\s*hiring\s*\]/i;
const FOR_HIRE = /\[\s*for\s*hire\s*\]/i;

/** True for a client's post ([Hiring] in the title or the flair), false for people offering work. */
export function isHiringPost(data) {
  const title = data?.title ?? '';
  if (FOR_HIRE.test(title)) return false;
  const flair = data?.link_flair_text ?? '';
  return HIRING.test(title) || (/hiring/i.test(flair) && !/for\s*hire/i.test(flair));
}

export function parseReddit(body) {
  return (body?.data?.children ?? [])
    .map((c) => c?.data)
    .filter((d) => d && d.id && d.title && !d.stickied && !d.removed_by_category && isHiringPost(d))
    .map((d) => makeJob({
      source: 'reddit',
      id: d.id,
      url: `https://www.reddit.com${d.permalink}`,
      title: d.title,
      description: d.selftext ?? '',
      budgetType: 'unknown',
      postedAt: Math.floor(d.created_utc ?? 0),
      tags: [`r/${d.subreddit}`],
    }));
}

async function token(env, fetchFn) {
  const basic = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20_000),
  });
  // Never echo the response: it may hold the token.
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.access_token) throw new Error('token missing in reply');
  return json.access_token;
}

export const hasRedditKeys = (env) => !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);

export async function fetchReddit(env, fetchFn = fetch) {
  const access = await token(env, fetchFn);
  const res = await fetchFn(LISTING_URL, {
    headers: { Authorization: `Bearer ${access}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseReddit(await res.json());
}

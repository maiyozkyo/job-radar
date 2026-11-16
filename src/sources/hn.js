import { makeJob } from '../job.js';
import { getJson, htmlToText } from './http.js';

// The monthly "Freelancer? Seeking freelancer?" thread is no longer posted by
// the whoishiring account, so find it through HN's Algolia search, then read
// its comments from the official Firebase API (Algolia's comment index lags).
const SEARCH = 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=20&query=' +
  encodeURIComponent('"Freelancer? Seeking freelancer?"');
const ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const MAX_AGE = 45 * 24 * 3600;
const MAX_COMMENTS = 200;

async function findThreadId(fetchFn, now) {
  const { hits = [] } = await getJson(SEARCH, fetchFn);
  const recent = hits.filter((h) =>
    /^Ask HN: Freelancer\? Seeking freelancer\?/i.test(h.title ?? '') && now - h.created_at_i < MAX_AGE);
  recent.sort((a, b) => b.created_at_i - a.created_at_i || b.num_comments - a.num_comments);
  // Newest month first; within it, the busiest copy (people sometimes repost).
  const month = recent[0]?.title;
  const best = recent.filter((h) => h.title === month).sort((a, b) => b.num_comments - a.num_comments)[0];
  if (!best) throw new Error('no recent freelancer thread');
  return best.objectID;
}

export async function fetchHn(fetchFn = fetch, now = Math.floor(Date.now() / 1000)) {
  const threadId = await findThreadId(fetchFn, now);
  const thread = await getJson(ITEM(threadId), fetchFn);
  const ids = (thread.kids ?? []).slice(0, MAX_COMMENTS);
  const items = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = await Promise.allSettled(ids.slice(i, i + 20).map((id) => getJson(ITEM(id), fetchFn)));
    for (const r of batch) if (r.status === 'fulfilled' && r.value) items.push(r.value);
  }
  return items
    .filter((c) => !c.deleted && !c.dead && c.text)
    .map((c) => ({ c, text: htmlToText(c.text) }))
    .filter(({ text }) => /^seeking freelancer/i.test(text))
    .map(({ c, text }) => makeJob({
      source: 'hn',
      id: c.id,
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      title: text.split('\n')[0].slice(0, 200),
      description: text,
      postedAt: c.time ?? 0,
    }));
}

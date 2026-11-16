const HEADERS = { 'User-Agent': 'job-radar (github.com/maiyozkyo/job-radar)' };

async function get(url, fetchFn) {
  const res = await fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export const getJson = async (url, fetchFn) => (await get(url, fetchFn)).json();
export const getText = async (url, fetchFn) => (await get(url, fetchFn)).text();

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Turns an HTML snippet into plain text with line breaks kept. */
export function htmlToText(html = '') {
  return String(html)
    .replace(/<(br|p|\/p|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\n{2,}/g, '\n')
    .trim();
}

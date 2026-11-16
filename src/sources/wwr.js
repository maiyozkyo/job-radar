import { XMLParser } from 'fast-xml-parser';
import { makeJob } from '../job.js';
import { getText, htmlToText } from './http.js';

const FEED = 'https://weworkremotely.com/categories/remote-programming-jobs.rss';

export function parseWwr(xml) {
  const doc = new XMLParser({ ignoreAttributes: true }).parse(xml);
  const items = [doc?.rss?.channel?.item ?? []].flat();
  return items.map((it) => {
    const id = String(it.guid?.['#text'] ?? it.guid ?? it.link);
    return makeJob({
      source: 'wwr',
      id,
      url: String(it.link ?? id),
      title: String(it.title ?? ''),
      description: htmlToText(it.description),
      budgetType: 'salary',
      location: it.region ? String(it.region) : null,
      postedAt: Math.floor(Date.parse(it.pubDate) / 1000) || 0,
      tags: [it.category].flat().filter(Boolean).map(String),
    });
  });
}

export async function fetchWwr(fetchFn = fetch) {
  return parseWwr(await getText(FEED, fetchFn));
}

import { XMLParser } from 'fast-xml-parser';
import { makeJob } from '../job.js';
import { getText, htmlToText } from './http.js';

// FreelancerViet's public RSS of freelance jobs (linked from viec-lam-freelance.html).
// Vietnamese clients, budgets in VND written in the text; about one job a day.
const FEED = 'https://freelancerviet.vn/feed/job-freelance';

const slug = (url) => url.match(/\/([^/]+?)(?:\.html)?$/)?.[1] ?? url;

export function parseFreelancerViet(xml) {
  const doc = new XMLParser({ ignoreAttributes: true }).parse(xml);
  const items = [doc?.rss?.channel?.item ?? []].flat();
  return items.map((it) => {
    const url = String(it.link ?? it.guid?.['#text'] ?? it.guid);
    return makeJob({
      source: 'freelancerviet',
      id: slug(url),
      url,
      title: String(it.title ?? '').normalize('NFC'),
      description: htmlToText(it['content:encoded'] || it.description).normalize('NFC'),
      location: 'Việt Nam',
      postedAt: Math.floor(Date.parse(it.pubDate) / 1000) || 0,
    });
  });
}

export async function fetchFreelancerViet(fetchFn = fetch) {
  return parseFreelancerViet(await getText(FEED, fetchFn));
}

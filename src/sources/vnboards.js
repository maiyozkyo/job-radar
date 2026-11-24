import { XMLParser } from 'fast-xml-parser';
import { makeJob } from '../job.js';
import { getText, htmlToText } from './http.js';

// Vietnamese job boards with a public RSS of new jobs. Clients write in
// Vietnamese and put budgets (VND) in the text. A few jobs a day each.
const FREELANCERVIET = 'https://freelancerviet.vn/feed/job-freelance'; // linked from viec-lam-freelance.html
const VLANCE = 'https://www.vlance.vn/rss.xml'; // the job pages sit behind Cloudflare; the feed does not

const guid = (it) => String(it.guid?.['#text'] ?? it.guid ?? '');

function parseRss(xml, source, idOf) {
  const doc = new XMLParser({ ignoreAttributes: true }).parse(xml);
  const items = [doc?.rss?.channel?.item ?? []].flat();
  return items.map((it) => {
    const url = String(it.link ?? guid(it));
    return makeJob({
      source,
      id: idOf(it, url),
      url,
      title: String(it.title ?? '').normalize('NFC'),
      description: htmlToText(it['content:encoded'] || it.description).normalize('NFC'),
      location: 'Việt Nam',
      postedAt: Math.floor(Date.parse(it.pubDate) / 1000) || 0,
    });
  });
}

const slug = (url) => url.match(/\/([^/]+?)(?:\.html)?$/)?.[1] ?? url;

export const parseFreelancerViet = (xml) => parseRss(xml, 'freelancerviet', (_, url) => slug(url));
export const parseVlance = (xml) => parseRss(xml, 'vlance', (it, url) => guid(it).match(/(\d+)$/)?.[1] ?? slug(url));

export const fetchFreelancerViet = async (fetchFn = fetch) => parseFreelancerViet(await getText(FREELANCERVIET, fetchFn));
export const fetchVlance = async (fetchFn = fetch) => parseVlance(await getText(VLANCE, fetchFn));

import { makeJob } from '../job.js';
import { getJson, htmlToText } from './http.js';

// Jobicy's API terms: credit Jobicy with a direct link to the listing, and poll
// at most once an hour (see RATE_LIMITS in index.js).
const API = 'https://jobicy.com/api/v2/remote-jobs?count=50';

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => htmlToText(String(x)));

export function parseJobicy(body) {
  return (body?.jobs ?? [])
    .filter((j) => j && j.id && j.jobTitle)
    .map((j) => makeJob({
      source: 'jobicy',
      id: j.id,
      url: j.url,
      title: `${j.companyName ? `${j.companyName}: ` : ''}${j.jobTitle}`,
      description: htmlToText(j.jobDescription || j.jobExcerpt),
      budgetType: 'salary',
      location: j.jobGeo || null,
      employmentType: list(j.jobType).join(', ') || null,
      postedAt: Math.floor(Date.parse(j.pubDate) / 1000) || 0,
      tags: list(j.jobIndustry),
    }));
}

export async function fetchJobicy(fetchFn = fetch) {
  return parseJobicy(await getJson(API, fetchFn));
}

import { makeJob } from '../job.js';
import { getJson, htmlToText } from './http.js';

// Remotive's API terms: link back to the Remotive job URL, name Remotive as the
// source, and call at most 4 times a day (see RATE_LIMITS in index.js).
// Alerts show "[remotive]" and the Remotive URL.
const API = 'https://remotive.com/api/remote-jobs';

export function parseRemotive(body) {
  return (body?.jobs ?? [])
    .filter((j) => j && j.id && j.title)
    .map((j) => makeJob({
      source: 'remotive',
      id: j.id,
      url: j.url,
      title: `${j.company_name ? `${j.company_name}: ` : ''}${j.title}`,
      description: htmlToText(j.description),
      budgetType: 'salary',
      location: j.candidate_required_location || null,
      employmentType: j.job_type || null,
      postedAt: Math.floor(Date.parse(`${j.publication_date}Z`) / 1000) || 0,
      tags: [j.category, ...(Array.isArray(j.tags) ? j.tags : [])].filter(Boolean).map(String),
    }));
}

export async function fetchRemotive(fetchFn = fetch) {
  return parseRemotive(await getJson(API, fetchFn));
}

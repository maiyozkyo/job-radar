import { makeJob } from '../job.js';
import { getJson, htmlToText } from './http.js';

// RemoteOK's API terms ask for a link back; alerts link to the RemoteOK job page.
const API = 'https://remoteok.com/api';

export function parseRemoteOk(body) {
  return (Array.isArray(body) ? body : [])
    .filter((j) => j && j.id && j.position)
    .map((j) => makeJob({
      source: 'remoteok',
      id: j.id,
      url: j.url,
      title: `${j.company ? `${j.company}: ` : ''}${j.position}`,
      description: htmlToText(j.description),
      budgetType: 'salary',
      budgetMinUsd: j.salary_min || null,
      budgetMaxUsd: j.salary_max || null,
      location: j.location || null,
      postedAt: j.epoch ?? 0,
      tags: j.tags ?? [],
    }));
}

export async function fetchRemoteOk(fetchFn = fetch) {
  return parseRemoteOk(await getJson(API, fetchFn));
}

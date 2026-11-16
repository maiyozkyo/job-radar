import { makeJob } from '../job.js';
import { getJson, htmlToText } from './http.js';

const API = 'https://himalayas.app/jobs/api?limit=50';

export function parseHimalayas(body) {
  return (body?.jobs ?? []).map((j) => {
    const usd = j.currency === 'USD';
    return makeJob({
      source: 'himalayas',
      id: j.guid,
      url: j.applicationLink || j.guid,
      title: `${j.companyName ? `${j.companyName}: ` : ''}${j.title}`,
      description: htmlToText(j.description || j.excerpt),
      budgetType: 'salary',
      budgetMinUsd: usd ? j.minSalary ?? null : null,
      budgetMaxUsd: usd ? j.maxSalary ?? null : null,
      location: j.locationRestrictions?.length ? j.locationRestrictions.join(', ') : null,
      employmentType: j.employmentType ?? null,
      postedAt: j.pubDate ?? 0,
      tags: j.categories ?? [],
    });
  });
}

export async function fetchHimalayas(fetchFn = fetch) {
  return parseHimalayas(await getJson(API, fetchFn));
}

import { makeJob } from '../job.js';

const API = 'https://www.freelancer.com/api/projects/0.1/projects/active/';

const toUsd = (amount, rate) =>
  amount == null || rate == null ? null : Math.round(amount * rate * 100) / 100;

/** @returns {import('../job.js').Job[]} */
export function parseFreelancer(body) {
  return (body?.result?.projects ?? []).map((p) => {
    const rate = p.currency?.exchange_rate ?? null;
    return makeJob({
      source: 'freelancer',
      id: p.id,
      url: `https://www.freelancer.com/projects/${p.seo_url}`,
      title: p.title ?? '',
      description: p.description ?? p.preview_description ?? '',
      budgetType: p.type === 'hourly' ? 'hourly' : 'fixed',
      budgetMinUsd: toUsd(p.budget?.minimum, rate),
      budgetMaxUsd: toUsd(p.budget?.maximum, rate),
      bidCount: p.bid_stats?.bid_count ?? null,
      postedAt: p.time_submitted ?? 0,
      tags: (p.jobs ?? []).map((j) => j.name),
    });
  });
}

/**
 * One request per query term; a failing query is skipped. Rejects only when
 * every query fails, so the run can report the source as down.
 * @param {import('../job.js').Config} config
 */
export async function fetchFreelancer(config, fetchFn = fetch) {
  const byId = new Map();
  let lastError = null;
  let okCount = 0;
  for (const q of config.freelancerQueries) {
    const url = `${API}?query=${encodeURIComponent(q)}&limit=30&full_description=true&job_details=true&sort_field=time_updated`;
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const job of parseFreelancer(await res.json())) byId.set(job.id, job);
      okCount++;
    } catch (err) {
      lastError = err;
      console.warn(`freelancer query "${q}" failed: ${err.message}`);
    }
  }
  if (okCount === 0 && lastError) throw lastError;
  return [...byId.values()];
}

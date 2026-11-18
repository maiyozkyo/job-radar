import { makeJob } from '../job.js';
import { getJson } from './http.js';

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
      // Bids are typed in the project's own currency, so keep it for non-USD jobs.
      currency: p.currency?.code && p.currency.code !== 'USD' && rate
        ? { code: p.currency.code, sign: p.currency.sign ?? p.currency.code, usdRate: rate, min: p.budget?.minimum ?? null, max: p.budget?.maximum ?? null }
        : null,
    });
  });
}

/**
 * One request per query term; a failing query is skipped. Rejects only when
 * every query fails, so the run can report the source as down.
 * The minute-by-minute Worker asks for fewer, shorter projects (`full: false`)
 * to stay inside its CPU limit.
 * @param {import('../job.js').Config} config
 */
export async function fetchFreelancer(config, fetchFn = fetch, { limit = 30, full = true } = {}) {
  const byId = new Map();
  let lastError = null;
  let okCount = 0;
  for (const q of config.freelancerQueries) {
    const url = `${API}?query=${encodeURIComponent(q)}&limit=${limit}&full_description=${full}&job_details=true&sort_field=time_updated`;
    try {
      for (const job of parseFreelancer(await getJson(url, fetchFn))) byId.set(job.id, job);
      okCount++;
    } catch (err) {
      lastError = err;
      console.warn(`freelancer query "${q}" failed: ${err.message}`);
    }
  }
  if (okCount === 0 && lastError) throw lastError;
  return [...byId.values()];
}

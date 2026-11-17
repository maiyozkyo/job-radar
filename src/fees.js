// Freelancer.com fees (freelancer.com/feesandcharges, checked 2026-11-16):
// fixed price 10% or $5, whichever is greater; hourly 10%.

const round2 = (n) => Math.round(n * 100) / 100;
const afterFees = (amount, budgetType) =>
  round2(budgetType === 'hourly' ? amount * 0.9 : amount - Math.max(amount * 0.1, 5));

/** @param {import('./job.js').Job} job @returns {number|null} */
export function netUsd(job) {
  if (job.source !== 'freelancer' || job.budgetMaxUsd == null) return null;
  return afterFees(job.budgetMaxUsd, job.budgetType);
}

/**
 * A bid for a Freelancer job from Claude's hours estimate: hours × rate (fixed)
 * or the rate (hourly), kept inside the client's range. `days` assumes evening
 * work at `hoursPerDay` plus one day of slack. `underpaid` means the work is
 * worth more than the client's maximum.
 * @param {{ rate: number, hoursPerDay: number }} opts
 */
export function suggestBid(job, hours, { rate, hoursPerDay }) {
  if (job.source !== 'freelancer' || job.budgetMaxUsd == null || !(hours > 0)) return null;
  const min = job.budgetMinUsd ?? 0;
  const max = job.budgetMaxUsd;
  const hourly = job.budgetType === 'hourly';
  const wantUsd = hourly ? rate : Math.round(hours * rate * 100) / 100;
  const target = hourly ? rate : Math.round(wantUsd / 5) * 5;
  const amountUsd = Math.min(Math.max(target, min), max);
  return {
    amountUsd,
    unit: hourly ? '/h' : '',
    hours,
    days: Math.ceil(hours / hoursPerDay) + 1,
    netUsd: afterFees(amountUsd, job.budgetType),
    wantUsd,
    underpaid: wantUsd > max,
  };
}

/**
 * Splits a fixed-price bid over Claude's milestone names: one milestone takes
 * the whole amount; two take about 40% / 60% in whole dollars, always adding
 * up to the bid. Hourly bids and missing names give [].
 * @param {ReturnType<typeof suggestBid>} bid
 * @param {string[]} names
 * @returns {{ name: string, amountUsd: number }[]}
 */
export function splitMilestones(bid, names) {
  if (!bid || bid.unit !== '' || !names?.length) return [];
  if (names.length === 1 || bid.amountUsd < 20) return [{ name: names[0], amountUsd: bid.amountUsd }];
  const first = Math.round(bid.amountUsd * 0.4);
  return [{ name: names[0], amountUsd: first }, { name: names[1], amountUsd: Math.round((bid.amountUsd - first) * 100) / 100 }];
}

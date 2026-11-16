// Freelancer.com fees (freelancer.com/feesandcharges, checked 2026-11-16):
// fixed price 10% or $5, whichever is greater; hourly 10%.

/** @param {import('./job.js').Job} job @returns {number|null} */
export function netUsd(job) {
  if (job.source !== 'freelancer' || job.budgetMaxUsd == null) return null;
  const max = job.budgetMaxUsd;
  const net = job.budgetType === 'hourly' ? max * 0.9 : max - Math.max(max * 0.1, 5);
  return Math.round(net * 100) / 100;
}

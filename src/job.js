import { readFileSync } from 'node:fs';

/**
 * One job, normalized from any source.
 * @typedef {object} Job
 * @property {string} key            "source:id"
 * @property {'freelancer'|'hn'|'wwr'|'remoteok'|'himalayas'|'remotive'|'jobicy'|'reddit'|'paste'} source
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {string} description
 * @property {'fixed'|'hourly'|'salary'|'unknown'} budgetType
 * @property {number|null} budgetMinUsd
 * @property {number|null} budgetMaxUsd
 * @property {number|null} bidCount
 * @property {string|null} location
 * @property {string|null} employmentType
 * @property {number} postedAt       unix seconds
 * @property {string[]} tags
 * @property {boolean} [escrow]      Freelancer Escrow.com project: bidding needs a linked Escrow.com account
 * @property {{ code: string, sign: string, usdRate: number, min: number|null, max: number|null }|null} [currency]
 *           Freelancer jobs not in USD: the project currency, USD per unit, and the budget in that currency
 */

/**
 * @typedef {object} Config
 * @property {string[]} freelancerQueries
 * @property {string[]} stackKeywords
 * @property {string[]} blockKeywords      matched in title and tags
 * @property {string[]} [titleBlockKeywords] matched in the title only
 * @property {number} minFixedUsd
 * @property {number} minHourlyUsd
 * @property {number} maxBidCount
 * @property {number} alertScore
 * @property {number} digestDraftScore
 * @property {string[]} allowedLocations
 * @property {number} [hourlyRateUsd]   bid suggestion rate
 * @property {number} [hoursPerDay]     evening hours, for delivery days
 * @property {number} [firstJobDiscount] bid multiplier until the first reviews (e.g. 0.75); 1 = off
 */

/** @returns {Config} */
export function loadConfig(path = new URL('../config.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** @param {Partial<Job> & Pick<Job, 'source'|'id'>} fields @returns {Job} */
export function makeJob(fields) {
  return {
    url: '', title: '', description: '', budgetType: 'unknown',
    budgetMinUsd: null, budgetMaxUsd: null, bidCount: null,
    location: null, employmentType: null, postedAt: 0, tags: [],
    ...fields,
    id: String(fields.id),
    key: `${fields.source}:${fields.id}`,
  };
}

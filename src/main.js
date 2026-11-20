import { pathToFileURL } from 'node:url';
import { loadConfig } from './job.js';
import { fetchAll } from './sources/index.js';
import { filterJob, isUrgent } from './filter.js';
import { appendLog, loadState, saveState, takeNew, prune } from './state.js';
import { scoreJobs } from './claude.js';
import { formatAlertHtml, formatDigest, formatUnscored, sendMessage } from './telegram.js';
import { fetchFreelancerStatus } from './sources/freelancer.js';
import { isQuiet } from './night.js';

const MAX_DIGEST = 10;
const MAX_DIGEST_SCORING = 40;
const MAX_PENDING = 200;
const MAX_NIGHT = 150;
const MAX_MORNING = 8;

const claudeWarning = (err) => `Claude lỗi: ${err.message.slice(0, 120)}, chưa chấm điểm`;
const newestFirst = (a, b) => b.postedAt - a.postedAt;
const bidOpts = (config) => ({ rate: config.hourlyRateUsd ?? 20, hoursPerDay: config.hoursPerDay ?? 2, discount: config.firstJobDiscount ?? 1 });

const stamp = (now) => new Date(now * 1000).toISOString().slice(0, 16) + 'Z';

/**
 * One line per scored job, so thresholds can be tuned from real scores: in the
 * Actions log and in `log` (saved to scores.log). Job titles and URLs are
 * public; proposals are never logged.
 */
function logScores(jobs, scored, log, now) {
  jobs.forEach((job, i) => {
    const s = scored[i];
    const line = `score ${s ? s.score : '-'} ${s?.hours != null ? `${s.hours}h` : '-'} ${job.key} | ${job.title.slice(0, 80)} | ${job.url}`;
    console.log(line);
    log.push(`${stamp(now)} ${line}`);
  });
}

/** Counts of why fresh jobs were dropped, most common first, e.g. "no stack keyword=12". */
function dropSummary(results) {
  const counts = {};
  for (const r of results) {
    if (r.keep) continue;
    const why = r.reason.split(':')[0];
    counts[why] = (counts[why] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(', ');
}

/** Scores urgent jobs: alerts at >= alertScore, and the ones Claude skipped or could not score. */
async function scoreUrgent(jobs, deps, log) {
  const { config, now } = deps;
  const alerts = [];
  let unscored = [];
  let warning = 'Claude bỏ sót, chưa chấm điểm';
  if (!jobs.length) return { alerts, unscored, warning };
  try {
    const scored = await deps.scoreJobs(jobs, { draftMin: config.alertScore, ...bidOpts(config) });
    logScores(jobs, scored, log, now);
    jobs.forEach((job, i) => {
      if (!scored[i]) unscored.push(job);
      else if (scored[i].score >= config.alertScore) alerts.push({ job, scored: scored[i] });
    });
  } catch (err) {
    unscored = jobs;
    warning = claudeWarning(err);
  }
  return { alerts, unscored, warning };
}

/**
 * The first poll after quiet hours: drops night jobs that closed or filled up
 * with bids, scores the rest and sends a header plus the best few, each with
 * its ✅ Bid button. Nothing is bid without the user's tap.
 */
async function morningBatch(state, deps, log) {
  const { config, now } = deps;
  const found = state.night.length;
  let jobs = state.night;
  let note = '';
  const ids = jobs.filter((j) => j.source === 'freelancer').map((j) => j.id);
  if (ids.length && deps.freelancerStatus) {
    try {
      const status = await deps.freelancerStatus(ids);
      jobs = jobs.flatMap((j) => {
        if (j.source !== 'freelancer') return [j];
        const st = status.get(String(j.id));
        return st?.open ? [{ ...j, bidCount: st.bidCount ?? j.bidCount }] : [];
      }).filter((j) => filterJob(j, config).keep);
    } catch {
      note = '\n⚠️ Không kiểm tra được job nào còn mở.';
    }
  }
  const { alerts, unscored, warning } = await scoreUrgent(jobs, deps, log);
  alerts.sort((a, b) => b.scored.score - a.scored.score);
  const top = alerts.slice(0, MAX_MORNING);
  const more = alerts.length > top.length ? ` (gửi ${top.length} job tốt nhất)` : '';
  log.push(`${stamp(now)} run morning night=${found} open=${jobs.length} alerts=${alerts.length} sent=${top.length}`);
  state.night = [];
  return [
    `🌙 Job đêm qua: ${found} job, ${jobs.length} còn mở, ${alerts.length} job ≥ ${config.alertScore}${more}.${note}`,
    ...top.map((a) => formatAlertHtml(a.job, a.scored, undefined, now)),
    ...(unscored.length ? [formatUnscored(unscored.slice(0, 15), warning)] : []),
  ];
}

async function poll(state, deps, log) {
  const { config, now } = deps;
  state.lastFetch ??= {};
  const { jobs, errors, okSources } = await deps.fetchAll(config, undefined, now, state.lastFetch);
  const { fresh, firstRun } = takeNew(state, jobs, now, okSources);
  if (firstRun) {
    await deps.sendMessage('✅ Job radar đã chạy lần đầu, bắt đầu theo dõi.');
    return 1;
  }

  const results = fresh.map((j) => filterJob(j, config));
  const kept = fresh.filter((_, i) => results[i].keep);
  const urgent = kept.filter(isUrgent);
  state.pending = [...state.pending, ...kept.filter((j) => !isUrgent(j))].sort(newestFirst).slice(0, MAX_PENDING);

  // Quiet hours: keep urgent jobs for the morning batch instead of alerting.
  const quiet = isQuiet(config, now);
  if (quiet) state.night = [...state.night, ...urgent].slice(-MAX_NIGHT);
  const morning = !quiet && state.night.length ? await morningBatch(state, deps, log) : [];
  const { alerts, unscored, warning: unscoredWarning } = await scoreUrgent(quiet ? [] : urgent, deps, log);

  const messages = [
    ...morning,
    ...alerts.map((a) => formatAlertHtml(a.job, a.scored, undefined, now)),
    ...(unscored.length ? [formatUnscored(unscored, unscoredWarning)] : []),
  ];
  if (messages.length && errors.length) messages[0] += `\n\n⚠️ Nguồn lỗi: ${errors.join('; ')}`;
  for (const text of messages) await deps.sendMessage(text);
  log.push(`${stamp(now)} run poll${quiet ? ' quiet' : ''} fresh=${fresh.length} kept=${kept.length} night=${state.night.length} scored=${quiet ? 0 : urgent.length - unscored.length} unscored=${unscored.length} alerts=${alerts.length} sent=${messages.length}`
    + `${errors.length ? ` errors=${errors.join('; ')}` : ''}${results.length > kept.length ? ` dropped: ${dropSummary(results)}` : ''}`);
  return messages.length;
}

async function digest(state, deps, log) {
  const { config, now } = deps;
  if (!state.pending.length) { log.push(`${stamp(now)} run digest pending=0 sent=0`); return 0; }
  const pending = [...state.pending].sort(newestFirst).slice(0, MAX_DIGEST_SCORING);

  let scored;
  try {
    scored = await deps.scoreJobs(pending, { draftMin: config.digestDraftScore, ...bidOpts(config) });
    logScores(pending, scored, log, now);
  } catch (err) {
    // Keep the queue: the next digest retries instead of dropping the jobs.
    await deps.sendMessage(`⚠️ ${claudeWarning(err)}. ${state.pending.length} job remote để lại cho lần tổng hợp sau.`);
    log.push(`${stamp(now)} run digest pending=${pending.length} claude error, kept for next digest`);
    return 1;
  }

  const items = pending
    .map((job, i) => ({ job, scored: scored[i] }))
    .filter((it) => it.scored && it.scored.score >= config.alertScore)
    .sort((a, b) => b.scored.score - a.scored.score);
  const text = formatDigest(items.slice(0, MAX_DIGEST));
  if (text) await deps.sendMessage(text);
  log.push(`${stamp(now)} run digest pending=${pending.length} alerts=${items.length} sent=${text ? 1 : 0}`);
  state.pending = [];
  return text ? 1 : 0;
}

/**
 * State is saved only after every message went out, so a Telegram outage
 * means the next run retries instead of losing jobs.
 * @param {'poll'|'digest'} mode
 */
export async function run(mode, deps) {
  const state = loadState(deps.stateDir);
  const log = [];
  const sent = mode === 'digest' ? await digest(state, deps, log) : await poll(state, deps, log);
  prune(state, deps.now);
  saveState(deps.stateDir, state);
  appendLog(deps.stateDir, log);
  return { sent };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2] === 'digest' ? 'digest' : 'poll';
  const env = process.env;
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!env[name]) { console.error(`missing ${name}`); process.exit(1); }
  }
  run(mode, {
    stateDir: 'state',
    config: loadConfig(),
    env,
    now: Math.floor(Date.now() / 1000),
    fetchAll,
    scoreJobs,
    freelancerStatus: (ids) => fetchFreelancerStatus(ids),
    sendMessage: (message) => sendMessage(message, env),
  }).then(
    ({ sent }) => console.log(`${mode}: sent ${sent} message(s)`),
    (err) => { console.error(`${mode} failed: ${err.message}`); process.exit(1); },
  );
}

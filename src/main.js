import { pathToFileURL } from 'node:url';
import { loadConfig } from './job.js';
import { fetchAll } from './sources/index.js';
import { filterJob, isUrgent } from './filter.js';
import { loadState, saveState, takeNew, prune } from './state.js';
import { scoreJobs } from './claude.js';
import { formatAlertHtml, formatDigest, formatUnscored, sendMessage } from './telegram.js';

const MAX_DIGEST = 10;
const MAX_DIGEST_SCORING = 40;
const MAX_PENDING = 200;

const claudeWarning = (err) => `Claude lỗi: ${err.message.slice(0, 120)}, chưa chấm điểm`;
const newestFirst = (a, b) => b.postedAt - a.postedAt;
const bidOpts = (config) => ({ rate: config.hourlyRateUsd ?? 20, hoursPerDay: config.hoursPerDay ?? 2, discount: config.firstJobDiscount ?? 1 });

/**
 * One line per scored job in the Actions log, so thresholds can be tuned from
 * real scores. Job titles and URLs are public; proposals are never logged.
 */
function logScores(jobs, scored) {
  jobs.forEach((job, i) => {
    const s = scored[i];
    console.log(`score ${s ? s.score : '-'} ${s?.hours != null ? `${s.hours}h` : '-'} ${job.key} | ${job.title.slice(0, 80)} | ${job.url}`);
  });
}

async function poll(state, deps) {
  const { config, now } = deps;
  state.lastFetch ??= {};
  const { jobs, errors, okSources } = await deps.fetchAll(config, undefined, now, state.lastFetch);
  const { fresh, firstRun } = takeNew(state, jobs, now, okSources);
  if (firstRun) {
    await deps.sendMessage('✅ Job radar đã chạy lần đầu, bắt đầu theo dõi.');
    return 1;
  }

  const kept = fresh.filter((j) => filterJob(j, config).keep);
  const urgent = kept.filter(isUrgent);
  state.pending = [...state.pending, ...kept.filter((j) => !isUrgent(j))].sort(newestFirst).slice(0, MAX_PENDING);

  let alerts = [];
  let unscored = [];
  let unscoredWarning = 'Claude bỏ sót, chưa chấm điểm';
  try {
    const scored = await deps.scoreJobs(urgent, { draftMin: config.alertScore, ...bidOpts(config) });
    logScores(urgent, scored);
    urgent.forEach((job, i) => {
      if (!scored[i]) unscored.push(job);
      else if (scored[i].score >= config.alertScore) alerts.push({ job, scored: scored[i] });
    });
  } catch (err) {
    unscored = urgent;
    unscoredWarning = claudeWarning(err);
  }

  const messages = [
    ...alerts.map((a) => formatAlertHtml(a.job, a.scored, undefined, now)),
    ...(unscored.length ? [formatUnscored(unscored, unscoredWarning)] : []),
  ];
  if (messages.length && errors.length) messages[0] += `\n\n⚠️ Nguồn lỗi: ${errors.join('; ')}`;
  for (const text of messages) await deps.sendMessage(text);
  return messages.length;
}

async function digest(state, deps) {
  const { config } = deps;
  if (!state.pending.length) return 0;
  const pending = [...state.pending].sort(newestFirst).slice(0, MAX_DIGEST_SCORING);

  let scored;
  try {
    scored = await deps.scoreJobs(pending, { draftMin: config.digestDraftScore, ...bidOpts(config) });
    logScores(pending, scored);
  } catch (err) {
    // Keep the queue: the next digest retries instead of dropping the jobs.
    await deps.sendMessage(`⚠️ ${claudeWarning(err)}. ${state.pending.length} job remote để lại cho lần tổng hợp sau.`);
    return 1;
  }

  const items = pending
    .map((job, i) => ({ job, scored: scored[i] }))
    .filter((it) => it.scored && it.scored.score >= config.alertScore)
    .sort((a, b) => b.scored.score - a.scored.score);
  const text = formatDigest(items.slice(0, MAX_DIGEST));
  if (text) await deps.sendMessage(text);
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
  const sent = mode === 'digest' ? await digest(state, deps) : await poll(state, deps);
  prune(state, deps.now);
  saveState(deps.stateDir, state);
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
    sendMessage: (message) => sendMessage(message, env),
  }).then(
    ({ sent }) => console.log(`${mode}: sent ${sent} message(s)`),
    (err) => { console.error(`${mode} failed: ${err.message}`); process.exit(1); },
  );
}

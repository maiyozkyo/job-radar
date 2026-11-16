import { pathToFileURL } from 'node:url';
import { loadConfig } from './job.js';
import { fetchAll } from './sources/index.js';
import { filterJob, isUrgent } from './filter.js';
import { loadState, saveState, takeNew, prune } from './state.js';
import { scoreJobs } from './claude.js';
import { formatAlert, formatDigest, sendMessage } from './telegram.js';

const MAX_DIGEST = 10;
const MAX_DIGEST_SCORING = 40;

async function poll(state, deps) {
  const { config, now } = deps;
  const { jobs, errors } = await deps.fetchAll(config);
  const { fresh, firstRun } = takeNew(state, jobs, now);
  if (firstRun) {
    await deps.sendMessage('✅ Job radar đã chạy lần đầu, bắt đầu theo dõi.');
    return 1;
  }

  const kept = fresh.filter((j) => filterJob(j, config).keep);
  const urgent = kept.filter(isUrgent);
  state.pending.push(...kept.filter((j) => !isUrgent(j)));

  let alerts;
  try {
    const scored = await deps.scoreJobs(urgent, { draftMin: config.alertScore });
    alerts = urgent
      .map((job, i) => ({ job, scored: scored[i], warning: null }))
      .filter((a) => a.scored.score >= config.alertScore);
  } catch (err) {
    const warning = `Claude lỗi: ${err.message.slice(0, 120)}, chưa chấm điểm`;
    alerts = urgent.map((job) => ({ job, scored: null, warning }));
  }

  const sourceWarning = errors.length ? `Nguồn lỗi: ${errors.join('; ')}` : null;
  for (const [i, a] of alerts.entries()) {
    const warning = [a.warning, i === 0 ? sourceWarning : null].filter(Boolean).join('\n⚠️ ');
    await deps.sendMessage(formatAlert(a.job, a.scored, warning || undefined));
  }
  return alerts.length;
}

async function digest(state, deps) {
  const { config } = deps;
  if (!state.pending.length) return 0;
  const pending = [...state.pending].sort((a, b) => b.postedAt - a.postedAt).slice(0, MAX_DIGEST_SCORING);

  let items;
  let warning;
  try {
    const scored = await deps.scoreJobs(pending, { draftMin: config.digestDraftScore });
    items = pending
      .map((job, i) => ({ job, scored: scored[i] }))
      .filter((it) => it.scored.score >= config.alertScore)
      .sort((a, b) => b.scored.score - a.scored.score);
  } catch (err) {
    items = pending.map((job) => ({ job, scored: null }));
    warning = `Claude lỗi: ${err.message.slice(0, 120)}, chưa chấm điểm`;
  }

  const text = formatDigest(items.slice(0, MAX_DIGEST), warning);
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
    sendMessage: (text) => sendMessage(text, env),
  }).then(
    ({ sent }) => console.log(`${mode}: sent ${sent} message(s)`),
    (err) => { console.error(`${mode} failed: ${err.message}`); process.exit(1); },
  );
}

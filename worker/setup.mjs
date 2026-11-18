// One-time setup for the Worker, run on your own machine from the repo root:
//   node worker/setup.mjs              everything: KV, secrets, deploy, Telegram webhook, Freelancer token
//   node worker/setup.mjs freelancer   only the Freelancer token (e.g. after the app is approved)
//   node worker/setup.mjs paste        deploy, then turn on "paste a job to the bot" (new webhook + PASTE_TOKEN)
// Secrets are typed in hidden and go straight to `wrangler secret put`; nothing is written to disk.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const DIR = new URL('.', import.meta.url);
const TOML = new URL('wrangler.toml', DIR);
const REDIRECT_URI = 'https://localhost/callback';
// Freelancer advanced scopes, numbered as on the "Create New Application" form:
// 2 = manage projects, bids and milestones; 6 = view user and profile information.
const ADVANCED_SCOPES = '2 6';

export const kvIdFrom = (out) => out.match(/id\s*=\s*"([0-9a-f]{32})"/)?.[1] ?? out.match(/"id":\s*"([0-9a-f]{32})"/)?.[1] ?? null;
// Deploy output can also list a per-version preview URL (<hash>-job-radar.…),
// which Telegram may not resolve yet; the webhook needs the main one.
export const workerUrlFrom = (out, name = 'job-radar') =>
  out.match(new RegExp(`https://${name}\\.[\\w-]+\\.workers\\.dev`))?.[0] ?? null;

export function authorizeUrl(clientId, scopes = ADVANCED_SCOPES) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI,
    scope: 'basic', prompt: 'select_account consent', advanced_scopes: scopes,
  });
  return `https://accounts.freelancer.com/oauth/authorize?${q}`;
}

/** The code from the URL the browser lands on (the page itself fails to load, that is fine), or a bare code. */
export function codeFrom(pasted) {
  const s = pasted.trim();
  try { return new URL(s).searchParams.get('code'); } catch { return s || null; }
}

/** Latest private chat with the bot, from getUpdates (works only before the webhook is set). */
export function chatIdFrom(updates) {
  const chats = (updates?.result ?? []).map((u) => u.message?.chat).filter((c) => c?.type === 'private');
  return chats.length ? String(chats.at(-1).id) : null;
}

// --- terminal helpers ---

const rl = () => createInterface({ input: process.stdin, output: process.stdout, terminal: true });

/** Keys typed or pasted while reading a hidden value; exported for tests. */
export function applyKeys(value, chunk) {
  let v = value;
  for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
    if (ch === '\r' || ch === '\n') return { value: v, done: true };
    if (ch === '\u0003') return { value: v, cancel: true };
    if (ch === '\u007f' || ch === '\b') v = v.slice(0, -1);
    else if (ch >= ' ') v += ch;
  }
  return { value: v, done: false };
}

/**
 * Hidden input reads raw keys and echoes nothing; readline would redraw the
 * line (prompt + text) and show the secret.
 */
function askHidden(question) {
  const { stdin, stdout } = process;
  stdout.write(question);
  if (!stdin.isTTY) {
    return new Promise((resolve) => { const r = createInterface({ input: stdin }); r.once('line', (l) => { r.close(); stdout.write('\n'); resolve(l.trim()); }); });
  }
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk) => {
      const r = applyKeys(value, chunk);
      value = r.value;
      if (!r.done && !r.cancel) return;
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      if (r.cancel) { stdout.write('\n'); process.exit(130); }
      stdout.write('\n');
      resolve(value.trim());
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
});

/** Reads the clipboard, then empties it so the secret does not linger. */
async function takeClipboard() {
  if (process.platform === 'win32') {
    const text = await run('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']);
    await run('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value " "']).catch(() => {});
    return text.trim();
  }
  if (process.platform === 'darwin') {
    const text = await run('pbpaste', []);
    await new Promise((r) => { const c = spawn('pbcopy'); c.on('close', r); c.stdin.end(''); });
    return text.trim();
  }
  return '';
}

/** Shows only the start and length, enough to spot a wrong token type. */
export const masked = (s) => `${s.slice(0, 6)}… (${s.length} ký tự)`;

/**
 * Secrets: copy the value and press Enter (read from the clipboard, never
 * shown), or type it blind. Pasting shows it on some Windows terminals.
 */
async function askSecret(question) {
  const typed = await askHidden(`${question}\n   → copy giá trị rồi CHỈ bấm Enter (đừng dán): `);
  const value = typed || await takeClipboard().catch(() => '');
  if (!value) throw new Error('không có giá trị (clipboard trống)');
  console.log(`   nhận: ${masked(value)}`);
  return value;
}

function ask(question, { hidden = false } = {}) {
  if (hidden) return askSecret(question);
  return new Promise((resolve) => {
    const r = rl();
    r.question(question, (answer) => { r.close(); resolve(answer.trim()); });
  });
}

/** Runs wrangler in worker/; `input` goes to stdin (how secrets are passed). */
function wrangler(args, { input, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'wrangler@4', ...args], {
      cwd: DIR, shell: process.platform === 'win32', stdio: [input == null ? 'inherit' : 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; if (!quiet) process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args[0]} exited ${code}`))));
    if (input != null) child.stdin.end(input);
  });
}

const putSecret = async (name, value) => {
  await wrangler(['secret', 'put', name], { input: value, quiet: true });
  console.log(`  ✓ ${name}`);
};

const openBrowser = (url) => {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${url}"`]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd[0], cmd[1], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
};

// --- steps ---

async function ensureLogin() {
  const who = await wrangler(['whoami'], { quiet: true }).catch(() => '');
  if (/not authenticated|You are not/i.test(who) || !who) {
    console.log('\n1) Đăng nhập Cloudflare (trình duyệt sẽ mở):');
    await wrangler(['login']);
  } else console.log('\n1) Đã đăng nhập Cloudflare.');
}

async function ensureKv() {
  const toml = readFileSync(TOML, 'utf8');
  if (!toml.includes('REPLACE_WITH_KV_ID')) return console.log('2) KV đã có.');
  console.log('2) Tạo KV RADAR_KV…');
  const id = kvIdFrom(await wrangler(['kv', 'namespace', 'create', 'RADAR_KV'], { quiet: true, input: '' }));
  if (!id) throw new Error('không đọc được id của KV, chạy tay: npx wrangler kv namespace create RADAR_KV');
  writeFileSync(TOML, toml.replace('REPLACE_WITH_KV_ID', id));
  console.log(`  ✓ KV ${id} (đã ghi vào wrangler.toml)`);
}

async function telegramChatId(botToken) {
  let chatId = await ask('   TELEGRAM_CHAT_ID (Enter để tự tìm): ');
  if (chatId) return chatId;
  await ask('   Nhắn một tin bất kỳ cho bot job-radar trên Telegram, rồi bấm Enter… ');
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
  chatId = chatIdFrom(await res.json().catch(() => ({})));
  if (!chatId) throw new Error('không tìm thấy chat; nhắn bot rồi chạy lại, hoặc nhập TELEGRAM_CHAT_ID tay');
  console.log(`   chat id: ${chatId}`);
  return chatId;
}

async function freelancerToken() {
  console.log('\n• Token Freelancer (bỏ trống Client ID để làm sau: node worker/setup.mjs freelancer)');
  const clientId = await ask('   Client ID: ');
  if (!clientId) return console.log('   Bỏ qua. Nút ✅ chưa bid được cho tới khi có token.');
  const clientSecret = await ask('   Client Secret (ẩn): ', { hidden: true });
  const url = authorizeUrl(clientId);
  console.log(`   Mở trang cấp quyền… nếu không tự mở, dán link này vào trình duyệt:\n   ${url}`);
  openBrowser(url);
  console.log('   Bấm Allow. Trình duyệt sẽ chuyển tới https://localhost/callback?code=… (trang báo lỗi là bình thường).');
  const code = codeFrom(await ask('   Địa chỉ trên thanh URL (localhost/callback?code=…):', { hidden: true }));
  if (!code) throw new Error('không thấy code trong địa chỉ đã dán');

  const res = await fetch('https://accounts.freelancer.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Freelancer không cấp token: HTTP ${res.status} ${body.error_description ?? body.error ?? ''}`.trim());

  // Check the token can read the account before storing it.
  const self = await fetch('https://www.freelancer.com/api/users/0.1/self/', { headers: { 'freelancer-oauth-v1': body.access_token } });
  const user = (await self.json().catch(() => ({})))?.result;
  if (!self.ok || !user?.id) throw new Error(`token không đọc được tài khoản (HTTP ${self.status}); kiểm tra scope "View your user and profile information"`);
  console.log(`   Token của tài khoản: ${user.username ?? user.id}. Scope: ${body.scope ?? '?'}. Hết hạn sau: ${body.expires_in ? `${Math.round(body.expires_in / 86400)} ngày` : 'không ghi'}.`);

  await putSecret('FREELANCER_TOKEN', body.access_token);
  if (body.refresh_token) await putSecret('FREELANCER_REFRESH_TOKEN', body.refresh_token);
}

async function deploy() {
  const url = workerUrlFrom(await wrangler(['deploy']));
  if (!url) throw new Error('không đọc được URL của Worker từ kết quả deploy');
  return url;
}

/** Sets a GitHub Actions secret through gh, value on stdin. */
const ghSecret = (name, value) => new Promise((resolve, reject) => {
  const child = spawn('gh', ['secret', 'set', name, '-R', 'maiyozkyo/job-radar'], { shell: process.platform === 'win32', stdio: ['pipe', 'ignore', 'inherit'] });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? (console.log(`  ✓ GitHub secret ${name}`), resolve()) : reject(new Error(`gh secret set ${name} exited ${code} (cần: gh auth login)`))));
  child.stdin.end(value);
});

/**
 * Webhook for button taps and messages, with a new secret, and a new
 * PASTE_TOKEN shared by the Worker and Actions (pasted jobs are read with it).
 */
async function connectTelegram(botToken, url) {
  const webhookSecret = randomBytes(24).toString('hex');
  const pasteToken = randomBytes(24).toString('hex');
  await putSecret('TG_WEBHOOK_SECRET', webhookSecret);
  await putSecret('PASTE_TOKEN', pasteToken);
  await ghSecret('PASTE_TOKEN', pasteToken);
  const hook = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${url}/telegram`, secret_token: webhookSecret, allowed_updates: ['callback_query', 'message'] }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!hook.ok) throw new Error(`setWebhook lỗi: ${hook.description ?? 'không rõ'}`);
  console.log(`  ✓ webhook ${url}/telegram (nút bấm + tin nhắn)`);
}

async function paste() {
  console.log('Deploy Worker…');
  const url = await deploy();
  console.log('\nBật dán job vào bot:');
  const botToken = await ask('   TELEGRAM_BOT_TOKEN của bot job-radar: ', { hidden: true });
  await connectTelegram(botToken, url);
  console.log('\nXong. Gửi cho bot nội dung job hoặc link Freelancer để thử.');
}

async function full() {
  await ensureLogin();
  await ensureKv();

  console.log('\n3) Secret (gõ ẩn):');
  const botToken = await ask('   TELEGRAM_BOT_TOKEN của bot job-radar (@BotFather → /mybots → API Token): ', { hidden: true });
  const chatId = await telegramChatId(botToken);
  const ghToken = await ask('   GH_DISPATCH_TOKEN (fine-grained, chỉ job-radar, Actions: Read and write): ', { hidden: true });

  console.log('\n4) Deploy Worker…');
  const url = await deploy();
  await putSecret('TELEGRAM_BOT_TOKEN', botToken);
  await putSecret('TELEGRAM_CHAT_ID', chatId);
  await putSecret('GH_DISPATCH_TOKEN', ghToken);

  console.log('\n5) Nối Telegram với Worker…');
  await connectTelegram(botToken, url);

  await freelancerToken();
  console.log('\nXong. Worker quét Freelancer mỗi phút; nút ✅ bid khi có FREELANCER_TOKEN.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const steps = { freelancer: freelancerToken, paste };
  (steps[process.argv[2]] ?? full)()
    .catch((err) => { console.error(`\n✗ ${err.message}`); process.exit(1); });
}

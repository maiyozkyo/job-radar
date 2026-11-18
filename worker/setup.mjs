// One-time setup for the Worker, run on your own machine from the repo root:
//   node worker/setup.mjs              everything: KV, secrets, deploy, Telegram webhook, Freelancer token
//   node worker/setup.mjs freelancer   only the Freelancer token (e.g. after the app is approved)
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
export const workerUrlFrom = (out) => out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0] ?? null;

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

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const r = rl();
    if (hidden) r._writeToOutput = (s) => { if (s.includes(question)) r.output.write(s); };
    r.question(question, (answer) => { r.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
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
  const code = codeFrom(await ask('   Dán cả địa chỉ trên thanh URL vào đây: ', { hidden: true }));
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

async function full() {
  await ensureLogin();
  await ensureKv();

  console.log('\n3) Secret (gõ ẩn):');
  const botToken = await ask('   TELEGRAM_BOT_TOKEN của bot job-radar (@BotFather → /mybots → API Token): ', { hidden: true });
  const chatId = await telegramChatId(botToken);
  const ghToken = await ask('   GH_DISPATCH_TOKEN (fine-grained, chỉ job-radar, Actions: Read and write): ', { hidden: true });
  const webhookSecret = randomBytes(24).toString('hex');

  console.log('\n4) Deploy Worker…');
  const url = workerUrlFrom(await wrangler(['deploy']));
  if (!url) throw new Error('không đọc được URL của Worker từ kết quả deploy');

  await putSecret('TELEGRAM_BOT_TOKEN', botToken);
  await putSecret('TELEGRAM_CHAT_ID', chatId);
  await putSecret('GH_DISPATCH_TOKEN', ghToken);
  await putSecret('TG_WEBHOOK_SECRET', webhookSecret);

  console.log('\n5) Nối nút bấm Telegram với Worker…');
  const hook = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${url}/telegram`, secret_token: webhookSecret, allowed_updates: ['callback_query'] }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!hook.ok) throw new Error(`setWebhook lỗi: ${hook.description ?? 'không rõ'}`);
  console.log(`  ✓ ${url}/telegram`);

  await freelancerToken();
  console.log('\nXong. Worker quét Freelancer mỗi phút; nút ✅ bid khi có FREELANCER_TOKEN.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  (process.argv[2] === 'freelancer' ? freelancerToken() : full())
    .catch((err) => { console.error(`\n✗ ${err.message}`); process.exit(1); });
}

// Scans a repo a client sent WITHOUT running anything in it: no npm install,
// no opening in VS Code. Looks for what fake "test task" repos use to run
// malware. A clean result does not prove the repo is safe.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{ level: 'high'|'medium', label: string, file: string, line: number|null }} Finding */

// Build output and caches: noisy, and the scripts that would run them are still checked.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'bower_components', '.angular', '.next', '.nuxt', '.cache', 'coverage', 'bin', 'obj', '.vs', '.worktrees']);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.py', '.sh', '.ps1', '.bat', '.cmd', '.vbs', '.html', '.yml', '.yaml', '.toml', '.cs', '.php', '.rb', '']);
const BINARY_EXT = new Set(['.exe', '.dll', '.node', '.so', '.dylib', '.scr', '.msi', '.jar', '.bin']);
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare'];
const MAX_FILE = 2_000_000;

const DOWNLOAD_RUN = /(curl|wget)[^|\n]*\|\s*(ba|z)?sh|(iwr|invoke-webrequest|irm|invoke-restmethod)[^|\n]*\|\s*iex|powershell[^\n]*-enc|certutil[^\n]*-urlcache/i;

const LINE_RULES = [
  { level: 'high', label: 'Code bị làm rối (kiểu _0x…)', re: /_0x[0-9a-f]{4,}/i },
  { level: 'high', label: 'eval/Function chạy chuỗi giải mã (atob/base64/hex)', re: /(eval|Function)\s*\(\s*(atob|Buffer\.from|unescape|decodeURIComponent|String\.fromCharCode)/ },
  { level: 'high', label: 'Lệnh tải và chạy code từ mạng', re: DOWNLOAD_RUN },
  { level: 'high', label: 'Đọc dữ liệu ví, mật khẩu trình duyệt hoặc SSH key', re: /Login Data|Local State|Local Extension Settings|nkbihfbeogaeaoehlefnkodbefgpgknn|exodus.wallet|\.ssh[\\/]|id_rsa|id_ed25519|keychain-db|solana[\\/]id\.json/i },
  { level: 'high', label: 'Gọi tới địa chỉ IP trần (hay là máy chủ mã độc)', re: /https?:\/\/(?!0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}(\.\d{1,3}){3}/ },
  { level: 'medium', label: 'Chuỗi base64 rất lớn trong code', re: /["'`][A-Za-z0-9+/]{600,}={0,2}["'`]/ },
  { level: 'medium', label: 'Chạy lệnh hệ thống (child_process)', re: /require\(\s*["']child_process["']\)|from\s+["'](node:)?child_process["']/ },
];

function* walk(dir, root = dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(full, root); }
    else yield { full, rel: relative(root, full).split('\\').join('/'), size: st.size };
  }
}

function checkPackageJson(text, file, out) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return; }
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (INSTALL_SCRIPTS.includes(name)) out.push({ level: 'high', label: `Script "${name}" tự chạy khi npm install: ${String(cmd).slice(0, 80)}`, file, line: null });
    if (DOWNLOAD_RUN.test(cmd) || /node\s+-e|base64/.test(cmd)) out.push({ level: 'high', label: `Script "${name}" tải và chạy code: ${String(cmd).slice(0, 80)}`, file, line: null });
  }
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [dep, spec] of Object.entries(pkg[group] ?? {})) {
      if (/^(git\+|git:|github:|https?:|file:)|\.tgz$/.test(String(spec))) {
        out.push({ level: 'medium', label: `Thư viện "${dep}" lấy từ nguồn ngoài npm: ${spec}`, file, line: null });
      }
    }
  }
}

/** @returns {Finding[]} */
export function scanRepo(dir) {
  const out = [];
  for (const { full, rel, size } of walk(dir)) {
    const ext = extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) { out.push({ level: 'medium', label: `File chạy được/nhị phân (${ext})`, file: rel, line: null }); continue; }
    if (rel.startsWith('.husky/')) out.push({ level: 'medium', label: 'Git hook (husky) sẽ chạy khi commit', file: rel, line: null });
    if (!TEXT_EXT.has(ext) || size > MAX_FILE) continue;
    const text = readFileSync(full, 'utf8');

    if (basename(rel) === 'package.json') checkPackageJson(text, rel, out);
    if (rel === '.vscode/tasks.json' && /"runOn"\s*:\s*"folderOpen"/.test(text)) {
      out.push({ level: 'high', label: 'VS Code task tự chạy khi mở thư mục (runOn: folderOpen)', file: rel, line: null });
    }
    if (rel === '.vscode/settings.json' && /allowAutomaticTasks"\s*:\s*"on"/.test(text)) {
      out.push({ level: 'high', label: 'VS Code bật tự chạy task khi mở thư mục', file: rel, line: null });
    }

    if (LOCKFILES.has(basename(rel))) continue;
    let longReported = false;
    text.split('\n').forEach((line, i) => {
      for (const r of LINE_RULES) if (r.re.test(line)) out.push({ level: r.level, label: r.label, file: rel, line: i + 1 });
      if (!longReported && line.length > 2000 && /\.(m?js|cjs|ts)$/.test(rel)) {
        out.push({ level: 'medium', label: 'Có dòng rất dài (có thể là code bị nén/làm rối)', file: rel, line: i + 1 });
        longReported = true;
      }
    });
  }
  return out;
}

function report(dir) {
  const findings = scanRepo(dir);
  const order = { high: 0, medium: 1 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`${f.level === 'high' ? '🔴 NGUY HIỂM' : '🟠 Đáng ngờ '}  ${where}  ${f.label}`);
  }
  const high = findings.filter((f) => f.level === 'high').length;
  console.log(findings.length
    ? `\n${high} nguy hiểm, ${findings.length - high} đáng ngờ. ${high ? 'KHÔNG chạy repo này.' : 'Đọc kỹ các chỗ trên trước khi chạy.'}`
    : '\nKhông thấy dấu hiệu quen thuộc. Vẫn chỉ chạy trong VM hoặc Codespaces, không chạy trên máy chính.');
  return high ? 2 : findings.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (!dir) { console.error('Cách dùng: npm run check-repo -- <thư mục repo>'); process.exit(64); }
  process.exit(report(dir));
}

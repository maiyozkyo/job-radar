// Scam patterns seen in fake job offers. "block" rules are never legitimate
// (remote access, secrets, fees) and the job is dropped. "warn" rules can be
// legitimate, so the job is kept with a red flag. The main one is the fake
// interview: a "test task" repo whose npm scripts or .vscode/tasks.json run
// malware that steals wallets, browser passwords and SSH keys.
const RULES = [
  {
    level: 'block',
    label: 'Đòi cài phần mềm truy cập từ xa',
    re: /anydesk|teamviewer|ultraviewer|remote desktop access/,
  },
  {
    level: 'block',
    label: 'Đòi seed phrase, private key, mật khẩu hoặc mã xác minh',
    re: /seed phrase|recovery phrase|private key|verification code|otp code|share (your |the )?(account|login|password)/,
  },
  {
    level: 'block',
    label: 'Đòi đóng phí hoặc mua bộ kit',
    re: /(registration|joining|training|application|security) fee|pay (a |an )?(small )?(fee|deposit)|buy (our|the) (starter )?(kit|course|package)/,
  },
  {
    level: 'warn',
    label: 'Bắt tải repo/chạy code về máy (kiểu "bài test" cài mã độc)',
    re: /github\.com|gitlab\.com|bitbucket|\bclone\b|download (the |our )?(repo|project|code|files?)|run (it |the (project|code|app) )?locally|\b(npm|yarn|pnpm) (i|install)\b|pip install|open (the |our )?(project|folder) in vs ?code/,
  },
  {
    level: 'warn',
    label: 'Có link/file tải về (link rút gọn, Drive/Dropbox/Mega, .zip/.exe...)',
    re: /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|cutt\.ly|rb\.gy)\/|drive\.google\.com|dropbox\.com|mega\.nz|wetransfer\.com|mediafire\.com|\.(zip|rar|7z|exe|msi|scr|lnk|iso|dmg|bat|cmd|ps1|vbs|jar|apk)\b/,
  },
  {
    level: 'warn',
    label: 'Kéo sang Telegram/WhatsApp/Discord',
    re: /t\.me\/|wa\.me\/|discord\.gg\/|(contact|message|text|reach|dm|add|ping)( me| us)? (on|via|at) (telegram|whatsapp|discord|skype|signal|wechat)/,
  },
  {
    level: 'warn',
    label: 'Dính crypto/ví (hay gặp lừa đảo)',
    re: /\b(crypto|web3|defi|nft|wallet|metamask|binance|blockchain|presale|airdrop)\b/,
  },
];

/**
 * @param {import('./job.js').Job} job
 * @returns {{ level: 'block'|'warn', label: string }[]}
 */
export function riskFlags(job) {
  const text = `${job.title}\n${job.description}`.toLowerCase();
  return RULES.filter((r) => r.re.test(text)).map(({ level, label }) => ({ level, label }));
}

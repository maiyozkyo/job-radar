# job-radar

Finds freelance and remote jobs that fit my stack, has Claude score them and draft a proposal, and sends them to my Telegram.

**It never applies, bids or messages anyone.** I read each alert and decide myself.

## How it works

Every 30 minutes (at :07 and :37), GitHub Actions:

1. Reads public job sources: Freelancer.com API, the HN "Freelancer? Seeking freelancer?" thread, We Work Remotely RSS, [RemoteOK](https://remoteok.com) API and Himalayas API. No logged-in access to any platform.
2. Drops jobs already seen and filters by stack, budget (Freelancer: ≥ $30 fixed, ≥ $15/h), bid count and location (`config.json`).
3. **Freelancer.com and HN** (clients decide within hours): Claude scores each kept job from 1 to 10 and drafts a proposal; jobs scoring ≥ 7 are sent at once.
4. **Remote job boards**: queued and sent as a digest at 08:15 and 19:15 (GMT+7).

The first run only records the current jobs and sends one start message.

State (seen job ids, queued jobs) is committed to the `state` branch. Scores and proposals are only sent to Telegram, never committed.

## Safety

- Posts asking for remote access (AnyDesk, TeamViewer), seed phrases, private keys, verification codes or fees are dropped.
- Posts that ask to download a repo or run code (the fake "test task" that installs malware), move to Telegram/WhatsApp/Discord, involve crypto, or carry shortened links or `.zip`/`.exe` files are sent with a 🚩 warning.
- Links, emails and phone numbers that are not mine are removed from drafted proposals.
- Claude runs with no tools; job text is treated as data.

Before opening a repo a client sends, scan it without running anything:

```
npm run check-repo -- path/to/their-repo
```

It looks for install-time npm scripts, VS Code tasks that run on folder open, obfuscated code, download-and-run commands, code reading wallets, browser passwords or SSH keys, and calls to raw IP addresses. A clean result does not prove the repo is safe: open client code only in a VM or GitHub Codespaces, never on your main machine.

## Tuning

Edit `config.json`: search terms, stack and block keywords, budget floors, bid limit, score thresholds, allowed locations. `profile.md` is what Claude may cite in proposals; `prompts/score.md` is the scoring prompt.

## Setup

Actions secrets:

| Secret | From |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `TELEGRAM_CHAT_ID` | `https://api.telegram.org/bot<token>/getUpdates` after messaging the bot |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` |

Manual run: `gh workflow run radar.yml -f mode=poll` (or `mode=digest`).

Tests: `npm test`.

# job-radar

Finds freelance and remote jobs that fit my stack, has Claude score them and draft a proposal, and sends them to my Telegram.

**It never applies, bids or messages anyone.** I read each alert and decide myself.

## How it works

Every 30 minutes (at :07 and :37), GitHub Actions:

1. Reads public job sources: Freelancer.com API, the HN "Freelancer? Seeking freelancer?" thread, We Work Remotely RSS, [RemoteOK](https://remoteok.com) API, Himalayas API, [Remotive](https://remotive.com) API (at most every 6 hours, per its terms) and [Jobicy](https://jobicy.com) API (at most every 2 hours; its terms say no more than hourly). Alerts name the source and link to its listing, as Remotive and Jobicy require. Reddit `[Hiring]` posts in r/forhire, r/freelance_forhire and r/jobbit are read through the official API with app-only OAuth, only when the Reddit secrets are set; Reddit blocks anonymous requests from GitHub's runners. No logged-in access to any platform.
   Beyond the code stack, it also looks for work an AI assistant can do with the freelancer reviewing it: English ↔ Vietnamese translation, Excel/Google Sheets, data cleaning and extraction, web scraping, technical writing (see `profile.md` "Other work").
   Each alert for a Freelancer job also suggests a bid: Claude estimates the hours, the bot multiplies by `hourlyRateUsd` (config), keeps it inside the client's range, shows the net after fees and the delivery days at `hoursPerDay` evening hours, and warns when the budget is below what the work is worth. Until the first reviews, `firstJobDiscount` (0.75) bids 25% below the rate and the alert shows the full price; set it to 1 after 3–5 reviews. Freelancer alerts also show the bid count and the post's age, flagging fresh posts with ≤ 5 bids (bid early) and posts with > 15 bids (save the bid). Every scored job is logged as `score <n> <hours> <key> | <title> | <url>` in the Actions log (no proposals) to tune thresholds.
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
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` (optional) | reddit.com/prefs/apps → create app → type "script", redirect URI `http://localhost`. The id is under the app name. Without them Reddit is skipped. |

Manual run: `gh workflow run radar.yml -f mode=poll` (or `mode=digest`). Check Claude and the token without sending anything: `mode=selftest`. Full alert (score, bid, milestones, proposal) for one Freelancer job, whatever its score: `gh workflow run radar.yml -f mode=job -f job=<project link>`.

Tests: `npm test`.

## Backup trigger (if GitHub's schedule stops firing)

GitHub's `schedule` can be delayed for hours or skipped, especially on new repos. An external cron can start the same workflow through the API instead:

1. Create a **fine-grained personal access token**: GitHub → Settings → Developer settings → Fine-grained tokens. Repository access: only `job-radar`. Permissions: **Actions: Read and write** (nothing else). Expiry: up to 1 year. Worst case if it leaks: someone can start or re-enable this workflow.
2. On https://cron-job.org (free), create two jobs:

| Job | Schedule (Asia/Ho_Chi_Minh) | Body |
|---|---|---|
| radar poll | every 30 minutes | `{"ref":"main","inputs":{"mode":"poll"}}` |
| radar digest | 08:15 and 19:15 | `{"ref":"main","inputs":{"mode":"digest"}}` |

Both jobs:
- URL: `https://api.github.com/repos/maiyozkyo/job-radar/actions/workflows/radar.yml/dispatches`
- Method: `POST`
- Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
- Success is HTTP 204.

The `radar` concurrency group stops runs from overlapping, so GitHub's own schedule and the backup can both stay on.

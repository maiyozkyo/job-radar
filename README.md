# job-radar

Finds freelance and remote jobs that fit my stack, has Claude score them and draft a proposal, and sends them to my Telegram.

**It never applies, bids or messages anyone on its own.** I read each alert and decide myself. A Freelancer alert can carry a ✅ button: the bid goes out only when I tap it (see [One-tap bid](#one-tap-bid)).

## How it works

On each run (every 15 minutes from cron-job.org, and within about a minute of a new matching Freelancer project via the [Worker](#one-tap-bid)), GitHub Actions:

1. Reads public job sources: Freelancer.com API, the HN "Freelancer? Seeking freelancer?" thread, We Work Remotely RSS, [RemoteOK](https://remoteok.com) API, Himalayas API, [Remotive](https://remotive.com) API (at most every 6 hours, per its terms) and [Jobicy](https://jobicy.com) API (at most every 2 hours; its terms say no more than hourly). Alerts name the source and link to its listing, as Remotive and Jobicy require. Reddit `[Hiring]` posts in r/forhire, r/freelance_forhire and r/jobbit are read through the official API with app-only OAuth, only when the Reddit secrets are set; Reddit blocks anonymous requests from GitHub's runners. No logged-in access to any platform.
   Beyond the code stack, it also looks for work an AI assistant can do with the freelancer reviewing it: English ↔ Vietnamese translation, Excel/Google Sheets, data cleaning and extraction, web scraping, technical writing (see `profile.md` "Other work").
   Each alert for a Freelancer job also suggests a bid: Claude estimates the hours, the bot multiplies by `hourlyRateUsd` (config), keeps it inside the client's range, shows the net after fees and the delivery days at `hoursPerDay` evening hours, and warns when the budget is below what the work is worth. Until the first reviews, `firstJobDiscount` (0.75) bids 25% below the rate and the alert shows the full price; set it to 1 after 3–5 reviews. Freelancer alerts also show the bid count and the post's age, flagging fresh posts with ≤ 5 bids (bid early) and posts with > 15 bids (save the bid). Every scored job is logged as `score <n> <hours> <key> | <title> | <url>` in the Actions log (no proposals) to tune thresholds. The same lines, plus one summary per run (fresh, kept, scored, alerts, sent, and why jobs were dropped), are appended to `scores.log` on the `state` branch (newest 20,000 lines), so a week of scores is one small file: `git fetch origin state && git show FETCH_HEAD:scores.log`.
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

## One-tap bid

`worker/` is a Cloudflare Worker (free plan) that does two things:

1. **Every minute** it checks Freelancer (10 newest per search term, short descriptions) and, when a new project passes the filters, starts `radar.yml` at once. New Freelancer jobs reach Telegram in about 1–1.5 minutes instead of up to 15.
2. **Telegram webhook.** A Freelancer alert with a drafted proposal and a bid suggestion gets two more buttons above the copy buttons: **✅ Bid** and **❌ Bỏ**. Tapping ✅ places exactly the suggested bid (amount in the project's currency, delivery days, first milestone as the upfront %) through the official Freelancer API, with the proposal from the message. The buttons are swapped out before the bid goes out, so a double tap cannot bid twice. Only taps from `TELEGRAM_CHAT_ID` count. To change the price or text, open the job and bid by hand.

Setup, once: run `node worker/setup.mjs` from the repo root. It logs in to Cloudflare, creates the KV namespace, asks for each secret (hidden input, nothing saved to disk), deploys, sets the Telegram webhook and gets the Freelancer token through OAuth (app redirect URI: `https://localhost/callback`; scopes: manage bids, view profile). After the Freelancer app is approved, `node worker/setup.mjs freelancer` redoes only the token.

The same by hand (from `worker/`):

```
npx wrangler login
npx wrangler kv namespace create RADAR_KV        # put the id in wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN       # same as the Actions secret
npx wrangler secret put TELEGRAM_CHAT_ID         # same as the Actions secret
npx wrangler secret put TG_WEBHOOK_SECRET        # any long random string (A-Z, a-z, 0-9, _ -)
npx wrangler secret put FREELANCER_TOKEN         # Freelancer OAuth token that may place bids
npx wrangler secret put GH_DISPATCH_TOKEN        # the fine-grained token from "Backup trigger" below
npx wrangler deploy
```

Then point the bot's button taps at the Worker (once):

```
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook"   -d url=https://job-radar.<your-subdomain>.workers.dev/telegram   -d secret_token=<TG_WEBHOOK_SECRET>   -d 'allowed_updates=["callback_query"]'
```

After that, `getUpdates` no longer works for this bot (Telegram allows a webhook or polling, not both), so do not share this bot with anything that polls.

Freelancer token: create an app at https://accounts.freelancer.com/settings/develop and generate a token for your own account with the scope that allows bidding. It can bid as you: keep it only in the Worker secret.

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

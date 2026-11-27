// Bid log for the owner's private dashboard. Each bid placed from Telegram is
// recorded in KV; GET /bids.json (Bearer BIDS_READ_KEY) returns that log merged
// with the live state from the Freelancer API. Read-only, nothing is bid here.
import { fetchBidRecords } from './mybids.js';

const PREFIX = 'bidlog:';

/** Stores one record for a placed bid. Never throws: a log failure must not hide a bid that went out. */
export async function logBid(kv, { bidId, projectId, title, url, amount, period }, now = new Date()) {
  if (!bidId) return false;
  try {
    const rec = { bidId, projectId, title: String(title ?? '').slice(0, 200), url: url ?? null, amount, period, placedAt: now.toISOString() };
    await kv.put(`${PREFIX}${bidId}`, JSON.stringify(rec));
    return true;
  } catch {
    console.warn('bid log write failed');
    return false;
  }
}

async function readLog(kv) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor });
    for (const { name } of page.keys) {
      try {
        const v = JSON.parse(await kv.get(name));
        if (v?.bidId) out.push(v);
      } catch { /* skip a bad record */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Live API bids (current title and state) plus logged bids the API list no longer shows. Newest first. */
export function mergeBids(live, logged) {
  const byId = new Map();
  for (const l of logged) byId.set(String(l.bidId), { ...l, currency: null, status: 'sent' });
  for (const a of live) {
    const prev = byId.get(String(a.bidId));
    byId.set(String(a.bidId), { ...prev, ...a, placedAt: a.placedAt ?? prev?.placedAt ?? null });
  }
  return [...byId.values()].sort((a, b) => String(b.placedAt ?? '').localeCompare(String(a.placedAt ?? '')));
}

/** Constant-time check of "Authorization: Bearer <key>"; no key configured means nobody gets in. */
export function authorized(request, key) {
  if (!key) return false;
  const enc = new TextEncoder();
  const a = enc.encode(String(request.headers.get('Authorization') ?? ''));
  const b = enc.encode(`Bearer ${key}`);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

/** GET /bids.json handler. */
export async function bidsJson(request, env, fetchFn = fetch) {
  if (!authorized(request, env.BIDS_READ_KEY)) return new Response('unauthorized', { status: 401 });
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const logged = await readLog(env.RADAR_KV);
  try {
    const live = await fetchBidRecords(env.FREELANCER_TOKEN, fetchFn);
    return new Response(JSON.stringify({ bids: mergeBids(live, logged) }), { headers });
  } catch (err) {
    // Keep serving the KV log; the error text never holds the token.
    return new Response(JSON.stringify({ bids: mergeBids([], logged), liveError: String(err.message).slice(0, 200) }), { headers });
  }
}

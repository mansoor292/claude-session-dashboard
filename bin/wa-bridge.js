#!/usr/bin/env node
/**
 * wa-bridge — one WhatsApp account, one Claude session.
 *
 * Baileys speaks WhatsApp's multi-device protocol directly; this wraps it in a tiny HTTP
 * API that wa-threads drives, the same shape bc-threads uses for Basecamp: the bridge owns
 * the connection, the CLI owns routing, delivery and transcripts.
 *
 * LISTENS ON A UNIX SOCKET, never a TCP port. Binding 127.0.0.1 is NOT enough here: Caddy
 * runs on this box and publishes every local port to the public internet at
 * https://p<port>.dev.catalogshub.com with no auth. Proved on 2026-09-19 — the first cut of
 * this bridge answered /status over that URL from outside. A socket file under ~/.claude,
 * mode 600, has no port for the proxy to find and is reachable only by this user.
 *
 * PRIVACY: linking an account exposes EVERY chat on it — family, personal, other clients.
 * Only chats explicitly tracked in ~/.claude/wa-threads.json are written to disk; everything
 * else stays in a small in-memory ring so `wa-threads chats` can still offer it for tracking.
 */
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        fetchLatestBaileysVersion, jidNormalizedUser } = baileys;

const HOME = homedir();
const AUTH  = join(HOME, '.claude', 'wa-auth');
const STORE = join(HOME, '.claude', 'wa-store');
const REG   = join(HOME, '.claude', 'wa-threads.json');
const SOCK  = process.env.WA_SOCK || join(HOME, '.claude', 'wa-bridge.sock');
const RING  = 300;                       // untracked chats: memory only, newest N

mkdirSync(STORE, { recursive: true });
const log = pino({ level: process.env.WA_LOG || 'warn' });

let sock = null, qr = null, qrAscii = null, me = null, connected = false, lastErr = null;
const recent = [];                       // {jid,name,ts,fromMe,text} — newest message per chat
const chatList = new Map();              // jid -> {jid,name,ts,unread}  the REAL chat list
const contacts = new Map();              // jid -> best known display name
const seenTypes = process.env.WA_TRACE === '1';   // log every upsert while diagnosing

const tracked = () => {
  try { return JSON.parse(readFileSync(REG, 'utf8')).chats || {}; } catch { return {}; }
};
const safeJid = (j) => String(j || '').replace(/[^A-Za-z0-9._@-]/g, '_');
const textOf = (m) => m.message?.conversation
  || m.message?.extendedTextMessage?.text
  || m.message?.imageMessage?.caption
  || m.message?.videoMessage?.caption
  || (m.message?.audioMessage ? '[voice note]' : '')
  || (m.message?.documentMessage ? `[document: ${m.message.documentMessage.fileName || '?'}]` : '')
  || (m.message?.imageMessage ? '[image]' : '')
  || '';

function record(m) {
  const jid = jidNormalizedUser(m.key.remoteJid || '');
  const row = {
    id: m.key.id, jid, fromMe: !!m.key.fromMe,
    from: m.pushName || (m.key.fromMe ? 'me' : jid.split('@')[0]),
    ts: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000),
    text: textOf(m),
  };
  if (!row.text) {
    if (seenTypes) console.log('dropped (no text) from %s keys=%s', jid,
                               Object.keys(m.message || {}).join(','));
    return;                                                // reactions, receipts, protocol noise
  }
  if (seenTypes) console.log('recorded %s from %s (%d chars)', row.id, row.jid, row.text.length);
  recent.unshift(row); if (recent.length > RING) recent.pop();
  // Disk is for tracked chats only — see PRIVACY above.
  if (tracked()[jid]) {
    const f = join(STORE, safeJid(jid) + '.ndjson');
    const isNew = !existsSync(f);
    appendFileSync(f, JSON.stringify(row) + '\n');
    if (isNew) chmodSync(f, 0o600);      // conversation content: owner-only, not just dir-protected
  }
}

const nameFor = (jid) => contacts.get(jid)
  || chatList.get(jid)?.name
  || String(jid || '').split('@')[0];

function mergeChats(list = [], why = '') {
  for (const c of list) {
    const jid = jidNormalizedUser(c.id || c.jid || '');
    if (!jid) continue;
    const prev = chatList.get(jid) || {};
    chatList.set(jid, {
      jid,
      name: c.name || c.subject || prev.name || contacts.get(jid) || '',
      ts: Number(c.conversationTimestamp || c.t || prev.ts || 0),
      unread: Number(c.unreadCount ?? prev.unread ?? 0),
    });
  }
  if (list.length) console.log('chat list %s: +%d (total %d)', why, list.length, chatList.size);
}

function mergeContacts(list = []) {
  for (const c of list) {
    const jid = jidNormalizedUser(c.id || c.jid || '');
    const n = c.name || c.notify || c.verifiedName;
    if (jid && n) contacts.set(jid, n);
  }
}


function oldestKnown(jid) {
  const f = join(STORE, safeJid(jid) + '.ndjson');
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[0]); } catch { return null; }
}


async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: log, printQRInTerminal: false,
                        markOnlineOnConnect: false,     // stay invisible; do not steal presence
                        syncFullHistory: true });       // capture the chat list at the NEXT pairing
  sock.ev.on('creds.update', saveCreds);
  // The chat LIST is what a person needs to choose what to track, and it only arrives via
  // app-state sync — not from watching live messages. Building `chats` out of the message
  // ring meant it showed only whoever happened to text you since the bridge booted, which is
  // useless for picking a chat. This is metadata (jid, name, last-activity) and stays in
  // memory; message CONTENT is still only ever written for chats explicitly tracked.
  sock.ev.on('messaging-history.set', ({ chats, contacts: cts, messages, isLatest, syncType }) => {
    mergeContacts(cts || []);
    mergeChats(chats || [], isLatest ? 'history(final)' : 'history');
    // An on-demand history request (below) returns its messages HERE, not via messages.upsert.
    // Without this the fetch would appear to succeed and produce nothing.
    let n = 0;
    for (const m of (messages || [])) { try { record(m); n++; } catch {} }
    if (n) console.log('history batch: %d message(s) syncType=%s', n, syncType);
  });
  sock.ev.on('chats.upsert', (c) => mergeChats(c, 'upsert'));
  sock.ev.on('chats.update', (c) => mergeChats(c, 'update'));
  sock.ev.on('contacts.upsert', (c) => mergeContacts(c));
  sock.ev.on('contacts.update', (c) => mergeContacts(c));
  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      qr = u.qr;
      // Render once and keep the art, so `wa-threads link` can print it at the prompt where
      // the person actually is. Sending them to journalctl for a code that rotates every
      // ~20s is a bad way to ask someone to scan something.
      qrcode.generate(u.qr, { small: true }, (art) => { qrAscii = art; console.log(art); });
    }
    if (u.connection === 'open') {
      connected = true; qr = null; qrAscii = null; lastErr = null;
      me = jidNormalizedUser(sock.user?.id || '');
      console.log('connected as', me);
    }
    if (u.connection === 'close') {
      connected = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      lastErr = String(u.lastDisconnect?.error?.message || code || 'closed').slice(0, 200);
      // loggedOut means the phone unlinked us: reconnecting would spin forever on dead creds.
      if (code === DisconnectReason.loggedOut) { console.error('logged out — re-run `wa-threads link`'); return; }
      setTimeout(start, 3000);
    }
  });
  // 'notify' is someone messaging you; 'append' is your OWN message arriving from another
  // device (your phone). Taking only 'notify' made the bridge look dead when the obvious way
  // to test it — send yourself something — produced nothing at all. 'set' is the history
  // replay on connect and stays excluded: linking should not dump the whole backlog.
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (seenTypes) console.log('upsert type=%s count=%d', type, messages.length);
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      try { record(m); } catch (e) { console.error('record failed:', e.message); }
    }
  });
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (u.pathname === '/status')
      return json(res, 200, { connected, me, qr: qr ? true : false, lastErr, sock: SOCK });
    if (u.pathname === '/qr')  return json(res, 200, { qr, ascii: qrAscii, connected });
    if (u.pathname === '/groups' || (u.pathname === '/chats' && u.searchParams.get('groups') === '1')) {
      // groupFetchAllParticipating is a live query and always works, unlike the 1:1 chat list
      // which WhatsApp only pushes during app-state sync at pairing. 247 groups came back the
      // first time this was tried, so "there is no list" was never the whole truth.
      if (!connected) return json(res, 503, []);
      const g = await sock.groupFetchAllParticipating();
      const out = Object.entries(g || {}).map(([jid, m]) => ({
        jid, name: m.subject || jid, ts: Number(m.creation || 0),
        unread: 0, text: `group · ${(m.participants || []).length} participants`,
      }));
      if (u.pathname === '/groups') return json(res, 200, out.sort((a, b) => a.name.localeCompare(b.name)));
      for (const c of out) if (!chatList.has(c.jid)) chatList.set(c.jid, c);
    }
    if (u.pathname === '/chats') {
      const out = new Map();
      for (const c of chatList.values())
        out.set(c.jid, { jid: c.jid, name: nameFor(c.jid), ts: c.ts, unread: c.unread, text: '' });
      // anything seen live but not yet in the synced list still deserves to be listed
      for (const r of recent) if (!out.has(r.jid))
        out.set(r.jid, { jid: r.jid, name: nameFor(r.jid) || r.from, ts: r.ts, unread: 0, text: r.text });
      for (const r of recent) { const e = out.get(r.jid); if (e && !e.text) e.text = r.text; }
      return json(res, 200, [...out.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    }
    if (u.pathname === '/history' && req.method === 'POST') {
      // WhatsApp lets a linked device ask the PHONE for older messages in one chat, but only
      // relative to a message it already has: the request pages backwards from an anchor key.
      // With no anchor there is nothing to page from, so a chat we have never seen a message
      // in cannot be back-filled — someone has to post first. The phone must also be online;
      // it is the peer that answers, not WhatsApp's servers.
      let body = ''; for await (const c of req) body += c;
      const { chat, count = 50, anchor } = JSON.parse(body || '{}');
      if (!connected) return json(res, 503, { ok: false, err: 'not connected' });
      if (!chat) return json(res, 400, { ok: false, err: 'chat required' });
      const a = anchor || oldestKnown(chat);
      if (!a) return json(res, 409, { ok: false, err: 'no anchor message for this chat yet — '
        + 'the phone can only page back from a message we already hold. Wait for one post here, '
        + 'then retry.' });
      if (typeof sock.fetchMessageHistory !== 'function')
        return json(res, 501, { ok: false, err: 'this baileys build has no fetchMessageHistory' });
      // oldestMsgTimestampMs — MILLISECONDS. We store unix seconds, and passing those asked
      // the phone for messages older than 1970, which it answered by sending nothing at all.
      const rid = await sock.fetchMessageHistory(Number(count),
        { id: a.id, remoteJid: chat, fromMe: !!a.fromMe }, a.ts * 1000);
      return json(res, 200, { ok: true, requestId: rid, anchor: a.id, note:
        'requested — results arrive asynchronously and only while your phone is online' });
    }
    if (u.pathname === '/send' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const { chat, text } = JSON.parse(body || '{}');
      if (!connected) return json(res, 503, { ok: false, err: 'not connected' });
      if (!chat || !text) return json(res, 400, { ok: false, err: 'chat and text required' });
      const sent = await sock.sendMessage(chat, { text });
      return json(res, 200, { ok: true, id: sent?.key?.id || null });
    }
    return json(res, 404, { ok: false, err: 'no such endpoint' });
  } catch (e) { return json(res, 500, { ok: false, err: String(e.message).slice(0, 200) }); }
});

try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {}
server.listen(SOCK, () => { chmodSync(SOCK, 0o600); console.log('wa-bridge on', SOCK); });
process.on('SIGTERM', () => { try { unlinkSync(SOCK); } catch {} process.exit(0); });

start().catch((e) => { console.error('start failed:', e.message); process.exit(1); });

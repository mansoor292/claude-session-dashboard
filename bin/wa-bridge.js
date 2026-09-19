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
const recent = [];                       // {jid,name,ts,fromMe,text} — for `chats`, not persisted
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

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: log, printQRInTerminal: false,
                        markOnlineOnConnect: false });   // stay invisible; do not steal presence
  sock.ev.on('creds.update', saveCreds);
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
    if (u.pathname === '/chats') {
      const seen = new Map();
      for (const r of recent) if (!seen.has(r.jid)) seen.set(r.jid, r);
      return json(res, 200, [...seen.values()].sort((a, b) => b.ts - a.ts));
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

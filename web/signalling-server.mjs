import { createServer } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

export const UNUSED_ROOM_MS = 10 * 60 * 1000;
const NEGOTIATION_MS = 2 * 60 * 1000;
const BODY_LIMIT = 32768;

function reply(response, status, value) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!(request.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Expected JSON.'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Setup message too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function validSignal(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const signal = JSON.parse(gunzipSync(Buffer.from(value, 'base64url'), { maxOutputLength: 65536 }).toString('utf8'));
    return signal?.v === 4 && typeof signal.sdp === 'string' && signal.sdp.startsWith('v=0') && signal.sdp.length <= 60000;
  } catch { return false; }
}

function authorized(request, token) {
  const supplied = (request.headers.authorization || '').replace(/^Bearer /, '');
  if (!token || supplied.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

export function createSignallingServer({ now = Date.now, maxRooms = 500, createLimit = 12, joinLimit = 40, webRoot = null } = {}) {
  const rooms = new Map();
  const attempts = new Map();
  const remove = (code, message = 'Game setup closed.') => {
    const room = rooms.get(code);
    if (!room) return;
    room.waiter?.(410, { error: message });
    rooms.delete(code);
  };
  const sweep = () => {
    for (const [code, room] of rooms) if (now() >= room.expiresAt) remove(code, 'Game code expired.');
    for (const [key, limit] of attempts) if (now() >= limit.until) attempts.delete(key);
  };
  const allowed = (request, kind, maximum) => {
    const key = `${request.socket.remoteAddress}:${kind}`;
    let limit = attempts.get(key);
    if (!limit || now() >= limit.until) { limit = { count: 0, until: now() + 60000 }; attempts.set(key, limit); }
    return ++limit.count <= maximum;
  };
  const server = createServer(async (request, response) => {
    try {
      sweep();
      if (request.headers.origin) {
        let host;
        try { host = new URL(request.headers.origin).host; } catch {}
        if (host !== request.headers.host) { reply(response, 403, { error: 'Cross-origin setup is not allowed.' }); return; }
      }
      const url = new URL(request.url, 'http://signalling');
      if (webRoot && !url.pathname.startsWith('/signal/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') { reply(response, 405, { error: 'Invalid static request.' }); return; }
        const root = resolve(webRoot);
        let file = resolve(root, '.' + decodeURIComponent(url.pathname));
        if (file !== root && !file.startsWith(root + sep)) { reply(response, 403, { error: 'Invalid file path.' }); return; }
        try {
          let metadata = await stat(file);
          if (metadata.isDirectory()) { file = resolve(file, 'index.html'); metadata = await stat(file); }
          if (!metadata.isFile()) throw new Error('Not a file.');
          const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.mp4': 'video/mp4' };
          response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': metadata.size, 'Cache-Control': 'no-store' });
          if (request.method === 'HEAD') response.end();
          else createReadStream(file).on('error', () => response.destroy()).pipe(response);
        } catch { reply(response, 404, { error: 'File not found.' }); }
        return;
      }
      if (url.pathname === '/signal/health' && request.method === 'GET') { reply(response, 200, { ok: true }); return; }
      if (url.pathname === '/signal/rooms' && request.method === 'POST') {
        if (!allowed(request, 'create', createLimit)) { reply(response, 429, { error: 'Too many game codes. Try again shortly.' }); return; }
        if (rooms.size >= maxRooms) { reply(response, 503, { error: 'Game setup is busy. Try again shortly.' }); return; }
        const input = await body(request);
        if (!validSignal(input.offer)) { reply(response, 400, { error: 'Invalid connection offer.' }); return; }
        if (rooms.size >= maxRooms) { reply(response, 503, { error: 'Game setup is busy. Try again shortly.' }); return; }
        let code;
        do { code = String(randomInt(100000000)).padStart(8, '0'); } while (rooms.has(code));
        const room = { offer: input.offer, hostToken: randomBytes(32).toString('base64url'), guestToken: null, answer: null, expiresAt: now() + UNUSED_ROOM_MS, waiter: null };
        rooms.set(code, room);
        reply(response, 201, { code, token: room.hostToken, expiresAt: room.expiresAt });
        return;
      }
      const match = url.pathname.match(/^\/signal\/rooms\/(\d{8})(?:\/(join|answer))?$/);
      if (!match) { reply(response, 404, { error: 'Unknown setup endpoint.' }); return; }
      const [, code, action] = match;
      if (action === 'join' && request.method === 'POST' && !allowed(request, 'join', joinLimit)) { reply(response, 429, { error: 'Too many join attempts. Try again shortly.' }); return; }
      const room = rooms.get(code);
      if (!room) { reply(response, 404, { error: 'Game code expired or was not found.' }); return; }
      if (action === 'join' && request.method === 'POST') {
        await body(request);
        if (rooms.get(code) !== room || now() >= room.expiresAt) { reply(response, 404, { error: 'Game code expired or was not found.' }); return; }
        if (room.guestToken) { reply(response, 409, { error: 'This game already has a joining player.' }); return; }
        room.guestToken = randomBytes(32).toString('base64url');
        room.expiresAt = now() + NEGOTIATION_MS;
        room.waiter?.(202, { joining: true, expiresAt: room.expiresAt });
        reply(response, 200, { offer: room.offer, token: room.guestToken, expiresAt: room.expiresAt });
        return;
      }
      if (action === 'answer' && request.method === 'POST') {
        if (!authorized(request, room.guestToken)) { reply(response, 403, { error: 'Invalid setup owner.' }); return; }
        const input = await body(request);
        if (rooms.get(code) !== room || now() >= room.expiresAt) { reply(response, 404, { error: 'Game setup expired.' }); return; }
        if (!validSignal(input.answer)) { reply(response, 400, { error: 'Invalid connection answer.' }); return; }
        if (room.answer && room.answer !== input.answer) { reply(response, 409, { error: 'An answer was already submitted.' }); return; }
        room.answer = input.answer;
        room.waiter?.(200, { answer: room.answer });
        reply(response, 200, { ok: true });
        return;
      }
      if (action === 'answer' && request.method === 'GET') {
        if (!authorized(request, room.hostToken)) { reply(response, 403, { error: 'Invalid setup owner.' }); return; }
        if (room.answer) { reply(response, 200, { answer: room.answer }); return; }
        if (url.searchParams.get('wait') !== '1') { reply(response, 202, { joining: !!room.guestToken, expiresAt: room.expiresAt }); return; }
        if (room.waiter) { reply(response, 409, { error: 'Game setup is already being checked.' }); return; }
        const finish = (status, value) => { clearTimeout(timeout); room.waiter = null; reply(response, status, value); };
        const timeout = setTimeout(() => finish(202, { joining: !!room.guestToken, expiresAt: room.expiresAt }), 15000);
        room.waiter = finish;
        response.on('close', () => { clearTimeout(timeout); if (room.waiter === finish) room.waiter = null; });
        return;
      }
      if (!action && request.method === 'DELETE') {
        if (!authorized(request, room.hostToken) && !authorized(request, room.guestToken)) { reply(response, 403, { error: 'Invalid setup owner.' }); return; }
        remove(code);
        reply(response, 200, { ok: true });
        return;
      }
      reply(response, 405, { error: 'Invalid setup request.' });
    } catch (error) { reply(response, error.status || 400, { error: error.status ? error.message : 'Invalid setup request.' }); }
  });
  const timer = setInterval(sweep, 1000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); for (const code of rooms.keys()) remove(code); });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}

async function testServer() {
  const { RoomSetup, PROTOCOL } = await import('./net.js');
  assert.equal(PROTOCOL, 4, 'Room validation matches the client protocol');
  let clock = 1000;
  const server = createSignallingServer({ now: () => clock });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const signal = gzipSync(JSON.stringify({ v: 4, sdp: 'v=0\r\na=ice-ufrag:local\r\n' })).toString('base64url');
  const call = async (path, method = 'GET', value = null, token = null) => {
    const response = await fetch(base + path, { method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: value ? JSON.stringify(value) : undefined });
    return { status: response.status, value: await response.json() };
  };
  try {
    const created = await call('/signal/rooms', 'POST', { offer: signal });
    assert.equal(created.status, 201);
    assert.match(created.value.code, /^\d{8}$/);
    assert.equal(created.value.expiresAt, clock + UNUSED_ROOM_MS);
    const path = `/signal/rooms/${created.value.code}`;
    assert.equal((await call(path + '/answer')).status, 403);
    clock += 300000;
    assert.equal((await call(path + '/answer', 'GET', null, created.value.token)).status, 202);
    assert.equal((await call(path + '/answer', 'GET', null, created.value.token)).value.expiresAt, created.value.expiresAt);
    const joined = await call(path + '/join', 'POST', {});
    assert.equal(joined.status, 200);
    assert.equal(joined.value.offer, signal);
    assert.equal((await call(path + '/join', 'POST', {})).status, 409);
    assert.equal((await call(path + '/answer', 'POST', { answer: signal }, created.value.token)).status, 403);
    assert.equal((await call(path + '/answer', 'POST', { answer: signal }, joined.value.token)).status, 200);
    assert.equal((await call(path + '/answer', 'GET', null, created.value.token)).value.answer, signal);
    assert.equal((await call(path, 'DELETE', null, created.value.token)).status, 200);
    assert.equal((await call(path + '/join', 'POST', {})).status, 404);
    const expires = await call('/signal/rooms', 'POST', { offer: signal });
    clock += UNUSED_ROOM_MS;
    assert.equal((await call(`/signal/rooms/${expires.value.code}/join`, 'POST', {})).status, 404);
    const lastSecond = await call('/signal/rooms', 'POST', { offer: signal });
    clock += UNUSED_ROOM_MS - 1;
    const lastJoined = await call(`/signal/rooms/${lastSecond.value.code}/join`, 'POST', {});
    assert.equal(lastJoined.status, 200, 'Unused code is valid until the ten-minute boundary');
    clock += 2;
    assert.equal((await call(`/signal/rooms/${lastSecond.value.code}/answer`, 'POST', { answer: signal }, lastJoined.value.token)).status, 200, 'A claimed code has a separate bounded negotiation window');
    await call(`/signal/rooms/${lastSecond.value.code}`, 'DELETE', null, lastSecond.value.token);
    assert.equal((await call('/signal/rooms', 'POST', { offer: 'invalid' })).status, 400);
    const crossOrigin = await fetch(base + '/signal/rooms', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ offer: signal }) });
    assert.equal(crossOrigin.status, 403);
    const host = new RoomSetup({ base: base + '/signal' });
    const guest = new RoomSetup({ base: base + '/signal' });
    const code = await host.create(signal);
    const pendingAnswer = host.waitForAnswer();
    assert.equal(await guest.join(code), signal);
    await guest.sendAnswer(signal);
    assert.equal(await pendingAnswer, signal, 'Real client/server long-poll exchanges the answer automatically');
    await host.close();
    await guest.close();
    assert.equal((await call(`/signal/rooms/${code}/join`, 'POST', {})).status, 404, 'Claimed setup is deleted after connection setup');
    console.log('Signalling tests passed: eight-digit codes, ten-minute unused expiry, ownership, single guest, answer exchange, deletion and origin checks.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--test') await testServer();
  else createSignallingServer({ webRoot: process.env.WEB_ROOT || null }).listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0', () => console.log('WebRTC setup service listening.'));
}
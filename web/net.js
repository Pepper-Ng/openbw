// web/net.js — deterministic lockstep turn queue for multiplayer.
//
// The simulation is deterministic (fixed LCG seed, integer/fixed-point math — it's why
// OpenBW replays BW bit-exactly), so peers stay identical as long as every peer applies
// the same player commands on the same frame. This module owns that scheduling:
//
//   - local input is drained from the wasm as BW command bytes (see bw_cmd in sandbox.h)
//   - it is tagged for `frame + delay` and broadcast to peers
//   - a frame is only simulated once *every* player's batch for it has arrived
//
// Nothing here knows about WebRTC: the caller supplies a `send` callback and pushes
// incoming turns in via receiveTurn(). That keeps single-player, a loopback harness, and
// a real peer connection on exactly the same code path.

// Every wire surface: the command byte format (bw_cmd in web/sandbox.h), the turn framing
// here, and the lobby/handshake messages. Bump on ANY change to those — peers can easily
// be on different deploys, and a version mismatch must fail loudly instead of desyncing.
// v2: map hash changed from SHA-256 (crypto.subtle) to cyrb53 (pure JS) — a v1 peer would
// compute a different hash and fail the terrain check, so the version bump rejects the pair.
export const PROTOCOL = 5;

const EMPTY = new Uint8Array(0);

// Bot command latency in frames. BW's latency is time-based (commands batch into network
// "turns" on a wall-clock timer), so it spans ~3 frames at normal speed and ~5-6 at
// "fastest"; bot ladders run the normal-speed 3-frame latency for snappier reactions. OpenBW
// lets us set it in frames directly, so we pin it regardless of the visual game speed. Keep
// this equal to what a bot reads from getLatencyFrames() — patch-vendor.py sets the external
// game's sync_st.latency to the same value — so its getRemainingLatencyFrames() pacing lines
// up with when its commands actually execute. Humans keep their own (usually zero) delay.
export const BOT_LATENCY = 3;

// --- signalling -------------------------------------------------------------------
// RoomSetup transfers the offer and answer through short-lived server room codes.
// They're gzipped and base64url'd; PeerLink still carries gameplay directly.
// Measured on a typical machine, a data-channel-only offer is ~850 B raw / ~720 chars
// encoded — but the size is dominated by ICE candidate lines, and candidate count scales
// with the number of network interfaces (VPNs, Docker bridges, IPv6). So callers must
// check the encoded length and fall back to a paste box rather than assume a URL fits.
export const MAX_URL_CODE = 1800;   // beyond this, some chat/mail clients mangle the link

const b64urlEncode = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlDecode = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + (b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function packSignal(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  return b64urlEncode(new Uint8Array(await new Response(stream).arrayBuffer()));
}
export async function unpackSignal(code) {
  const stream = new Blob([b64urlDecode(code.trim())]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export class RoomSetup {
  constructor({ base = '/signal', request = globalThis.fetch.bind(globalThis) } = {}) {
    this.base = base;
    this.request = request;
    this.controller = new AbortController();
    this.code = '';
    this.token = '';
    this.expiresAt = 0;
    this.admission = Promise.resolve();
  }

  async call(path, method = 'GET', value = null) {
    const response = await this.request(this.base + path, {
      method, cache: 'no-store', signal: this.controller.signal,
      headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: value ? JSON.stringify(value) : undefined,
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('Game setup service is unavailable.'); }
    if (!response.ok) throw new Error(result.error || `Game setup HTTP ${response.status}`);
    return result;
  }

  remember(value, code) {
    if (!/^\d{8}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isFinite(value.expiresAt)) throw new Error('Invalid game setup response.');
    this.code = code;
    this.token = value.token;
    this.expiresAt = value.expiresAt;
  }

  async create(offer) {
    const value = await this.call('/rooms', 'POST', Array.isArray(offer) ? { offers: offer } : { offer });
    this.remember(value, value.code);
    return value.code;
  }

  async join(code) {
    if (!/^\d{8}$/.test(code)) throw new Error('Enter an eight-digit game code.');
    const value = await this.call(`/rooms/${code}/join`, 'POST', {});
    this.remember(value, code);
    this.slot = value.slot;
    this.member = value.id;
    if (typeof value.offer !== 'string') throw new Error('Invalid game offer.');
    return value.offer;
  }

  async sendAnswer(answer) { await this.call(`/rooms/${this.code}/answer`, 'POST', { answer }); }

  async poll(after = -1) {
    const value = await this.call(`/rooms/${this.code}/answer?wait=1&after=${after}`);
    if (Number.isFinite(value.expiresAt)) this.expiresAt = value.expiresAt;
    return value;
  }

  async replaceOffer(slot, offer, member = null) {
    return this.call(`/rooms/${this.code}/offer`, 'POST', { slot, offer, member });
  }

  setLocked(locked) {
    this.admission = this.admission.catch(() => {}).then(() => this.call(`/rooms/${this.code}/lock`, 'POST', { locked }));
    return this.admission;
  }

  detach() {
    this.controller.abort(); this.code = ''; this.token = '';
  }

  async waitForAnswer(status = () => {}) {
    while (!this.controller.signal.aborted) {
      const value = await this.call(`/rooms/${this.code}/answer?wait=1`);
      if (typeof value.answer === 'string') return value.answer;
      if (Number.isFinite(value.expiresAt)) this.expiresAt = value.expiresAt;
      status(value);
    }
    throw new DOMException('Game setup cancelled.', 'AbortError');
  }

  async close() {
    this.controller.abort();
    if (!this.code || !this.token) return;
    const code = this.code, token = this.token;
    this.code = '';
    this.token = '';
    try { await this.request(`${this.base}/rooms/${code}`, { method: 'DELETE', keepalive: true, headers: { Authorization: `Bearer ${token}` } }); } catch {}
  }
}

// Peers can easily be on different deploys (we cache-bust per commit), so a version
// mismatch must fail loudly here rather than surface later as an unexplained desync.
function checkProtocol(msg) {
  if (msg && msg.v === PROTOCOL) return msg;
  throw new Error(
    `Protocol mismatch: you're on v${PROTOCOL}, the other side is on v${msg && msg.v != null ? msg.v : '?'}. ` +
    `Both players need the same version — reload the page (and have them do the same) to get the latest.`);
}

// --- transport --------------------------------------------------------------------
// STUN lets most home NATs connect. There's no TURN, so symmetric NAT will fail; a plain
// LAN works even with no ICE servers at all.
export const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export class PeerLink {
  constructor({ onControl = () => {}, onOpen = () => {}, onClose = () => {},
                iceServers = DEFAULT_ICE } = {}) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.ch = null;
    this.onControl = onControl; this.onOpen = onOpen; this.onClose = onClose;
    // Turns can arrive before the game has finished loading and attached a consumer.
    // They are never retransmitted, so dropping them would stall lockstep permanently —
    // queue until setTurnHandler() is called, then flush.
    this._onTurn = null;
    this._queued = [];
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') this.onClose(s);
    };
  }

  #wire(ch) {
    this.ch = ch;
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => this.onOpen();
    ch.onclose = () => this.onClose('closed');
    // Strings are JSON control messages; binary is a turn ([u32 frame][command bytes]).
    ch.onmessage = (e) => {
      if (typeof e.data === 'string') { this.onControl(JSON.parse(e.data)); return; }
      const frame = new DataView(e.data).getUint32(0, true);
      const bytes = new Uint8Array(e.data, 4);
      if (this._onTurn) this._onTurn(frame, bytes);
      else if (this._queued.length < 20000) this._queued.push([frame, bytes]);
    };
  }

  /** Attach the turn consumer, replaying anything buffered while the game was loading. */
  setTurnHandler(fn) {
    this._onTurn = fn;
    const q = this._queued;
    this._queued = [];
    for (const [f, b] of q) fn(f, b);
  }

  // Non-trickle ICE: the blob must be self-contained, so we wait for candidates before
  // encoding it. Waiting for iceGatheringState === 'complete' is the obvious way and also
  // the slow way — it doesn't settle until every transport finishes or times out (mDNS
  // registration, a blocked STUN server), which routinely costs seconds. Instead, finish
  // shortly after the candidates that actually matter arrive: once we have a
  // server-reflexive (public) candidate a peer behind NAT has what it needs, so we only
  // grant stragglers a brief grace period. Anything arriving after that is dropped, which
  // is the accepted trade for a pasteable, non-trickle blob.
  async #gathered() {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise((res) => {
      let settled = false, grace = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(grace); clearTimeout(hard);
        this.pc.removeEventListener('icegatheringstatechange', onState);
        this.pc.removeEventListener('icecandidate', onCand);
        res();
      };
      const onState = () => { if (this.pc.iceGatheringState === 'complete') finish(); };
      const onCand = (e) => {
        if (!e.candidate) return finish();        // null candidate: gathering really is done
        const srflx = e.candidate.candidate.includes(' typ srflx');
        clearTimeout(grace);
        grace = setTimeout(finish, srflx ? 250 : 700);
      };
      this.pc.addEventListener('icegatheringstatechange', onState);
      this.pc.addEventListener('icecandidate', onCand);
      const hard = setTimeout(finish, 2500);      // hard cap if STUN is unreachable
    });
  }

  /** Host: build the invite code. */
  async createOffer(extra = {}) {
    this.#wire(this.pc.createDataChannel('bw', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.#gathered();
    return packSignal({ v: PROTOCOL, ...extra, sdp: this.pc.localDescription.sdp });
  }

  /** Joiner: consume the invite, return {info, answer} to paste back. */
  async acceptOffer(code, extra = {}) {
    const info = checkProtocol(await unpackSignal(code));
    this.pc.ondatachannel = (e) => this.#wire(e.channel);
    await this.pc.setRemoteDescription({ type: 'offer', sdp: info.sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.#gathered();
    return { info, answer: await packSignal({ v: PROTOCOL, ...extra, sdp: this.pc.localDescription.sdp }) };
  }

  /** Host: consume the pasted response. */
  async acceptAnswer(code) {
    const info = checkProtocol(await unpackSignal(code));
    await this.pc.setRemoteDescription({ type: 'answer', sdp: info.sdp });
    return info;
  }

  sendTurn(frame, bytes) {
    if (!this.ch || this.ch.readyState !== 'open') return;
    const buf = new Uint8Array(4 + bytes.length);
    new DataView(buf.buffer).setUint32(0, frame, true);
    buf.set(bytes, 4);
    this.ch.send(buf);
  }
  /**
   * Control messages are JSON and always carry a frame counter, so the receiver can tell
   * how far along the sender was and reject anything inconsistent. Set `frameOf` once the
   * game is running to stamp the live frame.
   */
  sendControl(obj) {
    if (this.ch && this.ch.readyState === 'open')
      this.ch.send(JSON.stringify({ f: this.frameOf ? this.frameOf() : 0, ...obj }));
  }
  close() {
    try { if (this.ch) this.ch.close(); } catch {}
    try { this.pc.close(); } catch {}
  }
}

export class PeerMesh {
  constructor({ localSlot, onControl = () => {}, onOpen = () => {}, onClose = () => {} }) {
    this.localSlot = localSlot;
    this.links = new Map();
    this.onControl = onControl; this.onOpen = onOpen; this.onClose = onClose;
    this._onTurn = null; this._queued = [];
  }

  add(slot, link) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 7 || slot === this.localSlot) throw new Error('Invalid mesh player.');
    this.remove(slot);
    const record = { link, open: false, closed: false };
    this.links.set(slot, record);
    const current = () => this.links.get(slot) === record;
    link.frameOf = () => this.frameOf ? this.frameOf() : 0;
    link.onOpen = () => { if (current()) { record.open = true; this.onOpen(slot); } };
    link.onClose = why => {
      if (!current() || record.closed) return;
      record.open = false; record.closed = true; this.onClose(slot, why);
    };
    link.onControl = message => { if (current()) this.onControl(message, slot); };
    link.setTurnHandler((frame, bytes) => {
      if (!current()) return;
      if (this._onTurn) this._onTurn(frame, bytes, slot);
      else if (this._queued.length < 20000) this._queued.push([frame, bytes, slot]);
    });
    return link;
  }

  connected(slot) { return this.links.get(slot)?.open === true; }
  ready(slots) { return slots.every(slot => slot === this.localSlot || this.connected(slot)); }
  sendTurn(frame, bytes) { for (const record of this.links.values()) if (record.open) record.link.sendTurn(frame, bytes); }
  sendControl(message, slot = null) {
    for (const [peer, record] of this.links) if (record.open && (slot === null || slot === peer)) record.link.sendControl(message);
  }
  setTurnHandler(handler) {
    this._onTurn = handler;
    const queued = this._queued; this._queued = [];
    for (const [frame, bytes, slot] of queued) if (this.links.has(slot)) handler(frame, bytes, slot);
  }
  remove(slot) {
    const record = this.links.get(slot);
    this.links.delete(slot);
    this._queued = this._queued.filter(turn => turn[2] !== slot);
    record?.link.close();
  }
  close() { for (const slot of [...this.links.keys()]) this.remove(slot); }
}

// A drop-in alternative to PeerLink that speaks to the native openbw_bridge relay over a
// WebSocket instead of doing a copy-paste WebRTC handshake. Same runtime surface
// (setTurnHandler / sendTurn / sendControl / frameOf / onControl / onOpen / onClose), so the
// Lockstep and lobby code don't care which transport they're on. onOpen fires when the PEER
// joins the relay (matching PeerLink's "data channel open"), not when we reach the relay.
export class RelayLink {
  constructor({ onControl = () => {}, onOpen = () => {}, onClose = () => {} } = {}) {
    this.onControl = onControl; this.onOpen = onOpen; this.onClose = onClose;
    this.ws = null; this.frameOf = null;
    this._onTurn = null; this._queued = [];
  }

  /** Connect to the relay; resolves once the socket is open (peer may join later). */
  connect(url) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the relay at ' + url));
      ws.onclose = () => this.onClose('closed');
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data);
          if (msg.t === '_relay') {                       // relay meta, not a peer message
            if (msg.peer === 'connected') this.onOpen();
            else if (msg.peer === 'left') this.onClose('peer left');
            else if (msg.error) this.onClose('relay ' + msg.error);
            return;
          }
          this.onControl(msg);
          return;
        }
        const frame = new DataView(e.data).getUint32(0, true);
        const bytes = new Uint8Array(e.data, 4);
        if (this._onTurn) this._onTurn(frame, bytes);
        else if (this._queued.length < 20000) this._queued.push([frame, bytes]);
      };
    });
  }

  setTurnHandler(fn) {
    this._onTurn = fn;
    const q = this._queued; this._queued = [];
    for (const [f, b] of q) fn(f, b);
  }
  sendTurn(frame, bytes) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const buf = new Uint8Array(4 + bytes.length);
    new DataView(buf.buffer).setUint32(0, frame, true);
    buf.set(bytes, 4);
    this.ws.send(buf);
  }
  sendControl(obj) {
    if (this.ws && this.ws.readyState === 1)
      this.ws.send(JSON.stringify({ f: this.frameOf ? this.frameOf() : 0, ...obj }));
  }
  close() { try { if (this.ws) this.ws.close(); } catch {} }
}

export class Lockstep {
  /**
   * @param {object}  o
   * @param {object}  o.x          wasm exports
   * @param {WebAssembly.Memory} o.memory
   * @param {number[]} o.slots     participating player slots ([0] solo, [0,1] for 1v1)
   * @param {number}  o.localSlot  which of those is us
   * @param {number}  o.delay      input delay in frames (0 solo; a few frames for a peer)
   * @param {(msg:object)=>void} o.send
   */
  constructor({ x, memory, slots, localSlot, delay = 0, send = () => {}, bot = null, shadow = null, bot2 = null, botDelay = BOT_LATENCY, onTurn = null }) {
    this.x = x;
    this.memory = memory;
    this.slots = slots.slice();
    this.localSlot = localSlot;
    this.delay = delay;
    this.send = send;
    this.onTurn = onTurn;
    // Command latency for bot-controlled slots (see BOT_LATENCY); only meaningful with a bot.
    this.botDelay = (bot || bot2) ? botDelay : 0;
    this.botSeeded = false;
    // A local AI producing one slot's turns (vs-Computer). It reads the shared sim and
    // emits BW command bytes just like the human, so it's just another local producer.
    this.bot = bot;   // { slot } or null
    // Bot-vs-bot spectate: a second bot on a second sim replica (`shadow`, a { x, memory }).
    // Each frame both bots' commands are applied to BOTH replicas so they stay bit-identical;
    // the local player is a spectator (no human turn). shadow/bot2 are null for every other mode.
    this.shadow = shadow;
    this.bot2 = bot2;   // { slot } — its bot runs on `shadow`
    this.frame = 0;           // next frame to simulate
    this.nextLocalFrame = 0;  // next frame we still owe a local batch for
    this.turns = new Map();   // frame -> Map(slot -> Uint8Array)
    this.stalledSince = 0;
    this.history = new Map();
    this.departures = new Map();
    this.networkPaused = false;
  }

  #batch(f) {
    let m = this.turns.get(f);
    if (!m) { m = new Map(); this.turns.set(f, m); }
    return m;
  }

  /**
   * A peer's turn arrived. Every turn carries the frame it applies to, and it is only
   * legal inside a narrow window: a turn for a frame we've already simulated can never be
   * applied (lockstep never advances past a missing turn, so it must be a duplicate or a
   * replay), and one far in the future means the peer is out of step or misbehaving.
   * Returns a verdict so the host can drop a peer that sends bad frames.
   */
  receiveTurn(slot, frame, bytes) {
    if (!this.slots.includes(slot) || slot === this.localSlot) return { ok: false, why: 'Turn from an inactive player slot' };
    if (!Number.isInteger(frame) || frame < 0)
      return { ok: false, why: `malformed frame ${frame}` };
    if (frame < this.frame)
      return { ok: false, why: `turn for frame ${frame}, already simulated up to ${this.frame}` };
    if (frame > this.frame + this.horizon())
      return { ok: false, why: `turn for frame ${frame}, too far ahead of ${this.frame}` };
    const b = this.#batch(frame);
    if (b.has(slot))
      return { ok: false, why: `duplicate turn for frame ${frame}` };
    b.set(slot, bytes && bytes.length ? bytes : EMPTY);
    return { ok: true };
  }

  /** How far ahead of the current frame a peer's turn may legitimately be. */
  horizon() { return this.delay * 4 + 8; }

  departureSnapshot(slots) {
    const turns = [];
    for (const [frame, batches] of [...this.history, ...this.turns]) {
      for (const slot of slots) if (batches.has(slot)) turns.push([slot, frame, b64urlEncode(batches.get(slot))]);
    }
    if (JSON.stringify(turns).length > 48000) throw new Error('Too much pending input to reconcile a disconnected player safely.');
    return { frame: this.frame, turns };
  }

  scheduleDeparture(at, slots, entries) {
    if (!Number.isInteger(at) || at < this.frame || at > this.frame + this.horizon() * 2 + 2 || !slots.length || slots.some(slot => slot === this.localSlot || !this.slots.includes(slot))) throw new Error('Invalid departure boundary.');
    const recovered = new Map();
    for (const [slot, frame, encoded] of entries) {
      if (!slots.includes(slot) || !Number.isInteger(frame) || frame < 0 || frame >= at || typeof encoded !== 'string' || encoded.length > 65536 || !/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error('Invalid recovered player input.');
      recovered.set(`${slot}:${frame}`, b64urlDecode(encoded));
    }
    for (const slot of slots) for (let frame = this.frame; frame < at; frame++) {
      const bytes = recovered.get(`${slot}:${frame}`) || EMPTY;
      const batch = this.#batch(frame), existing = batch.get(slot);
      if (existing && (existing.length !== bytes.length || existing.some((value, index) => value !== bytes[index]))) throw new Error('Conflicting final player inputs.');
      batch.set(slot, bytes);
    }
    let pending = this.departures.get(at);
    if (!pending) { pending = new Set(); this.departures.set(at, pending); }
    for (const slot of slots) pending.add(slot);
  }

  /** Pull locally generated commands out of the wasm (copy: the buffer is reused). */
  #drainLocal() {
    const len = this.x.openbw_out_len();
    if (!len) return EMPTY;
    const out = new Uint8Array(this.memory.buffer, this.x.openbw_out_ptr(), len).slice();
    this.x.openbw_out_clear();
    return out;
  }

  /** Run the bot's onFrame on a replica and pull its commands (same framing). */
  #drainBot(x = this.x, memory = this.memory) {
    x.openbw_bot_tick();
    const len = x.openbw_bot_out_len();
    if (!len) return EMPTY;
    const out = new Uint8Array(memory.buffer, x.openbw_bot_out_ptr(), len).slice();
    x.openbw_bot_out_clear();
    return out;
  }

  /** Hand one player's batch to a replica. openbw_in_ptr can grow memory, so view after. */
  #apply(slot, bytes, x = this.x, memory = this.memory) {
    if (!bytes || !bytes.length) return;
    const dst = x.openbw_in_ptr(bytes.length);
    new Uint8Array(memory.buffer, dst, bytes.length).set(bytes);
    x.openbw_apply(slot, bytes.length);
  }

  /** Slots we're still waiting on for frame `f`. */
  missing(f) {
    const m = this.turns.get(f);
    return this.slots.filter((s) => !m || !m.has(s));
  }

  /**
   * Advance at most one frame. Returns true if the sim stepped, false if we're waiting
   * on a peer (the caller should render a "waiting" state but keep rendering/input alive).
   */
  tick() {
    if (this.networkPaused) return false;
    const leaving = this.departures.get(this.frame);
    // Owe a batch for every frame through frame+delay. On the first tick this also
    // bootstraps the initial `delay` frames with empty batches, so peers immediately have
    // something to consume and nobody deadlocks waiting for turn 0.
    // Seed the first botDelay frames with empty bot batches so the latency window can fill
    // without the step gate stalling (nothing is scheduled to apply there yet).
    if (this.botDelay && !this.botSeeded) {
      this.botSeeded = true;
      for (let f = 0; f < this.botDelay; f++) {
        if (this.bot) this.#batch(f).set(this.bot.slot, EMPTY);
        if (this.bot2) this.#batch(f).set(this.bot2.slot, EMPTY);
      }
    }
    while (this.nextLocalFrame <= this.frame + this.delay) {
      const f = this.nextLocalFrame++;
      const bf = f + this.botDelay;   // a command the bot issues while seeing frame f executes at bf
      if (this.bot2) {
        // Spectate bot-vs-bot: both slots come from bots, each on its own replica. The
        // human is a spectator, so drop whatever their clicks staged (camera/select only).
        this.x.openbw_out_clear();
        this.#batch(bf).set(this.bot.slot, this.#drainBot(this.x, this.memory));
        this.#batch(bf).set(this.bot2.slot, this.#drainBot(this.shadow.x, this.shadow.memory));
      } else {
        const d = this.#drainLocal();
        this.#batch(f).set(this.localSlot, d);
        // The bot is a local producer for its slot: run its onFrame every frame and stage its
        // turn for frame f + botDelay, matching BW's command latency (see BOT_LATENCY).
        if (this.bot) this.#batch(bf).set(this.bot.slot, this.#drainBot());
        if (this.slots.length > 1) this.send({ t: 'turn', f, d });
      }
    }

    if (this.missing(this.frame).some(slot => !leaving?.has(slot))) {
      if (!this.stalledSince) this.stalledSince = Date.now();
      return false;
    }
    this.stalledSince = 0;
    if (leaving) {
      for (const slot of [...leaving].sort((first, second) => first - second)) {
        this.#apply(slot, new Uint8Array([2, 0, 87, 1]));
        this.dropSlot(slot);
      }
      this.departures.delete(this.frame);
    }

    // Apply in slot order so every peer applies in the same order — to both replicas when
    // spectating, keeping them bit-identical.
    const m = this.turns.get(this.frame);
    for (const s of this.slots) {
      if (this.onTurn && m.get(s)?.length) this.onTurn(this.frame, s, m.get(s));
      this.#apply(s, m.get(s), this.x, this.memory);
      if (this.shadow) this.#apply(s, m.get(s), this.shadow.x, this.shadow.memory);
    }
    if (this.slots.length > 1) {
      this.history.set(this.frame, new Map(m));
      while (this.history.size > this.horizon() * 2 + 8) this.history.delete(this.history.keys().next().value);
    }
    this.turns.delete(this.frame);

    this.x.openbw_step();
    if (this.shadow) this.shadow.x.openbw_step();
    this.frame++;
    return true;
  }

  /** How long we've been blocked on a peer, in ms (0 when running). */
  stalledMs() { return this.stalledSince ? Date.now() - this.stalledSince : 0; }

  /**
   * Stop waiting on a slot. NOTE: with more than two players every peer must drop the
   * same slot on the same frame or they diverge; for 1v1 dropping the peer just means
   * continuing solo, so a local decision is safe.
   */
  dropSlot(slot) {
    this.slots = this.slots.filter((s) => s !== slot);
    for (const batch of this.turns.values()) batch.delete(slot);
    this.stalledSince = 0;
  }
}

export class PeerDepartures {
  constructor({ lockstep, player, playerSlots, send, detach, onError = () => {} }) {
    this.lockstep = lockstep; this.player = player; this.playerSlots = playerSlots;
    this.send = send; this.detach = detach; this.onError = onError;
    this.active = new Set(Object.keys(playerSlots).map(Number));
    this.missing = new Set(); this.epoch = 0; this.phase = null; this.timer = null;
    this.closed = false;
  }

  coordinator(missing = this.missing) { return Math.min(...[...this.active].filter(player => !missing.has(player))); }
  isCoordinator() { return this.coordinator() === this.player; }
  has(player) { return this.active.has(player) && !this.missing.has(player); }
  close() { this.closed = true; clearTimeout(this.timer); }

  lost(player) {
    if (this.closed || !this.active.has(player) || player === this.player || this.missing.has(player)) return;
    this.missing.add(player); this.detach(player); this.lockstep.networkPaused = true;
    try { this.#refresh(); } catch (error) { this.#fail(error); }
  }

  #id(missing) { return `${this.epoch}:${[...missing].sort((first, second) => first - second).join(',')}`; }
  #validMissing(players) { return Array.isArray(players) && players.length > 0 && players.length < this.active.size && new Set(players).size === players.length && players.every(player => Number.isInteger(player) && this.active.has(player)); }
  #fail(error) { if (!this.closed) { this.close(); this.onError(error); } }
  #arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.closed || !this.phase) return;
      const unresponsive = this.isCoordinator() ? this.phase.survivors.filter(player => !this.phase.reports.has(player)) : [this.phase.leader];
      if (!unresponsive.length) { this.#fail(new Error('Could not agree on the final player inputs.')); return; }
      for (const player of unresponsive) this.lost(player);
    }, 10000);
  }
  #refresh() {
    if (this.closed || !this.missing.size) return;
    const id = this.#id(this.missing);
    if (this.phase?.id === id) return;
    const leader = this.coordinator();
    const survivors = [...this.active].filter(player => !this.missing.has(player));
    this.phase = { id, leader, survivors, reports: new Map() };
    this.#arm();
    if (leader === this.player) {
      this.send({ t: 'depart-prepare', epoch: this.epoch, missing: [...this.missing], phase: id });
      this.#report();
    } else this.send({ t: 'depart-request', epoch: this.epoch, missing: [...this.missing] }, leader);
  }
  #report() {
    const snapshot = this.lockstep.departureSnapshot([...this.missing].map(player => this.playerSlots[player]));
    const message = { t: 'depart-report', epoch: this.epoch, phase: this.phase.id, ...snapshot };
    if (this.isCoordinator()) this.#record(message, this.player);
    else this.send(message, this.phase.leader);
  }
  #record(message, player) {
    if (!this.phase || !this.isCoordinator() || message.phase !== this.phase.id || !this.phase.survivors.includes(player)) return;
    if (!Number.isInteger(message.frame) || Math.abs(message.frame - this.lockstep.frame) > this.lockstep.horizon() * 2 || !Array.isArray(message.turns) || message.turns.length > 1024 || JSON.stringify(message).length > 60000) throw new Error('Invalid departure report.');
    const slots = [...this.missing].map(peer => this.playerSlots[peer]);
    for (const entry of message.turns) {
      if (!Array.isArray(entry) || entry.length !== 3 || !slots.includes(entry[0]) || !Number.isInteger(entry[1]) || entry[1] < 0 || entry[1] > message.frame + this.lockstep.horizon() || typeof entry[2] !== 'string' || entry[2].length > 65536 || !/^[A-Za-z0-9_-]*$/.test(entry[2])) throw new Error('Invalid final player inputs.');
    }
    this.phase.reports.set(player, { frame: message.frame, turns: message.turns });
    if (this.phase.reports.size !== this.phase.survivors.length) return;
    const recovered = new Map(), frames = [...this.phase.reports.values()].map(report => report.frame);
    for (const report of this.phase.reports.values()) for (const entry of report.turns) {
      const key = `${entry[0]}:${entry[1]}`, existing = recovered.get(key);
      if (existing && existing[2] !== entry[2]) throw new Error('Players disagree about a final input batch.');
      recovered.set(key, entry);
    }
    const minimum = Math.min(...frames);
    const at = Math.max(1, ...frames, ...[...recovered.values()].map(entry => entry[1] + 1));
    const turns = [...recovered.values()].filter(entry => entry[1] >= minimum).sort((first, second) => first[1] - second[1] || first[0] - second[0]);
    const plan = { t: 'depart-commit', epoch: this.epoch, phase: this.phase.id, missing: [...this.missing], at, turns };
    if (JSON.stringify(plan).length > 60000) throw new Error('Final player inputs exceed the safe departure message size.');
    this.send(plan);
    this.#commit(plan, this.player);
  }
  #commit(message, player) {
    if (!this.#validMissing(message.missing)) return;
    const missing = new Set(message.missing);
    if (player !== this.coordinator(missing) || message.phase !== this.#id(missing) || message.missing.some(peer => !this.missing.has(peer)) || !Array.isArray(message.turns) || message.turns.length > 1024 || JSON.stringify(message).length > 60000) return;
    this.lockstep.scheduleDeparture(message.at, message.missing.map(peer => this.playerSlots[peer]), message.turns);
    for (const peer of missing) { this.active.delete(peer); this.missing.delete(peer); }
    clearTimeout(this.timer); this.phase = null; this.epoch++;
    this.lockstep.networkPaused = this.missing.size > 0;
    this.#refresh();
  }

  handle(message, player) {
    if (typeof message?.t !== 'string' || !message.t.startsWith('depart-')) return false;
    if (this.closed || !this.active.has(player) || message.epoch !== this.epoch) return true;
    try {
      if (message.t === 'depart-commit') { this.#commit(message, player); return true; }
      if (message.t === 'depart-report') { this.#record(message, player); return true; }
      if (!['depart-request', 'depart-prepare'].includes(message.t) || !this.#validMissing(message.missing) || message.missing.includes(player)) return true;
      if (message.missing.includes(this.player)) { this.#fail(new Error('You have been disconnected from the other players.')); return true; }
      const announced = new Set(message.missing);
      if (message.t === 'depart-prepare' && (player !== this.coordinator(announced) || message.phase !== this.#id(announced))) return true;
      for (const peer of announced) if (!this.missing.has(peer)) { this.missing.add(peer); this.detach(peer); }
      this.lockstep.networkPaused = true;
      this.#refresh();
      if (message.t === 'depart-prepare') {
        if (this.phase.id === message.phase) this.#report();
        else this.send({ t: 'depart-request', epoch: this.epoch, missing: [...this.missing] }, this.coordinator());
      } else if (this.isCoordinator()) this.send({ t: 'depart-prepare', epoch: this.epoch, phase: this.phase.id, missing: [...this.missing] }, player);
    } catch (error) { this.#fail(error); }
    return true;
  }
}

// web/openbw.js — browser host for the OpenBW sandbox wasm module.
//
// Responsibilities:
//   * fetch the 3 game MPQs from the Internet Archive on first run and cache
//     them in IndexedDB (so no copyrighted bytes are ever hosted by the site);
//   * provide a minimal WASI shim + the env file bridge the wasm imports;
//   * step the sim on a fixed timer and render on requestAnimationFrame,
//     blitting the framebuffer to a <canvas>; forward input to the wasm exports.

// Build id — CI replaces the placeholder with the commit SHA for cache-busting.
const BUILD = '__BUILD__';
let campaignSaveModule;
const campaignSaves = () => campaignSaveModule ||= import('./campaign-saves.js?v=' + (DEV ? Date.now() : BUILD));

// Any build whose SHA wasn't stamped in by CI is a local/dev build. CI's stamp is a
// GLOBAL sed of the placeholder, which also rewrites comparisons that spell it out —
// so test for the placeholder's underscores instead of matching it literally.
const DEV = BUILD.startsWith('__') || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

// Dev builds swap the favicon to the classic SC icon (prod keeps BW.ICO from the
// index.html link) so dev tabs are recognizable at a glance. Fetched straight from
// the Internet Archive, like the MPQs — no Blizzard material in the repo.
if (DEV) {
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.href = 'https://archive.org/download/starcraft_202012/STARCRAFT.ISO/SC.ICO';
}

// BOT_LOG (?debug or ?botlog) mirrors a bot's own log output (e.g. McRave's per-frame
// profiler) into the console.
const BOT_LOG = /(\?|&)(debug|botlog)\b/.test(location.search);

// Archive index mapping must match web/wasm_main.cpp's js_file_reader:
//   0 StarDat  1 BrooDat  2 Patch_rt  3 map
const ARCHIVE_BASE =
  'https://archive.org/download/sc-classic-installer_202311/' +
  'StarCraft%20Portable.zip/Starcraft%20Brood%20War%2F';
const MPQS = [
  { key: 'stardat',  local: './data/STARDAT.MPQ',  url: ARCHIVE_BASE + 'STARDAT.MPQ',  size: 66184491 },
  { key: 'broodat',  local: './data/BROODAT.MPQ',  url: ARCHIVE_BASE + 'BROODAT.MPQ',  size: 23519727 },
  { key: 'patch_rt', local: './data/patch_rt.mpq', url: ARCHIVE_BASE + 'patch_rt.mpq', size: 636958   },
];
// The melee map: a CC BY 4.0 map committed under web/maps/ and deployed with the
// site (see web/maps/ATTRIBUTION.md). MAP_REMOTE is an optional fallback, used only
// if a build ever ships without the map file.
// Map metadata for the lobby (needed before the map parses; cross-checked at load). `file`
// is fetched directly, so it can be a local path or a CORS URL — the pro/classic maps stream
// from the bwmapdb GitHub repo, so only CC-licensed Weave is bundled. Weave is the default:
// it renders cleanly, whereas OpenBW leaves black gaps on some maps.
const BWDB = 'https://raw.githubusercontent.com/Lucifirius/bwmapdb/master/F0%20-%20Melee/';
const MAPS = [
  // Lost Temple first: THE classic SC melee map and the default — streamed from
  // bwmapdb like the other Blizzard/pro maps (never bundled in this repo).
  { name: 'Lost Temple',      file: BWDB + '(4)Lost%20Temple.scm',                  starts: 4, w: 128, h: 128, tileset: 'Jungle'   },
  { name: 'Weave',            file: './maps/Weave_v1.scx',                          starts: 4, w: 64,  h: 64,  tileset: 'Desert'   },
  { name: 'Python',           file: BWDB + '~Pro/(4)Python1.3.scx',                 starts: 4, w: 128, h: 128, tileset: 'Jungle'   },
  { name: 'Luna',             file: BWDB + '~Pro/(4)Luna%20The%20Final%20PGT.scx',  starts: 4, w: 128, h: 128, tileset: 'Twilight' },
  { name: 'Nostalgia',        file: BWDB + '~Pro/(4)Nostalgia.scm',                 starts: 4, w: 128, h: 128, tileset: 'Badlands' },
  { name: 'Neo Lost Temple',  file: BWDB + '~Pro/(4)Neo%20Lost%20Temple.scx',       starts: 4, w: 128, h: 128, tileset: 'Jungle'   },
  { name: 'Longinus',         file: BWDB + '~Pro/(4)Longinus.scx',                  starts: 3, w: 128, h: 128, tileset: 'Jungle'   },
  { name: 'The Hunters',      file: BWDB + '(8)The%20Hunters.scm',                  starts: 8, w: 128, h: 128, tileset: 'Jungle'   },
  { name: 'Big Game Hunters', file: BWDB + '(8)Big%20Game%20Hunters.scm',           starts: 8, w: 128, h: 128, tileset: 'Jungle'   },
  { name: 'Blood Bath',       file: BWDB + '(4)Blood%20Bath.scm',                   starts: 4, w: 64,  h: 64,  tileset: 'Space'    },
];
const TILESETS = ['Badlands', 'Space', 'Installation', 'Ashworld', 'Jungle', 'Desert', 'Ice', 'Twilight'];
// Pick `n` distinct start slots at random.
function pickStartSlots(n, starts) {
  if (!Number.isInteger(n) || !Number.isInteger(starts) || n < 1 || starts > 8 || n > starts) throw new Error('The map has no room for that many players.');
  const pool = [...Array(starts).keys()];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
const MAP_LOCAL = MAPS[0].file;
const MAP_REMOTE = '';

// Fetched map bytes, kept so the lobby can hash a map without re-downloading it.
const mapCache = new Map();
let mapProbesStarted = false;
async function fetchMap(file, onProgress = null, signal = null) {
  if (mapCache.has(file)) { onProgress?.(1); return mapCache.get(file); }
  const bytes = new Uint8Array(await fetchWithProgress(file, 0, onProgress || (() => {}), signal));
  mapCache.set(file, bytes);
  return bytes;
}
// Peers must run byte-identical terrain or their sims diverge immediately, so the map is
// hash-verified rather than trusted by filename.
// A quick non-cryptographic hash (cyrb53) of the map bytes — enough to catch peers loading
// different terrain, and pure JS so it works on any origin. crypto.subtle would need a
// secure context (https or localhost), which broke multiplayer over a plain-http LAN IP.
function cyrb53(bytes) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 2654435761);
    h2 = Math.imul(h2 ^ bytes[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
async function mapHash(file) {
  return cyrb53(await fetchMap(file));
}

const $ = (id) => document.getElementById(id);
const setBar = (f) => { $('bar').firstElementChild.style.width = (f * 100).toFixed(1) + '%'; };
const setMsg = (m) => { $('msg').textContent = m; };

// ---------------------------------------------------------------------------
// IndexedDB cache for the MPQs
// ---------------------------------------------------------------------------
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('openbw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('assets');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbGet(db, key) {
  return new Promise((res, rej) => {
    const r = db.transaction('assets').objectStore('assets').get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}
function idbPut(db, key, val) {
  return new Promise((res, rej) => {
    const tx = db.transaction('assets', 'readwrite');
    tx.objectStore('assets').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function fetchWithProgress(url, expected, onProgress, signal) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
  const total = +resp.headers.get('content-length') || expected || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (expected && got > expected) { await reader.cancel(); throw new Error('Download exceeds expected size.'); }
    if (total) onProgress(got / total);
  }
  if (expected && got !== expected) throw new Error('Download size did not match the expected file.');
  onProgress(1);
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf.buffer;
}

// Returns [stardat, broodat, patch_rt, map] as Uint8Arrays.
async function missionDigest(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Mission verification requires HTTPS or localhost.');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}

async function loadMissionPack(manifest, db, signal) {
  const key = `campaign:${manifest.id}:${manifest.contentVersion}:${manifest.pack.sha256}`;
  const valid = async bytes => bytes && bytes.byteLength === manifest.pack.bytes && await missionDigest(bytes) === manifest.pack.sha256;
  let bytes = db ? await idbGet(db, key).catch(() => null) : null;
  if (!await valid(bytes)) {
    setMsg(`Downloading ${manifest.title} (${(manifest.pack.bytes / 1048576).toFixed(2)} MB)...`);
    bytes = await fetchWithProgress(manifest.pack.url, manifest.pack.bytes, fraction => setBar(0.75 + fraction * 0.25), signal);
    if (!await valid(bytes)) throw new Error('Mission pack failed its size or SHA-256 check.');
    if (db) await idbPut(db, key, bytes).catch(error => console.warn('[campaign] pack cache unavailable', error));
  }
  return new Uint8Array(bytes);
}

async function loadAssets(mapFile = MAP_LOCAL, mission = null, signal, onProgress = null) {
  const db = await idbOpen().catch(error => { console.warn('[assets] cache unavailable', error); return null; });
  const out = new Array(MPQS.length);

  // Fetch the three MPQs concurrently. archive.org throttles per-connection, so
  // three parallel downloads pull far more aggregate bandwidth than the old
  // serial loop, and IndexedDB writes are independent so there's no contention.
  // The bar is the sum of bytes across all three, leaving the final slice for the map.
  const totalBytes = MPQS.reduce((s, m) => s + m.size, 0);
  const got = new Array(MPQS.length).fill(0);
  const MPQ_SPAN = MPQS.length / (MPQS.length + 1);
  const renderBar = () => {
    const fraction = Math.min(1, got.reduce((a, b) => a + b, 0) / totalBytes);
    if (onProgress) onProgress('Game files', fraction);
    else setBar(fraction * MPQ_SPAN);
  };
  if (onProgress) onProgress('Game files', 0);
  else setMsg(`Downloading game data (${(totalBytes / 1e6) | 0} MB)…`);

  await Promise.all(MPQS.map(async ({ key, local, url, size }, i) => {
    let buf = db ? await idbGet(db, key).catch(() => null) : null;
    if (buf && buf.byteLength !== size) buf = null;
    if (!buf) {
      // Same-origin local mirror is a dev convenience; production hosts no game
      // files, so this 404s and the archive.org URL is used.
      let mirror = null;
      try { mirror = await fetchWithProgress(local, size, fraction => { got[i] = fraction * size; renderBar(); }, signal); } catch (error) { if (signal?.aborted) throw error; }
      if (!mirror && DEV) throw new Error('Missing local game data: ' + local);
      buf = mirror || await fetchWithProgress(url, size, (frac) => { got[i] = frac * size; renderBar(); }, signal);
      if (db) await idbPut(db, key, buf).catch(error => console.warn('[assets] cache write unavailable', error));
    }
    got[i] = size; renderBar();
    out[i] = new Uint8Array(buf);
  })).catch(error => { db?.close(); throw error; });

  if (onProgress) onProgress('Map', 0);
  else setMsg('Loading map…');
  if (mission) {
    out.push(await loadMissionPack(mission, db, signal));
    if (db) db.close();
    setBar(1);
    return out;
  }
  // fetchMap memoises, so a map the lobby already hashed isn't downloaded twice.
  let mapBytes = null;
  try { mapBytes = await fetchMap(mapFile, fraction => onProgress?.('Map', fraction), signal); } catch (error) { if (signal?.aborted) { db?.close(); throw error; } }
  if (!mapBytes && MAP_REMOTE) mapBytes = new Uint8Array(await (await fetch(MAP_REMOTE)).arrayBuffer());
  if (!mapBytes) { db?.close(); throw new Error('No map available — set MAP_REMOTE to a hosted .scx URL.'); }
  out.push(mapBytes);
  if (db) db.close();
  if (onProgress) onProgress('Map', 1);
  else setBar(1);
  return out;
}

// ---------------------------------------------------------------------------
// WASI shim (only what wasm_main/backend actually import)
// ---------------------------------------------------------------------------
function makeWasi(getMemory) {
  const OK = 0, EBADF = 8;
  const dv = () => new DataView(getMemory().buffer);
  const dec = new TextDecoder();
  return {
    clock_time_get(id, precision, out) {
      const ns = BigInt(Math.round(performance.now() * 1e6));
      dv().setBigUint64(out, ns, true);
      return OK;
    },
    fd_write(fd, iovs, iovs_len, nwritten) {
      const view = dv();
      let total = 0, s = '';
      for (let i = 0; i < iovs_len; i++) {
        const p = iovs + i * 8;
        const off = view.getUint32(p, true), len = view.getUint32(p + 4, true);
        s += dec.decode(new Uint8Array(getMemory().buffer, off, len));
        total += len;
      }
      view.setUint32(nwritten, total, true);
      if (s) (fd === 2 ? console.error : console.log)('[wasm] ' + s.replace(/\n$/, ''));
      return OK;
    },
    fd_fdstat_get(fd, out) {
      const view = dv();
      view.setUint8(out, 2);          // filetype = character device (stdout/stderr)
      view.setUint16(out + 2, 0, true);
      view.setBigUint64(out + 8, 0n, true);
      view.setBigUint64(out + 16, 0n, true);
      return OK;
    },
    fd_fdstat_set_flags: () => OK,
    fd_close: () => OK,
    fd_seek: () => EBADF,
    fd_read: () => EBADF,
    path_open: () => EBADF,
    fd_prestat_get: () => EBADF,      // no preopens
    fd_prestat_dir_name: () => EBADF,
    proc_exit(code) { throw new Error('wasm proc_exit(' + code + ')'); },
    // The bot module (BWAPI server + ZZZKBot) pulls in a bit more of libc than the
    // clean build: it reads env vars (none set -> defaults), touches the filesystem
    // (there is none -> fails cleanly), and uses random_get. None affect the sim.
    environ_sizes_get(count_out, size_out) {
      const view = dv(); view.setUint32(count_out, 0, true); view.setUint32(size_out, 0, true); return OK;
    },
    environ_get: () => OK,            // empty environment
    random_get(buf, len) {
      crypto.getRandomValues(new Uint8Array(getMemory().buffer, buf, len)); return OK;
    },
    poll_oneoff(subs, events, n, nevents_out) { dv().setUint32(nevents_out, 0, true); return OK; },
    path_unlink_file: () => EBADF,
    path_remove_directory: () => EBADF,
    path_rename: () => EBADF,
  };
}

// ---------------------------------------------------------------------------
// Input mapping (browser -> SDL-style codes the engine expects)
// ---------------------------------------------------------------------------
const SCANCODE = {
  Escape: 41, Tab: 43, Space: 44,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  ControlLeft: 224, ShiftLeft: 225, ControlRight: 228, ShiftRight: 229,
};

// A user-chosen key (KeyboardEvent.code) that acts exactly like Escape — for setups where
// the physical Esc is awkward, and ahead of pointer-lock/fullscreen modes where the browser
// reserves Esc for itself. Vim users' Caps Lock→Esc habit is the canonical example.
let altEsc = '';
try { altEsc = localStorage.getItem('openbw-alt-esc') || ''; } catch {}

// View zoom: the engine renders at window/zoom and CSS upscales the canvas
// (image-rendering: pixelated). 1x = native resolution, the default and minimum;
// zooming in gives bigger, chunkier OG-style pixels. Pinch / Ctrl+wheel adjusts it.
let zoom = 1;
const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
const viewportSize = () => {
  if (!coarsePointer()) return [window.innerWidth, window.innerHeight];
  const rectangle = $('screen').getBoundingClientRect();
  return [rectangle.width, rectangle.height];
};
const zoomMax = () => {
  const [minimumWidth, minimumHeight] = coarsePointer() ? [320, 240] : [640, 480];
  const [width, height] = viewportSize();
  return Math.max(1, Math.min(coarsePointer() ? 3 : Infinity,
    width / minimumWidth, height / minimumHeight));
};
try { zoom = Math.min(zoomMax(), Math.max(1, parseFloat(localStorage.getItem('openbw-zoom')) || 1)); } catch {}
const winSize = () => {
  const [width, height] = viewportSize();
  return [Math.max(320, (width / zoom) | 0), Math.max(240, (height / zoom) | 0)];
};

function wireInput(canvas, x) {
  const touchMedia = window.matchMedia('(pointer: coarse)');
  const mouseMedia = window.matchMedia('(any-pointer: fine) and (any-hover: hover)');
  let touchControls;
  const useTouchControls = (touch) => {
    if (touchControls === touch) return;
    touchControls = touch;
    x.openbw_set_touch_controls?.(touch ? 1 : 0);
  };
  const syncTouchControls = () => useTouchControls(touchMedia.matches && !mouseMedia.matches);
  syncTouchControls();
  touchMedia.addEventListener('change', syncTouchControls);
  mouseMedia.addEventListener('change', syncTouchControls);
  window.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') useTouchControls(false);
    else if (event.pointerType === 'touch' || event.pointerType === 'pen') useTouchControls(true);
  }, {capture: true, passive: true});
  window.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') useTouchControls(false);
  }, {passive: true});
  const xy = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) * canvas.width / r.width),
            Math.round((e.clientY - r.top) * canvas.height / r.height)];
  };
  const sdlButton = (b) => (b === 0 ? 1 : b === 1 ? 2 : b === 2 ? 3 : 0);

  // Pointer lock (opt-in, ⚙ settings): the mouse is captured by the window and drives a
  // virtual cursor instead — it can't slip out of the window, so edge-scroll always
  // works, like the original's fullscreen. The engine draws the BW cursor at the
  // virtual position (the OS cursor is hidden under lock anyway). Esc releases the lock
  // (browser-reserved); clicking re-engages it. The Alt-Esc setting still cancels.
  let vx = 0, vy = 0;   // virtual cursor, canvas coords; seeded from the real mouse
  const locked = () => document.pointerLockElement === canvas;
  wireInput.lockWanted = false;   // set by the settings wiring in boot()
  wireInput.cursorPos = () => [vx | 0, vy | 0];   // for the native cursor overlay
  canvas.addEventListener('click', () => {
    if (!coarsePointer() && (wireInput.lockWanted || fullscreenElement()) && !locked() && canvas.requestPointerLock)
      Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  });

  // Reflect a mouse event's modifier flags into the engine's key-state, which is
  // authoritative at click time. On macOS this lets Cmd (meta) stand in for Ctrl
  // for select-all-of-type — there Ctrl+click is hijacked by the OS as a right-click.
  const syncMods = (e) => {
    x.openbw_key(e.ctrlKey || e.metaKey ? 1 : 0, 0, 224);   // virtual Ctrl
    x.openbw_key(e.shiftKey ? 1 : 0, 0, 225);               // virtual Shift
  };

  // Under lock, coordinates come from the virtual cursor; otherwise from the event.
  const pos = (e) => {
    if (locked()) return [vx | 0, vy | 0];
    const p = xy(e);
    vx = p[0]; vy = p[1];   // keep the virtual cursor seeded for a seamless lock engage
    return p;
  };
  // Under lock every mouse event lands on the canvas, so DOM UI (top-left icons,
  // command card, wireframes, menus) would be unreachable and the engine would eat
  // clicks meant for it. Hit-test the virtual cursor: if it sits over a DOM element,
  // route the click there instead of into the game.
  const domUnderCursor = () => {
    if (!locked()) return null;
    const r = canvas.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + vx * r.width / canvas.width,
                                         r.top + vy * r.height / canvas.height);
    return el && el !== canvas ? el : null;
  };
  let domDownEl = null;
  canvas.addEventListener('mousemove', (e) => {
    if (locked()) {
      const r = canvas.getBoundingClientRect();
      vx = Math.max(0, Math.min(canvas.width - 1, vx + e.movementX * canvas.width / r.width));
      vy = Math.max(0, Math.min(canvas.height - 1, vy + e.movementY * canvas.height / r.height));
      x.openbw_mouse_move(vx | 0, vy | 0);
      return;
    }
    const [px, py] = pos(e); x.openbw_mouse_move(px, py);
  });
  // Park the cursor off-screen when it leaves the canvas so edge-scrolling stops.
  canvas.addEventListener('mouseleave', () => { if (!locked()) x.openbw_mouse_move(-1, -1); });
  canvas.addEventListener('mousedown', (e) => {
    domDownEl = domUnderCursor();
    if (domDownEl) return;   // press belongs to the DOM UI, not the game
    syncMods(e); const [px, py] = pos(e); x.openbw_mouse_button(1, sdlButton(e.button), px, py, e.detail || 1);
  });
  window.addEventListener('mouseup', (e) => {
    if (e.target.closest?.('#touch-shortcuts')) return;
    if (coarsePointer() && e.target.closest?.('#card')) return;
    if (domDownEl) {
      // Complete the DOM click if the release is still over the pressed element.
      const el = domUnderCursor();
      if (el && (el === domDownEl || domDownEl.contains(el))) domDownEl.click();
      domDownEl = null;
      return;
    }
    syncMods(e); const [px, py] = pos(e); x.openbw_mouse_button(0, sdlButton(e.button), px, py, e.detail || 1);
    // A game click while locked is an "outside" click for any open popup: hand the
    // close-on-outside-click handlers their canvas-targeted signal.
    if (e.button === 0 && locked()) canvas.click();
  });
  // Under lock the browser still delivers its native click to the canvas, which the
  // close-popup-on-outside-click handlers would see right after a routed DOM click
  // opened settings/help — instantly undoing it. Swallow trusted clicks while
  // locked; routed clicks are synthesized via el.click() (untrusted) and pass.
  window.addEventListener('click', (e) => {
    if (locked() && e.isTrusted) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Forward keys to the engine without shadowing the browser's own shortcuts.
  // The game only binds unmodified keys plus Ctrl+digit (control groups); anything
  // held with Cmd (meta) or Alt — Cmd+1 to switch tabs, Cmd+R to reload, … — is
  // left for the browser. The modifier keys themselves are always forwarded so the
  // engine can track held state (for select-all, shift-queue, group assign).
  const MOD_SC = new Set([224, 225, 228, 229]);
  const key = (down) => (e) => {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;   // typing in chat
    if (altEsc && e.code === altEsc) {
      // Fire a complete Esc press. Caps Lock is a lock key — macOS delivers keydown when
      // the lock turns on but only keyup when it turns off — so accept either edge for it;
      // ordinary keys act on keydown alone (both edges would double-fire the cancel).
      if (down || e.code === 'CapsLock') { x.openbw_key(1, 0, 41); x.openbw_key(0, 0, 41); }
      e.preventDefault();
      return;
    }
    const sc = SCANCODE[e.code] || 0;
    const sym = e.key.length === 1 ? e.key.toLowerCase().charCodeAt(0) : 0;
    if (!sc && !sym) return;
    if (MOD_SC.has(sc)) { x.openbw_key(down ? 1 : 0, 0, sc); return; }   // track, don't preventDefault
    const isDigit = sym >= 48 && sym <= 57;
    const gameBinds = (!e.metaKey && !e.altKey && !e.ctrlKey)          // unmodified keys
                   || (e.ctrlKey && !e.metaKey && !e.altKey && isDigit); // Ctrl+digit = control groups
    if (!gameBinds) return;   // hand Cmd+1, Cmd+R, Ctrl+T, … back to the browser
    x.openbw_key(down ? 1 : 0, sym, sc);
    if (down) x.openbw_render(performance.now());
    e.preventDefault();
  };
  window.addEventListener('keydown', key(true));
  window.addEventListener('keyup', key(false));

  // Trackpad / wheel scrolling pans the camera; pinch (Ctrl+wheel) zooms the view.
  // The zoom renders the engine at window/zoom and lets the pixelated CSS upscale
  // do the rest; 1x (native, the default) is the floor — never more zoomed out.
  // The engine keeps the minimap at constant size via the view scale.
  let zoomTimer = 0, lastZoomApply = 0, appliedZoom = zoom;
  const updateZoomButtons = () => {
    $('touch-zoom-out').disabled = zoom <= 1;
    $('touch-zoom-in').disabled = zoom >= zoomMax();
    if (coarsePointer()) {
      const bounds = canvas.getBoundingClientRect();
      const scaleX = bounds.width / x.openbw_framebuffer_width();
      const scaleY = bounds.height / x.openbw_framebuffer_height();
      const mapWidth = Math.round(x.openbw_map_w() / zoom);
      const mapHeight = Math.round(x.openbw_map_h() / zoom);
      document.body.style.setProperty('--minimap-edge', (bounds.left + (mapWidth + 4) * scaleX + 8) + 'px');
      document.body.style.setProperty('--touch-rows', mapHeight * scaleY >= 90 ? '2' : '1');
    }
  };
  const applyZoom = () => {
    zoomTimer = 0;
    lastZoomApply = performance.now();
    const k = appliedZoom / zoom;
    if (k === 1) return;
    appliedZoom = zoom;
    if (x.openbw_set_view_scale) x.openbw_set_view_scale(zoom);
    x.openbw_resize(...winSize());
    // Zoom towards the cursor: the resize keeps the camera's top-left corner, so
    // pan by the cursor's shift to keep the map point under it fixed (the engine
    // clamps at map edges). The virtual cursor keeps its on-screen spot.
    x.openbw_pan(Math.round(vx * (1 - k)), Math.round(vy * (1 - k)));
    vx *= k; vy *= k;
    x.openbw_mouse_move(vx | 0, vy | 0);
    updateZoomButtons();
  };
  const setZoom = (value) => {
    zoom = Math.min(zoomMax(), Math.max(1, value));
    try { localStorage.setItem('openbw-zoom', zoom.toFixed(2)); } catch {}
    const since = performance.now() - lastZoomApply;
    if (since >= 30) { clearTimeout(zoomTimer); applyZoom(); }
    else if (!zoomTimer) zoomTimer = setTimeout(applyZoom, 30 - since);
    updateZoomButtons();
  };
  wireInput.resize = () => {
    cancelTouch();
    clearTimeout(zoomTimer);
    zoomTimer = 0;
    zoom = Math.min(zoom, zoomMax());
    appliedZoom = zoom;
    if (x.openbw_set_view_scale) x.openbw_set_view_scale(zoom);
    x.openbw_resize(...winSize());
    updateZoomButtons();
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      setZoom(zoom * Math.exp(-e.deltaY * 0.01));
      return;
    }
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.height : 1;
    x.openbw_pan(Math.round(e.deltaX * scale), Math.round(e.deltaY * scale));
  }, { passive: false });

  const LONG_MS = 350, DOUBLE_TAP_MS = 300, MOVE_PX = 12, MOVE2 = MOVE_PX * MOVE_PX;
  const d2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
  let tt = null;
  let lastSelectionTap = null;
  wireInput.queue = false;
  wireInput.inspect = false;
  const park = () => x.openbw_mouse_move(-1, -1);
  const previewPlacement = (touch) => {
    const [px, py] = xy(touch);
    const offset = Math.round(40 * canvas.height / canvas.getBoundingClientRect().height);
    x.openbw_preview_placement?.(px | 0, Math.max(0, py - offset) | 0);
    x.openbw_render(performance.now());
  };
  const cancelTouch = () => {
    lastSelectionTap = null;
    if (!tt) return;
    clearTimeout(tt.timer);
    if (tt.mode === 'box') {
      x.openbw_mouse_button(0, 1, tt.x | 0, tt.y | 0, 1);
      x.openbw_render(performance.now());
    }
    x.openbw_key(0, 0, 225);
    tt = null;
    park();
  };
  const tap = (button, px, py, clicks = 1) => {
    x.openbw_key(wireInput.queue ? 1 : 0, 0, 225);
    x.openbw_mouse_move(px | 0, py | 0);
    x.openbw_mouse_button(1, button, px | 0, py | 0, clicks);
    x.openbw_mouse_button(0, button, px | 0, py | 0, clicks);
    x.openbw_render(performance.now());
    x.openbw_key(0, 0, 225);
  };
  const pressKey = (symbol, scancode = 0) => {
    x.openbw_key(1, symbol, scancode);
    x.openbw_key(0, symbol, scancode);
  };
  const clearInspect = () => {
    for (const command of document.querySelectorAll('#card .inspect')) {
      command.classList.remove('inspect');
      command.setAttribute('aria-expanded', 'false');
    }
  };
  $('touch-queue').onclick = () => {
    wireInput.queue = !wireInput.queue;
    $('touch-queue').setAttribute('aria-pressed', String(wireInput.queue));
  };
  $('touch-info').onclick = () => {
    wireInput.inspect = !wireInput.inspect;
    $('touch-info').setAttribute('aria-pressed', String(wireInput.inspect));
    clearInspect();
  };
  for (const button of document.querySelectorAll('[data-touch-group]')) {
    let holdTimer = 0, assigned = false;
    const save = () => {
      assigned = true;
      x.openbw_key(1, 0, 224);
      pressKey(button.dataset.touchGroup.charCodeAt(0));
      x.openbw_render(performance.now());
      x.openbw_key(0, 0, 224);
      button.classList.add('saved');
      setTimeout(() => button.classList.remove('saved'), 800);
    };
    button.addEventListener('pointerdown', (event) => {
      assigned = false;
      holdTimer = setTimeout(save, 450);
      button.setPointerCapture(event.pointerId);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
      button.addEventListener(event, () => clearTimeout(holdTimer));
    button.addEventListener('contextmenu', event => event.preventDefault());
    button.onclick = () => {
      if (!assigned) pressKey(button.dataset.touchGroup.charCodeAt(0));
      assigned = false;
    };
  }
  for (const [id, factor] of [['touch-zoom-out', 1 / 1.2], ['touch-zoom-in', 1.2]]) {
    $(id).onclick = () => {
      vx = canvas.width / 2; vy = canvas.height / 2;
      setZoom(zoom * factor);
    };
  }
  updateZoomButtons();
  document.body.classList.add('playing');
  if (window.lucide) window.lucide.createIcons();

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    clearInspect();
    if (e.touches.length >= 2) {
      if (tt?.mode === 'pinch') return;
      const first = e.touches[0], second = e.touches[1];
      const canTap = tt?.mode === 'pending';
      cancelTouch();
      tt = { mode: 'pinch', distance: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
        zoom, cx: (first.clientX + second.clientX) / 2, cy: (first.clientY + second.clientY) / 2,
        moved: false, canTap, target: xy(first) };
      return;
    }
    if (tt) return;
    const t = e.changedTouches[0];
    const [px, py] = xy(t);
    if (x.openbw_cursor() === 2 && x.openbw_preview_placement) {
      tt = { id: t.identifier, mode: 'placement', x: px, y: py };
      previewPlacement(t);
      return;
    }
    tt = { id: t.identifier, x0: px, y0: py, x: px, y: py, cx: t.clientX, cy: t.clientY,
      mode: 'pending', armed: false };
    const gesture = tt;
    tt.timer = setTimeout(() => { if (tt === gesture) tt.armed = true; }, LONG_MS);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!tt) return;
    e.preventDefault();
    if (tt.mode === 'pinch') {
      if (e.touches.length < 2) return;
      const first = e.touches[0], second = e.touches[1];
      const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
      const cx = (first.clientX + second.clientX) / 2, cy = (first.clientY + second.clientY) / 2;
      if (Math.abs(distance - tt.distance) > 4 || d2(cx, cy, tt.cx, tt.cy) > MOVE2) tt.moved = true;
      if (!tt.moved) return;
      [vx, vy] = xy({ clientX: cx, clientY: cy });
      const rectangle = canvas.getBoundingClientRect();
      x.openbw_pan(Math.round((tt.cx - cx) * canvas.width / rectangle.width),
        Math.round((tt.cy - cy) * canvas.height / rectangle.height));
      setZoom(tt.zoom * distance / Math.max(1, tt.distance));
      tt.cx = cx; tt.cy = cy;
      return;
    }
    const t = [...e.changedTouches].find((c) => c.identifier === tt.id);
    if (!t) return;
    if (tt.mode === 'placement') { previewPlacement(t); return; }
    const [px, py] = xy(t);
    const far = d2(t.clientX, t.clientY, tt.cx, tt.cy) > MOVE2;
    if (tt.mode === 'pending' && far) {
      clearTimeout(tt.timer);
      if (tt.armed) {
        tt.mode = 'box';
        x.openbw_key(wireInput.queue ? 1 : 0, 0, 225);
        x.openbw_mouse_move(tt.x0, tt.y0);
        x.openbw_mouse_button(1, 1, tt.x0, tt.y0, 1);
        x.openbw_mouse_move(px, py);
      } else {
        tt.mode = 'pan';
      }
    } else if (tt.mode === 'pan') {
      x.openbw_pan(tt.x - px, tt.y - py);
    } else if (tt.mode === 'box') {
      x.openbw_mouse_move(px, py);
    }
    tt.x = px; tt.y = py;
  }, { passive: false });

  const endTouch = (e) => {
    if (!tt) return;
    e.preventDefault();
    if (tt.mode === 'pinch') {
      if (e.touches.length) return;
      if (!tt.moved && tt.canTap) tap(3, ...tt.target);
      tt = null; park();
      return;
    }
    const t = [...e.changedTouches].find((c) => c.identifier === tt.id);
    if (!t) return;
    clearTimeout(tt.timer);
    const [px, py] = xy(t);
    if (tt.mode === 'placement') {
      lastSelectionTap = null;
      previewPlacement(t);
    } else if (tt.mode === 'box') {
      lastSelectionTap = null;
      x.openbw_mouse_button(0, 1, px, py, 1);
      x.openbw_render(performance.now());
      x.openbw_key(0, 0, 225);
    } else if (tt.mode === 'pending') {
      const cursor = x.openbw_cursor();
      const targeting = cursor === 1 || cursor === 2 || cursor === 4;
      const button = targeting ? 1 : tt.armed ? 3
        : x.openbw_touch_button ? x.openbw_touch_button(px | 0, py | 0) : 1;
      const now = performance.now();
      const selectionTap = button === 1 && !targeting && !tt.armed;
      const doubleTap = selectionTap && lastSelectionTap && now - lastSelectionTap.time <= DOUBLE_TAP_MS
        && d2(t.clientX, t.clientY, lastSelectionTap.x, lastSelectionTap.y) <= MOVE2;
      tap(button, px, py, doubleTap ? 2 : 1);
      lastSelectionTap = selectionTap && !doubleTap ? { time: now, x: t.clientX, y: t.clientY } : null;
    } else lastSelectionTap = null;
    tt = null;
    park();
  };
  canvas.addEventListener('touchend', endTouch, { passive: false });
  canvas.addEventListener('touchcancel', cancelTouch, { passive: false });
}

// ---------------------------------------------------------------------------
// Boot
async function instantiateWasm(moduleName, imports, identify = false, prepared = null) {
  if (prepared) return { module: prepared, instance: await WebAssembly.instantiate(prepared, imports) };
  const url = './' + moduleName + (DEV ? '?t=' + Date.now() : '?v=' + BUILD);
  const response = await fetch(url, DEV ? { cache: 'no-store' } : {});
  if (!response.ok) {
    if (response.status === 404 && moduleName !== 'openbw.wasm')
      throw new Error('Computer-opponent module ' + moduleName + ' is not built locally. Set all opponent slots to None.');
    throw new Error('Could not load ' + moduleName + ': HTTP ' + response.status + '.');
  }
  if ((response.headers.get('content-type') || '').toLowerCase().includes('text/html'))
    throw new Error('Received an HTML page instead of ' + moduleName + '. Check the server URL and reload the page.');
  const identity = identify ? response.clone() : null;
  let result;
  try {
    result = await WebAssembly.instantiateStreaming(response.clone(), imports);
  } catch {
    result = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
  }
  if (identity) result.engineHash = await missionDigest(new Uint8Array(await identity.arrayBuffer()));
  return result;
}

// A headless bot replica: its own memory + WASI over the shared assets, silent (the
// rendered replica handles sound). Seats the full melee and attaches its bot. Used as the
// shadow sim for the second bot in a spectated bot-vs-bot — the Lockstep keeps it in sync.
async function makeBotReplica(assets, moduleName, slots, botSlot, w, h) {
  let memory;
  const env = {
    js_file_size: (i) => assets[i].length,
    js_read_data: (i, dst, off, n) => { new Uint8Array(memory.buffer).set(assets[i].subarray(off, off + n), dst); },
    js_bot_log: (ptr, len) => { if (BOT_LOG) console.log('%c[bot ' + botSlot + ']', 'color:#c90', new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))); },
    js_sound_load: () => -1, js_sound_play: () => {}, js_sound_is_playing: () => 0, js_sound_stop: () => {}, js_sound_set_volume: () => {},
  };
  const { instance } = await instantiateWasm(moduleName, { wasi_snapshot_preview1: makeWasi(() => memory), env });
  const x = instance.exports;
  memory = x.memory;
  x._initialize();
  const pairs = new Int32Array(slots.length * 2);
  slots.forEach((s, i) => { pairs[2 * i] = s.slot; pairs[2 * i + 1] = s.race; });
  const p = x.openbw_in_ptr(pairs.byteLength);
  new Uint8Array(memory.buffer, p, pairs.byteLength).set(new Uint8Array(pairs.buffer));
  x.openbw_init_mp(w, h, botSlot, slots.length);
  x.openbw_bot_attach(botSlot);
  return { x, memory };
}

// ---------------------------------------------------------------------------
// session: { slots: [{slot, race}], mySlot, link, delay }
// Single-player is one slot with no link and zero delay; 1v1 is two slots, a PeerLink,
// and a few frames of input delay. Both peers must pass an identical `slots` list.
// Bot-vs-bot spectate adds { spectate:true, bot:{slot,module}, bot2:{slot,module} }.
async function boot(session) {
  let briefingActive = !!session.mission;
  let sessionFailed = false;
  let missionTicks = 0;
  let recovering = !!session.resume;
  let saveBeforeLeave = () => {};
  const missionTurns = [];
  // Audio is created LAZILY on the first user gesture, never during boot. The constructor
  // is a synchronous IPC to Chrome's shared audio service; on a reload the old game's
  // context is being torn down in the same renderer, and constructing a new one in that
  // window can block the main thread indefinitely — the "reload, then the next game hangs
  // and Chrome offers to kill the page" freeze. By the first click/keypress the teardown
  // is long finished (and a gesture is also what the autoplay policy wants). Sounds the
  // engine loads before then are stashed as raw WAVs and decoded when audio comes up.
  let audioCtx = null, masterGain = null;
  const pendingWavs = {};    // id -> Uint8Array, loaded before the context existed
  let muted = false;
  try { muted = localStorage.getItem('openbw-muted') === '1'; } catch {}
  const ensureAudio = () => {
    if (audioCtx) { audioCtx.resume(); return; }
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { console.warn('[audio] no AudioContext — running silent:', e && e.message); return; }
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
    applyMute();
    for (const id of Object.keys(pendingWavs)) { decodeWav(+id, pendingWavs[id]); delete pendingWavs[id]; }
  };
  addEventListener('pointerdown', ensureAudio);
  addEventListener('keydown', ensureAudio);
  addEventListener('pagehide', () => {
    saveBeforeLeave();
    sessionFailed = true;
    removeEventListener('pointerdown', ensureAudio);
    removeEventListener('keydown', ensureAudio);
    if (audioCtx) audioCtx.close().catch(() => {});
  });

  const muteBtn = $('mute');
  const applyMute = () => {
    if (masterGain) masterGain.gain.value = muted ? 0 : 1;
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.title = muted ? 'Unmute sound' : 'Mute sound';
    muteBtn.setAttribute('aria-label', muteBtn.title);
  };
  $('topbar').style.display = 'flex';
  muteBtn.onclick = () => {
    muted = !muted;
    try { localStorage.setItem('openbw-muted', muted ? '1' : '0'); } catch {}
    applyMute();
    ensureAudio();
  };
  applyMute();

  // Controls popup toggled by the "?" button; dismissed by clicking elsewhere.
  const helpBtn = $('helpbtn'), helpPop = $('help');
  helpBtn.onclick = (e) => {
    e.stopPropagation();
    $('settings').style.display = 'none';
    helpPop.style.display = helpPop.style.display === 'block' ? 'none' : 'block';
  };
  document.addEventListener('click', (e) => {
    if (helpPop.style.display === 'block' && e.target !== helpBtn && !helpPop.contains(e.target)) {
      helpPop.style.display = 'none';
    }
  });

  // Black-box recorder for the intermittent 100%-CPU wedge: stamp each boot stage and a
  // once-a-second run heartbeat into localStorage, which survives a killed renderer. After
  // a freeze, a fresh tab's console shows where the last life ended:
  //   localStorage.getItem('openbw-heartbeat')
  const hb = (stage) => { try { localStorage.setItem('openbw-heartbeat', stage + ' @' + new Date().toISOString()); } catch {} };
  hb('boot:start');

  const assets = session.prepared?.assets || await loadAssets(session.mapFile || MAP_LOCAL, session.mission, session.signal);
  session.signal?.throwIfAborted();
  hb('boot:assets-loaded');

  let memory;
  const getMemory = () => memory;

  // Web Audio bridge for native_sound (web/wasm_backend.cpp): decode WAV bytes
  // to AudioBuffers keyed by id, then play/stop them per channel. pan is always
  // 0 from the engine, so we don't bother panning.
  const soundBuffers = [];   // id -> AudioBuffer | null while decoding
  const soundChannels = [];  // channel -> { source, gain, playing }
  const pendingPlay = {};    // id -> {channel, volume} requested before decode finished
  const gainFor = (v) => Math.min(1, Math.max(0, v / 128));
  const playBuffer = (buf, channel, volume) => {
    if (!audioCtx) return;
    const prev = soundChannels[channel];
    if (prev && prev.source) { try { prev.source.stop(); } catch {} }
    const source = audioCtx.createBufferSource();
    source.buffer = buf;
    const gain = audioCtx.createGain();
    gain.gain.value = gainFor(volume);
    source.connect(gain).connect(masterGain);
    const rec = { source, gain, playing: true };
    source.onended = () => { if (soundChannels[channel] === rec) rec.playing = false; };
    soundChannels[channel] = rec;
    source.start();
  };
  const decodeWav = (id, wav) => {
    audioCtx.decodeAudioData(wav.buffer).then((b) => {
      if (sessionFailed) return;
      soundBuffers[id] = b;
      // A play requested while still decoding would be silently dropped
      // (a one-shot sound like a selection ack) — fire it now that it's ready.
      const p = pendingPlay[id];
      if (p) { delete pendingPlay[id]; playBuffer(b, p.channel, p.volume); }
    }, () => {});
  };
  const audio = {
    js_sound_load(ptr, size) {
      const id = soundBuffers.length;
      soundBuffers.push(null);
      const wav = new Uint8Array(memory.buffer, ptr, size).slice();   // copy out of wasm memory
      if (audioCtx) decodeWav(id, wav);
      else pendingWavs[id] = wav;   // decoded when the first gesture brings audio up
      return id;
    },
    js_sound_play(id, channel, volume) {
      if (id < 0 || recovering) return;
      if (soundBuffers[id]) playBuffer(soundBuffers[id], channel, volume);
      else pendingPlay[id] = { channel, volume };   // decode still in flight
    },
    js_sound_is_playing: (channel) => (soundChannels[channel] && soundChannels[channel].playing ? 1 : 0),
    js_sound_stop(channel) {
      const c = soundChannels[channel];
      if (c && c.source) { try { c.source.stop(); } catch {} c.playing = false; }
    },
    js_sound_set_volume(channel, volume) {
      const c = soundChannels[channel];
      if (c) c.gain.gain.value = gainFor(volume);
    },
  };

  const env = {
    js_file_size: (index) => assets[index].length,
    js_read_data: (index, dst, offset, n) => {
      new Uint8Array(memory.buffer).set(assets[index].subarray(offset, offset + n), dst);
    },
    // A bot module (e.g. McRave) routes its Logger here; mirror it to the console in debug.
    js_bot_log: (ptr, len) => {
      if (!BOT_LOG) return;
      const s = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
      // Crash recorder: the last bot line survives a killed renderer, so a wedged game
      // can be localized afterwards (localStorage.getItem('openbw-botlog') in a new tab).
      try { localStorage.setItem('openbw-botlog', s.slice(0, 200)); } catch {}
      console.log('%c[bot]', 'color:#f90', s);
    },
    ...audio,
  };

  setMsg('Starting engine…');
  const imports = { wasi_snapshot_preview1: makeWasi(getMemory), env };
  // In dev, a unique URL + no-store defeats Chrome's aggressive HTTP/compiled-
  // wasm caching so rebuilds are picked up. In production we want the opposite:
  // let the browser cache and reuse the compiled module across visits.
  // Any build whose SHA wasn't stamped in by CI is a local/dev build — including one served
  // to a phone over a LAN IP. Treat it as dev so the wasm is fetched fresh (the ?v=__BUILD__
  // cache-buster is a constant locally, so a plain fetch would serve a stale, skewed wasm).
  // BUILD is replaced by CI with the commit SHA (see .github/workflows/container.yml), so a
  // new deploy fetches a fresh wasm URL instead of a stale cached one. Locally it stays
  // the '__BUILD__' placeholder and we cache-bust per load instead.
  // vs-Computer loads a bot-enabled module (sandbox + BWAPI server + the chosen bot);
  // each exports the same surface plus openbw_bot_*, so everything else is identical.
  const wasmName = session.bot ? session.bot.module : 'openbw.wasm';
  hb('boot:wasm-fetch');
  const { instance, engineHash } = await instantiateWasm(wasmName, imports, !!session.mission, session.prepared?.module);
  const x = instance.exports;
  memory = x.memory;
  const saveCompatibility = session.mission ? { mission: session.mission.id, packHash: session.mission.pack.sha256, engineHash, assetHashes: assets.slice(0, 3).map(cyrb53) } : null;
  if (session.resume) (await campaignSaves()).validateCampaignSave(session.resume, saveCompatibility);

  const canvas = $('screen');
  const ctx = canvas.getContext('2d');

  hb('boot:engine-init');
  zoom = Math.min(zoom, zoomMax());
  x._initialize();
  const { slots, mySlot, link = null, delay = 0 } = session;
  if (session.mission) {
    const pointer = x.openbw_campaign_capabilities();
    const bytes = new Uint8Array(memory.buffer);
    let end = pointer;
    while (bytes[end]) end++;
    const capabilities = new Set(new TextDecoder().decode(bytes.subarray(pointer, end)).trim().split('\n'));
    const missing = session.mission.requirements.filter(required => !capabilities.has(required));
    if (missing.length) throw new Error('Unsupported mission operations: ' + missing.join(', '));
    x.openbw_init_campaign(...winSize(), session.mission.race, session.mission.humanSlot);
  } else if (slots.length > 1) {
    // Hand the slot list to the wasm as int32 [slot, race] pairs via the scratch buffer.
    const pairs = new Int32Array(slots.length * 2);
    slots.forEach((s, i) => { pairs[2 * i] = s.slot; pairs[2 * i + 1] = s.race; });
    const p = x.openbw_in_ptr(pairs.byteLength);
    new Uint8Array(memory.buffer, p, pairs.byteLength).set(new Uint8Array(pairs.buffer));
    x.openbw_init_mp(...winSize(), mySlot, slots.length);
  } else {
    x.openbw_init(...winSize(), slots[0].race, slots[0].slot);
  }
  hb('boot:engine-ready');
  // Attach the BWAPI read-view so the bot can drive its slot (vs-Computer only).
  if (session.bot) { hb('boot:bot-attach'); x.openbw_bot_attach(session.bot.slot); hb('boot:bot-attached'); }
  // Bot-vs-bot spectate: reveal the whole map and stand up the second bot on a shadow
  // replica that the Lockstep keeps bit-identical. This one (x) is the rendered spectator
  // view — full UI, sound, pause, input — with the human as an onlooker (Lockstep bot2 path).
  let shadow = null, bot2 = null;
  if (session.spectate && session.bot2) {
    x.openbw_reveal_map();
    x.openbw_set_spectator(1);   // no unit voices; resource HUD follows the selected unit
    shadow = await makeBotReplica(assets, session.bot2.module, slots, session.bot2.slot, ...winSize());
    bot2 = { slot: session.bot2.slot };
  }
  wireInput(canvas, x);
  // View zoom + native cursor overlay (feature-detected: a stale module falls back
  // to the engine-drawn cursor and a zoom-scaled minimap).
  if (x.openbw_set_view_scale) x.openbw_set_view_scale(zoom);
  if (x.openbw_set_external_cursor && x.openbw_cursor_rgba) x.openbw_set_external_cursor(1);

  // Settings popup (⚙, top-left). Order/rally lines are off by default; the choice
  // persists. Wired here because it drives the wasm, which is now instantiated.
  const settingsBtn = $('settingsbtn'), settingsPop = $('settings'), optLines = $('opt-lines');
  let showLines = false;
  try { showLines = localStorage.getItem('openbw-order-lines') === '1'; } catch {}
  optLines.checked = showLines;
  x.openbw_set_order_lines(showLines ? 1 : 0);
  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    helpPop.style.display = 'none';
    settingsPop.style.display = settingsPop.style.display === 'block' ? 'none' : 'block';
  };
  optLines.onchange = () => {
    try { localStorage.setItem('openbw-order-lines', optLines.checked ? '1' : '0'); } catch {}
    x.openbw_set_order_lines(optLines.checked ? 1 : 0);
  };
  // Mouse lock (pointer capture) + fullscreen. The lock preference persists; the lock
  // itself engages on the next game click (browsers require a user gesture).
  const optLock = $('opt-mouselock');
  try { optLock.checked = localStorage.getItem('openbw-mouselock') === '1'; } catch {}
  wireInput.lockWanted = optLock.checked;
  optLock.onchange = () => {
    wireInput.lockWanted = optLock.checked;
    try { localStorage.setItem('openbw-mouselock', optLock.checked ? '1' : '0'); } catch {}
    if (!optLock.checked && document.pointerLockElement) document.exitPointerLock();
  };
  // Esc releases the pointer lock; reflect that in the checkbox so it doesn't stay
  // ticked (and silently re-engage on the next click). Fullscreen's automatic lock
  // is independent of the checkbox and doesn't count.
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && optLock.checked && !fullscreenElement()) {
      optLock.checked = false;
      wireInput.lockWanted = false;
      try { localStorage.setItem('openbw-mouselock', '0'); } catch {}
    }
  });
  const fsBtn = $('opt-fullscreen');
  const appMode = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches
    || (window.matchMedia('(display-mode: fullscreen)').matches && !fullscreenElement());
  const root = document.documentElement;
  const requestFullscreen = document.fullscreenEnabled !== false && root.requestFullscreen
    ? () => root.requestFullscreen()
    : document.webkitFullscreenEnabled !== false && (root.webkitRequestFullscreen || root.webkitRequestFullScreen)
      ? () => (root.webkitRequestFullscreen || root.webkitRequestFullScreen).call(root) : null;
  const updateFullscreenButton = () => {
    fsBtn.disabled = appMode || !requestFullscreen;
    fsBtn.textContent = appMode ? 'App mode' : !requestFullscreen ? 'Fullscreen unavailable'
      : fullscreenElement() ? 'Exit fullscreen' : coarsePointer() ? 'Fullscreen'
        : `Fullscreen (${navigator.platform.startsWith('Mac') ? '\u2325\u21a9' : 'Alt-Enter'})`;
    fsBtn.title = !requestFullscreen && !appMode
      ? 'On iPhone, use Safari Share > Add to Home Screen, leave Open as Web App enabled, then launch the Home Screen icon.' : '';
  };
  updateFullscreenButton();
  const toggleFullscreen = async () => {
    if (appMode || !requestFullscreen) return;
    try {
      if (fullscreenElement()) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else await document.webkitExitFullscreen();
      } else await requestFullscreen();
      updateFullscreenButton();
    } catch {
      updateFullscreenButton();
      fsBtn.title = 'Fullscreen was not permitted by this browser.';
    }
  };
  fsBtn.onclick = () => {
    settingsPop.style.display = 'none';
    toggleFullscreen();
  };
  // Alt-Enter (the classic PC-game convention) / F11 toggle fullscreen. The game's
  // own key handler hands modified keys back to the browser, so no game binds shadowed.
  window.addEventListener('keydown', (e) => {
    const combo = e.key === 'F11'
      || (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'Enter');
    if (!combo || e.repeat) return;
    e.preventDefault();
    toggleFullscreen();
  });
  // In fullscreen, capture Esc with the Keyboard Lock API (Chromium): a TAP of Esc is
  // delivered to the game — so Esc keeps working as cancel, and it no longer drops
  // pointer lock — while HOLDING Esc exits fullscreen (the browser shows the hint).
  // Browsers without the API keep today's behavior (Esc exits; Alt-Esc covers cancel).
  const fullscreenChanged = () => {
    updateFullscreenButton();
    requestAnimationFrame(() => wireInput.resize());
    if (fullscreenElement()) {
      if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(['Escape']).catch(() => {});
      // Capture the mouse too: without pointer lock, macOS reveals the menu bar when
      // the cursor touches the screen top. If the activation expired, the next click
      // engages it (the canvas click handler treats fullscreen as lock-wanted).
      if (!coarsePointer() && canvas.requestPointerLock)
        Promise.resolve(canvas.requestPointerLock()).catch(() => {});
    } else if (navigator.keyboard && navigator.keyboard.unlock) {
      navigator.keyboard.unlock();
    }
  };
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('webkitfullscreenchange', fullscreenChanged);

  // Alternative Esc key: click the button, press the key to bind (Esc itself clears).
  // Stored as KeyboardEvent.code; the key handler routes it as a full Esc press.
  const altEscBtn = $('opt-altesc');
  const altEscShow = () => {
    altEscBtn.textContent = altEsc ? altEsc.replace(/^(Key|Digit)/, '') : 'none';
  };
  altEscShow();
  altEscBtn.onclick = (e) => {
    e.stopPropagation();
    altEscBtn.textContent = 'press a key…';
    window.addEventListener('keydown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      altEsc = ev.code === 'Escape' ? '' : ev.code;
      try { localStorage.setItem('openbw-alt-esc', altEsc); } catch {}
      altEscShow();
    }, { capture: true, once: true });
  };
  // Save the recorded game as a StarCraft .rep. Our command stream already is BW's action
  // format, so the wasm just serialises what it recorded — opens in BW and replay tools.
  const saveReplay = (btn) => {
    const ptr = x.openbw_save_replay(), len = x.openbw_replay_len();
    if (!ptr || !len) { if (btn) btn.textContent = 'Nothing recorded'; return; }
    const bytes = new Uint8Array(memory.buffer, ptr, len).slice();   // copy: the buffer is reused
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url; a.download = `openbw-${stamp}.rep`; a.click();
    URL.revokeObjectURL(url);
    if (btn) { const t = btn.textContent; btn.textContent = `Saved (${(len / 1024) | 0} KB)`;
               setTimeout(() => { btn.textContent = t; }, 2500); }
  };

  // End-of-game score screen: outcome, per-player unit/building/resource/score totals from
  // the sim, and the save-replay button (a replay is only worth keeping once it's done).
  const RACE_NAME = ['Zerg', 'Terran', 'Protoss'];
  const PLAYER_COLORS = ['#f40404', '#0c48cc', '#2cb494', '#88409c', '#f88c14', '#703014', '#cce0d0', '#fcfc38'];
  let gameOverShown = false;
  const toMainMenu = () => location.replace(location.origin + location.pathname + (session.mission ? campaignDebug ? '?campaign=1&campaign-debug=1' : '?campaign=1' : '?campaign=0'));
  const showGameOver = (title, won) => {
    if (gameOverShown) return;
    gameOverShown = true;
    if (session.mission) {
      stopNarration();
      $('mission-caption').hidden = true;
      if (!campaignDebug) campaignSaves().then(storage => storage.deleteCampaignSave(`auto:${session.mission.id}`)).catch(() => {});
      if (won && !campaignDebug) {
        const progress = campaignProgress();
        progress.victories[session.mission.id] = true;
        try { saveCampaignProgress(progress); $('go-progress').textContent = 'Mission complete.'; }
        catch { $('go-progress').textContent = 'Mission complete. Progress could not be saved.'; }
      }
      const next = campaignMissionIds[campaignMissionIds.indexOf(session.mission.id) + 1];
      $('go-next').hidden = !won || !next;
      $('go-next').disabled = !!next && !campaignUnlocked(next);
      $('go-next').onclick = () => location.replace(campaignAddress(next, null, true));
    }
    // openbw_stats returns a C-string pointer, not a JS string — read it out of wasm memory.
    const ptr = x.openbw_stats();
    const rows = (ptr ? readCString(ptr) : '').split('\n');
    const secs = Math.round((+(rows.shift() || '0\t0').split('\t')[1] || 0) / (session.mission ? 16 : 24));
    let html = '<tr><th>Player</th><th>Units</th><th>Buildings</th><th>Minerals</th><th>Gas</th><th>Score</th></tr>';
    for (const line of rows) {
      if (!line) continue;
      const [isMe, race, color, units, bldgs, min, gas, score] = line.split('\t').map(Number);
      const sw = `<span class="swatch" style="background:${PLAYER_COLORS[color] || '#888'}"></span>`;
      html += `<tr class="${isMe ? 'me' : ''}"><td>${sw}${RACE_NAME[race] || 'Player'}</td>` +
              `<td>${units}</td><td>${bldgs}</td><td>${min}</td><td>${gas}</td><td>${score}</td></tr>`;
    }
    html += `<tr><td colspan="6" style="color:#64748b;text-align:center;padding-top:12px">` +
            `Game length ${(secs/60)|0}:${String(secs%60).padStart(2,'0')}</td></tr>`;
    $('go-stats').innerHTML = html;
    const t = $('go-title');
    t.textContent = title;
    t.className = won === true ? 'win' : won === false ? 'lose' : '';
    $('gameover').classList.add('show');
    // The game's decided — you can't concede one you've already won or lost, so the
    // settings menu's "Resign" turns into "Back to main menu".
    resignArmed = false;
    resignBtn.textContent = 'Back to main menu';
    resignBtn.classList.replace('danger', 'backmenu');
  };
  $('go-replay').onclick = (e) => saveReplay(e.currentTarget);
  $('go-close').onclick = () => { x.openbw_reveal_map(); $('gameover').classList.remove('show'); };
  $('go-new').onclick = toMainMenu;
  $('go-new').textContent = session.mission ? 'Campaign Menu' : 'New game';
  $('go-replay').hidden = !!session.mission;
  $('go-retry').hidden = !session.mission;
  $('go-retry').onclick = () => {
    const address = new URL(location.origin + location.pathname);
    address.searchParams.set('mission', session.mission.id);
    address.searchParams.set('autostart', '1');
    address.searchParams.set('fresh', '1');
    if (campaignDebug) address.searchParams.set('campaign-debug', '1');
    location.replace(address);
  };

  // Debug (?debug in the URL): force a win/lose to exercise the game-over screen without
  // playing to elimination. Bypasses the competitive gate, so it works in single-player.
  let debugResourcesPending = false;
  if (/(\?|&)debug\b/.test(location.search)) {
    $('opt-debug').style.display = 'block';
    $('dbg-victory').onclick = () => { settingsPop.style.display = 'none'; x.openbw_debug_outcome(1); };
    $('dbg-defeat').onclick = () => { settingsPop.style.display = 'none'; x.openbw_debug_outcome(2); };
    $('dbg-resources').onclick = () => { settingsPop.style.display = 'none'; x.openbw_debug_resources(2000, 1000); };
    $('dbg-reveal').onclick = () => { settingsPop.style.display = 'none'; x.openbw_reveal_map(); };
    // Not while spectating: a cheat mutates only the rendered replica, desyncing the shadow.
    debugResourcesPending = !session.spectate && !session.mission;
    if (session.mission) $('opt-debug').style.display = 'none';
  }

  // Chat (Enter to open). Messages go into the same log the sim uses for eliminations, via
  // openbw_post_message. In a 1v1 they're relayed to the peer over the control channel; in
  // single-player debug the input doubles as a cheat console.
  const isDebug = /(\?|&)debug\b/.test(location.search);
  const chatInput = $('chatinput');
  const postLog = (text) => {
    const bytes = new TextEncoder().encode(text);
    const p = x.openbw_in_ptr(bytes.length);
    new Uint8Array(memory.buffer, p, bytes.length).set(bytes);
    x.openbw_post_message(bytes.length);
  };
  const CHEATS = {
    'show me the money':     () => (x.openbw_debug_resources(10000, 10000), 'resources granted'),
    'black sheep wall':      () => (x.openbw_reveal_map(), 'map revealed'),
    'there is no cow level': () => (x.openbw_debug_outcome(1), 'victory'),
    'game over man':         () => (x.openbw_debug_outcome(2), 'defeat'),
  };
  const sendChat = (raw) => {
    const text = raw.trim();
    if (!text) return;
    if (!link && isDebug) {
      const cheat = CHEATS[text.toLowerCase()];
      if (cheat) { postLog('Cheat: ' + cheat()); return; }
    }
    if (link) link.sendControl({ t: 'chat', text });
    postLog('You: ' + text);
  };
  const closeChat = () => { chatInput.value = ''; chatInput.blur(); chatInput.style.display = 'none'; };
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === chatInput) {
      if (e.key === 'Enter') { sendChat(chatInput.value); closeChat(); e.preventDefault(); }
      else if (e.key === 'Escape') { closeChat(); e.preventDefault(); }
      return;
    }
    if (e.key === 'Enter') { chatInput.style.display = 'block'; chatInput.focus(); e.preventDefault(); }
  });

  // Resign: one confirming click (no blocking dialog), then concede via the sim.
  const resignBtn = $('opt-resign');
  let resignArmed = false;
  resignBtn.onclick = () => {
    if (gameOverShown) { settingsPop.style.display = 'none'; toMainMenu(); return; }
    if (!resignArmed) { resignArmed = true; resignBtn.textContent = 'Confirm — resign?'; return; }
    resignArmed = false; resignBtn.textContent = 'Resign game';
    settingsPop.style.display = 'none';
    x.openbw_resign();
    if (session.mission && paused) pauseBtn.click();
  };
  document.addEventListener('click', (e) => {
    if (settingsPop.style.display === 'block' && e.target !== settingsBtn && !settingsPop.contains(e.target))
      settingsPop.style.display = 'none';
    if (resignArmed && e.target !== resignBtn) { resignArmed = false; resignBtn.textContent = 'Resign game'; }
  });

  // Follow the window size (debounced). The frame loop below picks up the new
  // framebuffer dimensions automatically.
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => wireInput.resize(), 150);
  });

  $('overlay').style.display = 'none';

  // Fixed-timestep simulation on a timer, rendering on requestAnimationFrame.
  // A self-rescheduling timeout (rather than setInterval) advances one frame per fire
  // — so returning to a hidden tab resumes at normal speed instead of fast-forwarding a
  // backlog — while letting the interval change on the fly for the speed control. rAF is
  // paused while hidden, so we simply don't render then. Pausing just skips the step;
  // rendering and input keep running, so you can still look around and give orders.
  let paused = false, waiting = false, stepMs = 42;   // 42 ms ≈ 24 Hz "fastest" game speed
  try { stepMs = +localStorage.getItem('openbw-speed') || 42; } catch {}
  if (session.mission) stepMs = 42;

  // Local input is serialised to BW command bytes rather than applied directly; the
  // lockstep queue drains them, schedules them, and applies every player's batch before
  // stepping. Single-player is just a one-player session with zero input delay, so solo
  // play runs the exact code path multiplayer will — versioned by net.js's BUILD query so
  // a deploy can't pair a fresh openbw.js with a stale net.js.
  const { Lockstep, PeerDepartures } = await import('./net.js?v=' + BUILD);
  const lockstep = new Lockstep({
    x, memory,
    slots: slots.map((s) => s.slot),
    localSlot: mySlot,
    delay,
    send: (msg) => { if (link && msg.t === 'turn') link.sendTurn(msg.f, msg.d); },
    bot: session.bot || null,
    shadow, bot2,   // set only when spectating a bot-vs-bot match
    onTurn: session.mission ? (tick, owner, bytes) => {
      if (owner !== mySlot) throw new Error('Unexpected campaign input owner.');
      missionTurns.push({ tick, bytes: Array.from(bytes) });
    } : null,
  });
  let dropped = null;   // set when the peer is gone
  let over = false;     // game finished (win / lose / disconnect) — stop stepping
  let rejectPeer = () => {};
  let departures = null;
  const dropBtn = $('dropbtn');
  if (link) {
    const peerSlot = slots.find((s) => s.slot !== mySlot).slot;
    const group = slots.length > 2;
    const remoteSlot = player => session.playerSlots ? session.playerSlots[player] : peerSlot;
    const isCoordinator = () => departures ? departures.isCoordinator() : session.isHost;
    link.frameOf = () => lockstep.frame;

    // End the multiplayer game cleanly: stop stepping, release the peer, and show a final
    // banner. Used for a disconnect, a host-authority kick, and a manual drop after a stall.
    const endMp = (banner) => {
      if (dropped) return;
      over = true;
      dropped = dropped || banner;
      if (!group) lockstep.dropSlot(peerSlot);
      dropBtn.style.display = 'none';
      departures?.close();
      try { link.close(); } catch {}
      setBanner(banner, 0);
      showGameOver(banner, !group && /Victory/.test(banner) ? true : null);
    };
    // The host is the authority: a peer sending turns for illegal frames, or whose sim has
    // diverged, is dropped rather than allowed to stall or corrupt the game.
    const kick = (why) => {
      if (dropped) return;
      console.warn('[mp] dropping peer:', why);
      if (isCoordinator()) link.sendControl({ t: 'kick', why });
      endMp(`Opponent dropped — ${why}`);
    };
    rejectPeer = kick;
    // The channel closed or failed mid-game: in a 1v1, the opponent leaving is a win.
    link.onClose = player => {
      if (dropped) return;
      if (departures) departures.lost(player);
      else endMp('Opponent left — Victory!');
    };
    // Manual escape hatch shown after a long stall.
    dropBtn.textContent = 'Drop disconnected player';
    dropBtn.onclick = () => {
      if (!departures) { endMp('Opponent left — Victory!'); return; }
      const missing = lockstep.missing(lockstep.frame);
      for (const [player, slot] of Object.entries(session.playerSlots)) if (missing.includes(slot) && Number(player) !== link.localSlot) departures.lost(Number(player));
    };

    // setTurnHandler (not a plain assignment) so turns that arrived while we were still
    // loading get replayed instead of dropped — they are never retransmitted.
    link.setTurnHandler((frame, bytes, player) => {
      const r = lockstep.receiveTurn(remoteSlot(player), frame, bytes);
      if (!r.ok && isCoordinator()) kick(r.why);
      else if (!r.ok) console.warn('[mp] bad peer turn:', r.why);
    });

    // Periodic desync probe: both peers hash their sim at the same frames and compare.
    link.onControl = (msg, player) => {
      if (session.playerSlots && !Object.hasOwn(session.playerSlots, player)) return;
      if (departures?.handle(msg, player)) return;
      if (departures && !departures.has(player)) return;
      if (msg.t === 'kick') { if (!session.playerSlots || player === departures?.coordinator()) endMp(`Disconnected — ${String(msg.why || 'kicked').slice(0, 160)}`); return; }
      if (msg.t === 'chat') { postLog('Opponent: ' + String(msg.text || '').slice(0, 80)); return; }
      if (msg.t !== 'sum') return;
      if (!Number.isInteger(msg.f) || msg.f < 0 || msg.f % SUM_EVERY !== 0 || msg.f > lockstep.frame + lockstep.horizon() || !Number.isInteger(msg.h) || msg.h < 0 || msg.h > 0xffffffff) return;
      const mine = mySums.get(msg.f);
      if (mine === undefined) {
        if (msg.f < lockstep.frame) return;
        if (!peerSums.has(msg.f)) peerSums.set(msg.f, new Map());
        peerSums.get(msg.f).set(player, msg.h);
        return;
      }
      if (mine !== msg.h && isCoordinator()) kick(`desync at frame ${msg.f}`);
      else if (mine !== msg.h) endMp('Desynced — game ended');
    };
    if (session.playerSlots) departures = new PeerDepartures({
      lockstep, player: link.localSlot, playerSlots: session.playerSlots,
      send: (message, player = null) => link.sendControl(message, player), detach: player => link.remove(player),
      onError: error => endMp('Connection recovery failed: ' + error.message),
    });
    for (const [player] of session.pendingNetwork?.closed || []) departures?.lost(player);
    for (const [message, player] of session.pendingNetwork?.controls || []) link.onControl(message, player);
  }
  const mySums = new Map(), peerSums = new Map();
  const SUM_EVERY = 240;   // ~10 s at "fastest"
  if (!session.mission) {
    const m = MAPS.find((e) => e.file === (session.mapFile || MAP_LOCAL));
    const actual = x.openbw_start_locations();
    if (m && actual && m.starts !== actual)
      console.warn(`[map] ${m.name}: table says ${m.starts} start locations, map has ${actual}`);
    // Same cross-check for the lobby's size/tileset (from the openbw_map_* exports).
    if (m) {
      const w = x.openbw_map_w(), h = x.openbw_map_h(), ts = TILESETS[x.openbw_map_tileset()];
      if (m.w !== w || m.h !== h || m.tileset !== ts)
        console.warn(`[map] ${m.name}: table says ${m.w}×${m.h} ${m.tileset}, map is ${w}×${h} ${ts}`);
    }
  }
  if (DEV) window.__bw = { x, memory, lockstep, link };   // dev-only debugging handle

  // Pace the sim off wall-clock instead of one frame per timer tick, so a hiccup is made
  // up rather than permanently lost. Frames are never skipped — lockstep requires every
  // peer to simulate every frame in order — we only choose when to run them, so
  // determinism is unaffected. The debt is capped so a long stall resumes promptly
  // instead of fast-forwarding for ages.
  //
  // NOTE: this does NOT rescue a backgrounded tab. Browsers throttle hidden-tab timers to
  // ~1 Hz, and lockstep deliberately never lets a peer run more than `delay` frames ahead
  // of the other, so a hidden peer can only burst ~delay frames per wake-up (~5 fps at
  // delay 4) and drags its opponent down with it. That bound is the correctness property,
  // not a bug; raising `delay` trades input lag for it. In real play both windows are
  // visible and this never applies — but two tabs in one window will crawl.
  // MAX_BURST_MS bounds one timer fire by wall time as well: with an expensive bot a
  // 32-frame burst could block the main thread for over a second — including while a
  // reload's navigation was waiting on the running task, which wedged the page.
  const MAX_CATCHUP = 32, MAX_DEBT_MS = 2000, MAX_BURST_MS = 40;
  // After our own verdict we keep feeding the lockstep for a grace window, so a finished
  // player doesn't starve the peer's turns before it reaches its own verdict. Without this
  // the loser goes `over`, stops sending turns, and the winner stalls on "Waiting for
  // opponent" a few frames short of detecting the win.
  const OVER_GRACE_MS = 5000;
  const readCStringAt = (ptr) => {
    const mem = new Uint8Array(memory.buffer);
    let end = ptr; while (mem[end]) end++;
    return new TextDecoder().decode(mem.subarray(ptr, end));
  };
  let stepTimer, stepClock = performance.now(), lastProgress = performance.now(), overSince = 0;
  let lastHb = 0;   // heartbeat pacing (see the black-box recorder)
  const runStepLoop = () => {
    let burstMs = 0;
    if (!briefingActive && !paused && !dropped && (!over || (link && (slots.length > 2 || performance.now() - overSince < OVER_GRACE_MS)))) {
      const now = performance.now();
      if (now - stepClock > MAX_DEBT_MS) stepClock = now - MAX_DEBT_MS;
      let budget = Math.min(Math.floor((now - stepClock) / stepMs), MAX_CATCHUP);
      let advanced = 0;
      // Heartbeat brackets the tick burst: if a wedge leaves 'run:pre-tick' as the last
      // stamp, the spin is inside the engine step; 'run:frame=N' means we returned.
      if (now - lastHb > 1000) { hb('run:pre-tick frame=' + lockstep.frame); }
      while (budget-- > 0 && performance.now() - now < MAX_BURST_MS && lockstep.tick()) {
        advanced++;
        if (session.mission) { missionTicks++; consumeMissionEvents(); }
        if (session.mission && x.openbw_outcome()) break;
      }
      if (now - lastHb > 1000) {
        hb('run:frame=' + lockstep.frame);
        lastHb = now;
        // Vision tripwire: an intermittent report of seeing the opponent's vision in a
        // normal game — if the sim's vision state ever goes abnormal, name it loudly and
        // persist the evidence (survives a closed tab).
        const va = x.openbw_vision_anomaly ? x.openbw_vision_anomaly() : 0;
        if (va) {
          const dump = readCStringAt(x.openbw_debug_dump());
          console.warn('[vision] anomaly ' + va + ': ' + dump.split('\n')[0]);
          try { localStorage.setItem('openbw-vision', 'anomaly ' + va + ' frame=' + lockstep.frame + ' ' + dump.split('\n')[0]); } catch {}
        }
      }
      burstMs = performance.now() - now;
      stepClock += advanced * stepMs;      // only consume the time we actually simulated
      const stepped = advanced > 0;
      if (stepped) lastProgress = now;
      if (stepped && debugResourcesPending) { x.openbw_debug_resources(2000, 1000); debugResourcesPending = false; }
      // Victory/defeat comes straight out of the shared sim, so both peers reach the
      // same verdict on the same frame without exchanging anything. Stop stepping once
      // it's decided — rendering and panning keep working so you can look around.
      if (stepped && !over) {
        const o = x.openbw_outcome();
        if (o) { over = true; overSince = now; showGameOver(o === 1 ? 'Victory!' : 'Defeat', o === 1); }
      }
      // Hysteresis: only claim we're waiting after a sustained gap with no progress.
      // Reacting to a single late turn made the banner flicker. After a long stall, offer
      // to drop the opponent (their turns never resumed).
      const stall = (link && !over) ? (now - lastProgress) : 0;
      waiting = stall > 1500;
      dropBtn.style.display = stall > 8000 && !lockstep.networkPaused ? 'block' : 'none';
      updateBanner();
      // Desync probe: both peers hash the same frames and compare. Sampled after the step,
      // so both label it with the same post-step frame number.
      if (stepped && link && !dropped && !over && lockstep.frame % SUM_EVERY === 0) {
        const h = x.openbw_checksum() >>> 0;
        const peers = peerSums.get(lockstep.frame);
        mySums.set(lockstep.frame, h);
        while (mySums.size > 8) mySums.delete(mySums.keys().next().value);
        if (peers) {
          peerSums.delete(lockstep.frame);
          if ([...peers.values()].some(peer => peer !== h)) rejectPeer(`desync at frame ${lockstep.frame}`);
        }
        link.sendControl({ t: 'sum', f: lockstep.frame, h });
      }
    }
    // Tick faster than the frame interval so catch-up stays responsive; the loop itself
    // decides how many frames are actually due.
    // The gap also scales with how long this burst took: an expensive sim must fall
    // behind real time rather than saturate the main thread — a page with no idle time
    // can't render or take input and looks frozen even while the sim advances.
    stepTimer = setTimeout(stepLoop, Math.max(8, stepMs >> 1, burstMs * 0.7));
  };
  const failSession = error => {
    if (sessionFailed) return;
    sessionFailed = true;
    over = true;
    clearTimeout(stepTimer);
    stopNarration();
    if (session.mission) campaignFailure(error);
    else { setBanner('Game stopped: ' + error.message, 0); console.error(error); }
  };
  const stepLoop = () => {
    if (sessionFailed) return;
    try { runStepLoop(); } catch (error) { failSession(error); }
  };
  stepTimer = setTimeout(stepLoop, stepMs);

  // Reload is how players go back to the main menu, and a same-origin reload reuses the
  // renderer process — so anything the page doesn't release outlives it. AudioContexts
  // hold one of ~6 per-process hardware slots until close(); leaking one per reload
  // eventually makes the next boot's `new AudioContext()` fail. Also stop the step timer
  // so no catch-up burst fires mid-teardown, and drop the debug handle to help the GC
  // reclaim the (large) wasm memory sooner.
  addEventListener('pagehide', () => {
    clearTimeout(stepTimer);
    sessionFailed = true;
    stopNarration();
    try { if (link) link.close(); } catch {}
    if (DEV) window.__bw = null;
  });

  // Pause/resume, shown like a video player (⏸ while running, ▶ while paused). The
  // ︎ text selector keeps the glyphs monochrome. A big "Paused" banner also shows.
  const pauseBtn = $('pausebtn'), pausedEl = $('paused');
  const pausedSpan = pausedEl.querySelector('span');
  // No pause in multiplayer: lockstep means a local pause just stops feeding turns and
  // stalls the opponent, who sees "Waiting for opponent" until you resume. Hiding it
  // reflows the flex row, so the remaining icons shift left rather than leaving a gap.
  pauseBtn.style.display = link ? 'none' : '';
  // One centre banner serves every state: an explicit message (disconnect/desync) wins,
  // otherwise paused, otherwise blocked waiting on a peer's turn.
  let bannerText = null, bannerOverride = '', bannerTimer = 0;
  const updateBanner = () => {
    const t = bannerOverride || (paused ? 'Paused' : waiting ? 'Waiting for opponent…' : '');
    if (t === bannerText) return;
    bannerText = t;
    pausedSpan.textContent = t;
    pausedEl.style.display = t ? 'flex' : 'none';
  };
  // ms = 0 keeps it up permanently (a fatal state); otherwise it clears itself.
  const setBanner = (t, ms) => {
    bannerOverride = t;
    clearTimeout(bannerTimer);
    if (ms) bannerTimer = setTimeout(() => { bannerOverride = ''; updateBanner(); }, ms);
    updateBanner();
  };
  const applyPause = () => {
    pauseBtn.classList.toggle('is-paused', paused);
    pauseBtn.title = paused ? 'Resume' : 'Pause';
    updateBanner();
  };
  pauseBtn.onclick = () => {
    paused = !paused;
    // On resume, forget the wall-clock debt from the pause so the step loop doesn't
    // fast-forward to "catch up".
    if (!paused) stepClock = performance.now();
    applyPause();
    x.openbw_set_paused?.(paused ? 1 : 0);   // freeze game input in the sim too
  };
  applyPause();

  // Game speed lives in the settings popup; the value is the ms per sim frame.
  const optSpeed = $('opt-speed');
  optSpeed.value = String(stepMs);
  optSpeed.disabled = !!session.mission;
  optSpeed.onchange = () => {
    stepMs = +optSpeed.value || 42;
    try { localStorage.setItem('openbw-speed', String(stepMs)); } catch {}
  };

  // Command card overlay: openbw_card() returns "title\nKEY\tLabel\n…".
  const cardEl = $('card');
  const dec = new TextDecoder();
  let lastCard = '', lastBtnSig = null, lastTouchCard = '';
  let touchBuildOrder = [], buildPointerX = 0, buildDragged = false;
  const readCString = (ptr) => {
    const mem = new Uint8Array(memory.buffer);
    let end = ptr; while (mem[end]) end++;
    return dec.decode(mem.subarray(ptr, end));
  };
  // Render a unit's sprite icon (by unit id) to a cached data URL. The engine hands
  // back RGBA pixels in wasm memory valid only until the next openbw_icon call, so we
  // copy them into a canvas immediately and memoize the resulting data URL by id.
  const iconCache = new Map();
  const iconCanvas = document.createElement('canvas');
  const ictx = iconCanvas.getContext('2d');
  const iconURL = (id) => {
    if (iconCache.has(id)) return iconCache.get(id);
    const ptr = x.openbw_command_icon ? x.openbw_command_icon(id) : id < 228 ? x.openbw_icon(id) : 0;
    const w = x.openbw_icon_w(), h = x.openbw_icon_h();
    let url = '';
    if (ptr && w && h) {
      iconCanvas.width = w; iconCanvas.height = h;
      const img = ictx.createImageData(w, h);
      img.data.set(new Uint8Array(memory.buffer, ptr, w * h * 4));
      ictx.putImageData(img, 0, 0);
      url = iconCanvas.toDataURL();
    }
    iconCache.set(id, url);
    return url;
  };

  const missionDecoder = new TextDecoder('windows-1252');
  const missionText = pointer => {
    const bytes = new Uint8Array(memory.buffer);
    let end = pointer;
    while (bytes[end]) end++;
    return missionDecoder.decode(bytes.subarray(pointer, end)).replace(/[\x01-\x09\x0b-\x1f\x7f]/g, '');
  };
  const missionString = index => index ? missionText(x.openbw_mission_string(index)) : '';
  const narratorName = type => type === 106 ? 'Adjutant' : type === 23 ? 'Edmund Duke' : type === 19 ? 'Jim Raynor' : missionText(x.openbw_mission_unit_name(type));
  const narrationChannel = 63;
  let captionUntil = 0;
  let lastMissionSequence = 0;
  function stopNarration() {
    audio.js_sound_stop(narrationChannel);
    audio.js_sound_stop(narrationChannel - 1);
    for (const id of Object.keys(pendingPlay)) if (pendingPlay[id].channel >= narrationChannel - 1) delete pendingPlay[id];
  }
  function playNarration(index, channel = narrationChannel) {
    if (!index || sessionFailed || recovering) return;
    audio.js_sound_stop(channel);
    for (const id of Object.keys(pendingPlay)) if (pendingPlay[id].channel === channel) delete pendingPlay[id];
    x.openbw_mission_play_sound(index, channel);
  }
  function consumeMissionEvents() {
    const stream = readCString(x.openbw_mission_events()).trim();
    if (!stream) return;
    for (const line of stream.split('\n')) {
      const [generation, sequence, owner, type, location, text, sound, time, modifier, unit, adjustment] = line.split('\t').map(Number);
      if (generation !== 1 || sequence !== lastMissionSequence + 1 || owner !== mySlot) throw new Error('Invalid mission presentation sequence.');
      lastMissionSequence = sequence;
      if (type === 7 || type === 8) playNarration(sound, type === 8 ? narrationChannel - 1 : narrationChannel);
      if (!recovering && (type === 7 || type === 9)) {
        $('mission-caption-text').textContent = missionString(text);
        $('mission-caption-speaker').textContent = type === 7 ? narratorName(unit) : '';
        $('mission-caption').hidden = false;
        const duration = type === 7 ? x.openbw_mission_transmission_time(time, adjustment, modifier) : 7000;
        captionUntil = missionTicks + Math.ceil(Math.max(3000, duration) / 42);
      }
      if (type === 12) $('mission-objectives-text').textContent = missionString(text);
    }
    x.openbw_mission_ack(lastMissionSequence);
  }
  function updateMissionHud() {
    if (!session.mission || briefingActive) return;
    $('mission-objectives-text').textContent = missionText(x.openbw_mission_objectives());
    const remaining = x.openbw_mission_countdown();
    $('mission-countdown').hidden = remaining < 0;
    if (remaining >= 0) $('mission-countdown').textContent = `Time Left: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    const leaderboard = readCString(x.openbw_mission_leaderboard()).trim();
    $('mission-leaderboard').hidden = !leaderboard;
    if (leaderboard) {
      const lines = leaderboard.split('\n');
      const [title, unit] = lines.shift().split('\t').map(Number);
      const label = missionString(title) || missionText(x.openbw_mission_unit_name(unit));
      $('mission-leaderboard').textContent = [label, ...lines.map(line => { const [owner, count] = line.split('\t').map(Number); return `${owner === mySlot ? 'You' : `Player ${owner + 1}`}: ${count}`; })].join('  ');
    }
    if (missionTicks >= captionUntil) $('mission-caption').hidden = true;
    const caption = $('mission-caption');
    if (!caption.hidden) {
      caption.style.left = '';
      caption.style.width = '';
      caption.style.top = '';
      caption.style.transform = '';
      const bounds = caption.getBoundingClientRect();
      const objectives = $('mission-hud').getBoundingClientRect();
      if (bounds.left < objectives.right && bounds.right > objectives.left && bounds.top < objectives.bottom && bounds.bottom > objectives.top) {
        const available = objectives.left - 28;
        if (available >= 280) {
          caption.style.left = '14px';
          caption.style.width = `${Math.min(520, available)}px`;
          caption.style.transform = 'none';
        } else caption.style.top = `${objectives.bottom + 8}px`;
      }
    }
  }
  let briefingPlaying = false, briefingIndex = 0, briefingClock = 0, briefingUntil = 0, briefingLast = 0;
  let briefingActions = [];
  let briefingTalkingUntil = 0;
  const briefingPortraits = new Map();
  function showBriefingPortrait(slot) {
    const unit = briefingPortraits.get(slot);
    $('briefing-portrait').hidden = unit === undefined;
    $('briefing-speaker').textContent = unit === undefined ? '' : narratorName(unit);
    if (unit !== undefined) { $('briefing-portrait').src = iconURL(unit); $('briefing-portrait').alt = narratorName(unit); }
  }
  function briefingFrame(now) {
    if (!briefingActive || !briefingPlaying) return;
    if (!document.hidden) briefingClock += Math.min(100, Math.max(0, now - briefingLast));
    briefingLast = now;
    if (briefingClock >= briefingTalkingUntil) $('briefing-portrait').dataset.talking = 'false';
    while (briefingPlaying && briefingClock >= briefingUntil && briefingIndex < briefingActions.length) {
      const [type, text, sound, time, slot, amount, modifier, unit] = briefingActions[briefingIndex++];
      if (type === 1) briefingUntil = briefingClock + Math.max(0, time);
      if (type === 2 || type === 8) playNarration(sound, type === 2 ? narrationChannel - 1 : narrationChannel);
      if (type === 3 || type === 8) $('briefing-text').textContent = missionString(text);
      if (type === 4) $('briefing-objectives').textContent = missionString(text);
      if (type === 5) { briefingPortraits.set(slot, unit); showBriefingPortrait(slot); }
      if (type === 6) { briefingPortraits.delete(slot); showBriefingPortrait(slot); }
      if (type === 7) {
        showBriefingPortrait(slot);
        briefingTalkingUntil = briefingClock + Math.max(0, time);
        $('briefing-portrait').dataset.talking = 'true';
      }
      if (type === 8) {
        showBriefingPortrait(slot);
        briefingUntil = briefingClock + x.openbw_mission_transmission_time(time, amount, modifier);
      }
    }
    if (briefingIndex === briefingActions.length && briefingClock >= briefingUntil) {
      briefingPlaying = false;
      $('briefing-state').textContent = 'Complete';
      $('briefing-play').querySelector('span').textContent = 'Replay Briefing';
    }
  }
  if (session.mission) {
    const stream = readCString(x.openbw_mission_briefing()).trim();
    briefingActions = stream ? stream.split('\n').map(line => line.split('\t').map(Number)) : [];
    $('briefing-title').textContent = session.mission.title;
    const objectives = briefingActions.find(action => action[0] === 4);
    if (objectives) $('briefing-objectives').textContent = missionString(objectives[1]);
    $('mission-briefing').hidden = false;
    $('briefing-play').focus();
    $('briefing-play').onclick = () => {
      stopNarration(); ensureAudio();
      briefingPortraits.clear();
      briefingIndex = 0; briefingClock = 0; briefingUntil = 0; briefingLast = performance.now();
      briefingPlaying = true;
      $('briefing-state').textContent = 'Playing';
      $('briefing-text').textContent = '';
    };
    $('briefing-begin').onclick = () => {
      stopNarration(); ensureAudio();
      briefingPlaying = false; briefingActive = false;
      $('mission-briefing').hidden = true;
      $('mission-hud').hidden = false;
      x.openbw_mission_begin();
      stepClock = performance.now();
      saveCurrentGame(`auto:${session.mission.id}`).catch(() => {});
    };
    $('briefing-return').onclick = returnToStartup;
  }

  let cardPointer = null;
  const updateCard = () => {
    if (cardPointer !== null) return;
    const ptr = x.openbw_card();
    const text = ptr ? readCString(ptr) : '';
    const mobile = coarsePointer();
    const cursor = x.openbw_cursor();
    const targeting = cursor === 1 || cursor === 2 || cursor === 4;
    const touchCard = text + '\n' + cursor;
    if (mobile && touchCard !== lastTouchCard) {
      lastTouchCard = touchCard;
      const rows = text.split('\n');
      const title = rows.shift().split('\t')[0];
      const commands = rows.map(row => row.split('\t'));
      const buildMenu = title === 'Build' || title === 'Advanced Build';
      document.body.classList.toggle('touch-building-menu', buildMenu);
      const canMove = commands.some(command => command[1] === 'Move');
      const hasDetails = commands.some(command => +command[4] || +command[5] || command[7] || command[8]);
      $('touch-queue').hidden = !canMove || buildMenu;
      $('touch-info').hidden = targeting || !hasDetails;
      document.body.classList.toggle('touch-targeting', targeting);
      if ($('touch-info').hidden && wireInput.inspect) {
        wireInput.inspect = false;
        $('touch-info').setAttribute('aria-pressed', 'false');
      }
    }
    if (!mobile) document.body.classList.remove('touch-building-menu', 'touch-targeting');
    const presentation = mobile + '\n' + text;
    if (presentation === lastCard) return;
    lastCard = presentation;
    if (!text) { cardEl.innerHTML = ''; lastBtnSig = null; return; }
    const lines = text.split('\n');
    const buildMenu = lines[0].split('\t')[0] === 'Build';
    if (mobile && buildMenu) {
      const commands = lines.slice(1);
      const ids = commands.map(command => command.split('\t')[3]);
      touchBuildOrder = touchBuildOrder.filter(id => ids.includes(id));
      for (const id of ids) if (!touchBuildOrder.includes(id)) touchBuildOrder.push(id);
      commands.sort((left, right) => touchBuildOrder.indexOf(left.split('\t')[3]) - touchBuildOrder.indexOf(right.split('\t')[3]));
      lines.splice(1, lines.length - 1, ...commands);
    } else touchBuildOrder = [];
    // Title line: name \t "HP x/y" \t <second stat, e.g. Shields / Minerals — may be empty>.
    // It ticks every frame whenever the unit's HP/energy changes — e.g. a building whose HP
    // counts up during construction. Rebuilding the whole card each tick replaces the button
    // nodes, and a click needs its mousedown and mouseup on the *same* node — so a mid-build
    // rebuild between press and release silently ate the click (why "the Cancel button does
    // nothing" while its hotkey worked). Build the title and the button grid separately and
    // only touch the button DOM when the button set itself changes.
    const t0 = lines[0].split('\t');
    cardEl.classList.toggle('building-menu', t0[0] === 'Build' || t0[0] === 'Advanced Build');
    let titleHtml = `<span class="title">${t0[0]}</span>`;
    if (t0[1]) titleHtml += `<span class="stat">${t0[1]}</span>`;
    if (t0[2]) titleHtml += `<span class="stat">${t0[2]}</span>`;
    if (t0[3]) titleHtml += `<span class="fx">${t0[3]}</span>`;   // status effects (blind, parasite, …)
    const btnSig = mobile + '\n' + lines.slice(1).join('\n');
    if (btnSig === lastBtnSig) {
      // Buttons unchanged: refresh only the title spans, leaving the .cmd nodes (and any
      // in-flight click on them) intact.
      cardEl.querySelector('.card-heading').innerHTML = titleHtml;
      return;
    }
    lastBtnSig = btnSig;
    const ri = getResIcons();   // mineral / gas sprite icons for the cost popup
    let html = '';
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split('\t');   // KEY, Label, enabled(1/0), iconUnitId(-1 = none)
      if (f.length < 2) continue;
      const off = f[2] === '0' ? ' off' : '';
      const id = f.length > 3 ? parseInt(f[3], 10) : -1;
      const building = id >= 106 && id <= 173;
      const url = id >= 0 ? iconURL(id) : '';
      const ico = mobile && f[1] === 'Confirm' ? '<i class="ico" data-lucide="check"></i>'
        : url ? `<img class="ico" src="${url}">` : '';
      // Highlight the hotkey letter inside the label (first match — usually the first
      // letter, else an inner letter like "Medi[c]"). Fall back to a badge if absent.
      // Key 0x1b is Escape (Cancel, as in the original) — show it as an "Esc" badge and
      // encode data-key as a numeric entity so the char survives in the attribute.
      const esc27 = f[0].charCodeAt(0) === 27;
      const dataKey = esc27 ? '&#27;' : f[0];
      const key = f[0].toLowerCase(), label = f[1];
      const k = esc27 ? -1 : label.toLowerCase().indexOf(key);
      const labelHtml = esc27
        ? `<b>Esc</b> ${label}`
        : k >= 0
          ? `${label.slice(0, k)}<b>${label[k]}</b>${label.slice(k + 1)}`
          : `<b>${f[0].toUpperCase()}</b> ${label}`;
      // Resource cost: tooltip on hover, and mark red when unaffordable.
      const minC = f.length > 4 ? +f[4] : 0, gasC = f.length > 5 ? +f[5] : 0;
      const poor = f.length > 6 && f[6] === '0' ? ' poor' : '';
      // Immediate cost popup shown on hover (native title tooltips are too slow to notice),
      // fronting each amount with the same delivery sprite used in the resource HUD.
      const mIco = ri[0] ? `<img class="cico" src="${ri[0]}">` : '';
      const gIco = ri[1] ? `<img class="cico" src="${ri[1]}">` : '';
      const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      // Popup on hover: description, missing prerequisite and price, including unavailable commands.
      const desc = f.length > 8 ? f[8] : '';
      const costInner = (minC || gasC)
        ? `<b class="m">${mIco}${minC}</b>${gasC ? ` <b class="g">${gIco}${gasC}</b>` : ''}`
        : '';
      const req = f.length > 7 ? f[7] : '';
      const requirement = off && req ? `<div class="d">Requires ${esc(req)}</div>` : '';
      const popup = (desc || costInner || requirement)
        ? `<span class="cost"><div class="d">${esc(label)}</div>${desc ? `<div class="d">${esc(desc)}</div>` : ''}${requirement}${costInner ? `<div>${costInner}</div>` : ''}</span>`
        : '';
      // Light up the button matching the unit's current order (Move while moving, etc.).
      const active = f.length > 9 && f[9] === '1' ? ' active' : '';
      // Wrap the label in one span so the flex `gap` on .cmd spaces only the icon from
      // the label — not the highlighted <b> from the rest of the word ("B uild").
      html += `<button type="button" class="cmd${off}${poor}${active}" data-key="${dataKey}" data-building="${building}" aria-label="${esc(label)}" aria-disabled="${!!off}" aria-expanded="false">${ico}<span class="lbl">${mobile ? esc(label) : labelHtml}</span><span class="touch-cost">${costInner}</span>${popup}</button>`;
    }
    const scrollLeft = cardEl.querySelector('.command-grid')?.scrollLeft || 0;
    cardEl.innerHTML = `<div class="card-heading">${titleHtml}</div><div class="command-grid">${html}</div>`;
    if (mobile && window.lucide) window.lucide.createIcons();
    if (mobile && buildMenu) cardEl.querySelector('.command-grid').scrollLeft = scrollLeft;
  };

  cardEl.addEventListener('pointerdown', event => {
    cardPointer = event.pointerId;
    buildPointerX = event.clientX;
    buildDragged = false;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    window.addEventListener(type, event => {
      if (cardPointer === event.pointerId) cardPointer = null;
    }, { capture: true });
  }
  cardEl.addEventListener('pointermove', event => {
    if (coarsePointer() && cardEl.classList.contains('building-menu') && Math.abs(event.clientX - buildPointerX) > 8)
      buildDragged = true;
  });
  cardEl.addEventListener('pointercancel', () => { buildDragged = true; });

  // Clicking a card button does the same as pressing its key (shift-click queues).
  // Grayed buttons still dispatch — the sim decides (a spell blocked on energy raises the
  // "Not enough energy" toast; other unavailable commands are simply consumed).
  cardEl.addEventListener('click', (e) => {
    const cmd = e.target.closest('.cmd');
    if (!cmd) return;
    if (coarsePointer() && cardEl.classList.contains('building-menu') && buildDragged && e.detail > 0) return;
    if (coarsePointer() && wireInput.inspect) {
      const expanded = !cmd.classList.contains('inspect');
      for (const command of cardEl.querySelectorAll('.cmd')) {
        command.classList.toggle('inspect', expanded && command === cmd);
        command.setAttribute('aria-expanded', String(expanded && command === cmd));
      }
      return;
    }
    const key = cmd.dataset.key;
    if (!key) return;
    const queued = e.shiftKey || (coarsePointer() && wireInput.queue);
    x.openbw_key(queued ? 1 : 0, 0, 225);
    const sym = key.charCodeAt(0);
    x.openbw_key(1, sym, 0); x.openbw_key(0, sym, 0);
    x.openbw_render(performance.now());
    if (!e.shiftKey) {
      x.openbw_key(0, 0, 225);
    }
  });

  // Group wireframes: one 32x32 tile per selected unit when 2+ are selected (BW's
  // multi-selection row). openbw_wires() lists "id\tname\thp\tmax\tstate" per unit; the
  // canvases are rebuilt only when ids or damage states change (a rebuild between mousedown
  // and mouseup eats the click — same lesson as the command card), while the HP tooltips
  // update in place every tick.
  const wiresEl = $('wires');
  let lastWireSig = '';
  const updateWires = () => {
    if (!x.openbw_wires) return;   // stale wasm module mid-dev: degrade, don't kill the loop
    const t = readCString(x.openbw_wires());
    // 64 = single selection's big wireframe, 32 = group tiles. Feature-detected: three wasm
    // modules share this JS, and an older module mid-dev must degrade, not kill the loop.
    const box = x.openbw_wire_box ? x.openbw_wire_box() : 32;
    const rows = t ? t.trim().split('\n').map((l) => l.split('\t')) : [];
    const sig = box + '|' + rows.map((r) => r[0] + ':' + r[4]).join(',');
    if (sig !== lastWireSig) {
      lastWireSig = sig;
      wiresEl.innerHTML = '';
      rows.forEach((r, i) => {
        const ptr = x.openbw_wire_rgba(i);
        if (!ptr) return;
        const c = document.createElement('canvas');
        c.width = box; c.height = box;
        const g = c.getContext('2d');
        const img = g.createImageData(box, box);
        img.data.set(new Uint8Array(memory.buffer, ptr, box * box * 4));
        g.putImageData(img, 0, 0);
        // Big single frame displays 1:1 (64px): its 1px lines decimate badly below native
        // size under pixelated scaling. Group tiles get a slight upscale.
        c.style.width = c.style.height = (box === 64 ? 64 : 38) + 'px';
        if (box === 64) c.className = 'big';   // padded background around the single big frame
        c.dataset.id = r[0];
        c.onclick = () => x.openbw_debug_select(+c.dataset.id, 0);   // click = select just this unit
        wiresEl.appendChild(c);
      });
    }
    // tooltips track HP without touching the canvas nodes
    const kids = wiresEl.children;
    for (let i = 0; i < rows.length && i < kids.length; i++)
      kids[i].title = `${rows[i][1]} — HP ${rows[i][2]}/${rows[i][3]}`;
  };

  // Producer status: "<progress%>\t<name(training)>\t<queued>…". The progress ticks
  // every frame, so only rebuild the chips when the item list changes and just move the
  // bar otherwise — rebuilding the whole thing each frame flickers and eats clicks.
  const statusEl = $('status');
  let lastStatusKey = null, statusBar = null, lastBarPct = -1;
  const BAR_W = 61;   // internal width; quantised the same way the wasm renderer expects
  const updateStatus = () => {
    const ptr = x.openbw_status();
    const text = ptr ? readCString(ptr) : '';
    const p = text ? text.split('\t') : [];
    const key = p.slice(1).join('\t');   // the chips (names), independent of progress
    if (key !== lastStatusKey) {
      lastStatusKey = key;
      statusBar = null; lastBarPct = -1;
      if (!text) { statusEl.innerHTML = ''; return; }
      // Progress bar is a <canvas> rendered from the same health-bar palette the engine
      // draws under units, so it matches the original exactly.
      let html = `<canvas class="bar"></canvas>`;
      // p[1..] are the queued units in order; chip i maps to build-queue slot i-1.
      for (let i = 1; i < p.length; i++)
        html += `<span class="q${i === 1 ? ' cur' : ''}" data-slot="${i - 1}" title="Click to cancel">${p[i]}</span>`;
      statusEl.innerHTML = html;
      statusBar = statusEl.querySelector('.bar');
    }
    if (statusBar) {
      const pct = Math.max(0, Math.min(100, parseInt(p[0], 10) || 0));
      if (pct === lastBarPct) return;
      lastBarPct = pct;
      const bp = x.openbw_progress_bar(pct, BAR_W);
      const w = x.openbw_progress_bar_w(), h = x.openbw_progress_bar_h();
      if (!bp || !w || !h) return;
      if (statusBar.width !== w || statusBar.height !== h) { statusBar.width = w; statusBar.height = h; }
      const bctx = statusBar.getContext('2d');
      const img = bctx.createImageData(w, h);
      img.data.set(new Uint8Array(memory.buffer, bp, w * h * 4));
      bctx.putImageData(img, 0, 0);
    }
  };
  // Cancel a queued item (resources refunded). mousedown, not click: acts on the press
  // and stays reliable even if the chip list happens to rebuild mid-interaction.
  statusEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const q = e.target.closest('.q');
    if (q && q.dataset.slot !== undefined) x.openbw_cancel(+q.dataset.slot);
  });

  // Resource HUD: "minerals\tgas\tsupply_used\tsupply_max".
  const resEl = $('resources');
  let lastRes = '';
  // The mineral/gas icons are the sprites a worker carries when delivering — a blue
  // mineral chunk and a green gas container (per race). They never change, so build
  // the data URLs once (after the game is up, so the palette is loaded).
  const resIconURL = (which) => {
    const ptr = x.openbw_res_icon(which), w = x.openbw_icon_w(), h = x.openbw_icon_h();
    if (!ptr || !w || !h) return '';
    iconCanvas.width = w; iconCanvas.height = h;
    const img = ictx.createImageData(w, h);
    img.data.set(new Uint8Array(memory.buffer, ptr, w * h * 4));
    ictx.putImageData(img, 0, 0);
    return iconCanvas.toDataURL();
  };
  // [0]=mineral chunk, [1]=gas container, [2]=supply provider. Cached once the palette
  // is loaded; shared by the HUD and the command-card cost popup.
  let resIcons = null;
  const getResIcons = () => {
    if (resIcons) return resIcons;
    const r = [resIconURL(0), resIconURL(1), resIconURL(2)];
    if (r[0] && r[1] && r[2]) resIcons = r;
    return r;
  };
  const updateResources = () => {
    const ptr = x.openbw_resources();
    const text = ptr ? readCString(ptr) : '';
    if (text === lastRes) return;
    lastRes = text;
    if (!text) { resEl.innerHTML = ''; return; }
    const ri = getResIcons();
    const [min, gas, used, max] = text.split('\t');
    const cap = (+used >= +max) ? ' cap' : '';
    const ico = (u, cls) => u ? `<img class="rico" src="${u}">` : `<span class="dot ${cls}"></span>`;
    resEl.innerHTML =
      `<span class="r min">${ico(ri[0], 'min')}${min}</span>` +
      `<span class="r gas">${ico(ri[1], 'gas')}${gas}</span>` +
      `<span class="r sup">${ico(ri[2], 'sup')}<span class="${cap}">${used}/${max}</span></span>`;
  };

  // Blocked-command toast: openbw_error() returns "seq\tmessage"; flash the message
  // whenever seq changes (e.g. "Not enough minerals" when a build is unaffordable).
  const toastEl = $('toast');
  let lastErrSeq = -1, toastTimer = 0;
  const updateError = () => {
    const ptr = x.openbw_error();
    const text = ptr ? readCString(ptr) : '';
    if (!text) return;
    const tab = text.indexOf('\t');
    const seq = +text.slice(0, tab), msg = text.slice(tab + 1);
    if (seq === lastErrSeq) return;
    lastErrSeq = seq;
    if (!msg) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  };

  // System message log (eliminations…): openbw_messages() is a newline-separated list the
  // sim ages out, so re-render only when it changes. textContent keeps it injection-safe.
  const msgEl = $('messages');
  let lastMsgText = null;
  const updateMessages = () => {
    const ptr = x.openbw_messages();
    const text = ptr ? readCString(ptr) : '';
    if (text === lastMsgText) return;
    lastMsgText = text;
    msgEl.textContent = '';
    if (!text) return;
    for (const line of text.split('\n')) {
      const d = document.createElement('div');
      d.className = 'msg';
      d.textContent = line;
      msgEl.appendChild(d);
    }
  };

  let iw = 0, ih = 0, image = null;
  // The engine draws the original BW cursor (animated arrow, hover circles, targeting
  // crosshairs, edge-scroll arrows) into the frame itself — hide the OS cursor over the
  // canvas so the two never show at once. This is also what pointer lock needs.
  const updateCursor = () => {
    if (canvas.style.cursor !== 'none') canvas.style.cursor = 'none';
  };

  // Native-resolution cursor overlay: the engine rasterizes the current BW cursor
  // frame (RGBA, hotspot = box centre) and we draw it in a fixed-size element above
  // everything — constant size at any zoom, and visible over the DOM HUD under
  // pointer lock. Null RGBA (cursor parked / assets missing) hides it, which also
  // covers hovering the HUD unlocked: the canvas mouseleave parks the engine cursor.
  let curCanvas = null, curCtx = null, curImg = null, curBox = 0;
  if (x.openbw_cursor_rgba) {
    curBox = x.openbw_cursor_box();
    curCanvas = document.createElement('canvas');
    curCanvas.width = curBox; curCanvas.height = curBox;
    curCanvas.style.cssText = 'position:fixed;left:0;top:0;width:' + curBox + 'px;height:' + curBox +
      'px;pointer-events:none;z-index:1000;image-rendering:pixelated;display:none';
    document.body.appendChild(curCanvas);
    curCtx = curCanvas.getContext('2d');
    curImg = curCtx.createImageData(curBox, curBox);
  }
  const updateCursorOverlay = () => {
    if (!curCanvas) return;
    const ptr = x.openbw_cursor_rgba();
    if (!ptr) { curCanvas.style.display = 'none'; return; }
    curImg.data.set(new Uint8Array(memory.buffer, ptr, curBox * curBox * 4));
    curCtx.putImageData(curImg, 0, 0);
    const [px, py] = wireInput.cursorPos();
    const r = canvas.getBoundingClientRect();
    const cx = r.left + px * r.width / canvas.width, cy = r.top + py * r.height / canvas.height;
    curCanvas.style.transform = 'translate(' + (cx - curBox / 2) + 'px,' + (cy - curBox / 2) + 'px)';
    curCanvas.style.display = 'block';
  };

  function renderFrame() {
    briefingFrame(performance.now());
    x.openbw_render(performance.now());
    const w = x.openbw_framebuffer_width(), h = x.openbw_framebuffer_height(), ptr = x.openbw_framebuffer();
    if (w && h && ptr) {
      if (w !== iw || h !== ih) { iw = w; ih = h; canvas.width = w; canvas.height = h; image = ctx.createImageData(w, h); }
      image.data.set(new Uint8Array(memory.buffer, ptr, w * h * 4));
      ctx.putImageData(image, 0, 0);
    }
    updateCard();
    updateWires();
    updateStatus();
    updateResources();
    updateError();
    updateMessages();
    updateCursor();
    updateCursorOverlay();
    updateMissionHud();
    requestAnimationFrame(frame);
  }
  function frame() {
    if (sessionFailed) return;
    try { renderFrame(); } catch (error) { failSession(error); }
  }
  async function saveCurrentGame(key) {
    if (!session.mission || campaignDebug || briefingActive || recovering || over || sessionFailed || x.openbw_outcome()) return;
    const camera = readCString(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    const selection = readCString(x.openbw_wires()).trim().split('\n').filter(Boolean).map(line => Number(line.split('\t')[0]));
    const payload = {
      ...saveCompatibility, title: session.mission.title, ticks: missionTicks, frame: x.openbw_frame(), checksum: x.openbw_checksum() >>> 0, savedAt: Date.now(),
      turns: missionTurns.map(turn => ({ tick: turn.tick, bytes: turn.bytes.slice() })),
      view: { camera: camera ? [Math.max(0, Number(camera[1])), Math.max(0, Number(camera[2]))] : [0, 0], selection },
      caption: { text: $('mission-caption-text').textContent, speaker: $('mission-caption-speaker').textContent, remaining: $('mission-caption').hidden ? 0 : Math.max(0, captionUntil - missionTicks) },
    };
    try {
      const storage = await campaignSaves();
      await storage.writeCampaignSave(key, storage.sealCampaignSave(payload));
      $('save-status').textContent = `${key.startsWith('auto:') ? 'Autosaved' : 'Saved'} ${new Date(payload.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      return true;
    } catch (error) {
      $('save-status').textContent = `Save failed: ${error.message}`;
      throw error;
    }
  }
  if (session.mission && !campaignDebug) {
    $('campaign-save-controls').hidden = false;
    const saveButton = $('save-game');
    saveButton.onclick = async () => {
      saveButton.disabled = true;
      try { await saveCurrentGame($('save-slot').value); } catch {}
      finally { saveButton.disabled = false; }
    };
    $('campaign-menu').onclick = async () => {
      if ($('campaign-menu').dataset.discard === '1') { toMainMenu(); return; }
      try {
        if (!over && !briefingActive && !await saveCurrentGame(`auto:${session.mission.id}`)) return;
        toMainMenu();
      } catch {
        $('campaign-menu').dataset.discard = '1';
        $('campaign-menu').innerHTML = '<i data-lucide="arrow-left"></i>Leave Without Saving';
        window.lucide?.createIcons();
      }
    };
    const autosave = () => saveCurrentGame(`auto:${session.mission.id}`).catch(() => {});
    const saveTimer = setInterval(autosave, 15000);
    saveBeforeLeave = autosave;
    document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });
    addEventListener('pagehide', () => clearInterval(saveTimer), { once: true });
    pauseBtn.addEventListener('click', () => { if (paused) autosave(); });
    if (session.resume) {
      clearTimeout(stepTimer);
      x.openbw_set_paused(1);
      const saved = session.resume;
      $('overlay').style.display = 'grid';
      $('controls').style.display = 'none';
      $('mission-briefing').hidden = true;
      briefingActive = false;
      briefingPlaying = false;
      x.openbw_mission_begin();
      stopNarration();
      let turn = 0;
      while (missionTicks < saved.ticks) {
        session.signal?.throwIfAborted();
        const until = performance.now() + 16;
        do {
          while (saved.turns[turn]?.tick === missionTicks) {
            const command = saved.turns[turn++];
            const input = x.openbw_in_ptr(command.bytes.length);
            new Uint8Array(memory.buffer).set(command.bytes, input);
            x.openbw_apply(mySlot, command.bytes.length);
          }
          x.openbw_step();
          missionTicks++;
          consumeMissionEvents();
          if (x.openbw_outcome()) throw new Error('Saved game reached an unexpected mission outcome.');
        } while (missionTicks < saved.ticks && performance.now() < until);
        setMsg(`Restoring ${session.mission.title}: ${Math.floor(missionTicks * 100 / Math.max(1, saved.ticks))}%`);
        setBar(missionTicks / Math.max(1, saved.ticks));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      session.signal?.throwIfAborted();
      if (turn !== saved.turns.length || x.openbw_frame() !== saved.frame || (x.openbw_checksum() >>> 0) !== saved.checksum) throw new Error('Saved game could not be reconstructed exactly.');
      for (const command of saved.turns) missionTurns.push({ tick: command.tick, bytes: command.bytes.slice() });
      lockstep.frame = saved.ticks;
      lockstep.nextLocalFrame = saved.ticks;
      x.openbw_render(performance.now());
      const camera = readCString(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
      if (camera) x.openbw_pan(saved.view.camera[0] - Number(camera[1]), saved.view.camera[1] - Number(camera[2]));
      for (let index = 0; index < saved.view.selection.length; index++) x.openbw_debug_select(saved.view.selection[index], index ? 1 : 0);
      if (saved.caption?.remaining) {
        $('mission-caption-text').textContent = saved.caption.text;
        $('mission-caption-speaker').textContent = saved.caption.speaker;
        $('mission-caption').hidden = false;
        captionUntil = missionTicks + saved.caption.remaining;
      }
      recovering = false;
      paused = true;
      x.openbw_set_paused(1);
      applyPause();
      $('mission-hud').hidden = false;
      $('overlay').style.display = 'none';
      $('save-status').textContent = 'Saved game restored.';
      stepClock = performance.now();
      stepTimer = setTimeout(stepLoop, stepMs);
    }
    const address = new URL(location.href);
    address.searchParams.delete('fresh');
    address.searchParams.delete('resume');
    history.replaceState(null, '', address);
  }
  requestAnimationFrame(frame);
}

// Bot vs Bot (spectate). Two bot MODULES are two independent BWAPI singletons, so we run
// two deterministic sim replicas: each frame we tick each bot on its OWN replica, then
// apply BOTH bots' commands to BOTH replicas and step them. Identical sim + identical
// command stream => bit-identical (asserted via openbw_checksum). Replica A is rendered
// with fog off (spectator); replica B just produces its bot's orders. Human input is
// camera-only — a stray command to one replica alone would desync them.
// Map choice applies to both single-player and multiplayer, so it lives outside the
// multiplayer panel.
const mapSelect = $('map-select');

// The title doubles as a way back to a clean URL. An invite link leaves #i=... in the
// address bar, so a joiner who reloads re-enters the join flow with the *old* code —
// clicking here drops the fragment and query and forces a genuine reload (dropping a
// fragment alone is a same-document navigation, which would keep the stale page state).
{
  const bare = location.origin + location.pathname;
  const home = $('home');
  home.href = bare;
  home.addEventListener('click', (e) => {
    e.preventDefault();
    if (location.href !== bare) location.replace(bare);
    location.reload();
  });
}

// Solo lobby: pick your race and, for each other start location on the map, an
// opponent — ZZZKBot (Zerg) or None. (One bot for now; the rest are empty.) The
// slot rows rebuild when the map changes, since the map decides how many there are.
$('controls').style.display = 'block';
setMsg('Set up your game.');
// Warn on mobile: no touch controls yet, and the first run pulls ~90 MB.
if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (window.matchMedia && matchMedia('(pointer: coarse)').matches))
  $('mobilewarn').style.display = 'block';

const YOU_RACES = [[1, 'Terran'], [0, 'Zerg'], [2, 'Protoss'], [-1, 'Random']];   // value = race_t, -1 = random
// Computer opponents: dropdown value -> which wasm module + which race it plays.
// race_t: Zerg 0, Terran 1, Protoss 2. McRave is multi-race (one module per race).
const OPPONENTS = {
  zzzk:       { label: 'ZZZKBot (Zerg)',    module: 'openbw-bot.wasm',    race: 0 },
  'mcrave-p': { label: 'McRave (Protoss)',  module: 'openbw-mcrave.wasm', race: 2 },
  'mcrave-t': { label: 'McRave (Terran)',   module: 'openbw-mcrave.wasm', race: 1 },
  'mcrave-z': { label: 'McRave (Zerg)',     module: 'openbw-mcrave.wasm', race: 0 },
};
// ZZZKBot as the default: McRave is the stronger bot but its code has latent
// unbounded-loop bugs (see mcrave.patch's "wasm port" guards) — one rare mid-game
// spin is still unlocated, so the default opponent is the one with a clean record.
const DEFAULT_OPP = DEV ? 'none' : 'zzzk';
const slotsBox = $('slots');
const curMap = () => MAPS.find((m) => m.file === mapSelect.value) || MAPS[0];

function renderMapInfo() {
  const m = curMap();
  $('map-info').textContent = `${m.w}×${m.h} · ${m.tileset} · ${m.starts} players`;
}
function updateHint() {
  if ($('spectate').checked) { $('lobby-hint').textContent = 'Watch two bots play.'; return; }
  const anyBot = slotsBox._opps.some((s) => s.value !== 'none');
  $('lobby-hint').textContent = anyBot ? '' : 'No opponent — sandbox mode (no win or loss).';
}
// (Re)build the You + opponent rows for the current map's start-location count. When
// spectating, slot 0 ("You") becomes a second bot picker.
function buildSlots() {
  const m = curMap();
  const spectate = $('spectate').checked;
  slotsBox.innerHTML = '';
  const you = document.createElement('select');   // slot 0: You, or Bot 1 when spectating
  if (spectate) { for (const [val, o] of Object.entries(OPPONENTS)) you.add(new Option(o.label, val)); you.value = 'zzzk'; }
  else { for (const [v, name] of YOU_RACES) you.add(new Option(name, v)); you.value = '1'; }
  const youLbl = document.createElement('span'); youLbl.className = 'lbl you'; youLbl.textContent = spectate ? 'Bot 1' : 'You';
  slotsBox.append(youLbl, you);
  const opps = [];
  for (let s = 1; s < m.starts; s++) {
    const lbl = document.createElement('span'); lbl.className = 'lbl';
    lbl.textContent = spectate && s === 1 ? 'Bot 2' : 'Slot ' + (s + 1);
    const sel = document.createElement('select'); sel.dataset.slot = String(s);
    for (const [val, o] of Object.entries(OPPONENTS)) sel.add(new Option(o.label, val));
    sel.add(new Option('None', 'none'));
    sel.value = s === 1 ? DEFAULT_OPP : 'none';   // default to a 1v1 vs the bot
    // One bot for now: picking any bot here clears any other bot slot back to None.
    sel.onchange = () => {
      if (sel.value !== 'none') for (const o of opps) if (o !== sel && o.value !== 'none') o.value = 'none';
      updateHint();
    };
    slotsBox.append(lbl, sel);
    opps.push(sel);
  }
  slotsBox._you = you; slotsBox._opps = opps;
  updateHint();
}
// addEventListener (not .onchange) so the multiplayer panel's own map handler coexists.
mapSelect.addEventListener('change', () => { renderMapInfo(); buildSlots(); });
$('spectate').addEventListener('change', buildSlots);   // toggling swaps "You" for a 2nd bot
renderMapInfo(); buildSlots();

const campaignProgressKey = 'openbw-campaign-progress-v2';
const campaignLegacyProgressKey = 'openbw-campaign-progress-v1';
const campaignCodeLimit = 70;
const campaignDebug = new URLSearchParams(location.search).get('campaign-debug') === '1';
const selectedMission = new URLSearchParams(location.search).get('mission');
const campaignMissionIds = ['terran01', 'terran02', 'terran03', 'terran04', 'terran05', 'terran06', 'terran07', 'terran08', 'terran09', 'terran10', 'zerg01', 'zerg02'];
let campaignManifest = null;
let campaignDownload = null;
function campaignProgress() {
  let value = null, legacy = null;
  try {
    const saved = localStorage.getItem(campaignProgressKey);
    if (saved !== null) value = JSON.parse(saved);
    else legacy = JSON.parse(localStorage.getItem(campaignLegacyProgressKey) || 'null');
  } catch {}
  const importedPrefix = value?.version === 2 && value.victories && typeof value.victories === 'object' && !Array.isArray(value.victories) && Number.isInteger(value.importedPrefix) && value.importedPrefix >= 0 && value.importedPrefix <= campaignCodeLimit && campaignMissionIds.slice(0, value.importedPrefix).every(id => !Object.hasOwn(value.victories, id) || value.victories[id] === true) ? value.importedPrefix : 0;
  const victories = Object.fromEntries(campaignMissionIds.map((id, index) => [id, value?.version === 2 ? value.victories?.[id] === true || index < importedPrefix : legacy?.version === 1 && Array.isArray(legacy.completed) && legacy.completed.includes(id)]));
  const completed = campaignMissionIds.filter(id => victories[id]);
  if (!campaignDebug && legacy?.version === 1 && Array.isArray(legacy.completed)) {
    try { saveCampaignProgress({ victories, importedPrefix: 0 }); } catch {}
  }
  return { version: 2, victories, completed, importedPrefix };
}
function saveCampaignProgress(progress) {
  localStorage.setItem(campaignProgressKey, JSON.stringify({ version: 2, victories: progress.victories, importedPrefix: progress.importedPrefix || 0 }));
}
function campaignSequentialProgress(progress = campaignProgress()) {
  let cleared = 0;
  while (cleared < campaignMissionIds.length && progress.victories[campaignMissionIds[cleared]]) cleared++;
  return Math.max(cleared, progress.importedPrefix);
}
function campaignProgressCode(completed) {
  if (!Number.isInteger(completed) || completed < 0 || completed > campaignCodeLimit) throw new Error('Unsupported campaign progress.');
  return cyrb53(new TextEncoder().encode(`OpenBW campaign progress v1:${completed}`)).slice(-6);
}
function campaignDecodeCode(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toLowerCase();
  if (!/^[a-f0-9]{6}$/.test(normalized)) return null;
  for (let completed = 0; completed <= campaignCodeLimit; completed++) if (campaignProgressCode(completed) === normalized) return completed;
  return null;
}
function campaignApplyCode(code) {
  if (campaignDebug) throw new Error('Progress codes are disabled in debug mode.');
  const completed = campaignDecodeCode(code);
  if (completed === null) throw new Error('Invalid six-character progress code.');
  const progress = campaignProgress();
  if (completed <= campaignSequentialProgress(progress)) return false;
  for (const id of campaignMissionIds.slice(0, completed)) progress.victories[id] = true;
  progress.importedPrefix = completed;
  saveCampaignProgress(progress);
  return true;
}
function campaignUnlocked(missionId) {
  const index = campaignMissionIds.indexOf(missionId);
  const victories = campaignProgress().victories;
  return index >= 0 && (campaignDebug || campaignMissionIds.slice(0, index).every(id => victories[id] === true));
}
function selectGameMode(campaign) {
  if (!campaign) probeMeleeMaps();
  $('mode-sandbox').setAttribute('aria-selected', String(!campaign));
  $('mode-campaign').setAttribute('aria-selected', String(campaign));
  $('campaign-setup').hidden = !campaign;
  $('overlay').classList.add('menu-mode');
  for (const id of ['map-row', 'map-info', 'slots', 'spectate-row', 'lobby-hint', 'sandbox-start', 'mp']) $(id).hidden = campaign;
  if (campaign) loadSelectedMission();
}
function loadSelectedMission() {
  for (const option of $('mission-select').options) option.disabled = !campaignUnlocked(option.value);
  if (!campaignUnlocked($('mission-select').value)) $('mission-select').value = campaignMissionIds.find(id => campaignUnlocked(id) && !campaignProgress().completed.includes(id)) || campaignMissionIds[0];
  const missionId = $('mission-select').value;
  if (!campaignMissionIds.includes(missionId)) return;
  $('campaign-selected-name').textContent = $('mission-select').selectedOptions[0].textContent;
  renderCampaignSelection();
  refreshCampaignSaves(missionId);
  campaignManifest = null;
  const complete = campaignProgress().completed.includes(missionId);
  $('mission-size').textContent = complete ? 'Completed' : '';
  fetch(`data/campaign/${missionId}.json`).then(response => {
    if (!response.ok) throw new Error('Mission download unavailable.');
    return response.json();
  }).then(manifest => {
    validateMissionManifest(manifest, missionId);
    if ($('mission-select').value !== missionId) return;
    campaignManifest = manifest;
    $('mission-size').textContent = `${(manifest.pack.bytes / 1048576).toFixed(2)} MB${complete ? ' - completed' : ''}`;
  }).catch(error => { if ($('mission-select').value === missionId) $('mission-size').textContent = error.message; });
}
function renderCampaignSelection() {
  const progress = campaignProgress(), completed = progress.completed;
  const list = $('campaign-missions');
  if (!list.querySelector('input')) {
    let chapter = '';
    for (const option of $('mission-select').options) {
      const label = option.parentElement.label || '';
      if (label && label !== chapter) {
        const heading = document.createElement('h3'); heading.className = 'campaign-episode'; heading.textContent = label;
        list.append(heading); chapter = label;
      }
      const row = document.createElement('label');
      row.className = 'mission-row';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'campaign-mission'; radio.value = option.value;
      radio.onchange = () => { $('mission-select').value = radio.value; loadSelectedMission(); };
      const name = document.createElement('span');
      name.className = 'mission-name'; name.textContent = option.textContent;
      const state = document.createElement('span');
      state.className = 'mission-state';
      row.append(radio, name, state); list.append(row);
    }
  }
  for (const radio of list.querySelectorAll('input')) {
    radio.disabled = !campaignUnlocked(radio.value);
    radio.checked = radio.value === $('mission-select').value;
    const state = radio.parentElement.querySelector('.mission-state');
    state.textContent = radio.disabled ? completed.includes(radio.value) ? 'Won (locked)' : 'Locked' : completed.includes(radio.value) ? 'Completed' : 'Available';
    state.classList.toggle('completed', !radio.disabled && completed.includes(radio.value));
  }
  let cleared = 0;
  while (completed.includes(campaignMissionIds[cleared])) cleared++;
  $('campaign-progress').hidden = campaignDebug;
  $('campaign-tools').hidden = campaignDebug;
  $('campaign-code-tools').hidden = campaignDebug;
  $('campaign-code').value = campaignProgressCode(campaignSequentialProgress(progress));
  $('campaign-progress').querySelector('span').textContent = `${cleared} of ${campaignMissionIds.length} completed${completed.length > cleared ? ` - ${completed.length - cleared} later victories recorded` : ''}`;
  $('campaign-progress').querySelector('progress').max = campaignMissionIds.length;
  $('campaign-progress').querySelector('progress').value = cleared;
}
function campaignAddress(mission, resume = null, fresh = false) {
  const address = new URL(location.origin + location.pathname);
  address.searchParams.set('mission', mission);
  address.searchParams.set('autostart', '1');
  if (resume) address.searchParams.set('resume', resume);
  if (fresh) address.searchParams.set('fresh', '1');
  if (campaignDebug) address.searchParams.set('campaign-debug', '1');
  return address;
}
async function refreshCampaignSaves(mission) {
  if (campaignDebug) { $('campaign-resume').hidden = true; $('campaign-saves').replaceChildren(); return; }
  try {
    const storage = await campaignSaves();
    const summaries = await storage.listCampaignSaves();
    if ($('mission-select').value !== mission) return;
    const autosave = summaries.find(save => save.key === `auto:${mission}`);
    $('campaign-resume').hidden = !autosave;
    $('campaign-resume').onclick = () => location.replace(campaignAddress(mission, autosave.key));
    const container = $('campaign-saves');
    container.replaceChildren();
    if (!summaries.length) return;
    const heading = document.createElement('h3'); heading.textContent = 'Saved Games'; container.append(heading);
    for (const save of summaries) {
      const row = document.createElement('div'); row.className = 'campaign-save-row';
      const label = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = save.title;
      const detail = document.createElement('small');
      const seconds = Math.floor(save.frame / 16);
      detail.textContent = `${save.key.startsWith('auto:') ? 'Autosave' : `Slot ${save.key.split(':')[1]}`} - ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} - ${new Date(save.savedAt).toLocaleString()}`;
      label.append(title, detail);
      const resume = document.createElement('button'); resume.type = 'button'; resume.title = resume.ariaLabel = `Resume ${save.title}`;
      resume.innerHTML = '<i data-lucide="play"></i>'; resume.disabled = !campaignUnlocked(save.mission);
      resume.onclick = () => location.replace(campaignAddress(save.mission, save.key));
      const remove = document.createElement('button'); remove.type = 'button'; remove.title = remove.ariaLabel = `Delete ${save.title} ${save.key.startsWith('auto:') ? 'autosave' : `slot ${save.key.split(':')[1]}`}`;
      remove.innerHTML = '<i data-lucide="trash-2"></i>';
      remove.onclick = async () => {
        if (remove.dataset.confirm !== '1') { remove.dataset.confirm = '1'; remove.title = remove.ariaLabel = 'Confirm saved game deletion'; $('mission-size').textContent = `Delete ${save.title} saved game?`; return; }
        try { await storage.deleteCampaignSave(save.key); await refreshCampaignSaves($('mission-select').value); }
        catch (error) { $('mission-size').textContent = `Saved game could not be deleted: ${error.message}`; }
      };
      row.append(label, resume, remove); container.append(row);
    }
    window.lucide?.createIcons();
  } catch (error) { $('mission-size').textContent = `Saved games unavailable: ${error.message}`; }
}
function validateMissionManifest(manifest, missionId) {
  if (!campaignMissionIds.includes(missionId) || manifest.schemaVersion !== 1 || manifest.id !== missionId || !Number.isInteger(manifest.humanSlot) || manifest.humanSlot < 0 || manifest.humanSlot >= 8 || ![0, 1, 2].includes(manifest.race) || !Number.isInteger(manifest.contentVersion) || !Array.isArray(manifest.requirements) || !Array.isArray(manifest.files)) throw new Error('Unsupported mission manifest.');
  if (!Number.isInteger(manifest.pack?.bytes) || manifest.pack.bytes <= 32 || manifest.pack.bytes > 32 * 1048576 || !/^[a-f0-9]{64}$/.test(manifest.pack.sha256)) throw new Error('Invalid mission pack metadata.');
  const url = new URL(manifest.pack.url, location.href);
  if (url.origin !== location.origin || url.pathname !== new URL(`data/campaign/${missionId}.mpq`, location.href).pathname) throw new Error('Invalid mission pack location.');
  if (manifest.requirements.some(required => !/^(condition|action|briefing)\.\d+$/.test(required))) throw new Error('Invalid mission capability metadata.');
}
function campaignFailure(error) {
  console.error('[campaign]', error);
  $('overlay').style.display = 'grid';
  $('controls').style.display = 'none';
  $('load-actions').hidden = false;
  $('load-cancel').hidden = true;
  $('load-retry').hidden = false;
  $('load-return').hidden = false;
  $('mission-briefing').hidden = true;
  $('load-fresh').hidden = !campaignMissionIds.includes($('mission-select').value);
  setMsg(error.name === 'AbortError' ? 'Mission loading cancelled.' : `Mission unavailable: ${error.message}`);
}
const returnToStartup = () => location.replace(location.origin + location.pathname + (campaignDebug ? '?campaign=1&campaign-debug=1' : '?campaign=1'));
$('load-return').onclick = returnToStartup;
$('load-fresh').onclick = () => location.replace(campaignAddress($('mission-select').value, null, true));
$('load-retry').onclick = () => location.reload();
$('load-cancel').onclick = () => campaignDownload?.abort();
$('mode-sandbox').onclick = () => selectGameMode(false);
$('mode-campaign').onclick = () => selectGameMode(true);
$('mission-select').onchange = loadSelectedMission;
$('campaign-start').onclick = async () => {
  $('campaign-start').disabled = true;
  $('mission-select').disabled = true;
  $('campaign-missions').disabled = true;
  $('campaign-resume').disabled = true;
  campaignDownload = new AbortController();
  $('load-actions').hidden = false;
  $('load-cancel').hidden = false;
  $('load-retry').hidden = true;
  $('load-return').hidden = true;
  try {
    const missionId = $('mission-select').value;
    if (!campaignMissionIds.includes(missionId)) throw new Error('Unsupported mission selection.');
    if (!campaignUnlocked(missionId)) throw new Error('Complete the preceding missions first.');
    const parameters = new URLSearchParams(location.search);
    const resumeKey = campaignDebug ? null : parameters.get('resume') || (parameters.get('autostart') === '1' && parameters.get('fresh') !== '1' ? `auto:${missionId}` : null);
    let resume = null;
    if (resumeKey) {
      try { resume = await (await campaignSaves()).readCampaignSave(resumeKey); }
      catch (error) { if (parameters.has('resume')) throw error; $('mission-size').textContent = `Recovery unavailable: ${error.message}`; throw error; }
      if (!resume && parameters.has('resume')) throw new Error('Saved game was not found.');
      if (resume && resume.mission !== missionId) throw new Error('Saved game belongs to a different mission.');
    }
    if (campaignManifest?.id !== missionId) campaignManifest = null;
    if (!campaignManifest) {
      const response = await fetch(`data/campaign/${missionId}.json`, { signal: campaignDownload.signal });
      if (!response.ok) throw new Error(`Mission manifest HTTP ${response.status}`);
      campaignManifest = await response.json();
      validateMissionManifest(campaignManifest, missionId);
    }
    const address = new URL(location.href);
    address.searchParams.set('mission', campaignManifest.id);
    address.searchParams.set('autostart', '1');
    history.replaceState(null, '', address);
    $('controls').style.display = 'none';
    await boot({ mission: campaignManifest, resume, signal: campaignDownload.signal, slots: [{ slot: campaignManifest.humanSlot, race: campaignManifest.race }], mySlot: campaignManifest.humanSlot });
  } catch (error) { campaignFailure(error); }
};
$('campaign-delete').onclick = async () => {
  try {
    const db = await idbOpen();
    const transaction = db.transaction('assets', 'readwrite');
    const store = transaction.objectStore('assets');
    store.openKeyCursor().onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith('campaign:')) store.delete(cursor.key);
      cursor.continue();
    };
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
    db.close();
    $('mission-size').textContent = 'Mission downloads deleted.';
  } catch { $('mission-size').textContent = 'Mission downloads could not be deleted.'; }
};
$('campaign-code-copy').onclick = async () => {
  if (campaignDebug) return;
  const status = $('campaign-code-status');
  try { await navigator.clipboard.writeText($('campaign-code').value); status.textContent = 'Progress code copied.'; status.className = ''; }
  catch { $('campaign-code').focus(); $('campaign-code').select(); status.textContent = 'Clipboard unavailable.'; status.className = 'err'; }
};
$('campaign-code-apply').onclick = () => {
  const status = $('campaign-code-status');
  try {
    if (campaignApplyCode($('campaign-code-input').value)) {
      const progress = campaignProgress();
      $('mission-select').value = campaignMissionIds.find(id => !progress.victories[id] && campaignUnlocked(id)) || campaignMissionIds[campaignMissionIds.length - 1];
      loadSelectedMission();
      status.textContent = 'Campaign progress restored.';
    } else { renderCampaignSelection(); status.textContent = 'Code is not ahead of current progress.'; }
    status.className = '';
  } catch (error) { status.textContent = error.message; status.className = 'err'; }
};
$('campaign-code-input').oninput = () => { $('campaign-code-apply').disabled = !$('campaign-code-input').value.trim(); };
$('campaign-code-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !$('campaign-code-apply').disabled) $('campaign-code-apply').click(); });
$('campaign-reset').onclick = () => {
  const button = $('campaign-reset');
  if (button.dataset.confirm !== '1') {
    button.dataset.confirm = '1';
    button.title = button.ariaLabel = 'Confirm campaign progress reset';
    $('mission-size').textContent = 'Confirm progress reset.';
    return;
  }
  try { localStorage.removeItem(campaignProgressKey); localStorage.removeItem(campaignLegacyProgressKey); $('mission-size').textContent = 'Campaign progress reset.'; }
  catch { $('mission-size').textContent = 'Campaign progress could not be reset.'; }
  delete button.dataset.confirm;
  button.title = button.ariaLabel = 'Reset campaign progress';
  $('campaign-code-input').value = ''; $('campaign-code-apply').disabled = true; $('campaign-code-status').textContent = '';
  $('mission-select').value = campaignMissionIds[0];
  loadSelectedMission();
};
if (campaignMissionIds.includes(selectedMission)) {
  $('mission-select').value = selectedMission;
  selectGameMode(true);
  if (new URLSearchParams(location.search).get('autostart') === '1') $('campaign-start').click();
} else if (!location.search || new URLSearchParams(location.search).get('campaign') === '1') {
  $('mission-select').value = campaignMissionIds.find(id => campaignUnlocked(id) && !campaignProgress().completed.includes(id)) || campaignMissionIds[0];
  selectGameMode(true);
} else {
  selectGameMode(false);
}
if (window.lucide) window.lucide.createIcons();

$('start-game').onclick = () => {
  $('controls').style.display = 'none';
  const file = mapSelect.value;
  const starts = (MAPS.find((m) => m.file === file) || {}).starts || 2;
  // Bot vs Bot: two bots on two random start locations, watched as a spectator.
  if ($('spectate').checked) {
    const b1 = OPPONENTS[slotsBox._you.value];
    const s2 = slotsBox._opps[0] && slotsBox._opps[0].value !== 'none' ? slotsBox._opps[0].value : DEFAULT_OPP;
    const b2 = OPPONENTS[s2];
    const picks = pickStartSlots(2, starts);
    const slots = [{ slot: picks[0], race: b1.race }, { slot: picks[1], race: b2.race }];
    // A normal game (full UI) rendered as a spectator: bot 1 drives slot 0 here, bot 2 runs
    // on a shadow replica boot() spins up. See the spectate handling in boot().
    const session = { slots, mySlot: picks[0], mapFile: file, spectate: true,
                      bot:  { slot: picks[0], module: b1.module },
                      bot2: { slot: picks[1], module: b2.module } };
    boot(session).catch((e) => { setMsg('Error: ' + e.message); console.error(e); });
    return;
  }
  // Randomise which start location each player gets (slot = start location = colour).
  const botSel = slotsBox._opps.find((s) => s.value !== 'none');
  const picks = pickStartSlots(botSel ? 2 : 1, starts);
  // resolveRace turns the Random sentinel (-1) into a concrete race.
  const slots = [{ slot: picks[0], race: resolveRace(+slotsBox._you.value) }];
  const session = { slots, mySlot: picks[0], mapFile: file };
  if (botSel) {
    const o = OPPONENTS[botSel.value];
    slots.push({ slot: picks[1], race: o.race });
    session.bot = { slot: picks[1], module: o.module };
  }
  // No bot -> a single occupied slot -> the sim runs non-competitive (no auto win/lose).
  boot(session).catch((e) => { setMsg('Error: ' + e.message); console.error(e); });
};

// Load any .scx/.scm from disk (read locally, never uploaded): You on slot 0, a computer
// opponent on slot 1 if one is selected above.
$('map-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const id = 'custom:' + f.name;
    mapCache.set(id, bytes);   // fetchMap returns this straight from cache — no network
    const slots = [{ slot: 0, race: resolveRace(+slotsBox._you.value) }];
    const session = { slots, mySlot: 0, mapFile: id };
    const botSel = slotsBox._opps.find((s) => s.value !== 'none');
    if (botSel) { const o = OPPONENTS[botSel.value]; slots.push({ slot: 1, race: o.race }); session.bot = { slot: 1, module: o.module }; }
    $('controls').style.display = 'none';
    boot(session).catch((err) => { setMsg('Error: ' + err.message); console.error(err); });
  } catch (err) { setMsg('Error reading map: ' + err.message); console.error(err); }
});

// --- multiplayer: short-code setup and direct WebRTC gameplay -------------------
// The server exchanges setup data only. Both players choose races and mark ready
// before the host can start the existing direct-P2P lockstep game.
//
// After the channel opens both sit in a lobby until the host starts a 5s countdown; races
// lock for the final 2s. The host is authoritative for the final slot list, and the map is
// hash-verified so peers can't silently run different terrain.
const MP_DELAY = 4;        // input delay in frames (~170 ms at "fastest")
const COUNTDOWN = 5, LOCK_AT = 2;

for (let index = 2; index < 8; index++) {
  const row = $('mp-s0').cloneNode(true);
  for (const element of [row, ...row.querySelectorAll('[id]')]) element.id = element.id.replace(/0$/, String(index));
  row.hidden = true;
  $('mp-rows').appendChild(row);
}
const mp = {
  setup: $('mp-setup'),
  host: $('mp-host'), join: $('mp-join'),
  stepInvite: $('mp-step-invite'), inviteHint: $('mp-invite-hint'),
  inInvite: $('mp-in-invite'), accept: $('mp-accept'),
  stepShare: $('mp-step-share'), shareHint: $('mp-share-hint'), out: $('mp-out'), copy: $('mp-copy'),
  cancel: $('mp-cancel'), expires: $('mp-expires'),
  lobby: $('mp-lobby'), start: $('mp-start'), status: $('mp-status'),
  ready: $('mp-ready'), readyStates: Array.from({ length: 8 }, (_, index) => $('mp-ready-' + index)),
  loadLabels: Array.from({ length: 8 }, (_, index) => $('mp-load-' + index)), loadBars: Array.from({ length: 8 }, (_, index) => $('mp-load-progress-' + index)), loadRetry: $('mp-load-retry'),
  s: Array.from({ length: 8 }, (_, index) => $('mp-s' + index)), n: Array.from({ length: 8 }, (_, index) => $('mp-n' + index)), r: Array.from({ length: 8 }, (_, index) => $('mp-r' + index)),
  giMap: $('mp-gi-map'), giSpeed: $('mp-gi-speed'), giPlayers: $('mp-gi-players'),
};

// Random is a lobby choice, not something the engine understands. The host resolves it
// the instant the countdown ends and puts the concrete races in the authoritative `start`
// message, so both peers init from an identical list and neither rolls its own dice.
const RACES = [{ v: 1, n: 'Terran' }, { v: 0, n: 'Zerg' }, { v: 2, n: 'Protoss' }, { v: -1, n: 'Random' }];
const fillRaces = (sel) => { for (const r of RACES) sel.add(new Option(r.n, r.v)); };
const resolveRace = (r) => (r === -1 ? [0, 1, 2][(Math.random() * 3) | 0] : r);
const mpSay = (t, cls = '') => { mp.status.textContent = t; mp.status.className = cls; };
const mpShow = (el, on) => { el.style.display = on ? 'block' : 'none'; };

// Only list maps the site actually serves. Production ships just the one CC-licensed
// map; a local checkout has the others too. Probing keeps the dropdown honest in both
// (and picks up any licensed map added later) instead of advertising a 404. MAPS[0] is
// the always-shipped default, so it's listed immediately and the rest fill in as their
// HEAD requests confirm — the UI is never empty and never offers a map that isn't there.
mapSelect.add(new Option(MAPS[0].name, MAPS[0].file));
for (const sel of mp.r) fillRaces(sel);
function probeMeleeMaps() {
  if (mapProbesStarted) return;
  mapProbesStarted = true;
  Promise.all(MAPS.slice(1).map(async (m) => {
    try { return (await fetch(m.file, { method: 'HEAD' })).ok ? m : null; } catch { return null; }
  })).then((found) => {
    for (const m of found) if (m) mapSelect.add(new Option(m.name, m.file));
  });
}
if ($('mode-sandbox').getAttribute('aria-selected') === 'true') probeMeleeMaps();

// Race is picked in the lobby, not before hosting — the handshake only carries the
// starting value, and either side can change it until the countdown locks.
const START_RACE = 1;   // Terran
let mpLink = null, mpRole = null, mpMap = MAPS[0].file, mpLocked = false;
let mpRoom = null, mpConnected = false, mpExpiryTimer = 0, mpConnectionTimer = 0;
let mpCountdownTimer = 0, mpCountingDown = false;
let mpSetupGeneration = 0;
let mpPlayer = 0, mpCapacity = 2, mpRosterVersion = 0, mpLobbyVersion = 0, mpServerVersion = -1;
let mpStarted = false, mpAdmissionLocked = false, mpSealing = false, mpCode = '';
const mpMembers = Array(8).fill(null), mpOffers = new Map(), mpPeerTimers = new Map();
const mpReadyFlags = Array(8).fill(false), mpRaceRevisions = Array(8).fill(0);
const mpLoadStates = Array.from({ length: 8 }, () => ({ phase: 'Waiting', percent: 0, stagePercent: 0, ready: false }));
let mpPrepared = null, mpLoadController = null, mpExpectedMapHash = '';

// Choosing a role is one-way until it fails or the game starts. Without this, clicking
// Host and Join in any order left both flows' panels on screen at once.
function mpHideSteps() {
  for (const el of [mp.stepInvite, mp.stepShare, mp.lobby, mp.cancel]) mpShow(el, false);
}
function mpResetSteps() {
  for (const el of [mp.stepInvite, mp.stepShare]) {
    el.classList.remove('done');
    for (const c of el.querySelectorAll('input, button')) c.disabled = false;
  }
}
function mpSetRole(role) {
  if (mpRole) return false;                 // already committed
  selectGameMode(false);
  $('mode-campaign').disabled = true;
  for (const id of ['sandbox-start', 'map-row', 'map-info', 'slots', 'spectate-row', 'lobby-hint']) $(id).hidden = true;
  mpShow(mp.setup, false);
  const address = new URL(location.href);
  address.searchParams.set('campaign', '0');
  history.replaceState(null, '', address);
  mpRole = role;
  mpSetupGeneration++;
  mp.host.disabled = mp.join.disabled = true;
  mpHideSteps();
  return true;
}
function mpResetRole() {                    // let the user try again after a failure
  mpSetupGeneration++;
  mpLoadController?.abort(); mpLoadController = null; mpPrepared = null;
  for (let index = 0; index < 8; index++) mpLoadStates[index] = { phase: 'Waiting', percent: 0, stagePercent: 0, ready: false };
  for (const timer of mpPeerTimers.values()) clearTimeout(timer);
  mpPeerTimers.clear(); mpOffers.clear(); mpMembers.fill(null);
  mpStarted = false; mpAdmissionLocked = false; mpSealing = false;
  mpPlayer = 0; mpCapacity = 2; mpRosterVersion = 0; mpLobbyVersion = 0; mpServerVersion = -1; mpCode = '';
  clearInterval(mpExpiryTimer); clearTimeout(mpConnectionTimer);
  clearTimeout(mpCountdownTimer); mpCountingDown = false;
  mpRoom?.close(); mpRoom = null;
  mpConnected = false; mpLocked = false;
  mpReadyFlags.fill(false); mpRaceRevisions.fill(0); mp.ready.checked = false;
  for (const select of mp.r) select.value = String(START_RACE);
  $('mode-campaign').disabled = false;
  mp.inInvite.readOnly = false;
  mp.accept.style.display = '';
  mp.inviteHint.textContent = 'Game Code';
  mpRole = null;
  if (mpLink) { try { mpLink.close(); } catch {} mpLink = null; }
  mp.host.disabled = mp.join.disabled = false;
  mapSelect.disabled = false;
  mp.start.disabled = true;
  mpResetSteps();
  mpHideSteps();
  selectGameMode(false);
  mpShow(mp.setup, true);
}

const mpNet = () => import('./net.js?v=' + BUILD);

const mpBoot = (slots, mySlot, playerSlots) => {
  if (!mpCanStart()) { mpCancelCountdown(true); return; }
  mpStarted = true;
  const pendingNetwork = { controls: [], closed: [] };
  mpLink.onControl = (message, player) => { if (pendingNetwork.controls.length < 2000) pendingNetwork.controls.push([message, player]); };
  mpLink.onClose = (player, why) => pendingNetwork.closed.push([player, why]);
  for (const timer of mpPeerTimers.values()) clearTimeout(timer);
  mpPeerTimers.clear(); clearInterval(mpExpiryTimer);
  if (mpRole === 'host') mpRoom?.close();
  else mpRoom?.detach();
  mpRoom = null;
  for (const player of [...mpLink.links.keys()]) if (!mpMembers[player]) mpLink.remove(player);
  $('controls').style.display = 'none';
  boot({ slots, mySlot, playerSlots, pendingNetwork, link: mpLink, delay: MP_DELAY, isHost: mpRole === 'host', mapFile: mpMap, prepared: mpPrepared })
    .catch((err) => { setMsg('Error: ' + err.message); console.error(err); });
};

const mpRaceName = (r) => (RACES.find((x) => x.v === r) || RACES[0]).n;
const mpMine = () => mpPlayer;
function mpPlayers() { return mpMembers.flatMap((member, player) => member ? [player] : []); }
function mpMeshReady() {
  const players = mpPlayers();
  return !!mpLink && mpLink.ready(players) && players.every(player => mpMembers[player].connected && players.every(peer => peer === player || mpMembers[player].peers.includes(peer)));
}
function mpCanStart() { return mpConnected && mpPlayers().length >= 2 && mpMeshReady() && mpAllLoaded() && mpPlayers().every(player => mpReadyFlags[player]); }

function mpEnterLobby() {
  mpHideSteps();
  mpShow(mp.lobby, true);
  mpShow(mp.stepShare, true);
  mpShow(mp.cancel, true);
  mp.out.value = mpCode;
  mp.giMap.textContent = (MAPS.find((m) => m.file === mpMap) || {}).name || '—';
  mp.start.style.display = mpRole === 'host' ? '' : 'none';
  mpUpdateLobby();
  mpSay(mpRole === 'host' ? 'Waiting for players...' : 'Connected.', 'ok');
  mpPreloadDependencies();
}
function mpAllLoaded() {
  return !!mpPrepared && mpPlayers().every(player => {
    const state = mpLoadStates[player];
    return state.ready && state.mapHash === mpPrepared.mapHash && state.engineHash === mpPrepared.engineHash && JSON.stringify(state.assetHashes) === JSON.stringify(mpPrepared.assetHashes);
  });
}
function mpUpdateLobby() {
  mp.giSpeed.textContent = 'Fastest';
  mp.giPlayers.textContent = `${mpPlayers().length} / ${mpCapacity}`;
  for (let index = 0; index < 8; index++) {
    const member = mpMembers[index];
    mp.s[index].hidden = index >= mpCapacity;
    mp.s[index].classList.toggle('open', !member);
    mp.s[index].classList.toggle('you', index === mpPlayer);
    mp.n[index].textContent = member ? (index === 0 ? 'Host' : `Player ${index + 1}`) + (index === mpPlayer ? ' (you)' : '') : 'Open';
    mp.r[index].disabled = !member || index !== mpPlayer || !mpConnected || mpLocked || mpReadyFlags[index];
    mp.r[index].ariaLabel = index === mpPlayer ? 'Your race' : `Player ${index + 1} race`;
    mp.readyStates[index].textContent = !member ? '' : !member.connected ? 'Connecting' : mpReadyFlags[index] ? 'Ready' : 'Not ready';
    mp.readyStates[index].classList.toggle('is-ready', mpReadyFlags[index]);
    const load = mpLoadStates[index];
    mp.loadLabels[index].textContent = !member ? 'Open slot' : load.ready ? 'Loaded' : load.phase === 'Failed' ? 'Download failed' : `${load.phase}: ${load.stagePercent}%`;
    mp.loadBars[index].value = member ? load.percent : 0;
    mp.loadBars[index].ariaLabel = `Player ${index + 1} download progress`;
  }
  mp.ready.checked = mpReadyFlags[mpMine()];
  mp.ready.disabled = !mpConnected || mpLocked || !mpLoadStates[mpMine()].ready || !mpMeshReady();
  mp.start.disabled = !mpCanStart() || mpCountingDown || mpSealing;
  mp.cancel.disabled = mpLocked;
  mp.loadRetry.hidden = mpLoadStates[mpMine()].phase !== 'Failed';
  if (mpCode && (mpServerVersion > 0 || mpRole === 'join')) mp.expires.textContent = mpAdmissionLocked ? 'Game starting' : `${mpCapacity - mpPlayers().length} open player slots`;
}

function mpPublishLobby() {
  mpUpdateLobby();
  if (mpRole !== 'host' || mpStarted) return;
  const members = mpMembers.slice(0, mpCapacity).map((member, player) => member && ({ ...member, race: +mp.r[player].value, revision: mpRaceRevisions[player], ready: mpReadyFlags[player], load: mpLoadStates[player] }));
  mpLink.sendControl({ t: 'lobby', version: ++mpLobbyVersion, roster: mpRosterVersion, members });
}
function mpSubmit(message) {
  if (mpRole === 'host') mpOnControl(message, 0);
  else mpLink?.sendControl(message, 0);
}

async function mpPreloadDependencies() {
  if (!mpConnected) return;
  mpLoadController?.abort();
  const controller = mpLoadController = new AbortController();
  const generation = mpSetupGeneration;
  mpPrepared = null;
  mpReadyFlags[mpMine()] = false;
  mpSubmit({ t: 'ready', ready: false, roster: mpRosterVersion, revisions: mpRaceRevisions.slice(0, mpCapacity) });
  let last = '';
  const report = (phase, fraction, ready = false, hashes = {}) => {
    if (generation !== mpSetupGeneration || controller !== mpLoadController) return;
    if (controller.signal.aborted && phase !== 'Failed') return;
    const stagePercent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    const percent = ready ? 100 : phase === 'Game files' ? Math.floor(stagePercent * .8) : phase === 'Map' ? 80 + Math.floor(stagePercent * .1) : phase === 'Engine' ? 90 + Math.floor(stagePercent * .09) : phase === 'Verifying' ? 99 : 0;
    const signature = `${phase}:${stagePercent}:${ready}`;
    if (signature === last) return;
    last = signature;
    const state = { phase, percent, stagePercent, ready, ...hashes };
    mpLoadStates[mpMine()] = state;
    mpSubmit({ t: 'loading', ...state });
    mpUpdateLobby();
  };
  try {
    const assets = await loadAssets(mpMap, null, controller.signal, report);
    const mapHash = cyrb53(assets[3]);
    if (mapHash !== mpExpectedMapHash) throw new Error('Map differs from the host. Both players need the same map data.');
    report('Engine', 0);
    const url = './openbw.wasm' + (DEV ? '?t=' + Date.now() : '?v=' + BUILD);
    const bytes = new Uint8Array(await fetchWithProgress(url, 0, fraction => report('Engine', fraction), controller.signal));
    report('Verifying', 1);
    const module = await WebAssembly.compile(bytes);
    const engineHash = await missionDigest(bytes);
    const assetHashes = assets.slice(0, 3).map(cyrb53);
    if (generation !== mpSetupGeneration || controller !== mpLoadController) return;
    mpPrepared = { assets, module, map: mpMap, mapHash, engineHash, assetHashes };
    report('Loaded', 1, true, { mapHash, engineHash, assetHashes });
    if (mpPlayers().every(player => mpLoadStates[player].ready) && !mpAllLoaded()) mpSay('Game files or engine differ between players.', 'err');
  } catch (error) {
    if (controller.signal.aborted || generation !== mpSetupGeneration) return;
    controller.abort();
    report('Failed', 0);
    mpCancelCountdown(true);
    mpSay(error.message, 'err');
  }
}
mp.loadRetry.onclick = mpPreloadDependencies;

// Races may change freely in the lobby; both sides mirror each other until the lock.
const mpSendRace = () => {
  if (!mpLocked) mpSubmit({ t: 'race', race: +mp.r[mpMine()].value, revision: mpRaceRevisions[mpMine()] + 1 });
};
for (const select of mp.r) select.onchange = mpSendRace;
mapSelect.onchange = () => { mpMap = mapSelect.value; };

function mpCancelCountdown(notify = false) {
  const wasCountingDown = mpCountingDown;
  if (notify && mpCountingDown && mpRole === 'host') mpLink?.sendControl({ t: 'cancel-start' });
  clearTimeout(mpCountdownTimer);
  mpCountingDown = false;
  mpLocked = false;
  if (mpRole === 'host' && mpAdmissionLocked && !mpStarted) {
    mpAdmissionLocked = false;
    mpRoom?.setLocked(false).catch(error => mpSay(error.message, 'err'));
  }
  mpUpdateLobby();
  if (wasCountingDown) mpSay('Waiting for all players to be ready.');
}
mp.ready.onchange = () => {
  if (!mpLoadStates[mpMine()].ready || !mpMeshReady()) { mp.ready.checked = false; return; }
  mpSubmit({ t: 'ready', ready: mp.ready.checked, roster: mpRosterVersion, revisions: mpRaceRevisions.slice(0, mpCapacity) });
};

function mpCountdown(n) {
  if (!mpCanStart()) { mpCancelCountdown(true); return; }
  mpCountingDown = true;
  if (n <= LOCK_AT && !mpLocked) {
    mpLocked = true;
    mapSelect.disabled = true;
  }
  mpUpdateLobby();
  if (n <= 0) {
    if (mpRole !== 'host') return;          // the joiner starts on the host's `start`
    // Randomise who starts where. Slot drives both start location and colour, so this
    // stops the host always being top-left in the same colour every game.
    const players = mpPlayers(), starts = pickStartSlots(players.length, mpCapacity);
    const playerSlots = Object.fromEntries(players.map((player, index) => [player, starts[index]]));
    const slots = players.map(player => ({ slot: playerSlots[player], race: resolveRace(+mp.r[player].value) }));
    mpLink.sendControl({ t: 'start', slots, playerSlots, roster: mpRosterVersion, revisions: mpRaceRevisions.slice(0, mpCapacity) });
    mpBoot(slots, playerSlots[0], playerSlots);
    return;
  }
  mpSay(`Starting in ${n}…`, 'ok');
  if (mpRole === 'host') {
    mpLink.sendControl({ t: 'tick', n });
    mpCountdownTimer = setTimeout(() => mpCountdown(n - 1), 1000);
  }
}

// Lobby control messages, shared by the copy-paste (PeerLink) and relay (RelayLink)
// transports since both are just a channel underneath.
function mpLoadState(message) {
  if (!['Waiting', 'Game files', 'Map', 'Engine', 'Verifying', 'Loaded', 'Failed'].includes(message.phase) || !Number.isInteger(message.percent) || message.percent < 0 || message.percent > 100 || !Number.isInteger(message.stagePercent) || message.stagePercent < 0 || message.stagePercent > 100) return null;
  const ready = message.ready === true && message.phase === 'Loaded' && message.percent === 100 && /^[a-f0-9]{14}$/.test(message.mapHash) && /^[a-f0-9]{64}$/.test(message.engineHash) && Array.isArray(message.assetHashes) && message.assetHashes.length === 3 && message.assetHashes.every(hash => /^[a-f0-9]{14}$/.test(hash));
  return { phase: message.phase, percent: message.percent, stagePercent: message.stagePercent, ready, mapHash: message.mapHash, engineHash: message.engineHash, assetHashes: message.assetHashes };
}
function mpOnControl(msg, player) {
  if (!mpRole || mpStarted || !mpMembers[player]) return;
  if (mpRole === 'join') {
    if (player !== 0) return;
    if (msg.t === 'lobby') { mpApplyLobby(msg); return; }
    if (msg.t === 'mesh-signal') { mpAcceptPeerSignal(msg).catch(error => mpPeerFailure(msg.from, error.message)); return; }
    if (msg.t === 'cancel-start') { mpCancelCountdown(); return; }
    if (msg.t === 'tick' && Number.isInteger(msg.n) && msg.n >= 0 && msg.n <= COUNTDOWN) { mpCountdown(msg.n); return; }
    if (msg.t !== 'start' || !mpCanStart() || msg.roster !== mpRosterVersion || !Array.isArray(msg.revisions) || msg.revisions.length !== mpCapacity || !msg.revisions.every((revision, index) => revision === mpRaceRevisions[index])) return;
    const players = mpPlayers();
    if (!Array.isArray(msg.slots) || msg.slots.length !== players.length || !msg.playerSlots || typeof msg.playerSlots !== 'object' || Object.keys(msg.playerSlots).length !== players.length) return;
    if (msg.slots.some(slot => !Number.isInteger(slot.slot) || slot.slot < 0 || slot.slot >= mpCapacity || ![0, 1, 2].includes(slot.race)) || new Set(msg.slots.map(slot => slot.slot)).size !== players.length) return;
    if (new Set(players.map(peer => msg.playerSlots[peer])).size !== players.length || players.some(peer => !msg.slots.some(slot => slot.slot === msg.playerSlots[peer] && (+mp.r[peer].value === -1 || slot.race === +mp.r[peer].value)))) return;
    mpBoot(msg.slots, msg.playerSlots[mpPlayer], msg.playerSlots);
    return;
  }
  if (msg.t === 'mesh-signal') { mpRoutePeerSignal(msg, player); return; }
  if (msg.t === 'mesh-failed') {
    if (Number.isInteger(msg.peer) && msg.peer > 0 && msg.peer !== player && mpMembers[msg.peer] && mpMembers[msg.peer].id === msg.member) mpPeerFailure(player, 'A direct connection between players failed.', msg.peer);
    return;
  }
  if (msg.t === 'mesh') {
    if (!Array.isArray(msg.peers) || msg.peers.length > 7 || msg.peers.some(peer => !Number.isInteger(peer) || peer === player || !mpMembers[peer])) return;
    mpMembers[player].peers = [...new Set(msg.peers)];
  } else if (msg.t === 'loading') {
    const load = mpLoadState(msg);
    if (!load) return;
    mpLoadStates[player] = load;
    if (!load.ready) { mpReadyFlags[player] = false; mpCancelCountdown(true); }
  } else if (msg.t === 'race') {
    if (!RACES.some(race => race.v === msg.race) || !Number.isInteger(msg.revision) || msg.revision <= mpRaceRevisions[player] || msg.revision > 1000000) return;
    mpRaceRevisions[player] = msg.revision; mp.r[player].value = String(msg.race);
    mpReadyFlags.fill(false); mpCancelCountdown(true);
  } else if (msg.t === 'ready') {
    mpReadyFlags[player] = msg.ready === true && mpLoadStates[player].ready && mpMeshReady() && msg.roster === mpRosterVersion && Array.isArray(msg.revisions) && msg.revisions.length === mpCapacity && msg.revisions.every((revision, index) => revision === mpRaceRevisions[index]);
    if (!mpReadyFlags[player]) mpCancelCountdown(true);
  } else return;
  mpPublishLobby();
  if (mpPlayers().every(peer => mpLoadStates[peer].ready) && !mpAllLoaded()) mpSay('Game files or engine differ between players.', 'err');
}

function mpNewMesh(net) {
  const mesh = new net.PeerMesh({
    localSlot: mpPlayer, onControl: mpOnControl,
    onOpen: player => {
      if (mpLink !== mesh || !mpRole || mpStarted) return;
      clearTimeout(mpPeerTimers.get(player)); mpPeerTimers.delete(player);
      if (mpRole === 'host') {
        if (!mpMembers[player]) return;
        mpMembers[player].connected = true;
        if (mpLoadStates[0].phase !== 'Failed') mpSay(`Player ${player + 1} connected.`, 'ok');
      } else if (player === 0 && !mpConnected) {
        mpConnected = true;
        clearTimeout(mpConnectionTimer);
        mpMembers[mpPlayer].connected = true;
        mpEnterLobby();
      }
      mpReportConnections();
    },
    onClose: (player, why) => { if (mpLink === mesh && mpRole && !mpStarted) mpPeerFailure(player, `Direct P2P connection ${why}.`); },
  });
  return mesh;
}
function mpAttachPeer(net, player, member) {
  const record = { link: new net.PeerLink(), member, answered: false, replacing: false };
  mpOffers.set(player, record);
  mpLink.add(player, record.link);
  return record;
}
function mpWatchPeer(player, record) {
  clearTimeout(mpPeerTimers.get(player));
  mpPeerTimers.set(player, setTimeout(() => {
    if (mpOffers.get(player) === record && !mpLink?.connected(player)) mpPeerFailure(player, 'Direct connection failed; these networks may block WebRTC.');
  }, 30000));
}
function mpReportConnections() {
  if (!mpConnected || !mpLink || mpStarted) return;
  const peers = mpPlayers().filter(player => player !== mpPlayer && mpLink.connected(player));
  if (mpRole === 'host') { mpMembers[0].peers = peers; mpPublishLobby(); }
  else mpSubmit({ t: 'mesh', peers });
}
function mpRosterChanged() {
  mpRosterVersion++;
  mpReadyFlags.fill(false);
  mpCancelCountdown(true);
}
async function mpHostOffer(net, player) {
  const record = mpAttachPeer(net, player, null);
  record.replacing = true;
  const offer = await record.link.createOffer({ build: BUILD, map: mpMap, hash: mpExpectedMapHash, capacity: mpCapacity, player });
  return { record, offer };
}
async function mpRefreshSlot(player, why = '') {
  if (mpRole !== 'host' || mpStarted || mpOffers.get(player)?.replacing) return;
  const room = mpRoom, generation = mpSetupGeneration;
  const previous = mpOffers.get(player)?.member ?? null;
  clearTimeout(mpPeerTimers.get(player)); mpPeerTimers.delete(player);
  mpMembers[player] = null; mpReadyFlags[player] = false; mpRaceRevisions[player] = 0;
  mpLoadStates[player] = { phase: 'Waiting', percent: 0, stagePercent: 0, ready: false };
  mp.r[player].value = String(START_RACE);
  mpLink.remove(player); mpOffers.delete(player);
  mpRosterChanged(); mpReportConnections();
  if (why) mpSay(why, 'err');
  const net = await mpNet();
  if (generation !== mpSetupGeneration || room !== mpRoom) return;
  const { record, offer } = await mpHostOffer(net, player);
  if (generation !== mpSetupGeneration || room !== mpRoom || mpOffers.get(player) !== record) return;
  const state = await room.replaceOffer(player, offer, previous);
  record.replacing = false;
  await mpProcessRoom(state);
}
function mpPeerFailure(player, why, other = null) {
  if (!mpRole || mpStarted) return;
  if (mpRole === 'host') {
    if (!mpMembers[player] || player === 0) return;
    const target = other > 0 && mpMembers[other] && mpMembers[other].joined > mpMembers[player].joined ? other : player;
    mpRefreshSlot(target, why).catch(error => mpSay(error.message, 'err'));
  } else if (player === 0) { mpResetRole(); mpSay(why, 'err'); }
  else if (mpMembers[player]) mpSubmit({ t: 'mesh-failed', peer: player, member: mpMembers[player].id });
}
function mpApplyLobby(message) {
  if (!Number.isInteger(message.version) || message.version <= mpLobbyVersion || !Number.isInteger(message.roster) || message.roster < mpRosterVersion || !Array.isArray(message.members) || message.members.length !== mpCapacity) return;
  if (message.members[0]?.id !== 'host' || message.members[mpPlayer]?.id !== mpMembers[mpPlayer]?.id) return;
  const valid = message.members.every((member, player) => !member || (
    typeof member.id === 'string' && (player === 0 ? member.id === 'host' : /^[a-f0-9]{24}$/.test(member.id)) &&
    RACES.some(race => race.v === member.race) && Number.isInteger(member.revision) && member.revision >= 0 && member.revision <= 1000000 &&
    Number.isInteger(member.joined) && member.joined >= 0 && typeof member.connected === 'boolean' &&
    Array.isArray(member.peers) && member.peers.length < mpCapacity && member.peers.every(peer => Number.isInteger(peer) && peer >= 0 && peer < mpCapacity && peer !== player) && mpLoadState(member.load)
  ));
  if (!valid) return;
  const changed = mpRosterVersion !== message.roster;
  mpLobbyVersion = message.version; mpRosterVersion = message.roster;
  for (let player = 0; player < mpCapacity; player++) {
    const member = message.members[player];
    mpMembers[player] = member && { id: member.id, connected: member.connected, peers: member.peers.slice(), joined: member.joined };
    mpReadyFlags[player] = member?.ready === true;
    mpRaceRevisions[player] = member?.revision ?? 0;
    mp.r[player].value = String(member?.race ?? START_RACE);
    mpLoadStates[player] = member ? mpLoadState(member.load) : { phase: 'Waiting', percent: 0, stagePercent: 0, ready: false };
  }
  if (changed || (mpCountingDown && !mpCanStart())) mpCancelCountdown();
  mpUpdateLobby(); mpSyncPeerLinks();
  if (mpPlayers().every(player => mpLoadStates[player].ready) && !mpAllLoaded()) mpSay('Game files or engine differ between players.', 'err');
}
function mpPeerInfo(player) {
  return { build: BUILD, room: mpCode, from: mpPlayer, to: player, member: mpMembers[mpPlayer].id, target: mpMembers[player].id };
}
function mpSyncPeerLinks() {
  if (mpRole !== 'join') return;
  for (const [player, record] of mpOffers) {
    if (player > 0 && mpMembers[player]?.id !== record.member) {
      mpLink.remove(player); mpOffers.delete(player);
      clearTimeout(mpPeerTimers.get(player)); mpPeerTimers.delete(player);
    }
  }
  for (const player of mpPlayers()) if (player > mpPlayer && mpMembers[player].connected && !mpOffers.has(player)) {
    const generation = mpSetupGeneration;
    (async () => {
      const net = await mpNet();
      if (generation !== mpSetupGeneration || !mpMembers[player] || mpOffers.has(player)) return;
      const record = mpAttachPeer(net, player, mpMembers[player].id);
      mpWatchPeer(player, record);
      const signal = await record.link.createOffer(mpPeerInfo(player));
      if (generation !== mpSetupGeneration || mpOffers.get(player) !== record) return;
      mpLink.sendControl({ t: 'mesh-signal', to: player, target: record.member, member: mpMembers[mpPlayer].id, kind: 'offer', signal }, 0);
    })().catch(error => mpPeerFailure(player, error.message));
  }
}
function mpRoutePeerSignal(message, player) {
  if (!mpMembers[player]?.connected || !Number.isInteger(message.to) || message.to <= 0 || message.to === player || !mpMembers[message.to]?.connected || message.member !== mpMembers[player].id || message.target !== mpMembers[message.to].id || !['offer', 'answer'].includes(message.kind) || typeof message.signal !== 'string' || message.signal.length > 24000) return;
  mpLink.sendControl({ t: 'mesh-signal', from: player, target: message.target, member: message.member, kind: message.kind, signal: message.signal }, message.to);
}
async function mpAcceptPeerSignal(message) {
  const player = message.from, generation = mpSetupGeneration;
  if (!Number.isInteger(player) || player <= 0 || player === mpPlayer || !mpMembers[player]?.connected || message.member !== mpMembers[player].id || message.target !== mpMembers[mpPlayer].id || typeof message.signal !== 'string' || message.signal.length > 24000) return;
  const net = await mpNet(), info = await net.unpackSignal(message.signal);
  if (generation !== mpSetupGeneration || info.build !== BUILD || info.room !== mpCode || info.from !== player || info.to !== mpPlayer || info.member !== message.member || info.target !== message.target) return;
  if (message.kind === 'offer' && player < mpPlayer && !mpOffers.has(player)) {
    const record = mpAttachPeer(net, player, message.member);
    mpWatchPeer(player, record);
    const { answer } = await record.link.acceptOffer(message.signal, mpPeerInfo(player));
    if (generation !== mpSetupGeneration || mpOffers.get(player) !== record) return;
    mpLink.sendControl({ t: 'mesh-signal', to: player, target: message.member, member: message.target, kind: 'answer', signal: answer }, 0);
  } else if (message.kind === 'answer' && player > mpPlayer) {
    const record = mpOffers.get(player);
    if (record?.member === message.member && !record.answered) { record.answered = true; await record.link.acceptAnswer(message.signal); }
  }
}
async function mpProcessRoom(state) {
  if (!mpRoom || mpRole !== 'host' || mpStarted || !Number.isInteger(state.version) || state.version < mpServerVersion) return;
  mpServerVersion = state.version;
  const room = mpRoom, generation = mpSetupGeneration;
  const net = await mpNet();
  if (generation !== mpSetupGeneration || room !== mpRoom) return;
  for (const member of state.members) {
    const record = mpOffers.get(member.slot);
    if (!record || record.replacing) continue;
    if (mpMembers[member.slot]?.id !== member.id) {
      record.member = member.id;
      mpMembers[member.slot] = { id: member.id, connected: false, peers: [], joined: mpRosterVersion + 1 };
      mpRosterChanged(); mpPublishLobby(); mpWatchPeer(member.slot, record);
    }
    if (member.answer && !record.answered) {
      record.answered = true;
      const info = await net.unpackSignal(member.answer);
      if (generation !== mpSetupGeneration || room !== mpRoom || mpOffers.get(member.slot) !== record) return;
      if (info.build !== BUILD || info.player !== member.slot || info.member !== member.id) { await mpRefreshSlot(member.slot, 'A joining player has a different game version.'); continue; }
      await record.link.acceptAnswer(member.answer);
    }
  }
  for (let player = 1; player < mpCapacity; player++) {
    if (mpOffers.get(player)?.replacing) continue;
    if ((mpMembers[player] && !state.members.some(member => member.slot === player)) || state.unavailable.includes(player)) await mpRefreshSlot(player);
  }
}

mp.host.onclick = async () => {
  if (!mpSetRole('host')) return;         // guard *before* awaiting, or a second click slips in
  const generation = mpSetupGeneration;
  let room = null;
  mpShow(mp.cancel, true);
  try {
    const net = await mpNet();
    if (generation !== mpSetupGeneration) return;
    room = mpRoom = new net.RoomSetup();
    mpMap = mapSelect.value;
    mpCapacity = MAPS.find(map => map.file === mpMap)?.starts;
    if (!Number.isInteger(mpCapacity) || mpCapacity < 2 || mpCapacity > 8) throw new Error('This map does not support multiplayer.');
    mapSelect.disabled = true;
    mpSay('Preparing game code...');
    const hash = await mapHash(mpMap);
    if (room !== mpRoom) return;
    mpExpectedMapHash = hash;
    mpPlayer = 0; mpMembers[0] = { id: 'host', connected: true, peers: [], joined: 0 };
    mpLink = mpNewMesh(net);
    const prepared = await Promise.all(Array.from({ length: mpCapacity - 1 }, (_, index) => mpHostOffer(net, index + 1)));
    if (room !== mpRoom) return;
    const code = await room.create(prepared.map(value => value.offer));
    if (room !== mpRoom) return;
    for (const value of prepared) value.record.replacing = false;
    mpCode = code; mpConnected = true;
    mpEnterLobby();
    mp.shareHint.textContent = 'Game Code';
    mp.out.value = code;
    const expiry = () => {
      if (mpServerVersion > 0) return;
      const remaining = Math.max(0, Math.ceil((room.expiresAt - Date.now()) / 1000));
      mp.expires.textContent = `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    };
    expiry(); mpExpiryTimer = setInterval(expiry, 1000);
    while (room === mpRoom && !mpStarted) await mpProcessRoom(await room.poll(mpServerVersion));
  } catch (e) { if (generation === mpSetupGeneration && (!room || room === mpRoom)) { mpResetRole(); mpSay(e.message, 'err'); } }
};

// A direct connection has a bounded setup time; there is no automatic relay fallback.
function mpAwaitConnection() {
  if (mpConnected) return;
  mpSay('Connecting directly...', 'ok');
  clearTimeout(mpConnectionTimer);
  mpConnectionTimer = setTimeout(() => {
    if (mpConnected) return;
    mpResetRole();
    mpSay('Direct P2P connection failed. The networks may block WebRTC; no relay is enabled.', 'err');
  }, 30000);
}

// The joiner exchanges the answer through the server rather than pasting a response.
async function mpAcceptInvite(code) {
  if (mpRole === 'host') return;          // can't join your own game
  if (!mpRole) mpSetRole('join');
  const generation = mpSetupGeneration;
  code = code.trim();
  if (!/^\d{8}$/.test(code)) { mpSay('Enter an eight-digit game code.', 'err'); return; }
  mp.accept.disabled = true;
  mp.inInvite.readOnly = true;
  const net = await mpNet();
  if (generation !== mpSetupGeneration) return;
  const room = mpRoom = new net.RoomSetup();
  mpSay('Checking the map…');
  const offer = await room.join(code);
  if (room !== mpRoom) return;
  const info = await net.unpackSignal(offer);
  if (info.build !== BUILD) throw new Error('Game versions differ. Both players should reload.');
  // Same terrain, verified by content — not by filename.
  mpMap = info.map || MAP_LOCAL;
  if (!MAPS.some(map => map.file === mpMap)) throw new Error('The host selected an unsupported map.');
  mapSelect.value = mpMap;
  mapSelect.disabled = true;              // the host picks the map
  if (!/^[a-f0-9]{14}$/.test(info.hash)) throw new Error('Invalid host map fingerprint.');
  mpExpectedMapHash = info.hash;
  mpCapacity = MAPS.find(map => map.file === mpMap).starts;
  if (info.capacity !== mpCapacity || !Number.isInteger(room.slot) || room.slot < 1 || room.slot >= mpCapacity || info.player !== room.slot || !/^[a-f0-9]{24}$/.test(room.member)) throw new Error('Invalid map player reservation.');
  mpCode = code; mpPlayer = room.slot;
  mpMembers[0] = { id: 'host', connected: true, peers: [mpPlayer], joined: 0 };
  mpMembers[mpPlayer] = { id: room.member, connected: false, peers: [0], joined: 0 };
  if (room !== mpRoom) return;
  mpLink = mpNewMesh(net);
  const record = mpAttachPeer(net, 0, 'host');
  const { answer } = await record.link.acceptOffer(offer, { build: BUILD, player: mpPlayer, member: room.member });
  if (room !== mpRoom) return;
  await room.sendAnswer(answer);
  mpAwaitConnection();
}

mp.join.onclick = () => {
  if (!mpSetRole('join')) return;
  mapSelect.disabled = true;      // the host chooses the map; yours is set from the invite
  mpShow(mp.stepInvite, true);
  mpShow(mp.cancel, true);
  mp.inInvite.focus();
  mpSay('');
};

mp.accept.onclick = () => {
  if (mp.accept.disabled) return;
  const generation = mpSetupGeneration;
  mpAcceptInvite(mp.inInvite.value).catch(e => {
    if (generation !== mpSetupGeneration) return;
    mpResetRole(); mpSay(e.message, 'err');
  });
};
mp.start.onclick = async () => {
  if (mpRole !== 'host' || !mpCanStart() || mpCountingDown || mpSealing) return;
  const room = mpRoom, generation = mpSetupGeneration;
  mpSealing = true; mpUpdateLobby();
  try {
    const state = await room.setLocked(true);
    if (generation !== mpSetupGeneration || room !== mpRoom) return;
    mpAdmissionLocked = true;
    await mpProcessRoom(state);
    if (mpCanStart()) mpCountdown(COUNTDOWN);
    else mpCancelCountdown(true);
  } catch (error) { if (generation === mpSetupGeneration) { mpCancelCountdown(true); mpSay(error.message, 'err'); } }
  finally { if (generation === mpSetupGeneration) { mpSealing = false; mpUpdateLobby(); } }
};

mp.copy.onclick = async () => {
  try { await navigator.clipboard.writeText(mp.out.value); mpSay('Copied to clipboard.', 'ok'); }
  catch { mp.out.select(); mpSay('Press Cmd/Ctrl+C to copy.'); }
};
mp.cancel.onclick = () => { mpResetRole(); mpSay('Game setup cancelled.'); };
mp.inInvite.addEventListener('keydown', event => { if (event.key === 'Enter' && !mp.accept.disabled) mp.accept.click(); });
addEventListener('pagehide', () => { mpRoom?.close(); mpLink?.close(); });

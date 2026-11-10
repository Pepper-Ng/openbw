// Headless verification of the browser wasm code path (web/openbw.wasm) under
// Node's WASI. Provides the env.js_read_data / js_file_size file bridge backed
// by the local MPQs + map, runs init + a few ticks, and dumps the rendered
// framebuffer to a PPM — proving wasm_backend.cpp renders correctly.
//
//   node web/run-wasm-node.mjs out.ppm
import { WASI } from 'node:wasi';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sealCampaignSave, validateCampaignSave } from './campaign-saves.js';
import { campaignMissions } from './prepare-campaign.mjs';

if (process.argv[2] === '--test-network') {
  const { PeerMesh, Lockstep, PeerDepartures } = await import('./net.js');
  const controls = [], turns = [], closed = [];
  const mesh = new PeerMesh({ localSlot: 0, onControl: (message, slot) => controls.push([message, slot]), onClose: slot => closed.push(slot) });
  const fake = () => ({ sent: [], setTurnHandler(handler) { this.turn = handler; }, sendTurn(...args) { this.sent.push(['turn', ...args]); }, sendControl(message) { this.sent.push(['control', message]); }, close() { this.onClose('closed'); } });
  const first = fake(), second = fake();
  mesh.add(1, first); mesh.add(2, second);
  first.onOpen();
  assert.equal(mesh.ready([0, 1, 2]), false, 'A partial mesh cannot start');
  second.onOpen();
  assert.equal(mesh.ready([0, 1, 2]), true);
  first.onControl({ t: 'ready' }); second.onControl({ t: 'ready' });
  assert.deepEqual(controls.map(entry => entry[1]), [1, 2], 'Sender identity comes from its direct connection');
  first.turn(0, new Uint8Array([1])); second.turn(0, new Uint8Array([2]));
  mesh.setTurnHandler((frame, bytes, slot) => turns.push([frame, bytes[0], slot]));
  assert.deepEqual(turns, [[0, 1, 1], [0, 2, 2]], 'Buffered turns retain each sender');
  mesh.sendTurn(1, new Uint8Array()); mesh.sendControl({ t: 'start' }, 2);
  assert.equal(first.sent.length, 1); assert.equal(second.sent.length, 2);
  mesh.remove(1); first.onControl({ t: 'stale' });
  assert.equal(controls.length, 2, 'Removed peers cannot inject stale controls');
  assert.equal(closed.length, 0, 'Intentional removal does not report an unrelated disconnect');
  const queue = new Lockstep({ x: {}, memory: {}, slots: [0, 1, 2], localSlot: 0 });
  assert.equal(queue.receiveTurn(7, 0, new Uint8Array()).ok, false);
  assert.equal(queue.receiveTurn(0, 0, new Uint8Array()).ok, false);
  mesh.close();
  const makeReplica = (localSlot, peers, slots = [0, 1, 2]) => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const state = { frame: 0, applied: [] };
    const x = { openbw_out_len: () => 0, openbw_out_clear() {}, openbw_in_ptr: () => 0,
      openbw_apply: (owner, length) => state.applied.push([state.frame, owner, [...new Uint8Array(memory.buffer, 0, length)]]),
      openbw_step: () => state.frame++ };
    const lockstep = new Lockstep({ x, memory, slots, localSlot, delay: 2,
      send: message => { for (const replica of peers) if (replica.localSlot !== localSlot) replica.lockstep.receiveTurn(localSlot, message.f, message.d); } });
    return { localSlot, state, lockstep };
  };
  const replicas = [];
  for (const localSlot of [0, 1]) replicas.push(makeReplica(localSlot, replicas));
  replicas[0].lockstep.receiveTurn(2, 0, new Uint8Array([9]));
  const recovered = replicas[0].lockstep.departureSnapshot([2]).turns;
  for (const replica of replicas) replica.lockstep.scheduleDeparture(2, [2], recovered);
  for (let round = 0; round < 8; round++) for (const replica of replicas) replica.lockstep.tick();
  assert.deepEqual(replicas[0].state.applied, replicas[1].state.applied, 'Survivors recover the same final commands before a shared departure');
  assert.deepEqual(replicas[0].state.applied, [[0, 2, [9]], [2, 2, [2, 0, 87, 1]]], 'Disconnect uses the existing framed surrender command exactly once');
  assert.ok(replicas.every(replica => replica.state.frame > 2 && !replica.lockstep.slots.includes(2)), 'Survivors stop waiting only at the agreed turn');
  const blocked = makeReplica(0, []);
  blocked.lockstep.scheduleDeparture(0, [2], []);
  assert.equal(blocked.lockstep.tick(), false);
  assert.deepEqual(blocked.state.applied, [], 'Waiting for surviving input does not mutate native state partway through a turn');
  for (const lost of [[2], [0], [1, 3]]) {
    const slots = lost.length > 1 ? [0, 1, 2, 3] : [0, 1, 2];
    const survivors = slots.filter(slot => !lost.includes(slot)), peers = [], wire = [], failures = [];
    for (const localSlot of survivors) peers.push(makeReplica(localSlot, peers, slots));
    for (const replica of peers) replica.departures = new PeerDepartures({
      lockstep: replica.lockstep, player: replica.localSlot, playerSlots: Object.fromEntries(slots.map(slot => [slot, slot])), detach: () => {},
      send: (message, target = null) => { for (const peer of peers) if (peer !== replica && (target === null || peer.localSlot === target)) wire.push([peer, message, replica.localSlot]); },
      onError: error => failures.push(error.message),
    });
    peers[0].lockstep.receiveTurn(lost[0], 0, new Uint8Array([9]));
    for (const slot of lost) peers[0].departures.lost(slot);
    let remaining = 1000;
    while (wire.length && remaining-- > 0) {
      const [peer, message, sender] = wire.shift(); peer.departures.handle(message, sender);
    }
    assert.ok(remaining > 0, 'Departure agreement terminates');
    assert.deepEqual(failures, []);
    assert.ok(peers.every(peer => !peer.lockstep.networkPaused && lost.every(slot => !peer.departures.has(slot))), 'Every survivor accepts the same departed players');
    for (let round = 0; round < 8; round++) for (const peer of peers) peer.lockstep.tick();
    assert.deepEqual(peers[0].state.applied, peers[1].state.applied, 'Coordinated departures preserve all final commands');
    assert.ok(peers.every(peer => peer.lockstep.frame > 2 && lost.every(slot => !peer.lockstep.slots.includes(slot))), 'The surviving game continues');
    assert.equal(peers[0].departures.coordinator(), Math.min(...survivors), 'Authority moves to the lowest surviving player');
    for (const peer of peers) peer.departures.close();
  }
  const lastPlayer = makeReplica(1, [], [0, 1]);
  const lastRecovery = new PeerDepartures({ lockstep: lastPlayer.lockstep, player: 1, playerSlots: { 0: 0, 1: 1 }, send() {}, detach() {}, onError: error => assert.fail(error.message) });
  lastRecovery.lost(0);
  for (let tick = 0; tick < 6; tick++) lastPlayer.lockstep.tick();
  assert.deepEqual(lastPlayer.lockstep.slots, [1], 'The final survivor continues without waiting for the host');
  assert.deepEqual(lastPlayer.state.applied, [[1, 0, [2, 0, 87, 1]]]);
  lastRecovery.close();
  console.log('Mesh ownership, buffered input recovery, shared departure turns, host migration and simultaneous departure checks passed.');
  process.exit(0);
}

if (process.argv[2] === '--test-lobby') {
  const source = readFileSync('web/openbw.js', 'utf8');
  const extract = name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  const functions = ['mpPlayers', 'mpMeshReady', 'mpAllLoaded', 'mpCanStart', 'mpLoadState', 'mpUpdateLobby', 'mpCancelCountdown', 'mpCountdown', 'mpOnControl'].map(extract);
  assert.ok(functions.every(Boolean), 'Actual ready/countdown lobby functions exist');
  const make = new Function('assert', `${functions.join('\n')}
    let mpRole = 'host', mpConnected = true, mpLocked = false, mpCountingDown = false, mpCountdownTimer = 0;
    let mpPlayer = 0, mpCapacity = 4, mpRosterVersion = 1, mpStarted = false, mpAdmissionLocked = false, mpSealing = false;
    const mpRoom = null, mpCode = '12345678', mpServerVersion = 1;
    const mpReadyFlags = Array(8).fill(false), mpRaceRevisions = Array(8).fill(0), sent = [], started = [];
    const mpMembers = Array.from({ length: 8 }, (_, player) => player < 3 ? { id: 'player-' + player, connected: true, peers: [0, 1, 2].filter(peer => peer !== player) } : null);
    const hashes = { mapHash: 'a'.repeat(14), engineHash: 'b'.repeat(64), assetHashes: Array(3).fill('c'.repeat(14)) };
    const mpPrepared = { ...hashes };
    const mpLoadStates = Array.from({ length: 8 }, (_, player) => ({ ready: player < 3, phase: 'Loaded', percent: 100, stagePercent: 100, ...hashes }));
    const field = () => ({ value: '1', disabled: false, checked: false, textContent: '', classList: { toggle() {} } });
    const fields = () => Array.from({ length: 8 }, field);
    const mp = { r: fields(), s: fields(), n: fields(), readyStates: fields(), loadLabels: fields(), loadBars: fields(), loadRetry: field(), ready: field(), start: field(), cancel: field(), giSpeed: field(), giPlayers: field(), expires: field() };
    const mpLink = { ready: () => true, sendControl: message => sent.push(message) };
    const mpMine = () => mpPlayer;
    const mpPublishLobby = () => mpUpdateLobby();
    const failedPeers = [], mpPeerFailure = (...args) => failedPeers.push(args);
    const RACES = [-1, 0, 1, 2].map(value => ({ v: value })), MAPS = [{ file: 'map', starts: 4 }];
    const mpMap = 'map', COUNTDOWN = 5, LOCK_AT = 2;
    const resolveRace = race => race < 0 ? 1 : race, pickStartSlots = () => [0, 1, 2];
    const mpBoot = (...args) => started.push(args), mpSay = () => {};
    const setTimeout = () => 1, clearTimeout = () => {};
    mpCountdown(5);
    assert.equal(sent.length, 0, 'Host cannot count down without everyone ready');
    mpOnControl({ t: 'mesh-failed', peer: 3, member: 'departed' }, 1);
    mpOnControl({ t: 'mesh-failed', peer: 3 }, 1);
    assert.equal(failedPeers.length, 0, 'A stale failure for a departed peer cannot evict another player');
    for (const player of [0, 1, 2]) mpReadyFlags[player] = true;
    mpOnControl({ t: 'loading', phase: 'Game files', percent: 40, stagePercent: 50, ready: false }, 2);
    assert.equal(mpLoadStates[2].percent, 40, 'Third-player download progress is retained');
    assert.equal(mpReadyFlags[2], false, 'A downloading player cannot remain ready');
    assert.equal(mp.start.disabled, true, 'Peer progress cannot enable premature Start');
    mpOnControl({ t: 'loading', phase: 'Loaded', percent: 100, stagePercent: 100, ready: true, ...hashes }, 2);
    assert.equal(mpAllLoaded(), true, 'Matching verified completion restores the dependency gate');
    for (const player of [0, 1, 2]) mpReadyFlags[player] = true;
    mpLoadStates[2].ready = false; mpCountdown(5);
    assert.equal(sent.length, 0, 'Host cannot count down while the peer is downloading');
    mpLoadStates[2].ready = true; mpLoadStates[2].engineHash = 'd'.repeat(64); mpCountdown(5);
    assert.equal(sent.length, 0, 'Different preloaded engines cannot start');
    mpLoadStates[2].engineHash = hashes.engineHash;
    mpMembers[2].peers = [0]; mpCountdown(5);
    assert.equal(sent.length, 0, 'A missing guest-to-guest link prevents Start');
    mpMembers[2].peers = [0, 1]; mpCountdown(5);
    assert.equal(mpCountingDown, true); assert.equal(mp.start.disabled, true);
    mpOnControl({ t: 'ready', ready: false, roster: 1, revisions: [0, 0, 0, 0] }, 1);
    assert.equal(mpCountingDown, false, 'Unready cancels countdown');
    mpReadyFlags.fill(true); mpOnControl({ t: 'race', race: 2, revision: 1 }, 2);
    assert.ok(mpReadyFlags.every(ready => ready === false), 'Any race change invalidates every ready flag');
    mpOnControl({ t: 'ready', ready: true, roster: 1, revisions: [0, 0, 0, 0] }, 1);
    assert.equal(mpReadyFlags[1], false, 'Stale readiness for an old race revision is rejected');
    mpOnControl({ t: 'ready', ready: true, roster: 1, revisions: [0, 0, 1, 0] }, 1);
    assert.equal(mpReadyFlags[1], true);
    const start = { t: 'start', roster: 1, revisions: [0, 0, 1, 0], slots: [{ slot: 2, race: 1 }, { slot: 0, race: 1 }, { slot: 3, race: 2 }], playerSlots: { 0: 2, 1: 0, 2: 3 } };
    mpOnControl(start, 1); assert.equal(started.length, 0, 'A guest cannot force the host to start');
    mpRole = 'join'; mpPlayer = 1; mpReadyFlags.fill(false); mpOnControl(start, 0);
    assert.equal(started.length, 0, 'Joiner refuses premature start');
    for (const player of [0, 1, 2]) mpReadyFlags[player] = true;
    mpOnControl(start, 2); assert.equal(started.length, 0, 'Only the host can start the game');
    mpOnControl({ ...start, slots: [{ slot: 0, race: 1 }, { slot: 0, race: 1 }, { slot: 3, race: 2 }] }, 0);
    assert.equal(started.length, 0, 'Duplicate player slots are rejected');
    mpOnControl(start, 0); assert.equal(started.length, 1, 'Every occupied player being ready permits a valid start');
    assert.equal(started[0][1], 0, 'Each guest receives its assigned native start slot');
    assert.equal(mpReadyFlags[3], false, 'Unoccupied map slots do not require Ready');
    mpMembers[3] = { id: 'joining', connected: false, peers: [] };
    assert.equal(mpCanStart(), false, 'A joining fourth player blocks Start');
  `);
  make(assert);
  const pickSlots = new Function(`${extract('pickStartSlots')}\nreturn pickStartSlots;`)();
  for (const count of [2, 3, 4, 8]) {
    const slots = pickSlots(count, count);
    assert.equal(new Set(slots).size, count);
    assert.ok(slots.every(slot => slot >= 0 && slot < count));
  }
  assert.throws(() => pickSlots(5, 4), /map/);
  const preparedBoot = source.match(/async function instantiateWasm\([^]*?\n\}/)?.[0];
  assert.ok(preparedBoot, 'Actual prepared engine boot function exists');
  const instantiate = new Function('fetch', 'DEV', 'BUILD', 'missionDigest', `${preparedBoot}\nreturn instantiateWasm;`)(() => { throw new Error('Unexpected fetch after Start'); }, true, 'test', () => {});
  const prepared = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  assert.ok((await instantiate('openbw.wasm', {}, false, prepared)).instance instanceof WebAssembly.Instance, 'Prepared engine starts without a network fetch');
  console.log('Multi-player readiness, full mesh, roster/race revision, map capacity, start authority and prepared boot checks passed.');
  process.exit(0);
}

if (process.argv[2] === '--test-campaign-menu') {
  const source = readFileSync('web/openbw.js', 'utf8');
  const progress = source.match(/function campaignProgress\(\) \{[\s\S]*?\n\}/)?.[0];
  const unlocked = source.match(/function campaignUnlocked\(missionId\) \{[\s\S]*?\n\}/)?.[0];
  const progressFunctions = ['cyrb53', 'saveCampaignProgress', 'campaignSequentialProgress', 'campaignProgressCode', 'campaignDecodeCode', 'campaignApplyCode'].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]);
  assert.ok(progress && unlocked, 'Actual campaign progress functions exist');
  assert.ok(progressFunctions.every(Boolean), 'Actual portable progress functions exist');
  const ids = new Function(`return ${source.match(/const campaignMissionIds = (\[[^\n]+\]);/)[1]};`)();
  const menu = readFileSync('web/index.html', 'utf8');
  for (const id of ids) assert.ok(menu.includes(`<option value="${id}">`), `Implemented mission ${id} is available in the actual menu`);
  const stored = new Map();
  const localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const functions = (debug, missionIds = ids) => new Function('localStorage', 'campaignMissionIds', 'campaignProgressKey', 'campaignLegacyProgressKey', 'campaignDebug', 'campaignCodeLimit', `${progress}\n${unlocked}\n${progressFunctions.join('\n')}\nreturn { progress: campaignProgress, unlocked: campaignUnlocked, code: campaignProgressCode, decode: campaignDecodeCode, apply: campaignApplyCode, sequential: campaignSequentialProgress, save: saveCampaignProgress };`)(localStorage, missionIds, 'v2', 'v1', debug, 70);
  const normal = functions(false);
  const firstMissions = ids.filter(id => id === 'terran01' || id === 'bwprotoss01');
  assert.deepEqual(ids.filter(normal.unlocked), firstMissions, 'Each edition starts independently');
  assert.ok(Object.values(normal.progress().victories).every(value => value === false), 'Missing victory flags default false');
  stored.set('v1', JSON.stringify({ version: 1, completed: ['terran04', 'terran05', 'terran09'] }));
  assert.equal(normal.progress().completed.length, 3, 'Existing recorded victories are preserved');
  assert.deepEqual(ids.filter(normal.unlocked), firstMissions, 'Out-of-order wins cannot bypass missing prior victories');
  assert.equal(normal.progress().victories.terran01, false, 'Migration does not fabricate skipped victories');
  assert.equal(JSON.parse(stored.get('v2')).victories.terran09, true, 'Old win records migrate to explicit flags');
  stored.set('v2', JSON.stringify({ version: 2, victories: { terran01: true, terran02: true, terran03: true, terran04: 'true' } }));
  assert.deepEqual(ids.filter(normal.unlocked), ids.slice(0, 4).concat(ids.includes('bwprotoss01') ? ['bwprotoss01'] : []), 'Only true preceding victory flags unlock the next mission');
  const beforeDebug = JSON.stringify([...stored]);
  assert.deepEqual(ids.filter(functions(true).unlocked), ids, 'Debug loading exposes every implemented mission');
  assert.equal(JSON.stringify([...stored]), beforeDebug, 'Debug unlocking does not write progress');
  stored.set('v2', '{invalid');
  assert.deepEqual(ids.filter(normal.unlocked), firstMissions, 'Corrupt new progress cannot resurrect old win records');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 9).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg01'), false, 'Zerg continuation cannot bypass the final Terran victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 10).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg01'), true, 'Completing the Terran campaign unlocks the first Zerg mission');
  assert.equal(normal.unlocked('zerg02'), false, 'Egression cannot bypass the Among the Ruins victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 11).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg02'), true, 'Completing Among the Ruins unlocks Egression');
  assert.equal(normal.unlocked('zerg03'), false, 'The New Dominion requires the Egression victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 12).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg03'), true, 'Completing Egression unlocks The New Dominion');
  assert.equal(normal.unlocked('zerg04'), false, 'Agent of the Swarm requires The New Dominion victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 13).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg04'), true, 'Completing The New Dominion unlocks Agent of the Swarm');
  assert.equal(normal.unlocked('zerg05'), false, 'The Amerigo requires the Agent of the Swarm victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 14).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg05'), true, 'Completing Agent of the Swarm unlocks The Amerigo');
  assert.equal(normal.unlocked('zerg06'), false, 'The Dark Templar requires The Amerigo victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 15).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg06'), true, 'Completing The Amerigo unlocks The Dark Templar');
  assert.equal(normal.unlocked('zerg07'), false, 'The Culling requires The Dark Templar victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 16).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg07'), true, 'Completing The Dark Templar unlocks The Culling');
  assert.equal(normal.unlocked('zerg08'), false, 'Eye for an Eye requires The Culling victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 17).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg08'), true, 'Completing The Culling unlocks Eye for an Eye');
  assert.equal(normal.unlocked('zerg09'), false, 'The Invasion of Aiur requires the Eye for an Eye victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 18).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg09'), true, 'Completing Eye for an Eye unlocks The Invasion of Aiur');
  assert.equal(normal.unlocked('zerg10'), false, 'Full Circle requires The Invasion of Aiur victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 19).map(id => [id, true])) }));
  assert.equal(normal.unlocked('zerg10'), true, 'Completing The Invasion of Aiur unlocks Full Circle');
  assert.equal(normal.unlocked('protoss01'), false, 'First Strike requires the final Zerg victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 20).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss01'), true, 'Completing Full Circle unlocks the Protoss campaign');
  assert.equal(normal.unlocked('protoss02'), false, 'Into the Flames requires the First Strike victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 21).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss02'), true, 'Completing First Strike unlocks Into the Flames');
  assert.equal(normal.unlocked('protoss03'), false, 'Higher Ground requires the Into the Flames victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 22).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss03'), true, 'Completing Into the Flames unlocks Higher Ground');
  assert.equal(normal.unlocked('protoss04'), false, 'The Hunt for Tassadar requires the Higher Ground victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 23).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss04'), true, 'Completing Higher Ground unlocks The Hunt for Tassadar');
  assert.equal(normal.unlocked('protoss05'), false, 'Choosing Sides requires The Hunt for Tassadar victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 24).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss05'), true, 'Completing The Hunt for Tassadar unlocks Choosing Sides');
  assert.equal(normal.unlocked('protoss06'), false, 'Into the Darkness requires Choosing Sides victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 25).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss06'), true, 'Completing Choosing Sides unlocks Into the Darkness');
  assert.equal(normal.unlocked('protoss07'), false, 'Homeland requires Into the Darkness victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 26).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss07'), true, 'Completing Into the Darkness unlocks Homeland');
  assert.equal(normal.unlocked('protoss08'), false, 'The Trial of Tassadar requires Homeland victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 27).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss08'), true, 'Completing Homeland unlocks The Trial of Tassadar');
  assert.equal(normal.unlocked('protoss09'), false, 'Shadow Hunters requires The Trial of Tassadar victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 28).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss09'), true, 'Completing The Trial of Tassadar unlocks Shadow Hunters');
  assert.equal(normal.unlocked('protoss10'), false, 'Eye of the Storm requires Shadow Hunters victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(ids.slice(0, 29).map(id => [id, true])) }));
  assert.equal(normal.unlocked('protoss10'), true, 'Completing Shadow Hunters unlocks Eye of the Storm');
  stored.clear();
  const expansionMissions = ids.filter(id => id.startsWith('bw'));
  const expansion = functions(false, ids.filter(id => !id.startsWith('bw')).concat(expansionMissions));
  assert.equal(expansion.unlocked('bwprotoss01'), true, 'Brood War does not require original campaign completion');
  assert.equal(expansion.unlocked('bwprotoss02'), false, 'Brood War remains sequential internally');
  assert.equal(expansion.unlocked('bwprotoss04'), false, 'A later expansion mission stays locked');
  assert.equal(expansion.unlocked('bwprotoss05'), false, 'The fifth expansion mission stays locked');
  assert.equal(expansion.unlocked('bwprotoss06'), false, 'Return to Char requires all five preceding victories');
  assert.equal(expansion.unlocked('bwprotoss07'), false, 'The Insurgent requires all six preceding victories');
  stored.set('v2', JSON.stringify({ version: 2, victories: { bwprotoss01: true, bwprotoss03: true } }));
  assert.equal(expansion.unlocked('bwprotoss02'), true);
  assert.equal(expansion.unlocked('bwprotoss03'), false, 'A later victory cannot bypass an expansion prerequisite');
  assert.equal(expansion.unlocked('bwprotoss04'), false, 'A later victory cannot bypass preceding expansion missions');
  assert.equal(expansion.unlocked('bwprotoss05'), false, 'A later victory cannot bypass preceding expansion missions');
  assert.equal(expansion.unlocked('bwprotoss06'), false, 'A later victory cannot bypass preceding expansion missions');
  assert.equal(expansion.unlocked('bwprotoss07'), false, 'A later victory cannot bypass preceding expansion missions');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(expansionMissions.slice(0, 5).map(id => [id, true])) }));
  assert.equal(expansion.unlocked('bwprotoss06'), true, 'Completing The Battle of Braxis unlocks Return to Char');
  assert.equal(expansion.unlocked('bwprotoss07'), false, 'The Insurgent stays locked until Return to Char is complete');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(expansionMissions.slice(0, 6).map(id => [id, true])) }));
  assert.equal(expansion.unlocked('bwprotoss07'), true, 'Completing Return to Char unlocks The Insurgent');
  assert.equal(expansion.unlocked('bwprotoss08'), false, 'Countdown requires all seven preceding victories');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(expansionMissions.slice(0, 7).map(id => [id, true])) }));
  assert.equal(expansion.unlocked('bwprotoss08'), true, 'Completing The Insurgent unlocks Countdown');
  assert.equal(expansion.unlocked('bwterran01'), false, 'The UED episode retains its preceding expansion victory requirement');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(expansionMissions.slice(0, 8).map(id => [id, true])) }));
  assert.equal(expansion.unlocked('bwterran01'), true, 'Completing Countdown unlocks UED First Strike');
  assert.equal(expansion.unlocked('bwterran02'), false, 'Dylarian requires UED First Strike victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(expansionMissions.slice(0, 9).map(id => [id, true])) }));
  assert.equal(expansion.unlocked('bwterran02'), true, 'Completing UED First Strike unlocks Dylarian');
  assert.equal(expansion.unlocked('bwterran03'), false, 'Tarsonis requires Dylarian victory');
  stored.set('v2', JSON.stringify({ version: 2, victories: Object.fromEntries(expansionMissions.slice(0, 10).map(id => [id, true])) }));
  assert.equal(expansion.unlocked('bwterran03'), true, 'Completing Dylarian unlocks Tarsonis');
  assert.equal(expansion.unlocked('terran02'), false, 'Expansion victories do not unlock original missions');
  assert.equal(expansion.sequential(), 0, 'Expansion-only victories do not fabricate original portable progress');
  assert.ok(menu.includes('id="campaign-edition"') && menu.includes('<option value="bw">Brood War</option>'), 'Actual menu offers an edition switch');
  const codes = Array.from({ length: 71 }, (_, completed) => normal.code(completed));
  assert.deepEqual([0, 1, 10, 30, 56, 70].map(completed => [completed, codes[completed]]), [[0, 'b6c3c1'], [1, 'e62c8f'], [10, 'c1fe99'], [30, '9a5127'], [56, '860700'], [70, 'b2d0c9']], 'Published progress codes retain their format');
  assert.equal(new Set(codes).size, 71, 'Every sequential state through seventy missions has a unique code');
  for (let completed = 0; completed <= 70; completed++) {
    assert.match(codes[completed], /^[a-f0-9]{6}$/);
    assert.equal(normal.decode(' ' + codes[completed].toUpperCase() + ' '), completed);
  }
  for (const invalid of ['', 'AA', '12345', '1234567', 'gggggg', '000000', null]) assert.equal(normal.decode(invalid), null);
  stored.clear();
  stored.set('v2', JSON.stringify({ version: 2, victories: { terran01: true, terran04: true, terran09: true } }));
  assert.equal(normal.apply(codes[3]), true);
  assert.equal(normal.sequential(), 4, 'Imported prefix merges with existing later victories');
  assert.equal(normal.progress().victories.terran09, true, 'Import preserves out-of-order local wins');
  const ahead = JSON.stringify([...stored]);
  assert.equal(normal.apply(codes[2]), false);
  assert.equal(normal.apply(codes[4]), false);
  assert.equal(JSON.stringify([...stored]), ahead, 'Equal or older codes never rewrite local progress');
  assert.throws(() => normal.apply('gggggg'), /Invalid/);
  assert.equal(JSON.stringify([...stored]), ahead);
  assert.equal(normal.apply(codes[70]), true);
  assert.equal(normal.sequential(), 70, 'Future campaign progress survives with only ten missions currently implemented');
  const expanded = functions(false, ids.concat(Array.from({ length: 70 - ids.length }, (_, index) => 'future-' + index)));
  assert.equal(expanded.sequential(), 70, 'The same portable prefix survives expansion of the mission catalogue');
  assert.equal(expanded.progress().completed.length, 70);
  normal.save(normal.progress());
  assert.equal(functions(false).sequential(), 70, 'Ordinary victory persistence preserves portable future progress');
  assert.throws(() => functions(true).apply(codes[70]), /debug/);
  assert.equal(normal.sequential(), 70);
  assert.throws(() => normal.code(71), /Unsupported/);
  stored.set('v2', JSON.stringify({ version: 2, victories: { terran01: true, terran02: false }, importedPrefix: 70 }));
  assert.equal(normal.sequential(), 1, 'A counter contradicting an explicit missing victory cannot unlock it');
  const beforeFailedWrite = JSON.stringify([...stored]), originalWrite = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('Simulated storage limit'); };
  assert.throws(() => normal.apply(codes[2]), /storage limit/);
  assert.equal(JSON.stringify([...stored]), beforeFailedWrite, 'Storage failure preserves the previous progress atomically');
  localStorage.setItem = originalWrite;
  console.log('Campaign victory flags, migration, strict unlocks, six-hex forward-only progress codes through seventy missions and debug isolation passed.');
  console.log('Progress code vectors:', JSON.stringify([0, 1, 10, 30, 56, 70].map(completed => [completed, codes[completed]])));
  process.exit(0);
}

const recoveryTest = process.argv[2] === '--test-campaign-save';
const protossSelectionTest = process.argv[2] === '--test-protoss-selection';
const campaign = process.argv[2] === '--test-campaign' || recoveryTest;
const missionId = campaign ? process.argv[3] || 'terran01' : null;
if (campaign) assert.ok(campaignMissions.includes(missionId), 'Unsupported test mission');
const groupMinesTest = process.argv[2] === '--test-group-mines';
const out = campaign || protossSelectionTest || groupMinesTest || process.argv[2] === '--test-commands' ? null : process.argv[2] || 'wasm-shot.ppm';
const mission = campaign ? JSON.parse(readFileSync(`web/data/campaign/${missionId}.json`, 'utf8')) : null;

// Archive index mapping must match wasm_main.cpp's js_file_reader.
const files = [
  readFileSync('web/data/STARDAT.MPQ'),
  readFileSync('web/data/BROODAT.MPQ'),
  readFileSync('web/data/patch_rt.mpq'),
  readFileSync(campaign ? `web/data/campaign/${missionId}.mpq` : 'web/maps/Weave_v1.scx'),
];

const wasi = new WASI({ version: 'preview1', args: ['openbw'], preopens: {} });

let memory;
const missionSoundLoads = [];
const soundPlays = [];
let soundClockOffset = 0n;
const env = {
  js_file_size: (index) => files[index].length,
  js_read_data: (index, dst, offset, n) => {
    const mem = new Uint8Array(memory.buffer);
    mem.set(files[index].subarray(offset, offset + n), dst);
  },
  // no audio in headless Node — stubs so instantiation doesn't fail
  js_sound_load: (pointer, size) => {
    if (!campaign) return -1;
    missionSoundLoads.push({ pointer, size });
    return missionSoundLoads.length - 1;
  }, js_sound_play: (...args) => { soundPlays.push(args); }, js_sound_is_playing: () => 0,
  js_sound_stop: () => {}, js_sound_set_volume: () => {},
};

const module = await WebAssembly.compile(readFileSync('web/openbw.wasm'));
const wasiImports = wasi.getImportObject();
const readClock = wasiImports.wasi_snapshot_preview1.clock_time_get;
wasiImports.wasi_snapshot_preview1.clock_time_get = (clock, precision, output) => {
  const result = readClock(clock, precision, output);
  if (!result && soundClockOffset) {
    const data = new DataView(memory.buffer);
    data.setBigUint64(output, data.getBigUint64(output, true) + soundClockOffset, true);
  }
  return result;
};
const instance = await WebAssembly.instantiate(module, {
  ...wasiImports,
  env,
});
memory = instance.exports.memory;
wasi.initialize(instance);   // reactor: runs ctors + libc init

const recordedTurns = [];
let recordedTicks = 0, recording = false;
const nativeExports = instance.exports;
const x = recoveryTest ? {
  ...nativeExports,
  openbw_mission_begin() { nativeExports.openbw_mission_begin(); recording = true; },
  openbw_step() { nativeExports.openbw_step(); if (recording) recordedTicks++; },
  openbw_apply(owner, length) {
    recordedTurns.push({ tick: recordedTicks, owner, bytes: new Uint8Array(memory.buffer, nativeExports.openbw_in_ptr(length), length).slice() });
    nativeExports.openbw_apply(owner, length);
  },
} : nativeExports;
if (campaign) x.openbw_init_campaign(1280, 800, mission.race, mission.humanSlot, mission.createStartingUnits ? 1 : 0);
else x.openbw_init(1280, 800, protossSelectionTest ? 2 : 1, 0 /*slot*/);
if (!campaign) for (let i = 0; i < 4; i++) x.openbw_step();
x.openbw_render(0);

if (out) {
  const w = x.openbw_framebuffer_width();
  const h = x.openbw_framebuffer_height();
  const ptr = x.openbw_framebuffer();
  const fb = new Uint8Array(memory.buffer, ptr, w * h * 4);

  // RGBA -> PPM (P6)
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  const body = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++) {
    body[j++] = fb[i * 4 + 0];
    body[j++] = fb[i * 4 + 1];
    body[j++] = fb[i * 4 + 2];
  }
  writeFileSync(out, Buffer.concat([header, body]));
  console.log(`wrote ${out} (${w}x${h})`);
} else if (campaign) {
  testCampaign();
  if (recoveryTest) {
    const expectedChecksum = x.openbw_checksum();
    const expectedUnits = readRecoveryString(x.openbw_debug_units());
    const saved = validateCampaignSave(JSON.parse(JSON.stringify(sealCampaignSave({
      mission: missionId, title: mission.title, ticks: recordedTicks, frame: x.openbw_frame(), checksum: expectedChecksum >>> 0, savedAt: Date.now(),
      packHash: mission.pack.sha256, engineHash: createHash('sha256').update(readFileSync('web/openbw.wasm')).digest('hex'),
      assetHashes: files.slice(0, 3).map(bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 14)),
      turns: recordedTurns.map(turn => ({ tick: turn.tick, bytes: Array.from(turn.bytes) })), view: { camera: [0, 0], selection: [] },
    }))));
    assert.throws(() => validateCampaignSave({ ...saved, checksum: saved.checksum ^ 1 }), /integrity|Invalid/, 'Corrupt save cannot load');
    assert.throws(() => validateCampaignSave(saved, { ...saved, engineHash: '0'.repeat(64) }), /requires the engine/, 'Incompatible runtime cannot load');
    const resumedWasi = new WASI({ version: 'preview1', args: ['openbw'], preopens: {} });
    const resumed = await WebAssembly.instantiate(module, { ...resumedWasi.getImportObject(), env });
    memory = resumed.exports.memory;
    resumedWasi.initialize(resumed);
    const restored = resumed.exports;
    restored.openbw_init_campaign(1280, 800, mission.race, mission.humanSlot, mission.createStartingUnits ? 1 : 0);
    restored.openbw_mission_begin();
    let turn = 0;
    for (let tick = 0; tick < saved.ticks; tick++) {
      while (saved.turns[turn]?.tick === tick) {
        const command = saved.turns[turn++];
        const input = restored.openbw_in_ptr(command.bytes.length);
        new Uint8Array(memory.buffer).set(command.bytes, input);
        restored.openbw_apply(mission.humanSlot, command.bytes.length);
      }
      restored.openbw_step();
      const events = readRecoveryString(restored.openbw_mission_events()).trim();
      if (events) restored.openbw_mission_ack(Number(events.split('\n').at(-1).split('\t')[1]));
    }
    assert.equal(turn, saved.turns.length, 'All saved command turns replay at their original service tick');
    assert.equal(restored.openbw_checksum(), expectedChecksum, 'Recovered simulation checksum matches the saved game');
    assert.equal(readRecoveryString(restored.openbw_debug_units()), expectedUnits, 'Recovered actors, ownership, positions and orders match');
    console.log(`Campaign deterministic recovery passed: ${recordedTicks} service ticks, ${recordedTurns.length} command batches.`);
  }
} else if (protossSelectionTest) {
  testProtossSelection();
} else {
  testCommands(groupMinesTest);
}

function readRecoveryString(pointer) {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (bytes[end]) end++;
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}

function testCampaign() {
  const read = pointer => {
    const bytes = new Uint8Array(memory.buffer);
    let end = pointer;
    while (bytes[end]) end++;
    return new TextDecoder().decode(bytes.subarray(pointer, end));
  };
  const units = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t'));
  const human = units.filter(unit => Number(unit[2]) === mission.humanSlot);
  if (missionId === 'terran02') {
    assert.equal(units.length, 79, 'Expected 79 non-neutral actors, without melee starts');
    assert.equal(units.filter(unit => Number(unit[2]) === mission.humanSlot).length, 11);
    assert.equal(units.filter(unit => Number(unit[2]) === 2).length, 0, 'Raynor is naturally rescued during startup');
    assert.ok(units.some(unit => unit[1] === 'Jim Raynor' && Number(unit[2]) === mission.humanSlot));
    assert.equal(units.filter(unit => Number(unit[2]) === 3).length, 7, 'Preserve the rescuable station');
    assert.equal(units.filter(unit => Number(unit[2]) === 4).length, 61, 'Preserve original enemy units and buildings');
    console.log('Backwater initialization checks passed.');
  } else if (missionId === 'terran03') {
    assert.equal(human.length, 34, 'Preserve the original human base and army');
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 16);
    assert.equal(human.filter(unit => unit[1] === 'SCV').length, 3);
    const vultures = human.filter(unit => unit[1] === 'Vulture');
    assert.equal(vultures.length, 3);
    for (const touch of [0, 1]) {
      x.openbw_set_touch_controls(touch);
      for (const vulture of vultures) {
        x.openbw_debug_select(Number(vulture[0]), 0); x.openbw_render(0);
        assert.doesNotMatch(read(x.openbw_card()), /Mines \d+|\tSpider Mines\t/, 'Original Terran 3 Vultures hide mine ammunition and the ability before research');
      }
    }
    x.openbw_set_touch_controls(0); x.openbw_debug_select(0, 0); x.openbw_out_clear();
    const enemy = units.filter(unit => Number(unit[2]) === 4);
    assert.ok(enemy.length >= 135 && enemy.length <= 138, 'Original enemy force plus native Hatchery larva');
    assert.equal(enemy.filter(unit => unit[1] === 'Drone').length, 6);
    assert.equal(x.openbw_mission_countdown(), -1, 'No countdown before the original initialization action');
    console.log('Desperate Alliance initialization checks passed.');
  } else if (missionId === 'terran04') {
    assert.equal(mission.humanSlot, 0, 'Keep the original installation human slot');
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 7);
    assert.equal(human.filter(unit => unit[1] === 'Firebat').length, 4);
    assert.equal(human.filter(unit => unit[1] === 'SCV').length, 0, 'Installation starts without a buildable economy');
    assert.ok(human.some(unit => unit[1] === 'Jim Raynor'), 'Marine Raynor is naturally rescued at startup');
    assert.equal(x.openbw_mission_countdown(), -1, 'Installation has no survival countdown');
    console.log('Jacobs Installation initialization checks passed.');
  } else if (missionId === 'terran05') {
    assert.equal(mission.humanSlot, 0, 'Keep the original Revolution human slot');
    assert.equal(human.length, 9, 'Original eight Marines and naturally rescued Raynor');
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 8);
    assert.ok(human.some(unit => unit[1] === 'Jim Raynor'));
    x.openbw_debug_select(Number(human.find(unit => unit[1] === 'Marine')[0]), 0); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /\tStim Pack\t0\t/, 'Original Revolution Marines cannot use Stim before research');
    x.openbw_debug_select(0, 0); x.openbw_out_clear();
    assert.ok(units.some(unit => unit[1] === 'Sarah Kerrigan' && Number(unit[2]) === 2), 'Kerrigan awaits separate proximity rescue');
    assert.ok(units.some(unit => unit[1] === 'Command Center' && Number(unit[2]) === 3), 'Antigan base retains its original neutral owner');
    assert.equal(x.openbw_mission_countdown(), -1, 'Revolution has no survival countdown');
    console.log('Revolution initialization checks passed.');
  } else if (missionId === 'terran06') {
    assert.equal(mission.humanSlot, 0, 'Keep the original Norad II human slot');
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 4);
    assert.equal(human.filter(unit => unit[1] === 'Firebat').length, 1);
    assert.equal(human.filter(unit => unit[1] === 'SCV').length, 2);
    assert.ok(human.some(unit => unit[1] === 'Jim Raynor'));
    assert.ok(units.some(unit => unit[1].includes('Norad') && Number(unit[2]) === 2), 'Original crashed flagship remains separately rescuable');
    assert.equal(x.openbw_mission_countdown(), -1, 'Norad II has no countdown');
    console.log('Norad II initialization checks passed.');
  } else if (missionId === 'terran07') {
    assert.equal(mission.humanSlot, 0, 'Keep the original Trump Card human slot');
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 11);
    assert.equal(human.filter(unit => unit[1] === 'SCV').length, 5);
    assert.equal(human.filter(unit => unit[1] === 'Science Vessel').length, 1);
    assert.ok(human.some(unit => unit[1] === 'Sarah Kerrigan'), 'Kerrigan is naturally rescued during startup');
    assert.equal(x.openbw_mission_countdown(), -1, 'The Trump Card has no countdown');
    for (const [producer, expansionUnit] of [['Barracks', 'Medic'], ['Starport', 'Valkyrie']]) {
      const building = human.find(unit => unit[1] === producer);
      assert.ok(building, `Original ${producer} for retail unit restrictions`);
      x.openbw_debug_select(Number(building[0]), 0);
      x.openbw_render(0);
      assert.equal(read(x.openbw_card()).split('\n').some(line => line.split('\t')[1] === expansionUnit), false, `${expansionUnit} must not appear in the original campaign production card`);
    }
    x.openbw_debug_select(0, 0);
    x.openbw_out_clear();
    console.log('The Trump Card initialization checks passed.');
  } else if (missionId === 'terran08') {
    assert.equal(mission.humanSlot, 0, 'Keep the original Big Push human slot');
    assert.equal(human.length, 22, 'Original fleet and naturally rescued Duke');
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 4);
    assert.equal(human.filter(unit => unit[1] === 'Ghost').length, 2);
    assert.equal(human.filter(unit => unit[1] === 'SCV').length, 4);
    assert.equal(human.filter(unit => unit[1] === 'Dropship').length, 2);
    const duke = human.find(unit => unit[1] === 'Norad II');
    assert.ok(duke, 'Duke is the original flying hero Battlecruiser');
    x.openbw_debug_select(Number(duke[0]), 0);
    x.openbw_render(0);
    assert.match(read(x.openbw_card()), /Yamato/);
    const buildings = human.filter(unit => ['Command Center', 'Barracks', 'Factory', 'Starport', 'Science Facility'].includes(unit[1]));
    assert.equal(buildings.length, 6, 'Original six in-transit buildings');
    for (const building of buildings) {
      x.openbw_debug_select(Number(building[0]), 0);
      x.openbw_render(0);
      assert.match(read(x.openbw_card()), /\tLand\t/, 'Authored airborne buildings expose native Land');
    }
    x.openbw_debug_select(0, 0);
    x.openbw_out_clear();
    assert.equal(x.openbw_mission_countdown(), -1, 'The Big Push has no survival countdown');
    console.log('The Big Push initialization checks passed.');
  } else if (missionId === 'terran09') {
    assert.equal(mission.humanSlot, 0, 'Keep the original New Gettysburg human slot');
    assert.equal(human.length, 18, 'Original Terran force and naturally rescued Kerrigan');
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 6);
    assert.equal(human.filter(unit => unit[1] === 'SCV').length, 2);
    assert.equal(human.filter(unit => unit[1] === 'Dropship').length, 1);
    assert.ok(human.some(unit => unit[1] === 'Sarah Kerrigan'), 'Kerrigan is naturally rescued at the original base');
    assert.ok(units.some(unit => unit[1] === 'Nexus' && unit[2] === '1'), 'Original Protoss bases remain intact');
    assert.ok(units.some(unit => unit[1] === 'Hive' && unit[2] === '3'), 'Original Zerg buildings remain intact');
    assert.equal(x.openbw_mission_countdown(), -1, 'New Gettysburg has no survival countdown');
    console.log('New Gettysburg initialization checks passed.');
  } else if (missionId === 'terran10') {
    assert.equal(mission.humanSlot, 1, 'Keep the original Hammer Falls human slot');
    assert.equal(human.length, 32, 'Original Terran army, two native tank turrets and naturally rescued Raynor');
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 16);
    assert.equal(human.filter(unit => unit[1] === 'SCV').length, 4);
    assert.equal(human.filter(unit => unit[1] === 'Firebat').length, 2);
    assert.equal(human.filter(unit => unit[1].startsWith('Siege Tank')).length, 2, 'Original two tanks');
    assert.ok(human.some(unit => unit[1] === 'Jim Raynor'), 'Vulture Raynor is naturally rescued at the original base');
    assert.ok(units.some(unit => unit[1] === 'Ion Cannon' && unit[2] === '6'), 'Original Ion Cannon retains its enemy owner');
    assert.equal(x.openbw_mission_countdown(), -1, 'The Hammer Falls has no survival countdown');
    console.log('The Hammer Falls initialization checks passed.');
  } else if (missionId === 'zerg01') {
    assert.equal(mission.episode, 2);
    assert.equal(mission.race, 0, 'Original mission uses Zerg, not a Terran UI substitution');
    assert.equal(mission.humanSlot, 3, 'Preserve the original Zerg human slot');
    assert.equal(human.filter(unit => unit[1] === 'Drone').length, 2);
    assert.equal(human.filter(unit => unit[1] === 'Zergling').length, 12);
    assert.equal(human.filter(unit => unit[1] === 'Overlord').length, 1);
    assert.equal(human.filter(unit => unit[1] === 'Hatchery').length, 1);
    assert.ok(human.some(unit => unit[1] === 'Larva'), 'Original Hatchery supplies native Larva');
    assert.ok(human.some(unit => unit[1].includes('Beacon')), 'Original Zerg beacon remains present');
    assert.equal(x.openbw_mission_countdown(), -1, 'Among the Ruins has no survival countdown');
    console.log('Among the Ruins original Zerg initialization checks passed.');
  } else if (missionId === 'zerg02') {
    assert.equal(mission.episode, 2);
    assert.equal(mission.order, 2);
    assert.equal(mission.race, 0);
    assert.equal(mission.humanSlot, 3, 'Preserve the original Egression human slot');
    for (const [type, count] of [['Drone', 2], ['Hydralisk', 3], ['Mutalisk', 2], ['Overlord', 3], ['Hatchery', 2]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.ok(human.some(unit => unit[1] === 'Larva'), 'Original Hatcheries supply native Larva');
    assert.ok(human.some(unit => unit[1].includes('Beacon')), 'Original standing Chrysalis remains present');
    assert.equal(units.filter(unit => unit[1] === 'Hunter Killer' && unit[2] === '0').length, 6, 'The six original Hunter Killers begin with rescue ownership');
    assert.equal(x.openbw_mission_countdown(), -1, 'Egression has no opening recovery countdown');
    console.log('Egression original Zerg initialization checks passed.');
  } else if (missionId === 'zerg03') {
    assert.equal(mission.episode, 2); assert.equal(mission.race, 0); assert.equal(mission.humanSlot, 3);
    for (const [type, count] of [['Drone', 2], ['Hydralisk', 4], ['Mutalisk', 4], ['Overlord', 3], ['Hatchery', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(human.filter(unit => unit[1] === 'Mature Crysalis').length, 1, 'Original mature Chrysalis and its native display label are preserved');
    assert.equal(x.openbw_mission_countdown(), -1, 'The New Dominion has no invented opening countdown');
    console.log('The New Dominion original Zerg initialization checks passed.');
  } else if (missionId === 'zerg04') {
    assert.equal(mission.episode, 2); assert.equal(mission.race, 0); assert.equal(mission.humanSlot, 3);
    for (const [type, count] of [['Drone', 3], ['Hydralisk', 4], ['Zergling', 6], ['Queen', 2], ['Overlord', 2], ['Hatchery', 1], ['Mature Crysalis', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(human.filter(unit => unit[1] === 'Infested Kerrigan').length, 0, 'Kerrigan must be created by the original hatch trigger');
    console.log('Agent of the Swarm original Zerg initialization checks passed.');
  } else if (missionId === 'zerg05') {
    assert.equal(mission.episode, 2); assert.equal(mission.race, 0); assert.equal(mission.humanSlot, 3);
    assert.equal(human.filter(unit => unit[1] === 'Infested Kerrigan').length, 1);
    assert.equal(human.filter(unit => unit[1] === 'Zergling').length, 6);
    assert.equal(human.filter(unit => unit[1] === 'Hunter Killer').length, 2, 'Native opening proximity rescues the two original Hunter Killers');
    assert.equal(x.openbw_mission_countdown(), -1, 'The Amerigo has no invented countdown');
    console.log('The Amerigo original Zerg initialization checks passed.');
  } else if (missionId === 'zerg06') {
    assert.equal(mission.episode, 2); assert.equal(mission.race, 0); assert.equal(mission.humanSlot, 3);
    for (const [type, count] of [['Drone', 4], ['Hydralisk', 4], ['Mutalisk', 2], ['Guardian', 2], ['Overlord', 3], ['Hatchery', 1], ['Infested Kerrigan', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.filter(unit => unit[1] === 'Tassadar').length, 0, 'Tassadar must be created by the original challenge trigger');
    assert.equal(x.openbw_mission_countdown(), -1, 'The Dark Templar has no invented countdown');
    console.log('The Dark Templar original Zerg initialization checks passed.');
  } else if (missionId === 'zerg07') {
    assert.equal(mission.episode, 2); assert.equal(mission.race, 0); assert.equal(mission.humanSlot, 3);
    assert.equal(human.length, 20, 'The Culling starts with only its original mobile force');
    for (const [type, count] of [['Drone', 4], ['Hydralisk', 8], ['Mutalisk', 4], ['Overlord', 4], ['Hatchery', 0], ['Larva', 0], ['Infested Kerrigan', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(x.openbw_mission_countdown(), -1, 'The Culling has no invented visible countdown');
    console.log('The Culling original baseless Zerg initialization checks passed.');
  } else if (missionId === 'zerg08') {
    assert.equal(mission.episode, 2); assert.equal(mission.race, 0); assert.equal(mission.humanSlot, 3);
    for (const [type, count] of [['Drone', 2], ['Hydralisk', 6], ['Zergling', 9], ['Ultralisk', 2], ['Overlord', 5], ['Hatchery', 3], ['Nydus Canal', 4], ['Infested Kerrigan', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(x.openbw_mission_countdown(), -1, 'Eye for an Eye has no invented visible countdown');
    console.log('Eye for an Eye original Zerg bases, canals and force checks passed.');
  } else if (missionId === 'zerg09') {
    assert.equal(mission.episode, 2); assert.equal(mission.race, 0); assert.equal(mission.humanSlot, 3);
    for (const [type, count] of [['Drone', 4], ['Hydralisk', 2], ['Zergling', 6], ['Overlord', 3], ['Hatchery', 1], ['Spawning Pool', 1], ['Evolution Chamber', 1], ['Sunken Colony', 1], ['Infested Kerrigan', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.ok(human.some(unit => unit[1] === 'Larva'), 'Original Hatchery supplies native Larva');
    assert.ok(units.some(unit => unit[1].includes('Khaydarin') && unit[2] === '6'), 'Original formation retains its neutral owner');
    assert.equal(human.some(unit => unit[1] === 'Khaydarin Crystal'), false, 'The portable crystal must be created by the original completed-harvest trigger');
    assert.equal(x.openbw_mission_countdown(), -1, 'The harvest countdown cannot start before Drone contact');
    console.log('The Invasion of Aiur original Zerg base, force and neutral formation checks passed.');
  } else if (missionId === 'zerg10') {
    assert.equal(mission.episode, 2); assert.equal(mission.order, 10); assert.equal(mission.race, 0); assert.equal(mission.humanSlot, 3);
    for (const [type, count] of [['Drone', 3], ['Hydralisk', 3], ['Zergling', 6], ['Ultralisk', 1], ['Overlord', 4], ['Hatchery', 1], ['Creep Colony', 2], ['Infested Kerrigan', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.ok(human.some(unit => unit[1] === 'Larva'), 'Original Hatchery supplies native Larva');
    assert.ok(units.some(unit => unit[1].includes('Temple') && unit[2] === '0'), 'Original Protoss Temple retains its Red owner');
    assert.equal(human.some(unit => unit[1] === 'Khaydarin Crystal'), false, 'The crystal must be created by the original credited Temple-kill trigger');
    assert.equal(x.openbw_mission_countdown(), -1, 'Full Circle has no invented countdown');
    console.log('Full Circle original Zerg base, force and Protoss Temple checks passed.');
  } else if (missionId === 'protoss01') {
    assert.equal(mission.episode, 3); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    assert.equal(human.length, 8, 'First Strike starts with only its original field army');
    for (const [type, count] of [['Zealot', 6], ['Dragoon', 2], ['Probe', 0], ['Nexus', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.ok(units.some(unit => unit[1].includes('Fenix') && unit[2] === '2'), 'Original Fenix remains rescuable');
    assert.ok(units.some(unit => unit[1] === 'Nexus' && unit[2] === '1'), 'Original Antioch remains rescuable');
    assert.equal(x.openbw_mission_countdown(), -1, 'First Strike has no invented countdown');
    console.log('First Strike original Protoss army and rescue ownership checks passed.');
  } else if (missionId === 'protoss02') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 2); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    for (const [type, count] of [['Probe', 3], ['Zealot', 4], ['Dragoon', 2], ['Nexus', 1], ['Pylon', 2], ['Reaver', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.some(unit => unit[1].includes('Fenix')), false, 'Fenix must be created by the original countdown-expiry trigger');
    assert.ok(units.some(unit => unit[1].includes('Cerebrate') && unit[2] === '6'), 'Original Cerebrate retains its Zerg owner');
    console.log('Into the Flames original Protoss base, army and deferred Fenix checks passed.');
  } else if (missionId === 'protoss03') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 3); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    for (const [type, count] of [['Probe', 4], ['Zealot', 4], ['Dragoon', 3], ['Scout', 3], ['Nexus', 1], ['Pylon', 3]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.some(unit => unit[1].includes('Fenix')), false, 'Higher Ground has no invented Fenix actor or survival condition');
    assert.equal(x.openbw_mission_countdown(), -1, 'Higher Ground has no invented countdown');
    console.log('Higher Ground original Protoss ground/air force and both-colony checks passed.');
  } else if (missionId === 'protoss04') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 4); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    for (const [type, count] of [['Zealot', 4], ['Dragoon', 4], ['High Templar', 1], ['Nexus', 0], ['Probe', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.ok(units.some(unit => unit[1] === 'Tassadar' && unit[2] === '2'), 'Original Tassadar remains rescuable');
    assert.ok(units.some(unit => unit[1] === 'Nexus' && unit[2] === '1'), 'Original base remains rescuable');
    assert.equal(x.openbw_mission_countdown(), -1, 'The Hunt for Tassadar has no invented countdown');
    console.log('The Hunt for Tassadar original army and rescue ownership checks passed.');
  } else if (missionId === 'protoss05') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 5); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    for (const [type, count] of [['Probe', 4], ['Zealot', 4], ['Dragoon', 3], ['Shuttle', 1], ['Nexus', 1], ['Pylon', 3], ['Gateway', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.filter(unit => unit[1] === 'Tassadar').length, 1, 'Keep the single original naturally rescuable Tassadar');
    assert.equal(units.some(unit => unit[1] === 'Wraith'), false, 'Duke reinforcements must wait for an original confrontation gate');
    assert.equal(x.openbw_mission_countdown(), -1, 'Choosing Sides has no invented countdown');
    console.log('Choosing Sides original base, Shuttle, force and gated Terran confrontation checks passed.');
  } else if (missionId === 'protoss06') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 6); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    for (const [type, count] of [['Zealot', 2], ['Probe', 0], ['Nexus', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.filter(unit => unit[1] === 'Tassadar').length, 1, 'Keep the single original naturally rescuable Tassadar');
    assert.equal(units.filter(unit => unit[1] === 'Zeratul' && unit[2] === '2').length, 1, 'Original Zeratul remains rescuable in the installation');
    assert.equal(units.filter(unit => unit[2] === '5' && !unit[1].includes('Beacon')).length, 8, 'Keep all eight original classic Dark Templars under rescue ownership');
    assert.equal(x.openbw_mission_countdown(), -1, 'Into the Darkness has no invented countdown');
    console.log('Into the Darkness original indoor force and rescue ownership checks passed.');
  } else if (missionId === 'protoss07') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 7); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    for (const [type, count] of [['Probe', 2], ['Zealot', 8], ['Dragoon', 4], ['Scout', 1], ['Observer', 1], ['Nexus', 1], ['Pylon', 10]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    for (const hero of ['Fenix', 'Tassadar', 'Zeratul']) assert.equal(units.filter(unit => unit[1].includes(hero)).length, 1, 'Keep each single original Homeland hero');
    assert.equal(units.filter(unit => unit[1] === 'Nexus' && unit[2] === '0').length, 2, 'Original Conclave force keeps both Nexuses');
    assert.equal(units.filter(unit => unit[1] === 'Nexus' && unit[2] === '4').length, 1, 'Original shrine force keeps its Nexus');
    assert.equal(x.openbw_mission_countdown(), -1, 'Homeland has no invented countdown');
    console.log('Homeland original full base, heroes and Conclave Nexus checks passed.');
  } else if (missionId === 'protoss08') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 8); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    for (const [type, count] of [['Probe', 4], ['Zealot', 4], ['Dragoon', 3], ['Carrier', 1], ['Nexus', 1], ['Pylon', 3]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.ok(units.some(unit => unit[1].includes('Hyperion')), 'Keep the original rescuable Raynor Battlecruiser');
    assert.ok(units.some(unit => unit[1].includes('Stasis') && unit[2] === '0'), 'Keep the original enemy Stasis Cell');
    assert.equal(units.some(unit => unit[1].includes('Interceptor')), false, 'The original Carrier starts without invented Interceptors');
    assert.equal(units.some(unit => unit[1] === 'Tassadar'), false, 'Tassadar must be created by the original prison-destruction ending');
    assert.equal(x.openbw_mission_countdown(), -1, 'The Trial of Tassadar has no invented countdown');
    console.log('The Trial of Tassadar original base, empty Carrier, Raynor and Stasis Cell checks passed.');
  } else if (missionId === 'protoss09') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 9); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 7);
    for (const [type, count] of [['Probe', 4], ['Zealot', 6], ['Dragoon', 2], ['Arbiter', 1], ['Nexus', 0], ['Pylon', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    for (const hero of ['Fenix', 'Zeratul']) assert.equal(units.filter(unit => unit[1].includes(hero)).length, 1, 'Keep each single original Shadow Hunters hero');
    for (const owner of ['5', '6']) assert.equal(units.filter(unit => unit[1] === 'Cerebrate' && unit[2] === owner).length, 1, 'Keep each original Cerebrate with its authored owner');
    assert.equal(x.openbw_mission_countdown(), -1, 'Shadow Hunters has no invented countdown');
    console.log('Shadow Hunters original mobile force, heroes and both Cerebrate checks passed.');
  } else if (missionId === 'protoss10') {
    assert.equal(mission.episode, 3); assert.equal(mission.order, 10); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 1, 'The final mission uses original human slot one, not the earlier Protoss slot seven');
    for (const [type, count] of [['Probe', 4], ['Nexus', 1], ['Pylon', 2], ['Photon Cannon', 2], ['SCV', 0], ['Command Center', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.ok(units.some(unit => unit[1].includes('Gantrithor')) && units.some(unit => unit[1] === 'Zeratul'), 'Keep the original Gantrithor and Zeratul without substitutes');
    assert.ok(units.some(unit => unit[1].includes('Overmind') && unit[2] === '3'), 'Keep the original Overmind with its authored owner');
    assert.equal(units.some(unit => unit[1].includes('Hyperion')), false, 'Raynor and the Terran force must come from the original setup trigger');
    assert.equal(x.openbw_mission_countdown(), -1, 'Eye of the Storm has no invented countdown');
    console.log('Eye of the Storm original slot-1 Protoss start and deferred Terran setup checks passed.');
  } else if (missionId === 'bwprotoss01') {
    assert.equal(mission.episode, 4); assert.equal(mission.order, 1); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 2);
    for (const [type, count] of [['Zeratul', 1], ['Zealot', 6], ['Dragoon', 3], ['Nexus', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count, 'Preserve the original Zeratul and native opening rescues without a melee base');
    assert.ok(units.some(unit => unit[1] === 'Dragoon' && unit[2] === '7'), 'Keep the original rescuable Protoss force');
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwprotoss02') {
    assert.equal(mission.episode, 4); assert.equal(mission.order, 2); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 5);
    for (const [type, count] of [['Probe', 4], ['Zealot', 4], ['Nexus', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.filter(unit => unit[1] === 'Dark Templar' && unit[2] === '1').length, 4, 'Retain the four original allied expansion Dark Templars');
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwprotoss03') {
    assert.equal(mission.episode, 4); assert.equal(mission.order, 3); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 1);
    for (const [type, count] of [['Probe', 5], ['Dark Templar', 2], ['Nexus', 1], ['Gateway', 1], ['Templar Archives', 1], ['Pylon', 3]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    for (const owner of ['3', '4']) assert.equal(units.filter(unit => unit[1] === 'Cerebrate' && unit[2] === owner).length, 1);
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwprotoss04') {
    assert.equal(mission.episode, 4); assert.equal(mission.order, 4); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 1);
    for (const [type, count] of [['Probe', 4], ['Nexus', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count, 'Create only the original Protoss start at its authored start location');
    assert.equal(units.filter(unit => unit[1] === 'Shuttle' && unit[2] === '2').length, 3, 'Retain the original rescue-owned Shuttles');
    assert.equal(units.filter(unit => unit[1].includes('Uraj') && unit[2] === '6').length, 1, 'Retain the original Uraj crystal owner');
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwprotoss05') {
    assert.equal(mission.episode, 4); assert.equal(mission.order, 5); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 1);
    for (const [type, count] of [['Observer', 3], ['Shuttle', 2], ['Scout', 3], ['Zealot', 4], ['Dragoon', 2]]) assert.equal(human.filter(unit => unit[1] === type).length, count, 'Preserve the original baseless Protoss force');
    assert.equal(human.filter(unit => unit[1] === 'Nexus' || unit[1] === 'Probe').length, 0, 'Do not invent a Protoss base or workers');
    assert.equal(units.filter(unit => unit[1] === 'Artanis' && unit[2] === '1').length, 1, 'Keep the original naturally rescued Artanis');
    assert.equal(units.filter(unit => unit[1].includes('Power Generator') && unit[2] === '7').length, 5, 'Keep all five powered generators');
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwprotoss06') {
    assert.equal(mission.episode, 4); assert.equal(mission.order, 6); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 1);
    for (const [type, count] of [['Probe', 4], ['Dark Templar', 2], ['Zealot', 3], ['Dragoon', 3], ['Observer', 3], ['Nexus', 1], ['Pylon', 4], ['Gateway', 1], ['Drone', 0]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.filter(unit => unit[1] === 'Overmind' && unit[2] === '4').length, 1);
    assert.equal(units.filter(unit => unit[1].includes('Khalis') && unit[2] === '0').length, 1);
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwprotoss07') {
    assert.equal(mission.episode, 4); assert.equal(mission.order, 7); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 1);
    for (const [type, count] of [['Probe', 7], ['Dark Templar', 8], ['Dark Archon', 2], ['Dragoon', 4], ['Nexus', 1], ['Pylon', 7], ['Gateway', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.filter(unit => unit[1] === 'Tassadar' && unit[2] === '7').length, 3, 'Preserve all three original Tassadar-type Aldaris actors');
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwprotoss08') {
    assert.equal(mission.episode, 4); assert.equal(mission.order, 8); assert.equal(mission.race, 2); assert.equal(mission.humanSlot, 1);
    for (const [type, count] of [['Probe', 8], ['Nexus', 2], ['Zealot', 4], ['Dragoon', 6], ['Gateway', 2], ['Zeratul', 1], ['Artanis', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.filter(unit => unit[1].includes("Xel'Naga Temple") && unit[2] === '6').length, 1);
    assert.equal(x.openbw_mission_countdown(), -1, 'The original timer starts only after both heroes enter the temple');
  } else if (missionId === 'bwterran01') {
    assert.equal(mission.episode, 5); assert.equal(mission.order, 1); assert.equal(mission.race, 1); assert.equal(mission.humanSlot, 5);
    for (const [type, count] of [['SCV', 4], ['Marine', 3], ['Siege Tank', 2], ['Command Center', 1], ['Supply Depot', 2], ['Barracks', 1], ['Factory', 1], ['Machine Shop', 1]]) assert.equal(human.filter(unit => unit[1] === type).length, count);
    assert.equal(units.filter(unit => unit[1].includes('Duran') && unit[2] === '2').length, 1);
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwterran02') {
    assert.equal(mission.episode, 5); assert.equal(mission.order, 2); assert.equal(mission.race, 1); assert.equal(mission.humanSlot, 6);
    assert.deepEqual(human.map(unit => unit[1]), ['Map Revealer'], 'Only the original revealer precedes the source Dropship delivery');
    assert.equal(units.filter(unit => unit[1] === 'Dropship' && unit[2] === '2').length, 3);
    assert.equal(x.openbw_mission_countdown(), -1);
  } else if (missionId === 'bwterran03') {
    assert.equal(mission.episode, 5); assert.equal(mission.order, 3); assert.equal(mission.race, 1); assert.equal(mission.humanSlot, 6);
    assert.deepEqual(human.map(unit => unit[1]), ['Map Revealer']);
    for (const owner of ['0', '3', '4', '5']) assert.equal(units.filter(unit => unit[1] === 'Hive' && unit[2] === owner).length, 1);
    assert.equal(units.filter(unit => unit[1] === 'Command Center' && unit[2] === '1').length, 1);
    assert.equal(units.filter(unit => unit[1].includes('Duran')).length, 0, 'Duran comes from the original Dropship arrival');
    assert.equal(x.openbw_mission_countdown(), -1);
  } else {
    assert.equal(units.length, 36, 'Expected 36 non-neutral actors, without melee starts');
    assert.equal(human.length, 12);
    assert.equal(human.filter(unit => unit[1] === 'Marine').length, 5);
    assert.equal(human.filter(unit => unit[1] === 'SCV').length, 5);
    assert.equal(units.filter(unit => Number(unit[2]) === 2).length, 1, 'Raynor must begin with rescue ownership');
    assert.equal(units.filter(unit => Number(unit[2]) === 4).length, 23, 'Preserve the placed Zerglings');
  }
  assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 0, 'No injected melee minerals');
  console.log('Campaign initialization checks passed.');
  const capabilities = new Set(read(x.openbw_campaign_capabilities()).trim().split('\n'));
  for (const required of mission.requirements) assert.ok(capabilities.has(required), `Missing runtime capability ${required}`);
  const briefing = read(x.openbw_mission_briefing()).trim().split('\n').map(line => line.split('\t').map(Number));
  assert.deepEqual([...new Set(briefing.map(action => action[0]))].sort((left, right) => left - right), ['zerg05', 'protoss06'].includes(missionId) ? [3, 4, 5, 6, 8] : ['terran02', 'protoss08', 'bwprotoss05'].includes(missionId) ? [1, 2, 3, 4, 5, 6, 8] : ['terran06', 'terran07', 'terran08', 'terran10'].includes(missionId) ? [1, 3, 4, 5, 6, 7, 8] : [1, 3, 4, 5, 6, 8]);
  const transmissionTime = (base, adjustment, modifier) => modifier === 7 ? adjustment : modifier === 8 ? base + adjustment : Math.max(0, base - adjustment);
  for (const action of briefing.filter(action => action[0] === 8)) assert.equal(x.openbw_mission_transmission_time(action[3], action[5], action[6]), transmissionTime(action[3], action[5], action[6]), 'Original briefing uses its stored duration and modifier');
  const beforeBriefing = x.openbw_frame();
  x.openbw_step();
  assert.equal(x.openbw_frame(), beforeBriefing, 'Briefing cannot advance the world');
  x.openbw_mission_begin();
  for (let frame = 0; frame < 4; frame++) x.openbw_step();
  assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), {terran01: 40, terran02: 200, terran03: 100, terran04: 0, terran05: 300, terran06: 75, terran07: 170, terran08: 250, terran09: 250, terran10: 500, zerg01: 200, zerg02: 300, zerg03: 150, zerg04: 250, zerg05: 0, zerg06: 250, zerg07: 800, zerg08: 350, zerg09: 750, zerg10: 1000, protoss01: 400, protoss02: 170, protoss03: 300, protoss04: 0, protoss05: 150, protoss06: 0, protoss07: 2500, protoss08: 70, protoss09: 1000, protoss10: 100, bwprotoss01: 0, bwprotoss02: 600, bwprotoss03: 250, bwprotoss04: 200, bwprotoss05: 0, bwprotoss06: 800, bwprotoss07: 200, bwprotoss08: 1000, bwterran01: 250, bwterran02: 0, bwterran03: 500}[missionId], 'Preserve original mission minerals');
  if (missionId === 'bwterran03') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 100, 'Tarsonis grants its original hundred gas');
  if (missionId === 'bwterran01') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 0, 'UED First Strike starts without gas');
  if (missionId === 'bwprotoss08') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 1000, 'Countdown grants the original thousand gas');
  if (missionId === 'bwprotoss06') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 400, 'Return to Char grants the original four hundred gas');
  if (missionId === 'bwprotoss07') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 150, 'The Insurgent grants the original one hundred fifty gas');
  if (missionId === 'bwprotoss03') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 75, 'The original expansion base grants exactly seventy-five gas');
  if (missionId === 'protoss10') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 100, 'Original Eye of the Storm grants only 100 gas');
  if (missionId === 'protoss09') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 1000, 'Original Shadow Hunters grants 1000 gas');
  if (missionId === 'protoss08') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 0, 'Original Trial of Tassadar starts without gas');
  if (missionId === 'protoss07') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 2500, 'Original Homeland grants 2500 gas');
  if (missionId === 'protoss06') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 0, 'Original Into the Darkness has no injected gas');
  if (missionId === 'protoss05') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 0, 'Original Choosing Sides starts without gas');
  if (missionId === 'protoss04') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 0, 'Original mission-4 gas remains zero before rescue');
  if (missionId === 'protoss03') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 100, 'Original Higher Ground trigger grants 100 gas');
  if (missionId === 'protoss02') {
    assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 0, 'Original Into the Flames starts without gas');
    assert.equal(x.openbw_mission_countdown(), 900, 'Preserve the original fifteen-minute arrival countdown');
  }
  if (missionId === 'protoss01') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 100, 'Original First Strike trigger grants 100 gas');
  if (missionId === 'zerg10') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 1000, 'Original Full Circle trigger grants 1000 gas');
  if (missionId === 'zerg09') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 750, 'Original Invasion of Aiur trigger grants 750 gas');
  if (missionId === 'zerg08') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 350, 'Original Eye for an Eye trigger grants 350 gas');
  if (missionId === 'zerg07') {
    assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 200, 'Original Culling trigger grants 200 gas');
    const army = human.filter(unit => ['Hydralisk', 'Mutalisk'].includes(unit[1]));
    army.forEach((unit, index) => x.openbw_debug_select(Number(unit[0]), index ? 1 : 0));
    x.openbw_render(0); x.openbw_out_clear(); x.openbw_key(1, 104, 0); x.openbw_key(0, 104, 0); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Holding the original army uses normal synchronized input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
  }
  if (missionId === 'zerg06') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 250, 'Original Dark Templar trigger grants 250 gas');
  if (missionId === 'zerg04') {
    assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 250, 'Original Agent of the Swarm trigger grants 250 gas');
    assert.equal(x.openbw_mission_countdown(), 600, 'Original ten-minute hatch countdown');
  }
  if (missionId === 'zerg03') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 50, 'Original New Dominion trigger grants fifty gas');
  if (missionId === 'terran08') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 100, 'Original Big Push trigger grants 100 gas');
  if (missionId === 'terran09') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 150, 'Original New Gettysburg trigger grants 150 gas');
  if (missionId === 'terran10') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 150, 'Original Hammer Falls trigger grants 150 gas');
  if (missionId === 'terran03') assert.equal(x.openbw_mission_countdown(), 1800, 'Original thirty-minute countdown');
  if (missionId === 'terran02') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 200, 'Original Backwater trigger grants gas');
  if (missionId === 'terran05') assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 300, 'Original Revolution trigger grants gas');
  const events = [];
  const consume = () => {
    const text = read(x.openbw_mission_events()).trim();
    if (!text) return;
    const batch = text.split('\n').map(line => line.split('\t').map(Number));
    for (const event of batch) {
      assert.equal(event[0], 1, 'Fresh-session event generation');
      assert.equal(event[2], mission.humanSlot);
      assert.equal(event[1], events.length + 1, 'Ordered, nonduplicated mission events');
      events.push(event);
    }
    x.openbw_mission_ack(batch.at(-1)[1]);
    assert.equal(read(x.openbw_mission_events()), '', 'Acknowledged events must not replay');
  };
  consume();
  for (let tick = 0; tick < 1200; tick++) {
    x.openbw_step();
    if (tick % 16 === 0) {
      x.openbw_render(tick * 42);
      consume();
      x.openbw_render(tick * 42 + 1);
      assert.equal(read(x.openbw_mission_events()), '', 'Extra rendering cannot create dialogue');
    }
  }
  if (missionId === 'bwterran03') {
    const ready = () => read(x.openbw_mission_leaderboard()).length > 0 && read(x.openbw_debug_units()).split('\n').some(line => { const unit = line.split('\t'); return unit[1].includes('Duran') && Number(unit[2]) === mission.humanSlot; });
    for (let tick = 0; tick < 1800 && !ready(); tick++) { x.openbw_step(); if (tick % 16 === 0) { x.openbw_render(tick * 42); consume(); } }
    assert.ok(ready(), 'The original timed explanation and natural Duran rescue complete before recording production');
  }
  consume();
  if (missionId === 'terran03') {
    assert.ok(events.some(event => event[3] === 28), 'Original minimap pings are ordered presentation events');
    assert.ok(x.openbw_mission_countdown() < 1800 && x.openbw_mission_countdown() > 1700, 'Countdown follows native world ticks');
  }
  assert.ok(events.some(event => event[3] === 12), 'Original objectives must be emitted');
  assert.ok(read(x.openbw_mission_objectives()).length > 0, 'Objectives persist after event acknowledgement');
  const dialogue = events.filter(event => event[3] === 7);
  const noOpeningDialogue = ['terran04', 'terran05', 'terran06', 'terran08', 'zerg02', 'zerg03', 'zerg07', 'zerg08', 'zerg09', 'zerg10', 'protoss01', 'protoss02', 'protoss03', 'protoss04', 'protoss05', 'protoss06', 'protoss08', 'protoss09', 'bwprotoss01', 'bwprotoss02', 'bwprotoss05'].includes(missionId);
  if (noOpeningDialogue) assert.equal(dialogue.length, 0, 'Original mission supplies no idle-start transmission; none is invented');
  else assert.ok(dialogue.length > 0, 'Original elapsed-time trigger must emit a transmission');
  for (const event of dialogue) {
    assert.equal(x.openbw_mission_transmission_time(event[7], event[10], event[8]), transmissionTime(event[7], event[10], event[8]), 'Original gameplay transmission uses its stored duration and modifier');
  }
  const soundIndices = noOpeningDialogue ? briefing.filter(action => action[0] === 8).map(action => action[2]) : dialogue.map(event => event[6]);
  assert.ok(soundIndices.length > 0, 'Original mission supplies narration audio');
  for (const soundIndex of soundIndices) {
    const path = read(x.openbw_mission_string(soundIndex)).replaceAll('\\', '/').toLowerCase();
    const expected = mission.files.find(file => file.path === path);
    assert.ok(expected?.audio, 'Transmission audio must be in the validated pack');
    assert.equal(x.openbw_mission_sound_duration(soundIndex), expected.audio.durationMs);
    x.openbw_mission_play_sound(soundIndex, 63);
    assert.equal(missionSoundLoads.at(-1).size, expected.bytes, 'Actual mission WAV must reach native_sound::load_wav');
    const loads = missionSoundLoads.length;
    x.openbw_mission_play_sound(soundIndex, 63);
    assert.equal(missionSoundLoads.length, loads, 'Mission sound handles are reused');
  }
  assert.equal(x.openbw_outcome(), 0, 'Idle original state must not invent a mission outcome');
  if (missionId === 'bwterran02') {
    const current = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t'));
    for (const [type, count] of [['Marine', 8], ['Medic', 4], ['Civilian', 3]]) assert.equal(current.filter(unit => unit[1] === type && Number(unit[2]) === mission.humanSlot).length, count, 'The source Dropships deliver the original baseless landing force');
    assert.equal(current.filter(unit => unit[1] === 'Battlecruiser' && unit[2] === '1').length, 18);
    const [header, ...scores] = read(x.openbw_mission_leaderboard()).trim().split('\n').map(line => line.split('\t').map(Number));
    assert.ok(header[0] > 0, 'The original custom-score leaderboard retains its authored title');
    assert.equal(header[1], -1, 'The opening scoreboard displays custom score rather than a unit count');
    assert.deepEqual(scores, [[mission.humanSlot, 0]], 'The original leaderboard excludes computers and displays the human capture score');
  }
  if (missionId === 'bwterran01' || missionId === 'bwterran03') {
    const barracks = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[1] === 'Barracks' && Number(unit[2]) === mission.humanSlot);
    assert.ok(barracks);
    x.openbw_debug_select(Number(barracks[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    const marine = read(x.openbw_card()).trim().split('\n').map(line => line.split('\t')).find(row => row[1] === 'Marine');
    assert.ok(marine?.[0]);
    x.openbw_key(1, marine[0].charCodeAt(0), 0); x.openbw_key(0, marine[0].charCodeAt(0), 0); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'The original UED Barracks accepts normal synchronized production input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 24; tick++) x.openbw_step();
    assert.deepEqual(read(x.openbw_resources()).split('\t').slice(0, 2).map(Number), missionId === 'bwterran03' ? [450, 100] : [200, 0], 'A native Marine costs fifty of the original minerals');
    const [progress, queued] = read(x.openbw_status()).split('\t');
    assert.equal(queued, 'Marine');
    assert.ok(Number(progress) > 0 && Number(progress) < 100, 'Recovery captures the paid Marine still in production');
    if (missionId === 'bwterran03') {
      const [header, ...scores] = read(x.openbw_mission_leaderboard()).trim().split('\n').map(line => line.split('\t').map(Number));
      assert.deepEqual(header.slice(1), [133, 4], 'The original leaderboard displays four Hive kills as its goal');
      assert.deepEqual(scores, [[mission.humanSlot, 4]], 'The goal leaderboard reports remaining Hives, not completed kills');
    }
  }
  if (['bwprotoss03', 'bwprotoss06', 'bwprotoss07', 'bwprotoss08'].includes(missionId)) {
    const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
    const gateway = owned().find(unit => unit[1] === 'Gateway');
    assert.ok(gateway);
    x.openbw_debug_select(Number(gateway[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    const card = read(x.openbw_card()).trim().split('\n').map(line => line.split('\t'));
    assert.ok(card.some(row => row[1] === (missionId === 'bwprotoss08' ? 'Zealot' : 'Dark Templar')), 'The original expansion Gateway exposes source-allowed production');
    const trainingName = missionId === 'bwprotoss07' ? 'Dark Templar' : 'Zealot';
    const training = card.find(row => row[1] === trainingName);
    assert.ok(training?.[0]);
    x.openbw_key(1, training[0].charCodeAt(0), 0); x.openbw_key(0, training[0].charCodeAt(0), 0); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Expansion base production uses normal synchronized input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 24; tick++) x.openbw_step();
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), {bwprotoss03: 150, bwprotoss06: 700, bwprotoss07: 75, bwprotoss08: 900}[missionId], 'Native Gateway production pays the original unit cost');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), {bwprotoss03: 75, bwprotoss06: 400, bwprotoss07: 50, bwprotoss08: 1000}[missionId]);
    const [progress, queued] = read(x.openbw_status()).split('\t');
    assert.equal(queued, trainingName, 'The saved production order remains in the original Gateway queue');
    assert.ok(Number(progress) > 0 && Number(progress) < 100, 'Recovery captures paid production still in flight');
    assert.equal(owned().filter(unit => unit[1] === 'Dark Templar').length, missionId === 'bwprotoss07' ? 9 : missionId === 'bwprotoss08' ? 0 : 2, 'The original Dark Templars remain alongside any unfinished trainee');
    if (missionId === 'bwprotoss06') for (const [type, count] of [['Hatchery', 1], ['Drone', 3], ['Zergling', 6], ['Overlord', 2]]) assert.equal(owned().filter(unit => unit[1] === type).length, count, 'The original opening transfers the Zerg base to the Protoss human owner');
    assert.equal(x.openbw_outcome(), 0);
  }
  if (missionId === 'bwprotoss02') {
    const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
    const worker = owned().find(unit => unit[1] === 'Probe');
    assert.ok(worker);
    const current = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    const cameraX = Math.max(0, Math.min(Number(worker[3]) - 640, x.openbw_map_w() * 32 - 1280)), cameraY = Math.max(0, Math.min(Number(worker[4]) - 400, x.openbw_map_h() * 32 - 800));
    x.openbw_pan(cameraX - Number(current[1]), cameraY - Number(current[2]));
    x.openbw_debug_select(Number(worker[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    let site = null;
    for (let offsetY = -192; offsetY <= 192 && !site; offsetY += 32) for (let offsetX = -320; offsetX <= 320 && !site; offsetX += 32) {
      const mapX = Math.floor(Number(worker[3]) / 32) * 32 + offsetX, mapY = Math.floor(Number(worker[4]) / 32) * 32 + offsetY;
      if (mapX < cameraX + 160 || mapX > cameraX + 1120 || mapY < cameraY + 64 || mapY > cameraY + 640) continue;
      if ((x.openbw_debug_build_check(154, mapX, mapY) & 3) === 3) site = [mapX - cameraX, mapY - cameraY];
    }
    assert.ok(site, 'Native placement supplies a legal Nexus site near the original starting force');
    for (const key of ['b', 'n']) { x.openbw_key(1, key.charCodeAt(0), 0); x.openbw_key(0, key.charCodeAt(0), 0); x.openbw_render(0); }
    x.openbw_mouse_button(1, 1, ...site, 1); x.openbw_mouse_button(0, 1, ...site, 1); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Nexus construction uses normal synchronized input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 600 && !owned().some(unit => unit[1] === 'Nexus'); tick++) x.openbw_step();
    const nexus = owned().find(unit => unit[1] === 'Nexus');
    assert.ok(nexus, 'An original Probe starts the native Nexus warp');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 200, 'The Nexus pays four hundred of the original six hundred minerals');
    assert.equal(owned().filter(unit => unit[1] === 'Probe').length, 4);
    x.openbw_debug_select(Number(nexus[0]), 0); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /\tCancel\t/, 'Recovery is captured during actual paid Nexus construction');
    assert.equal(x.openbw_outcome(), 0);
  }
  if (['bwprotoss01', 'bwprotoss04', 'bwprotoss05', 'bwterran02'].includes(missionId)) {
    const unitName = missionId === 'bwprotoss01' ? 'Zeratul' : missionId === 'bwprotoss05' ? 'Zealot' : missionId === 'bwterran02' ? 'Civilian' : 'Probe';
    const actor = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[1] === unitName && Number(unit[2]) === mission.humanSlot);
    assert.ok(actor);
    const word = value => [value & 255, value >> 8 & 255];
    const target = [Number(actor[3]) + 160, Number(actor[4]) + 64];
    const selection = [9, 1, ...word(Number(actor[0]))], movement = [21, ...word(target[0]), ...word(target[1]), 0, 0, 228, 0, 6, 0];
    const bytes = Uint8Array.from([...word(selection.length), ...selection, ...word(movement.length), ...movement]);
    new Uint8Array(memory.buffer, x.openbw_in_ptr(bytes.length), bytes.length).set(bytes);
    x.openbw_apply(mission.humanSlot, bytes.length);
    for (let tick = 0; tick < 24; tick++) x.openbw_step();
    const moved = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[0] === actor[0]);
    assert.ok(moved && Math.hypot(Number(moved[3]) - Number(actor[3]), Number(moved[4]) - Number(actor[4])) > 16, `Normal recorded movement retains and moves the original ${unitName}`);
    assert.equal(x.openbw_outcome(), 0);
  }
  if (missionId === 'terran06' && !recoveryTest) {
    const currentUnits = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t'));
    const word = value => [value & 255, value >> 8 & 255];
    const send = (unit, order, mapX, mapY) => {
      const selection = [9, 1, ...word(Number(unit[0]))];
      const command = [21, ...word(mapX), ...word(mapY), 0, 0, 228, 0, order, 0];
      const bytes = Uint8Array.from([...word(selection.length), ...selection, ...word(command.length), ...command]);
      const pointer = x.openbw_in_ptr(bytes.length);
      new Uint8Array(memory.buffer).set(bytes, pointer);
      x.openbw_apply(mission.humanSlot, bytes.length);
    };
    const raynor = currentUnits().find(unit => unit[1] === 'Jim Raynor' && unit[2] === '0');
    const base = currentUnits().find(unit => unit[1] === 'Command Center' && unit[2] === '6');
    assert.ok(raynor && base, 'Original hero and neutral base for mobile Norad repair');
    send(raynor, 14, Number(base[3]), Number(base[4]));
    for (let tick = 0; tick < 2000 && !currentUnits().some(unit => unit[1] === 'Command Center' && unit[2] === '0'); tick++) x.openbw_step();
    assert.ok(currentUnits().some(unit => unit[1] === 'Command Center' && unit[2] === '0'), 'Normal hero movement rescues the original base');
    for (let tick = 0; tick < 2000 && !currentUnits().some(unit => unit[1].includes('Norad') && unit[2] === '0'); tick++) x.openbw_step();
    const flagship = currentUnits().find(unit => unit[1].includes('Norad') && unit[2] === '0');
    assert.ok(flagship, 'Original crash-site actors naturally rescue Norad II');
    const worker = currentUnits().filter(unit => unit[1] === 'SCV' && unit[2] === '0').sort((first, second) => Math.hypot(+first[3] - +flagship[3], +first[4] - +flagship[4]) - Math.hypot(+second[3] - +flagship[3], +second[4] - +flagship[4]))[0];
    assert.ok(worker, 'Original crash-site SCV');
    x.openbw_set_touch_controls(1);
    x.openbw_debug_select(Number(worker[0]), 0);
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    const cameraX = Math.max(0, Math.min(Number(flagship[3]) - 640, x.openbw_map_w() * 32 - 1280));
    const cameraY = Math.max(0, Math.min(Number(flagship[4]) - 400, x.openbw_map_h() * 32 - 800));
    x.openbw_pan(cameraX - Number(camera[1]), cameraY - Number(camera[2]));
    x.openbw_debug_set_life(Number(flagship[0]), 150, -1);
    x.openbw_render(0);
    const screenX = Number(flagship[3]) - cameraX;
    const screenY = Number(flagship[4]) - cameraY;
    const repair = button => {
      x.openbw_out_clear();
      x.openbw_mouse_move(screenX, screenY);
      x.openbw_mouse_button(1, button, screenX, screenY, 1);
      x.openbw_mouse_button(0, button, screenX, screenY, 1);
      x.openbw_render(0);
      const bytes = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      let repairOrder;
      for (let offset = 0; offset < bytes.length;) {
        const length = bytes[offset] | bytes[offset + 1] << 8;
        offset += 2;
        if (bytes[offset] === 21) repairOrder = bytes.slice(offset, offset + length);
        offset += length;
      }
      assert.equal(repairOrder?.[9], 34, 'Mobile Norad targeting must emit Repair, not Move or selection');
      assert.equal(repairOrder[5] | repairOrder[6] << 8, Number(flagship[0]), 'Repair targets the original crashed Norad II');
      const pointer = x.openbw_in_ptr(bytes.length);
      new Uint8Array(memory.buffer).set(bytes, pointer);
      x.openbw_apply(mission.humanSlot, bytes.length);
      x.openbw_out_clear();
    };
    assert.equal(x.openbw_touch_button(screenX, screenY), 3, 'Plain SCV tap prioritizes repairing the downed flagship');
    const flagshipLife = () => {
      x.openbw_debug_select(Number(flagship[0]), 0);
      const life = Number(read(x.openbw_wires()).split('\t')[2]);
      x.openbw_debug_select(Number(worker[0]), 0);
      x.openbw_render(0);
      return life;
    };
    assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 0, 'Original mission has no gas before harvesting');
    repair(x.openbw_touch_button(screenX, screenY));
    for (let tick = 0; tick < 240; tick++) x.openbw_step();
    assert.ok(flagshipLife() <= 150, 'An emitted Repair order cannot bypass the original gas cost');
    x.openbw_debug_resources(1000, 1000);
    for (const button of [x.openbw_touch_button(screenX, screenY), 3]) {
      x.openbw_debug_set_life(Number(flagship[0]), 150, -1);
      repair(button);
      for (let tick = 0; tick < 240; tick++) x.openbw_step();
      assert.ok(flagshipLife() > 150, 'Affordable tap and long-press Repair each increase the burning flagship HP');
    }
    console.log('Norad II mobile tap/long-press targeting and actual repair passed.');
  }
  if (missionId === 'terran05') {
    const raynor = human.find(unit => unit[1] === 'Jim Raynor');
    const kerrigan = units.find(unit => unit[1] === 'Sarah Kerrigan');
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    assert.ok(raynor && kerrigan && camera);
    const cameraX = Math.max(0, Number(kerrigan[3]) - 320);
    const cameraY = Math.max(0, Number(kerrigan[4]) - 240);
    x.openbw_debug_select(Number(raynor[0]), 0);
    x.openbw_pan(cameraX - Number(camera[1]), cameraY - Number(camera[2]));
    x.openbw_key(1, 109, 0);
    x.openbw_key(0, 109, 0);
    x.openbw_mouse_button(1, 1, Number(kerrigan[3]) - cameraX, Number(kerrigan[4]) - cameraY, 1);
    x.openbw_mouse_button(0, 1, Number(kerrigan[3]) - cameraX, Number(kerrigan[4]) - cameraY, 1);
    x.openbw_render(0);
    const commands = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    const input = x.openbw_in_ptr(commands.length);
    new Uint8Array(memory.buffer).set(commands, input);
    x.openbw_apply(mission.humanSlot, commands.length);
    x.openbw_out_clear();
    for (let tick = 0; tick < 2500; tick++) x.openbw_step();
    const rescued = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[1] === 'Sarah Kerrigan');
    assert.equal(Number(rescued[2]), mission.humanSlot, 'Normal movement and native proximity rescue Kerrigan');
    x.openbw_debug_select(Number(rescued[0]), 0);
    x.openbw_render(0);
    assert.match(read(x.openbw_card()), /Cloak/);
    assert.match(read(x.openbw_card()), /Lockdown/);
    for (const label of ['Decloak', 'Cloak']) {
      x.openbw_key(1, 99, 0);
      x.openbw_key(0, 99, 0);
      x.openbw_render(0);
      const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      const pointer = x.openbw_in_ptr(output.length);
      new Uint8Array(memory.buffer).set(output, pointer);
      x.openbw_apply(mission.humanSlot, output.length);
      x.openbw_out_clear();
      for (let tick = 0; tick < 200; tick++) x.openbw_step();
      x.openbw_render(0);
      assert.match(read(x.openbw_card()), new RegExp(`\\t${label}\\t`), 'Hero cloak card follows native cloak/decloak state');
    }
    console.log('Revolution normal hero rescue and cloak controls passed.');
  }
  if (missionId === 'zerg01') {
    const hatchery = human.find(unit => unit[1] === 'Hatchery');
    x.openbw_debug_select(Number(hatchery[0]), 0); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /\tSelect Larva\t/, 'Native Zerg Hatchery card selects Larva');
    const larva = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => Number(unit[2]) === mission.humanSlot && unit[1] === 'Larva');
    assert.ok(larva);
    const drone = human.find(unit => unit[1] === 'Drone');
    x.openbw_debug_select(Number(larva[0]), 0); x.openbw_debug_select(Number(drone[0]), 1); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /^Drone\t/, 'A mixed Larva/Drone group defaults to the Drone regardless of selection order');
    assert.equal(read(x.openbw_wires()).trim().split('\n').length, 2, 'Both unit types remain visually selected');
    x.openbw_key(1, 98, 0); x.openbw_key(0, 98, 0); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /^Build\t/, 'Active Drone exposes building choices while Larva stays selected');
    x.openbw_key(1, 115, 0); x.openbw_key(0, 115, 0); x.openbw_render(0);
    assert.equal(x.openbw_cursor(), 2, 'Active Drone can arm building placement in a mixed group');
    x.openbw_key(1, 0, 43); x.openbw_key(0, 0, 43); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /^Larva\t/, 'Tab cycles the command card to the other selected unit type');
    assert.notEqual(x.openbw_cursor(), 2, 'Cycling cancels the previous subgroup building preview');
    assert.equal(read(x.openbw_wires()).trim().split('\n').length, 2, 'Tab never shrinks the visual selection');
    x.openbw_key(1, 0, 225); x.openbw_key(1, 0, 43); x.openbw_key(0, 0, 43); x.openbw_key(0, 0, 225); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /^Drone\t/, 'Shift+Tab cycles back through selected unit types');
    x.openbw_key(1, 0, 43); x.openbw_key(0, 0, 43); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /\tDrone\t/, 'Larva exposes native Drone morph');
    x.openbw_out_clear(); x.openbw_key(1, 100, 0); x.openbw_key(0, 100, 0);
    x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Drone morph uses the normal synchronized command stream');
    assert.equal(output[2], 9); assert.equal(output[3], 1, 'Only the active Larva subgroup is synchronized for morphing');
    assert.equal(output[4] | output[5] << 8, Number(larva[0]));
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 600; tick++) x.openbw_step();
    const after = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t'));
    assert.equal(after.filter(unit => Number(unit[2]) === mission.humanSlot && unit[1] === 'Drone').length, 3, 'A native Larva becomes the third Drone');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 150, 'Native Drone morph pays fifty minerals');
    console.log('Among the Ruins native Hatchery/Larva controls and paid Drone morph passed.');
    if (!recoveryTest) {
      const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
      const selectedIds = () => read(x.openbw_wires()).trim().split('\n').filter(Boolean).map(line => Number(line.split('\t')[0]));
      const press = symbol => { x.openbw_key(1, symbol.charCodeAt(0), 0); x.openbw_key(0, symbol.charCodeAt(0), 0); x.openbw_render(0); };
      const applyQueued = () => {
        const bytes = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
        assert.ok(bytes.length > 0);
        new Uint8Array(memory.buffer, x.openbw_in_ptr(bytes.length), bytes.length).set(bytes);
        x.openbw_apply(mission.humanSlot, bytes.length); x.openbw_out_clear();
      };
      x.openbw_debug_resources(2000, 1000);
      const worker = owned().find(unit => unit[1] === 'Drone');
      x.openbw_debug_select(Number(worker[0]), 0); x.openbw_render(0);
      const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
      let site = null;
      for (let vertical = -480; vertical <= 160 && !site; vertical += 32) for (let horizontal = -256; horizontal <= 576 && !site; horizontal += 32) {
        const mapX = Number(hatchery[3]) + horizontal, mapY = Number(hatchery[4]) + vertical;
        if (Math.hypot(horizontal, vertical) < 384 || mapX < Number(camera[1]) + 160 || mapX > Number(camera[1]) + 1120 || mapY < Number(camera[2]) + 64 || mapY > Number(camera[2]) + 600) continue;
        if ((x.openbw_debug_build_check(131, mapX, mapY) & 3) === 3) site = [mapX - Number(camera[1]), mapY - Number(camera[2])];
      }
      assert.ok(site, 'A second native Hatchery fits in the same viewport for parent-specific selection');
      press('b'); press('h');
      x.openbw_mouse_button(1, 1, ...site, 1); x.openbw_mouse_button(0, 1, ...site, 1); x.openbw_render(0);
      applyQueued();
      let secondBase = null, completed = false;
      for (let tick = 0; tick < 3000 && !completed; tick++) {
        x.openbw_step();
        if (tick % 16) continue;
        secondBase = owned().find(unit => unit[1] === 'Hatchery' && Number(unit[0]) !== Number(hatchery[0]));
        if (secondBase) { x.openbw_debug_select(Number(secondBase[0]), 0); x.openbw_render(0); const card = read(x.openbw_card()); completed = /\tSelect Larva\t/.test(card) && !/\tCancel\t/.test(card); }
      }
      assert.ok(completed, 'Second Hatchery completes through paid native Drone construction');
      for (let tick = 0; tick < 64; tick++) x.openbw_step();
      x.openbw_debug_select(Number(secondBase[0]), 0); x.openbw_render(0); press('s');
      assert.match(read(x.openbw_card()), /^Larva\t/);
      const allLarvae = owned().filter(unit => unit[1] === 'Larva'), selectedLarvae = allLarvae.filter(unit => selectedIds().includes(Number(unit[0])));
      assert.ok(selectedLarvae.length > 0 && selectedLarvae.length < allLarvae.length, 'S selects only the chosen Hatchery Larva, not other nearby Larva');
      assert.ok(selectedLarvae.every(unit => Math.hypot(Number(unit[3]) - Number(secondBase[3]), Number(unit[4]) - Number(secondBase[4])) < 192), 'Selected Larva belong to the requested Hatchery');
      press('o'); applyQueued();
      for (let tick = 0; tick < 8; tick++) x.openbw_step();
      x.openbw_debug_select(Number(secondBase[0]), 0); x.openbw_render(0);
      press('s'); press('s');
      assert.match(read(x.openbw_card()), /^Hatchery\t/, 'An empty Hatchery stays selected when S is pressed repeatedly');
      assert.deepEqual(selectedIds(), [Number(secondBase[0])], 'Empty Hatchery selection does not jump to another base Larva');
      let spawned = false;
      for (let tick = 0; tick < 600 && !spawned; tick++) { x.openbw_step(); press('s'); spawned = /^Larva\t/.test(read(x.openbw_card())); }
      assert.ok(spawned, 'Repeated S selects that Hatchery Larva when native spawning produces one');
      const focusedLarva = owned().find(unit => selectedIds().includes(Number(unit[0]))), overlord = owned().find(unit => unit[1] === 'Overlord');
      x.openbw_debug_select(Number(overlord[0]), 0); x.openbw_debug_select(Number(focusedLarva[0]), 1); x.openbw_render(0);
      assert.match(read(x.openbw_card()), /^Overlord\t/);
      x.openbw_key(1, 0, 43); x.openbw_key(0, 0, 43); x.openbw_render(0);
      assert.match(read(x.openbw_card()), /^Larva\t/); press('d'); applyQueued();
      for (let tick = 0; tick < 600; tick++) x.openbw_step();
      x.openbw_render(0);
      assert.match(read(x.openbw_card()), /^Drone\t/, 'A manually chosen subgroup follows its unit through morphing beside a higher-priority unit');
      console.log('Parent-specific Hatchery Larva selection, empty retention and repeated-S spawning checks passed.');
    }
  }
  if (missionId === 'zerg02') {
    const worker = human.find(unit => unit[1] === 'Drone'), chrysalis = human.find(unit => unit[1].includes('Beacon'));
    assert.ok(worker && chrysalis, 'Original Drone and standing Chrysalis marker exist');
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    x.openbw_pan(-Number(camera[1]), -Number(camera[2]));
    x.openbw_debug_select(Number(worker[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    x.openbw_mouse_button(1, 3, Number(chrysalis[3]), Number(chrysalis[4]), 1);
    x.openbw_mouse_button(0, 3, Number(chrysalis[3]), Number(chrysalis[4]), 1); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.equal(output[2], 9); assert.equal(output[3], 1, 'Normal Chrysalis right-click uses the synchronized worker command stream');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    let carried = false;
    for (let tick = 0; tick < 1000 && !carried; tick++) {
      x.openbw_step();
      if (tick % 16) continue;
      consume();
      const current = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[1] === 'Young Chrysalis' && unit[2] === String(mission.humanSlot));
      carried = !!current;
    }
    assert.ok(carried, 'Native Drone movement collects the original neutral Chrysalis and transfers its ownership');
    for (let tick = 0; tick < 64; tick++) x.openbw_step();
    consume();
    const rescueDialogue = events.find(event => event[3] === 7);
    assert.ok(rescueDialogue, 'Original Hunter Killer rescue emits its authored transmission');
    assert.match(read(x.openbw_mission_string(rescueDialogue[5])), /DAGGOTH/, 'Original rescue dialogue text is preserved');
    assert.equal(x.openbw_mission_countdown(), -1, 'Normal carried Chrysalis does not invent a recovery countdown');
    assert.equal(read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => unit[1] === 'Hunter Killer' && unit[2] === String(mission.humanSlot)).length, 6, 'The same normal move rescues the original Hunter Killers');
    console.log('Egression normal right-click Chrysalis pickup and original Hunter Killer rescue passed.');
  }
  if (missionId === 'zerg07') {
    const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
    const press = symbol => { x.openbw_key(1, symbol.charCodeAt(0), 0); x.openbw_key(0, symbol.charCodeAt(0), 0); x.openbw_render(0); };
    const applyQueued = () => {
      const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      assert.ok(output.length > 0, 'Original Culling base construction/morph uses synchronized input');
      new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
      x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    };
    const worker = owned().find(unit => unit[1] === 'Drone');
    assert.ok(worker);
    x.openbw_debug_select(Number(worker[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    let site = null;
    for (let vertical = -224; vertical <= 64 && !site; vertical += 32) for (let horizontal = -256; horizontal <= 256 && !site; horizontal += 32) {
      const mapX = Math.floor(Number(worker[3]) / 32) * 32 + horizontal, mapY = Math.floor(Number(worker[4]) / 32) * 32 + 16 + vertical;
      if (mapX < Number(camera[1]) + 160 || mapX > Number(camera[1]) + 1120 || mapY < Number(camera[2]) + 64 || mapY > Number(camera[2]) + 650) continue;
      if ((x.openbw_debug_build_check(131, mapX, mapY) & 3) === 3) site = [mapX - Number(camera[1]), mapY - Number(camera[2])];
    }
    assert.ok(site, 'A legal Hatchery site is reachable from the original baseless start');
    press('b'); press('h');
    x.openbw_mouse_button(1, 1, ...site, 1); x.openbw_mouse_button(0, 1, ...site, 1); x.openbw_render(0); applyQueued();
    let hatchery = null, completed = false;
    for (let tick = 0; tick < 3600 && !completed; tick++) {
      x.openbw_step();
      if (tick % 16) continue;
      hatchery = owned().find(unit => unit[1] === 'Hatchery');
      if (hatchery) { x.openbw_debug_select(Number(hatchery[0]), 0); x.openbw_render(0); completed = /\tSelect Larva\t/.test(read(x.openbw_card())) && !/\tCancel\t/.test(read(x.openbw_card())); }
    }
    assert.ok(completed, 'The original Drone completes a Hatchery through normal native construction');
    assert.equal(owned().filter(unit => unit[1] === 'Drone').length, 3, 'Building consumes the original Drone rather than granting an extra structure');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 500, 'Original 800 minerals pay the normal 300-mineral Hatchery cost');
    for (let tick = 0; tick < 64; tick++) x.openbw_step();
    x.openbw_debug_select(Number(hatchery[0]), 0); x.openbw_render(0); press('s');
    assert.match(read(x.openbw_card()), /^Larva\t/, 'The newly built Hatchery supplies native Larva');
    press('d'); applyQueued();
    for (let tick = 0; tick < 600; tick++) x.openbw_step();
    assert.equal(owned().filter(unit => unit[1] === 'Drone').length, 4, 'Native Larva production replaces the consumed Drone');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 450, 'Native Drone production pays fifty additional minerals without test funding');
    console.log('The Culling original paid Hatchery construction, native Larva/Drone production and no-invented-dialogue checks passed.');
  }
  if (missionId === 'protoss01') {
    const currentUnits = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t'));
    const owned = () => currentUnits().filter(unit => unit[2] === '7');
    const applyQueued = () => {
      const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      assert.ok(output.length > 0, 'First Strike uses normal synchronized player commands');
      new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
      x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    };
    const fenix = units.find(unit => unit[1].includes('Fenix') && unit[2] === '2');
    const originalNexus = units.find(unit => unit[1] === 'Nexus' && unit[2] === '1');
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    const cameraX = Math.max(0, Number(fenix[3]) - 640), cameraY = Math.max(0, Number(fenix[4]) - 400);
    x.openbw_pan(cameraX - Number(camera[1]), cameraY - Number(camera[2]));
    human.forEach((unit, index) => x.openbw_debug_select(Number(unit[0]), index ? 1 : 0)); x.openbw_render(0); x.openbw_out_clear();
    x.openbw_key(1, 97, 0); x.openbw_key(0, 97, 0); x.openbw_render(0);
    x.openbw_mouse_button(1, 1, Number(fenix[3]) - cameraX, Number(fenix[4]) - cameraY, 1);
    x.openbw_mouse_button(0, 1, Number(fenix[3]) - cameraX, Number(fenix[4]) - cameraY, 1); x.openbw_render(0); applyQueued();
    for (let tick = 0; tick < 4000 && !owned().some(unit => unit[0] === originalNexus[0]); tick++) x.openbw_step();
    assert.ok(owned().some(unit => unit[0] === originalNexus[0]), `Normal army Attack-move and source Observer rescue the original Antioch Nexus: frame ${x.openbw_frame()}, outcome ${x.openbw_outcome()}, Fenix ${currentUnits().filter(unit => unit[1].includes('Fenix')).map(unit => unit.slice(0, 5).join(':')).join(',')}`);
    assert.ok(owned().some(unit => unit[0] === fenix[0]), 'The same original Fenix is naturally rescued');
    for (let tick = 0; tick < 600; tick++) x.openbw_step();
    consume();
    assert.ok(events.some(event => event[3] === 7), 'Actual Fenix contact emits the original meeting transmission');
    assert.equal(owned().filter(unit => unit[1] === 'Probe').length, 0, 'Rescue must not grant an invented worker');
    console.log('First Strike normal Fenix/Antioch rescue and original meeting dialogue passed.');
  }
  if (['protoss01', 'protoss02', 'protoss03', 'protoss05', 'protoss07'].includes(missionId)) {
    const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
    const nexus = owned().find(unit => unit[1] === 'Nexus');
    const initialProbes = owned().filter(unit => unit[1] === 'Probe').length;
    const initialMinerals = Number(read(x.openbw_resources()).split('\t')[0]);
    assert.ok(nexus, 'Original owned Nexus permits normal player production');
    x.openbw_debug_select(Number(nexus[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    const probeCommand = read(x.openbw_card()).split('\n').map(line => line.split('\t')).find(row => row[1] === 'Probe');
    assert.ok(probeCommand?.[0], 'Original mission permits native Probe production');
    x.openbw_key(1, probeCommand[0].charCodeAt(0), 0); x.openbw_key(0, probeCommand[0].charCodeAt(0), 0); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Probe production uses normal synchronized player input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 600; tick++) x.openbw_step();
    assert.equal(owned().filter(unit => unit[1] === 'Probe').length, initialProbes + 1, 'Original player resources produce one actual Probe');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), initialMinerals - 50, 'Native Probe production charges fifty minerals without test funding');
    console.log(`${mission.title} paid native Probe production passed.`);
  }
  if (missionId === 'protoss05') {
    const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
    const shuttle = owned().find(unit => unit[1] === 'Shuttle'), passenger = owned().find(unit => unit[1] === 'Zealot');
    assert.ok(shuttle && passenger && owned().some(unit => unit[1] === 'Tassadar'), 'Original Shuttle, escort and naturally rescued Tassadar remain present');
    const applyQueued = () => {
      const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      assert.ok(output.length > 0, 'Transport controls use normal synchronized input');
      new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
      x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    };
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    x.openbw_debug_select(Number(passenger[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    const targetX = Number(shuttle[3]) - Number(camera[1]), targetY = Number(shuttle[4]) - Number(camera[2]);
    x.openbw_mouse_button(1, 3, targetX, targetY, 1); x.openbw_mouse_button(0, 3, targetX, targetY, 1); x.openbw_render(0); applyQueued();
    x.openbw_debug_select(Number(shuttle[0]), 0);
    for (let tick = 0; tick < 600; tick++) {
      x.openbw_step(); x.openbw_render(0);
      if (/\tUnload\t/.test(read(x.openbw_card()))) break;
    }
    const unload = read(x.openbw_card()).trim().split('\n').map(line => line.split('\t')).find(row => row[1] === 'Unload');
    assert.ok(unload?.[0], 'Normal escort right-click boards the original Shuttle and exposes native Unload');
    x.openbw_out_clear(); x.openbw_key(1, unload[0].charCodeAt(0), 0); x.openbw_key(0, unload[0].charCodeAt(0), 0); x.openbw_render(0); applyQueued();
    for (let tick = 0; tick < 400; tick++) {
      x.openbw_step(); x.openbw_render(0);
      if (!/\tUnload\t/.test(read(x.openbw_card()))) break;
    }
    assert.doesNotMatch(read(x.openbw_card()), /\tUnload\t/, 'Native Unload returns the carried escort to ground play');
    assert.ok(owned().some(unit => unit[0] === passenger[0]), 'The same original Zealot survives boarding and unloading');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 100, 'Transport commands do not invent resources after the paid Probe');
    assert.equal(x.openbw_outcome(), 0, 'Local boarding and unloading cannot satisfy the distant original entrance objective');
    console.log('Choosing Sides normal Shuttle boarding/unloading and native actor identity passed.');
  }
  if (missionId === 'protoss10') {
    const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
    for (const [type, count] of [['SCV', 4], ['Marine', 12], ['Firebat', 2], ['Command Center', 1], ['Supply Depot', 3], ['Barracks', 1], ['Bunker', 2], ['Engineering Bay', 1], ['Missile Turret', 1]]) assert.equal(owned().filter(unit => unit[1] === type).length, count, `Original source creates ${type} under the same human owner`);
    const barracks = owned().find(unit => unit[1] === 'Barracks'), gantrithor = owned().find(unit => unit[1].includes('Gantrithor'));
    assert.ok(barracks && gantrithor && owned().some(unit => unit[1].includes('Hyperion')) && owned().some(unit => unit[1] === 'Zeratul'), 'Original setup and native rescue retain all three heroes and both bases');
    const produce = (unit, label) => {
      x.openbw_debug_select(Number(unit[0]), 0); x.openbw_render(0); x.openbw_out_clear();
      const command = read(x.openbw_card()).trim().split('\n').map(line => line.split('\t')).find(row => row[1] === label);
      assert.ok(command?.[0], `Original producer exposes ${label}`);
      x.openbw_key(1, command[0].charCodeAt(0), 0); x.openbw_key(0, command[0].charCodeAt(0), 0); x.openbw_render(0);
      const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      assert.ok(output.length > 0, 'Dual-race production uses normal synchronized input');
      new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
      x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    };
    produce(barracks, 'Marine');
    for (let tick = 0; tick < 600; tick++) x.openbw_step();
    assert.equal(owned().filter(unit => unit[1] === 'Marine').length, 13, 'A source-created Terran Barracks completes one native Marine for the Protoss human');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 50, 'Normal Marine production pays fifty original minerals');
    produce(gantrithor, 'Build Interceptor');
    for (let tick = 0; tick < 600; tick++) x.openbw_step();
    assert.equal(owned().filter(unit => unit[1].includes('Interceptor')).length, 1, 'Original Gantrithor completes one actual paid native Interceptor');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 25, 'Both races share the original hundred minerals and pay normal production costs');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[1]), 100, 'Normal Marine and Interceptor production does not invent gas spending or funding');
    const current = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/), cameraX = Math.max(0, Math.min(Number(gantrithor[3]) - 640, x.openbw_map_w() * 32 - 1280)), cameraY = Math.max(0, Math.min(Number(gantrithor[4]) - 400, x.openbw_map_h() * 32 - 800));
    x.openbw_pan(cameraX - Number(current[1]), cameraY - Number(current[2]));
    x.openbw_debug_select(Number(gantrithor[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    x.openbw_key(1, 109, 0); x.openbw_key(0, 109, 0);
    const targetX = Number(gantrithor[3]) + 160 - cameraX, targetY = Number(gantrithor[4]) - 96 - cameraY;
    x.openbw_mouse_button(1, 1, targetX, targetY, 1); x.openbw_mouse_button(0, 1, targetX, targetY, 1); x.openbw_render(0);
    const movement = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(movement.length > 0, 'Original Gantrithor flight uses normal synchronized human input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(movement.length), movement.length).set(movement);
    x.openbw_apply(mission.humanSlot, movement.length); x.openbw_out_clear();
    for (let tick = 0; tick < 96; tick++) x.openbw_step();
    const moved = owned().find(unit => unit[0] === gantrithor[0]);
    assert.ok(moved && Math.hypot(Number(moved[3]) - Number(gantrithor[3]), Number(moved[4]) - Number(gantrithor[4])) > 48, 'The same original Gantrithor moves through native flight without teleportation');
    assert.equal(x.openbw_outcome(), 0, 'Paid dual-race production and local hero flight cannot bypass the original Overmind objective');
    console.log('Eye of the Storm normal paid Terran/Protoss production and original Gantrithor flight passed.');
  }
  if (missionId === 'protoss09') {
    const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
    const worker = owned().find(unit => unit[1] === 'Probe'), arbiter = owned().find(unit => unit[1] === 'Arbiter');
    assert.ok(worker && arbiter && owned().some(unit => unit[1] === 'Zeratul') && owned().some(unit => unit[1].includes('Fenix')), 'Native opening rescue retains the original heroes, worker and Arbiter');
    const current = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/), cameraX = Math.max(0, Math.min(Number(worker[3]) - 640, x.openbw_map_w() * 32 - 1280)), cameraY = Math.max(0, Math.min(Number(worker[4]) - 400, x.openbw_map_h() * 32 - 800));
    x.openbw_pan(cameraX - Number(current[1]), cameraY - Number(current[2]));
    const applyQueued = () => {
      const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      assert.ok(output.length > 0, 'Original Protoss construction/flight uses normal synchronized input');
      new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
      x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    };
    x.openbw_debug_select(Number(worker[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    let site = null;
    for (let offsetY = -192; offsetY <= 64 && !site; offsetY += 32) for (let offsetX = -192; offsetX <= 192 && !site; offsetX += 32) {
      const mapX = Math.floor(Number(worker[3]) / 32) * 32 + offsetX, mapY = Math.floor(Number(worker[4]) / 32) * 32 + offsetY;
      if (mapX < cameraX + 160 || mapX > cameraX + 1120 || mapY < cameraY + 64 || mapY > cameraY + 640) continue;
      if ((x.openbw_debug_build_check(156, mapX, mapY) & 3) === 3) site = [mapX - cameraX, mapY - cameraY];
    }
    assert.ok(site, 'Native placement supplies a legal Pylon site near the original baseless start');
    for (const key of ['b', 'p']) { x.openbw_key(1, key.charCodeAt(0), 0); x.openbw_key(0, key.charCodeAt(0), 0); x.openbw_render(0); }
    x.openbw_mouse_button(1, 1, ...site, 1); x.openbw_mouse_button(0, 1, ...site, 1); x.openbw_render(0); applyQueued();
    let completed = false;
    for (let tick = 0; tick < 1500 && !completed; tick++) {
      x.openbw_step();
      if (tick % 16) continue;
      const pylon = owned().find(unit => unit[1] === 'Pylon');
      if (pylon) { x.openbw_debug_select(Number(pylon[0]), 0); x.openbw_render(0); completed = !/\tCancel\t/.test(read(x.openbw_card())); }
    }
    assert.ok(completed, 'An original Probe completes a paid native Pylon without a granted base');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 900, 'Original 1000 minerals pay the native 100-mineral Pylon cost');
    assert.equal(owned().filter(unit => unit[1] === 'Probe').length, 4, 'Protoss construction retains the original Probe');
    x.openbw_debug_select(Number(arbiter[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    assert.doesNotMatch(read(x.openbw_card()), /\t(?:Recall|Stasis Field)\t/, 'The original ordinary Arbiter cannot bypass authored missing Recall/Stasis research');
    x.openbw_key(1, 109, 0); x.openbw_key(0, 109, 0);
    const targetX = Number(arbiter[3]) + 160 - cameraX, targetY = Number(arbiter[4]) - 160 - cameraY;
    x.openbw_mouse_button(1, 1, targetX, targetY, 1); x.openbw_mouse_button(0, 1, targetX, targetY, 1); x.openbw_render(0); applyQueued();
    for (let tick = 0; tick < 96; tick++) x.openbw_step();
    const moved = owned().find(unit => unit[0] === arbiter[0]);
    assert.ok(moved && Math.hypot(Number(moved[3]) - Number(arbiter[3]), Number(moved[4]) - Number(arbiter[4])) > 48, 'The same original Arbiter flies without teleportation');
    assert.equal(x.openbw_outcome(), 0, 'Paid construction and normal flight do not bypass the two Cerebrate/Zeratul gates');
    console.log('Shadow Hunters paid original Probe construction and native Arbiter flight passed.');
  }
  if (missionId === 'protoss08') {
    const owned = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => Number(unit[2]) === mission.humanSlot);
    const carrier = owned().find(unit => unit[1] === 'Carrier');
    assert.ok(carrier && owned().some(unit => unit[1].includes('Fenix')) && owned().some(unit => unit[1].includes('Hyperion')), 'Original setup and native rescue retain the original Carrier, Fenix and Raynor');
    x.openbw_debug_select(Number(carrier[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    const interceptor = read(x.openbw_card()).trim().split('\n').map(line => line.split('\t')).find(row => row[1] === 'Build Interceptor');
    assert.ok(interceptor?.[0], 'The original empty Carrier exposes native Interceptor production');
    x.openbw_key(1, interceptor[0].charCodeAt(0), 0); x.openbw_key(0, interceptor[0].charCodeAt(0), 0); x.openbw_render(0);
    const production = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(production.length > 0, 'Interceptor production uses normal synchronized input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(production.length), production.length).set(production);
    x.openbw_apply(mission.humanSlot, production.length); x.openbw_out_clear();
    for (let tick = 0; tick < 600; tick++) x.openbw_step();
    assert.equal(owned().filter(unit => unit[1].includes('Interceptor')).length, 1, 'Native player production adds one actual original Carrier fighter');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 45, 'Native Interceptor production charges twenty-five of the original seventy minerals without test funding');
    const current = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/), cameraX = Math.max(0, Math.min(Number(carrier[3]) - 640, x.openbw_map_w() * 32 - 1280)), cameraY = Math.max(0, Math.min(Number(carrier[4]) - 400, x.openbw_map_h() * 32 - 800));
    x.openbw_pan(cameraX - Number(current[1]), cameraY - Number(current[2]));
    x.openbw_debug_select(Number(carrier[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    x.openbw_key(1, 109, 0); x.openbw_key(0, 109, 0);
    const targetX = Number(carrier[3]) + 160 - cameraX, targetY = Number(carrier[4]) - 96 - cameraY;
    x.openbw_mouse_button(1, 1, targetX, targetY, 1); x.openbw_mouse_button(0, 1, targetX, targetY, 1); x.openbw_render(0);
    const movement = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(movement.length > 0, 'Original Carrier flight uses normal synchronized input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(movement.length), movement.length).set(movement);
    x.openbw_apply(mission.humanSlot, movement.length); x.openbw_out_clear();
    for (let tick = 0; tick < 96; tick++) x.openbw_step();
    const moved = owned().find(unit => unit[0] === carrier[0]);
    assert.ok(moved && Math.hypot(Number(moved[3]) - Number(carrier[3]), Number(moved[4]) - Number(carrier[4])) > 48, 'The same original Carrier moves through native flight without teleportation');
    assert.equal(x.openbw_outcome(), 0, 'Paid ammunition and local flight cannot bypass the original Stasis Cell objective');
    console.log('The Trial of Tassadar native paid Interceptor production and original Carrier flight passed.');
  }
  if (['protoss04', 'protoss06'].includes(missionId)) {
    const templar = missionId === 'protoss04' ? human.find(unit => unit[1] === 'High Templar') : read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[1] === 'Tassadar' && unit[2] === '7');
    assert.ok(templar, 'Original spellcaster supplies native controls without a substitute or ownership grant');
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/), cameraX = Math.max(0, Math.min(Number(templar[3]) - 640, x.openbw_map_w() * 32 - 1280)), cameraY = Math.max(0, Math.min(Number(templar[4]) - 400, x.openbw_map_h() * 32 - 800));
    x.openbw_pan(cameraX - Number(camera[1]), cameraY - Number(camera[2]));
    x.openbw_debug_select(Number(templar[0]), 0); x.openbw_render(0);
    const storm = read(x.openbw_card()).trim().split('\n').map(line => line.split('\t')).find(line => line[1] === 'Psionic Storm');
    assert.ok(storm?.[0], 'Original mission permits this caster to use Psionic Storm without a research grant');
    const energy = Number(read(x.openbw_card()).match(/Energy (\d+)/)[1]);
    x.openbw_out_clear(); x.openbw_key(1, storm[0].charCodeAt(0), 0); x.openbw_key(0, storm[0].charCodeAt(0), 0);
    const targetX = Number(templar[3]) + 128 - cameraX, targetY = Number(templar[4]) + 128 - cameraY;
    x.openbw_mouse_button(1, 1, targetX, targetY, 1); x.openbw_mouse_button(0, 1, targetX, targetY, 1); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Original caster Storm uses normal synchronized targeted-spell input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 96; tick++) x.openbw_step();
    x.openbw_render(0);
    assert.ok(Number(read(x.openbw_card()).match(/Energy (\d+)/)[1]) <= energy - 70, 'Native Storm pays its seventy-five-energy cost with normal regeneration');
    x.openbw_out_clear(); x.openbw_key(1, 109, 0); x.openbw_key(0, 109, 0);
    const moveX = Number(templar[3]) - 96 - cameraX, moveY = Number(templar[4]) - 96 - cameraY;
    x.openbw_mouse_button(1, 1, moveX, moveY, 1); x.openbw_mouse_button(0, 1, moveX, moveY, 1); x.openbw_render(0);
    const movement = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(movement.length > 0, 'Original caster movement uses normal synchronized input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(movement.length), movement.length).set(movement);
    x.openbw_apply(mission.humanSlot, movement.length); x.openbw_out_clear();
    for (let tick = 0; tick < 96; tick++) x.openbw_step();
    const moved = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[0] === templar[0]);
    assert.ok(moved && Math.hypot(Number(moved[3]) - Number(templar[3]), Number(moved[4]) - Number(templar[4])) > 32, 'The same original caster moves through native pathing');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 0, 'Control checks cannot inject minerals into the original mission');
    console.log(`${mission.title} native paid Storm and normal movement controls passed.`);
  }
  if (['protoss03', 'protoss07'].includes(missionId)) {
    const scout = human.find(unit => unit[1] === 'Scout');
    if (missionId === 'protoss07') {
      const current = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/), cameraX = Math.max(0, Math.min(Number(scout[3]) - 640, x.openbw_map_w() * 32 - 1280)), cameraY = Math.max(0, Math.min(Number(scout[4]) - 400, x.openbw_map_h() * 32 - 800));
      x.openbw_pan(cameraX - Number(current[1]), cameraY - Number(current[2]));
    }
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    x.openbw_debug_select(Number(scout[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    x.openbw_key(1, 109, 0); x.openbw_key(0, 109, 0); x.openbw_render(0);
    const targetX = Number(scout[3]) + 320 - Number(camera[1]), targetY = Number(scout[4]) - 256 - Number(camera[2]);
    x.openbw_mouse_button(1, 1, targetX, targetY, 1); x.openbw_mouse_button(0, 1, targetX, targetY, 1); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Original Scout flight uses normal synchronized movement input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 96; tick++) x.openbw_step();
    const moved = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[0] === scout[0]);
    assert.ok(moved && Math.hypot(Number(moved[3]) - Number(scout[3]), Number(moved[4]) - Number(scout[4])) > 64, 'The same original Scout flies through native movement without teleportation');
    console.log(`${mission.title} original Scout normal flight passed.`);
  }
  if (['zerg09', 'zerg10'].includes(missionId)) {
    const larva = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[1] === 'Larva' && unit[2] === '3');
    assert.ok(larva, 'Original Hatchery has a native Larva for paid player production');
    x.openbw_debug_select(Number(larva[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    x.openbw_key(1, 100, 0); x.openbw_key(0, 100, 0); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Larva morphing uses normal synchronized player input');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 600; tick++) x.openbw_step();
    const owned = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => unit[2] === '3');
    assert.equal(owned.filter(unit => unit[1] === 'Drone').length, missionId === 'zerg09' ? 5 : 4, 'Native player production adds one completed Drone');
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), missionId === 'zerg09' ? 700 : 950, 'Original minerals pay the normal fifty-mineral Drone cost without test funding');
    assert.equal(x.openbw_mission_countdown(), -1, 'Ordinary production cannot invent an objective countdown');
    console.log(`${mission.title} paid native Drone morph and original objective-gate isolation passed.`);
  }
  if (['zerg05', 'zerg06', 'zerg08'].includes(missionId)) {
    const kerrigan = human.find(unit => unit[1] === 'Infested Kerrigan');
    x.openbw_debug_select(Number(kerrigan[0]), 0); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /\tCloak\t/);
    assert.match(read(x.openbw_card()), /\tConsume\t/);
    if (missionId === 'zerg05') assert.doesNotMatch(read(x.openbw_card()), /Psionic Storm/, 'The original Amerigo mission disables Storm');
    else assert.match(read(x.openbw_card()), /Psionic Storm/, 'The original mission permits Storm');
    const energy = Number(read(x.openbw_card()).match(/Energy (\d+)/)[1]);
    for (const expected of ['Decloak', 'Cloak']) {
      x.openbw_out_clear(); x.openbw_key(1, 99, 0); x.openbw_key(0, 99, 0); x.openbw_render(0);
      const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      assert.ok(output.length > 0, 'Kerrigan cloak and decloak use synchronized input');
      new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
      x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
      for (let tick = 0; tick < 128; tick++) {
        x.openbw_step(); x.openbw_render(0);
        if (read(x.openbw_card()).includes(`\t${expected}\t`)) break;
      }
      assert.ok(read(x.openbw_card()).includes(`\t${expected}\t`), `Native Kerrigan state offers ${expected}: ${read(x.openbw_card())}`);
      if (expected === 'Decloak') assert.ok(Number(read(x.openbw_card()).match(/Energy (\d+)/)[1]) <= energy - 24, 'Original hero cloak charges the native twenty-five-energy cost');
    }
    if (['zerg06', 'zerg08'].includes(missionId)) {
      const storm = read(x.openbw_card()).trim().split('\n').map(line => line.split('\t')).find(line => line[1] === 'Psionic Storm');
      assert.ok(storm?.[0], 'Mission-enabled Storm has a usable native command-card hotkey');
      const beforeStorm = Number(read(x.openbw_card()).match(/Energy (\d+)/)[1]);
      const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
      x.openbw_out_clear(); x.openbw_key(1, storm[0].charCodeAt(0), 0); x.openbw_key(0, storm[0].charCodeAt(0), 0);
      const targetX = Number(kerrigan[3]) + 64 - Number(camera[1]), targetY = Number(kerrigan[4]) + 96 - Number(camera[2]);
      x.openbw_mouse_button(1, 1, targetX, targetY, 1); x.openbw_mouse_button(0, 1, targetX, targetY, 1); x.openbw_render(0);
      const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
      assert.ok(output.length > 0, 'Storm uses normal synchronized targeted-spell input');
      new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
      x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
      for (let tick = 0; tick < 96; tick++) x.openbw_step();
      x.openbw_render(0);
      assert.ok(Number(read(x.openbw_card()).match(/Energy (\d+)/)[1]) <= beforeStorm - 70, 'Native Psionic Storm pays its seventy-five-energy cost, allowing normal regeneration');
    }
    console.log(`${mission.title} original Kerrigan paid cloak/decloak and authored Storm availability controls passed.`);
  }
  if (missionId === 'zerg08') {
    const kerrigan = human.find(unit => unit[1] === 'Infested Kerrigan');
    const entrance = human.find(unit => unit[1] === 'Nydus Canal' && Number(unit[3]) === 3424 && Number(unit[4]) === 576);
    const exit = human.find(unit => unit[1] === 'Nydus Canal' && Number(unit[3]) === 3808 && Number(unit[4]) === 3776);
    assert.ok(kerrigan && entrance && exit, 'The original north/south canal pair and Kerrigan are present');
    x.openbw_debug_select(Number(kerrigan[0]), 0); x.openbw_render(0); x.openbw_out_clear();
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    const targetX = Number(entrance[3]) - Number(camera[1]), targetY = Number(entrance[4]) - Number(camera[2]);
    x.openbw_mouse_button(1, 3, targetX, targetY, 1); x.openbw_mouse_button(0, 3, targetX, targetY, 1); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(output.length > 0, 'Normal Nydus right-click uses synchronized unit orders');
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    let arrived = false;
    for (let tick = 0; tick < 400 && !arrived; tick++) {
      x.openbw_step();
      const current = read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).find(unit => unit[0] === kerrigan[0]);
      arrived = !!current && Math.hypot(Number(current[3]) - Number(exit[3]), Number(current[4]) - Number(exit[4])) < 160;
    }
    assert.ok(arrived, 'Native player orders move Kerrigan through the original linked Nydus pair');
    console.log('Eye for an Eye normal right-click Nydus transport through the source-linked pair passed.');
  }
  if (missionId === 'terran06') {
    const raynor = human.find(unit => unit[1] === 'Jim Raynor'), worker = human.find(unit => unit[1] === 'SCV');
    assert.ok(raynor && worker);
    x.openbw_debug_select(Number(worker[0]), 0); x.openbw_debug_select(Number(raynor[0]), 1); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /^Jim Raynor\t/, 'Hero Raynor has stable precedence over a first-selected SCV');
    assert.match(read(x.openbw_card()), /Mines 3/, 'Hero Raynor retains his innate mine-ammunition readout');
    assert.match(read(x.openbw_card()), /\tSpider Mines\t/);
    assert.equal(read(x.openbw_wires()).trim().split('\n').length, 2);
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    const left = Math.max(0, Number(raynor[3]) - 640), top = Math.max(0, Number(raynor[4]) - 400);
    x.openbw_pan(left - Number(camera[1]), top - Number(camera[2]));
    x.openbw_out_clear(); x.openbw_key(1, 105, 0); x.openbw_key(0, 105, 0); x.openbw_render(0);
    const targetX = Number(raynor[3]) + 64 - left, targetY = Number(raynor[4]) + 32 - top;
    x.openbw_mouse_button(1, 1, targetX, targetY, 1); x.openbw_mouse_button(0, 1, targetX, targetY, 1); x.openbw_render(0);
    const output = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.equal(output[2], 9); assert.equal(output[3], 2, 'Mine placement retains the visual group and lets native eligibility skip the SCV');
    const mineSelection = [output[4] | output[5] << 8, output[6] | output[7] << 8].sort((a, b) => a - b);
    assert.deepEqual(mineSelection, [Number(worker[0]), Number(raynor[0])].sort((a, b) => a - b));
    new Uint8Array(memory.buffer, x.openbw_in_ptr(output.length), output.length).set(output);
    x.openbw_apply(mission.humanSlot, output.length); x.openbw_out_clear();
    for (let tick = 0; tick < 240; tick++) x.openbw_step();
    x.openbw_render(0);
    assert.match(read(x.openbw_card()), /Mines 2/, 'Raynor places a real mine while the SCV remains selected');
    x.openbw_key(1, 0, 43); x.openbw_key(0, 0, 43); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /^SCV\t/, 'Tab exposes the selected worker without dropping Raynor');
    x.openbw_key(1, 98, 0); x.openbw_key(0, 98, 0); x.openbw_render(0);
    assert.match(read(x.openbw_card()), /\tBarracks\t/, 'Active SCV exposes Barracks construction in a mixed hero group');
    assert.equal(read(x.openbw_wires()).trim().split('\n').length, 2);
    x.openbw_key(1, 0, 41); x.openbw_key(0, 0, 41); x.openbw_render(0);
    console.log('Mixed Raynor/SCV precedence, real mine placement and worker Tab controls passed.');
  }
  if (missionId === 'terran01') {
    x.openbw_debug_select(Number(human.find(unit => unit[1] === 'SCV')[0]), 0);
    const buildChecks = [[1056, 1584], [864, 1744], [1120, 1584], [1216, 1584], [1056, 1904]].map(([mapX, mapY]) => ({mapX, mapY, flags: x.openbw_debug_build_check(111, mapX, mapY)}));
    assert.ok(buildChecks.every(check => check.flags & 1), 'Original mission permits SCVs to build Barracks');
    console.log('Campaign Barracks placement checks:', JSON.stringify(buildChecks));
  }
  if (missionId === 'terran02' && !recoveryTest) {
    const raynor = human.find(unit => unit[1] === 'Jim Raynor');
    const marine = human.find(unit => unit[1] === 'Marine');
    assert.ok(raynor && marine, 'Original owned hero and Marine voice fixture');
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    assert.ok(camera);
    x.openbw_pan(Number(raynor[3]) - 320 - Number(camera[1]), Number(raynor[4]) - 240 - Number(camera[2]));
    x.openbw_debug_select(Number(raynor[0]), 0);
    const move = () => {
      soundClockOffset += 100000000n;
      const start = soundPlays.length;
      x.openbw_key(1, 109, 0);
      x.openbw_key(0, 109, 0);
      x.openbw_render(0);
      x.openbw_mouse_button(1, 1, 400, 300, 1);
      x.openbw_mouse_button(0, 1, 400, 300, 1);
      x.openbw_render(0);
      return soundPlays.slice(start).map(play => play[0]);
    };
    const heroSounds = new Set();
    for (let count = 0; count != 16; ++count) for (const sound of move()) heroSounds.add(sound);
    assert.ok(heroSounds.size > 0, 'Raynor movement reaches native sound playback');
    x.openbw_debug_select(Number(marine[0]), 0);
    x.openbw_debug_select(Number(raynor[0]), 1);
    const mixedSounds = move();
    assert.ok(mixedSounds.length > 0, 'Mixed selection acknowledges movement');
    assert.ok(mixedSounds.every(sound => heroSounds.has(sound)), 'Raynor speaks when mixed with ordinary Marines');
    console.log('Campaign hero acknowledgement checks passed.');
    const commandCenter = human.find(unit => unit[1] === 'Command Center');
    assert.ok(commandCenter);
    let offScreen = false;
    for (const [horizontal, vertical] of [[0, 0], [2048, 0], [0, 2048], [2048, 2048]]) {
      const current = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
      x.openbw_pan(horizontal - Number(current[1]), vertical - Number(current[2]));
      const moved = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
      const outside = unit => Number(unit[3]) < Number(moved[1]) || Number(unit[3]) >= Number(moved[1]) + 1280 || Number(unit[4]) < Number(moved[2]) || Number(unit[4]) >= Number(moved[2]) + 800;
      if (outside(marine) && outside(commandCenter)) { offScreen = true; break; }
    }
    assert.ok(offScreen, 'Advisor fixture has off-screen unit and building');
    const damageAlert = (unit, life) => {
      for (let tick = 0; tick != 1801; ++tick) x.openbw_render(0);
      soundClockOffset += 100000000n;
      const start = soundPlays.length;
      x.openbw_debug_set_life(Number(unit[0]), life, -1);
      x.openbw_render(0);
      const played = soundPlays.slice(start).map(play => play[0]);
      assert.equal(played.length, 1, 'Off-screen damage emits one advisor clip');
      return played[0];
    };
    const forcesAlert = damageAlert(marine, 39);
    const baseAlert = damageAlert(commandCenter, 1499);
    assert.notEqual(forcesAlert, baseAlert, 'Field-unit and building attacks use different advisor clips');
    console.log('Campaign base/forces advisor checks passed.');
  }
  console.log(`Campaign original-trigger checks passed: ${events.length} events, ${events.filter(event => event[3] === 7).length} transmissions.`);
}

function testProtossSelection() {
  const read = readRecoveryString;
  const units = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t')).filter(unit => unit[2] === '0');
  const press = symbol => { x.openbw_key(1, symbol.charCodeAt(0), 0); x.openbw_key(0, symbol.charCodeAt(0), 0); x.openbw_render(0); };
  const applyQueued = () => {
    const bytes = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    assert.ok(bytes.length > 0);
    new Uint8Array(memory.buffer, x.openbw_in_ptr(bytes.length), bytes.length).set(bytes);
    x.openbw_apply(0, bytes.length); x.openbw_out_clear();
    return bytes;
  };
  x.openbw_debug_resources(2000, 1000);
  const probe = units().find(unit => unit[1] === 'Probe');
  assert.ok(probe);
  const build = (type, label, width, height) => {
    x.openbw_debug_select(Number(probe[0]), 0); x.openbw_render(0);
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    let site = null;
    for (let tileY = Math.ceil((Number(camera[2]) + 64) / 32); tileY * 32 < Number(camera[2]) + 512 && !site; tileY++) {
      for (let tileX = Math.ceil((Number(camera[1]) + 160) / 32); tileX * 32 < Number(camera[1]) + 1120 && !site; tileX++) {
        const mapX = tileX * 32 + width * 16, mapY = tileY * 32 + height * 16;
        if ((x.openbw_debug_build_check(type, mapX, mapY) & 3) === 3) site = [mapX - Number(camera[1]), mapY - Number(camera[2])];
      }
    }
    assert.ok(site, `Legal native placement for ${label}`);
    press('b');
    const command = read(x.openbw_card()).split('\n').map(line => line.split('\t')).find(row => row[1] === label);
    assert.ok(command, `Probe command for ${label}`); press(command[0]);
    x.openbw_mouse_button(1, 1, ...site, 1); x.openbw_mouse_button(0, 1, ...site, 1); x.openbw_render(0); applyQueued();
    for (let tick = 0; tick < 3000; tick++) {
      x.openbw_step();
      if (tick % 16) continue;
      const building = units().find(unit => unit[1] === label);
      if (!building) continue;
      x.openbw_debug_select(Number(building[0]), 0); x.openbw_render(0);
      if (!/\tCancel\t/.test(read(x.openbw_card()))) return building;
    }
    assert.fail(`${label} completes through native Probe construction`);
  };
  build(156, 'Pylon', 2, 2);
  const gateway = build(160, 'Gateway', 4, 3);
  build(164, 'Cybernetics Core', 3, 2);
  const train = label => {
    x.openbw_debug_select(Number(gateway[0]), 0); x.openbw_render(0);
    const command = read(x.openbw_card()).split('\n').map(line => line.split('\t')).find(row => row[1] === label);
    assert.ok(command); press(command[0]); applyQueued();
    for (let tick = 0; tick < 1800; tick++) { x.openbw_step(); const unit = units().find(unit => unit[1] === label); if (unit) return unit; }
    assert.fail(`${label} completes through native Gateway production`);
  };
  const zealot = train('Zealot'), dragoon = train('Dragoon');
  x.openbw_debug_select(Number(probe[0]), 0); x.openbw_debug_select(Number(zealot[0]), 1); x.openbw_debug_select(Number(dragoon[0]), 1); x.openbw_render(0);
  assert.match(read(x.openbw_card()), /^Dragoon\t/, 'A more valuable Protoss unit takes stable default precedence');
  const tab = backwards => {
    if (backwards) x.openbw_key(1, 0, 225);
    x.openbw_key(1, 0, 43); x.openbw_key(0, 0, 43);
    if (backwards) x.openbw_key(0, 0, 225);
    x.openbw_render(0);
  };
  tab(false); assert.match(read(x.openbw_card()), /^Zealot\t/);
  tab(false); assert.match(read(x.openbw_card()), /^Probe\t/);
  press('b'); assert.match(read(x.openbw_card()), /\tGateway\t/, 'Tab exposes Probe building options inside a three-type group');
  x.openbw_key(1, 0, 41); x.openbw_key(0, 0, 41); x.openbw_render(0);
  tab(true); assert.match(read(x.openbw_card()), /^Zealot\t/, 'Shift+Tab reverses the three-type order');
  assert.equal(read(x.openbw_wires()).trim().split('\n').length, 3);
  x.openbw_out_clear(); press('m');
  x.openbw_mouse_button(1, 1, 900, 300, 1); x.openbw_mouse_button(0, 1, 900, 300, 1); x.openbw_render(0);
  const move = applyQueued();
  assert.equal(move[2], 9); assert.equal(move[3], 3, 'Generic movement still applies to every selected type');
  console.log('Protoss three-type precedence, forward/reverse Tab, Probe commands and whole-group movement passed.');
}

function testCommands(groupMines = false) {
  const read = (pointer) => {
    const bytes = new Uint8Array(memory.buffer);
    let end = pointer;
    while (bytes[end]) end++;
    return new TextDecoder().decode(bytes.subarray(pointer, end));
  };
  const units = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t'));
  const records = () => {
    const bytes = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len());
    const result = [];
    for (let offset = 0; offset < bytes.length;) {
      const length = bytes[offset] | bytes[offset + 1] << 8;
      offset += 2;
      result.push(Array.from(bytes.subarray(offset, offset + length)));
      offset += length;
    }
    return result;
  };
  const apply = () => {
    const bytes = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    const pointer = x.openbw_in_ptr(bytes.length);
    new Uint8Array(memory.buffer).set(bytes, pointer);
    x.openbw_apply(0, bytes.length);
    x.openbw_out_clear();
  };
  const press = (symbol, scancode = 0) => {
    x.openbw_key(1, symbol, scancode);
    x.openbw_key(0, symbol, scancode);
  };
  const worker = units().find(unit => unit[1] === 'SCV');
  const building = units().find(unit => unit[1] === 'Command Center');
  assert.ok(worker && building);
  x.openbw_debug_select(Number(worker[0]), 0);
  x.openbw_mouse_move(-1, -1);
  x.openbw_render(0);

  x.openbw_set_touch_controls(1);
  const mobileCard = read(x.openbw_card()).split('\n').slice(1).map(line => line.split('\t'));
  assert.deepEqual(mobileCard.map(command => command[1]), ['Move', 'Attack', 'Build', 'Stop']);
  assert.equal(mobileCard.find(command => command[1] === 'Stop')[2], '0');
  press(98);
  x.openbw_render(0);
  const mobileBuildings = read(x.openbw_card()).split('\n').slice(1).map(line => line.split('\t'));
  assert.ok(mobileBuildings.length > 0);
  assert.ok(mobileBuildings.every(command => command[2] === '1'));
  assert.ok(mobileBuildings.find(command => command[1] === 'Supply Depot'));
  assert.equal(mobileBuildings.some(command => command[1] === 'Factory'), false);
  assert.equal(mobileBuildings.find(command => command[1] === 'Supply Depot')[6], '0');
  press(0, 41);
  x.openbw_render(0);
  x.openbw_set_touch_controls(0);

  x.openbw_debug_select(Number(building[0]), 0);
  assert.match(read(x.openbw_card()), /Comsat Station/);
  x.openbw_set_touch_controls(1);
  x.openbw_debug_resources(0, 0);
  x.openbw_render(0);
  const mobileProducer = read(x.openbw_card()).split('\n').slice(1).map(line => line.split('\t'));
  assert.equal(mobileProducer.some(command => command[1] === 'Comsat Station'), false);
  assert.equal(mobileProducer.some(command => command[1] === 'Nuclear Silo'), false);
  assert.equal(mobileProducer.find(command => command[1] === 'SCV')[2], '1');
  assert.equal(mobileProducer.find(command => command[1] === 'SCV')[6], '0');
  x.openbw_debug_resources(50, 0);
  x.openbw_set_touch_controls(0);
  x.openbw_debug_select(Number(worker[0]), 0);

  for (const releaseBeforeClick of [false, true]) {
    x.openbw_out_clear();
    x.openbw_key(1, 97, 4);
    if (releaseBeforeClick) x.openbw_key(0, 97, 4);
    x.openbw_mouse_button(1, 1, 500, 350, 1);
    x.openbw_mouse_button(0, 1, 500, 350, 1);
    if (!releaseBeforeClick) x.openbw_key(0, 97, 4);
    x.openbw_render(0);
    assert.equal(records().find(record => record[0] === 21)?.[9], 14, 'Immediate A and ground click must issue AttackMove, not Move, without an intervening render');
  }

  for (const [before, after] of [[0, 1], [1, 0]]) {
    x.openbw_set_touch_controls(before);
    x.openbw_out_clear();
    x.openbw_mouse_move(500, 350);
    press(97);
    x.openbw_render(0);
    assert.ok([1, 4].includes(x.openbw_cursor()), 'Attack key arms a target before switching pointer mode');
    x.openbw_set_touch_controls(after);
    assert.ok([1, 4].includes(x.openbw_cursor()), 'Pointer mode changes must preserve a pending Attack target');
    x.openbw_mouse_button(1, 1, 500, 350, 1);
    x.openbw_mouse_button(0, 1, 500, 350, 1);
    x.openbw_render(0);
    assert.equal(records().find(record => record[0] === 21)?.[9], 14, 'The first click after a pointer-mode change must issue AttackMove, not Move');
  }
  x.openbw_set_touch_controls(0);
  x.openbw_out_clear();

  for (const shift of [225, 229]) {
    for (const releaseBeforeRender of [false, true]) {
      x.openbw_out_clear();
      x.openbw_key(1, 0, shift);
      press(104, 11);
      if (releaseBeforeRender) x.openbw_key(0, 0, shift);
      x.openbw_render(0);
      assert.deepEqual(records().find(record => record[0] === 43), [43, 1]);
      if (!releaseBeforeRender) {
        x.openbw_key(0, 0, shift);
        x.openbw_render(0);
      }
    }
  }
  x.openbw_out_clear();
  press(104, 11);
  x.openbw_render(0);
  assert.deepEqual(records().find(record => record[0] === 43), [43, 0]);

  x.openbw_out_clear();
  x.openbw_key(1, 0, 225);
  x.openbw_mouse_button(1, 3, 200, 100, 1);
  x.openbw_mouse_button(0, 3, 200, 100, 1);
  x.openbw_key(0, 0, 225);
  x.openbw_render(0);
  assert.equal(records().find(record => record[0] === 20)?.at(-1), 1);

  x.openbw_key(1, 0, 224);
  press(49, 30);
  x.openbw_key(0, 0, 224);
  x.openbw_render(0);
  x.openbw_debug_select(Number(building[0]), 0);
  press(49, 30);
  x.openbw_render(0);
  assert.match(read(x.openbw_debug_dump()), /unit=SCV owner=0/);

  x.openbw_out_clear();
  press(98);
  x.openbw_render(0);
  assert.equal(read(x.openbw_card()).split('\t')[0], 'Build');
  press(0, 41);
  x.openbw_render(0);
  assert.equal(records().length, 0);
  assert.equal(read(x.openbw_card()).split('\t')[0], 'SCV');

  x.openbw_debug_select(Number(building[0]), 0);
  x.openbw_debug_resources(1000, 1000);
  for (let index = 0; index < 3; index++) press(115, 22);
  x.openbw_render(0);
  apply();
  for (let frame = 0; frame < 60; frame++) x.openbw_step();
  x.openbw_render(0);
  const before = read(x.openbw_status()).split('\t');
  const progress = Number(before[0]);
  assert.equal(before.length - 1, 3);
  assert.ok(progress > 0);
  for (const slot of [2, 1, 0]) {
    press(0, 41);
    x.openbw_render(0);
    assert.deepEqual(records().find(record => record[0] === 32), [32, slot, 0]);
    apply();
    x.openbw_render(0);
    const status = read(x.openbw_status());
    assert.equal(status ? status.split('\t').length - 1 : 0, slot);
    if (slot) assert.equal(Number(status.split('\t')[0]), progress);
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 1000 - slot * 50);
  }

  const word = value => [value & 255, value >> 8 & 255];
  const send = (unit, command) => {
    const bytes = Uint8Array.from([[9, 1, ...word(Number(unit[0]))], command]
      .flatMap(record => [...word(record.length), ...record]));
    const pointer = x.openbw_in_ptr(bytes.length);
    new Uint8Array(memory.buffer).set(bytes, pointer);
    x.openbw_apply(0, bytes.length);
  };
  const advance = (frames) => {
    for (let frame = 0; frame < frames; frame++) x.openbw_step();
  };
  const buildNearBase = (type, name) => {
    for (const [offsetX, offsetY] of [[160, 96], [-160, 96], [160, -96], [-160, -96],
                                    [256, 0], [-256, 0], [0, 192], [0, -192],
                                    [320, 96], [-320, 96], [320, -96], [-320, -96],
                                    [160, 256], [-160, 256], [160, -256], [-160, -256]]) {
      const tileX = Math.round((Number(building[3]) + offsetX - 64) / 32);
      const tileY = Math.round((Number(building[4]) + offsetY - 48) / 32);
      if (tileX < 0 || tileY < 0 || tileX + 4 > x.openbw_map_w() || tileY + 3 > x.openbw_map_h()) continue;
      send(worker, [12, 30, ...word(tileX), ...word(tileY), ...word(type)]);
      advance(2400);
      const placed = units().find(unit => unit[1] === name);
      if (placed) return placed;
    }
    x.openbw_debug_select(Number(worker[0]), 0);
    assert.fail(`Could not construct ${name}: ${read(x.openbw_resources())}\n${read(x.openbw_debug_dump())}\n${read(x.openbw_debug_units())}`);
  };

  x.openbw_debug_resources(10000, 10000);
  const barracks = buildNearBase(111, 'Barracks');
  x.openbw_debug_select(Number(barracks[0]), 0);
  press(109);
  press(109);
  x.openbw_render(0);
  apply();
  advance(60);
  x.openbw_render(0);
  assert.equal(read(x.openbw_status()).split('\t').length - 1, 2);
  for (const slot of [1, 0]) {
    press(0, 41);
    x.openbw_render(0);
    assert.deepEqual(records().find(record => record[0] === 32), [32, slot, 0]);
    apply();
    x.openbw_render(0);
    const status = read(x.openbw_status());
    assert.equal(status ? status.split('\t').length - 1 : 0, slot);
  }

  const factory = buildNearBase(113, 'Factory');
  const addonX = (Number(factory[3]) - 64) / 32 + 4;
  const addonY = (Number(factory[4]) - 48) / 32 + 1;
  send(factory, [12, 36, ...word(addonX), ...word(addonY), ...word(120)]);
  advance(1200);
  const shop = units().find(unit => unit[1] === 'Machine Shop');
  assert.ok(shop, 'Machine Shop must complete before training a tank');
  send(shop, [48, 5]);
  send(factory, [31, 5, 0]);
  advance(2400);
  const tank = units().find(unit => unit[1] === 'Siege Tank');
  assert.ok(tank, 'Factory must train a tank');
  x.openbw_debug_select(Number(tank[0]), 0);
  x.openbw_render(0);
  assert.match(read(x.openbw_card()), /\no\tSiege Mode\t1/);
  const targetX = Number(tank[3]) + (Number(tank[3]) < 1024 ? 160 : -160);
  send(tank, [21, ...word(targetX), ...word(Number(tank[4])), 0, 0, 228, 0, 6, 0]);
  assert.match(read(x.openbw_debug_dump()), /order=6 /);
  x.openbw_out_clear();
  x.openbw_key(1, 0, 225);
  press(111, 18);
  x.openbw_key(0, 0, 225);
  x.openbw_render(0);
  assert.deepEqual(records().find(record => record[0] === 38), [38, 1]);
  apply();
  assert.match(read(x.openbw_debug_dump()), /order=6 /, 'Queued Siege Mode must not interrupt Move');
  advance(2400);
  x.openbw_render(0);
  assert.match(read(x.openbw_card()), /\no\tTank Mode\t1/, 'Tank must siege after finishing Move');
  for (const [opcode, queued, expectedOrder] of [[37, 0, 99], [38, 1, 98], [37, 1, 99]]) {
    x.openbw_out_clear();
    x.openbw_key(queued, 0, 225);
    press(111, 18);
    x.openbw_key(0, 0, 225);
    x.openbw_render(0);
    assert.deepEqual(records().find(record => record[0] === opcode), [opcode, queued]);
    apply();
    assert.match(read(x.openbw_debug_dump()), new RegExp(`order=${expectedOrder} `));
    advance(240);
    x.openbw_render(0);
  }
  send(tank, [21, ...word(Number(tank[3])), ...word(Number(tank[4])), 0, 0, 228, 0, 6, 0]);
  assert.match(read(x.openbw_debug_dump()), /order=6 /);
  x.openbw_out_clear();
  press(111, 18);
  x.openbw_render(0);
  assert.deepEqual(records().find(record => record[0] === 38), [38, 0]);
  apply();
  assert.match(read(x.openbw_debug_dump()), /order=98 /, 'Unmodified O must still interrupt Move');

  if (groupMines) {
    x.openbw_debug_resources(1000, 1000);
    buildNearBase(109, 'Supply Depot');
  }
  for (let count = 0; count < (groupMines ? 3 : 1); count++) send(factory, [31, 2, 0]);
  advance(groupMines ? 2400 : 1200);
  const groupedVultures = units().filter(unit => unit[1] === 'Vulture').sort((left, right) => Number(left[0]) - Number(right[0]));
  assert.equal(groupedVultures.length, groupMines ? 3 : 1, 'Factory completes paid Vulture production with sufficient native supply');
  let vulture = groupedVultures[0];
  x.openbw_set_touch_controls(1);
  x.openbw_debug_select(Number(vulture[0]), 0);
  assert.equal(read(x.openbw_card()).includes('Spider Mines'), false, 'Mines require research');
  assert.match(read(x.openbw_card()), /Patrol/);
  assert.doesNotMatch(read(x.openbw_card()), /Mines \d+/, 'Unresearched mines do not appear in the selected Vulture status');
  send(shop, [48, 3]);
  advance(2400);
  x.openbw_render(0);
  assert.match(read(x.openbw_card()), /Mines 3/, 'Paid Spider Mines research reveals the existing ammunition');
  if (groupMines) {
    send(vulture, [21, ...word(Number(vulture[3]) + 160), ...word(Number(vulture[4]) + 160), 0, 0, 228, 0, 6, 0]);
    advance(320);
    vulture = units().find(unit => unit[0] === vulture[0]);
  }
  x.openbw_key(1, 0, 224);
  press(56, 37);
  x.openbw_key(0, 0, 224);
  x.openbw_render(0);
  press(56, 37);
  x.openbw_render(0);
  press(56, 37);
  x.openbw_render(0);
  const vultureScreenX = Number(vulture[3]) - Math.max(0, Math.min(Number(vulture[3]) - 640, x.openbw_map_w() * 32 - 1280));
  const vultureScreenY = Number(vulture[4]) - Math.max(0, Math.min(Number(vulture[4]) - 400, x.openbw_map_h() * 32 - 800));
  for (const remaining of [2, 1, 0]) {
    const mineCommand = read(x.openbw_card()).split('\n').map(line => line.split('\t'))
      .find(command => command[1] === 'Spider Mines');
    assert.ok(mineCommand);
    assert.equal(mineCommand[2], '1');
    assert.equal(mineCommand[3], '243');
    x.openbw_out_clear();
    press(mineCommand[0].charCodeAt(0));
    x.openbw_mouse_move(vultureScreenX, vultureScreenY);
    x.openbw_mouse_button(1, 1, vultureScreenX, vultureScreenY, 1);
    x.openbw_mouse_button(0, 1, vultureScreenX, vultureScreenY, 1);
    x.openbw_render(0);
    const mineOrder = records().find(record => record[0] === 21);
    assert.ok(mineOrder);
    assert.equal(mineOrder[9], 132);
    assert.equal(mineOrder[5] | mineOrder[6] << 8, 0, 'Spider Mines must target the ground');
    apply();
    advance(96);
    x.openbw_render(0);
    assert.match(read(x.openbw_card()), new RegExp(`Mines ${remaining}`));
    assert.equal(units().filter(unit => unit[1] === 'Vulture Spider Mine').length, 3 - remaining);
  }
  assert.equal(read(x.openbw_card()).includes('Spider Mines'), false, 'No mine-laying command remains after ammo is exhausted');
  x.openbw_out_clear();
  x.openbw_key(1, 0, 225);
  press(112);
  x.openbw_mouse_button(1, 1, vultureScreenX + 32, vultureScreenY, 1);
  x.openbw_mouse_button(0, 1, vultureScreenX + 32, vultureScreenY, 1);
  x.openbw_key(0, 0, 225);
  x.openbw_render(0);
  assert.equal(records().find(record => record[0] === 21).at(-1), 1, 'Mobile combat Patrol must support queuing');
  x.openbw_out_clear();
  if (groupMines) {
    const armed = groupedVultures.filter(unit => unit[0] !== vulture[0]);
    const selectMines = selection => {
      selection.forEach((unit, index) => x.openbw_debug_select(Number(unit[0]), index ? 1 : 0));
      x.openbw_render(0);
    };
    const mineAmmo = unit => {
      selectMines([unit]);
      return Number(read(x.openbw_card()).match(/\bMines (\d+)/)?.[1]);
    };
    const mineCount = () => units().filter(unit => unit[1] === 'Vulture Spider Mine').length;
    const clickMine = (pos, queued) => {
      const command = read(x.openbw_card()).split('\n').map(line => line.split('\t')).find(row => row[1] === 'Spider Mines');
      assert.ok(command, 'A selected armed Vulture keeps the group mine command available');
      const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
      const screenX = pos[0] - Number(camera[1]), screenY = pos[1] - Number(camera[2]);
      x.openbw_out_clear();
      if (queued) x.openbw_key(1, 0, 225);
      press(command[0].charCodeAt(0));
      x.openbw_mouse_button(1, 1, screenX, screenY, 1); x.openbw_mouse_button(0, 1, screenX, screenY, 1);
      if (queued) x.openbw_key(0, 0, 225);
      x.openbw_render(0);
      const order = records().find(record => record[0] === 21);
      assert.ok(order); assert.equal(order[9], 132); assert.equal(order[10], queued ? 1 : 0);
      return records().find(record => record[0] === 9);
    };
    const mineSite = [Number(armed[0][3]), Number(armed[0][4])];
    const camera = read(x.openbw_debug_dump()).match(/camera=(-?\d+),(-?\d+)/);
    x.openbw_pan(Math.max(0, mineSite[0] - 640) - Number(camera[1]), Math.max(0, mineSite[1] - 400) - Number(camera[2]));
    selectMines([armed[0]]); clickMine(mineSite, false); apply(); advance(160);
    assert.deepEqual(groupedVultures.map(mineAmmo), [0, 2, 3], 'The group has an empty primary and unequal remaining ammunition');
    const group = [vulture, ...armed];
    for (const [index, touch, increment] of [[0, 0, 2], [1, 1, 2], [2, 0, 1]]) {
      x.openbw_set_touch_controls(touch);
      if (index === 1) {
        const move = [21, ...word(mineSite[0] + 96), ...word(mineSite[1] + 160), 0, 0, 228, 0, 6, 0];
        for (const unit of groupedVultures) send(unit, move);
      }
      selectMines(group);
      assert.match(read(x.openbw_card()), /^Vulture\t[^\n]*Mines 0/, 'The exhausted primary stays selected while armed group members can lay mines');
      const before = mineCount();
      const selection = clickMine(mineSite, index === 1);
      assert.equal(selection[1], group.length);
      const selectedIds = Array.from({ length: selection[1] }, (_, i) => selection[2 + i * 2] | selection[3 + i * 2] << 8);
      assert.deepEqual(selectedIds.sort((a, b) => a - b), group.map(unit => Number(unit[0])).sort((a, b) => a - b));
      apply();
      if (index === 1) for (const unit of armed) {
        selectMines([unit]); assert.match(read(x.openbw_debug_dump()), /order=132 /, 'Classic PlaceMine is non-queueable and interrupts Move even when Shift is forwarded');
      }
      advance(320);
      assert.equal(mineCount(), before + increment, 'Each mine command creates one native mine per eligible selected Vulture, not one per group');
      assert.deepEqual(groupedVultures.map(mineAmmo), index === 0 ? [0, 1, 2] : index === 1 ? [0, 0, 1] : [0, 0, 0]);
      selectMines(group);
      assert.equal(read(x.openbw_wires()).trim().split('\n').length, group.length, 'Mine orders preserve the entire visual selection');
    }
    assert.equal(read(x.openbw_card()).includes('Spider Mines'), false, 'The group command disappears only when all selected Vultures are exhausted');
    assert.equal(mineCount(), 9, 'All three Vultures can use all nine original mines');
    console.log('Classic group mine placement, empty-primary fallback, unequal ammunition and native non-queueable Shift behavior passed.');
    return;
  }
  x.openbw_out_clear();
  x.openbw_set_touch_controls(1);
  x.openbw_debug_select(Number(worker[0]), 0);
  assert.equal(read(x.openbw_card()).includes('Patrol'), false);
  x.openbw_set_touch_controls(0);
  x.openbw_mouse_move(-1, -1);
  x.openbw_render(0);

  x.openbw_debug_resources(20000, 20000);
  buildNearBase(112, 'Academy');
  buildNearBase(114, 'Starport');
  const science = buildNearBase(116, 'Science Facility');
  const covertX = (Number(science[3]) + 48) / 32;
  const covertY = (Number(science[4]) - 32) / 32;
  send(science, [12, 36, ...word(covertX), ...word(covertY), ...word(117)]);
  advance(1200);
  assert.ok(units().find(unit => unit[1] === 'Covert Ops'), 'Covert Ops must complete before training a Ghost');
  const siloX = (Number(building[3]) + 64) / 32;
  const siloY = (Number(building[4]) - 16) / 32;
  send(building, [12, 36, ...word(siloX), ...word(siloY), ...word(108)]);
  advance(1200);
  const silo = units().find(unit => unit[1] === 'Nuclear Silo');
  assert.ok(silo, 'Command Center must construct a Nuclear Silo');
  send(barracks, [31, 1, 0]);
  advance(1200);
  const ghost = units().find(unit => unit[1] === 'Ghost');
  assert.ok(ghost, 'Barracks must train a Ghost');
  x.openbw_debug_select(Number(ghost[0]), 0);
  x.openbw_render(0);
  assert.equal(read(x.openbw_card()).includes('Nuclear Strike'), false);

  buildNearBase(109, 'Supply Depot');
  send(silo, [31, 14, 0]);
  advance(2400);
  assert.ok(units().find(unit => unit[1] === 'Nuclear Missile'), 'Silo must complete a nuclear missile');
  x.openbw_debug_select(Number(ghost[0]), 0);
  x.openbw_render(0);
  const strike = read(x.openbw_card()).split('\n').map(line => line.split('\t'))
    .find(command => command[1] === 'Nuclear Strike');
  assert.ok(strike, 'A completed missile must enable Nuclear Strike');
  assert.equal(strike[2], '1');
  assert.equal(strike[3], '311');
  const icon = x.openbw_command_icon(Number(strike[3]));
  assert.ok(icon);
  assert.equal(x.openbw_icon_w(), 36);
  assert.equal(x.openbw_icon_h(), 34);
  const pixels = new Uint8Array(memory.buffer, icon, 36 * 34 * 4);
  assert.ok(pixels.some((value, index) => index % 4 === 3 ? value > 0 : false), 'Nuclear Strike icon must not be blank');
  const beforeRender = x.openbw_frame();
  for (let frame = 0; frame < 8; frame++) {
    x.openbw_step();
    x.openbw_render(frame);
  }
  assert.equal(x.openbw_frame(), beforeRender + 8);
  x.openbw_out_clear();
  press(110, 17);
  x.openbw_render(0);
  assert.equal(x.openbw_cursor(), 1, 'Nuclear Strike must enter targeting mode');
  press(0, 41);
  x.openbw_render(0);
  assert.equal(x.openbw_cursor(), 0);
  assert.equal(records().length, 0);
  x.openbw_debug_select(Number(worker[0]), 0);
  x.openbw_debug_select(Number(ghost[0]), 0);
  x.openbw_render(0);
  assert.match(read(x.openbw_card()), /Nuclear Strike/);

  x.openbw_set_touch_controls(1);
  x.openbw_debug_select(Number(worker[0]), 1);
  for (const queued of [false, true]) {
    x.openbw_out_clear();
    x.openbw_key(queued ? 1 : 0, 0, 225);
    press(97);
    x.openbw_render(0);
    let point;
    for (const [screenX, screenY] of [[1000, 200], [1000, 400], [800, 200], [400, 200]]) {
      x.openbw_mouse_move(screenX, screenY);
      x.openbw_render(0);
      if (x.openbw_cursor() === 1) { point = [screenX, screenY]; break; }
    }
    assert.ok(point, 'Empty ground for grouped Attack');
    assert.equal(x.openbw_touch_button(...point), 1, 'Armed Attack must not become a contextual touch order');
    x.openbw_mouse_button(1, 1, ...point, 1);
    x.openbw_mouse_button(0, 1, ...point, 1);
    x.openbw_render(0);
    assert.equal(records().find(record => record[0] === 9)?.[1], 2, 'Attack retains the selected unit group');
    const attack = records().find(record => record[0] === 21);
    assert.equal(attack?.[9], 14, 'Grouped mobile Attack emits AttackMove rather than Move');
    assert.equal(attack[10], Number(queued), 'Grouped Attack preserves ordinary versus queued ordering');
    x.openbw_key(0, 0, 225);
    x.openbw_render(0);
  }
  x.openbw_debug_select(Number(ghost[0]), 0);
  x.openbw_out_clear();
  const combatCommands = read(x.openbw_card()).split('\n').slice(1).map(line => line.split('\t')[1]);
  assert.ok(combatCommands.includes('Hold'));
  assert.equal(combatCommands.includes('Patrol'), true);
  x.openbw_debug_select(Number(worker[0]), 0);
  send(worker, [21, ...word(Number(worker[3]) + 64), ...word(Number(worker[4])), 0, 0, 228, 0, 6, 0]);
  x.openbw_render(0);
  assert.equal(read(x.openbw_card()).split('\n').map(line => line.split('\t'))
    .find(command => command[1] === 'Stop')[2], '1');
  press(98);
  x.openbw_render(0);
  const unlocked = read(x.openbw_card()).split('\n').slice(1).map(line => line.split('\t'));
  assert.ok(unlocked.find(command => command[1] === 'Factory'));
  assert.ok(unlocked.find(command => command[1] === 'Science Facility'));
  assert.ok(unlocked.every(command => command[2] === '1'));
  press(0, 41);
  x.openbw_render(0);

  x.openbw_debug_select(Number(building[0]), 0);
  x.openbw_key(1, 0, 224);
  press(57, 38);
  x.openbw_key(0, 0, 224);
  x.openbw_render(0);
  press(57, 38);
  x.openbw_render(0);
  press(57, 38);
  x.openbw_render(0);
  x.openbw_debug_set_life(Number(building[0]), 1000, -1);
  x.openbw_debug_select(Number(worker[0]), 0);
  const buildingScreenX = Number(building[3]) - Math.max(0, Math.min(Number(building[3]) - 640, x.openbw_map_w() * 32 - 1280));
  const buildingScreenY = Number(building[4]) - Math.max(0, Math.min(Number(building[4]) - 400, x.openbw_map_h() * 32 - 800));
  x.openbw_debug_select(Number(ghost[0]), 0);
  assert.equal(x.openbw_touch_button(buildingScreenX, buildingScreenY), 1, 'Without an SCV, a friendly damaged building remains selectable');
  x.openbw_debug_select(Number(worker[0]), 1);
  assert.equal(x.openbw_touch_button(buildingScreenX, buildingScreenY), 3, 'A mixed group containing an SCV retains repair-first tapping');
  x.openbw_debug_select(Number(worker[0]), 0);
  assert.equal(x.openbw_touch_button(buildingScreenX, buildingScreenY), 3, 'SCV tap must repair a damaged friendly mechanical target before selecting it');
  x.openbw_out_clear();
  const repairButton = x.openbw_touch_button(buildingScreenX, buildingScreenY);
  x.openbw_mouse_button(1, repairButton, buildingScreenX, buildingScreenY, 1);
  x.openbw_mouse_button(0, repairButton, buildingScreenX, buildingScreenY, 1);
  x.openbw_render(0);
  assert.equal(records().find(record => record[0] === 21)?.[9], 34, 'A plain SCV tap must emit the native Repair order');
  const targetBuilding = (symbol, shift = false) => {
    x.openbw_out_clear();
    x.openbw_key(shift ? 1 : 0, 0, 225);
    press(symbol);
    x.openbw_mouse_move(buildingScreenX, buildingScreenY);
    x.openbw_mouse_button(1, 1, buildingScreenX, buildingScreenY, 1);
    x.openbw_mouse_button(0, 1, buildingScreenX, buildingScreenY, 1);
    x.openbw_render(0);
    x.openbw_key(0, 0, 225);
    x.openbw_render(0);
    const order = records().find(record => record[0] === 21);
    assert.ok(order);
    assert.equal(order[5] | order[6] << 8, Number(building[0]));
    return order;
  };
  const repair = targetBuilding(109, true);
  assert.equal(repair[9], 34, 'Mobile Move must repair a damaged friendly mechanical building');
  assert.equal(repair[10], 1, 'Smart repair must preserve queueing');
  assert.equal(targetBuilding(97)[9], 8, 'Explicit Attack must not become Repair');
  x.openbw_out_clear();
  x.openbw_mouse_button(1, 3, buildingScreenX, buildingScreenY, 1);
  x.openbw_mouse_button(0, 3, buildingScreenX, buildingScreenY, 1);
  x.openbw_render(0);
  assert.equal(records().find(record => record[0] === 21)[9], 34, 'Default mobile orders must retain smart repair without a Move button');
  x.openbw_debug_set_life(Number(building[0]), 1500, -1);
  assert.equal(x.openbw_touch_button(buildingScreenX, buildingScreenY), 1, 'Healthy friendly targets remain selectable with an SCV selected');
  x.openbw_out_clear();
  press(109);
  x.openbw_mouse_button(1, 1, buildingScreenX, buildingScreenY, 1);
  x.openbw_mouse_button(0, 1, buildingScreenX, buildingScreenY, 1);
  x.openbw_render(0);
  const contextual = records().find(record => record[0] === 20);
  assert.ok(contextual, 'Healthy targets must use the normal contextual-order path');
  assert.equal(contextual[5] | contextual[6] << 8, Number(building[0]));
  x.openbw_debug_set_life(Number(building[0]), 1000, -1);
  x.openbw_set_touch_controls(0);
  assert.notEqual(targetBuilding(109)[9], 34, 'Desktop Move must not become smart repair');
  assert.match(read(x.openbw_card()), /Patrol/);
  assert.match(read(x.openbw_card()), /Advanced/);

  x.openbw_set_touch_controls(1);
  x.openbw_debug_resources(10000, 10000);
  x.openbw_out_clear();
  const commandRows = () => read(x.openbw_card()).split('\n').slice(1).map(line => line.split('\t'));
  const chooseDepot = () => {
    press(98);
    x.openbw_render(0);
    assert.equal(commandRows().filter(command => command[1] === 'Cancel').length, 1);
    const depot = commandRows().find(command => command[1] === 'Supply Depot');
    assert.ok(depot);
    press(depot[0].charCodeAt(0));
    x.openbw_render(0);
    assert.equal(x.openbw_cursor(), 2);
    assert.equal(read(x.openbw_card()).split('\n')[0].split('\t')[1], '', 'Placement must not label worker HP as building HP');
    assert.deepEqual(commandRows().map(command => command[1]), ['Confirm', 'Cancel']);
    assert.equal(commandRows()[0][2], '0');
  };
  chooseDepot();
  press(99);
  x.openbw_render(0);
  assert.equal(records().length, 0, 'Confirm must not build before choosing a location');
  x.openbw_preview_placement(0, 0);
  x.openbw_mouse_move(-1, -1);
  x.openbw_render(0);
  assert.equal(x.openbw_edge(), 0, 'Placement preview must not edge-scroll');
  assert.equal(records().length, 0, 'Preview must not build');
  press(0, 41);
  x.openbw_render(0);
  assert.notEqual(x.openbw_cursor(), 2);
  assert.equal(records().length, 0, 'Cancel must not build');
  chooseDepot();
  let validPreview = false;
  let previewScreenX = 0, previewScreenY = 0;
  for (let screenY = 48; screenY < 720 && !validPreview; screenY += 32) {
    for (let screenX = 48; screenX < 1200; screenX += 32) {
      x.openbw_preview_placement(screenX, screenY);
      if (commandRows()[0][2] === '1') {
        validPreview = true;
        previewScreenX = screenX;
        previewScreenY = screenY;
        break;
      }
    }
  }
  assert.ok(validPreview, 'Test map must contain a valid Supply Depot location');
  x.openbw_mouse_move(-1, -1);
  x.openbw_render(0);
  assert.equal(commandRows()[0][2], '1', 'A parked cursor must not lose the saved preview');
  assert.equal(records().length, 0);
  x.openbw_pan(32, 32);
  x.openbw_render(0);
  press(99);
  x.openbw_render(0);
  const placed = records().find(record => record[0] === 12);
  assert.ok(placed, 'Confirm must issue the build command');
  assert.deepEqual(placed.slice(6, 8), [109, 0]);
  const expectedTileX = Math.floor((previewScreenX + Number(building[3]) - buildingScreenX - 48 + 16) / 32);
  const expectedTileY = Math.floor((previewScreenY + Number(building[4]) - buildingScreenY - 32 + 16) / 32);
  assert.equal(placed[2] | placed[3] << 8, expectedTileX, 'Camera movement must not change the preview map tile');
  assert.equal(placed[4] | placed[5] << 8, expectedTileY);
  assert.notEqual(x.openbw_cursor(), 2);
  x.openbw_out_clear();
  x.openbw_pan(-32, -32);
  x.openbw_render(0);

  x.openbw_set_touch_controls(0);
  press(98);
  x.openbw_render(0);
  const desktopDepot = commandRows().find(command => command[1] === 'Supply Depot');
  assert.ok(desktopDepot);
  press(desktopDepot[0].charCodeAt(0));
  x.openbw_mouse_move(previewScreenX, previewScreenY);
  x.openbw_render(0);
  assert.equal(x.openbw_cursor(), 2, 'Mouse hover keeps the desktop placement command active');
  assert.ok(!commandRows().some(command => command[1] === 'Confirm'), 'Desktop placement must not require mobile confirmation');
  assert.equal(records().length, 0, 'Mouse hover previews without placing');
  x.openbw_mouse_button(1, 1, previewScreenX, previewScreenY, 1);
  x.openbw_mouse_button(0, 1, previewScreenX, previewScreenY, 1);
  x.openbw_render(0);
  assert.ok(records().some(record => record[0] === 12), 'One desktop click must issue the building command');
  assert.notEqual(x.openbw_cursor(), 2, 'One desktop click finishes placement without Confirm');
  x.openbw_out_clear();
  x.openbw_set_touch_controls(1);

  x.openbw_debug_select(Number(building[0]), 0);
  const clickSelected = (screenX, screenY, clicks = 1) => {
    x.openbw_mouse_button(1, 1, screenX, screenY, clicks);
    x.openbw_mouse_button(0, 1, screenX, screenY, clicks);
    x.openbw_render(0);
  };
  clickSelected(buildingScreenX, buildingScreenY);
  assert.equal(read(x.openbw_card()), '', 'Clicking a selected building must deselect it');
  clickSelected(buildingScreenX, buildingScreenY);
  assert.match(read(x.openbw_card()), /^Command Center/);
  clickSelected(buildingScreenX, buildingScreenY);
  assert.equal(read(x.openbw_card()), '');
  x.openbw_set_touch_controls(0);
  x.openbw_debug_select(Number(building[0]), 0);
  clickSelected(buildingScreenX, buildingScreenY);
  assert.equal(read(x.openbw_card()), '', 'Desktop single click must also deselect');
  const currentWorker = units().find(unit => Number(unit[0]) === Number(worker[0]));
  const workerScreenX = Number(currentWorker[3]) - Number(building[3]) + buildingScreenX;
  const workerScreenY = Number(currentWorker[4]) - Number(building[4]) + buildingScreenY;
  x.openbw_debug_select(Number(worker[0]), 0);
  clickSelected(workerScreenX, workerScreenY);
  assert.equal(read(x.openbw_card()), '', 'Clicking a selected mobile unit must deselect it');
  x.openbw_set_touch_controls(1);
  x.openbw_debug_select(Number(worker[0]), 0);
  clickSelected(workerScreenX, workerScreenY, 2);
  const visibleWorkers = units().filter(unit => unit[1] === 'SCV' && unit[2] === worker[2])
    .filter(unit => Number(unit[3]) >= Number(building[3]) - buildingScreenX
      && Number(unit[3]) < Number(building[3]) - buildingScreenX + 1280
      && Number(unit[4]) >= Number(building[4]) - buildingScreenY
      && Number(unit[4]) < Number(building[4]) - buildingScreenY + 800);
  const doubleTapSelection = read(x.openbw_wires()).trim().split('\n').filter(Boolean);
  assert.equal(doubleTapSelection.length, visibleWorkers.length, 'Double-tap must select matching units only within the view');
  assert.ok(doubleTapSelection.some(line => Number(line.split('\t')[0]) === Number(worker[0])));
  x.openbw_debug_select(Number(worker[0]), 0);
  clickSelected(workerScreenX, workerScreenY);
  assert.equal(read(x.openbw_card()), '', 'An ordinary later tap must still deselect');
  x.openbw_debug_select(Number(ghost[0]), 0);
  x.openbw_key(1, 0, 224);
  press(55, 36);
  x.openbw_key(0, 0, 224);
  x.openbw_render(0);
  press(55, 36);
  x.openbw_render(0);
  press(55, 36);
  x.openbw_render(0);
  const ghostPosition = units().find(unit => Number(unit[0]) === Number(ghost[0]));
  const ghostMapLeft = Math.max(0, Math.min(Number(ghostPosition[3]) - 640, x.openbw_map_w() * 32 - 1280));
  const ghostMapTop = Math.max(0, Math.min(Number(ghostPosition[4]) - 400, x.openbw_map_h() * 32 - 800));
  const strikeGroundX = Number(ghostPosition[3]) + (Number(ghostPosition[3]) < 1024 ? 320 : -320);
  const strikeGroundY = Number(ghostPosition[4]) + (Number(ghostPosition[4]) < 1024 ? 160 : -160);
  for (const mobile of [false, true]) {
    x.openbw_set_touch_controls(mobile ? 1 : 0);
    for (const [mapX, mapY] of [[Number(building[3]), Number(building[4])], [strikeGroundX, strikeGroundY]]) {
      x.openbw_debug_select(Number(ghost[0]), 0);
      x.openbw_out_clear();
      press(110, 17);
      x.openbw_render(0);
      assert.ok([1, 4].includes(x.openbw_cursor()));
      x.openbw_mouse_move(mapX - ghostMapLeft, mapY - ghostMapTop);
      x.openbw_mouse_button(1, 1, mapX - ghostMapLeft, mapY - ghostMapTop, 1);
      x.openbw_mouse_button(0, 1, mapX - ghostMapLeft, mapY - ghostMapTop, 1);
      x.openbw_render(0);
      const nuclearOrder = records().find(record => record[0] === 21);
      assert.ok(nuclearOrder, 'A Nuclear Strike target click must issue an order');
      assert.equal(nuclearOrder[9], 126, 'Ghost must receive NukePaint, not the internal CastNuclearStrike order');
      assert.equal(nuclearOrder[5] | nuclearOrder[6] << 8, 0, 'Nuclear Strike targets the clicked position, including over buildings');
      assert.equal(nuclearOrder[1] | nuclearOrder[2] << 8, mapX);
      assert.equal(nuclearOrder[3] | nuclearOrder[4] << 8, mapY);
      assert.equal(Number(read(x.openbw_wires()).split('\t')[0]), Number(ghost[0]), 'Targeting a building must not select it');
      apply();
      assert.match(read(x.openbw_debug_dump()), /order=126 /, 'Engine must accept the Ghost nuclear-paint order');
    }
  }
  let nuclearLaunchSeen = false;
  let ghostMovedForStrike = false;
  for (let frame = 0; frame < 900 && !nuclearLaunchSeen; frame++) {
    x.openbw_step();
    const currentUnits = units();
    const currentGhost = currentUnits.find(unit => Number(unit[0]) === Number(ghost[0]));
    if (Number(currentGhost[3]) !== Number(ghostPosition[3]) || Number(currentGhost[4]) !== Number(ghostPosition[4]))
      ghostMovedForStrike = true;
    nuclearLaunchSeen = currentUnits.some(unit => unit[1] === 'Nuclear Missile' && unit[5] === '125');
  }
  assert.ok(ghostMovedForStrike, 'Ghost must approach an out-of-range strike location');
  assert.ok(nuclearLaunchSeen, 'A ready missile must launch after the Ghost paints the target');
  console.log('Command checks passed: actual nuclear targeting/launch, placement, selection, smart orders, queues, tank modes and Vulture mines.');
}

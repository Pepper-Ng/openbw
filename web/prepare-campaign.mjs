import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WASI } from 'node:wasi';

const root = fileURLToPath(new URL('../', import.meta.url));
const missions = {
  terran01: { title: 'Wasteland', order: 1, scenarioHash: '4b0e5009c4ae80cfb4cb13ede30842db0aa05bb3be2eedad695fb093fa5786f6', units: 49, triggers: 9, sounds: 8 },
  terran02: { title: 'Backwater Station', order: 2, scenarioHash: 'd8a7f6b70422ff32e4fd3f6293de4013f883e0761814d4496ffd18b7eb13dfce', units: 98, triggers: 15, sounds: 21 },
  terran03: { title: 'Desperate Alliance', order: 3, scenarioHash: '9d83a8bde18c38ee12f54f4c5253bed5466027fc612141e9a7415c94d3346737', units: 199, triggers: 10, sounds: 16 },
  terran04: { title: 'The Jacobs Installation', order: 4, scenarioHash: 'a48e1d1682f0a6e68eeec4ef0fc82efc48e70a11b4315de8c091079c68e10601', units: 100, triggers: 36, sounds: 17 },
  terran05: { title: 'Revolution', order: 5, scenarioHash: '35cd98bc0590c0f36e5d8f75e41a29b254db2d6cf8dec5480e6ffd7602609829', units: 172, triggers: 17, sounds: 17 },
  terran06: { title: 'Norad II', order: 6, scenarioHash: '80dd42e4d4540d0340113b92aae02120b9919a5dac359b010607ec7c26e72ead', units: 221, triggers: 20, sounds: 24 },
  terran07: { title: 'The Trump Card', order: 7, source: 'terran08', scenarioHash: 'dab280d946f059845ba3084da11f159091bfbc24c4cd54eb2a352ff1a165f515', units: 213, triggers: 10, sounds: 16 },
  terran08: { title: 'The Big Push', order: 8, source: 'terran09', scenarioHash: '083be62ec869ddf049f816eaf873355c57381b869581717234f3499b39ab23c7', units: 281, triggers: 13, sounds: 15 },
  terran09: { title: 'New Gettysburg', order: 9, source: 'terran11', scenarioHash: '1b55e907af8c4c5c6c5e0adcc775b8fe82e263d7afb9eba70ded40d11d5e412c', units: 255, triggers: 11, sounds: 22 },
  terran10: { title: 'The Hammer Falls', order: 10, source: 'terran12', scenarioHash: '2a3efca711b5a75ffd0ea569802fe0bd4dbfcfbfa0b0f308d897c0dca698fd7d', units: 331, triggers: 7, sounds: 14 },
};
export const campaignMissions = Object.freeze(Object.keys(missions));
export const campaignSource = Object.freeze({
  file: 'StarCraft.mpq',
  bytes: 601389682,
  sha256: 'ba155a30ca11a57a2ea917cb4f25715f79bee7397ebb16db4816e7725395e58d',
  url: 'https://archive.org/download/sc-classic-installer_202311/StarCraft%20Portable.zip/Starcraft%20Brood%20War%2FStarCraft.mpq',
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function auditAiScript(bytes, scriptIds = ['Ter3', 'Suic']) {
  assert.ok(bytes.length >= 8 && bytes.length <= 1048576, 'Invalid AI binary size');
  const table = bytes.readUInt32LE(0);
  assert.ok(table >= 4 && table <= bytes.length - 4, 'Invalid AI header offset');
  const entries = new Map();
  let cursor = table;
  while (true) {
    assert.ok(cursor <= bytes.length - 4, 'Unterminated AI header table');
    if (bytes.readUInt32LE(cursor) === 0) break;
    assert.ok(cursor <= bytes.length - 16, 'Truncated AI header');
    const id = bytes.toString('ascii', cursor, cursor + 4);
    assert.ok(!entries.has(id), 'Duplicate AI script ID');
    entries.set(id, { id, offset: bytes.readUInt32LE(cursor + 4), flags: bytes.readUInt32LE(cursor + 12) });
    assert.ok(entries.size <= 4096, 'Too many AI scripts');
    cursor += 16;
  }
  const commands = {
    0: ['goto', 'w'], 1: ['notowns_jump', 'ww'], 2: ['wait', 'w'], 3: ['start_town', ''],
    4: ['start_areatown', ''], 5: ['expand', 'bw'],
    6: ['build', 'bwb'], 7: ['upgrade', 'bwb'], 8: ['tech', 'wb'],
    9: ['wait_build', 'bw'], 10: ['wait_buildstart', 'bw'], 11: ['attack_clear', ''],
    12: ['attack_add', 'bw'], 13: ['attack_prepare', ''], 14: ['attack_do', ''], 15: ['wait_secure', ''],
    16: ['capt_expand', ''], 17: ['build_bunkers', ''], 18: ['wait_bunkers', ''],
    19: ['defensebuild_gg', 'bw'], 20: ['defensebuild_ag', 'bw'], 21: ['defensebuild_ga', 'bw'], 22: ['defensebuild_aa', 'bw'],
    23: ['defenseuse_gg', 'bw'], 24: ['defenseuse_ag', 'bw'], 25: ['defenseuse_ga', 'bw'], 26: ['defenseuse_aa', 'bw'],
    27: ['defenseclear_gg', ''], 28: ['defenseclear_ag', ''], 29: ['defenseclear_ga', ''], 30: ['defenseclear_aa', ''],
    31: ['send_suicide', 'b'], 32: ['player_enemy', ''], 33: ['player_ally', ''],
    34: ['default_min', 'b'], 35: ['defaultbuild_off', ''], 36: ['stop', ''], 37: ['switch_rescue', ''],
    38: ['move_dt', ''], 39: ['debug', 'ws'], 40: ['fatal_error', ''], 41: ['enter_bunker', ''], 42: ['value_area', ''],
    43: ['transports_off', ''], 44: ['check_transports', ''], 45: ['nuke_rate', 'b'], 46: ['max_force', 'w'],
    47: ['clear_combatdata', ''], 48: ['random_jump', 'bw'], 49: ['time_jump', 'bw'],
    50: ['farms_notiming', ''], 51: ['farms_timing', ''], 52: ['build_turrets', ''], 53: ['wait_turrets', ''],
    54: ['default_build', ''], 55: ['harass_factor', 'w'], 56: ['start_campaign', ''], 57: ['race_jump', 'www'],
    58: ['region_size', 'bw'], 59: ['get_oldpeons', 'b'], 60: ['groundmap_jump', 'w'], 61: ['place_guard', 'wb'],
    62: ['wait_force', 'bw'], 63: ['guard_resources', 'w'], 64: ['call', 'w'], 65: ['return', ''],
    66: ['eval_harass', 'w'], 67: ['creep', 'b'], 68: ['panic', 'w'], 69: ['player_need', 'bw'],
    70: ['do_morph', 'bw'], 71: ['wait_upgrades', ''], 72: ['multirun', 'w'], 73: ['rush', 'bw'], 74: ['scout_with', 'w'],
    75: ['define_max', 'bw'], 76: ['train', 'bw'], 77: ['target_expansion', ''], 78: ['wait_train', 'bw'],
    79: ['set_attacks', 'b'], 80: ['set_gencmd', ''], 81: ['make_patrol', ''], 82: ['give_money', ''],
    83: ['prep_down', 'bbw'], 84: ['resources_jump', 'www'], 85: ['enter_transport', ''], 86: ['exit_transport', ''],
    87: ['sharedvision_on', 'b'], 88: ['sharedvision_off', 'b'], 89: ['nuke_location', ''], 90: ['harass_location', ''],
    91: ['implode', ''], 92: ['guard_all', ''], 93: ['enemyowns_jump', 'ww'], 94: ['enemyresources_jump', 'www'],
    95: ['if_dif', 'bbw'], 96: ['easy_attack', 'bw'], 97: ['kill_thread', ''], 98: ['killable', ''],
    99: ['wait_finishattack', ''], 100: ['quick_attack', ''], 101: ['junkyard_dog', ''], 102: ['fake_nuke', ''],
    103: ['disruption_web', ''], 104: ['recall_location', ''], 105: ['set_randomseed', 'd'], 106: ['if_owned', 'ww'],
    107: ['create_nuke', ''], 108: ['create_unit', 'www'], 109: ['nuke_pos', 'ww'], 110: ['help_iftrouble', ''],
    111: ['allies_watch', 'bw'], 112: ['try_townpoint', 'bw'],
  };
  const scripts = scriptIds.map(id => {
    const entry = entries.get(id);
    assert.ok(entry, `Missing AI script ${id}`);
    const pending = [entry.offset];
    const instructions = new Map();
    const occupied = new Map();
    while (pending.length) {
      const offset = pending.pop();
      if (instructions.has(offset)) continue;
      assert.ok(offset >= 4 && offset < table, `AI ${id} address out of bounds: ${offset}`);
      assert.ok(!occupied.has(offset), `Overlapping AI instructions at ${offset}`);
      const opcode = bytes[offset];
      const command = commands[opcode];
      assert.ok(command, `Unknown AI opcode ${opcode} at ${offset} in ${id}`);
      const [name, types] = command;
      let next = offset + 1;
      const operands = [...types].map(type => {
        if (type === 's') {
          const end = bytes.indexOf(0, next);
          assert.ok(end >= next && end < table, `Unterminated AI string at ${offset}`);
          const value = bytes.toString('latin1', next, end);
          next = end + 1;
          return value;
        }
        const width = type === 'b' ? 1 : type === 'd' ? 4 : 2;
        assert.ok(next + width <= table, `Truncated AI operand at ${offset}`);
        const value = bytes.readUIntLE(next, width);
        next += width;
        return value;
      });
      for (let position = offset; position < next; position++) {
        assert.ok(!occupied.has(position), `Overlapping AI instructions at ${offset}`);
        occupied.set(position, offset);
      }
      instructions.set(offset, { offset, opcode, name, operands });
      assert.ok(instructions.size <= 4096, 'AI instruction limit exceeded');
      if ([0, 39, 64, 72].includes(opcode)) pending.push(operands[0]);
      if ([1, 5, 48, 49, 58, 60, 66, 68, 73, 84, 93, 94, 95, 106, 111, 112].includes(opcode)) pending.push(operands.at(-1));
      if (opcode === 57) pending.push(...operands);
      if (![0, 36, 39, 40, 57, 65, 97].includes(opcode)) pending.push(next);
    }
    return { ...entry, instructions: [...instructions.values()].sort((left, right) => left.offset - right.offset) };
  });
  return { bytes: bytes.length, sha256: sha256(bytes), tableOffset: table, entryCount: entries.size, scripts };
}

export function normalizeMissionPath(value) {
  assert.ok(value.length > 0 && value.length <= 240, 'Invalid mission path length');
  assert.ok(!/[\x00-\x1f\x7f-\uffff:"*?<>|]/.test(value), 'Invalid mission path character');
  const path = value.replaceAll('\\', '/').toLowerCase();
  for (const part of path.split('/')) {
    assert.ok(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'Invalid mission path component');
  }
  return path;
}

export function scenarioSections(bytes) {
  const sections = new Map();
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(bytes.length - offset >= 8, 'Truncated CHK section header');
    const name = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    offset += 8;
    assert.ok(length <= bytes.length - offset, `Truncated CHK ${name} section`);
    if (name === 'UNIT') assert.equal(length % 36, 0, 'Invalid UNIT record length');
    if (name === 'TRIG' || name === 'MBRF') assert.equal(length % 2400, 0, `Invalid ${name} record length`);
    const section = bytes.subarray(offset, offset + length);
    const append = name === 'UNIT' || name === 'TRIG' || name === 'MBRF';
    const previous = sections.get(name);
    sections.set(name, append && previous ? Buffer.concat([previous, section]) : section);
    offset += length;
  }
  return sections;
}

export function scenarioStrings(bytes) {
  assert.ok(bytes && bytes.length >= 2, 'Missing STR section');
  const count = bytes.readUInt16LE(0);
  assert.ok(count <= (bytes.length - 2) / 2, 'Truncated string table');
  const strings = [''];
  for (let index = 0; index < count; index++) {
    const offset = bytes.readUInt16LE(2 + index * 2);
    assert.ok(offset < bytes.length, 'String offset out of bounds');
    const end = bytes.indexOf(0, offset);
    assert.ok(end >= offset, 'Unterminated CHK string');
    strings.push(bytes.toString('latin1', offset, end));
  }
  return strings;
}

export function triggerProfile(bytes, strings, briefing = false) {
  assert.equal(bytes.length % 2400, 0, 'Invalid trigger records');
  const conditions = new Set();
  const actions = new Set();
  const waves = new Set();
  const records = [];
  const stringAt = index => {
    assert.ok(index < strings.length, 'Trigger string index out of bounds');
    return strings[index];
  };
  for (let offset = 0; offset < bytes.length; offset += 2400) {
    const record = bytes.subarray(offset, offset + 2400);
    const owners = Array.from(record.subarray(2372, 2399)).flatMap((enabled, index) => enabled ? [index] : []);
    const detail = { owners, flags: record.readUInt32LE(2368), conditions: [], actions: [] };
    if (!briefing) {
      for (let index = 0; index < 16; index++) {
        const condition = record.subarray(index * 20, index * 20 + 20);
        const type = condition[15];
        if (!type) break;
        if (condition[17] & 2) continue;
        conditions.add(type);
        detail.conditions.push({ type, location: condition.readUInt32LE(0), player: condition.readUInt32LE(4), amount: condition.readUInt32LE(8), unit: condition.readUInt16LE(12), comparison: condition[14], resource: condition[16] });
      }
    }
    for (let index = 0; index < 64; index++) {
      const action = record.subarray(320 + index * 32, 352 + index * 32);
      const type = action[26];
      if (!type) break;
      if (action[28] & 2) continue;
      actions.add(type);
      const text = action.readUInt32LE(4);
      const wave = action.readUInt32LE(8);
      if (text) stringAt(text);
      if (wave) waves.add(normalizeMissionPath(stringAt(wave)));
      detail.actions.push({ type, location: action.readUInt32LE(0), text, wave, time: action.readUInt32LE(12), player: action.readUInt32LE(16), amount: action.readUInt32LE(20), unit: action.readUInt16LE(24), modifier: action[27], flags: action[28] });
    }
    records.push(detail);
  }
  return { conditions: [...conditions].sort((left, right) => left - right), actions: [...actions].sort((left, right) => left - right), waves: [...waves].sort(), records };
}

export function auditScenario(bytes) {
  const sections = scenarioSections(bytes);
  assert.equal(sections.get('VER ')?.readUInt16LE(0), 59, 'Unsupported CHK version');
  assert.equal(sections.get('OWNR')?.length, 12, 'Invalid OWNR section');
  assert.equal(sections.get('SIDE')?.length, 12, 'Invalid SIDE section');
  const strings = scenarioStrings(sections.get('STR '));
  const gameplay = triggerProfile(sections.get('TRIG') ?? Buffer.alloc(0), strings);
  const briefing = triggerProfile(sections.get('MBRF') ?? Buffer.alloc(0), strings, true);
  const waveSection = sections.get('WAV ') ?? Buffer.alloc(0);
  assert.equal(waveSection.length % 4, 0, 'Invalid WAV section');
  const wavePaths = new Set([...gameplay.waves, ...briefing.waves]);
  for (let offset = 0; offset < waveSection.length; offset += 4) {
    const index = waveSection.readUInt32LE(offset);
    if (!index) continue;
    assert.ok(index < strings.length, 'WAV string index out of bounds');
    wavePaths.add(normalizeMissionPath(strings[index]));
  }
  const units = [];
  const unitSection = sections.get('UNIT') ?? Buffer.alloc(0);
  for (let offset = 0; offset < unitSection.length; offset += 36) {
    units.push({ type: unitSection.readUInt16LE(offset + 8), owner: unitSection[offset + 16], x: unitSection.readUInt16LE(offset + 4), y: unitSection.readUInt16LE(offset + 6) });
  }
  return { sha256: sha256(bytes), controllers: [...sections.get('OWNR')], races: [...sections.get('SIDE')], units, gameplay, briefing, wavePaths: [...wavePaths].sort() };
}

function cryptTable() {
  const table = new Uint32Array(1280);
  let seed = 0x100001;
  for (let index = 0; index < 256; index++) {
    for (let bank = 0; bank < 5; bank++) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const high = (seed & 0xffff) << 16;
      seed = (seed * 125 + 3) % 0x2aaaab;
      table[index + bank * 256] = high | (seed & 0xffff);
    }
  }
  return table;
}

export function readPlainMissionPack(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x1a51504d, 'Invalid MPQ signature');
  assert.equal(bytes.readUInt32LE(4), 32, 'Invalid MPQ header size');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'Invalid MPQ archive length');
  assert.equal(bytes.readUInt16LE(12), 0, 'Unsupported MPQ version');
  const crypt = cryptTable();
  const hash = (path, bank) => {
    let value = 0x7fed7fed;
    let seed = 0xeeeeeeee;
    for (const character of Buffer.from(path.replaceAll('/', '\\').toUpperCase(), 'ascii')) {
      value = (crypt[bank * 256 + character] ^ ((value + seed) >>> 0)) >>> 0;
      seed = (character + value + Math.imul(seed, 33) + 3) >>> 0;
    }
    return value;
  };
  const decrypt = (offset, count, name) => {
    assert.ok(offset >= 32 && count > 0 && count <= 65536 && offset + count * 16 <= bytes.length, 'Invalid MPQ table bounds');
    const words = new Uint32Array(count * 4);
    let key = hash(name, 3);
    let seed = 0xeeeeeeee;
    for (let index = 0; index < words.length; index++) {
      seed = (seed + crypt[1024 + (key & 255)]) >>> 0;
      const value = (bytes.readUInt32LE(offset + index * 4) ^ ((key + seed) >>> 0)) >>> 0;
      words[index] = value;
      seed = (Math.imul(seed, 33) + value + 3) >>> 0;
      key = (((~key << 21) + 0x11111111) | (key >>> 11)) >>> 0;
    }
    return words;
  };
  const hashCount = bytes.readUInt32LE(24);
  const blockCount = bytes.readUInt32LE(28);
  assert.equal(hashCount & (hashCount - 1), 0, 'Invalid MPQ hash count');
  const hashes = decrypt(bytes.readUInt32LE(16), hashCount, '(hash table)');
  const blocks = decrypt(bytes.readUInt32LE(20), blockCount, '(block table)');
  return path => {
    path = normalizeMissionPath(path);
    const first = hash(path, 1);
    const second = hash(path, 2);
    for (let attempt = 0, slot = hash(path, 0) % hashCount; attempt < hashCount; attempt++, slot = (slot + 1) % hashCount) {
      const blockIndex = hashes[slot * 4 + 3];
      if (blockIndex === 0xffffffff) break;
      if (hashes[slot * 4] !== first || hashes[slot * 4 + 1] !== second) continue;
      assert.ok(blockIndex < blockCount, 'Invalid MPQ block index');
      const [offset, storedSize, size, flags] = blocks.subarray(blockIndex * 4, blockIndex * 4 + 4);
      assert.equal(flags, 0x80000000, 'Expected plain unencrypted MPQ entry');
      assert.equal(storedSize, size, 'Invalid plain MPQ entry size');
      assert.ok(offset >= 32 && offset + size <= bytes.readUInt32LE(16), 'Invalid MPQ entry bounds');
      return bytes.subarray(offset, offset + size);
    }
    throw new Error(`Missing mission dependency: ${path}`);
  };
}

export function waveMetadata(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'Invalid RIFF header');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', 'Invalid WAVE header');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, 'Invalid RIFF length');
  let format;
  let dataSize;
  for (let offset = 12; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length, 'Truncated RIFF chunk');
    const name = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8;
    assert.ok(offset + size <= bytes.length, 'Truncated RIFF data');
    if (name === 'fmt ') {
      assert.ok(size >= 16, 'Truncated PCM format');
      format = { encoding: bytes.readUInt16LE(offset), channels: bytes.readUInt16LE(offset + 2), sampleRate: bytes.readUInt32LE(offset + 4), byteRate: bytes.readUInt32LE(offset + 8), blockAlign: bytes.readUInt16LE(offset + 12), bits: bytes.readUInt16LE(offset + 14) };
    }
    if (name === 'data') dataSize = size;
    offset += size + (size & 1);
  }
  assert.ok(format && dataSize !== undefined, 'Missing PCM format or audio data');
  assert.equal(format.encoding, 1, 'Expected PCM WAVE');
  assert.ok([1, 2].includes(format.channels) && [8, 16].includes(format.bits), 'Unsupported PCM format');
  assert.ok(format.sampleRate >= 8000 && format.sampleRate <= 96000, 'Invalid PCM sample rate');
  assert.equal(format.blockAlign, format.channels * format.bits / 8, 'Invalid PCM block alignment');
  assert.equal(format.byteRate, format.sampleRate * format.blockAlign, 'Invalid PCM byte rate');
  assert.equal(dataSize % format.blockAlign, 0, 'Truncated PCM sample');
  return { ...format, dataSize, durationMs: Math.ceil(dataSize * 1000 / format.byteRate) };
}

function testAudit() {
  const section = (name, data) => {
    const header = Buffer.alloc(8);
    header.write(name);
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data]);
  };
  assert.throws(() => scenarioSections(Buffer.alloc(7)), /header/);
  assert.throws(() => scenarioSections(section('UNIT', Buffer.alloc(35))), /UNIT/);
  assert.throws(() => scenarioSections(section('TRIG', Buffer.alloc(2399))), /TRIG/);
  const truncated = section('STR ', Buffer.from([0, 0]));
  assert.throws(() => scenarioSections(truncated.subarray(0, 9)), /Truncated/);
  const combined = scenarioSections(Buffer.concat([section('UNIT', Buffer.alloc(36)), section('UNIT', Buffer.alloc(72)), section('OWNR', Buffer.alloc(12)), section('OWNR', Buffer.alloc(12, 6))]));
  assert.equal(combined.get('UNIT').length, 108);
  assert.equal(combined.get('OWNR')[0], 6);
  for (const path of ['../test', '/test', 'C:\\test', 'a//b', 'a\\..\\b', 'a\0b', 'a/./b']) assert.throws(() => normalizeMissionPath(path));
  assert.equal(normalizeMissionPath('Staredit\\Wav\\TEST.wav'), 'staredit/wav/test.wav');
  assert.throws(() => scenarioStrings(Buffer.from([1, 0])), /Truncated/);
  const trigger = Buffer.alloc(2400);
  trigger[15] = 2;
  trigger[35] = 255;
  trigger[37] = 2;
  trigger[75] = 254;
  trigger[346] = 9;
  trigger[378] = 255;
  trigger[380] = 2;
  trigger[442] = 254;
  trigger[2372 + 18] = 1;
  const profile = triggerProfile(trigger, ['']);
  assert.deepEqual(profile.conditions, [2]);
  assert.deepEqual(profile.actions, [9]);
  assert.deepEqual(profile.records[0].owners, [18]);
  trigger.writeUInt32LE(5, 324);
  assert.throws(() => triggerProfile(trigger, ['']), /string index/);
  assert.throws(() => waveMetadata(Buffer.alloc(12)), /RIFF/);
  const ai = Buffer.alloc(34);
  ai.writeUInt32LE(14, 0);
  ai.set([2, 16, 0, 72, 11, 0, 36, 31, 0, 36], 4);
  ai.write('Test', 14, 'ascii');
  ai.writeUInt32LE(4, 18);
  assert.deepEqual(auditAiScript(ai, ['Test']).scripts[0].instructions.map(instruction => instruction.name), ['wait', 'multirun', 'stop', 'send_suicide', 'stop']);
  const invalidAi = Buffer.from(ai);
  invalidAi.writeUInt16LE(5, 8);
  assert.throws(() => auditAiScript(invalidAi, ['Test']), /Overlapping/);
  invalidAi.writeUInt16LE(1000, 8);
  assert.throws(() => auditAiScript(invalidAi, ['Test']), /out of bounds/);
  assert.throws(() => auditAiScript(ai.subarray(0, 20), ['Test']), /Truncated AI header/);
  assert.throws(() => auditAiScript(ai, ['None']), /Missing AI script/);
  console.log('Campaign audit synthetic checks passed.');
}

async function extractSource(source, request, directory, output) {
  const wasi = new WASI({ version: 'preview1', args: ['campaign-pack', `/input/${basename(source)}`, request, `/output/${output}`], preopens: { '/input': dirname(source), '/output': directory }, returnOnExit: true });
  const module = await WebAssembly.compile(readFileSync(resolve(root, 'web/campaign-pack.wasm')));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  assert.equal(wasi.start(instance), 0, 'Campaign extraction failed');
}

async function prepareAi(missionId = 'terran03') {
  assert.ok(Object.hasOwn(missions, missionId), 'Unsupported AI audit mission');
  const directory = resolve(root, 'web/data/campaign');
  mkdirSync(directory, { recursive: true });
  const temporary = resolve(directory, 'aiscript.bin.tmp');
  try {
    await extractSource(resolve(root, 'web/data/patch_rt.mpq'), '--ai-script', directory, basename(temporary));
    const bytes = readFileSync(temporary);
    assert.equal(sha256(bytes), '635433e546998e05529a9d6acc806c06b528c7ce5075a206f6f2c8de44ffed6e', 'Patched AI binary changed');
    let scripts = ['Ter3', 'Suic'];
    if (missionId !== 'terran03') {
      const read = readPlainMissionPack(readFileSync(resolve(directory, `${missionId}.mpq`)));
      const scenario = auditScenario(read('staredit/scenario.chk'));
      scripts = [...new Set(scenario.gameplay.records.flatMap(record => record.actions.filter(action => action.type === 15 || action.type === 16).map(action => {
        const id = Buffer.alloc(4);
        id.writeUInt32LE(action.amount);
        return id.toString('ascii');
      })))];
    }
    const audit = auditAiScript(bytes, scripts);
    writeFileSync(resolve(directory, `${missionId}.ai.audit.json`), `${JSON.stringify(audit, null, 2)}\n`);
    renameSync(temporary, resolve(directory, 'aiscript.bin'));
    console.log(JSON.stringify({ bytes: audit.bytes, sha256: audit.sha256, entryCount: audit.entryCount, scripts: audit.scripts.map(script => ({ id: script.id, offset: script.offset, instructionCount: script.instructions.length, commands: [...new Set(script.instructions.map(instruction => instruction.name))].sort() })) }, null, 2));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function prepare(missionId = 'terran01') {
  assert.ok(Object.hasOwn(missions, missionId), 'Unsupported mission ID');
  const mission = missions[missionId];
  const source = resolve(root, 'web/data', campaignSource.file);
  assert.equal(statSync(source).size, campaignSource.bytes, 'Unexpected source archive size');
  const sourceHasher = createHash('sha256');
  for await (const chunk of createReadStream(source)) sourceHasher.update(chunk);
  assert.equal(sourceHasher.digest('hex'), campaignSource.sha256, 'Source archive hash mismatch');
  const directory = resolve(root, 'web/data/campaign');
  mkdirSync(directory, { recursive: true });
  const temporary = resolve(directory, `${missionId}.mpq.tmp`);
  const manifestTemporary = resolve(directory, `${missionId}.json.tmp`);
  try {
    await extractSource(source, mission.source ?? missionId, directory, basename(temporary));
    const bytes = readFileSync(temporary);
    const read = readPlainMissionPack(bytes);
    const scenario = read('staredit/scenario.chk');
    assert.equal(sha256(scenario), mission.scenarioHash, `${mission.title} scenario changed`);
    const audit = auditScenario(scenario);
    assert.equal(audit.units.length, mission.units);
    assert.equal(audit.gameplay.records.length, mission.triggers);
    assert.equal(audit.briefing.records.length, 1);
    assert.equal(audit.wavePaths.length, mission.sounds);
    const humanSlots = audit.controllers.flatMap((controller, slot) => controller === 6 ? [slot] : []);
    assert.equal(humanSlots.length, 1, 'Expected one open human mission slot');
    const humanSlot = humanSlots[0];
    const race = audit.races[humanSlot];
    assert.ok([0, 1, 2].includes(race), 'Expected a fixed mission race');
    const files = ['staredit/scenario.chk', ...audit.wavePaths].map(path => {
      const content = read(path);
      return { path, bytes: content.length, sha256: sha256(content), ...(path.endsWith('.wav') ? { audio: waveMetadata(content) } : {}) };
    });
    const requirements = [...audit.gameplay.conditions.map(type => `condition.${type}`), ...audit.gameplay.actions.map(type => `action.${type}`), ...audit.briefing.actions.map(type => `briefing.${type}`)];
    const manifest = { schemaVersion: 1, contentVersion: 1, id: missionId, episode: 1, order: mission.order, title: mission.title, humanSlot, race, sourceChkSha256: mission.scenarioHash, pack: { url: `data/campaign/${missionId}.mpq`, bytes: bytes.length, sha256: sha256(bytes) }, requirements, files };
    writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(resolve(directory, `${missionId}.audit.json`), `${JSON.stringify(audit, null, 2)}\n`);
    renameSync(temporary, resolve(directory, `${missionId}.mpq`));
    renameSync(manifestTemporary, resolve(directory, `${missionId}.json`));
    console.log(JSON.stringify({ mission: manifest.id, packBytes: bytes.length, decodedBytes: files.reduce((total, file) => total + file.bytes, 0), packSha256: manifest.pack.sha256, dialogueFiles: files.filter(file => file.audio).length, conditions: audit.gameplay.conditions, actions: audit.gameplay.actions, briefing: audit.briefing.actions }, null, 2));
  } finally {
    rmSync(temporary, { force: true });
    rmSync(manifestTemporary, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--test') testAudit();
  else if (process.argv[2] === '--audit-ai') await prepareAi(process.argv[3]);
  else await prepare(process.argv[2]);
}
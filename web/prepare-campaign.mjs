import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WASI } from 'node:wasi';
import { campaignVariants, resolveCampaignMission } from './campaign-variants.js';

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
  zerg01: { title: 'Among the Ruins', episode: 2, order: 1, scenarioHash: 'f4794b4f8fc90f6ea9c4a585faa2c0a1de25450311256c7329a288d4dcd826ad', units: 101, triggers: 13, sounds: 15 },
  zerg02: { title: 'Egression', episode: 2, order: 2, scenarioHash: '5819629c7bf99c941ab64225de24e4aa60c5164ad5c00345258aa62fe6a0eadf', units: 146, triggers: 9, sounds: 8 },
  zerg03: { title: 'The New Dominion', episode: 2, order: 3, scenarioHash: 'a62ddf17410b37aa406aaf6a0024edb1aae9f69521e5abeab7a537baf638f7d7', units: 131, triggers: 6, sounds: 8 },
  zerg04: { title: 'Agent of the Swarm', episode: 2, order: 4, scenarioHash: '535c6d75f4225224abf36965627d7e7889c3e3b245a97d95843933d5cfb9de2a', units: 195, triggers: 7, sounds: 17 },
  zerg05: { title: 'The Amerigo', episode: 2, order: 5, scenarioHash: 'd758f917aebef2775b76bf90a5637fc7308ef4540334b05567e3c0caa6666e45', units: 137, triggers: 36, sounds: 21 },
  zerg06: { title: 'The Dark Templar', episode: 2, order: 6, scenarioHash: 'f441dcbdc4878d16a0e71790464d9ef8d677aad0c85e2463d0fa4ff2616af1f1', units: 188, triggers: 9, sounds: 14 },
  zerg07: { title: 'The Culling', episode: 2, order: 7, scenarioHash: '2c39850f5a902c369130da3ebfce6d32d087e1d1d8fca1204ef6ef2f9a1b5e9d', units: 233, triggers: 8, sounds: 6 },
  zerg08: { title: 'Eye for an Eye', episode: 2, order: 8, scenarioHash: 'ea8af2d5458e5c27ad53419a80420f32619c60a7830eefd4742b767f3dc0cac2', units: 198, triggers: 39, sounds: 11 },
  zerg09: { title: 'The Invasion of Aiur', episode: 2, order: 9, scenarioHash: 'fd99e4670f57110dd7720777a188d6447c7e23a02334c691f90790c5752f8205', units: 377, triggers: 14, sounds: 8 },
  zerg10: { title: 'Full Circle', episode: 2, order: 10, scenarioHash: '7d9befb178c53014bc7c7efdcb6ed208a0aa7c97b4a37141cbca5345fd6d15fb', units: 447, triggers: 10, sounds: 6 },
  protoss01: { title: 'First Strike', episode: 3, order: 1, scenarioHash: '374a08c6d15bbd32280091e54164047b12c6ffc526d12d0663a0c7df18784188', units: 126, triggers: 13, sounds: 9 },
  protoss02: { title: 'Into the Flames', episode: 3, order: 2, scenarioHash: 'c2a1faa77faaa8f85d178da8d5502a9235749240244b7403d240bff9b220fe24', units: 144, triggers: 8, sounds: 14 },
  protoss03: { title: 'Higher Ground', episode: 3, order: 3, scenarioHash: '6e73084830bd7c49da9dfeeb11e11b9e589b066b3e4290836cd2baf4415762e6', units: 200, triggers: 5, sounds: 6 },
  protoss04: { title: 'The Hunt for Tassadar', episode: 3, order: 4, scenarioHash: '9cf4f218e0b29b7e61743fd6383dab6c3aec4a5e12c6fade0b0fc37ae44c67b3', units: 201, triggers: 13, sounds: 21 },
  protoss05: { title: 'Choosing Sides', episode: 3, order: 5, scenarioHash: '0911c2cf8b484c266e26ed3c439cd917e0dc0cd9a7cb62985bc4800f7b64afe5', units: 257, triggers: 11, sounds: 13 },
  protoss06: { title: 'Into the Darkness', episode: 3, order: 6, scenarioHash: '30f0a374867c7b57cf51e5c445041020eebbe4a1fcbc074359a581a5bc5f5eee', units: 210, triggers: 23, sounds: 18 },
  protoss07: { title: 'Homeland', episode: 3, order: 7, scenarioHash: 'a813922890e6eafe4feda27b591715c465e98e8ee40e3717b5c2b0735e403a83', units: 362, triggers: 10, sounds: 16 },
  protoss08: { title: 'The Trial of Tassadar', episode: 3, order: 8, scenarioHash: '4ee5b213ce8e46b5a3b1ab3e815767a91b0b1f720d503cb203548730ce0efc37', units: 260, triggers: 8, sounds: 15 },
  protoss09: { title: 'Shadow Hunters', episode: 3, order: 9, scenarioHash: '5af7dd1b80328ee75501b18e54c5f8849c320ca247e3380e1aae1349d4a8a15c', units: 348, triggers: 12, sounds: 6 },
  protoss10: { title: 'Eye of the Storm', episode: 3, order: 10, scenarioHash: 'e8bc84347cd8810d423e76c8e739612de777f579dd287eca2ef5bc620ff4ebdd', units: 407, triggers: 8, sounds: 10 },
  bwprotoss01: { title: 'Escape from Aiur', episode: 4, order: 1, scenarioHash: 'ef8153dbfc7d9216207aaac7cda7a2950980cdb35a9c72612a67dc7b76a09e67', units: 293, triggers: 117, sounds: 28 },
  bwprotoss02: { title: 'Dunes of Shakuras', episode: 4, order: 2, scenarioHash: '07725cd6a26052101ecfef735105c204309a40518de1a232736aefb268f01011', units: 168, triggers: 30, sounds: 18 },
  bwprotoss03: { title: "Legacy of the Xel'Naga", episode: 4, order: 3, scenarioHash: 'd4d49e69460b587bc55af2852409366ccff1ed433a101535ac391b288f74bbf8', units: 176, triggers: 41, sounds: 23 },
  bwprotoss04: { title: 'Quest for Uraj', episode: 4, order: 4, createStartingUnits: true, scenarioHash: 'f495e751fb3975fa7a701f5a250d554dadee5776a7a2d35c038980883293c863', units: 261, triggers: 29, sounds: 21 },
  bwprotoss05: { title: 'The Battle of Braxis', episode: 4, order: 5, scenarioHash: 'b32673a2c6b5aa4479202df8ddc408c2cca29cca094b77e357fb1f930103b963', units: 405, triggers: 102, sounds: 11 },
  bwprotoss06: { title: 'Return to Char', episode: 4, order: 6, scenarioHash: '4eb75410295fe4ac68a4c45e0179a91afb72d0078bf98a808461a7c54a62f611', units: 607, triggers: 24, sounds: 12 },
  bwprotoss07: { title: 'The Insurgent', episode: 4, order: 7, scenarioHash: '44b57433f843a111d02e565fb8976a2396a228bf08ef058c5c0a1a9c6d5ef274', units: 354, triggers: 29, sounds: 25 },
  bwprotoss08: { title: 'Countdown', episode: 4, order: 8, scenarioHash: '600dbf632ff6a1b2987e482912312f29189cde3a3c3a599b13c2c6d4b56e5acb', units: 746, triggers: 20, sounds: 15 },
  bwterran01: { title: 'First Strike', episode: 5, order: 1, scenarioHash: '48b3dee553ae2e0b2747b9cd4b85f5a4dfc982dc89bb523fad015acdc4c7b5ab', units: 296, triggers: 12, sounds: 14 },
  bwterran02: { title: 'The Dylarian Shipyards', episode: 5, order: 2, scenarioHash: 'dda5b662bd21a7335f076a56a65690b35e441a1a0fe6aebc84676f0951934108', units: 124, triggers: 89, sounds: 29 },
  bwterran03: { title: 'Ruins of Tarsonis', episode: 5, order: 3, scenarioHash: '76516a763fe806b2a4e2c6814c4fcd3e05f51a21c8aa8817837a74b4fcf9ff38', units: 360, triggers: 37, sounds: 22 },
  bwterran04: { title: 'Assault on Korhal', episode: 5, order: 4, scenarioHash: '988d5c2c1692a63038a3e7a895dd0d35fe9cf3696523e37858f4b5f69f9a8401', units: 456, triggers: 31, sounds: 8 },
  bwterran05: { title: "Emperor's Fall", episode: 5, order: 5, scenarioHash: 'c957cb9946b7e756be3fbbbcee27438891695522612bc3f9e7ced880ae7e07ef', units: 673, triggers: 53, sounds: 31 },
  bwterran06: { title: "Emperor's Flight", episode: 5, order: 6, scenarioHash: '54d0997fa091fc6ffb6e16491fda29281ed89d2e5b3d0e0be3f2b2d7c14c4e17', units: 496, triggers: 74, sounds: 18 },
  bwterran07: { title: "Patriot's Blood", episode: 5, order: 7, scenarioHash: 'c6835b14e8362a4edd66305b3821788386fa8b1deeffb39867d56a55884c508d', units: 279, triggers: 209, sounds: 89 },
};
const variantProfiles = {
  bwterran05b: { scenarioHash: 'ef5270cc733291603cc1646dff1ce03f40dc310a6025d4ea99ebe53ff88d5a20', units: 468, triggers: 29, sounds: 26 },
};
export const campaignMissions = Object.freeze(Object.keys(missions));
export const campaignPackMissions = Object.freeze(campaignMissions.flatMap(id => campaignVariants[id]?.variants.map(variant => variant.assetId) ?? [id]));
export const campaignSource = Object.freeze({
  file: 'StarCraft.mpq',
  bytes: 601389682,
  sha256: 'ba155a30ca11a57a2ea917cb4f25715f79bee7397ebb16db4816e7725395e58d',
  url: 'https://archive.org/download/sc-classic-installer_202311/StarCraft%20Portable.zip/Starcraft%20Brood%20War%2FStarCraft.mpq',
});
export const broodWarSource = Object.freeze({
  file: 'BroodWar.mpq',
  bytes: 571847688,
  sha256: '180425f53094c71b208b1244dab3cb2f63492a9120d96e3a9362f4c5ff7404b2',
  url: 'https://archive.org/download/sc-classic-installer_202311/StarCraft%20Portable.zip/Starcraft%20Brood%20War%2FBroodWar.mpq',
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function auditAiScript(bytes, scriptIds = ['Ter3', 'Suic'], broodwar = false) {
  assert.ok(bytes.length >= 8 && bytes.length <= 1048576, 'Invalid AI binary size');
  const table = bytes.readUInt32LE(0);
  assert.ok(table >= 4 && table <= bytes.length - 4, 'Invalid AI header offset');
  const entries = new Map();
  let cursor = table;
  while (true) {
    assert.ok(cursor <= bytes.length - 4, 'Unterminated AI header table');
    if (bytes.readUInt32LE(cursor) === 0) break;
    const width = broodwar ? 8 : 16;
    assert.ok(cursor <= bytes.length - width, 'Truncated AI header');
    const id = bytes.toString('ascii', cursor, cursor + 4);
    assert.ok(!entries.has(id), 'Duplicate AI script ID');
    entries.set(id, { id, offset: bytes.readUInt32LE(cursor + 4), ...(broodwar ? {} : { flags: bytes.readUInt32LE(cursor + 12) }) });
    assert.ok(entries.size <= 4096, 'Too many AI scripts');
    cursor += width;
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
  const version = sections.get('VER ')?.readUInt16LE(0);
  assert.ok([59, 205].includes(version), 'Unsupported CHK version');
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
  return { sha256: sha256(bytes), version, controllers: [...sections.get('OWNR')], races: [...sections.get('SIDE')], units, gameplay, briefing, wavePaths: [...wavePaths].sort() };
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
  const bw = Buffer.alloc(18);
  bw.writeUInt32LE(6);
  bw.set([36, 36], 4);
  bw.write('ExpA', 6, 'ascii');
  bw.writeUInt32LE(4, 10);
  assert.equal(auditAiScript(bw, ['ExpA'], true).scripts[0].instructions[0].name, 'stop');
  assert.throws(() => auditAiScript(bw.subarray(0, 13), ['ExpA'], true), /Truncated AI header/);
  const scenario = version => Buffer.concat([section('VER ', Buffer.from([version & 255, version >> 8])), section('OWNR', Buffer.alloc(12)), section('SIDE', Buffer.alloc(12)), section('STR ', Buffer.alloc(2))]);
  assert.equal(auditScenario(scenario(59)).version, 59);
  assert.equal(auditScenario(scenario(205)).version, 205);
  assert.throws(() => auditScenario(scenario(63)), /Unsupported CHK version/);
  console.log('Campaign audit synthetic checks passed.');
}

async function extractSource(source, request, directory, output) {
  const wasi = new WASI({ version: 'preview1', args: ['campaign-pack', `/input/${basename(source)}`, request, `/output/${output}`], preopens: { '/input': dirname(source), '/output': directory }, returnOnExit: true });
  const module = await WebAssembly.compile(readFileSync(resolve(root, 'web/campaign-pack.wasm')));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  assert.equal(wasi.start(instance), 0, 'Campaign extraction failed');
}

async function prepareAi(missionId = 'terran03') {
  const selection = resolveCampaignMission(missionId);
  assert.ok(Object.hasOwn(missions, selection.missionId), 'Unsupported AI audit mission');
  missionId = selection.assetId;
  const directory = resolve(root, 'web/data/campaign');
  mkdirSync(directory, { recursive: true });
  const temporary = resolve(directory, 'aiscript.bin.tmp');
  const expansionTemporary = resolve(directory, 'bwscript.bin.tmp');
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
    await extractSource(resolve(root, 'web/data/BROODAT.MPQ'), '--bw-script', directory, basename(expansionTemporary));
    const expansionBytes = readFileSync(expansionTemporary);
    assert.equal(sha256(expansionBytes), '15a1a5b3fb4f2cab2e7b7b507ae04d4e2ef097c77081cfeb950d9a2e4ebee382', 'Expansion AI binary changed');
    const audit = auditAiScript(bytes, []);
    const table = bytes.readUInt32LE(0);
    audit.scripts = scripts.flatMap(id => {
      let offset = null;
      for (let cursor = table; bytes.readUInt32LE(cursor); cursor += 16) if (bytes.toString('ascii', cursor, cursor + 4) === id) offset = bytes.readUInt32LE(cursor + 4);
      assert.notEqual(offset, null, `Missing AI script ${id}`);
      return auditAiScript(offset === 0 ? expansionBytes : bytes, [id], offset === 0).scripts.map(script => ({ ...script, binary: offset === 0 ? 'bwscript.bin' : 'aiscript.bin' }));
    });
    audit.expansionSha256 = sha256(expansionBytes);
    writeFileSync(resolve(directory, `${missionId}.ai.audit.json`), `${JSON.stringify(audit, null, 2)}\n`);
    renameSync(temporary, resolve(directory, 'aiscript.bin'));
    renameSync(expansionTemporary, resolve(directory, 'bwscript.bin'));
    console.log(JSON.stringify({ bytes: audit.bytes, sha256: audit.sha256, entryCount: audit.entryCount, scripts: audit.scripts.map(script => ({ id: script.id, offset: script.offset, instructionCount: script.instructions.length, commands: [...new Set(script.instructions.map(instruction => instruction.name))].sort() })) }, null, 2));
  } finally {
    rmSync(temporary, { force: true });
    rmSync(expansionTemporary, { force: true });
  }
}

export async function prepare(missionId = 'terran01') {
  const selection = resolveCampaignMission(missionId);
  assert.ok(Object.hasOwn(missions, selection.missionId), 'Unsupported mission ID');
  missionId = selection.assetId;
  const mission = { ...missions[selection.missionId], ...variantProfiles[missionId] };
  const archive = mission.episode >= 4 ? broodWarSource : campaignSource;
  const source = resolve(root, 'web/data', archive.file);
  assert.equal(statSync(source).size, archive.bytes, 'Unexpected source archive size');
  const sourceHasher = createHash('sha256');
  for await (const chunk of createReadStream(source)) sourceHasher.update(chunk);
  assert.equal(sourceHasher.digest('hex'), archive.sha256, 'Source archive hash mismatch');
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
    assert.equal(audit.version, mission.episode >= 4 ? 205 : 59, 'Mission format must match its campaign edition');
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
    const manifest = { schemaVersion: 1, contentVersion: 1, id: selection.missionId, ...(selection.scenario ? { variant: selection.scenario } : {}), episode: mission.episode ?? 1, order: mission.order, title: selection.label ? `${mission.title} (${selection.label})` : mission.title, humanSlot, race, createStartingUnits: !!mission.createStartingUnits, sourceChkSha256: mission.scenarioHash, pack: { url: `data/campaign/${missionId}.mpq`, bytes: bytes.length, sha256: sha256(bytes) }, requirements, files };
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
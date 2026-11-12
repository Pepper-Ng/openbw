import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const body = (source, signature) => {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing native shortcut source: ${signature}`);
  return source.slice(start).split('\n\t}')[0];
};
const enumValues = (source, name) => {
  const match = source.match(new RegExp(`enum struct ${name} : int \\{([^]*?)\\n\\};`));
  if (!match) throw new Error(`Missing enum ${name}`);
  let next = 0;
  return Object.fromEntries(match[1].replace(/\/\/[^\n]*/g, '').split(',').filter(s => s.trim()).map(part => {
    const [key, explicit] = part.trim().split(/\s*=\s*/);
    if (explicit !== undefined) next = Number(explicit);
    if (!Number.isInteger(next)) throw new Error(`Unsupported enum value: ${part}`);
    return [key, next++];
  }));
};
const keyTable = text => {
  const result = {};
  for (const match of text.matchAll(/((?:case [UT]::\w+:\s*)+)return '(.)';/g))
    for (const item of match[1].matchAll(/[UT]::(\w+)/g)) result[item[1]] = match[2];
  return result;
};
const returnTable = text => {
  const result = {};
  for (const match of text.matchAll(/((?:case U::\w+:\s*)+)return U::(\w+);/g))
    for (const item of match[1].matchAll(/U::(\w+)/g)) result[item[1]] = match[2];
  return result;
};
const producerTable = (text, type) => {
  const result = {};
  const pattern = new RegExp(`case ${type}::(\\w+):([^]*?)(?=case ${type}::|\\n\\t\\tdefault:|$)`, 'g');
  for (const match of text.matchAll(pattern)) {
    const condition = match[2].match(/if \(!unit_is\(u, UnitTypes::[^;\n]+/);
    if (condition) result[match[1]] = [...condition[0].matchAll(/UnitTypes::(\w+)/g)].map(m => m[1]);
  }
  return result;
};

export function generateHotkeyCatalog() {
  const enums = read('bwenums.h'), ui = read('web/sandbox.h'), game = read('bwgame.h');
  const units = enumValues(enums, 'UnitTypes'), techs = enumValues(enums, 'TechTypes'), upgrades = enumValues(enums, 'UpgradeTypes');
  const name = text => text.replace(/_/g, ' ');
  const scope = unit => `unit:${units[unit]}`;
  const id = (action, unit = units.None, tech = techs.None, upgrade = upgrades.None) => `${action}:${unit}:${tech}:${upgrade}:0`;
  const entries = [];
  const add = (action, label, key, producers, unit, tech, upgrade, extraScopes = []) => {
    if (!producers.length) throw new Error(`Missing producers for ${label}`);
    entries.push({ id: id(action, unit, tech, upgrade), label, key: key || '',
      context: producers.length > 4 ? 'Multiple unit types' : producers.map(name).join(', '),
      race: new Set(producers.map(producer => producer.split('_')[0])).size > 1 ? 'General' : producers[0].split('_')[0],
      scopes: [...producers.map(scope), ...extraScopes] });
  };
  const train = keyTable(body(ui, 'static char bw_train_key('));
  const producers = returnTable(body(ui, 'static UnitTypes bw_what_builds('));
  for (const [unit, key] of Object.entries(train)) {
    const zerg = unit.startsWith('Zerg_');
    if (!zerg && !producers[unit]) throw new Error(`Missing native producer: ${unit}`);
    const producer = producers[unit] || (unit === 'Zerg_Lurker' ? 'Zerg_Hydralisk'
      : ['Zerg_Guardian', 'Zerg_Devourer'].includes(unit) ? 'Zerg_Mutalisk' : 'Zerg_Larva');
    add(zerg ? 'morph' : 'train', `${zerg ? 'Morph' : 'Train'} ${name(unit)}`, key, [producer], units[unit]);
  }
  add('train', 'Train Nuclear Missile', 'n', ['Terran_Nuclear_Silo'], units.Terran_Nuclear_Missile);
  add('train', 'Train Infested Terran', 'i', ['Zerg_Infested_Command_Center'], units.Zerg_Infested_Terran);
  const building = keyTable(body(ui, 'static char bw_build_key('));
  const addons = returnTable(body(ui, 'static UnitTypes bw_addon_parent('));
  const morphs = { Zerg_Lair: 'Zerg_Hatchery', Zerg_Hive: 'Zerg_Lair', Zerg_Greater_Spire: 'Zerg_Spire',
    Zerg_Sunken_Colony: 'Zerg_Creep_Colony', Zerg_Spore_Colony: 'Zerg_Creep_Colony' };
  const advanced = new Set([...body(ui, 'static bool bw_build_advanced(').matchAll(/case U::(\w+):/g)].map(m => m[1]));
  for (const [unit, key] of Object.entries(building)) {
    const race = unit.split('_')[0];
    if (addons[unit] || morphs[unit]) {
      add(addons[unit] ? 'train' : 'morph-building', `Build ${name(unit)}`, key, [addons[unit] || morphs[unit]], units[unit]);
    } else {
      const producer = { Terran: 'Terran_SCV', Protoss: 'Protoss_Probe', Zerg: 'Zerg_Drone' }[race];
      entries.push({ id: id('build', units[unit]), label: `Build ${name(unit)}`, key, race,
        context: `${race} worker: ${advanced.has(unit) ? 'Advanced' : 'Basic'} or combined build menu`,
        scopes: [`build:${race}:${advanced.has(unit) ? 'advanced' : 'basic'}`, `build:${race}:combined`] });
      if (!producer) throw new Error(`Unknown worker race: ${race}`);
    }
  }
  for (const [action, type, values, functionName, keyName] of [
    ['research', 'TechTypes', techs, 'unit_can_research(const unit_t* u, const tech_type_t* tech) const', 'bw_research_key'],
    ['upgrade', 'UpgradeTypes', upgrades, 'unit_can_upgrade(const unit_t* u, const upgrade_type_t* upgrade) const', 'bw_upgrade_key'],
  ]) {
    const keys = keyTable(body(ui, `static char ${keyName}(`));
    for (const [item, allowed] of Object.entries(producerTable(body(game, functionName), type)))
      add(action, `${action === 'research' ? 'Research' : 'Upgrade'} ${name(item)}`, keys[item] || item[0].toLowerCase(),
        allowed, undefined, action === 'research' ? values[item] : undefined, action === 'upgrade' ? values[item] : undefined);
  }
  for (const match of body(ui, 'static const spell_t* spells(').matchAll(/\{U::(\w+), T::(\w+), O::\w+, (?:true|false), "([^"]+)", '(.)'\}/g))
    add('spell', match[3], match[4], [match[1]], undefined, techs[match[2]]);
  const mobile = Object.keys(units).filter(unit => units[unit] < 106 && !/Larva|Egg|Turret|Spell_/.test(unit));
  const workers = ['Terran_SCV', 'Zerg_Drone', 'Protoss_Probe'];
  for (const [action, label, key, allowed, unit] of [
    ['move', 'Move', 'm', mobile], ['stop', 'Stop', 's', mobile], ['attack', 'Attack', 'a', mobile],
    ['hold', 'Hold position', 'h', mobile], ['patrol', 'Patrol', 'p', mobile],
    ['gather', 'Gather', 'g', workers], ['return-cargo', 'Return cargo', 'c', workers],
    ['repair', 'Repair', 'r', ['Terran_SCV']], ['build-menu', 'Basic / combined build menu', 'b', workers],
    ['advanced-menu', 'Advanced build menu', 'v', workers],
    ['stim', 'Stim Pack', 't', ['Terran_Marine', 'Terran_Firebat']],
    ['siege', 'Siege Mode', 'o', ['Terran_Siege_Tank_Tank_Mode']],
    ['unsiege', 'Tank Mode', 'o', ['Terran_Siege_Tank_Siege_Mode']],
    ['cloak', 'Cloak', 'c', ['Terran_Ghost', 'Terran_Wraith']], ['decloak', 'Decloak', 'c', ['Terran_Ghost', 'Terran_Wraith']],
    ['burrow', 'Burrow', 'u', mobile.filter(u => u.startsWith('Zerg_'))],
    ['unburrow', 'Unburrow', 'u', mobile.filter(u => u.startsWith('Zerg_'))],
    ['fighter', 'Build Interceptor', 'i', ['Protoss_Carrier'], units.Protoss_Interceptor],
    ['fighter', 'Build Scarab', 'r', ['Protoss_Reaver'], units.Protoss_Scarab],
    ['archon', 'Merge Archon', 'r', ['Protoss_High_Templar'], units.Protoss_Archon],
    ['dark-archon', 'Merge Dark Archon', 'r', ['Protoss_Dark_Templar'], units.Protoss_Dark_Archon],
    ['select', 'Select Larva', 's', ['Zerg_Hatchery', 'Zerg_Lair', 'Zerg_Hive'], units.Zerg_Larva],
    ['rally', 'Set Rally Point', 'r', [...new Set([...Object.values(producers), ...Object.values(morphs)])]],
    ['lift', 'Lift Off', 'l', ['Terran_Command_Center', 'Terran_Barracks', 'Terran_Factory', 'Terran_Starport', 'Terran_Science_Facility', 'Terran_Engineering_Bay']],
    ['land', 'Land', 'l', ['Terran_Command_Center', 'Terran_Barracks', 'Terran_Factory', 'Terran_Starport', 'Terran_Science_Facility', 'Terran_Engineering_Bay']],
    ['unload-all', 'Unload all', 'u', ['Terran_Dropship', 'Terran_Bunker', 'Protoss_Shuttle', 'Zerg_Overlord']],
    ['confirm', 'Confirm building placement', 'c', workers],
  ]) add(action, label, key, allowed, unit);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate shortcut identities');
  return entries;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = `// Generated from native shortcut tables by generate-hotkey-catalog.mjs.\nexport default ${JSON.stringify(generateHotkeyCatalog(), null, 2)};\n`;
  const target = new URL('./hotkey-catalog.js', import.meta.url);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== output) throw new Error('Hotkey catalog is stale. Run node web/generate-hotkey-catalog.mjs.');
    console.log('Native shortcut catalog is current.');
  } else {
    writeFileSync(target, output);
    console.log('Generated native shortcut catalog.');
  }
}

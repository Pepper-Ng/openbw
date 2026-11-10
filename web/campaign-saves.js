export const campaignSaveVersion = 1;
export const campaignSaveKeys = ['slot:1', 'slot:2', 'slot:3'];

const validMission = value => /^(?:(?:terran|zerg|protoss)(?:0[1-9]|10)|bwprotoss0[1-5])$/.test(value);
const validKey = value => campaignSaveKeys.includes(value) || typeof value === 'string' && value.startsWith('auto:') && validMission(value.slice(5));
const integer = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum;

function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

export function sealCampaignSave(payload) {
  const value = { ...payload, version: campaignSaveVersion };
  delete value.integrity;
  return { ...value, integrity: fingerprint(value) };
}

export function validateCampaignSave(value, expected = null) {
  if (!value || value.version !== campaignSaveVersion || !validMission(value.mission) || typeof value.title !== 'string' || value.title.length > 200 || !integer(value.ticks, 2000000) || !integer(value.frame, value.ticks + 8) || !integer(value.checksum, 0xffffffff) || !Number.isFinite(value.savedAt) || value.savedAt <= 0) throw new Error('Invalid saved game.');
  if (!/^[a-f0-9]{64}$/.test(value.packHash) || !/^[a-f0-9]{64}$/.test(value.engineHash) || !Array.isArray(value.assetHashes) || value.assetHashes.length !== 3 || value.assetHashes.some(hash => !/^[a-f0-9]{14}$/.test(hash))) throw new Error('Invalid saved game compatibility data.');
  if (!Array.isArray(value.turns) || value.turns.length > 100000) throw new Error('Invalid saved game commands.');
  let previous = -1, total = 0;
  for (const turn of value.turns) {
    if (!integer(turn.tick, value.ticks - 1) || turn.tick < previous || !Array.isArray(turn.bytes) || turn.bytes.length === 0 || turn.bytes.length > 65536 || turn.bytes.some(byte => !integer(byte, 255))) throw new Error('Invalid saved game command batch.');
    previous = turn.tick;
    total += turn.bytes.length;
    if (total > 8 * 1048576) throw new Error('Saved command history exceeds the supported size.');
  }
  if (!value.view || !Array.isArray(value.view.camera) || value.view.camera.length !== 2 || value.view.camera.some(position => !integer(position, 65536)) || !Array.isArray(value.view.selection) || value.view.selection.length > 12 || value.view.selection.some(id => !integer(id, 65535))) throw new Error('Invalid saved game view.');
  if (value.caption && (typeof value.caption.text !== 'string' || value.caption.text.length > 16000 || typeof value.caption.speaker !== 'string' || value.caption.speaker.length > 200 || !integer(value.caption.remaining, 100000))) throw new Error('Invalid saved game caption.');
  const payload = { ...value };
  delete payload.integrity;
  if (value.integrity !== fingerprint(payload)) throw new Error('Saved game integrity check failed.');
  if (expected && (value.mission !== expected.mission || value.packHash !== expected.packHash || value.engineHash !== expected.engineHash || JSON.stringify(value.assetHashes) !== JSON.stringify(expected.assetHashes))) throw new Error('This saved game requires the engine and mission data that created it.');
  return value;
}

let database;
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('openbw-campaign-saves', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('games');
      request.result.createObjectStore('summaries');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
    request.onerror = () => { database = null; reject(request.error); };
    request.onblocked = () => { database = null; reject(new Error('Saved-game storage is blocked by another tab.')); };
  });
  return database;
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Saved-game storage failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Saved-game storage was interrupted.'));
  });
}

export async function writeCampaignSave(key, value) {
  if (!validKey(key)) throw new Error('Invalid saved game slot.');
  validateCampaignSave(value);
  if (key.startsWith('auto:') && key !== `auto:${value.mission}`) throw new Error('Autosave mission mismatch.');
  const db = await openDatabase();
  const transaction = db.transaction(['games', 'summaries'], 'readwrite');
  const done = finished(transaction);
  const summaries = transaction.objectStore('summaries');
  const existing = summaries.get(key);
  let writeError = null;
  existing.onsuccess = () => {
    try {
      if (existing.result?.savedAt > value.savedAt) return;
      transaction.objectStore('games').put(value, key);
      summaries.put({ key, version: value.version, mission: value.mission, title: value.title, savedAt: value.savedAt, frame: value.frame, engineHash: value.engineHash }, key);
    } catch (error) { writeError = error; transaction.abort(); }
  };
  try { await done; } catch (error) { throw writeError || error; }
}

export async function readCampaignSave(key) {
  if (!validKey(key)) throw new Error('Invalid saved game slot.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('games').objectStore('games').get(key);
    request.onsuccess = () => {
      try { resolve(request.result ? validateCampaignSave(request.result) : null); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function listCampaignSaves() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('summaries').objectStore('summaries').getAll();
    request.onsuccess = () => resolve(request.result.filter(value => validKey(value.key) && validMission(value.mission)).sort((first, second) => second.savedAt - first.savedAt));
    request.onerror = () => reject(request.error);
  });
}

export async function deleteCampaignSave(key) {
  if (!validKey(key)) throw new Error('Invalid saved game slot.');
  const db = await openDatabase();
  const transaction = db.transaction(['games', 'summaries'], 'readwrite');
  const done = finished(transaction);
  transaction.objectStore('games').delete(key);
  transaction.objectStore('summaries').delete(key);
  await done;
}
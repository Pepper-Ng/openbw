const { default: nativeCatalog } = await import('./hotkey-catalog.js' + new URL(import.meta.url).search);

const global = (id, label, key) => ({ id, label, key, race: 'General', scopes: ['*'] });
export const GLOBAL_SHORTCUTS = [
  global('global:cancel', 'Cancel / Back / Halt construction', 'Escape'),
  global('global:alternate-cancel', 'Alternate Cancel / Back', ''),
  global('selection:next', 'Next subgroup / terrain view', 'Tab'),
  global('selection:previous', 'Previous subgroup', 'Shift+Tab'),
  global('selection:alert', 'Center on latest alert', 'Space'),
  ...['Left', 'Right', 'Up', 'Down'].map(direction => global(`camera:${direction.toLowerCase()}`, `Pan ${direction.toLowerCase()}`, `Arrow${direction}`)),
  ...Array.from({ length: 10 }, (_, n) => [
    global(`group:recall:${n}`, `Recall control group ${n}`, `Digit${n}`),
    global(`group:assign:${n}`, `Assign control group ${n}`, `Ctrl+Digit${n}`),
  ]).flat(),
  global('ui:pause', 'Pause / Resume', 'Pause'), global('ui:settings', 'Settings menu', 'F10'),
  global('ui:objectives', 'Show objectives', 'F9'), global('ui:sound', 'Mute / Unmute', 'F8'),
  global('ui:chat', 'Chat', 'Enter'), global('ui:fullscreen', 'Fullscreen', 'Alt+Enter'),
  global('ui:zoom-in', 'Zoom in', 'Equal'), global('ui:zoom-out', 'Zoom out', 'Minus'),
];
export const SHORTCUT_CATALOG = [...GLOBAL_SHORTCUTS, ...nativeCatalog,
  ...Array.from({ length: 8 }, (_, i) => ({ id: `cargo:${i + 1}`, label: `Unload passenger ${i + 1}`,
    key: '', race: 'General', scopes: ['cargo'] })),
];
const catalogById = new Map(SHORTCUT_CATALOG.map(entry => [entry.id, entry]));
const commandKinds = new Set(nativeCatalog.map(entry => entry.id.split(':')[0]));
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const keyCodes = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Left|Right|Up|Down)|Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma)|Escape|Tab|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Pause|CapsLock|NumLock|ScrollLock|PrintScreen|ContextMenu|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen|MediaPlayPause|MediaStop|MediaTrackNext|MediaTrackPrevious|AudioVolumeUp|AudioVolumeDown|AudioVolumeMute)$/;
const extraCodes = new Set(('Convert NonConvert KanaMode Lang1 Lang2 Lang3 Lang4 Lang5 Help ' +
  'NumpadBackspace NumpadClear NumpadClearEntry NumpadHash NumpadMemoryAdd NumpadMemoryClear ' +
  'NumpadMemoryRecall NumpadMemoryStore NumpadMemorySubtract NumpadParenLeft NumpadParenRight NumpadStar ' +
  'BrowserBack BrowserFavorites BrowserForward BrowserHome BrowserRefresh BrowserSearch BrowserStop ' +
  'Eject LaunchApp1 LaunchApp2 LaunchMail MediaSelect Power Sleep WakeUp Abort Again Copy Cut Find Open Paste Props Select Undo').split(' '));
const gridKeys = [...'QWEASDZXCRTFGHVBNYUIJKMOPL'].map(key => `Key${key}`);

export function validateChord(chord) {
  if (typeof chord !== 'string' || chord.length > 100) throw new Error('Invalid shortcut.');
  const parts = chord.split('+'), code = parts.pop();
  if ((!keyCodes.test(code) && !extraCodes.has(code)) || parts.some(part => !modifiers.includes(part)) ||
      parts.join('+') !== modifiers.filter(part => parts.includes(part)).join('+'))
    throw new Error('Use a regular key, optionally with Ctrl, Alt, Shift or Meta. Modifier keys alone cannot be assigned.');
  if ((parts.includes('Ctrl') || parts.includes('Meta')) && /^(Key[WRTLNQ]|Tab)$/.test(code))
    throw new Error('That shortcut is reserved for the browser or operating system.');
  return chord;
}

export function validateHotkeys(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid keyboard settings.');
  const profile = value.profile === undefined ? 'classic' : value.profile;
  const bindings = value.bindings === undefined ? {} : value.bindings;
  if (!['classic', 'grid'].includes(profile) || !bindings || typeof bindings !== 'object' || Array.isArray(bindings) ||
      Object.keys(bindings).length > 1024) throw new Error('Invalid keyboard profile.');
  const entries = Object.entries(bindings).map(([id, chord]) => {
    if (!catalogById.has(id) && (!/^[a-z-]+:\d{1,5}:\d{1,3}:\d{1,3}:\d{1,5}$/.test(id) || !commandKinds.has(id.split(':')[0])))
      throw new Error(`Unknown shortcut identity: ${id}`);
    return [id, chord === null ? null : validateChord(chord)];
  });
  return { profile, bindings: Object.fromEntries(entries) };
}

export function eventChord(event, omitShift = false) {
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', !omitShift && event.shiftKey && 'Shift',
    event.metaKey && 'Meta', event.code].filter(Boolean).join('+');
}

export function formatChord(chord) {
  return chord ? chord.split('+').map(part => part === 'Escape' ? 'Esc'
    : part.replace(/^Numpad([0-9])$/, '#$1').replace(/^(Key|Digit)/, '').replace(/^Arrow/, '')).join(' + ') : 'Unbound';
}

export function commandHint(label, chord, command = '') {
  if (!chord || (chord === 'Escape' && /^(cancel|back|stop):/.test(command)))
    return { index: -1, badge: '' };
  const character = /^(Key[A-Z]|Digit[0-9])$/.test(chord) ? chord.replace(/^(Key|Digit)/, '') : '';
  const index = character ? label.toLowerCase().indexOf(character.toLowerCase()) : -1;
  return { index, badge: index < 0 ? formatChord(chord) : '' };
}

export function classicChord(key) {
  if (key === '\x1b') return 'Escape';
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return '';
}

export function commandShortcuts(text) {
  let passenger = 0;
  return text.split('\n').slice(1).filter(Boolean).map(line => {
    const fields = line.split('\t');
    const id = fields[0] === '\x1b' ? 'global:cancel' : fields[10]?.startsWith('unload:')
      ? `cargo:${++passenger}` : fields[10];
    return { id, command: fields[10], key: classicChord(fields[0]), label: fields[1], fields };
  }).filter(row => row.id);
}

export function activeShortcuts(rows, value, visible = []) {
  const settings = validateHotkeys(value), bindings = settings.bindings;
  const applicable = new Set([...rows.map(row => row.id), ...GLOBAL_SHORTCUTS.map(entry => entry.id)]);
  const reserved = new Set(Object.entries(bindings).filter(([id, chord]) => applicable.has(id) && chord).map(([, chord]) => chord));
  const globals = GLOBAL_SHORTCUTS.map(entry => ({ ...entry,
    chord: Object.hasOwn(bindings, entry.id) ? bindings[entry.id] : entry.key }));
  for (const entry of globals) if (entry.chord) reserved.add(entry.chord);
  const commands = rows.filter(row => row.id !== 'global:cancel');
  const order = [...commands.filter(row => visible.includes(row.command)),
    ...commands.filter(row => !visible.includes(row.command))];
  const grid = new Map();
  if (settings.profile === 'grid') {
    const free = gridKeys.filter(key => !reserved.has(key));
    for (const row of order) if (!Object.hasOwn(bindings, row.id)) grid.set(row.id, free.shift() || '');
  }
  return [...globals, ...commands.map(row => ({ ...row,
    chord: Object.hasOwn(bindings, row.id) ? bindings[row.id] : settings.profile === 'grid' ? grid.get(row.id) : row.key }))];
}

export function resolveShortcut(event, rows, settings, visible = []) {
  const mappings = activeShortcuts(rows, settings, visible);
  let matches = mappings.filter(entry => entry.chord && entry.chord === eventChord(event));
  if (!matches.length && event.shiftKey)
    matches = mappings.filter(entry => entry.chord && entry.chord === eventChord(event, true));
  return matches;
}

const exclusive = (a, b) => [['cloak', 'decloak'], ['burrow', 'unburrow'], ['lift', 'land']]
  .some(pair => pair.includes(a.id.split(':')[0]) && pair.includes(b.id.split(':')[0]) && a.id !== b.id);
export function shortcutConflicts(value, liveRows = [], visible = []) {
  const settings = validateHotkeys(value), conflicts = [], seen = new Set();
  const entries = SHORTCUT_CATALOG.map(entry => ({ ...entry, chord: Object.hasOwn(settings.bindings, entry.id)
    ? settings.bindings[entry.id] : settings.profile === 'grid' && !GLOBAL_SHORTCUTS.includes(entry)
      ? null : classicChord(entry.key) || entry.key }));
  const add = (a, b) => {
    const key = [a.id, b.id].sort().join('|');
    if (!seen.has(key)) { seen.add(key); conflicts.push({ first: a, second: b, chord: a.chord }); }
  };
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    if (!a.chord || a.chord !== b.chord || exclusive(a, b) ||
        (!Object.hasOwn(settings.bindings, a.id) && !Object.hasOwn(settings.bindings, b.id))) continue;
    if (a.scopes.includes('*') || b.scopes.includes('*') || a.scopes.some(scope => b.scopes.includes(scope))) add(a, b);
  }
  const live = activeShortcuts(liveRows, settings, visible);
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++)
    if (live[i].chord && live[i].chord === live[j].chord) add(live[i], live[j]);
  return conflicts;
}

export function activateCommand(engine, id) {
  const bytes = new TextEncoder().encode(id);
  const pointer = engine.openbw_in_ptr(bytes.length);
  new Uint8Array(engine.memory.buffer, pointer, bytes.length).set(bytes);
  engine.openbw_render(performance.now());
  const result = engine.openbw_activate_command(bytes.length);
  engine.openbw_render(performance.now());
  return result;
}

export function createHotkeyEditor({ dialog, getSettings, setSettings, getLive }) {
  const $ = id => document.getElementById(id);
  let capturing = null;
  const observed = new Map();
  const cancelCapture = () => { capturing = null; $('hotkey-capture').hidden = true; };
  const render = () => {
    const settings = getSettings(), live = getLive();
    for (const row of live.rows) if (!catalogById.has(row.id)) observed.set(row.id,
      { ...row, race: 'Selected', scopes: ['live'] });
    const conflicts = shortcutConflicts(settings, live.rows, live.visible);
    $('options-apply').disabled = !!conflicts.length || !!capturing;
    $('hotkey-conflicts').textContent = conflicts.map(conflict =>
      `${formatChord(conflict.chord)}: ${conflict.first.label} conflicts with ${conflict.second.label}.`).join('\n');
    const search = $('hotkey-search').value.toLowerCase(), category = $('hotkey-category').value;
    $('hotkey-profile').value = settings.profile;
    if ($('options-hotkeys').hidden) return;
    const list = $('hotkey-list');
    list.replaceChildren();
    const active = new Map(activeShortcuts(live.rows, settings, live.visible).map(entry => [entry.id, entry.chord]));
    for (const entry of [...SHORTCUT_CATALOG, ...observed.values()]) {
      if (category !== 'all' && entry.race !== category) continue;
      if (!`${entry.label} ${entry.context || ''} ${entry.race}`.toLowerCase().includes(search)) continue;
      const row = document.createElement('div'); row.className = 'hotkey-row';
      const description = document.createElement('div');
      const label = document.createElement('strong'); label.textContent = entry.label;
      const context = document.createElement('small'); context.textContent = entry.context || entry.race;
      description.append(label, context);
      const bind = document.createElement('button'); bind.type = 'button'; bind.dataset.shortcut = entry.id;
      const custom = Object.hasOwn(settings.bindings, entry.id);
      const binding = custom ? formatChord(settings.bindings[entry.id])
        : active.has(entry.id) ? formatChord(active.get(entry.id)) : settings.profile === 'grid' &&
          !GLOBAL_SHORTCUTS.includes(entry) ? 'Grid' : formatChord(classicChord(entry.key) || entry.key);
      bind.textContent = binding;
      bind.title = `${custom ? 'Custom' : 'Default'} shortcut: ${binding}`;
      bind.classList.toggle('custom-binding', custom);
      bind.setAttribute('aria-label', `Change shortcut for ${entry.label}`);
      bind.onclick = () => {
        capturing = entry.id; $('hotkey-capture').hidden = false;
        $('hotkey-capture-label').textContent = `Press a key for ${entry.label}.`;
        $('hotkey-capture-error').textContent = '';
        $('options-apply').disabled = true;
      };
      const tools = document.createElement('span'); tools.className = 'hotkey-tools';
      for (const action of ['Unbind', 'Reset']) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = action;
        button.setAttribute('aria-label', `${action} shortcut for ${entry.label}`);
        button.onclick = () => {
          cancelCapture();
          const bindings = { ...getSettings().bindings };
          if (action === 'Reset') delete bindings[entry.id]; else bindings[entry.id] = null;
          setSettings({ ...getSettings(), bindings }); render();
        };
        tools.append(button);
      }
      if (conflicts.some(conflict => conflict.first.id === entry.id || conflict.second.id === entry.id)) row.classList.add('conflict');
      row.append(description, bind, tools); list.append(row);
    }
    if (!list.childElementCount) list.textContent = 'No matching shortcuts.';
  };
  const focusBinding = id => {
    const button = [...$('hotkey-list').querySelectorAll('[data-shortcut]')].find(button => button.dataset.shortcut === id);
    (button || $('hotkey-search')).focus();
  };
  const finishCapture = () => {
    const id = capturing;
    cancelCapture(); render(); focusBinding(id);
  };
  const accept = chord => {
    try { validateChord(chord); }
    catch (error) { $('hotkey-capture-error').textContent = error.message; return; }
    const id = capturing;
    cancelCapture();
    setSettings({ ...getSettings(), bindings: { ...getSettings().bindings, [id]: chord } });
    render();
    focusBinding(id);
  };
  window.addEventListener('keydown', event => {
    if (!capturing || !dialog.open) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.repeat) return;
    if (event.code === 'Escape') { finishCapture(); return; }
    if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(event.code)) return;
    accept(eventChord(event));
  }, { capture: true });
  $('hotkey-capture-cancel').onclick = finishCapture;
  $('hotkey-bind-escape').onclick = () => { if (capturing) accept('Escape'); };
  $('hotkey-search').addEventListener('input', render);
  $('hotkey-category').addEventListener('change', render);
  $('hotkey-profile').addEventListener('change', () => {
    cancelCapture(); setSettings({ ...getSettings(), profile: $('hotkey-profile').value }); render();
  });
  $('hotkey-reset-all').onclick = () => {
    cancelCapture(); setSettings({ profile: 'classic', bindings: {} }); render();
  };
  return { render, cancelCapture };
}

export const shortcuts = await import('./hotkeys.js' + new URL(import.meta.url).search);
export const UI_OPTIONS_KEY = 'openbw-interface-v1';
export const DEFAULT_UI_OPTIONS = Object.freeze({
  input: 'auto', commands: 'auto', layout: 'adaptive', buildings: 'auto',
  unavailable: 'auto', scale: 100, objectives: 'collapsed', pause: 'auto',
  sound: 'menu', minimap: 100,
  hotkeys: Object.freeze({ profile: 'classic', bindings: Object.freeze({}) }),
});

const choices = {
  input: ['auto', 'touch', 'mouse'],
  commands: ['auto', 'contextual', 'full'],
  layout: ['adaptive', 'grid'],
  buildings: ['auto', 'strip', 'split'],
  unavailable: ['auto', 'hide', 'show'],
  objectives: ['expanded', 'collapsed', 'menu'],
  pause: ['auto', 'pinned', 'menu'],
  sound: ['pinned', 'menu'],
};

export function validateUIOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid interface options.');
  const result = { ...DEFAULT_UI_OPTIONS };
  for (const [key, values] of Object.entries(choices)) {
    if (value[key] !== undefined) {
      if (!values.includes(value[key])) throw new Error(`Invalid interface option: ${key}.`);
      result[key] = value[key];
    }
  }
  for (const [key, minimum, maximum] of [['scale', 75, 150], ['minimap', 50, 200]]) {
    if (value[key] !== undefined) {
      if (!Number.isInteger(value[key]) || value[key] < minimum || value[key] > maximum)
        throw new Error(`${key === 'scale' ? 'Interface' : 'Minimap'} scale must be between ${minimum}% and ${maximum}%.`);
      result[key] = value[key];
    }
  }
  result.hotkeys = shortcuts.validateHotkeys(value.hotkeys);
  return result;
}

export function resolveUIOptions(value, coarse) {
  const options = validateUIOptions(value);
  return {
    ...options,
    commands: options.commands === 'auto' ? (coarse ? 'contextual' : 'full') : options.commands,
    buildings: options.buildings === 'auto' ? (coarse ? 'strip' : 'split') : options.buildings,
    unavailable: options.unavailable === 'auto' ? (coarse ? 'hide' : 'show') : options.unavailable,
    pause: options.pause === 'auto' ? 'pinned' : options.pause,
  };
}

export function readUIOptions(storage) {
  const text = storage.getItem(UI_OPTIONS_KEY);
  const record = text === null ? { version: 1, options: {} } : JSON.parse(text);
  if (!record || record.version !== 1) throw new Error('Unsupported interface options version.');
  const options = validateUIOptions(record.options);
  if (!record.options.hotkeys) {
    const legacy = storage.getItem('openbw-alt-esc');
    if (legacy) options.hotkeys.bindings['global:alternate-cancel'] = shortcuts.validateChord(legacy);
  }
  return options;
}

export function writeUIOptions(storage, options) {
  const validated = validateUIOptions(options);
  storage.setItem(UI_OPTIONS_KEY, JSON.stringify({ version: 1, options: validated }));
  return validated;
}

export function actionButtonSize(options, coarse, width) {
  const columns = options.layout === 'grid' || options.buildings === 'split' ? 3 : 2;
  const available = Math.max(44, Math.floor((width - 40 - (columns - 1) * 4) / columns));
  return Math.min(available, Math.max(coarse ? 44 : 36,
    Math.round((coarse ? 64 : 56) * options.scale / 100)));
}

export function resourceFontSize(options, width) {
  const baseline = Math.max(14, Math.min(16, 14 + (width - 320) / 140));
  return Math.round(baseline * (1 + (options.scale - 100) / 200) * 10) / 10;
}

export function minimapSize(options, coarse, width, height) {
  const edge = Math.min(width, height);
  const baseline = coarse ? Math.max(96, Math.min(144, edge * .28))
    : Math.max(128, Math.min(192, edge * .22));
  return Math.round(Math.max(48, Math.min(edge * .45, baseline * options.minimap / 100)));
}

export function createGameMenu(onShow = () => {}) {
  const $ = id => document.getElementById(id);
  const panel = $('settings'), opener = $('settingsbtn'), content = $('settings-content');
  const titles = { root: 'Game menu', objectives: 'Objectives', save: 'Save game', controls: 'Controls', gestures: 'Touch controls', more: 'More settings' };
  let page = 'root';
  const close = (restoreFocus = false) => {
    panel.style.display = 'none';
    opener.setAttribute('aria-expanded', 'false');
    if (restoreFocus) opener.focus();
  };
  const show = (next = 'root') => {
    if (!Object.hasOwn(titles, next)) throw new Error(`Unknown game menu page: ${next}`);
    if ((next === 'objectives' && $('menu-objectives').hidden) || (next === 'save' && $('menu-save').hidden)) next = 'root';
    page = next;
    for (const section of panel.querySelectorAll('[data-menu-page]')) section.hidden = section.dataset.menuPage !== page;
    $('settings-title').textContent = titles[page];
    $('settings-back').hidden = page === 'root';
    panel.style.display = 'flex';
    panel.dataset.page = page;
    opener.setAttribute('aria-expanded', 'true');
    content.scrollTop = 0;
    onShow();
    if (page === 'objectives') $('mission-objectives').open = true;
    (page === 'root' ? $('settings-close') : $('settings-back')).focus({ preventScroll: true });
  };
  const back = () => {
    if (page === 'root') close(true);
    else {
      const previous = page;
      show(previous === 'gestures' ? 'controls' : 'root');
      panel.querySelector(`[data-menu-open="${previous}"]:not([hidden])`)?.focus({ preventScroll: true });
    }
  };
  for (const button of panel.querySelectorAll('[data-menu-open]')) {
    button.addEventListener('click', event => { event.stopPropagation(); show(button.dataset.menuOpen); });
  }
  $('settings-close').onclick = () => close(true);
  $('settings-back').onclick = back;
  opener.setAttribute('aria-controls', 'settings');
  opener.setAttribute('aria-expanded', 'false');
  panel.addEventListener('keydown', event => {
    if (event.code === 'Escape') { event.preventDefault(); event.stopPropagation(); back(); }
    if (event.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll('button, input, select, [tabindex]')]
      .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    if (!controls.length) return;
    const target = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1)
      : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : null;
    if (target) { event.preventDefault(); target.focus(); }
  });
  document.addEventListener('click', event => {
    if (event.target !== opener && !opener.contains(event.target) && !panel.contains(event.target)) close();
  });
  return {
    get isOpen() { return panel.style.display === 'flex'; },
    get page() { return page; },
    show, close, back,
    toggle() { if (this.isOpen) close(true); else show(); },
    refresh() {
      if ((page === 'objectives' && $('menu-objectives').hidden) || (page === 'save' && $('menu-save').hidden))
        if (this.isOpen) show();
    },
  };
}

export function createInterfaceOptions() {
  const $ = id => document.getElementById(id);
  const dialog = $('interface-options');
  const form = $('interface-options-form');
  const status = $('interface-options-status');
  const media = matchMedia('(pointer: coarse)');
  const compact = matchMedia('(max-width: 600px), (pointer: coarse) and (max-height: 600px)');
  const listeners = new Set();
  let saved, current, previousFocus, hooks = {}, lastObjectives, missionActive = false;
  try { saved = readUIOptions(localStorage); }
  catch (error) {
    saved = validateUIOptions({});
    status.textContent = `Saved interface options could not be loaded. Defaults are active. ${error.message}`;
    console.error('Cannot load interface options:', error);
    $('options-notice').hidden = false;
  }
  current = validateUIOptions(saved);
  const editor = shortcuts.createHotkeyEditor({
    dialog, getSettings: () => current.hotkeys,
    setSettings(value) { current = validateUIOptions({ ...current, hotkeys: value }); apply(); },
    getLive: () => hooks.shortcuts?.() || { rows: [], visible: [] },
  });

  const resolved = () => resolveUIOptions(current, media.matches);
  const refreshHUD = () => {
    document.body.style.setProperty('--resource-font', `${resourceFontSize(current, innerWidth)}px`);
    const edge = $('topbar').getBoundingClientRect().right;
    const right = parseFloat(getComputedStyle($('resources')).right);
    document.body.style.setProperty('--resources-room', `${Math.max(100, innerWidth - edge - right - 8)}px`);
    document.body.style.setProperty('--resources-bottom', `${$('resources').getBoundingClientRect().bottom + 8}px`);
  };
  const apply = () => {
    const options = resolved();
    const body = document.body;
    body.dataset.commands = options.commands;
    body.dataset.commandLayout = options.layout;
    body.dataset.buildings = options.buildings;
    body.dataset.objectives = options.objectives;
    body.dataset.pause = options.pause;
    const soundDock = options.sound === 'pinned' ? $('topbar') : $('sound-dock');
    if ($('mute').parentElement !== soundDock) soundDock.append($('mute'));
    const objectivesDock = options.objectives === 'menu' ? $('settings-objectives') : $('hud-objectives-dock');
    if ($('mission-objectives').parentElement !== objectivesDock) objectivesDock.append($('mission-objectives'));
    $('settings-objectives').hidden = !missionActive || options.objectives !== 'menu';
    $('menu-objectives').hidden = !missionActive || options.objectives !== 'menu';
    body.style.setProperty('--ui-scale', options.scale / 100);
    const size = actionButtonSize(options, media.matches, innerWidth);
    body.style.setProperty('--action-size', `${size}px`);
    body.style.setProperty('--action-icon', `${Math.round(size * .55)}px`);
    refreshHUD();
    if (lastObjectives !== options.objectives) {
      $('mission-objectives').open = options.objectives !== 'collapsed';
      lastObjectives = options.objectives;
    }
    for (const listener of listeners) listener(options);
  };
  const populate = () => {
    for (const control of form.querySelectorAll('[data-preference]'))
      control.value = current[control.dataset.preference];
    $('ui-scale-value').value = `${current.scale}%`;
    $('minimap-scale-value').value = `${current.minimap}%`;
    editor.render();
  };
  const close = () => {
    editor.cancelCapture();
    current = validateUIOptions(saved);
    apply();
    dialog.close();
    hooks.close?.();
    const visible = element => element?.getClientRects().length && element.matches('button, a, input, select, textarea, [tabindex]');
    const target = [previousFocus, $('settingsbtn'), $('start-menu-toggle'),
      document.querySelector('#start-navigation [data-options-open]')].find(visible);
    target?.focus();
  };
  const open = () => {
    if (dialog.open) return;
    current = validateUIOptions(saved);
    if (compact.matches && dialog.dataset.page === 'hotkeys') $('tab-controls').click();
    populate();
    previousFocus = document.activeElement;
    $('start-navigation').classList.remove('is-open');
    $('start-menu-toggle').setAttribute('aria-expanded', 'false');
    hooks.open?.();
    dialog.showModal();
  };
  for (const button of document.querySelectorAll('[data-options-open]')) {
    button.addEventListener('click', event => { event.stopPropagation(); open(); });
  }
  $('start-menu-toggle').onclick = () => {
    const expanded = $('start-navigation').classList.toggle('is-open');
    $('start-menu-toggle').setAttribute('aria-expanded', String(expanded));
  };
  for (const button of document.querySelectorAll('[data-start-mode]')) {
    button.onclick = () => {
      $(`mode-${button.dataset.startMode}`).click();
      $('start-navigation').classList.remove('is-open');
      $('start-menu-toggle').setAttribute('aria-expanded', 'false');
    };
  }
  for (const button of dialog.querySelectorAll('[data-options-tab]')) {
    button.onclick = () => {
      if (button.dataset.optionsTab !== 'hotkeys') editor.cancelCapture();
      for (const tab of dialog.querySelectorAll('[data-options-tab]')) {
        const selected = tab === button;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        $(`options-${tab.dataset.optionsTab}`).hidden = !selected;
      }
      dialog.dataset.page = button.dataset.optionsTab;
      $('options-back').hidden = !compact.matches || button.dataset.optionsTab !== 'hotkeys';
      $('interface-options-title').textContent = compact.matches && button.dataset.optionsTab === 'hotkeys'
        ? 'Keyboard shortcuts' : 'Interface Options';
      const content = dialog.querySelector('.options-content');
      content.scrollTop = 0;
      editor.render();
    };
    button.addEventListener('keydown', event => {
      const tabs = [...dialog.querySelectorAll('[data-options-tab]')].filter(tab => tab.getClientRects().length);
      let next;
      if (event.key === 'ArrowRight') next = (tabs.indexOf(button) + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (tabs.indexOf(button) + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[next].click();
      tabs[next].focus();
    });
  }
  $('options-keyboard').onclick = () => { $('tab-hotkeys').click(); $('hotkey-search').focus(); };
  $('options-back').onclick = () => { $('tab-controls').click(); $('options-keyboard').focus(); };
  compact.addEventListener('change', () => {
    const tab = dialog.querySelector('[data-options-tab][aria-selected="true"]');
    if (tab) tab.click();
  });
  form.addEventListener('input', event => {
    const control = event.target.closest('[data-preference]');
    if (!control) return;
    current = validateUIOptions({
      ...current, [control.dataset.preference]: control.type === 'range' ? Number(control.value) : control.value,
    });
    $('ui-scale-value').value = `${current.scale}%`;
    $('minimap-scale-value').value = `${current.minimap}%`;
    apply();
    editor.render();
  });
  for (const button of dialog.querySelectorAll('[data-scale]')) {
    button.onclick = () => {
      current.scale = Number(button.dataset.scale);
      populate();
      apply();
    };
  }
  $('options-reset').onclick = () => {
    editor.cancelCapture();
    current = validateUIOptions({});
    populate();
    apply();
  };
  $('options-cancel').onclick = close;
  $('options-close').onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  window.addEventListener('keydown', event => {
    if (!dialog.open || event.code !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }, { capture: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const live = hooks.shortcuts?.() || { rows: [], visible: [] };
    if (shortcuts.shortcutConflicts(current.hotkeys, live.rows, live.visible).length) {
      status.textContent = 'Resolve the conflicting shortcuts before applying.';
      $('tab-hotkeys').click();
      editor.render();
      return;
    }
    try { saved = writeUIOptions(localStorage, current); }
    catch (error) {
      status.textContent = `Options could not be saved. ${error.message}`;
      console.error('Cannot save interface options:', error);
      return;
    }
    status.textContent = '';
    $('options-notice').hidden = true;
    close();
  });
  media.addEventListener('change', apply);
  addEventListener('resize', apply);
  populate();
  apply();
  return {
    get preferences() { return { ...current }; },
    get resolved() { return resolved(); },
    get open() { return dialog.open; },
    get minimapSize() { return minimapSize(current, media.matches, innerWidth, innerHeight); },
    show(tab) { open(); if (tab) $(`tab-${tab}`).click(); },
    setMissionActive(active) { missionActive = active; apply(); },
    refreshHUD,
    subscribe(listener) { listeners.add(listener); },
    setGameHooks(value) { hooks = value; },
  };
}

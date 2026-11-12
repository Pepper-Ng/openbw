export const UI_OPTIONS_KEY = 'openbw-interface-v1';
export const DEFAULT_UI_OPTIONS = Object.freeze({
  input: 'auto', commands: 'auto', layout: 'adaptive', buildings: 'auto',
  unavailable: 'auto', scale: 100, objectives: 'collapsed', pause: 'auto',
  sound: 'menu', minimap: 100,
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
  if (text === null) return { ...DEFAULT_UI_OPTIONS };
  const record = JSON.parse(text);
  if (!record || record.version !== 1) throw new Error('Unsupported interface options version.');
  return validateUIOptions(record.options);
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

export function createInterfaceOptions() {
  const $ = id => document.getElementById(id);
  const dialog = $('interface-options');
  const form = $('interface-options-form');
  const status = $('interface-options-status');
  const media = matchMedia('(pointer: coarse)');
  const listeners = new Set();
  let saved, current, previousFocus, hooks = {}, lastObjectives;
  try { saved = readUIOptions(localStorage); }
  catch (error) {
    saved = { ...DEFAULT_UI_OPTIONS };
    status.textContent = `Saved interface options could not be loaded. Defaults are active. ${error.message}`;
    console.error('Cannot load interface options:', error);
    $('options-notice').hidden = false;
  }
  current = { ...saved };

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
    body.style.setProperty('--ui-scale', options.scale / 100);
    const size = actionButtonSize(options, media.matches, innerWidth);
    body.style.setProperty('--action-size', `${size}px`);
    body.style.setProperty('--action-icon', `${Math.round(size * .55)}px`);
    refreshHUD();
    if (lastObjectives !== options.objectives) {
      $('mission-objectives').open = options.objectives === 'expanded';
      body.classList.remove('peek-objectives');
      lastObjectives = options.objectives;
    }
    for (const listener of listeners) listener(options);
  };
  const populate = () => {
    for (const control of form.querySelectorAll('[data-preference]'))
      control.value = current[control.dataset.preference];
    $('ui-scale-value').value = `${current.scale}%`;
    $('minimap-scale-value').value = `${current.minimap}%`;
  };
  const close = () => {
    current = { ...saved };
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
    current = { ...saved };
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
      for (const tab of dialog.querySelectorAll('[data-options-tab]')) {
        const selected = tab === button;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        $(`options-${tab.dataset.optionsTab}`).hidden = !selected;
      }
    };
    button.addEventListener('keydown', event => {
      const tabs = [...dialog.querySelectorAll('[data-options-tab]')];
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
  form.addEventListener('input', event => {
    const control = event.target.closest('[data-preference]');
    if (!control) return;
    current = validateUIOptions({
      ...current, [control.dataset.preference]: control.type === 'range' ? Number(control.value) : control.value,
    });
    $('ui-scale-value').value = `${current.scale}%`;
    $('minimap-scale-value').value = `${current.minimap}%`;
    apply();
  });
  for (const button of dialog.querySelectorAll('[data-scale]')) {
    button.onclick = () => {
      current.scale = Number(button.dataset.scale);
      populate();
      apply();
    };
  }
  $('options-reset').onclick = () => {
    current = { ...DEFAULT_UI_OPTIONS };
    populate();
    apply();
  };
  $('options-cancel').onclick = close;
  $('options-close').onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
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
  $('mission-objectives').addEventListener('toggle', () => {
    if (!$('mission-objectives').open) document.body.classList.remove('peek-objectives');
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
    refreshHUD,
    subscribe(listener) { listeners.add(listener); },
    setGameHooks(value) { hooks = value; },
  };
}

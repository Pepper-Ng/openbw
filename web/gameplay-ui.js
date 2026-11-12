const kind = row => row?.command.split(':')[0];
const abilityFamily = row => {
  const action = kind(row);
  if (['siege', 'unsiege'].includes(action)) return 'siege';
  if (['cloak', 'decloak'].includes(action)) return 'cloak';
  if (['burrow', 'unburrow'].includes(action)) return 'burrow';
  return row?.command;
};
const abilityPriority = ['siege', 'unsiege', 'stim', 'spell', 'cloak', 'decloak', 'burrow', 'unburrow',
  'fighter', 'unload-all', 'archon', 'dark-archon', 'morph'];

export function compactCommandsEnabled(options, mobile, cursor, context) {
  return mobile && options.commands === 'contextual' && options.layout === 'adaptive' &&
    (cursor === 0 || cursor === 3) && context.split('\t')[1] === '0';
}

export function createCompactCommands() {
  const contexts = new Map();
  return (rows, context) => {
    if (!rows.some(row => kind(row) === 'move')) return null;
    const worker = rows.some(row => kind(row) === 'build-menu');
    const take = action => rows.find(row => kind(row) === action) || null;
    const primary = worker ? [take('attack'), take('build-menu'), take('stop')]
      : [take('attack'), take('hold'), take('stop')];
    if (!worker) {
      const abilities = rows.filter(row => abilityPriority.includes(kind(row)))
        .sort((a, b) => abilityPriority.indexOf(kind(a)) - abilityPriority.indexOf(kind(b)));
      const slots = contexts.get(context) || [];
      for (const ability of abilities) {
        const family = abilityFamily(ability);
        if (slots.length < 2 && !slots.includes(family)) slots.push(family);
      }
      contexts.set(context, slots);
      for (let index = 0; index < 2; index++)
        primary.push(abilities.find(row => abilityFamily(row) === slots[index]) || null);
    }
    const ids = new Set(primary.filter(Boolean).map(row => row.command));
    const secondary = rows.filter(row => !ids.has(row.command));
    return { worker, primary: [...primary, null], secondary };
  };
}

export function createObjectiveUpdates() {
  let text = null, unread = false;
  return {
    get unread() { return unread; },
    update(next, { viewed = false, recovering = false } = {}) {
      const changed = text !== null && !!text.trim() && next !== text;
      text = next;
      if (viewed || recovering) unread = false;
      else if (changed) unread = true;
      return { changed, unread, announce: changed && !recovering && !viewed };
    },
    acknowledge() { unread = false; },
  };
}

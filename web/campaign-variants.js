export const campaignVariants = Object.freeze({
  bwterran05: Object.freeze({
    previous: 'bwterran04',
    variants: Object.freeze([
      Object.freeze({ assetId: 'bwterran05a', scenario: 'Terran05a.scx', label: 'Ground Zero' }),
      Object.freeze({ assetId: 'bwterran05b', scenario: 'Terran05b.scx', label: 'Birds of War' }),
    ]),
  }),
  bwzerg04: Object.freeze({
    previous: 'bwzerg03',
    variants: Object.freeze([
      Object.freeze({ assetId: 'bwzerg04a', scenario: 'Zerg04a.scx', label: '0 infested Command Centers' }),
      Object.freeze({ assetId: 'bwzerg04b', scenario: 'Zerg04b.scx', label: '1 infested Command Center' }),
      Object.freeze({ assetId: 'bwzerg04c', scenario: 'Zerg04c.scx', label: '2 infested Command Centers' }),
      Object.freeze({ assetId: 'bwzerg04d', scenario: 'Zerg04d.scx', label: '3 infested Command Centers' }),
      Object.freeze({ assetId: 'bwzerg04e', scenario: 'Zerg04e.scx', label: '4 infested Command Centers' }),
      Object.freeze({ assetId: 'bwzerg04f', scenario: 'Zerg04f.scx', label: '5 infested Command Centers' }),
    ]),
  }),
});

export function resolveCampaignMission(id, scenario = '') {
  if (typeof id !== 'string' || typeof scenario !== 'string') throw new Error('Invalid campaign mission selection.');
  for (const [missionId, fork] of Object.entries(campaignVariants)) {
    const pinned = fork.variants.find(variant => variant.assetId === id);
    if (pinned) {
      if (scenario && scenario.toLowerCase() !== pinned.scenario.toLowerCase()) throw new Error('Campaign variant mismatch.');
      return { missionId, ...pinned };
    }
    if (id === missionId) {
      const selected = scenario ? fork.variants.find(variant => variant.scenario.toLowerCase() === scenario.toLowerCase()) : fork.variants[0];
      if (!selected) throw new Error('Unsupported campaign variant.');
      return { missionId, ...selected };
    }
  }
  if (scenario) throw new Error('This campaign mission has no variants.');
  return { missionId: id, assetId: id, scenario: '', label: '' };
}

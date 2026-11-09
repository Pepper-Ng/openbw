// Node WASI runner for the WebAssembly sim bring-up test (web/sim.wasm).
// Preopens the local game data + maps so the wasm's WASI file reads resolve.
//   node web/run-sim.mjs            (run from repo root)
import { WASI } from 'node:wasi';
import { readFileSync } from 'node:fs';
import { argv } from 'node:process';

const combatAI = argv[2] === '--test-ai-combat';
const campaign = argv[2] === '--test-campaign' || combatAI;
const missionId = campaign ? combatAI ? 'terran01' : argv[3] || 'terran01' : null;
if (campaign && !['terran01', 'terran02', 'terran03', 'terran04', 'terran05', 'terran06', 'terran07', 'terran08', 'terran09', 'terran10', 'zerg01', 'zerg02', 'zerg03', 'zerg04', 'zerg05', 'zerg06', 'zerg07', 'zerg08', 'zerg09', 'zerg10', 'protoss01', 'protoss02', 'protoss03', 'protoss04'].includes(missionId)) throw new Error('Unsupported test mission');
const map = campaign ? `/data/campaign/${missionId}.mpq` : argv[2] || '/maps/Benzene.scx';

const wasi = new WASI({
  version: 'preview1',
  args: ['sim', '/data', map, ...(combatAI ? ['--test-ai-combat'] : campaign ? ['--test-campaign', missionId] : [])],
  preopens: { '/data': 'web/data', '/maps': 'web/maps' },
});

const bytes = readFileSync('web/sim.wasm');
const module = await WebAssembly.compile(bytes);
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
wasi.start(instance);

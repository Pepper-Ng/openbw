// Node WASI runner for the WebAssembly sim bring-up test (web/sim.wasm).
// Preopens the local game data + maps so the wasm's WASI file reads resolve.
//   node web/run-sim.mjs            (run from repo root)
import { WASI } from 'node:wasi';
import { readFileSync } from 'node:fs';
import { argv } from 'node:process';

const campaign = argv[2] === '--test-campaign';
const map = campaign ? '/data/campaign/terran01.mpq' : argv[2] || '/maps/Benzene.scx';

const wasi = new WASI({
  version: 'preview1',
  args: ['sim', '/data', map, ...(campaign ? ['--test-campaign'] : [])],
  preopens: { '/data': 'web/data', '/maps': 'web/maps' },
});

const bytes = readFileSync('web/sim.wasm');
const module = await WebAssembly.compile(bytes);
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
wasi.start(instance);

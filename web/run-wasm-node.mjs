// Headless verification of the browser wasm code path (web/openbw.wasm) under
// Node's WASI. Provides the env.js_read_data / js_file_size file bridge backed
// by the local MPQs + map, runs init + a few ticks, and dumps the rendered
// framebuffer to a PPM — proving wasm_backend.cpp renders correctly.
//
//   node web/run-wasm-node.mjs out.ppm
import { WASI } from 'node:wasi';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const out = process.argv[2] === '--test-commands' ? null : process.argv[2] || 'wasm-shot.ppm';

// Archive index mapping must match wasm_main.cpp's js_file_reader.
const files = [
  readFileSync('web/data/STARDAT.MPQ'),
  readFileSync('web/data/BROODAT.MPQ'),
  readFileSync('web/data/patch_rt.mpq'),
  readFileSync('web/maps/Weave_v1.scx'),
];

const wasi = new WASI({ version: 'preview1', args: ['openbw'], preopens: {} });

let memory;
const env = {
  js_file_size: (index) => files[index].length,
  js_read_data: (index, dst, offset, n) => {
    const mem = new Uint8Array(memory.buffer);
    mem.set(files[index].subarray(offset, offset + n), dst);
  },
  // no audio in headless Node — stubs so instantiation doesn't fail
  js_sound_load: () => -1, js_sound_play: () => {}, js_sound_is_playing: () => 0,
  js_sound_stop: () => {}, js_sound_set_volume: () => {},
};

const module = await WebAssembly.compile(readFileSync('web/openbw.wasm'));
const instance = await WebAssembly.instantiate(module, {
  ...wasi.getImportObject(),
  env,
});
memory = instance.exports.memory;
wasi.initialize(instance);   // reactor: runs ctors + libc init

const x = instance.exports;
x.openbw_init(1280, 800, 1 /*terran*/, 0 /*slot*/);
for (let i = 0; i < 4; i++) x.openbw_step();
x.openbw_render(0);

if (out) {
  const w = x.openbw_framebuffer_width();
  const h = x.openbw_framebuffer_height();
  const ptr = x.openbw_framebuffer();
  const fb = new Uint8Array(memory.buffer, ptr, w * h * 4);

  // RGBA -> PPM (P6)
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  const body = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++) {
    body[j++] = fb[i * 4 + 0];
    body[j++] = fb[i * 4 + 1];
    body[j++] = fb[i * 4 + 2];
  }
  writeFileSync(out, Buffer.concat([header, body]));
  console.log(`wrote ${out} (${w}x${h})`);
} else {
  testCommands();
}

function testCommands() {
  const read = (pointer) => {
    const bytes = new Uint8Array(memory.buffer);
    let end = pointer;
    while (bytes[end]) end++;
    return new TextDecoder().decode(bytes.subarray(pointer, end));
  };
  const units = () => read(x.openbw_debug_units()).trim().split('\n').map(line => line.split('\t'));
  const records = () => {
    const bytes = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len());
    const result = [];
    for (let offset = 0; offset < bytes.length;) {
      const length = bytes[offset] | bytes[offset + 1] << 8;
      offset += 2;
      result.push(Array.from(bytes.subarray(offset, offset + length)));
      offset += length;
    }
    return result;
  };
  const apply = () => {
    const bytes = new Uint8Array(memory.buffer, x.openbw_out_ptr(), x.openbw_out_len()).slice();
    const pointer = x.openbw_in_ptr(bytes.length);
    new Uint8Array(memory.buffer).set(bytes, pointer);
    x.openbw_apply(0, bytes.length);
    x.openbw_out_clear();
  };
  const press = (symbol, scancode = 0) => {
    x.openbw_key(1, symbol, scancode);
    x.openbw_key(0, symbol, scancode);
  };
  const worker = units().find(unit => unit[1] === 'SCV');
  const building = units().find(unit => unit[1] === 'Command Center');
  assert.ok(worker && building);
  x.openbw_debug_select(Number(worker[0]), 0);
  x.openbw_mouse_move(-1, -1);
  x.openbw_render(0);

  for (const shift of [225, 229]) {
    for (const releaseBeforeRender of [false, true]) {
      x.openbw_out_clear();
      x.openbw_key(1, 0, shift);
      press(104, 11);
      if (releaseBeforeRender) x.openbw_key(0, 0, shift);
      x.openbw_render(0);
      assert.deepEqual(records().find(record => record[0] === 43), [43, 1]);
      if (!releaseBeforeRender) {
        x.openbw_key(0, 0, shift);
        x.openbw_render(0);
      }
    }
  }
  x.openbw_out_clear();
  press(104, 11);
  x.openbw_render(0);
  assert.deepEqual(records().find(record => record[0] === 43), [43, 0]);

  x.openbw_out_clear();
  x.openbw_key(1, 0, 225);
  x.openbw_mouse_button(1, 3, 200, 100, 1);
  x.openbw_mouse_button(0, 3, 200, 100, 1);
  x.openbw_key(0, 0, 225);
  x.openbw_render(0);
  assert.equal(records().find(record => record[0] === 20)?.at(-1), 1);

  x.openbw_key(1, 0, 224);
  press(49, 30);
  x.openbw_key(0, 0, 224);
  x.openbw_render(0);
  x.openbw_debug_select(Number(building[0]), 0);
  press(49, 30);
  x.openbw_render(0);
  assert.match(read(x.openbw_debug_dump()), /unit=SCV owner=0/);

  x.openbw_out_clear();
  press(98);
  x.openbw_render(0);
  assert.equal(read(x.openbw_card()).split('\t')[0], 'Build');
  press(0, 41);
  x.openbw_render(0);
  assert.equal(records().length, 0);
  assert.equal(read(x.openbw_card()).split('\t')[0], 'SCV');

  x.openbw_debug_select(Number(building[0]), 0);
  x.openbw_debug_resources(1000, 1000);
  for (let index = 0; index < 3; index++) press(115, 22);
  x.openbw_render(0);
  apply();
  for (let frame = 0; frame < 60; frame++) x.openbw_step();
  x.openbw_render(0);
  const before = read(x.openbw_status()).split('\t');
  const progress = Number(before[0]);
  assert.equal(before.length - 1, 3);
  assert.ok(progress > 0);
  for (const slot of [2, 1, 0]) {
    press(0, 41);
    x.openbw_render(0);
    assert.deepEqual(records().find(record => record[0] === 32), [32, slot, 0]);
    apply();
    x.openbw_render(0);
    const status = read(x.openbw_status());
    assert.equal(status ? status.split('\t').length - 1 : 0, slot);
    if (slot) assert.equal(Number(status.split('\t')[0]), progress);
    assert.equal(Number(read(x.openbw_resources()).split('\t')[0]), 1000 - slot * 50);
  }

  const word = value => [value & 255, value >> 8 & 255];
  const send = (unit, command) => {
    const bytes = Uint8Array.from([[9, 1, ...word(Number(unit[0]))], command]
      .flatMap(record => [...word(record.length), ...record]));
    const pointer = x.openbw_in_ptr(bytes.length);
    new Uint8Array(memory.buffer).set(bytes, pointer);
    x.openbw_apply(0, bytes.length);
  };
  const advance = (frames) => {
    for (let frame = 0; frame < frames; frame++) x.openbw_step();
  };
  const buildNearBase = (type, name) => {
    for (const [offsetX, offsetY] of [[160, 96], [-160, 96], [160, -96], [-160, -96],
                                    [256, 0], [-256, 0], [0, 192], [0, -192]]) {
      const tileX = Math.round((Number(building[3]) + offsetX - 64) / 32);
      const tileY = Math.round((Number(building[4]) + offsetY - 48) / 32);
      if (tileX < 0 || tileY < 0 || tileX + 4 > x.openbw_map_w() || tileY + 3 > x.openbw_map_h()) continue;
      send(worker, [12, 30, ...word(tileX), ...word(tileY), ...word(type)]);
      advance(2400);
      const placed = units().find(unit => unit[1] === name);
      if (placed) return placed;
    }
    assert.fail(`Could not construct ${name} for the command test`);
  };

  x.openbw_debug_resources(10000, 10000);
  const barracks = buildNearBase(111, 'Barracks');
  x.openbw_debug_select(Number(barracks[0]), 0);
  press(109);
  press(109);
  x.openbw_render(0);
  apply();
  advance(60);
  x.openbw_render(0);
  assert.equal(read(x.openbw_status()).split('\t').length - 1, 2);
  for (const slot of [1, 0]) {
    press(0, 41);
    x.openbw_render(0);
    assert.deepEqual(records().find(record => record[0] === 32), [32, slot, 0]);
    apply();
    x.openbw_render(0);
    const status = read(x.openbw_status());
    assert.equal(status ? status.split('\t').length - 1 : 0, slot);
  }

  const factory = buildNearBase(113, 'Factory');
  const addonX = (Number(factory[3]) - 64) / 32 + 4;
  const addonY = (Number(factory[4]) - 48) / 32 + 1;
  send(factory, [12, 36, ...word(addonX), ...word(addonY), ...word(120)]);
  advance(1200);
  const shop = units().find(unit => unit[1] === 'Machine Shop');
  assert.ok(shop, 'Machine Shop must complete before training a tank');
  send(shop, [48, 5]);
  send(factory, [31, 5, 0]);
  advance(2400);
  const tank = units().find(unit => unit[1] === 'Siege Tank');
  assert.ok(tank, 'Factory must train a tank');
  x.openbw_debug_select(Number(tank[0]), 0);
  x.openbw_render(0);
  assert.match(read(x.openbw_card()), /\no\tSiege Mode\t1/);
  const targetX = Number(tank[3]) + (Number(tank[3]) < 1024 ? 160 : -160);
  send(tank, [21, ...word(targetX), ...word(Number(tank[4])), 0, 0, 228, 0, 6, 0]);
  assert.match(read(x.openbw_debug_dump()), /order=6 /);
  x.openbw_out_clear();
  x.openbw_key(1, 0, 225);
  press(111, 18);
  x.openbw_key(0, 0, 225);
  x.openbw_render(0);
  assert.deepEqual(records().find(record => record[0] === 38), [38, 1]);
  apply();
  assert.match(read(x.openbw_debug_dump()), /order=6 /, 'Queued Siege Mode must not interrupt Move');
  advance(2400);
  x.openbw_render(0);
  assert.match(read(x.openbw_card()), /\no\tTank Mode\t1/, 'Tank must siege after finishing Move');
  for (const [opcode, queued, expectedOrder] of [[37, 0, 99], [38, 1, 98], [37, 1, 99]]) {
    x.openbw_out_clear();
    x.openbw_key(queued, 0, 225);
    press(111, 18);
    x.openbw_key(0, 0, 225);
    x.openbw_render(0);
    assert.deepEqual(records().find(record => record[0] === opcode), [opcode, queued]);
    apply();
    assert.match(read(x.openbw_debug_dump()), new RegExp(`order=${expectedOrder} `));
    advance(240);
    x.openbw_render(0);
  }
  send(tank, [21, ...word(Number(tank[3])), ...word(Number(tank[4])), 0, 0, 228, 0, 6, 0]);
  assert.match(read(x.openbw_debug_dump()), /order=6 /);
  x.openbw_out_clear();
  press(111, 18);
  x.openbw_render(0);
  assert.deepEqual(records().find(record => record[0] === 38), [38, 0]);
  apply();
  assert.match(read(x.openbw_debug_dump()), /order=98 /, 'Unmodified O must still interrupt Move');
  console.log('Command checks passed: queued hotkeys/clicks, Ctrl groups, submenu Escape, SCV/Marine cancellation, refunds and queued/immediate/idle tank modes.');
}

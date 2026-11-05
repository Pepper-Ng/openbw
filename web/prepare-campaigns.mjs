import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { campaignMissions, campaignSource, prepare } from './prepare-campaign.mjs';

async function verifySource(file, source) {
  assert.equal(statSync(file).size, source.bytes, 'Campaign source size mismatch');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest('hex'), source.sha256, 'Campaign source checksum mismatch');
}

export async function ensureSource(directory, source = campaignSource) {
  assert.equal(basename(source.file), source.file, 'Invalid campaign source filename');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, source.file);
  if (existsSync(file)) {
    await verifySource(file, source);
    return file;
  }
  const temporary = `${file}.download`;
  rmSync(temporary, { force: true });
  try {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    assert.ok(response.ok && response.body, `Campaign source HTTP ${response.status}`);
    let bytes = 0;
    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > source.bytes) return callback(new Error('Campaign source exceeds expected size'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { mode: 0o600 }));
    assert.equal(bytes, source.bytes, 'Campaign source size mismatch');
    assert.equal(hash.digest('hex'), source.sha256, 'Campaign source checksum mismatch');
    renameSync(temporary, file);
    return file;
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function prepareAll() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = resolve(root, 'web/data');
  const source = { ...campaignSource, url: process.env.OPENBW_CAMPAIGN_SOURCE_URL || campaignSource.url };
  const url = new URL(source.url);
  assert.equal(url.protocol, 'https:', 'Campaign source requires HTTPS');
  assert.ok(!url.username && !url.password, 'Campaign source URL must not contain credentials');
  console.log('Preparing campaign assets from the verified private source archive.');
  await ensureSource(directory, source);
  const output = resolve(process.env.OPENBW_CAMPAIGN_PUBLIC_DIR || '/usr/share/nginx/html/data/campaign');
  mkdirSync(output, { recursive: true });
  for (const mission of campaignMissions) {
    await prepare(mission);
    for (const extension of ['mpq', 'json']) {
      const name = `${mission}.${extension}`;
      const target = resolve(output, name);
      copyFileSync(resolve(directory, 'campaign', name), `${target}.tmp`);
      renameSync(`${target}.tmp`, target);
    }
  }
  console.log(`Campaign assets ready: ${campaignMissions.length} verified missions.`);
}

async function testSource() {
  const bytes = Buffer.from('Synthetic owned campaign source fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const directory = mkdtempSync(resolve(tmpdir(), 'openbw-campaign-source-'));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/missing') { response.writeHead(404); response.end(); return; }
    response.end(request.url === '/truncated' ? bytes.subarray(0, 4) : request.url === '/large' ? Buffer.concat([bytes, bytes]) : request.url === '/wrong' ? Buffer.alloc(bytes.length) : bytes);
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const url = `http://127.0.0.1:${server.address().port}`;
  const source = { file: 'source.mpq', bytes: bytes.length, sha256: hash, url: `${url}/ok` };
  try {
    const file = await ensureSource(resolve(directory, 'good'), source);
    assert.deepEqual(readFileSync(file), bytes);
    await ensureSource(resolve(directory, 'good'), source);
    assert.equal(requests, 1, 'Validated private source must be reused without downloading again');
    for (const name of ['missing', 'truncated', 'large', 'wrong']) {
      const output = resolve(directory, name);
      await assert.rejects(() => ensureSource(output, { ...source, url: `${url}/${name}` }), /HTTP|size|checksum/);
      assert.equal(existsSync(resolve(output, source.file)), false);
      assert.equal(existsSync(resolve(output, `${source.file}.download`)), false);
    }
    writeFileSync(file, Buffer.alloc(bytes.length));
    await assert.rejects(() => ensureSource(resolve(directory, 'good'), source), /checksum/);
    assert.deepEqual(readFileSync(file), Buffer.alloc(bytes.length), 'An invalid existing user source must not be overwritten');
    console.log('Campaign source download, bounds, checksum, cache and cleanup checks passed.');
  } finally {
    await new Promise(resolveClosed => server.close(resolveClosed));
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--test') await testSource();
  else await prepareAll();
}
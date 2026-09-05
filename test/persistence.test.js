import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createArtifact } from '../src/index.js';
import { DurableReleaseStore } from '../src/persistence.js';

async function tempStateFile(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronos-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'release-state.json');
}

test('release state survives process-style store recreation', async (t) => {
  const file = await tempStateFile(t);
  const artifact = createArtifact({ app: 'shop', version: '1.0.0', target: 'web', files: [{ path: 'index.js', content: 'ok' }] });
  const first = await new DurableReleaseStore(file).initialize();
  await first.putArtifact(artifact, 'builder');
  const release = await first.createRelease({ artifactDigest: artifact.digest, environment: { name: 'production' }, actor: 'deployer' });
  await first.recordHealth(release.id, { healthy: true, healthyPercent: 100 });
  await first.promote(release.id, 100, 'deployer');

  const restarted = await new DurableReleaseStore(file).initialize();
  const active = await restarted.channel('production');
  assert.equal(active.id, release.id);
  assert.equal(active.status, 'active');
  assert.equal(await restarted.verifyIntegrity(), true);
});

test('rollback survives durable state and restores previous release', async (t) => {
  const file = await tempStateFile(t);
  const store = await new DurableReleaseStore(file).initialize();
  const a1 = createArtifact({ app: 'api', version: '1.0.0', target: 'server', files: [{ path: 'app', content: 'v1' }] });
  const a2 = createArtifact({ app: 'api', version: '1.1.0', target: 'server', files: [{ path: 'app', content: 'v2' }] });
  await store.putArtifact(a1); await store.putArtifact(a2);
  const r1 = await store.createRelease({ artifactDigest: a1.digest, environment: { name: 'production' } });
  await store.recordHealth(r1.id, { healthy: true }); await store.promote(r1.id);
  const r2 = await store.createRelease({ artifactDigest: a2.digest, environment: { name: 'production' } });
  await store.recordHealth(r2.id, { healthy: true }); await store.promote(r2.id);
  const restored = await store.rollback('production');
  assert.equal(restored.id, r1.id);
  assert.equal((await store.channel('production')).id, r1.id);
  assert.equal(await store.verifyIntegrity(), true);
});

test('state checksum detects tampering', async (t) => {
  const file = await tempStateFile(t);
  await new DurableReleaseStore(file).initialize();
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.state.channels['production:stable'] = 'forged';
  await fs.writeFile(file, JSON.stringify(raw), 'utf8');
  const restarted = new DurableReleaseStore(file);
  await assert.rejects(() => restarted.channel('production'), /checksum mismatch/);
});

test('concurrent durable mutations serialize without losing artifacts', async (t) => {
  const file = await tempStateFile(t);
  const store = await new DurableReleaseStore(file, { retryMs: 5 }).initialize();
  const artifacts = Array.from({ length: 12 }, (_, index) => createArtifact({ app: 'bulk', version: `1.0.${index}`, target: 'web', files: [{ path: 'x', content: String(index) }] }));
  await Promise.all(artifacts.map((artifact) => store.putArtifact(artifact)));
  const state = await store.store.load();
  assert.equal(Object.keys(state.artifacts).length, artifacts.length);
  assert.equal(await store.verifyIntegrity(), true);
});

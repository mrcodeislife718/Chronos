import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifact } from '../src/index.js';
import { DurableReleaseStore } from '../src/persistence.js';
import { ChronosDisasterRecovery } from '../src/release-disaster-recovery.js';

test('Chronos rebuilds release control-plane state from the last valid disaster checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronos-release-dr-'));
  const stateFile = path.join(root, 'state', 'chronos.json');
  const recoveryRoot = path.join(root, 'recovery');
  try {
    const store = new DurableReleaseStore(stateFile);
    await store.initialize();
    const artifact = createArtifact({ app: 'demo', version: '1.0.0', target: 'linux-x64', files: [{ path: 'app.js', content: 'ok' }] });
    await store.putArtifact(artifact, 'test');
    const release = await store.createRelease({ artifactDigest: artifact.digest, environment: { name: 'production', replicas: 2 }, channel: 'stable', actor: 'test' });
    await store.recordHealth(release.id, { healthy: true, healthyPercent: 100 }, 'test');
    await store.promote(release.id, 100, 'test');

    const dr = new ChronosDisasterRecovery(stateFile, recoveryRoot);
    await dr.checkpoint();
    assert.equal(await dr.verifyPrimary(), true);

    await fs.writeFile(stateFile, '{broken');
    await assert.rejects(() => store.channel('production', 'stable'), /not valid JSON/);

    await dr.restoreLatest();
    const reopened = new DurableReleaseStore(stateFile);
    await reopened.initialize();
    const active = await reopened.channel('production', 'stable');
    assert.equal(active?.id, release.id);
    assert.equal(active?.status, 'active');
    assert.equal(await reopened.verifyIntegrity(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactDigest, createArtifact, createBuildManifest, ReleaseStore, planRollout, verifyReproducibleBuild } from '../src/index.js';

test('canonical digests are stable across key order', () => {
  assert.equal(artifactDigest({ b: 2, a: 1 }), artifactDigest({ a: 1, b: 2 }));
});

test('release promotion is health gated and rollback restores previous release', () => {
  const store = new ReleaseStore();
  const a1 = createArtifact({ app: 'demo', version: '1.0.0', target: 'web', files: [{ path: 'app.js', content: 'one' }] });
  const a2 = createArtifact({ app: 'demo', version: '1.1.0', target: 'web', files: [{ path: 'app.js', content: 'two' }] });
  store.putArtifact(a1); store.putArtifact(a2);
  const r1 = store.createRelease({ artifactDigest: a1.digest, environment: { name: 'prod' } });
  assert.throws(() => store.promote(r1.id), /health gate/);
  store.recordHealth(r1.id, { healthy: true }); store.promote(r1.id);
  const r2 = store.createRelease({ artifactDigest: a2.digest, environment: { name: 'prod', strategy: 'canary' } });
  store.recordHealth(r2.id, { healthy: true, healthyPercent: 100 }); store.promote(r2.id);
  assert.equal(store.channel('prod').version, '1.1.0');
  assert.equal(store.rollback('prod').version, '1.0.0');
});

test('build manifests support reproducibility checks', () => {
  const manifest = createBuildManifest({ sourceDigest: 'abc', toolchain: 'nova@0.1.0', commands: ['nova build'] });
  const artifact = createArtifact({ app: 'demo', version: '1', target: 'server', metadata: { manifest: manifest.manifestDigest } });
  assert.equal(verifyReproducibleBuild(artifact, { ...artifact }), true);
  assert.deepEqual(planRollout({ strategy: 'canary' }, 4), [{ phase: 1, replicas: 1 }, { phase: 2, replicas: 4 }]);
});

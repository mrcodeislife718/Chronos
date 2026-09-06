import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifact, ReleaseStore } from '../src/index.js';
import { DeploymentOrchestrator } from '../src/deployment.js';

function candidate(store, version = '9.0.0', strategy = 'canary') {
  const artifact = createArtifact({ app:'proof', version, target:'web', files:[{ path:'app.js', content:version }] });
  store.putArtifact(artifact);
  return store.createRelease({ artifactDigest:artifact.digest, environment:{ name:'prod', replicas:3, strategy }, strategy });
}

test('Chronos removes already-created replicas when deployment throws mid-phase', async () => {
  const store = new ReleaseStore();
  const release = candidate(store);
  const live = new Set();
  const removed = [];
  let calls = 0;
  const orchestrator = new DeploymentOrchestrator({
    store,
    deployReplica: async () => {
      calls += 1;
      if (calls === 3) throw new Error('provider create failed');
      const id = `slot-${calls}`;
      live.add(id);
      return id;
    },
    removeReplica: async (id) => { removed.push(id); live.delete(id); },
    healthCheck: async () => true
  });
  await assert.rejects(orchestrator.rollout(release, { replicas:3 }), /provider create failed/);
  assert.equal(live.size, 0);
  assert.deepEqual(removed, ['slot-2','slot-1']);
  assert.equal(store.history().find((entry) => entry.id === release.id).status, 'unhealthy');
});

test('Chronos removes replicas when a health check throws', async () => {
  const store = new ReleaseStore();
  const release = candidate(store, '9.1.0');
  const live = new Set();
  const orchestrator = new DeploymentOrchestrator({
    store,
    deployReplica: async (_release, { index }) => { const id = `slot-${index}`; live.add(id); return id; },
    removeReplica: async (id) => { live.delete(id); },
    healthCheck: async () => { throw new Error('health backend unavailable'); }
  });
  await assert.rejects(orchestrator.rollout(release, { replicas:3 }), /health backend unavailable/);
  assert.equal(live.size, 0);
  assert.equal(store.history().find((entry) => entry.id === release.id).status, 'unhealthy');
});

test('Chronos attempts every rollback removal even if one cleanup operation fails', async () => {
  const store = new ReleaseStore();
  const release = candidate(store, '9.2.0', 'blue-green');
  const attempted = [];
  const orchestrator = new DeploymentOrchestrator({
    store,
    deployReplica: async (_release, { index }) => `slot-${index}`,
    removeReplica: async (id) => { attempted.push(id); if (id === 'slot-1') throw new Error('remove failed'); },
    healthCheck: async () => false
  });
  const result = await orchestrator.rollout(release, { replicas:3 });
  assert.equal(result.ok, false);
  assert.deepEqual(attempted, ['slot-2','slot-1','slot-0']);
  assert.equal(result.cleanupErrors.length, 1);
  assert.match(result.cleanupErrors[0].message, /remove failed/);
});

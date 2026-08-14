import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBuildManifest, createArtifact } from '../src/index.js';
import { BuildRunner, FileArtifactStore, createPreviewServer, SigningVault, createSignedBuild, UpdateService, PolicyEngine, AuditLog, RunnerRegistry } from '../src/cloud.js';

test('artifact store, signing, update channels, policies, audit, and private runners work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronos-store-'));
  const artifact = createArtifact({ app:'demo', version:'1.0.0', target:'web', files:[{path:'index.html',content:'ok'}] });
  const store = new FileArtifactStore(root);
  await store.put(artifact);
  assert.equal((await store.get(artifact.digest)).version, '1.0.0');

  const vault = new SigningVault(); vault.create('release');
  const signed = createSignedBuild({ artifact, keyName:'release', vault, platform:'android' });
  const canonical = JSON.stringify({ artifactDigest: artifact.digest, app: artifact.app, version: artifact.version, target: artifact.target, platform:'android', credentialsRef:null });
  assert.equal(vault.verify('release', canonical, signed.signature), true);

  const updates = new UpdateService();
  updates.publish({ app:'demo', channel:'stable', runtimeVersion:'1', artifactDigest:artifact.digest, eligibility:{platforms:['android']} });
  assert.ok(updates.check({app:'demo',channel:'stable',runtimeVersion:'1',platform:'android',appVersion:'1.0.0'}));
  assert.equal(updates.check({app:'demo',channel:'stable',runtimeVersion:'1',platform:'ios',appVersion:'1.0.0'}), null);

  const policy = new PolicyEngine([{id:'prod-only',when:{environment:'prod',actor:'guest'},effect:'deny'}]);
  assert.equal(policy.evaluate({environment:'prod',actor:'guest'}).allowed, false);
  const audit = new AuditLog(); await audit.append({type:'deploy'}); await audit.append({type:'promote'}); assert.equal(audit.verify(), true);
  const runners = new RunnerRegistry(); runners.register('private-1', {build(){}}, {labels:['macos'],private:true}); const lease=runners.acquire(['macos']); assert.equal(lease.id,'private-1'); lease.release();
});

test('preview server serves immutable build output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronos-preview-'));
  await fs.writeFile(path.join(root,'index.html'), '<h1>preview</h1>');
  const preview = createPreviewServer({root}); const address=await preview.start();
  assert.equal(await (await fetch(address.url)).text(), '<h1>preview</h1>');
  await preview.close();
});

test('container build runner produces reproducible artifacts from clean copies', { skip: process.env.CHRONOS_CONTAINER_TEST !== '1' }, async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'chronos-src-'));
  await fs.writeFile(path.join(source,'source.txt'),'deterministic');
  const manifest = { ...createBuildManifest({sourceDigest:'source',toolchain:'shell',commands:['mkdir -p dist && cp source.txt dist/out.txt']}), app:'demo',version:'1.0.0',target:'web' };
  const runner = new BuildRunner({engine:'docker',image:'alpine:3.20'});
  const first = await runner.build(manifest,{sourceDir:source});
  const second = await runner.build(manifest,{sourceDir:source});
  assert.equal(first.ok, true, first.result?.stderr);
  assert.equal(second.ok, true, second.result?.stderr);
  assert.equal(first.artifact.digest, second.artifact.digest);
});

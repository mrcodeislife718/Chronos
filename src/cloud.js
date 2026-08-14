import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { artifactDigest, createArtifact } from './index.js';

export class BuildRunner {
  constructor({ engine = 'docker', image, workRoot = path.join(os.tmpdir(), 'chronos-builds'), privateRunner = false } = {}) { this.engine = engine; this.image = image; this.workRoot = workRoot; this.privateRunner = privateRunner; }
  async build(manifest, { sourceDir, outputDir = 'dist', env = {}, timeoutMs = 15 * 60_000 } = {}) {
    if (!this.image) throw new Error('Chronos BuildRunner requires a container image');
    const buildId = crypto.randomUUID();
    const workspace = path.join(this.workRoot, buildId);
    await fs.mkdir(workspace, { recursive: true });
    const source = path.join(workspace, 'source');
    await fs.cp(path.resolve(sourceDir), source, { recursive: true });
    const argumentsList = ['run','--rm','--network','none','-v',`${source}:/workspace:rw`,'-w','/workspace'];
    for (const [name,value] of Object.entries(env)) argumentsList.push('-e', `${name}=${value}`);
    argumentsList.push(this.image, 'sh', '-lc', (manifest.commands ?? []).join(' && '));
    const result = await runProcess(this.engine, argumentsList, { timeoutMs });
    if (!result.ok) return { ok: false, buildId, result, workspace };
    const artifactRoot = path.join(source, outputDir);
    const files = await hashDirectory(artifactRoot);
    const artifact = createArtifact({ app: manifest.app ?? 'app', version: manifest.version ?? buildId, target: manifest.target ?? 'generic', files, metadata: { buildId, manifestDigest: manifest.manifestDigest, runner: this.privateRunner ? 'private' : 'shared', engine: this.engine, image: this.image } });
    return { ok: true, buildId, result, workspace, artifactRoot, artifact };
  }
}

export class FileArtifactStore {
  constructor(root) { this.root = path.resolve(root); }
  async put(artifact, filesDir = null) {
    const dir = path.join(this.root, artifact.digest);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'artifact.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    if (filesDir) await fs.cp(filesDir, path.join(dir, 'files'), { recursive: true });
    return { digest: artifact.digest, path: dir };
  }
  async get(digest) { return JSON.parse(await fs.readFile(path.join(this.root, digest, 'artifact.json'), 'utf8')); }
  async has(digest) { try { await fs.access(path.join(this.root,digest,'artifact.json')); return true; } catch { return false; } }
  async delete(digest) { await fs.rm(path.join(this.root,digest), { recursive: true, force: true }); }
}

export function createPreviewServer({ root, host = '127.0.0.1', port = 0 } = {}) {
  const absolute = path.resolve(root);
  const server = http.createServer(async (req,res) => {
    try {
      let relative = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\//,'')) || 'index.html';
      let file = safeJoin(absolute, relative);
      let stat;
      try { stat = await fs.stat(file); } catch {}
      if (stat?.isDirectory()) file = path.join(file,'index.html');
      const data = await fs.readFile(file);
      res.setHeader('cache-control','no-store'); res.end(data);
    } catch (error) { res.statusCode = error.code === 'ENOENT' ? 404 : 500; res.end(error.message); }
  });
  return {
    async start() { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);}); const a=server.address(); return { url:`http://${host}:${a.port}`, host, port:a.port }; },
    async close() { if (server.listening) await new Promise((resolve)=>server.close(resolve)); },
    server
  };
}

export class SigningVault {
  constructor() { this.keys = new Map(); }
  create(name, { algorithm = 'ed25519' } = {}) { if (this.keys.has(name)) throw new Error(`signing key exists: ${name}`); const pair = algorithm === 'ed25519' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}); this.keys.set(name,{algorithm,privateKey:pair.privateKey,publicKey:pair.publicKey}); return { name, algorithm, publicKey: pair.publicKey.export({type:'spki',format:'pem'}) }; }
  import(name, { privateKey, publicKey, algorithm = 'ed25519' }) { this.keys.set(name,{algorithm,privateKey:crypto.createPrivateKey(privateKey),publicKey:crypto.createPublicKey(publicKey)}); }
  sign(name, data) { const key=this.#get(name); const bytes=Buffer.isBuffer(data)?data:Buffer.from(data); return crypto.sign(null,bytes,key.privateKey).toString('base64url'); }
  verify(name, data, signature) { const key=this.#get(name); const bytes=Buffer.isBuffer(data)?data:Buffer.from(data); return crypto.verify(null,bytes,key.publicKey,Buffer.from(signature,'base64url')); }
  #get(name){const key=this.keys.get(name);if(!key)throw new Error(`unknown signing key: ${name}`);return key;}
}

export function createSignedBuild({ artifact, keyName, vault, platform, credentials = {} }) {
  const payload = { artifactDigest: artifact.digest, app: artifact.app, version: artifact.version, target: artifact.target, platform, credentialsRef: credentials.ref ?? null };
  const canonical = JSON.stringify(sortObject(payload));
  return { ...payload, signature: vault.sign(keyName, canonical), keyName, signedAt: new Date().toISOString() };
}

export class UpdateService {
  constructor() { this.channels = new Map(); this.updates = new Map(); }
  publish({ app, channel = 'stable', runtimeVersion, artifactDigest: digest, assets = [], eligibility = {} }) {
    const update = { id: crypto.randomUUID(), app, channel, runtimeVersion, artifactDigest: digest, assets: assets.map(structuredClone), eligibility: structuredClone(eligibility), createdAt: new Date().toISOString(), checksum: artifactDigest({ app, channel, runtimeVersion, digest, assets, eligibility }) };
    this.updates.set(update.id, update); this.channels.set(`${app}:${channel}`, update.id); return structuredClone(update);
  }
  check({ app, channel = 'stable', runtimeVersion, platform, appVersion }) {
    const id=this.channels.get(`${app}:${channel}`); if(!id)return null; const update=this.updates.get(id);
    if (update.runtimeVersion && update.runtimeVersion !== runtimeVersion) return null;
    if (update.eligibility.platforms && !update.eligibility.platforms.includes(platform)) return null;
    if (update.eligibility.minAppVersion && compareVersion(appVersion, update.eligibility.minAppVersion) < 0) return null;
    return structuredClone(update);
  }
}

export class PolicyEngine {
  constructor(policies = []) { this.policies = policies.map(structuredClone); }
  evaluate(context) {
    const decisions = [];
    for (const policy of this.policies) {
      const applies = !policy.when || matches(context, policy.when);
      if (!applies) continue;
      decisions.push({ id: policy.id ?? policy.name, effect: policy.effect ?? 'deny', reason: policy.reason ?? null });
      if ((policy.effect ?? 'deny') === 'deny') return { allowed: false, decisions };
    }
    return { allowed: true, decisions };
  }
}

export class AuditLog {
  constructor({ sink = null } = {}) { this.entries=[]; this.sink=sink; this.previousHash=null; }
  async append(event) { const body={id:crypto.randomUUID(),at:new Date().toISOString(),previousHash:this.previousHash,...structuredClone(event)}; body.hash=artifactDigest(body); this.previousHash=body.hash; this.entries.push(body); await this.sink?.(structuredClone(body)); return structuredClone(body); }
  verify(){let previous=null;for(const entry of this.entries){const {hash,...body}=entry;if(body.previousHash!==previous||artifactDigest(body)!==hash)return false;previous=hash;}return true;}
}

export class RunnerRegistry {
  constructor() { this.runners=new Map(); }
  register(id, runner, { labels = [], private: isPrivate = true } = {}) { this.runners.set(id,{id,runner,labels:new Set(labels),private:isPrivate,busy:false}); return this; }
  acquire(requiredLabels = []) { const candidate=[...this.runners.values()].find((r)=>!r.busy&&requiredLabels.every((label)=>r.labels.has(label))); if(!candidate)return null;candidate.busy=true;return { id:candidate.id, runner:candidate.runner, release:()=>{candidate.busy=false;} }; }
}

async function runProcess(bin,args,{timeoutMs}){return new Promise((resolve,reject)=>{const child=spawn(bin,args,{stdio:'pipe'});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const timer=setTimeout(()=>{child.kill('SIGKILL');},timeoutMs);child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve({ok:code===0,code,stdout,stderr,command:{bin,args}});});});}
async function hashDirectory(root){const files=[];async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())await walk(full);else{const data=await fs.readFile(full);files.push({path:path.relative(root,full).replace(/\\/g,'/'),digest:artifactDigest(data),content:null});}}}await walk(root);return files.sort((a,b)=>a.path.localeCompare(b.path));}
function safeJoin(root,relative){const target=path.resolve(root,relative);if(!target.startsWith(root+path.sep)&&target!==root)throw new Error('path escapes preview root');return target;}
function sortObject(v){if(Array.isArray(v))return v.map(sortObject);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sortObject(v[k])]));return v;}
function matches(context,when){return Object.entries(when).every(([key,expected])=>Array.isArray(expected)?expected.includes(context[key]):context[key]===expected);}
function compareVersion(a='0',b='0'){const A=a.split('.').map(Number),B=b.split('.').map(Number);for(let i=0;i<Math.max(A.length,B.length);i++){const d=(A[i]??0)-(B[i]??0);if(d)return Math.sign(d);}return 0;}

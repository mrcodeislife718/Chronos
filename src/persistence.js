import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactDigest, canonicalize, defineEnvironment } from './index.js';

const STRATEGIES = new Set(['rolling', 'canary', 'blue-green', 'immediate']);
const clone = (value) => globalThis.structuredClone(value);

function emptyState() {
  return { version: 1, artifacts: {}, releases: {}, channels: {}, audit: [], previousAuditHash: null };
}

export class AtomicJsonStateStore {
  constructor(file, { lockTimeoutMs = 10_000, staleLockMs = 60_000, retryMs = 25 } = {}) {
    this.file = path.resolve(file);
    this.lockFile = `${this.file}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.retryMs = retryMs;
  }

  async initialize(initial = emptyState()) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { await fs.access(this.file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#writeEnvelope(initial);
    }
    return this.load();
  }

  async load() {
    const raw = await fs.readFile(this.file, 'utf8');
    let envelope;
    try { envelope = JSON.parse(raw); }
    catch (error) { throw new Error(`Chronos state is not valid JSON: ${error.message}`); }
    if (envelope?.format !== 'chronos-state/1' || !envelope.state || !envelope.checksum) throw new Error('Chronos state envelope is invalid');
    const checksum = artifactDigest(canonicalize(envelope.state));
    if (checksum !== envelope.checksum) throw new Error('Chronos state checksum mismatch');
    return clone(envelope.state);
  }

  async transaction(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('transaction mutator must be a function');
    return this.#withLock(async () => {
      const state = await this.load();
      const result = await mutator(state);
      await this.#writeEnvelope(state);
      return clone(result);
    });
  }

  async #writeEnvelope(state) {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const envelope = {
      format: 'chronos-state/1',
      checksum: artifactDigest(canonicalize(state)),
      state
    };
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(envelope, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
    try {
      const dirHandle = await fs.open(dir, 'r');
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch {}
  }

  async #withLock(work) {
    const started = Date.now();
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        await handle.sync();
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this.#removeStaleLock();
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error(`Timed out acquiring Chronos state lock: ${this.lockFile}`);
        await new Promise((resolve) => setTimeout(resolve, this.retryMs));
      }
    }
    try { return await work(); }
    finally {
      await handle.close().catch(() => {});
      await fs.rm(this.lockFile, { force: true });
    }
  }

  async #removeStaleLock() {
    try {
      const stat = await fs.stat(this.lockFile);
      if (Date.now() - stat.mtimeMs > this.staleLockMs) await fs.rm(this.lockFile, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export class DurableReleaseStore {
  constructor(file, options = {}) {
    this.store = new AtomicJsonStateStore(file, options);
  }

  async initialize() { await this.store.initialize(emptyState()); return this; }

  async putArtifact(artifact, actor = 'system') {
    if (!artifact?.digest || !artifact.app || !artifact.version) throw new TypeError('artifact must include digest, app, and version');
    return this.store.transaction((state) => {
      const existing = state.artifacts[artifact.digest];
      if (existing && artifactDigest(canonicalize(existing)) !== artifactDigest(canonicalize(artifact))) throw new Error(`artifact digest collision or mutation detected: ${artifact.digest}`);
      state.artifacts[artifact.digest] = clone(artifact);
      appendAudit(state, 'artifact.store', { digest: artifact.digest, app: artifact.app, version: artifact.version, actor });
      return artifact.digest;
    });
  }

  async createRelease({ artifactDigest: digest, environment, channel = 'stable', strategy, actor = 'system' }) {
    return this.store.transaction((state) => {
      const artifact = state.artifacts[digest];
      if (!artifact) throw new Error(`unknown artifact: ${digest}`);
      const env = defineEnvironment(environment);
      const selectedStrategy = validateStrategy(strategy ?? env.strategy);
      const release = {
        id: crypto.randomUUID(),
        app: artifact.app,
        version: artifact.version,
        artifactDigest: digest,
        environment: env.name,
        environmentDefinition: clone(env),
        channel,
        strategy: selectedStrategy,
        status: 'pending',
        createdAt: new Date().toISOString(),
        promotedAt: null,
        previousReleaseId: state.channels[`${env.name}:${channel}`] ?? null,
        actor,
        health: null
      };
      state.releases[release.id] = release;
      appendAudit(state, 'release.create', { releaseId: release.id, environment: env.name, channel, actor });
      return release;
    });
  }

  async recordHealth(releaseId, { healthy, healthyPercent = healthy ? 100 : 0, details = {} }, actor = 'system') {
    if (typeof healthyPercent !== 'number' || healthyPercent < 0 || healthyPercent > 100) throw new TypeError('healthyPercent must be between 0 and 100');
    return this.store.transaction((state) => {
      const release = requireRelease(state, releaseId);
      release.health = { healthy: Boolean(healthy), healthyPercent, details: clone(details), checkedAt: new Date().toISOString() };
      release.status = healthy ? 'healthy' : 'unhealthy';
      appendAudit(state, 'release.health', { releaseId, healthy: Boolean(healthy), healthyPercent, actor });
      return release;
    });
  }

  async promote(releaseId, minimumHealthyPercent = 100, actor = 'system') {
    return this.store.transaction((state) => {
      const release = requireRelease(state, releaseId);
      if (!release.health?.healthy || release.health.healthyPercent < minimumHealthyPercent) throw new Error(`release ${releaseId} failed health gate`);
      const key = `${release.environment}:${release.channel}`;
      const currentId = state.channels[key];
      if (currentId && currentId !== release.id) {
        const current = requireRelease(state, currentId);
        if (current.status === 'active') current.status = 'superseded';
        release.previousReleaseId = current.id;
      }
      release.status = 'active';
      release.promotedAt = new Date().toISOString();
      state.channels[key] = release.id;
      appendAudit(state, 'release.promote', { releaseId, environment: release.environment, channel: release.channel, actor });
      return release;
    });
  }

  async rollback(environment, channel = 'stable', actor = 'system') {
    return this.store.transaction((state) => {
      const key = `${environment}:${channel}`;
      const currentId = state.channels[key];
      if (!currentId) throw new Error(`no active release for ${key}`);
      const current = requireRelease(state, currentId);
      if (!current.previousReleaseId) throw new Error(`release ${currentId} has no rollback target`);
      const previous = requireRelease(state, current.previousReleaseId);
      current.status = 'rolled-back';
      previous.status = 'active';
      state.channels[key] = previous.id;
      appendAudit(state, 'release.rollback', { from: current.id, to: previous.id, environment, channel, actor });
      return previous;
    });
  }

  async channel(environment, channel = 'stable') {
    const state = await this.store.load();
    const id = state.channels[`${environment}:${channel}`];
    return id ? clone(requireRelease(state, id)) : null;
  }

  async history({ app, environment, channel } = {}) {
    const state = await this.store.load();
    return Object.values(state.releases)
      .filter((release) => (!app || release.app === app) && (!environment || release.environment === environment) && (!channel || release.channel === channel))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async auditLog() { return (await this.store.load()).audit.map(clone); }

  async verifyIntegrity() {
    const state = await this.store.load();
    let previousHash = null;
    for (const entry of state.audit) {
      const { hash, ...body } = entry;
      if (body.previousHash !== previousHash || artifactDigest(canonicalize(body)) !== hash) return false;
      previousHash = hash;
    }
    return previousHash === state.previousAuditHash;
  }
}

function appendAudit(state, type, data) {
  const body = { id: crypto.randomUUID(), at: new Date().toISOString(), previousHash: state.previousAuditHash, type, ...clone(data) };
  const entry = { ...body, hash: artifactDigest(canonicalize(body)) };
  state.previousAuditHash = entry.hash;
  state.audit.push(entry);
  return entry;
}

function requireRelease(state, id) {
  const release = state.releases[id];
  if (!release) throw new Error(`unknown release: ${id}`);
  return release;
}

function validateStrategy(value) {
  if (!STRATEGIES.has(value)) throw new Error(`unsupported rollout strategy: ${value}`);
  return value;
}

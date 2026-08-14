import { createHash, randomUUID } from 'node:crypto';

const STRATEGIES = new Set(['rolling', 'canary', 'blue-green', 'immediate']);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, canonicalize(value[k])]));
  }
  return value;
}

export function artifactDigest(input) {
  const bytes = typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(canonicalize(input));
  return createHash('sha256').update(bytes).digest('hex');
}

export function createArtifact({ app, version, target, files = [], metadata = {} }) {
  if (!app || !version || !target) throw new Error('artifact requires app, version, and target');
  const normalizedFiles = files.map((file) => ({ path: file.path, digest: file.digest ?? artifactDigest(file.content ?? '') })).sort((a, b) => a.path.localeCompare(b.path));
  const body = { app, version, target, files: normalizedFiles, metadata: canonicalize(metadata) };
  return Object.freeze({ ...body, digest: artifactDigest(body) });
}

export function defineEnvironment(config = {}) {
  if (!config.name) throw new Error('environment requires a name');
  return Object.freeze({
    name: config.name,
    region: config.region ?? 'local',
    replicas: positiveInteger(config.replicas ?? 1, 'replicas'),
    strategy: validateStrategy(config.strategy ?? 'rolling'),
    health: {
      minimumHealthyPercent: boundedNumber(config.health?.minimumHealthyPercent ?? 100, 1, 100, 'minimumHealthyPercent'),
      timeoutMs: positiveInteger(config.health?.timeoutMs ?? 30000, 'timeoutMs')
    }
  });
}

export class ReleaseStore {
  constructor() {
    this.artifacts = new Map();
    this.releases = new Map();
    this.channels = new Map();
    this.audit = [];
  }

  putArtifact(artifact) {
    this.artifacts.set(artifact.digest, structuredClone(artifact));
    this.#audit('artifact.store', { digest: artifact.digest, app: artifact.app, version: artifact.version });
    return artifact.digest;
  }

  createRelease({ artifactDigest: digest, environment, channel = 'stable', strategy, actor = 'system' }) {
    const artifact = this.artifacts.get(digest);
    if (!artifact) throw new Error(`unknown artifact: ${digest}`);
    const env = defineEnvironment(environment);
    const release = {
      id: randomUUID(),
      app: artifact.app,
      version: artifact.version,
      artifactDigest: digest,
      environment: env.name,
      channel,
      strategy: validateStrategy(strategy ?? env.strategy),
      status: 'pending',
      createdAt: new Date().toISOString(),
      promotedAt: null,
      previousReleaseId: this.channels.get(`${env.name}:${channel}`) ?? null,
      actor,
      health: null
    };
    this.releases.set(release.id, release);
    this.#audit('release.create', { releaseId: release.id, environment: env.name, channel, actor });
    return structuredClone(release);
  }

  recordHealth(releaseId, { healthy, healthyPercent = healthy ? 100 : 0, details = {} }) {
    const release = this.#release(releaseId);
    release.health = { healthy: Boolean(healthy), healthyPercent, details: structuredClone(details), checkedAt: new Date().toISOString() };
    release.status = healthy ? 'healthy' : 'unhealthy';
    this.#audit('release.health', { releaseId, healthy: Boolean(healthy), healthyPercent });
    return structuredClone(release);
  }

  promote(releaseId, minimumHealthyPercent = 100) {
    const release = this.#release(releaseId);
    if (!release.health?.healthy || release.health.healthyPercent < minimumHealthyPercent) {
      throw new Error(`release ${releaseId} failed health gate`);
    }
    release.status = 'active';
    release.promotedAt = new Date().toISOString();
    this.channels.set(`${release.environment}:${release.channel}`, release.id);
    this.#audit('release.promote', { releaseId, environment: release.environment, channel: release.channel });
    return structuredClone(release);
  }

  rollback(environment, channel = 'stable') {
    const key = `${environment}:${channel}`;
    const currentId = this.channels.get(key);
    if (!currentId) throw new Error(`no active release for ${key}`);
    const current = this.#release(currentId);
    if (!current.previousReleaseId) throw new Error(`release ${currentId} has no rollback target`);
    const previous = this.#release(current.previousReleaseId);
    current.status = 'rolled-back';
    previous.status = 'active';
    this.channels.set(key, previous.id);
    this.#audit('release.rollback', { from: current.id, to: previous.id, environment, channel });
    return structuredClone(previous);
  }

  channel(environment, channel = 'stable') {
    const id = this.channels.get(`${environment}:${channel}`);
    return id ? structuredClone(this.#release(id)) : null;
  }

  history({ app, environment, channel } = {}) {
    return [...this.releases.values()]
      .filter((r) => (!app || r.app === app) && (!environment || r.environment === environment) && (!channel || r.channel === channel))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(structuredClone);
  }

  auditLog() { return this.audit.map(structuredClone); }

  #release(id) {
    const value = this.releases.get(id);
    if (!value) throw new Error(`unknown release: ${id}`);
    return value;
  }

  #audit(type, data) {
    this.audit.push({ id: randomUUID(), type, at: new Date().toISOString(), ...structuredClone(data) });
  }
}

export function planRollout(release, replicas = 1) {
  replicas = positiveInteger(replicas, 'replicas');
  if (release.strategy === 'immediate') return [{ phase: 1, replicas }];
  if (release.strategy === 'canary') return [{ phase: 1, replicas: 1 }, { phase: 2, replicas }];
  if (release.strategy === 'blue-green') return [{ phase: 1, replicas, slot: 'green' }, { phase: 2, replicas, switchTraffic: true }];
  return Array.from({ length: replicas }, (_, index) => ({ phase: index + 1, replicas: index + 1 }));
}

export function createBuildManifest({ sourceDigest, toolchain, environment = {}, commands = [], inputs = [] }) {
  if (!sourceDigest || !toolchain) throw new Error('build manifest requires sourceDigest and toolchain');
  const manifest = canonicalize({ sourceDigest, toolchain, environment, commands, inputs });
  return Object.freeze({ ...manifest, manifestDigest: artifactDigest(manifest) });
}

export function verifyReproducibleBuild(a, b) {
  return Boolean(a?.digest && b?.digest && a.digest === b.digest);
}

function validateStrategy(value) { if (!STRATEGIES.has(value)) throw new Error(`unsupported rollout strategy: ${value}`); return value; }
function positiveInteger(value, name) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`); return value; }
function boundedNumber(value, min, max, name) { if (typeof value !== 'number' || value < min || value > max) throw new TypeError(`${name} must be between ${min} and ${max}`); return value; }

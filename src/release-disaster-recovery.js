import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactDigest, canonicalize } from './index.js';
import { AtomicJsonStateStore } from './persistence.js';
import { RecoveryStore } from './disaster-recovery.js';

export class ChronosDisasterRecovery {
  constructor(stateFile, recoveryRoot, options = {}) {
    if (!stateFile || !recoveryRoot) throw new TypeError('Chronos disaster recovery requires stateFile and recoveryRoot');
    this.stateFile = path.resolve(stateFile);
    this.primary = new AtomicJsonStateStore(this.stateFile, options.primary ?? {});
    this.recovery = new RecoveryStore(recoveryRoot, options.recovery ?? {});
  }

  async checkpoint({ label = 'release-control-plane' } = {}) {
    const state = await this.primary.load();
    verifyAuditChain(state);
    return this.recovery.checkpoint(state, { label });
  }

  async restoreLatest() {
    const restored = await this.recovery.restoreLatest();
    if (!restored) return null;
    verifyAuditChain(restored.state);
    await writeChronosEnvelope(this.stateFile, restored.state);
    const verified = await this.primary.load();
    verifyAuditChain(verified);
    return { state: verified, metadata: restored.metadata };
  }

  async verifyPrimary() {
    const state = await this.primary.load();
    verifyAuditChain(state);
    return true;
  }
}

export function verifyAuditChain(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.audit)) throw new Error('Chronos recovery state is invalid');
  let previousHash = null;
  for (const entry of state.audit) {
    const { hash, ...body } = entry;
    if (typeof hash !== 'string' || body.previousHash !== previousHash || artifactDigest(canonicalize(body)) !== hash) {
      throw new Error('Chronos recovery audit chain is invalid');
    }
    previousHash = hash;
  }
  if ((state.previousAuditHash ?? null) !== previousHash) throw new Error('Chronos recovery audit head is invalid');
  return true;
}

async function writeChronosEnvelope(file, state) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const envelope = { format: 'chronos-state/1', checksum: artifactDigest(canonicalize(state)), state };
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.restore.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(envelope, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
  try { const directory = await fs.open(dir, 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {}
}

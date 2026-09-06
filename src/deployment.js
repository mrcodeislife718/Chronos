import crypto from 'node:crypto';
import { planRollout, artifactDigest } from './index.js';

export class SecretVault {
  constructor(masterKey = crypto.randomBytes(32)) {
    this.key=Buffer.from(masterKey);
    if(this.key.length!==32)throw new Error('SecretVault requires 32-byte key');
    this.records=new Map();
    this.closed=false;
  }
  put(name,value){this.#assertOpen();const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);const plaintext=Buffer.from(value);try{const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);const tag=cipher.getAuthTag();const previous=this.records.get(name);if(previous)this.#zeroizeRecord(previous);this.records.set(name,{iv,ciphertext,tag});return name;}finally{plaintext.fill(0);}}
  async withSecret(name,work){this.#assertOpen();if(typeof work!=='function')throw new TypeError('withSecret requires a callback');const record=this.records.get(name);if(!record)throw new Error(`unknown credential: ${name}`);const decipher=crypto.createDecipheriv('aes-256-gcm',this.key,record.iv);decipher.setAuthTag(record.tag);const secret=Buffer.concat([decipher.update(record.ciphertext),decipher.final()]);try{return await work(secret);}finally{secret.fill(0);}}
  delete(name){this.#assertOpen();const record=this.records.get(name);if(!record)return false;this.#zeroizeRecord(record);return this.records.delete(name);}
  close(){if(this.closed)return;for(const record of this.records.values())this.#zeroizeRecord(record);this.records.clear();this.key.fill(0);this.closed=true;}
  #zeroizeRecord(record){record.ciphertext.fill(0);record.tag.fill(0);record.iv.fill(0);}
  #assertOpen(){if(this.closed)throw new Error('SecretVault is closed');}
}

export class DeploymentOrchestrator {
  constructor({store,deployReplica,removeReplica,healthCheck,audit=()=>{}}={}){if(!store)throw new Error('release store required');for(const [name,fn] of Object.entries({deployReplica,removeReplica,healthCheck}))if(typeof fn!=='function')throw new TypeError(`${name} must be a function`);this.store=store;this.deployReplica=deployReplica;this.removeReplica=removeReplica;this.healthCheck=healthCheck;this.audit=audit;}
  async rollout(release,{replicas=1,minimumHealthyPercent=100}={}){
    const plan=planRollout(release,replicas);const deployed=[];const phases=[];
    try {
      for(const phase of plan){
        const desired=phase.replicas;
        while(deployed.length<desired){
          const slot=await this.deployReplica(release,{index:deployed.length,phase});
          if(slot==null)throw new Error(`deployReplica returned no slot for replica ${deployed.length}`);
          deployed.push(slot);
        }
        const checks=await Promise.all(deployed.map((slot)=>this.healthCheck(slot,release)));
        const healthy=checks.filter(Boolean).length;const percent=deployed.length?healthy/deployed.length*100:0;
        phases.push({phase:phase.phase,deployed:deployed.length,healthy,healthyPercent:percent});
        await this.audit({type:'rollout.phase',releaseId:release.id,...phases.at(-1)});
        if(percent<minimumHealthyPercent){
          const cleanupErrors=await this.#removeAll(deployed,release);
          this.store.recordHealth(release.id,{healthy:false,healthyPercent:percent,details:{phase:phase.phase,cleanupErrors:serializeErrors(cleanupErrors)}});
          await this.audit({type:'rollout.rollback',releaseId:release.id,reason:'health-gate',cleanupErrors:serializeErrors(cleanupErrors)});
          return{ok:false,rolledBack:true,phases,cleanupErrors};
        }
      }
      this.store.recordHealth(release.id,{healthy:true,healthyPercent:100,details:{phases:phases.length}});
      const active=this.store.promote(release.id,minimumHealthyPercent);
      return{ok:true,rolledBack:false,active,phases,deployed};
    } catch (error) {
      const cleanupErrors=await this.#removeAll(deployed,release);
      try { this.store.recordHealth(release.id,{healthy:false,healthyPercent:0,details:{phase:phases.at(-1)?.phase??null,failure:error?.message??String(error),cleanupErrors:serializeErrors(cleanupErrors)}}); } catch {}
      try { await this.audit({type:'rollout.rollback',releaseId:release.id,reason:'exception',error:{name:error?.name??'Error',message:error?.message??String(error)},cleanupErrors:serializeErrors(cleanupErrors)}); } catch (auditError) { cleanupErrors.push(auditError); }
      if(cleanupErrors.length) error.cleanupErrors=cleanupErrors;
      throw error;
    }
  }
  async #removeAll(deployed,release){
    const errors=[];
    for(const slot of [...deployed].reverse()){
      try{await this.removeReplica(slot,release);}catch(error){errors.push(error);}
    }
    deployed.length=0;
    return errors;
  }
}

export function createOtaManifest({app,channel='stable',runtimeVersion,artifactDigest:artifact,assets=[],eligibility={},sequence=1}){
  const body={protocol:'chronos-ota/1',app,channel,runtimeVersion,artifactDigest:artifact,assets:assets.map((asset)=>structuredClone(asset)),eligibility:structuredClone(eligibility),sequence};
  const validation=validateOtaManifest(body);
  if(!validation.ok)throw new TypeError(validation.reason);
  return Object.freeze({...body,digest:artifactDigest(body)});
}
export function signOtaManifest(manifest,vault,keyName){
  const validation=validateOtaManifest(manifest);
  if(!validation.ok)throw new TypeError(validation.reason);
  if(typeof vault?.sign!=='function')throw new TypeError('OTA signing vault must provide sign()');
  const payload=JSON.stringify(sortObject(manifest));
  return{manifest:structuredClone(manifest),keyName,signature:vault.sign(keyName,payload)};
}
export function verifyOtaManifest(signed,vault){
  const validation=validateOtaManifest(signed?.manifest);
  if(!validation.ok||typeof signed?.keyName!=='string'||!signed.keyName||typeof signed?.signature!=='string'||!signed.signature||typeof vault?.verify!=='function')return false;
  const {digest,...body}=signed.manifest;
  if(typeof digest!=='string'||artifactDigest(body)!==digest)return false;
  try{return Boolean(vault.verify(signed.keyName,JSON.stringify(sortObject(signed.manifest)),signed.signature));}catch{return false;}
}

export class UpdateClient {
  constructor({runtimeVersion,platform,appVersion,verify}){
    if(typeof verify!=='function')throw new TypeError('UpdateClient requires verify()');
    if(typeof runtimeVersion!=='string'||!runtimeVersion)throw new TypeError('UpdateClient requires runtimeVersion');
    if(typeof platform!=='string'||!platform)throw new TypeError('UpdateClient requires platform');
    if(typeof appVersion!=='string'||!appVersion)throw new TypeError('UpdateClient requires appVersion');
    this.runtimeVersion=runtimeVersion;this.platform=platform;this.appVersion=appVersion;this.verify=verify;this.sequence=0;
  }
  accept(signed){
    if(!this.verify(signed))return{accepted:false,reason:'signature'};
    const update=signed?.manifest;
    const validation=validateOtaManifest(update);
    if(!validation.ok)return{accepted:false,reason:'manifest'};
    if(update.sequence<=this.sequence)return{accepted:false,reason:'replay'};
    if(update.runtimeVersion&&update.runtimeVersion!==this.runtimeVersion)return{accepted:false,reason:'runtime'};
    if(update.eligibility?.platforms&&!update.eligibility.platforms.includes(this.platform))return{accepted:false,reason:'platform'};
    this.sequence=update.sequence;
    return{accepted:true,artifactDigest:update.artifactDigest,assets:structuredClone(update.assets)};
  }
}

function validateOtaManifest(manifest){
  if(!manifest||manifest.protocol!=='chronos-ota/1')return{ok:false,reason:'OTA manifest protocol must be chronos-ota/1'};
  if(typeof manifest.app!=='string'||!manifest.app)return{ok:false,reason:'OTA manifest requires app'};
  if(typeof manifest.channel!=='string'||!manifest.channel)return{ok:false,reason:'OTA manifest requires channel'};
  if(manifest.runtimeVersion!=null&&(typeof manifest.runtimeVersion!=='string'||!manifest.runtimeVersion))return{ok:false,reason:'OTA runtimeVersion must be a non-empty string when provided'};
  if(typeof manifest.artifactDigest!=='string'||!manifest.artifactDigest)return{ok:false,reason:'OTA manifest requires artifactDigest'};
  if(!Number.isSafeInteger(manifest.sequence)||manifest.sequence<1)return{ok:false,reason:'OTA sequence must be a positive safe integer'};
  if(!Array.isArray(manifest.assets))return{ok:false,reason:'OTA assets must be an array'};
  for(const asset of manifest.assets){
    if(!asset||typeof asset!=='object'||typeof asset.path!=='string'||!asset.path||typeof asset.digest!=='string'||!asset.digest)return{ok:false,reason:'OTA assets require non-empty path and digest'};
  }
  if(!manifest.eligibility||typeof manifest.eligibility!=='object'||Array.isArray(manifest.eligibility))return{ok:false,reason:'OTA eligibility must be an object'};
  if(manifest.eligibility.platforms!=null&&(!Array.isArray(manifest.eligibility.platforms)||manifest.eligibility.platforms.some((value)=>typeof value!=='string'||!value)))return{ok:false,reason:'OTA eligibility platforms must be non-empty strings'};
  return{ok:true,reason:null};
}
function sortObject(value){if(Array.isArray(value))return value.map(sortObject);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,sortObject(value[key])]));return value;}
function serializeErrors(errors){return errors.map((error)=>({name:error?.name??'Error',message:error?.message??String(error)}));}

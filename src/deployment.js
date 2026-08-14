import crypto from 'node:crypto';
import { planRollout, artifactDigest } from './index.js';

export class SecretVault {
  constructor(masterKey = crypto.randomBytes(32)) { this.key=Buffer.from(masterKey); if(this.key.length!==32) throw new Error('SecretVault requires 32-byte key'); this.records=new Map(); }
  put(name,value){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);const plaintext=Buffer.from(value);const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);plaintext.fill(0);const tag=cipher.getAuthTag();this.records.set(name,{iv,ciphertext,tag});return name;}
  async withSecret(name,work){const record=this.records.get(name);if(!record)throw new Error(`unknown credential: ${name}`);const decipher=crypto.createDecipheriv('aes-256-gcm',this.key,record.iv);decipher.setAuthTag(record.tag);const secret=Buffer.concat([decipher.update(record.ciphertext),decipher.final()]);try{return await work(secret);}finally{secret.fill(0);}}
  delete(name){const record=this.records.get(name);if(!record)return false;record.ciphertext.fill(0);record.tag.fill(0);record.iv.fill(0);return this.records.delete(name);}
  close(){for(const name of [...this.records.keys()])this.delete(name);this.key.fill(0);}
}

export class DeploymentOrchestrator {
  constructor({store,deployReplica,removeReplica,healthCheck,audit=()=>{}}={}){if(!store)throw new Error('release store required');for(const [name,fn] of Object.entries({deployReplica,removeReplica,healthCheck}))if(typeof fn!=='function')throw new TypeError(`${name} must be a function`);this.store=store;this.deployReplica=deployReplica;this.removeReplica=removeReplica;this.healthCheck=healthCheck;this.audit=audit;}
  async rollout(release,{replicas=1,minimumHealthyPercent=100}={}){
    const plan=planRollout(release,replicas);const deployed=[];const phases=[];
    for(const phase of plan){
      const desired=phase.replicas;while(deployed.length<desired){const slot=await this.deployReplica(release,{index:deployed.length,phase});deployed.push(slot);}
      const checks=await Promise.all(deployed.map((slot)=>this.healthCheck(slot,release)));
      const healthy=checks.filter(Boolean).length;const percent=deployed.length?healthy/deployed.length*100:0;
      phases.push({phase:phase.phase,deployed:deployed.length,healthy,healthyPercent:percent});
      await this.audit({type:'rollout.phase',releaseId:release.id,...phases.at(-1)});
      if(percent<minimumHealthyPercent){for(const slot of [...deployed].reverse())await this.removeReplica(slot,release);this.store.recordHealth(release.id,{healthy:false,healthyPercent:percent,details:{phase:phase.phase}});await this.audit({type:'rollout.rollback',releaseId:release.id,reason:'health-gate'});return{ok:false,rolledBack:true,phases};}
    }
    this.store.recordHealth(release.id,{healthy:true,healthyPercent:100,details:{phases:phases.length}});const active=this.store.promote(release.id,minimumHealthyPercent);return{ok:true,rolledBack:false,active,phases,deployed};
  }
}

export function createOtaManifest({app,channel='stable',runtimeVersion,artifactDigest:artifact,assets=[],eligibility={},sequence=1}){
  const body={protocol:'chronos-ota/1',app,channel,runtimeVersion,artifactDigest:artifact,assets:assets.map((asset)=>structuredClone(asset)),eligibility:structuredClone(eligibility),sequence};
  return Object.freeze({...body,digest:artifactDigest(body)});
}
export function signOtaManifest(manifest,vault,keyName){const payload=JSON.stringify(sortObject(manifest));return{manifest:structuredClone(manifest),keyName,signature:vault.sign(keyName,payload)};}
export function verifyOtaManifest(signed,vault){if(signed?.manifest?.protocol!=='chronos-ota/1')return false;const {digest,...body}=signed.manifest;if(artifactDigest(body)!==digest)return false;return vault.verify(signed.keyName,JSON.stringify(sortObject(signed.manifest)),signed.signature);}

export class UpdateClient {
  constructor({runtimeVersion,platform,appVersion,verify}){this.runtimeVersion=runtimeVersion;this.platform=platform;this.appVersion=appVersion;this.verify=verify;this.sequence=0;}
  accept(signed){if(!this.verify(signed))return{accepted:false,reason:'signature'};const update=signed.manifest;if(update.sequence<=this.sequence)return{accepted:false,reason:'replay'};if(update.runtimeVersion&&update.runtimeVersion!==this.runtimeVersion)return{accepted:false,reason:'runtime'};if(update.eligibility?.platforms&&!update.eligibility.platforms.includes(this.platform))return{accepted:false,reason:'platform'};this.sequence=update.sequence;return{accepted:true,artifactDigest:update.artifactDigest,assets:structuredClone(update.assets)};}
}
function sortObject(value){if(Array.isArray(value))return value.map(sortObject);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,sortObject(value[key])]));return value;}

import {randomUUID} from 'node:crypto';
import {CompactEncrypt,compactDecrypt,exportJWK,generateKeyPair,importJWK,type JWK} from 'jose';
import {localPlanScopes,verifiedAccount,PlanError} from './openai.ts';
import type {Saved,Account} from './session.ts';

export type Recipient={version:1;hostId:string;transferId:string;ownerId:string;expiresAt:number;publicKey:JWK};
export type PendingTransfer={recipient:Recipient;privateKey:JWK};
type Serialize=<T>(work:(read:()=>Promise<Saved>,save:(state:Saved)=>Promise<void>)=>Promise<T>)=>Promise<T>;
const fail=()=>new PlanError('CHATGPT_INVALID_TRANSFER',400);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function validateRecipient(value:unknown):Recipient {
  if(!value||typeof value!=='object')throw fail();
  const r=value as Recipient;
  if(r.version!==1||!uuid.test(r.ownerId)||!uuid.test(r.transferId)
    ||!/^urn:uuid:[a-f0-9-]{36}$/i.test(r.hostId)||!Number.isFinite(r.expiresAt)
    ||r.expiresAt<=Date.now()||r.expiresAt>Date.now()+3_600_000
    ||r.publicKey?.kty!=='EC'||r.publicKey.crv!=='P-256'
    ||typeof r.publicKey.x!=='string'||typeof r.publicKey.y!=='string'
    ||r.publicKey.d!==undefined)throw fail();
  return r;
}

export function createChatGptTransfer(serialize:Serialize,selfHosted:boolean,requireOwner:(saved:Saved,owner:string)=>void) {
  return {
    prepareImport:(ownerId:string)=>serialize(async(read,save)=>{
      if(!selfHosted||!uuid.test(ownerId))throw fail();
      const saved=await read();requireOwner(saved,ownerId);
      const {publicKey,privateKey}=await generateKeyPair('ECDH-ES',{crv:'P-256'});
      const recipient:Recipient={version:1,hostId:saved.hostId??'urn:uuid:'+randomUUID(),
        transferId:randomUUID(),ownerId,expiresAt:Date.now()+3_600_000,publicKey:await exportJWK(publicKey)};
      await save({...saved,hostId:recipient.hostId,transfer:{recipient,privateKey:await exportJWK(privateKey)}});
      return recipient;
    }),

    exportForVm:(ownerId:string,input:unknown,write:(encrypted:string)=>Promise<void>)=>serialize(async(read,save)=>{
      if(selfHosted)throw fail();
      const recipient=validateRecipient(input);
      const saved=await read();requireOwner(saved,ownerId);
      const account=saved.account;
      if(recipient.ownerId!==ownerId||!account?.tokens||!account.idToken)throw fail();
      await verifiedAccount(account.idToken,account.clientId);
      const key=await importJWK(recipient.publicKey,'ECDH-ES');
      const encrypted=await new CompactEncrypt(Buffer.from(JSON.stringify({
        version:1,hostId:recipient.hostId,transferId:recipient.transferId,expiresAt:recipient.expiresAt,account,
      }))).setProtectedHeader({alg:'ECDH-ES',enc:'A256GCM',kid:recipient.transferId}).encrypt(key);
      await write(encrypted);
      // The VM becomes the only refresher of this rotating session. Do not revoke it.
      await save({...saved,attempt:undefined,account:{...account,tokens:undefined,idToken:undefined}});
    }),

    importFromLocal:(ownerId:string,encrypted:string)=>serialize(async(read,save)=>{
      if(!selfHosted||typeof encrypted!=='string'||encrypted.length>60_000)throw fail();
      const saved=await read();requireOwner(saved,ownerId);
      const transfer=saved.transfer;
      if(!transfer||transfer.recipient.ownerId!==ownerId||transfer.recipient.expiresAt<=Date.now())throw fail();
      // Consume atomically across Agent instances, including on a failed import.
      await save({...saved,transfer:undefined});
      try {
        const key=await importJWK(transfer.privateKey,'ECDH-ES');
        const {plaintext,protectedHeader}=await compactDecrypt(encrypted,key,{
          keyManagementAlgorithms:['ECDH-ES'],contentEncryptionAlgorithms:['A256GCM'],
        });
        const value=JSON.parse(Buffer.from(plaintext).toString('utf8')) as {
          version:number;hostId:string;transferId:string;expiresAt:number;account:Account;
        };
        const a=value.account,tokens=a?.tokens;
        if(value.version!==1||value.hostId!==saved.hostId||value.transferId!==transfer.recipient.transferId
          ||protectedHeader.kid!==value.transferId||value.expiresAt!==transfer.recipient.expiresAt
          ||value.expiresAt<=Date.now()||a?.ownerId!==ownerId
          ||typeof a.clientId!=='string'||!/^oaiapp_[a-z0-9_-]{1,200}$/i.test(a.clientId)
          ||typeof a.idToken!=='string'||!tokens||typeof tokens.accessToken!=='string'||!tokens.accessToken
          ||typeof tokens.refreshToken!=='string'||!tokens.refreshToken||!Number.isFinite(tokens.expiresAt)
          ||tokens.expiresAt<=Date.now()||typeof tokens.scope!=='string'
          ||!['offline_access',...localPlanScopes].every(s=>tokens.scope.split(/\s+/).includes(s)))throw fail();
        const identity=await verifiedAccount(a.idToken,a.clientId);
        if(identity.subject!==a.subject||(saved.account&&(saved.account.subject!==a.subject
          ||saved.account.clientId!==a.clientId)))throw fail();
        await save({...saved,attempt:undefined,transfer:undefined,
          account:{...identity,ownerId,clientId:a.clientId,tokens:a.tokens,idToken:a.idToken}});
        return {connected:true,hostId:saved.hostId};
      } catch {throw fail();}
    }),
  };
}

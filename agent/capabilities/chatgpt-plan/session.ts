import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {issuer,resource,localPlanScopes,openAiTokens,verifiedAccount,revokeChatGpt,PlanError,type OAuthClient,type Tokens} from './openai.ts';
import {createChatGptStorage} from './storage.ts';
import {createChatGptTransfer} from './transfer.ts';

export type Account={ownerId:string;clientId:string;subject:string;email?:string;tokens?:Tokens;idToken?:string};
export type Saved={hostId?:string;account?:Account;attempt?:Attempt;transfer?:import('./transfer.ts').PendingTransfer};
type Attempt={ownerId:string;state:string;nonce:string;verifier:string;clientId:string;expiresAt:number};

type Settings={origin:string}&(
  {localSecret:string;directory?:string}
  |{stateKey:string;client?:OAuthClient;planScopes:string[];mode?:'self-hosted'});

export function createChatGptSession(settings:Settings) {
  const hosted='stateKey' in settings;
  const selfHosted=hosted&&settings.mode==='self-hosted';
  const provider=hosted&&!selfHosted?settings.client:undefined;
  const planScopes=hosted&&!selfHosted?settings.planScopes:localPlanScopes;
  const callback=settings.origin+'/api/chatgpt-plan/callback';
  const initialClient='dynamic_agent_client';
  const serialize=createChatGptStorage<Saved>({},settings);

  function oauthClient(clientId:string):OAuthClient {
    if(!hosted||selfHosted)return {id:clientId,method:'none'};
    if(!provider||provider.id!==clientId)throw new PlanError('CHATGPT_RECONNECT',409);
    return provider;
  }

  function requireOwner(saved:Saved,ownerId:string) {
    if(saved.account&&saved.account.ownerId!==ownerId)throw new PlanError('CHATGPT_ALREADY_LINKED',403);
  }

  return {
    ...createChatGptTransfer(serialize,selfHosted,requireOwner),
    status:(ownerId:string)=>serialize(async(read)=>{
      const saved=await read();
      requireOwner(saved,ownerId);
      if(hosted&&!selfHosted&&!provider)return {configured:false,connected:false};
      const connected=!!saved.account?.tokens&&(!provider||saved.account.clientId===provider.id);
      return {...(selfHosted?{mode:'self-hosted',ownerId}:{}),connected,email:saved.account?.email};
    }),

    start:(ownerId:string)=>serialize(async(read,save)=>{
      const saved=await read();
      requireOwner(saved,ownerId);
      if(selfHosted)throw new PlanError('CHATGPT_LOCAL_AUTH_REQUIRED',409);
      if(hosted&&!provider)throw new PlanError('CHATGPT_APPROVAL_PENDING',409);
      const state=randomBytes(32).toString('base64url');
      const nonce=randomBytes(32).toString('base64url');
      const verifier=randomBytes(48).toString('base64url');
      const clientId=provider?.id??saved.account?.clientId??initialClient;
      const hostId=hosted?undefined:saved.hostId??'urn:uuid:'+randomUUID();
      await save({...saved,hostId,attempt:{ownerId,state,nonce,verifier,clientId,expiresAt:Date.now()+600_000}});
      const url=new URL('/api/accounts/authorize',issuer);
      url.search=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:callback,
        scope:[...new Set(['openid','profile','email','offline_access',...planScopes])].join(' '),resource,state,nonce,
        code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
      if(hostId)url.searchParams.set('ext_agent_host_id',hostId);
      if(clientId===initialClient)url.searchParams.set('agent_name_hint','Harbor Agent');
      return {authorizationUrl:url.href,state};
    }),

    complete:(ownerId:string,input:Record<string,unknown>)=>serialize(async(read,save)=>{
      const saved=await read();
      requireOwner(saved,ownerId);
      const current=saved.attempt;
      if(!current||current.ownerId!==ownerId||current.expiresAt<Date.now()||input.state!==current.state) {
        throw new PlanError('CHATGPT_INVALID_CALLBACK',400);
      }
      saved.attempt=undefined;
      await save(saved);
      if(input.error==='access_denied')return {cancelled:true};
      const clientId=current.clientId===initialClient?input.clientId:current.clientId;
      if(typeof clientId!=='string'||!/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId)
        ||(input.clientId&&input.clientId!==clientId)||typeof input.code!=='string'||!input.code||input.error) {
        throw new PlanError('CHATGPT_INVALID_CALLBACK',400);
      }
      const {tokens,idToken}=await openAiTokens(oauthClient(clientId),{grant_type:'authorization_code',
        code:input.code,code_verifier:current.verifier,redirect_uri:callback},planScopes);
      const identity=await verifiedAccount(idToken,clientId,current.nonce);
      if(saved.account&&saved.account.subject!==identity.subject)throw new PlanError('CHATGPT_ACCOUNT_CHANGED',409);
      await save({...saved,account:{...identity,ownerId,clientId,tokens,idToken:String(idToken)}});
      return {cancelled:false};
    }),

    accessToken:(ownerId:string)=>serialize(async(read,save)=>{
      const saved=await read();
      requireOwner(saved,ownerId);
      const account=saved.account;
      if(hosted&&!selfHosted&&!provider)throw new PlanError('CHATGPT_APPROVAL_PENDING',409);
      if(!account?.tokens)throw new PlanError('CHATGPT_RECONNECT',409);
      const client=oauthClient(account.clientId);
      if(account.tokens.expiresAt>Date.now()+60_000)return account.tokens.accessToken;
      try {
        const {tokens}=await openAiTokens(client,{grant_type:'refresh_token',
          refresh_token:account.tokens.refreshToken},planScopes,account.tokens);
        await save({...saved,account:{...account,tokens}});
        return tokens.accessToken;
      } catch(error) {
        if(error instanceof PlanError&&['CHATGPT_RECONNECT','CHATGPT_PERMISSION_REQUIRED'].includes(error.message)) {
          await save({...saved,account:{...account,tokens:undefined}});
        }
        throw error;
      }
    }),

    disconnect:(ownerId:string)=>serialize(async(read,save)=>{
      const saved=await read();
      requireOwner(saved,ownerId);
      if(saved.attempt?.ownerId===ownerId||saved.transfer?.recipient.ownerId===ownerId) {
        saved.attempt=undefined;
        saved.transfer=undefined;
        await save(saved);
      }
      if(!saved.account?.tokens)return {connected:false,revoked:true};
      const {clientId,tokens}=saved.account;
      const revoked=await Promise.resolve().then(()=>revokeChatGpt(oauthClient(clientId),tokens.refreshToken)).catch(()=>false);
      await save({...saved,account:{...saved.account,tokens:undefined,idToken:undefined}});
      return {connected:false,revoked};
    }),
  };
}

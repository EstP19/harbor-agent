import {createRemoteJWKSet,jwtVerify} from 'jose';

export const issuer='https://auth.openai.com';
export const resource='https://api.openai.com/v1';
export const localPlanScopes=['resource.invoke','chatgpt.tokens.use.direct'];
export type ReasoningEffort='none'|'low'|'medium'|'high'|'xhigh'|'max';
export type OAuthClient={id:string;method:'none'|'client_secret_basic'|'client_secret_post';secret?:string};
const keys=createRemoteJWKSet(new URL('/.well-known/jwks.json',issuer));

export class PlanError extends Error {
  readonly status:number;
  constructor(code:string,status:number) {super(code);this.status=status;}
}

export type Tokens={accessToken:string;refreshToken:string;expiresAt:number;scope:string};

function clientForm(client:OAuthClient,fields:Record<string,string>) {
  const body=new URLSearchParams({...fields,client_id:client.id});
  const headers=new Headers();
  if(client.method==='client_secret_post')body.set('client_secret',client.secret!);
  if(client.method==='client_secret_basic'){
    const encode=(value:string)=>new URLSearchParams({v:value}).toString().slice(2);
    headers.set('Authorization','Basic '+Buffer.from(encode(client.id)+':'+encode(client.secret!)).toString('base64'));
    body.delete('client_id');
  }
  return {body,headers};
}

export async function openAiTokens(client:OAuthClient,fields:Record<string,string>,planScopes:string[],previous?:Tokens) {
  const response=await fetch(issuer+'/api/accounts/oauth/token',{
    method:'POST',...clientForm(client,{...fields,resource}),redirect:'error',
    signal:AbortSignal.timeout(15_000),
  });
  const result=await response.json();
  if(!response.ok) {
    if(result.error==='invalid_grant')throw new PlanError('CHATGPT_RECONNECT',409);
    throw new PlanError('CHATGPT_UNAVAILABLE',502);
  }
  const scope=result.scope??previous?.scope;
  if(typeof scope!=='string'||!['offline_access',...planScopes].every(item=>scope.split(/\s+/).includes(item))) {
    throw new PlanError('CHATGPT_PERMISSION_REQUIRED',403);
  }
  if(typeof result.access_token!=='string'||!result.access_token||typeof result.refresh_token!=='string'||!result.refresh_token
    ||typeof result.expires_in!=='number'||!Number.isFinite(result.expires_in)||result.expires_in<=0) {
    throw new PlanError('CHATGPT_UNAVAILABLE',502);
  }
  const tokens:Tokens={accessToken:result.access_token,refreshToken:result.refresh_token,scope,
    expiresAt:Date.now()+result.expires_in*1000};
  return {tokens,idToken:result.id_token as unknown};
}

export async function verifiedAccount(idToken:unknown,clientId:string,nonce?:string) {
  if(typeof idToken!=='string')throw new PlanError('CHATGPT_INVALID_CALLBACK',400);
  const {payload}=await jwtVerify(idToken,keys,{issuer,audience:clientId,algorithms:['RS256'],
    requiredClaims:['sub','iat','exp','nonce'],maxTokenAge:'10m'});
  if((nonce!==undefined&&payload.nonce!==nonce)||!payload.sub||(payload.azp!==undefined&&payload.azp!==clientId)
    ||(Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==clientId)) {
    throw new PlanError('CHATGPT_INVALID_CALLBACK',400);
  }
  return {subject:payload.sub,email:typeof payload.email==='string'?payload.email:undefined};
}

export async function revokeChatGpt(client:OAuthClient,refreshToken:string) {
  const response=await fetch(issuer+'/api/accounts/oauth/revoke',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
    ...clientForm(client,{token:refreshToken,token_type_hint:'refresh_token'}),
  });
  return response.ok;
}

function inferenceError(code:unknown,status?:number) {
  if(status===429||code==='subscription_sharing_usage_limit_exceeded')return new PlanError('CHATGPT_LIMIT',429);
  if(status===401)return new PlanError('CHATGPT_RECONNECT',409);
  if(status===403)return new PlanError('CHATGPT_PERMISSION_REQUIRED',403);
  return new PlanError('CHATGPT_UNAVAILABLE',502);
}

export async function availableModels(accessToken:string):Promise<Array<{id:string;name:string}>> {
  const response=await fetch(resource+'/models',{
    headers:{Authorization:`Bearer ${accessToken}`},redirect:'error',signal:AbortSignal.timeout(15_000),
  });
  if(!response.ok)throw inferenceError(undefined,response.status);
  const result=await response.json();
  const models=(Array.isArray(result.models)?result.models:[]).flatMap((model:unknown)=>{
    if(!model||typeof model!=='object')return [];
    const {slug,display_name,visibility}=model as Record<string,unknown>;
    return visibility==='list'&&typeof slug==='string'&&typeof display_name==='string'?[{id:slug,name:display_name}]:[];
  });
  if(!models.length)throw new PlanError('CHATGPT_MODELS_UNAVAILABLE',502);
  return models;
}

export type ResponseGeneration={
  model:string;
  prompt:string;
  instructions?:string;
  reasoningEffort?:ReasoningEffort;
  imageBase64?:string;
  imageMimeType?:string;
  json?:boolean;
  signal?:AbortSignal;
  timeoutMs?:number;
};

/** Shared wire contract for subscription tokens and API-key backup. */
export async function generateResponse(accessToken:string,params:ResponseGeneration) {
  params.signal?.throwIfAborted();
  const timeout=AbortSignal.timeout(params.timeoutMs??120_000);
  const signal=params.signal?AbortSignal.any([params.signal,timeout]):timeout;
  const content=params.imageBase64?[
    {type:'input_text',text:params.prompt},
    {type:'input_image',image_url:params.imageBase64.startsWith('data:')?params.imageBase64
      :`data:${params.imageMimeType||'image/jpeg'};base64,${params.imageBase64}`},
  ]:params.prompt;
  const response=await fetch(resource+'/responses',{
    method:'POST',redirect:'error',signal,
    headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:params.model,input:[{role:'user',content}],store:false,stream:true,
      ...(params.instructions?{instructions:params.instructions}:{}),
      ...(params.json?{text:{format:{type:'json_object'}}}:{}),
      ...(params.reasoningEffort?{reasoning:{effort:params.reasoningEffort}}:{})}),
  });
  if(!response.ok) {
    const problem=await response.json().catch(()=>null);
    if(problem?.error?.code==='content_filter')throw new PlanError('CHATGPT_REFUSED',422);
    throw inferenceError(problem?.error?.code,response.status);
  }
  if(!response.body)throw inferenceError(undefined);

  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer='',text='';
  try {
    while(true) {
      signal.throwIfAborted();
      const {done,value}=await reader.read();
      if(done)break;
      buffer+=value;
      let newline=buffer.indexOf('\n');
      while(newline!==-1) {
        const line=buffer.slice(0,newline).trimEnd();
        buffer=buffer.slice(newline+1);
        newline=buffer.indexOf('\n');
        if(!line.startsWith('data:')||line.slice(5).trim()==='[DONE]')continue;
        const event=JSON.parse(line.slice(5));
        if(event.type?.startsWith('response.refusal.')||event.response?.incomplete_details?.reason==='content_filter'
          ||event.response?.error?.code==='content_filter')throw new PlanError('CHATGPT_REFUSED',422);
        if(event.type==='response.output_text.delta'&&typeof event.delta==='string')text+=event.delta;
        if(event.type==='response.failed'||event.type==='response.incomplete'||event.type==='error') {
          throw inferenceError(event.response?.error?.code??event.code);
        }
        if(event.type==='response.completed') {
          const parts=(event.response?.output??[]).flatMap((item:{content?:Array<{type:string;text?:string}>})=>item.content??[]);
          if(parts.some((part:{type:string})=>part.type==='refusal'))throw new PlanError('CHATGPT_REFUSED',422);
          if(!text)text=parts.filter((part:{type:string})=>part.type==='output_text').map((part:{text?:string})=>part.text??'').join('');
          if(text.trim()&&text.length<=100_000)return text.trim();
          throw inferenceError(undefined);
        }
        if(text.length>100_000)throw inferenceError(undefined);
      }
      if(buffer.length>1_000_000)throw inferenceError(undefined);
    }
  } finally {
    await reader.cancel().catch(()=>{});
  }
  throw inferenceError(undefined);
}

export async function generateInternalResponse(accessToken:string,model:string,prompt:string,reasoningEffort?:ReasoningEffort) {
  return generateResponse(accessToken,{model,prompt,reasoningEffort});
}

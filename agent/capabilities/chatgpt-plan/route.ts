import type {IncomingMessage,ServerResponse} from 'node:http';
import {createChatGptSession} from './session.ts';
import {availableModels,generateInternalResponse,PlanError} from './openai.ts';
import type {OAuthClient} from './openai.ts';
import {verifyHealthServiceAuthorization} from '../health-detailed-explanation/service-auth.ts';

const prefix='/api/internal/chatgpt-plan/';
const origin=process.env.HARBOR_CHATGPT_LOCAL_ORIGIN;
const publicOrigin=process.env.HARBOR_CHATGPT_PUBLIC_ORIGIN;
const internalHost=process.env.HARBOR_CHATGPT_AGENT_HOST;
const secret=process.env.HARBOR_DEVELOPER_SERVICE_TOKEN;
const stateKey=process.env.HARBOR_CHATGPT_STATE_KEY;
const clientId=process.env.HARBOR_CHATGPT_CLIENT_ID;
const method=process.env.HARBOR_CHATGPT_CLIENT_AUTH_METHOD;
const clientSecret=process.env.HARBOR_CHATGPT_CLIENT_SECRET;
const planScopes=[...new Set(process.env.HARBOR_CHATGPT_PLAN_SCOPES?.trim().split(/\s+/).filter(Boolean)??[])];
const approvedScopes=planScopes.length>0&&planScopes.every(scope=>/^[a-z0-9._:-]+$/i.test(scope))
  &&planScopes.some(scope=>!['openid','profile','email','offline_access','resource.invoke'].includes(scope));
const client:OAuthClient|undefined=clientId&&/^oaiapp_[a-z0-9_-]{1,200}$/i.test(clientId)&&approvedScopes
  &&(method==='none'||((method==='client_secret_basic'||method==='client_secret_post')&&!!clientSecret))
  ?{id:clientId,method,secret:clientSecret}:undefined;
const hosted=!!publicOrigin;
const session=hosted
  ?publicOrigin&&/^https:\/\/[a-z0-9.-]+$/.test(publicOrigin)&&internalHost&&secret&&stateKey&&/^[a-f0-9]{64}$/i.test(stateKey)
    ?createChatGptSession({origin:publicOrigin,stateKey,client,planScopes,
      mode:process.env.HARBOR_CHATGPT_MODE==='self-hosted'?'self-hosted':undefined}):null
  :origin&&/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)&&secret&&process.env.HOST==='127.0.0.1'
    ?createChatGptSession({origin,localSecret:secret,directory:process.env.HARBOR_CHATGPT_DATA_DIR}):null;

async function readBody(request:IncomingMessage):Promise<Record<string,unknown>> {
  let length=0;
  const chunks:Buffer[]=[];
  for await(const chunk of request.iterator({destroyOnReturn:false})) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    length+=bytes.length;
    if(length>64_000)throw new PlanError('CHATGPT_INVALID_REQUEST',413);
    chunks.push(bytes);
  }
  try {
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(input&&typeof input==='object'&&!Array.isArray(input))return input;
  } catch {}
  throw new PlanError('CHATGPT_INVALID_REQUEST',400);
}

export async function handleChatGptPlan(request:IncomingMessage,response:ServerResponse,path:string) {
  if(!path.startsWith(prefix))return false;
  const send=(status:number,body:object)=>{
    response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
    response.end(JSON.stringify(body));
  };
  const internal=hosted
    ?request.headers.host===internalHost&&!request.headers['x-forwarded-for']&&!request.headers.forwarded
    :request.socket.remoteAddress==='127.0.0.1';
  if(!session||!internal||request.method!=='POST') {
    send(404,{error:'CHATGPT_UNAVAILABLE'});
    return true;
  }
  const ownerId=request.headers['x-harbor-subject-id'];
  if(!verifyHealthServiceAuthorization(request.headers.authorization,secret)
    ||typeof ownerId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ownerId)) {
    send(403,{error:'CHATGPT_FORBIDDEN'});
    return true;
  }
  try {
    const operation=path.slice(prefix.length);
    const input=await readBody(request);
    switch(operation) {
      case 'status':send(200,await session.status(ownerId));break;
      case 'connect':send(200,await session.start(ownerId));break;
      case 'callback':send(200,await session.complete(ownerId,input));break;
      case 'disconnect':send(200,await session.disconnect(ownerId));break;
      case 'models':send(200,{models:await availableModels(await session.accessToken(ownerId))});break;
      case 'run': {
        const {prompt,model}=input;
        if(typeof prompt!=='string'||!prompt.trim()||prompt.length>10_000
          ||typeof model!=='string'||!/^[-a-z0-9._]{1,128}$/i.test(model)) {
          throw new PlanError('CHATGPT_INVALID_REQUEST',400);
        }
        const answer=await generateInternalResponse(await session.accessToken(ownerId),model,prompt.trim());
        send(200,{answer});
        break;
      }
      default:send(404,{error:'CHATGPT_UNAVAILABLE'});
    }
  } catch(error) {
    if(error instanceof PlanError)send(error.status,{error:error.message});
    else send(502,{error:'CHATGPT_UNAVAILABLE'});
  }
  return true;
}

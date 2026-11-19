import {createChatGptSession} from './session.ts';
import type {OAuthClient} from './openai.ts';

const origin=process.env.HARBOR_CHATGPT_LOCAL_ORIGIN;
const publicOrigin=process.env.HARBOR_CHATGPT_PUBLIC_ORIGIN;
export const internalHost=process.env.HARBOR_CHATGPT_AGENT_HOST;
export const secret=process.env.HARBOR_DEVELOPER_SERVICE_TOKEN;
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
export const hosted=!!publicOrigin;
export const session=hosted
  ?publicOrigin&&/^https:\/\/[a-z0-9.-]+$/.test(publicOrigin)&&internalHost&&secret&&stateKey&&/^[a-f0-9]{64}$/i.test(stateKey)
    ?createChatGptSession({origin:publicOrigin,stateKey,client,planScopes,
      mode:process.env.HARBOR_CHATGPT_MODE==='self-hosted'?'self-hosted':undefined}):null
  :origin&&/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)&&secret&&process.env.HOST==='127.0.0.1'
    ?createChatGptSession({origin,localSecret:secret,directory:process.env.HARBOR_CHATGPT_DATA_DIR}):null;

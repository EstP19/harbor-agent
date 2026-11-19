import type {IncomingMessage,ServerResponse} from 'node:http';
import {session,hosted,internalHost,secret} from './runtime.ts';
import {generatePreferredResponse} from './preferred-generation.ts';
import {availableModels,generateInternalResponse,PlanError} from './openai.ts';
import {chatGptGenerationSettings} from './generation-settings.ts';
import {verifyHealthServiceAuthorization} from '../health-detailed-explanation/service-auth.ts';

const prefix='/api/internal/chatgpt-plan/';
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
    const settings=chatGptGenerationSettings();
    switch(operation) {
      case 'status':send(200,{...await session.status(ownerId),...settings});break;
      case 'connect':send(200,await session.start(ownerId));break;
      case 'callback':send(200,await session.complete(ownerId,input));break;
      case 'disconnect':send(200,await session.disconnect(ownerId));break;
      case 'models':{
        const catalog=await availableModels(await session.accessToken(ownerId));
        const models=settings.model?catalog.filter(item=>item.id===settings.model):catalog;
        if(!models.length)throw new PlanError('CHATGPT_MODELS_UNAVAILABLE',502);
        send(200,{models});break;
      }
      case 'run': {
        const {prompt,model}=input;
        if(typeof prompt!=='string'||!prompt.trim()||prompt.length>10_000
          ||typeof model!=='string'||!/^[-a-z0-9._]{1,128}$/i.test(model)) {
          throw new PlanError('CHATGPT_INVALID_REQUEST',400);
        }
        if(settings.model&&model!==settings.model)throw new PlanError('CHATGPT_INVALID_REQUEST',400);
        const controller=new AbortController();
        const cancel=()=>{if(!response.writableEnded)controller.abort();};
        response.once('close',cancel);
        try {
          if(process.env.HARBOR_AI_PRIMARY==='chatgpt') {
            const result=await generatePreferredResponse({ownerId,prompt:prompt.trim(),signal:controller.signal});
            send(200,{answer:result.text,model:result.model,reasoningEffort:result.reasoningEffort,billingSource:result.billingSource});
          } else {
            const answer=await generateInternalResponse(await session.accessToken(ownerId),model,prompt.trim(),settings.reasoningEffort);
            send(200,{answer,...settings});
          }
        } finally {response.off('close',cancel);}
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

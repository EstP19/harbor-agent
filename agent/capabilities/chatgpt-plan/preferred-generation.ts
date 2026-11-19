import {chatGptGenerationSettings} from './generation-settings.ts';
import {generateResponse,PlanError,type ResponseGeneration} from './openai.ts';
import {session} from './runtime.ts';

type GenerationInput=Omit<ResponseGeneration,'model'|'reasoningEffort'|'timeoutMs'>&{ownerId?:string};
export type GenerationResult={
  text:string;
  parsed?:Record<string,unknown>;
  provider:'openai';
  billingSource:'chatgpt-plan'|'api-key';
  model:string;
  reasoningEffort:string;
};

/** Dependency seams are server-side only; request bodies cannot select tokens or bypass the plan. */
export function createPreferredGeneration(dependencies:{
  accessToken:(ownerId:string)=>Promise<string>;
  request?:typeof generateResponse;
  environment?:NodeJS.ProcessEnv;
  audit?:(event:Record<string,string|number>)=>void;
}) {
  return async(input:GenerationInput):Promise<GenerationResult>=>{
    const env=dependencies.environment??process.env;
    const owner=env.HARBOR_CHATGPT_OWNER_ID?.trim();
    if(!owner||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner))throw new PlanError('CHATGPT_CONFIG_INVALID',503);
    if(input.ownerId&&input.ownerId!==owner)throw new PlanError('CHATGPT_FORBIDDEN',403);
    const settings=chatGptGenerationSettings(env);
    const model=settings.model??'gpt-6-luna',reasoningEffort=settings.reasoningEffort??'high';
    const request=dependencies.request??generateResponse;
    const audit=dependencies.audit??(event=>console.info('[harbor-ai]',JSON.stringify(event)));
    const params:ResponseGeneration={...input,model,reasoningEffort,timeoutMs:75_000,
      ...(input.json?{instructions:[input.instructions,'Return only a valid JSON object.'].filter(Boolean).join('\n\n')}:{})};
    async function attempt(token:string,billingSource:GenerationResult['billingSource']):Promise<GenerationResult> {
      input.signal?.throwIfAborted();
      const text=await request(token,params);
      input.signal?.throwIfAborted();
      let parsed:Record<string,unknown>|undefined;
      if(input.json) {
        try {
          const value=JSON.parse(text);
          if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
          parsed=value;
        } catch {throw new PlanError('CHATGPT_INVALID_OUTPUT',502);}
      }
      audit({event:'generation_completed',billingSource,model,reasoningEffort});
      return {text,parsed,provider:'openai',billingSource,model,reasoningEffort};
    }
    function recover(error:unknown) {
      input.signal?.throwIfAborted();
      // Never spend a second credential after refusal, caller cancellation, or an ownership/configuration failure.
      if(error instanceof PlanError&&['CHATGPT_FORBIDDEN','CHATGPT_ALREADY_LINKED','CHATGPT_CONFIG_INVALID','CHATGPT_REFUSED'].includes(error.message))throw error;
      return error instanceof PlanError?error.message:'CHATGPT_UNAVAILABLE';
    }
    input.signal?.throwIfAborted();
    let reason:string;
    try {return await attempt(await dependencies.accessToken(owner),'chatgpt-plan');}
    catch(error) {reason=recover(error);}
    const keys=[...new Set([env.OPENAI_API_KEY,env.OPENAI_API_KEY_1].map(key=>key?.trim()).filter((key):key is string=>!!key&&key.startsWith('sk-')))];
    for(let index=0;index<keys.length;index++) {
      input.signal?.throwIfAborted();
      audit({event:'api_backup_started',reason,model,reasoningEffort,keySlot:index+1});
      try {return await attempt(keys[index],'api-key');}
      catch(error) {reason=recover(error);}
    }
    audit({event:'generation_unavailable',reason,model,reasoningEffort});
    throw new PlanError('CHATGPT_UNAVAILABLE',502);
  };
}

export const generatePreferredResponse=createPreferredGeneration({
  accessToken:async ownerId=>{
    if(!session)throw new PlanError('CHATGPT_UNAVAILABLE',502);
    return session.accessToken(ownerId);
  },
});

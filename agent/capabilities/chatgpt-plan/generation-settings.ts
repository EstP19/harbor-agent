import {PlanError,type ReasoningEffort} from './openai.ts';

export function chatGptGenerationSettings(environment:NodeJS.ProcessEnv=process.env):{model?:string;reasoningEffort?:ReasoningEffort} {
  const shared=environment.HARBOR_AI_PRIMARY==='chatgpt';
  const model=environment.HARBOR_CHATGPT_MODEL?.trim()||(shared?'gpt-6-luna':undefined);
  const effort=environment.HARBOR_CHATGPT_REASONING_EFFORT?.trim()||(shared?'high':undefined);
  if(model&&!/^[-a-z0-9._]{1,128}$/i.test(model))throw new PlanError('CHATGPT_CONFIG_INVALID',503);
  if(effort&&!['none','low','medium','high','xhigh','max'].includes(effort))throw new PlanError('CHATGPT_CONFIG_INVALID',503);
  return {...(model?{model}:{}),...(effort?{reasoningEffort:effort as ReasoningEffort}:{})};
}

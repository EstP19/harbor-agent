// Run inside the deployed container. Uses synthetic data and prints no credentials.
import '../lib/runtime-env.ts';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {generateAiJsonResponse} from '../lib/ai-provider.ts';
import {createPreferredGeneration} from '../agent/capabilities/chatgpt-plan/preferred-generation.ts';
import {PlanError} from '../agent/capabilities/chatgpt-plan/openai.ts';
import {pool} from '../lib/db.ts';

async function main() {
  assert.equal(process.env.HARBOR_AI_PRIMARY,'chatgpt');
  const primary=await generateAiJsonResponse({systemPrompt:'Return a JSON object with ok=true.',userPrompt:'Synthetic Harbor routing check.'});
  assert.ok(primary?.parsed?.ok===true);
  assert.equal(primary.billingSource,'chatgpt-plan');
  assert.equal(primary.model,'gpt-6-luna');assert.equal(primary.reasoningEffort,'high');
  console.log(JSON.stringify({check:'primary_json',ok:true,billingSource:primary.billingSource,model:primary.model,reasoningEffort:primary.reasoningEffort}));

  // Use a fixed synthetic raster: minimal Linux images may not contain any system fonts.
  const imageBase64=(await readFile(new URL('../tests/fixtures/multilingual-functional.jpg',import.meta.url))).toString('base64');
  const vision=await generateAiJsonResponse({systemPrompt:'Read the image. Return JSON with text containing the visible text.',userPrompt:'Transcribe this synthetic image.',imageBase64,imageMimeType:'image/jpeg'});
  assert.equal(vision?.billingSource,'chatgpt-plan');
  assert.match(String(vision?.parsed?.text),/HARBOR HEALTH/i);
  console.log(JSON.stringify({check:'primary_vision',ok:true,billingSource:vision?.billingSource}));

  const baseUrl=`http://127.0.0.1:${process.env.PORT||2000}`;
  const denied=await fetch(baseUrl+'/api/capabilities/health-image-ocr',{method:'POST',body:'{}'});
  assert.equal(denied.status,401);
  const response=await fetch(baseUrl+'/api/capabilities/health-image-ocr',{
    method:'POST',headers:{Authorization:`Bearer ${process.env.HARBOR_HEALTH_SERVICE_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({documentContent:imageBase64,mimeType:'image/jpeg',documentType:'general_health'}),signal:AbortSignal.timeout(170_000),
  });
  const value=await response.json();
  assert.equal(response.status,200);assert.equal(value.success,true);
  assert.match(String(value.data?.extractedText),/HARBOR HEALTH/i);
  console.log(JSON.stringify({check:'authenticated_health_ocr_http',ok:true,httpStatus:response.status,unauthorizedStatus:denied.status}));

  // Simulate an exhausted plan in this CLI only, leaving the server and linked session untouched.
  const backup=createPreferredGeneration({accessToken:async()=>{throw new PlanError('CHATGPT_LIMIT',429);}});
  const fallback=await backup({json:true,prompt:'Return a JSON object with backup_ok=true.'});
  assert.equal(fallback.parsed?.backup_ok,true);assert.equal(fallback.billingSource,'api-key');
  assert.equal(fallback.model,'gpt-6-luna');assert.equal(fallback.reasoningEffort,'high');
  console.log(JSON.stringify({check:'real_api_backup_with_simulated_plan_limit',ok:true,billingSource:fallback.billingSource,model:fallback.model,reasoningEffort:fallback.reasoningEffort}));

  const internal=await fetch(`http://${process.env.HARBOR_CHATGPT_AGENT_HOST}/api/internal/chatgpt-plan/run`,{
    method:'POST',headers:{Authorization:`Bearer ${process.env.HARBOR_DEVELOPER_SERVICE_TOKEN}`,
      'X-Harbor-Subject-Id':process.env.HARBOR_CHATGPT_OWNER_ID!,'Content-Type':'application/json'},
    body:JSON.stringify({model:'gpt-6-luna',prompt:'Return exactly HARBOR_AGENT_CHATGPT_OK'}),signal:AbortSignal.timeout(170_000),
  });
  const task=await internal.json();assert.equal(internal.status,200);assert.equal(task.billingSource,'chatgpt-plan');
  assert.match(task.answer,/HARBOR_AGENT_CHATGPT_OK/);
  console.log(JSON.stringify({check:'developer_internal_http',ok:true,billingSource:task.billingSource,model:task.model,reasoningEffort:task.reasoningEffort}));
}
try {await main();}
catch(error) {
  console.error(JSON.stringify({ok:false,error:error instanceof PlanError?error.message:error instanceof assert.AssertionError?'VERIFICATION_ASSERTION_FAILED':'VERIFICATION_FAILED'}));
  process.exitCode=1;
} finally {await pool.end();}

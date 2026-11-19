import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createPreferredGeneration} from '../agent/capabilities/chatgpt-plan/preferred-generation.ts';
import {generateResponse,PlanError} from '../agent/capabilities/chatgpt-plan/openai.ts';
import {doctorQuestionsJsonSchema} from '../agent/capabilities/health-doctor-questions/schema.ts';

const owner='11111111-1111-4111-8111-111111111111';
const environment={HARBOR_CHATGPT_OWNER_ID:owner,HARBOR_CHATGPT_MODEL:'gpt-6-luna',
  HARBOR_CHATGPT_REASONING_EFFORT:'high',OPENAI_API_KEY:'sk-test-backup'};
const base={prompt:'Synthetic request',json:true};
const stream=(text:string)=>new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:text})}\n\ndata: {"type":"response.completed"}\n\n`);

test('doctor questions use a strict root array envelope on both subscription and API backup',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    assert.deepEqual(body.text.format,{type:'json_schema',...doctorQuestionsJsonSchema,strict:true});
    calls++;
    if(calls===1)return Response.json({error:{code:'subscription_sharing_usage_limit_exceeded'}},{status:429});
    return stream('{"questions":["One?","Two?","Three?"]}');
  });
  const generate=createPreferredGeneration({environment,accessToken:async()=> 'synthetic-plan-token',audit:()=>{}});
  const result=await generate({...base,jsonSchema:doctorQuestionsJsonSchema});
  assert.equal(result.billingSource,'api-key');assert.equal(calls,2);
  assert.ok(Array.isArray(result.parsed?.questions));
});

test('text and image requests use the plan first, Luna high, and the supported Responses contract',async t=>{
  const bodies:any[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-plan-token');
    bodies.push(JSON.parse(String(init.body)));
    return stream('{"ok":true}');
  });
  const generate=createPreferredGeneration({environment,accessToken:async id=>{assert.equal(id,owner);return 'synthetic-plan-token';},audit:()=>{}});
  const result=await generate({...base,instructions:'Extract synthetic data',imageBase64:'aW1hZ2U=',imageMimeType:'image/png'});
  assert.deepEqual(result.parsed,{ok:true});
  assert.equal(result.billingSource,'chatgpt-plan');
  assert.deepEqual(bodies[0],{model:'gpt-6-luna',input:[{role:'user',content:[
    {type:'input_text',text:base.prompt+'\n\nReturn only a valid JSON object.'},{type:'input_image',image_url:'data:image/png;base64,aW1hZ2U='},
  ]}],store:false,stream:true,instructions:'Extract synthetic data\n\nReturn only a valid JSON object.',
    text:{format:{type:'json_object'}},reasoning:{effort:'high'}});
  await generate(base);
  assert.equal(bodies[1].input[0].content,base.prompt+'\n\nReturn only a valid JSON object.');
  await generate({prompt:'Plain task'});
  assert.equal(bodies[2].input[0].content,'Plain task');
  assert.equal(bodies[2].text,undefined);
});

test('limits, expired sessions, invalid JSON, incomplete streams and network failures activate the API backup',async t=>{
  for(const failure of ['limit','refresh','json','incomplete','network'])await t.test(failure,async t=>{
    const used:string[]=[];
    const events:object[]=[];
    t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{
      const token=new Headers(init.headers).get('authorization')!;
      used.push(token);
      const body=JSON.parse(String(init.body));
      assert.equal(body.model,'gpt-6-luna');assert.deepEqual(body.reasoning,{effort:'high'});
      if(token==='Bearer synthetic-plan-token') {
        if(failure==='limit')return Response.json({error:{code:'subscription_sharing_usage_limit_exceeded'}},{status:429});
        if(failure==='json')return stream('invalid JSON');
        if(failure==='incomplete')return new Response('data: {"type":"response.incomplete"}\n\n');
        throw new Error('sensitive upstream detail');
      }
      return stream('{"backup_ok":true}');
    });
    const generate=createPreferredGeneration({environment,accessToken:async()=>{
      if(failure==='refresh')throw new PlanError('CHATGPT_RECONNECT',409);
      return 'synthetic-plan-token';
    },audit:event=>events.push(event)});
    const result=await generate(base);
    assert.equal(result.billingSource,'api-key');
    assert.deepEqual(result.parsed,{backup_ok:true});
    assert.equal(used.at(-1),'Bearer sk-test-backup');
    assert.ok(events.some((event:any)=>event.event==='api_backup_started'));
    assert.ok(!JSON.stringify(events).includes('sk-test-backup')&&!JSON.stringify(events).includes('sensitive'));
  });
});

test('refusal, ownership failure and caller cancellation never consume a backup key',async t=>{
  for(const kind of ['refusal','content-filter','owner','cancel-before','cancel-during'])await t.test(kind,async t=>{
    let requests=0;
    const controller=new AbortController();
    if(kind==='cancel-before')controller.abort();
    t.mock.method(globalThis,'fetch',async()=>{
      requests++;
      if(kind==='cancel-during') {controller.abort();throw new Error('cancelled');}
      if(kind==='content-filter')return new Response('data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n');
      return new Response('data: {"type":"response.refusal.delta","delta":"Refused"}\n\n');
    });
    const generate=createPreferredGeneration({environment,accessToken:async()=> 'synthetic-plan-token',audit:()=>{}});
    await assert.rejects(generate({...base,signal:controller.signal,ownerId:kind==='owner'?'other':owner}));
    assert.equal(requests,kind==='owner'||kind==='cancel-before'?0:1);
  });
});

test('backup keys are deduplicated and failures end without legacy-provider billing',async()=>{
  const tokens:string[]=[];
  const generate=createPreferredGeneration({environment:{...environment,OPENAI_API_KEY_1:environment.OPENAI_API_KEY,GEMINI_API_KEY:'unused'},
    accessToken:async()=>{throw new PlanError('CHATGPT_LIMIT',429);},
    request:async token=>{tokens.push(token);throw new Error('unavailable');},audit:()=>{}});
  await assert.rejects(generate(base),{message:'CHATGPT_UNAVAILABLE'});
  assert.deepEqual(tokens,['sk-test-backup']);
});

test('completed-event output is accepted and partial output without completion is rejected',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"Complete"}]}]}}\n\n'));
  assert.equal(await generateResponse('synthetic',{model:'gpt-6-luna',prompt:'test'}),'Complete');
  t.mock.method(globalThis,'fetch',async()=>new Response('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n'));
  await assert.rejects(generateResponse('synthetic',{model:'gpt-6-luna',prompt:'test'}));
});

test('the shared JSON provider and health image OCR select ChatGPT even when the caller requests OpenAI',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'harbor-routing-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  // runtime.ts was imported with the factory above; the public wrapper still exercises the real fallback transport.
  Object.assign(process.env,{...environment,HARBOR_AI_PRIMARY:'chatgpt'});
  t.after(()=>{for(const key of [...Object.keys(environment),'HARBOR_AI_PRIMARY'])delete process.env[key];});
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{
    calls++;
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer sk-test-backup');
    const body=JSON.parse(String(init.body));assert.equal(body.model,'gpt-6-luna');
    return stream('{"rawText":"SYNTHETIC OCR","documentCategory":"general_health","observations":[]}');
  });
  const {generateAiJsonResponse}=await import('../lib/ai-provider.ts');
  const {handleHealthImageOcr}=await import('../agent/capabilities/health-ocr/image-handler.ts');
  const result=await generateAiJsonResponse({systemPrompt:'JSON',userPrompt:'test',provider:'openai'});
  assert.equal(result?.billingSource,'api-key');
  const ocr=await handleHealthImageOcr({documentContent:'data:image/png;base64,c3ludGhldGlj'});
  assert.equal(ocr?.extractedText,'SYNTHETIC OCR');assert.equal(calls,2);
});

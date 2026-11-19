import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

test('Developer HTTP run uses the shared fallback and retains owner and service authorization',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'harbor-preferred-http-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
  Object.assign(process.env,{HARBOR_AI_PRIMARY:'chatgpt',HARBOR_CHATGPT_LOCAL_ORIGIN:'http://127.0.0.1:3010',
    HARBOR_DEVELOPER_SERVICE_TOKEN:'synthetic-service-secret',HARBOR_CHATGPT_DATA_DIR:directory,HOST:'127.0.0.1',
    HARBOR_CHATGPT_OWNER_ID:owner,HARBOR_CHATGPT_MODEL:'gpt-6-luna',HARBOR_CHATGPT_REASONING_EFFORT:'high',OPENAI_API_KEY:'sk-synthetic-backup'});
  const {session}=await import('../agent/capabilities/chatgpt-plan/runtime.ts');assert.ok(session);
  let limited=false,upstream=0;
  t.mock.method(session,'accessToken',async()=>{if(limited)throw new Error('session temporarily unavailable');return 'synthetic-plan';});
  const localFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{
    upstream++;
    assert.equal(new Headers(init.headers).get('authorization'),limited?'Bearer sk-synthetic-backup':'Bearer synthetic-plan');
    assert.equal(JSON.parse(String(init.body)).reasoning.effort,'high');
    return new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  const {handleChatGptPlan}=await import('../agent/capabilities/chatgpt-plan/route.ts');
  const server=createServer((req,res)=>{void handleChatGptPlan(req,res,req.url??'');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const address=server.address() as {port:number};
  async function call(actor=owner,token='synthetic-service-secret',model='gpt-6-luna') {
    const res=await localFetch(`http://127.0.0.1:${address.port}/api/internal/chatgpt-plan/run`,{
      method:'POST',headers:{Authorization:'Bearer '+token,'X-Harbor-Subject-Id':actor},body:JSON.stringify({model,prompt:'Synthetic task'}),
    });
    return {status:res.status,...await res.json()};
  }
  assert.equal((await call()).billingSource,'chatgpt-plan');
  limited=true;
  const backup=await call();assert.equal(backup.status,200);assert.equal(backup.billingSource,'api-key');assert.equal(backup.answer,'OK');
  assert.equal((await call(other)).status,403);assert.equal((await call(owner,'wrong')).status,403);
  assert.equal((await call(owner,undefined,'another-model')).status,400);assert.equal(upstream,2);
});

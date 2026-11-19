import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';

test('only the linked Developer can run internal Responses requests through the renewable OAuth session',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'harbor-chatgpt-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const secret='local-synthetic-integration-secret';
  const origin='http://127.0.0.1:3010';
  const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
  Object.assign(process.env,{HARBOR_CHATGPT_LOCAL_ORIGIN:origin,HARBOR_DEVELOPER_SERVICE_TOKEN:secret,
    HARBOR_CHATGPT_DATA_DIR:directory,HOST:'127.0.0.1'});

  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const jwk={...await exportJWK(publicKey),kid:'fixture'};
  t.mock.method(https,'get',(url:string)=>{
    assert.equal(url,'https://auth.openai.com/.well-known/jwks.json');
    const request=new EventEmitter();
    queueMicrotask(()=>{
      const response=Readable.from([Buffer.from(JSON.stringify({keys:[jwk]}))]);
      request.emit('response',Object.assign(response,{statusCode:200}));
    });
    return request;
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const localFetch=globalThis.fetch;
  const clientId='oaiapp_harbor_fixture';
  const scopes='openid email profile offline_access resource.invoke chatgpt.tokens.use.direct';
  let authorization:URL,refreshes=0,completed=0,revoked=0;
  let limitReached=false;
  let httpLimitReached=false;
  let highReasoning=false;
  t.mock.method(globalThis,'fetch',async (input:string,init:RequestInit)=>{
    const url=new URL(input);
    if(url.pathname.endsWith('/oauth/token')) {
      assert.equal(url.origin,'https://auth.openai.com');
      const form=init.body as URLSearchParams;
      assert.equal(form.get('client_id'),clientId);
      assert.equal(form.get('resource'),'https://api.openai.com/v1');
      if(form.get('grant_type')==='refresh_token') {
        assert.equal(form.get('refresh_token'),'first-refresh');
        refreshes++;
        return Response.json({access_token:'renewed-access',refresh_token:'renewed-refresh',expires_in:3600});
      }
      assert.equal(form.get('code'),'fixture-code');
      assert.equal(form.get('redirect_uri'),origin+'/api/chatgpt-plan/callback');
      assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),authorization.searchParams.get('code_challenge'));
      const idToken=await new SignJWT({nonce:authorization.searchParams.get('nonce'),email:'owner@example.invalid'})
        .setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://auth.openai.com').setAudience(clientId)
        .setSubject('fixture-account').setIssuedAt().setExpirationTime('5m').sign(privateKey);
      return Response.json({scope:scopes,access_token:'first-access',refresh_token:'first-refresh',expires_in:30,id_token:idToken});
    }
    if(url.pathname.endsWith('/oauth/revoke')) {
      assert.equal((init.body as URLSearchParams).get('token'),'renewed-refresh');
      revoked++;
      return new Response(null,{status:200});
    }
    assert.equal(url.origin,'https://api.openai.com');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer renewed-access');
    if(url.pathname==='/v1/models')return Response.json({models:[
      {slug:'eligible-model',display_name:'Eligible model',visibility:'list'},
      {slug:'hidden-model',display_name:'Hidden model',visibility:'hidden'},
    ]});
    assert.equal(url.pathname,'/v1/responses');
    assert.deepEqual(JSON.parse(String(init.body)),{model:'eligible-model',input:[{role:'user',content:'Internal task'}],store:false,stream:true,
      ...(highReasoning?{reasoning:{effort:'high'}}:{})});
    if(httpLimitReached)return Response.json({error:{code:'subscription_sharing_usage_limit_exceeded'}},{status:402});
    if(limitReached)return new Response('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n');
    completed++;
    return new Response('data: {"type":"response.output_text.delta","delta":"Internal answer"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n');
  });

  const {handleChatGptPlan}=await import('../agent/capabilities/chatgpt-plan/route.ts');
  const server=createServer((req,res)=>{void handleChatGptPlan(req,res,req.url??'');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.close();});
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  async function call(operation:string,input={},actor=owner,bearer=secret) {
    const response=await localFetch(`http://127.0.0.1:${(address as {port:number}).port}/api/internal/chatgpt-plan/${operation}`,{
      method:'POST',headers:{Authorization:`Bearer ${bearer}`,'X-Harbor-Subject-Id':actor},body:JSON.stringify(input),
    });
    return {status:response.status,data:await response.json()};
  }

  assert.equal((await call('connect',{},owner,'wrong-secret')).status,403);
  const started=await call('connect');
  authorization=new URL(started.data.authorizationUrl);
  assert.equal(authorization.searchParams.get('client_id'),'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('agent_name_hint'),'Harbor Agent');
  assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
  const callback={state:started.data.state,code:'fixture-code',clientId};
  assert.equal((await call('callback',callback,other)).status,400);
  assert.equal((await call('callback',{...callback,state:'wrong-state'})).status,400);
  assert.equal((await call('callback',callback)).status,200);
  assert.equal((await call('callback',callback)).status,400);
  assert.equal((await call('status',{},other)).status,403);
  assert.deepEqual((await call('status')).data,{connected:true,email:'owner@example.invalid'});
  const encrypted=await readFile(join(directory,'session.jwe'),'utf8');
  assert.ok(!encrypted.includes('first-access')&&!encrypted.includes('first-refresh'));
  assert.equal(encrypted.split('.').length,5);
  const run={model:'eligible-model',prompt:'Internal task'};
  assert.equal((await call('run',run,other)).status,403);
  const [modelResponse,task]=await Promise.all([call('models'),call('run',run)]);
  assert.deepEqual(modelResponse.data.models,[{id:'eligible-model',name:'Eligible model'}]);
  assert.deepEqual(task.data,{answer:'Internal answer'});
  assert.equal(refreshes,1);
  assert.equal(completed,1);
  Object.assign(process.env,{HARBOR_CHATGPT_MODEL:'eligible-model',HARBOR_CHATGPT_REASONING_EFFORT:'high'});
  t.after(()=>{delete process.env.HARBOR_CHATGPT_MODEL;delete process.env.HARBOR_CHATGPT_REASONING_EFFORT;});
  highReasoning=true;
  assert.deepEqual((await call('status')).data,{connected:true,email:'owner@example.invalid',model:'eligible-model',reasoningEffort:'high'});
  assert.deepEqual((await call('models')).data.models,[{id:'eligible-model',name:'Eligible model'}]);
  assert.equal((await call('run',{...run,model:'different-model'})).status,400);
  assert.equal(completed,1);
  assert.deepEqual((await call('run',{...run,reasoningEffort:'none'})).data,
    {answer:'Internal answer',model:'eligible-model',reasoningEffort:'high'});
  process.env.HARBOR_CHATGPT_REASONING_EFFORT='invalid';
  assert.deepEqual(await call('status'),{status:503,data:{error:'CHATGPT_CONFIG_INVALID'}});
  process.env.HARBOR_CHATGPT_REASONING_EFFORT='high';
  limitReached=true;
  assert.equal((await call('run',run)).status,429);
  httpLimitReached=true;
  assert.deepEqual(await call('run',run),{status:429,data:{error:'CHATGPT_LIMIT'}});
  assert.deepEqual((await call('disconnect')).data,{connected:false,revoked:true});
  assert.equal(revoked,1);
  assert.equal((await call('run',run)).status,409);
  assert.equal(new URL((await call('connect')).data.authorizationUrl).searchParams.get('client_id'),clientId);
});

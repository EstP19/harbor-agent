import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {Readable} from 'node:stream';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';

const database=process.env.HARBOR_CHATGPT_TEST_DATABASE_URL;
test('hosted authorization waits for approval and consumes each callback once across Agent instances',
  {skip:!database},async t=>{
    const url=new URL(database!);
    assert.equal(url.hostname,'127.0.0.1');
    assert.match(url.pathname,/^\/harbor_chatgpt_test_[a-z0-9]+$/);
    process.env.DATABASE_URL=database;
    const {pool}=await import('../lib/db.ts');
    t.after(()=>pool.end());
    const {createChatGptSession}=await import('../agent/capabilities/chatgpt-plan/session.ts');
    const {publicKey,privateKey}=await generateKeyPair('RS256');
    const jwk={...await exportJWK(publicKey),kid:'hosted-fixture'};
    t.mock.method(https,'get',()=>{
      const request=new EventEmitter();
      queueMicrotask(()=>request.emit('response',Object.assign(
        Readable.from([Buffer.from(JSON.stringify({keys:[jwk]}))]),{statusCode:200})));
      return request;
    });
    syncBuiltinESMExports();
    t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});

    const owner='11111111-1111-4111-8111-111111111111';
    const other='22222222-2222-4222-8222-222222222222';
    const origin='https://developer.example.invalid';
    const base={origin,stateKey:'a'.repeat(64),planScopes:['hosted.fixture.plan']};
    const client={id:'oaiapp_hosted_fixture',method:'client_secret_basic' as const,secret:'fixture-secret'};
    const pending=createChatGptSession({...base,planScopes:[]});
    assert.deepEqual(await pending.status(owner),{configured:false,connected:false});
    await assert.rejects(()=>pending.start(owner),/CHATGPT_APPROVAL_PENDING/);

    const first=createChatGptSession({...base,client});
    const second=createChatGptSession({...base,client});
    const started=await first.start(owner);
    const authorization=new URL(started.authorizationUrl);
    assert.equal(authorization.searchParams.get('client_id'),client.id);
    assert.equal(authorization.searchParams.get('redirect_uri'),origin+'/api/chatgpt-plan/callback');
    assert.equal(authorization.searchParams.get('scope'),'openid profile email offline_access hosted.fixture.plan');
    assert.equal(authorization.searchParams.has('ext_agent_host_id'),false);
    assert.equal(authorization.searchParams.has('client_secret'),false);

    const idToken=await new SignJWT({nonce:authorization.searchParams.get('nonce'),email:'fixture@example.invalid'})
      .setProtectedHeader({alg:'RS256',kid:'hosted-fixture'}).setIssuer('https://auth.openai.com').setAudience(client.id)
      .setSubject('hosted-account').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    let exchanges=0;
    t.mock.method(globalThis,'fetch',async (endpoint:string,init:RequestInit)=>{
      assert.equal(endpoint,'https://auth.openai.com/api/accounts/oauth/token');
      assert.equal(new Headers(init.headers).get('authorization'),'Basic '+Buffer.from(client.id+':fixture-secret').toString('base64'));
      const form=init.body as URLSearchParams;
      assert.equal(form.has('client_secret'),false);
      assert.equal(form.get('redirect_uri'),origin+'/api/chatgpt-plan/callback');
      exchanges++;
      return Response.json({id_token:idToken,scope:'openid offline_access hosted.fixture.plan',
        access_token:'hosted-access-fixture',refresh_token:'hosted-refresh-fixture',expires_in:3600});
    });
    const callback={state:started.state,code:'fixture-code'};
    await assert.rejects(()=>second.complete(other,callback),/CHATGPT_INVALID_CALLBACK/);
    const results=await Promise.allSettled([first.complete(owner,callback),second.complete(owner,callback)]);
    assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
    assert.equal(exchanges,1);
    assert.equal(await second.accessToken(owner),'hosted-access-fixture');
    await assert.rejects(()=>second.accessToken(other),/CHATGPT_ALREADY_LINKED/);
    const {rows}=await pool.query<{state:string}>('SELECT state FROM agent_core.chatgpt_plan_session WHERE singleton');
    assert.equal(rows[0].state.includes('hosted-refresh-fixture'),false);
    assert.equal(rows[0].state.split('.').length,5);

    await t.test('local OAuth hands off a protected session to the VM once, preserving its host and owner',async()=>{
      await pool.query("UPDATE agent_core.chatgpt_plan_session SET state='' WHERE singleton");
      const directory=await mkdtemp(join(tmpdir(),'harbor-chatgpt-transfer-'));
      t.after(()=>rm(directory,{recursive:true,force:true}));
      const vm=createChatGptSession({...base,mode:'self-hosted'});
      const vmReplica=createChatGptSession({...base,mode:'self-hosted'});
      assert.deepEqual(await vm.status(owner),{mode:'self-hosted',ownerId:owner,connected:false,email:undefined});
      await assert.rejects(()=>vm.start(owner),/CHATGPT_LOCAL_AUTH_REQUIRED/);
      const recipient=await vm.prepareImport(owner);
      assert.equal('d' in recipient.publicKey,false);
      const hostId=recipient.hostId;
      const local=createChatGptSession({origin:'http://127.0.0.1:1455',localSecret:'fixture-local-encryption-key',directory});
      const started=await local.start(owner);
      const url=new URL(started.authorizationUrl);
      assert.notEqual(url.searchParams.get('ext_agent_host_id'),hostId);
      const localClient='oaiapp_local_fixture';
      const localToken=await new SignJWT({nonce:url.searchParams.get('nonce'),email:'fixture@example.invalid'})
        .setProtectedHeader({alg:'RS256',kid:'hosted-fixture'}).setIssuer('https://auth.openai.com').setAudience(localClient)
        .setSubject('local-account').setIssuedAt().setExpirationTime('5m').sign(privateKey);
      let refreshed=0;
      t.mock.method(globalThis,'fetch',async(endpoint:string,init:RequestInit)=>{
        assert.equal(endpoint,'https://auth.openai.com/api/accounts/oauth/token');
        const form=init.body as URLSearchParams;
        assert.equal(form.get('client_id'),localClient);
        assert.equal(form.has('client_secret'),false);
        assert.equal(new Headers(init.headers).has('authorization'),false);
        if(form.get('grant_type')==='refresh_token'){
          refreshed++;
          assert.equal(form.get('refresh_token'),'local-refresh-fixture');
          return Response.json({access_token:'vm-access-fixture',refresh_token:'vm-refresh-fixture',expires_in:3600});
        }
        assert.equal(form.get('redirect_uri'),'http://127.0.0.1:1455/api/chatgpt-plan/callback');
        return Response.json({id_token:localToken,access_token:'local-access-fixture',refresh_token:'local-refresh-fixture',
          expires_in:30,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});
      });
      await local.complete(owner,{state:started.state,code:'local-code',clientId:localClient});
      await assert.rejects(()=>local.exportForVm(other,recipient,async()=>{}),/CHATGPT_ALREADY_LINKED/);
      await assert.rejects(()=>local.exportForVm(owner,recipient,async()=>{throw Error('disk full');}),/disk full/);
      assert.equal((await local.status(owner)).connected,true);
      let envelope='';
      await local.exportForVm(owner,recipient,async value=>{envelope=value;});
      assert.equal(envelope.includes('local-refresh-fixture'),false);
      assert.equal(envelope.split('.').length,5);
      assert.equal((await local.status(owner)).connected,false);
      const localState=await readFile(join(directory,'session.jwe'),'utf8');
      assert.equal(localState.includes('local-access-fixture'),false);
      await assert.rejects(()=>vm.importFromLocal(other,envelope),/CHATGPT_INVALID_TRANSFER/);
      const imported=await Promise.allSettled([vm.importFromLocal(owner,envelope),vmReplica.importFromLocal(owner,envelope)]);
      assert.equal(imported.filter(r=>r.status==='fulfilled').length,1);
      assert.equal((imported.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{hostId:string}>).value.hostId,hostId);
      const tokens=await Promise.all([vm.accessToken(owner),vmReplica.accessToken(owner)]);
      assert.deepEqual(tokens,['vm-access-fixture','vm-access-fixture']);
      assert.equal(refreshed,1);
      await assert.rejects(()=>vm.accessToken(other),/CHATGPT_ALREADY_LINKED/);
      assert.equal((await vm.prepareImport(owner)).hostId,hostId);
      await assert.rejects(()=>vm.importFromLocal(owner,envelope),/CHATGPT_INVALID_TRANSFER/);
      // A failed import cannot erase the already active session.
      assert.equal((await vm.status(owner)).connected,true);
      assert.equal(await vm.accessToken(owner),'vm-access-fixture');
    });
  });

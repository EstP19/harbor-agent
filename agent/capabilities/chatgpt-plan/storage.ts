import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {CompactEncrypt,compactDecrypt} from 'jose';
import {pool} from '../../../lib/db.ts';
import {PlanError} from './openai.ts';

type Operation<State,Result>=(read:()=>Promise<State>,save:(state:State)=>Promise<void>)=>Promise<Result>;

export function createChatGptStorage<State>(empty:State,settings:{localSecret:string;directory?:string}|{stateKey:string}) {
  const key='stateKey' in settings?Buffer.from(settings.stateKey,'hex')
    :createHash('sha256').update('Harbor Agent ChatGPT plan storage\0').update(settings.localSecret).digest();
  async function decode(data:string):Promise<State> {
    if(!data)return empty;
    try {
      const {plaintext}=await compactDecrypt(data,key,{keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM']});
      return JSON.parse(Buffer.from(plaintext).toString('utf8')) as State;
    } catch {throw new PlanError('CHATGPT_STORAGE_UNAVAILABLE',503);}
  }
  const encode=(value:State)=>new CompactEncrypt(Buffer.from(JSON.stringify(value)))
    .setProtectedHeader({alg:'dir',enc:'A256GCM'}).encrypt(key);

  if('stateKey' in settings) {
    return async function postgres<Result>(operation:Operation<State,Result>) {
      const client=await pool.connect().catch(()=>{throw new PlanError('CHATGPT_STORAGE_UNAVAILABLE',503);});
      let committed=false;
      try {
        await client.query('BEGIN');
        const {rows}=await client.query<{state:string}>(
          'SELECT state FROM agent_core.chatgpt_plan_session WHERE singleton FOR UPDATE');
        if(!rows[0])throw new PlanError('CHATGPT_STORAGE_UNAVAILABLE',503);
        const state=await decode(rows[0].state);
        const result=await operation(async()=>state,async value=>{
          await client.query('UPDATE agent_core.chatgpt_plan_session SET state=$1 WHERE singleton',[await encode(value)]);
        }).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
        // Callback state consumption and removal of invalid refresh tokens must
        // survive an upstream OAuth failure.
        await client.query('COMMIT');
        committed=true;
        if(!result.ok)throw result.error;
        return result.value;
      } catch(error) {
        if(!committed)await client.query('ROLLBACK').catch(()=>{});
        if((error as {code?:string}).code==='42P01'||(error as {code?:string}).code==='42501') {
          throw new PlanError('CHATGPT_STORAGE_UNAVAILABLE',503);
        }
        throw error;
      } finally {client.release();}
    };
  }

  const root=settings.directory??join(process.env.LOCALAPPDATA||homedir(),'harbor-agent','chatgpt');
  const path=join(root,'session.jwe');
  let queue:Promise<void>=Promise.resolve();
  async function read() {
    try {return await decode(await readFile(path,'utf8'));}
    catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return empty;
      throw new PlanError('CHATGPT_STORAGE_UNAVAILABLE',503);
    }
  }
  async function save(value:State) {
    const encrypted=await encode(value);
    await mkdir(root,{recursive:true,mode:0o700});
    const temporary=join(root,randomUUID()+'.tmp');
    try {
      await writeFile(temporary,encrypted,{flag:'wx',mode:0o600});
      await rename(temporary,path);
    } finally {await rm(temporary,{force:true});}
  }
  return function file<Result>(operation:Operation<State,Result>) {
    const next=queue.then(()=>operation(read,save));
    queue=next.then(()=>{},()=>{});
    return next;
  };
}

import '../lib/runtime-env.ts';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {createChatGptSession} from '../agent/capabilities/chatgpt-plan/session.ts';
import {validateRecipient} from '../agent/capabilities/chatgpt-plan/transfer.ts';
import {PlanError} from '../agent/capabilities/chatgpt-plan/openai.ts';
import {pool} from '../lib/db.ts';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  owner:{type:'string'},output:{type:'string'},file:{type:'string'},recipient:{type:'string'},
  directory:{type:'string'},port:{type:'string'},help:{type:'boolean'},
}});
const command=positionals[0];
const usage=`Harbor Agent ChatGPT session
  prepare-import --owner <Developer UUID> --output <vm.recipient.json>
    Run inside the Dokploy container with HARBOR_CHATGPT_MODE=self-hosted.
  login --recipient <vm.recipient.json> --output <session.jwe> [--port 1455]
    Run on your computer. Open the displayed OpenAI URL in your browser.
  import --owner <Developer UUID> --file <session.jwe>
    Run in the same Dokploy container that prepared the recipient.
  status --owner <Developer UUID>
Transfer files over SSH. Never paste tokens or keys into chat or commit them.`;

async function readSmall(filename:string) {
  const content=await readFile(resolve(filename),'utf8');
  if(Buffer.byteLength(content)>60_000)throw new PlanError('CHATGPT_INVALID_TRANSFER',400);
  return content;
}
async function writeProtected(filename:string,content:string) {
  // Refuse to overwrite an existing file, including symlinks.
  await writeFile(resolve(filename),content,{flag:'wx',mode:0o600});
}
function hostedSession() {
  const origin=process.env.HARBOR_CHATGPT_PUBLIC_ORIGIN;
  const stateKey=process.env.HARBOR_CHATGPT_STATE_KEY;
  if(process.env.HARBOR_CHATGPT_MODE!=='self-hosted'||!origin||!/^https:\/\/[a-z0-9.-]+$/.test(origin)
    ||!stateKey||!/^[a-f0-9]{64}$/i.test(stateKey)||!process.env.DATABASE_URL)throw new Error('CHATGPT_VM_NOT_CONFIGURED');
  return createChatGptSession({origin,stateKey,planScopes:[],mode:'self-hosted'});
}
function owner() {
  const id=values.owner??process.env.HARBOR_CHATGPT_OWNER_ID;
  if(!id||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))throw new Error('CHATGPT_OWNER_REQUIRED');
  return id;
}
async function localLogin() {
  if(!values.recipient||!values.output)throw new Error('CHATGPT_TRANSFER_FILES_REQUIRED');
  const recipient=validateRecipient(JSON.parse(await readSmall(values.recipient)));
  const directory=resolve(values.directory??join(process.env.LOCALAPPDATA||homedir(),'harbor-agent','chatgpt-cli'));
  await mkdir(directory,{recursive:true,mode:0o700});
  const keyFile=join(directory,'local.key');
  try {await writeProtected(keyFile,randomBytes(32).toString('hex'));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const localSecret=await readSmall(keyFile);
  if(!/^[a-f0-9]{64}$/i.test(localSecret))throw new Error('CHATGPT_LOCAL_KEY_INVALID');
  const port=Number(values.port??1455);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('CHATGPT_PORT_INVALID');
  const origin='http://127.0.0.1:'+port;
  const session=createChatGptSession({origin,localSecret,directory});
  let settle!:(error?:Error)=>void;
  const finished=new Promise<void>((resolve,reject)=>{settle=e=>e?reject(e):resolve();});
  const server=createServer((request,response)=>{
    void (async()=>{
      const url=new URL(request.url??'/',origin);
      if(request.method!=='GET'||request.headers.host!=='127.0.0.1:'+port||url.pathname!=='/api/chatgpt-plan/callback'){
        response.writeHead(404);response.end();return;
      }
      response.setHeader('Cache-Control','no-store');
      response.setHeader('Referrer-Policy','no-referrer');
      response.setHeader('Content-Type','text/plain; charset=utf-8');
      try {
        const result=await session.complete(recipient.ownerId,{
          state:url.searchParams.get('state'),code:url.searchParams.get('code'),
          clientId:url.searchParams.get('client_id'),error:url.searchParams.get('error'),
        });
        if(result.cancelled)throw new Error('CHATGPT_AUTHORIZATION_CANCELLED');
        await session.exportForVm(recipient.ownerId,recipient,encrypted=>writeProtected(values.output!,encrypted));
        response.end('ChatGPT autorizado. La sesión cifrada está lista para importar en tu servidor. Puedes cerrar esta pestaña.');
        settle();
      } catch(error) {
        response.statusCode=400;
        response.end('No se pudo completar la autorización. Consulta la terminal e inicia un intento nuevo.');
        // Ignore mismatched callbacks without terminating the legitimate attempt.
        if(!(error instanceof PlanError&&error.message==='CHATGPT_INVALID_CALLBACK'))settle(new Error('CHATGPT_LOGIN_FAILED'));
      }
    })().catch(()=>settle(new Error('CHATGPT_LOGIN_FAILED')));
  });
  const timer=setTimeout(()=>settle(new Error('CHATGPT_LOGIN_EXPIRED')),600_000);
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    const {authorizationUrl}=await session.start(recipient.ownerId);
    console.log('Continue with ChatGPT: abre esta dirección en el navegador de este computador:');
    console.log(authorizationUrl);
    await finished;
    console.log('Sesión cifrada exportada. Transfiere el archivo por SSH e impórtalo en Dokploy.');
    console.log('La sesión local dejó de usar estos tokens; el servidor será quien los renueve.');
  } finally {
    clearTimeout(timer);server.closeAllConnections();server.close();
  }
}
async function main() {
  if(values.help||!command){console.log(usage);return;}
  switch(command){
    case 'prepare-import':{
      if(!values.output)throw new Error('CHATGPT_OUTPUT_REQUIRED');
      const recipient=await hostedSession().prepareImport(owner());
      await writeProtected(values.output,JSON.stringify(recipient,null,2));
      console.log('Destinatario público creado; válido durante una hora. Host ID: '+recipient.hostId);
      break;
    }
    case 'login':await localLogin();break;
    case 'import':{
      if(!values.file)throw new Error('CHATGPT_FILE_REQUIRED');
      await hostedSession().importFromLocal(owner(),await readSmall(values.file));
      console.log('Sesión de ChatGPT importada y cifrada en PostgreSQL.');break;
    }
    case 'status':console.log(JSON.stringify(await hostedSession().status(owner())));break;
    default:throw new Error('CHATGPT_COMMAND_INVALID');
  }
}
main().catch(error=>{
  // Never print upstream responses, credentials, callback URLs, or stack traces.
  const code=error instanceof Error&&/^CHATGPT_[A-Z_]+$/.test(error.message)?error.message:'CHATGPT_SESSION_FAILED';
  console.error(code);process.exitCode=1;
}).finally(()=>pool.end());

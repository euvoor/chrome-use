import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startChrome} from './launcher.mjs';
import {api,waitFor} from '../inspect-acceptance/lib.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.ok(process.env.DISPLAY);assert.notEqual(process.getuid(),0);
const execute=promisify(execFile),out='stealth-evidence';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'amd-acceptance-'));
const base=path.resolve('scripts/amd-validation/node_modules/monaco-editor/min');
assert.ok(fs.existsSync(path.join(base,'vs/loader.js')));
const html=fs.readFileSync('scripts/amd-validation/fixture.html'),esmHtml=fs.readFileSync('scripts/amd-validation/esm.html');
const requests=[];
const server=http.createServer((req,res)=>{requests.push(req.url);const pathname=new URL(req.url,'http://localhost').pathname;const f=path.resolve(base,'.'+pathname);if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(req.url.includes("esm")?esmHtml:html);}else if(f.startsWith(base+'/')&&fs.existsSync(f)&&fs.statSync(f).isFile()){res.setHeader('Content-Type',f.endsWith('.css')?'text/css':f.endsWith('.js')?'application/javascript':'application/octet-stream');fs.createReadStream(f).pipe(res);}else{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
const evidence={source:process.env.GITHUB_SHA,package:'monaco-editor@0.52.0 min/vs',sandbox:true,modes:[],checks:[]};
const save=()=>fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify(evidence,null,2));
async function run(mode){
 const dir=path.join(root,mode),profile=path.join(dir,'profile'),home=path.join(dir,'home'),sockets=path.join(dir,'sockets');for(const p of [profile,home,sockets])fs.mkdirSync(p,{recursive:true});
 const bin=mode==='baseline'?path.join(process.env.RUNNER_TEMP,'chrome-use-baseline'):path.resolve('cli/target/ci/chrome-use');
 const env={PATH:process.env.PATH,DISPLAY:process.env.DISPLAY,XAUTHORITY:process.env.XAUTHORITY||'',LANG:'en_US.UTF-8',HOME:home,TMPDIR:process.env.RUNNER_TEMP,CHROME_USE_RELAY_DIR:path.join(home,'relay'),AGENT_BROWSER_SOCKET_DIR:sockets,AGENT_BROWSER_EXECUTABLE_PATH:process.env.CHROME,AGENT_BROWSER_NO_UPDATE_CHECK:'1',CHROME_USE_NO_UPDATE_CHECK:'1',AGENT_BROWSER_NO_AUTO_OPEN:'1',AGENT_BROWSER_NO_AUTO_RECONNECT:'1',NO_COLOR:'1'};
 const relay=mode==='relay',extension=path.resolve('extensions/ab-connect'),extId='ciiljdlhdpfckdcfkphgmfalanpdejep';
 if(relay){const quote=s=>"'"+s.replaceAll("'","'\\''")+"'",wrapper=path.join(dir,'host.sh');fs.writeFileSync(wrapper,`#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(env).map(([k,v])=>`${k}=${quote(v)}`).join(' ')} ${quote(bin)} __nm-host "$@"\n`,{mode:0o700});fs.mkdirSync(path.join(profile,'NativeMessagingHosts'),{recursive:true});fs.writeFileSync(path.join(profile,'NativeMessagingHosts/com.agent_browser.connect.json'),JSON.stringify({name:'com.agent_browser.connect',description:'owned AMD validation',path:wrapper,type:'stdio',allowed_origins:[`chrome-extension://${extId}/`]}));}
 let b, navigation=0;
 const cli=async args=>{let r;try{r=await execute(bin,['--session','amd-'+mode,'--json',...(!relay?['--cdp','http://127.0.0.1:9471']:[]),...args],{env,timeout:65000,maxBuffer:16*1024*1024});}catch(e){r=e;}for(const line of String(r.stdout||'').trim().split('\n').reverse()){try{return JSON.parse(line);}catch{}}throw Error(`CLI no JSON: ${r.stderr||r.message}`);};
 const ok=async args=>{const r=await cli(args);assert.equal(r.success,true,JSON.stringify(r));return r.data;};
 const evaluate=async expr=>{const d=await ok(['eval',expr]);return d&&Object.hasOwn(d,'result')?d.result:d;};
 try{
 b=await startChrome(profile,env,relay?[`--load-extension=${extension}`,`--disable-extensions-except=${extension}`]:[]);const A=api(b);
 if(relay){const w=await A.worker();await waitFor(()=>A.evaluate(w.sid,"typeof chrome!=='undefined'&&!!chrome.storage?.local"));await A.evaluate(w.sid,'chrome.storage.local.set({ab_stealth:true,ab_cursor:true})');await waitFor(()=>fs.existsSync(path.join(env.CHROME_USE_RELAY_DIR,'relay-cdp-url')),{timeout:30000});evidence.stealth=await A.evaluate(w.sid,"chrome.storage.local.get(['ab_stealth','ab_cursor'])");}
 evidence.modes.push({mode,browser:b.version});save();
 await b.send('Browser.grantPermissions',{origin:url.slice(0,-1),permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
 const open=async(variant='amd')=>{const targetUrl=url+'?variant='+variant+'&navigation='+(++navigation);await ok(['open',targetUrl]);await waitFor(()=>evaluate(`window.fixture?.url===${JSON.stringify(targetUrl)}`),{timeout:30000});const target=(await A.targets()).find(t=>t.type==='page'&&t.url===targetUrl);await b.send('Target.activateTarget',{targetId:target.targetId});await waitFor(()=>evaluate('document.hasFocus()'));evidence.checks.push({mode,navigation,targetUrl,targets:await A.targets(),observed:await evaluate('({url:location.href,fixtureUrl:fixture.url,focus:document.hasFocus(),visibility:document.visibilityState})')});save();assert.deepEqual(await evaluate('[typeof monaco,typeof require,typeof define]'),['undefined','undefined','undefined']);
 await evaluate('fixture.events.length=0');const beforeClick=await cli(['press','Shift']);const beforeEvents=await evaluate('fixture.events');
 await ok(['click','#one']);await evaluate('fixture.events.length=0');const afterClick=await cli(['press','Shift']);const afterEvents=await evaluate('fixture.events');
 evidence.checks.push({mode,navigation,keyboardControl:{beforeClick,beforeEvents,afterClick,afterEvents}});save();assert.ok(afterEvents.some(e=>e.type==='keydown'&&e.trusted),'owned renderer must receive native keyboard input before testing model discovery');
 };
 if(mode==='baseline'){
  await open();
  await evaluate("fixture.seed('baseline sentinel')");const response=await cli(['fill','#one','baseline AMD input']);evidence.baseline={response,observed:await evaluate('fixture.read(0)')};save();assert.notEqual(response.data?.engine,'monaco-native','baseline must reproduce the discovery gap');return;
 }
 for(const variant of ['amd','esm']){
 await open(variant);await ok(['get','value','#one']);
 for(const [i,target] of ['one','two'].entries())for(const value of ['hello 你好 — café\nsecond line',Array.from({length:300},(_,n)=>'line '+n).join('\n'),'']){
  await evaluate("fixture.seed('native clipboard sentinel')");const before=await evaluate(`({globals:Object.getOwnPropertyNames(window).sort(),other:fixture.read(${1-i})})`);await evaluate('fixture.events.length=0;fixture.calls.length=0');const requestCount=requests.length;
  const response=await cli(['fill','#'+target,value]);const read=await cli(['get','value','#'+target]);const after=await evaluate(`(async()=>({globals:Object.getOwnPropertyNames(window).sort(),value:fixture.read(${i}),other:fixture.read(${1-i}),clipboard:await fixture.clipboard(),events:fixture.events,calls:fixture.calls,errors:fixtureErrors}))()`);
  const record={mode,variant,target,valueLength:value.length,response,read,before,after,requests:requests.slice(requestCount)};evidence.checks.push(record);save();
  assert.equal(response.success,true,JSON.stringify(response));assert.equal(response.data.engine,'monaco-native');assert.equal(read.success,true);assert.equal(read.data.value,value);assert.equal(after.value,value);assert.equal(after.other,before.other);assert.equal(after.clipboard,'native clipboard sentinel');assert.deepEqual(after.calls,[]);assert.deepEqual(after.globals,before.globals);assert.deepEqual(after.errors,[]);assert.ok(after.events.some(e=>e.type==='keydown'));assert.ok(after.events.every(e=>e.trusted&&!['copy','paste'].includes(e.type)));assert.deepEqual(record.requests,[]);
 }
 }
 for(const fault of ['focus','swap','reject','concurrent']){
  await open();await evaluate("fixture.seed('fault sentinel')");await evaluate(`fixture.arm(${JSON.stringify(fault)});fixture.events.length=0;fixture.calls.length=0`);
  const response=await cli(['fill','#one','must be verified']);await evaluate('fixture.settle()');const after=await evaluate('(async()=>({fired:fixture.state().fired,value:fixture.read(0),other:fixture.read(1),clipboard:await fixture.clipboard(),calls:fixture.calls,events:fixture.events}))()');evidence.checks.push({mode,fault,response,after});save();assert.equal(after.fired,true);assert.deepEqual(after.calls,[]);assert.equal(after.other,'second');assert.ok(after.events.every(e=>e.trusted&&!['copy','paste'].includes(e.type)));
  if(fault==='concurrent'){assert.equal(response.success,true);assert.equal(after.value,'must be verified');assert.equal(after.clipboard,'new concurrent clipboard');}else{assert.equal(response.success,false,JSON.stringify(response));assert.equal(after.value,fault==='swap'?'replacement model':'first');assert.equal(after.clipboard,'fault sentinel');}
 }
 }finally{await cli(['close']).catch(()=>{});if(b)await b.close();}
}
try{for(const mode of process.env.SKIP_BASELINE==='1'?['cdp','relay']:['baseline','cdp','relay'])await run(mode);evidence.passed=true;save();console.log('Browser acceptance passed:',evidence.checks.length,'records');}catch(error){evidence.error=String(error.stack||error);save();throw error;}finally{server.close();fs.rmSync(root,{recursive:true,force:true});}

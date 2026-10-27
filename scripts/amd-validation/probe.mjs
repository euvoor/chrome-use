import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {startChrome} from './launcher.mjs';
import {api,waitFor} from '../inspect-acceptance/lib.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.ok(process.env.DISPLAY);assert.notEqual(process.getuid(),0);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amd-probe-'));
const base=path.resolve('scripts/amd-validation/node_modules/monaco-editor/min');
const html=`<!doctype html><div id="one" style="width:700px;height:300px"></div><div id="two" style="width:700px;height:300px"></div><script src="/vs/loader.js"></script><script>
require.config({paths:{vs:'/vs'}});require(['vs/editor/editor.main'],function(){
const one=monaco.editor.create(document.getElementById('one'),{value:'first',language:'plaintext',editContext:false});
const two=monaco.editor.create(document.getElementById('two'),{value:'second',language:'plaintext',editContext:false});
window.fixtureRead=()=>[one.getValue(),two.getValue()];
delete window.monaco;delete window.require;delete window.define;window.fixtureReady=true;
});</script>`;
const server=http.createServer((req,res)=>{const f=path.resolve(base,'.'+new URL(req.url,'http://localhost').pathname);if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}else if(f.startsWith(base+'/')&&fs.existsSync(f)&&fs.statSync(f).isFile()){res.setHeader('Content-Type',f.endsWith('.css')?'text/css':f.endsWith('.js')?'application/javascript':'application/octet-stream');fs.createReadStream(f).pipe(res);}else{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let b;
try{
 b=await startChrome(path.join(dir,'profile'),{PATH:process.env.PATH,HOME:dir,DISPLAY:process.env.DISPLAY,XAUTHORITY:process.env.XAUTHORITY||'',LANG:'en_US.UTF-8'},[]);
 const A=api(b);const {targetId}=await b.send('Target.createTarget',{url:`http://127.0.0.1:${server.address().port}/`});const sid=await A.attach(targetId);
 await waitFor(()=>A.evaluate(sid,'window.fixtureReady===true'),{timeout:30000});
 assert.deepEqual(await A.evaluate(sid,'[typeof monaco,typeof require,typeof define]'),['undefined','undefined','undefined']);
 const send=(m,p)=>b.send(m,p,sid);
 const input=(await send('Runtime.evaluate',{expression:"document.querySelector('#one textarea.inputarea')",objectGroup:'probe'})).result.objectId;
 const ls=await send('DOMDebugger.getEventListeners',{objectId:input});
 fs.writeFileSync('stealth-evidence/listeners.json',JSON.stringify(ls,null,2));
 const queue=[],seen=new Set(),results=[];
 function add(v,p,d){if(!v?.objectId||seen.has(v.objectId)||seen.size>3000||v.subtype==='node'||v.description==='Global'||v.description==='Window')return;seen.add(v.objectId);queue.push({v,p,d});}
 for(const l of ls.listeners.filter(x=>['copy','input','keydown'].includes(x.type)))add(l.originalHandler||l.handler,l.type,0);
 while(queue.length&&results.length<650){const {v,p,d}=queue.shift();const props=await send('Runtime.getProperties',{objectId:v.objectId,ownProperties:true,generatePreview:true});results.push({path:p,depth:d,object:v,...props});if(d>=12)continue;
 for(const t of props.internalProperties||[])if(['[[Scopes]]','[[TargetFunction]]','[[BoundThis]]','[[Prototype]]'].includes(t.name))add(t.value,p+'.'+t.name,d+1);
 for(const t of props.result||[]){if(t.name==='__proto__'||['window','document','globalThis'].includes(t.name))continue;add(t.value,p+'.'+t.name,d+1);}
 }
 fs.writeFileSync('stealth-evidence/graph.json',JSON.stringify({browser:b.version,objects:results},null,2));
 console.log('Recorded',results.length,'descriptor objects');
 await send('Runtime.releaseObjectGroup',{objectGroup:'probe'});
}finally{if(b)await b.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}

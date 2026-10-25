// CI-only acceptance rig: disposable GitHub-hosted VM, fresh browser profiles,
// temporary native-host/CLI directories, fixture data only. Never run locally.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { waitFor, api } from '../inspect-acceptance/lib.mjs';
import { checkEditors } from './editor-checks.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'this rig is CI-only');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'use a disposable GitHub runner');
assert.ok(process.env.DISPLAY, 'headed acceptance requires a virtual display');
assert.notEqual(process.getuid(), 0, 'Chrome must run as a non-root user');
const execute = promisify(execFile);
const bin = path.resolve(process.env.HOST_BIN);
const chrome = path.resolve(process.env.CHROME);
const extDir = path.resolve('extensions/ab-connect');
const editorMode = process.env.STEALTH_EDITORS === '1';
const editorDist = process.env.EDITOR_DIST && path.resolve(process.env.EDITOR_DIST);
const extId = 'ciiljdlhdpfckdcfkphgmfalanpdejep';
const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'stealth-accept-'));
const outDir = path.resolve(process.env.ACCEPT_OUT || 'stealth-evidence');
fs.mkdirSync(outDir, { recursive: true });
const evidence = {
  commit: process.env.GITHUB_SHA,
  binarySha256: createHash('sha256').update(fs.readFileSync(bin)).digest('hex'),
  extensionVersion: JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'))).version,
  runner: process.env.RUNNER_OS, work, checks: [], modes: [],
};
const save = () => fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
async function check(name, fn) {
  try { const result = await fn(); evidence.checks.push({ name, ok: true, result }); console.log(`PASS ${name}`); }
  catch (error) { evidence.checks.push({ name, ok: false, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`); }
  save();
}
const fixture = crossPort => `<!doctype html><meta charset="utf-8"><title>Stealth fixture</title>
<style>body{margin:24px;min-height:1500px}button{width:180px;height:40px}#editor{border:1px solid;width:400px;min-height:60px}iframe{width:440px;height:180px}#cover{display:none;position:fixed;inset:0;z-index:9999}</style>
<button id="double">Double target</button><button id="moving">Moving target</button>
<div id="editor" contenteditable="true">old text</div><div id="cover"></div>
<iframe id="same" src="/child"></iframe><iframe id="cross" src="http://localhost:${crossPort}/child"></iframe>
<script>
window.audit={events:[],mutations:[],doubleCount:0,frameEvents:[]};
window.addEventListener('message',e=>{if(e.data?.fixtureEvent)audit.frameEvents.push(e.data.fixtureEvent)});
for(const type of ['mousedown','mouseup','click','dblclick','beforeinput','input','change','focusout'])
 document.addEventListener(type,e=>audit.events.push({type,detail:e.detail||0,trusted:e.isTrusted,target:e.target.id}));
document.querySelector('#double').ondblclick=()=>audit.doubleCount++;
document.querySelector('#moving').onclick=e=>e.target.style.marginLeft='300px';
new MutationObserver(records=>audit.mutations.push(...records.map(r=>({type:r.type,attribute:r.attributeName,added:[...r.addedNodes].map(n=>n.nodeName)}))))
 .observe(document.documentElement,{childList:true,subtree:true,attributes:true});
audit.baseline=Object.getOwnPropertyNames(window);
</script>`;
const child = name => `<!doctype html><style>button{width:100px;height:30px}</style><button id="child">${name}</button><script>window.events=[];for(const type of ['mousedown','mouseup','click','dblclick'])document.querySelector('button').addEventListener(type,e=>{const event={name:'${name}',type,trusted:e.isTrusted,detail:e.detail};events.push(event);parent.postMessage({fixtureEvent:event},'*')});</script>`;
const serve = handler => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, () => resolve(s)); });
const cross = await serve((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(child("Cross target")); });
const site = await serve((req, res) => {
  if(editorMode && req.url.startsWith('/editors/')) {
    const requested=decodeURIComponent(req.url.split('?')[0].slice('/editors/'.length)) || 'index.html';
    const file=path.resolve(editorDist,requested);
    if(!file.startsWith(editorDist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.ttf':'font/ttf'})[path.extname(file)]||'application/octet-stream');
    res.end(fs.readFileSync(file));return;
  }
  res.setHeader('Content-Type','text/html');res.end(req.url==='/child'?child('Same target'):fixture(cross.address().port));
});
const url = `http://127.0.0.1:${site.address().port}/`;
const children = [];

// This launcher deliberately passes neither --headless nor --no-sandbox.
// All child environment values are selected explicitly; no account credentials
// or runner tokens are inherited by Chrome or the tested CLI/native host.
async function startChrome(profile, env, args) {
  const port = 9471;
  const log = fs.openSync(path.join(outDir, 'chrome.log'), 'a');
  const proc = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', ...args, 'about:blank'], { env, stdio: ['ignore', log, log] });
  children.push(proc);
  const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), { timeout: 30000, label: 'headed Chrome' });
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 30000);
    pending.set(id, reply => { clearTimeout(timer); reply.error ? reject(Error(`${method}: ${reply.error.message}`)) : resolve(reply.result); });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { proc, send, listeners, version: version.Browser, async close() { await send('Browser.close').catch(() => {}); ws.close(); proc.kill('SIGTERM'); } };
}

async function runMode(mode) {
  const testHome = path.join(work, mode, 'home');
  const profile = path.join(work, mode, 'profile');
  const sockets = path.join(work, mode, 'sockets');
  for (const dir of [testHome, profile, sockets]) fs.mkdirSync(dir, { recursive: true });
  const env = {
    PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY || '',
    LANG: 'en_US.UTF-8', HOME: testHome, TMPDIR: process.env.RUNNER_TEMP,
    CHROME_USE_RELAY_DIR: path.join(testHome, 'relay'), AGENT_BROWSER_SOCKET_DIR: sockets,
    AGENT_BROWSER_EXECUTABLE_PATH: chrome, AGENT_BROWSER_NO_UPDATE_CHECK: '1',
    CHROME_USE_NO_UPDATE_CHECK: '1', AGENT_BROWSER_NO_AUTO_OPEN: '1',
    AGENT_BROWSER_NO_AUTO_RECONNECT: '1', NO_COLOR: '1',
  };
  const session = `stealth-${mode}`;
  let browser, worker, A;
  const cli = async args => {
    const command = ['--session', session, '--json', ...(mode === 'launch' ? ['--launch',...(editorMode?['--profile',profile]:[])] : []), ...args];
    let result;
    try { result = await execute(bin, command, { env, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }); }
    catch (error) { result = error; }
    const lines = String(result.stdout || '').trim().split('\n');
    let parsed;
    for (const line of lines.reverse()) { try { parsed = JSON.parse(line); break; } catch {} }
    if (!parsed) throw Error(`CLI gave no JSON: ${command.join(' ')}: ${result.stderr || result.stdout || result.message}`);
    return parsed;
  };
  const ok = async args => { const response = await cli(args); assert.equal(response.success, true, JSON.stringify(response)); return response.data; };
  const evaluate = async expression => {
    const data = await ok(['eval', expression]);
    return data && Object.hasOwn(data, 'result') ? data.result : data;
  };
  try {
    if (mode === 'relay') {
      const wrapper = path.join(work, mode, 'host.sh');
      const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(env).map(([k,v]) => `${k}=${quote(v)}`).join(' ')} ${quote(bin)} __nm-host "$@"\n`, { mode: 0o700 });
      fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
      fs.writeFileSync(path.join(profile, 'NativeMessagingHosts', 'com.agent_browser.connect.json'), JSON.stringify({ name: 'com.agent_browser.connect', description: 'isolated stealth acceptance', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extId}/`] }));
      browser = await startChrome(profile, env, [`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`]);
      A = api(browser); worker = await A.worker();
      evidence.workerTarget = worker.target;
      // The first run observed an announced worker with no chrome binding.
      // Wait for observed API readiness without attributing its cause.
      await waitFor(() => A.evaluate(worker.sid, `typeof chrome !== 'undefined' && !!chrome.storage?.local && chrome.runtime?.id === '${extId}'`), { timeout: 20000, label: 'extension worker API bindings' });
      await A.evaluate(worker.sid, "chrome.storage.local.set({ab_stealth:true,ab_cursor:true})");
      await waitFor(() => fs.existsSync(path.join(env.CHROME_USE_RELAY_DIR, 'relay-cdp-url')), { timeout: 30000, label: 'extension relay' });
      evidence.modes.push({ mode, chrome: browser.version, stealth: await A.evaluate(worker.sid, "chrome.storage.local.get(['ab_stealth','ab_cursor'])") });
      await A.evaluate(worker.sid,`(() => {
        const original=chrome.debugger.sendCommand.bind(chrome.debugger);globalThis.stealthCaptureTrace=[];
        chrome.debugger.sendCommand=async (...args)=>{
          if(args[1]!=='Page.captureScreenshot')return original(...args);
          const record={target:args[0],params:args[2],started:Date.now()};stealthCaptureTrace.push(record);
          try{const result=await original(...args);record.finished=Date.now();record.bytes=result.data?.length;return result;}
          catch(error){record.error=error.message;throw error;}
        };return true;
      })()`);
    }
    if(editorMode) {
      await checkEditors({mode,profile,url,ok,cli,evaluate,check,browser,A,worker,evidence,save});
      return;
    }
    await ok(['open', url]);
    await waitFor(async () => (await evaluate('document.readyState')) === 'complete', { timeout: 30000, label: 'fixture ready' });
    evidence.modes.push({ mode, selfCheck: await cli(['stealth', 'status']) });
    await check(`${mode}: trusted double-click and model effect`, async () => {
      await evaluate('audit.events=[];audit.doubleCount=0');
      const result = await ok(['dblclick', '#double']);
      assert.equal(result.verified, true);
      const observed = await evaluate('({events:audit.events.filter(e=>e.target==="double"),count:audit.doubleCount})');
      assert.equal(observed.count, 1);
      assert.deepEqual(observed.events.map(e=>[e.type,e.detail,e.trusted]), [
        ['mousedown',1,true],['mouseup',1,true],['click',1,true],['mousedown',2,true],['mouseup',2,true],['click',2,true],['dblclick',2,true],
      ]);
      return observed;
    });
    await check(`${mode}: covered target refuses without input`, async () => {
      await evaluate('audit.events=[];document.querySelector("#cover").style.display="block"');
      const result = await cli(['dblclick', '#double']);
      await evaluate('document.querySelector("#cover").style.display="none"');
      assert.equal(result.success, false);
      assert.equal(await evaluate('audit.events.filter(e=>e.target==="double").length'), 0);
      return result;
    });
    await check(`${mode}: moving target stops the second click`, async () => {
      await evaluate('audit.events=[]');
      const result = await cli(['dblclick', '#moving']);
      assert.equal(result.success, false);
      assert.equal(await evaluate('audit.events.filter(e=>e.target==="moving"&&e.type==="click").length'), 1);
      return result;
    });
    await check(`${mode}: contenteditable keeps focus and native events`, async () => {
      await evaluate('audit.events=[]');
      const response = await ok(['fill', '#editor', 'verified text']);
      const observed = await evaluate('({text:document.querySelector("#editor").textContent,focus:document.activeElement.id,events:audit.events.filter(e=>e.target==="editor")})');
      assert.equal(observed.text, 'verified text'); assert.equal(observed.focus, 'editor');
      assert.ok(observed.events.some(e=>e.type==='input'&&e.trusted));
      assert.ok(!observed.events.some(e=>!e.trusted||e.type==='change'||e.type==='focusout'));
      return { response, observed };
    });
    await check(`${mode}: screenshot frame geometry, scale, scroll and DOM mutations`, async () => {
      const results = [];
      for (const [scale, scroll, frameScale] of [[1,0,1],[1,70,1],[2,70,1],[2,70,0.75]]) {
        await ok(['set','viewport','1000','700',String(scale)]);
        await evaluate(`document.querySelector('#cross').style.transformOrigin='top left';document.querySelector('#cross').style.transform='scale(${frameScale})';scrollTo(0,${scroll})`);
        for (const [label, args] of [['viewport',[]],['full',['--full']],['selector',['--selector','#double']],['clip',['--clip','10,10,500,300']]]) {
          const expected = await evaluate(`(() => {
            const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
            const local = rect(document.querySelector('#same').contentDocument.querySelector('button'));
            return {scrollX,scrollY,viewportWidth:visualViewport.width,viewportHeight:visualViewport.height,
              contentWidth:document.documentElement.scrollWidth,contentHeight:document.documentElement.scrollHeight,
              target:rect(document.querySelector('#double')),
              children:['same','cross'].map(id=>{const f=document.getElementById(id),r=rect(f),scale=r.width/f.offsetWidth;return {x:r.x+(f.clientLeft+local.x)*scale,y:r.y+(f.clientTop+local.y)*scale,width:local.width*scale,height:local.height*scale}})};
          })()`);
          await evaluate('audit.mutations=[]');
          const file = path.join(outDir, `${mode}-${label}-${scale}-${scroll}-${frameScale}.png`);
          let shot;
          try { shot = await ok(['screenshot', file, '--annotate', ...args]); }
          catch(error) {
            const failure={mode,label,scale,scroll,frameScale,expected,error:error.message};
            if(mode==='relay') {
              failure.trace=await A.evaluate(worker.sid,'stealthCaptureTrace');
              const target=failure.trace.at(-1)?.target;
              if(target) {
                const metrics=await A.evaluate(worker.sid,`chrome.debugger.sendCommand(${JSON.stringify(target)},'Page.getLayoutMetrics',{})`);
                failure.metrics=metrics;
                const size=metrics.cssContentSize;
                const attempts=[['full-control',{x:0,y:0,width:size.width,height:size.height,scale:1}],['top-region',{x:0,y:0,width:metrics.cssLayoutViewport.clientWidth,height:metrics.cssLayoutViewport.clientHeight,scale:1}]];
                failure.rawControls=[];
                for(const [name,clip] of attempts) {
                  const control=await A.evaluate(worker.sid,`Promise.race([chrome.debugger.sendCommand(${JSON.stringify(target)},'Page.captureScreenshot',${JSON.stringify({format:'png',fromSurface:true,captureBeyondViewport:true,clip})}).then(r=>({data:r.data})).catch(e=>({error:e.message})),new Promise(r=>setTimeout(()=>r({error:'probe timeout after 5 seconds'}),5000))])`);
                  if(control.data){fs.writeFileSync(path.join(outDir,`${mode}-${name}.png`),Buffer.from(control.data,'base64'));failure.rawControls.push({name,ok:true,clip});}
                  else failure.rawControls.push({name,ok:false,clip,error:control.error});
                }
              }
            }
            (evidence.captureFailures??=[]).push(failure);save();throw error;
          }
          const bytes = fs.readFileSync(file);
          assert.ok(bytes.length > 100);
          assert.ok(Array.isArray(shot.annotations) && shot.annotations.length > 0, JSON.stringify(shot));
          assert.deepEqual(await evaluate('audit.mutations'), []);
          const region = label==='viewport' ? {x:0,y:0,width:expected.viewportWidth,height:expected.viewportHeight}
            : label==='full' ? {x:-expected.scrollX,y:-expected.scrollY,width:expected.contentWidth,height:expected.contentHeight}
            : label==='selector' ? expected.target
            : {x:10-expected.scrollX,y:10-expected.scrollY,width:500,height:300};
          const overlaps = r => r.x<region.x+region.width && r.x+r.width>region.x && r.y<region.y+region.height && r.y+r.height>region.y;
          const wanted = expected.children.filter(overlaps).map(r=>({x:Math.round(r.x-region.x),y:Math.round(r.y-region.y),width:Math.round(r.width),height:Math.round(r.height)})).sort((a,b)=>a.x-b.x);
          const actual = shot.annotations.filter(a=>['Same target','Cross target'].includes(a.name)).map(a=>a.box).sort((a,b)=>a.x-b.x);
          assert.deepEqual(actual,wanted,JSON.stringify({mode,label,scale,scroll,frameScale,shot}));
          assert.ok(Math.abs(bytes.readUInt32BE(16)-region.width*scale)<=1,JSON.stringify({label,scale,scroll,frameScale,expectedWidth:region.width*scale,actualWidth:bytes.readUInt32BE(16)}));
          assert.ok(Math.abs(bytes.readUInt32BE(20)-region.height*scale)<=1,JSON.stringify({label,scale,scroll,frameScale,expectedHeight:region.height*scale,actualHeight:bytes.readUInt32BE(20)}));
          const observation = {mode,label,scale,scroll,frameScale,expected,region,raster:{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)},annotations:shot.annotations};
          results.push(observation);
          (evidence.captureObservations ??= []).push(observation); save();
        }
      }
      await evaluate("document.querySelector('#cross').style.transform='none';scrollTo(0,0)");
      return results;
    });
    await check(`${mode}: iframe double-click verifies delivery or refuses before input`, async () => {
      const observations = [];
      for (const name of ['Same target','Cross target']) {
        await evaluate('audit.frameEvents=[];audit.events=[]');
        const snapshot = await ok(['snapshot','-i']);
        const line = snapshot.snapshot.split('\n').find(line=>line.includes(name)&&line.includes('button'));
        assert.ok(line, `missing ${name} in snapshot`);
        const ref = line.match(/\[ref=(e\d+)\]/)?.[1];
        assert.ok(ref, `missing ref in ${line}`);
        const result = await cli(['dblclick',`@${ref}`]);
        const events = await evaluate('audit.frameEvents');
        if (result.success) {
          assert.equal(result.data.verified,true);
          assert.equal(events.length,7);
          assert.ok(events.every(e=>e.name===name&&e.trusted));
          assert.deepEqual(events.map(e=>[e.type,e.detail]),[['mousedown',1],['mouseup',1],['click',1],['mousedown',2],['mouseup',2],['click',2],['dblclick',2]]);
        } else {
          assert.match(result.error,/isolat|frame|cross.origin|cannot safely target/i);
          assert.deepEqual(events,[],'refusal must precede frame input');
        }
        assert.equal(await evaluate('audit.events.filter(e=>["click","dblclick"].includes(e.type)).length'),0,'frame command must not click the top document');
        observations.push({name,result,events});
      }
      return observations;
    });
    await check(`${mode}: coordinate hover adds no page globals or persistent overlay`, async () => {
      const before = await evaluate('Object.getOwnPropertyNames(window).sort()');
      const response = await ok(['hover', '80', '40']);
      const after = await evaluate('Object.getOwnPropertyNames(window).sort()');
      assert.deepEqual(after, before);
      assert.equal(await evaluate('!!document.querySelector("#__agent_browser_annotations__,#__agent_browser_cursor__,#chrome-use-cursor")'), false);
      return response;
    });
    if (mode === 'relay') {
      await check('relay: hover input rejection removes observed isolated listeners', async () => {
        const tabs = await A.evaluate(worker.sid, 'chrome.tabs.query({})');
        const tab = tabs.find(t=>t.url===url); assert.ok(tab);
        const debug = (method, params={}) => A.evaluate(worker.sid, `chrome.debugger.sendCommand({tabId:${tab.id}},${JSON.stringify(method)},${JSON.stringify(params)})`);
        let windowObject;
        const listeners = async () => (await debug('DOMDebugger.getEventListeners',{objectId:windowObject})).listeners.filter(l=>['pointermove','mousemove'].includes(l.type)).map(l=>({type:l.type,useCapture:l.useCapture,scriptId:l.scriptId}));
        await A.evaluate(worker.sid, `(() => {
          const original=chrome.debugger.sendCommand.bind(chrome.debugger);
          globalThis.stealthFixtureFault={original,triggered:false,release:null};
          chrome.debugger.sendCommand=async (...args)=>{
            const f=globalThis.stealthFixtureFault;
            if(args[0]?.tabId===${tab.id} && args[1]==='Runtime.evaluate' && args[2]?.expression?.includes('const seen = { hit: null }')) {
              const object=await original(args[0],'Runtime.evaluate',{expression:'window',contextId:args[2].contextId,returnByValue:false});
              f.windowObject=object.result.objectId;
              f.before=(await original(args[0],'DOMDebugger.getEventListeners',{objectId:f.windowObject})).listeners.filter(l=>['pointermove','mousemove'].includes(l.type)).map(l=>({type:l.type,useCapture:l.useCapture,scriptId:l.scriptId}));
            }
            if(args[0]?.tabId===${tab.id} && args[1]==='Input.dispatchMouseEvent' && !f.triggered){
              f.triggered=true;await new Promise(resolve=>f.release=resolve);throw Error('fixture injected hover input rejection');
            }
            return original(...args);
          };return true;
        })()`);
        let operation;
        try {
          operation = cli(['hover','90','40']);
          await waitFor(()=>A.evaluate(worker.sid,'stealthFixtureFault.triggered'),{timeout:5000,label:'hover fault interception'});
          windowObject = await A.evaluate(worker.sid,'stealthFixtureFault.windowObject');
          assert.ok(windowObject,'captured the recorder isolated-world window');
          const before = await A.evaluate(worker.sid,'stealthFixtureFault.before');
          const during = await listeners();
          assert.equal(during.length,before.length+2,'positive control: inspector must observe both live recorder listeners');
          const released = Date.now();
          await A.evaluate(worker.sid,'stealthFixtureFault.release();true');
          const result = await operation;
          assert.equal(result.success,false);
          assert.match(result.error,/fixture injected hover input rejection/);
          await waitFor(async ()=>(await listeners()).length===before.length,{timeout:2500,label:'guard removes listeners before expiry'});
          const after = await listeners();
          assert.deepEqual(after,before);
          return {before,during,after,cleanupMs:Date.now()-released,result};
        } finally {
          await A.evaluate(worker.sid,'stealthFixtureFault.release?.();chrome.debugger.sendCommand=stealthFixtureFault.original;delete globalThis.stealthFixtureFault;true');
          if(operation) await operation.catch(()=>{});
          if(windowObject) await debug('Runtime.releaseObject',{objectId:windowObject}).catch(()=>{});
        }
      });
      await check('relay: background tab keeps the other tab active', async () => {
        const tabs = await A.evaluate(worker.sid, 'chrome.tabs.query({})');
        const agent = tabs.find(t=>t.url===url), other = tabs.find(t=>t.id!==agent?.id && t.windowId===agent.windowId);
        assert.ok(agent && other, 'need two tabs in the same fixture window');
        await A.evaluate(worker.sid, `chrome.tabs.update(${other.id},{active:true})`);
        await ok(['dblclick', '#double']);
        const active = await A.evaluate(worker.sid, `chrome.tabs.query({windowId:${agent.windowId},active:true})`);
        assert.equal(active[0].id, other.id);
        return { agent: agent.id, active: other.id };
      });
      await check('relay: isolation loss refuses internal read and preserves explicit eval', async () => {
        const tabs = await A.evaluate(worker.sid,'chrome.tabs.query({})');
        const tab = tabs.find(t=>t.url===url); assert.ok(tab);
        await A.evaluate(worker.sid,`(() => {
          const original=chrome.debugger.sendCommand.bind(chrome.debugger);
          globalThis.stealthIsolationFault={original,failedExpression:null,phase:'internal',evaluations:[],creations:0};
          chrome.debugger.sendCommand=async (...args)=>{
            const f=globalThis.stealthIsolationFault;
            if(args[0]?.tabId===${tab.id}){
              if(args[1]==='Runtime.evaluate'){
                f.evaluations.push({phase:f.phase,contextId:args[2]?.contextId,expression:args[2]?.expression});
                if(!f.failedExpression && args[2]?.contextId && args[2]?.expression?.includes('#double')){
                  f.failedExpression=args[2].expression;throw Error('Cannot find context with specified id');
                }
              }
              if(args[1]==='Page.createIsolatedWorld' && f.failedExpression){f.creations++;throw Error('fixture denied isolated world recreation');}
            }
            return original(...args);
          };return true;
        })()`);
        try {
          const result = await cli(['get','text','#double']);
          assert.equal(result.success,false);
          assert.match(result.error,/isolation_unavailable|isolated world|isolation unavailable/i);
          const internal = await A.evaluate(worker.sid,'({failedExpression:stealthIsolationFault.failedExpression,creations:stealthIsolationFault.creations,evaluations:stealthIsolationFault.evaluations})');
          assert.ok(internal.failedExpression && internal.creations>0,'positive control: internal context failed and recreation was attempted');
          assert.ok(!internal.evaluations.some(e=>e.expression===internal.failedExpression&&!e.contextId),'no unscoped retry of refused internal evaluation');
          await A.evaluate(worker.sid,"stealthIsolationFault.phase='explicit';true");
          assert.equal(await evaluate('document.title'),'Stealth fixture');
          const explicit = await A.evaluate(worker.sid,"stealthIsolationFault.evaluations.filter(e=>e.phase==='explicit'&&e.expression==='document.title')");
          assert.ok(explicit.some(e=>!e.contextId),'deliberate user eval remains in main world');
          return {result,internal,explicit};
        } finally {
          await A.evaluate(worker.sid,'chrome.debugger.sendCommand=stealthIsolationFault.original;delete globalThis.stealthIsolationFault;true');
        }
      });
    }
  } finally {
    await cli(['close']).catch(() => {});
    if (browser) await browser.close();
  }
}
// Protocol geometry observations run in a separate fixture tab after CLI tests.
// No extension debugger owns this tab. Compare the renderer's frame-local DOM
// rect with protocol quads before choosing a screenshot projection strategy.
async function probeGeometry() {
  const profile = path.join(work, 'geometry-profile');
  fs.mkdirSync(profile, { recursive: true });
  const browser = await startChrome(profile, {
    PATH: process.env.PATH, DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY || '', HOME: profile, LANG: 'en_US.UTF-8',
  }, []);
  try {
    const { targetId } = await browser.send('Target.createTarget', { url });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}, sid = sessionId) => browser.send(method, params, sid);
    await send('Page.enable');
    await waitFor(async () => (await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).result.value === 'complete', { label: 'geometry fixture' });
    const stages = [];
    for (const scrollY of [0, 70]) {
      await send('Runtime.evaluate', { expression: `scrollTo(0,${scrollY})` });
      await send('Runtime.evaluate', { expression: 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))', awaitPromise: true });
      const tree = (await send('Page.getFrameTree')).frameTree;
      const contexts = [{ frame: tree.frame, sid: sessionId }];
      for (const child of tree.childFrames || []) contexts.push({ frame: child.frame, sid: sessionId });
      const targets = (await browser.send('Target.getTargets')).targetInfos.filter(t=>t.type==='iframe');
      for (const t of targets) {
        const { sessionId: sid } = await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const frame = (await send('Page.getFrameTree', {}, sid)).frameTree.frame;
        const previous = contexts.findIndex(c=>c.frame.id===frame.id);
        if (previous>=0) contexts.splice(previous,1);
        contexts.push({ frame, sid });
      }
      const measurements = [];
      for (const { frame, sid } of contexts) {
        const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'geometry-probe' }, sid);
        const object = (await send('Runtime.evaluate', { expression: 'document.querySelector("button")', contextId: executionContextId }, sid)).result;
        if (!object.objectId) continue;
        const { node } = await send('DOM.describeNode', { objectId: object.objectId }, sid);
        const model = await send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }, sid);
        const rect = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){return this.getBoundingClientRect().toJSON()}', returnByValue: true }, sid);
        let owner;
        if (frame.id !== tree.frame.id) {
          try {
            const id = await send('DOM.getFrameOwner', { frameId: frame.id });
            owner = await send('DOM.getBoxModel', { backendNodeId: id.backendNodeId });
          } catch (error) { owner = { error: error.message }; }
        }
        measurements.push({ frame, oop: sid!==sessionId, backendNodeId: node.backendNodeId, model, rect: rect.result.value, owner });
      }
      stages.push({ scrollY, measurements });
    }
    fs.writeFileSync(path.join(outDir, 'geometry-probe.json'), JSON.stringify(stages,null,2));
    return stages;
  } finally { await browser.close(); }
}
try {
  evidence.version = (await execute(bin, ['--version'])).stdout.trim();
  for (const mode of ['launch', 'relay']) {
    try { await runMode(mode); }
    catch (error) { evidence.checks.push({ name: `${mode}: setup/teardown`, ok: false, error: error.stack }); console.log(`FAIL ${mode} setup: ${error.message}`); save(); }
  }
  if(!editorMode) await check('frame protocol geometry observations', probeGeometry);
} finally {
  site.close(); cross.close();
  for (const child of children) child.kill('SIGTERM');
  evidence.ok = evidence.checks.length > 0 && evidence.checks.every(c=>c.ok);
  save();
}
process.exitCode = evidence.ok ? 0 : 1;

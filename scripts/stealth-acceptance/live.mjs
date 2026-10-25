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

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'this rig is CI-only');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'use a disposable GitHub runner');
assert.ok(process.env.DISPLAY, 'headed acceptance requires a virtual display');
assert.notEqual(process.getuid(), 0, 'Chrome must run as a non-root user');
const execute = promisify(execFile);
const bin = path.resolve(process.env.HOST_BIN);
const chrome = path.resolve(process.env.CHROME);
const extDir = path.resolve('extensions/ab-connect');
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
window.audit={events:[],mutations:[],doubleCount:0};
for(const type of ['mousedown','mouseup','click','dblclick','beforeinput','input','change','focusout'])
 document.addEventListener(type,e=>audit.events.push({type,detail:e.detail||0,trusted:e.isTrusted,target:e.target.id}));
document.querySelector('#double').ondblclick=()=>audit.doubleCount++;
document.querySelector('#moving').onclick=e=>e.target.style.marginLeft='300px';
new MutationObserver(records=>audit.mutations.push(...records.map(r=>({type:r.type,attribute:r.attributeName,added:[...r.addedNodes].map(n=>n.nodeName)}))))
 .observe(document.documentElement,{childList:true,subtree:true,attributes:true});
audit.baseline=Object.getOwnPropertyNames(window);
</script>`;
const child = '<!doctype html><button id="child">Child target</button><script>window.events=[];document.querySelector("button").addEventListener("dblclick",e=>events.push({trusted:e.isTrusted,detail:e.detail}));</script>';
const serve = handler => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, () => resolve(s)); });
const cross = await serve((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(child); });
const site = await serve((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/child' ? child : fixture(cross.address().port)); });
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
    const command = ['--session', session, '--json', ...(mode === 'launch' ? ['--launch'] : []), ...args];
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
    await check(`${mode}: screenshot annotations leave no DOM mutations`, async () => {
      const results = [];
      for (const [label, args] of [['viewport',[]],['full',['--full']],['selector',['--selector','#double']],['clip',['--clip','10,10,500,300']]]) {
        await evaluate('audit.mutations=[]');
        const file = path.join(outDir, `${mode}-${label}.png`);
        const shot = await ok(['screenshot', file, '--annotate', ...args]);
        assert.ok(fs.statSync(file).size > 100);
        assert.ok(Array.isArray(shot.annotations) && shot.annotations.length > 0, JSON.stringify(shot));
        assert.deepEqual(await evaluate('audit.mutations'), []);
        results.push({ label, annotations: shot.annotations });
      }
      return results;
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
  await check('frame protocol geometry observations', probeGeometry);
} finally {
  site.close(); cross.close();
  for (const child of children) child.kill('SIGTERM');
  evidence.ok = evidence.checks.length > 0 && evidence.checks.every(c=>c.ok);
  save();
}
process.exitCode = evidence.ok ? 0 : 1;

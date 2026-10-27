import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {waitFor} from '../inspect-acceptance/lib.mjs';
const chrome=process.env.CHROME,outDir='stealth-evidence',children=[];
export async function startChrome(profile, env, args) {
  const port = 9471;
  const occupied=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)}).then(()=>true,()=>false);
  assert.equal(occupied,false,'test debugging port must not belong to a previous browser');
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
    // The protocol experiment observes whether a native capture eventually
    // finishes after the relay deadline; it does not alter production budgets.
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, process.env.CAPTURE_PROTOCOL_ONLY==='1'?90000:30000);
    pending.set(id, reply => { clearTimeout(timer); reply.error ? reject(Error(`${method}: ${reply.error.message}`)) : resolve(reply.result); });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { proc, send, listeners, version: version.Browser, async close() { await send('Browser.close').catch(() => {}); ws.close(); proc.kill('SIGTERM'); await waitFor(()=>proc.exitCode!==null||proc.signalCode!==null,{timeout:10000,label:'owned Chrome exited'}); } };
}

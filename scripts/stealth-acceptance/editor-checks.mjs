import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from '../inspect-acceptance/lib.mjs';

async function grantOnLaunchedBrowser(profile, origin) {
  const [port, endpoint] = fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split('\n');
  assert.match(port,/^\d+$/); assert.ok(endpoint.startsWith('/devtools/browser/'));
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  try {
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('clipboard permission grant timed out')),10000);
      socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);message.error?reject(Error(message.error.message)):resolve(message.result);};
      socket.send(JSON.stringify({id:1,method:'Browser.grantPermissions',params:{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']}}));
    });
  } finally { socket.close(); }
}

export async function checkEditors({mode,profile,url,ok,cli,evaluate,check,browser,A,worker,evidence,save}) {
  const editorUrl = `${url}editors/`;
  await ok(['open',editorUrl]);
  await waitFor(()=>evaluate('!!window.fixture?.ready'),{timeout:30000,label:'actual editor packages ready'});
  for(const [name,selector] of [['lexical','#lexical'],['prosemirror','#prosemirror .ProseMirror']]) {
    await check(`${mode}: real ${name} fill updates its model with native events`, async()=>{
      const observations=[];
      for(const value of ['verified editor text','line one\nline two','']) {
        await evaluate('fixture.events.length=0');
        const response=await cli(['fill',selector,value]);
        const observed=await evaluate(`({model:fixture.read('${name}'),focus:document.querySelector(${JSON.stringify(selector)}).contains(document.activeElement),events:fixture.events.filter(e=>e.editor==='${name}'),errors:fixture.errors})`);
        const record={name,value,response,observed};(evidence.editorObservations??=[]).push(record);save();
        assert.equal(response.success,true,JSON.stringify(record));
        assert.equal(observed.model,value,JSON.stringify(record));
        assert.equal(observed.focus,true);
        assert.ok(observed.events.some(e=>['beforeinput','input'].includes(e.type)&&e.trusted),JSON.stringify(record));
        assert.ok(observed.events.every(e=>e.trusted&&!['change','focusout'].includes(e.type)),JSON.stringify(record));
        assert.deepEqual(observed.errors,[]);
        observations.push(record);
      }
      return observations;
    });
  }
  await check(`${mode}: real Monaco hidden-API clipboard fill and MIME restoration`,async()=>{
    if(mode==='relay') {
      await browser.send('Browser.grantPermissions',{origin:new URL(url).origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
      const tab=(await A.evaluate(worker.sid,'chrome.tabs.query({})')).find(t=>t.url===editorUrl);assert.ok(tab);
      await A.evaluate(worker.sid,`chrome.tabs.update(${tab.id},{active:true}).then(()=>chrome.windows.update(${tab.windowId},{focused:true}))`);
    } else await grantOnLaunchedBrowser(profile,new URL(url).origin);
    assert.equal(await evaluate("typeof window.monaco === 'undefined' && typeof window.require === 'undefined'"),true,'exercise hidden API fallback');
    assert.equal(await evaluate("!!document.querySelector('#monaco textarea.inputarea')"),true,'textarea input mode');
    await evaluate(`navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['fixture clipboard sentinel'],{type:'text/plain'}),'text/html':new Blob(['<b>fixture clipboard sentinel</b>'],{type:'text/html'})})])`);
    const before=await evaluate('fixture.clipboard()');
    await evaluate('fixture.events.length=0');
    const value='first line\n  second line\nthird line';
    const response=await cli(['fill','#monaco',value]);
    const observed=await evaluate("({model:fixture.read('monaco'),events:fixture.events.filter(e=>e.editor==='monaco'),errors:fixture.errors})");
    const after=await evaluate('fixture.clipboard()');
    const record={value,response,observed,before,after};(evidence.editorObservations??=[]).push(record);save();
    assert.equal(response.success,true,JSON.stringify(record));
    assert.equal(response.data.engine,'monaco-clipboard');
    assert.equal(observed.model,value);
    assert.ok(observed.events.some(e=>e.type==='paste'&&e.trusted));
    assert.ok(observed.events.some(e=>e.type==='copy'&&e.trusted));
    assert.ok(observed.events.every(e=>!e.exposedState?.length),'no named transaction state during native clipboard events');
    assert.deepEqual(after,before,'restore every MIME type exposed by Clipboard.read');
    assert.deepEqual(observed.errors,[]);
    return record;
  });
}

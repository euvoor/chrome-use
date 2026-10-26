import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from '../inspect-acceptance/lib.mjs';
import { checkModelReads } from './model-read-checks.mjs';
import { checkModelProduction } from './model-production-checks.mjs';

async function grantOnLaunchedBrowser(profile, origin) {
  const [port, endpoint] = fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split('\n');
  assert.match(port,/^\d+$/); assert.ok(endpoint.startsWith('/devtools/browser/'));
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  try {
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let next=0;
    const send=(method,params)=>new Promise((resolve,reject)=>{
      const id=++next;
      const timer=setTimeout(()=>reject(Error(method+' timed out')),10000);
      socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id!==id)return;clearTimeout(timer);message.error?reject(Error(message.error.message)):resolve(message.result);};
      socket.send(JSON.stringify({id,method,params}));
    });
    const {targetInfos}=await send('Target.getTargets',{});
    const tab=targetInfos.find(t=>t.type==='page'&&t.url.startsWith(origin+'/editors/'));
    assert.ok(tab,'owned launched fixture target exists');
    await send('Browser.grantPermissions',{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite'],...(tab.browserContextId?{browserContextId:tab.browserContextId}:{})});
    await send('Target.activateTarget',{targetId:tab.targetId});
    // BrowserHandler::Disable resets this connection's permission overrides.
    // Keep the browser CDP connection alive until clipboard acceptance ends.
    return {target:tab,close:()=>socket.close()};
  } catch(error) {socket.close();throw error;}
}

export async function checkEditors({mode,profile,url,ok,cli,evaluate,check,browser,A,worker,evidence,save}) {
  const production=process.env.STEALTH_MODEL_PRODUCTION==='1';
  const editorUrl = `${url}editors/${production?'?wrapped=1':''}`;
  let launchPermissions;
  try {
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
    } else launchPermissions=await grantOnLaunchedBrowser(profile,new URL(url).origin);
    const permission=await evaluate("navigator.permissions.query({name:'clipboard-read'}).then(p=>p.state)");
    (evidence.clipboardPermissions??=[]).push({mode,state:permission,target:launchPermissions?.target});save();
    assert.equal(permission,'granted','owned fixture has a live clipboard permission override');
    const apiVisibility=await evaluate("({monacoTag:window.monaco?.tagName,hasEditorAPI:!!window.monaco?.editor,requireType:typeof window.require})");
    // A div with id=monaco can create a named window property without exposing
    // any editor API. Check the mechanism the production resolver uses.
    assert.equal(apiVisibility.hasEditorAPI,false,JSON.stringify(apiVisibility));
    assert.notEqual(apiVisibility.requireType,'function','exercise hidden module API fallback');
    await waitFor(()=>evaluate('document.hasFocus()'),{timeout:5000,label:'disposable editor page has clipboard focus'});
    assert.equal(await evaluate("!!document.querySelector('#monaco textarea.inputarea')"),true,'textarea input mode');
    await evaluate(`navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['fixture clipboard sentinel'],{type:'text/plain'}),'text/html':new Blob(['<b>fixture clipboard sentinel</b>'],{type:'text/html'})})])`);
    const control=await evaluate('fixture.clipboardControl().catch(error=>({error:String(error)}))');
    (evidence.clipboardControls??=[]).push({mode,control});save();
    // Reset the sentinel after the independent ClipboardItem control.
    await evaluate(`navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['fixture clipboard sentinel'],{type:'text/plain'}),'text/html':new Blob(['<b>fixture clipboard sentinel</b>'],{type:'text/html'})})])`);
    const before=await evaluate('fixture.clipboard().catch(error=>({error:String(error)}))');
    await evaluate('fixture.events.length=0');
    const value='first line\n  second line\nthird line';
    const response=await cli(['fill','#monaco',value]);
    const observed=await evaluate("({model:fixture.read('monaco'),events:fixture.events.filter(e=>e.editor==='monaco'),errors:fixture.errors})");
    const after=await evaluate('fixture.clipboard().catch(error=>({error:String(error)}))');
    const clipboardCalls=await evaluate('fixture.clipboardCalls');
    const record={value,apiVisibility,response,observed,before,after,clipboardCalls};(evidence.editorObservations??=[]).push(record);save();
    assert.equal(response.success,true,JSON.stringify(record));
    assert.equal(response.data.engine,'monaco-clipboard');
    assert.equal(observed.model,value);
    assert.ok(observed.events.some(e=>e.type==='paste'&&e.trusted));
    assert.ok(observed.events.some(e=>e.type==='copy'&&e.trusted));
    assert.ok(observed.events.every(e=>!e.exposedState?.length),'no named transaction state during native clipboard events');
    assert.ok(Array.isArray(before)&&Array.isArray(after),'both clipboard reads completed');
    assert.deepEqual(after,before,'restore every MIME type exposed by Clipboard.read');
    assert.deepEqual(observed.errors,[]);
    return record;
  });
  await check(`${mode}: real Monaco highlighted code preserves clipboard HTML`,async()=>{
    await evaluate("fixture.language('javascript');fixture.events.length=0");
    await evaluate(`navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['highlight backup'],{type:'text/plain'}),'text/html':new Blob(['<b>highlight backup</b>'],{type:'text/html'})})])`);
    const before=await evaluate('fixture.clipboard()');
    const value='const greeting = "你好";\nconsole.log(greeting);';
    const response=await cli(['fill','#monaco',value]);
    const observed=await evaluate("({model:fixture.read('monaco'),events:fixture.events.filter(e=>e.editor==='monaco')})");
    const after=await evaluate('fixture.clipboard()');
    const rawAfter=await evaluate("(async()=>Promise.all((await navigator.clipboard.read({unsanitized:['text/html']})).map(async item=>Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await(await item.getType(type)).text()]))))))()");
    const record={mode,language:'javascript',value,response,observed,before,after,rawAfter};
    (evidence.editorObservations??=[]).push(record);save();
    await evaluate("fixture.language('plaintext')");
    assert.equal(response.success,true,JSON.stringify(record));
    assert.equal(observed.model,value);
    assert.deepEqual(after,before);
    assert.ok(observed.events.some(e=>e.phase==='bubble'&&e.formats.some(([type])=>type==='text/html')),'positive control: editor generated HTML');
    return record;
  });
  for (const fault of ['backup','focus','restore']) {
    await check(`${mode}: real Monaco ${fault} failure has explicit outcome and cleanup`,async()=>{
      await evaluate(`navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['fault backup'],{type:'text/plain'}),'text/html':new Blob(['<b>fault backup</b>'],{type:'text/html'})})])`);
      const before=await evaluate('fixture.clipboard()');
      const oldModel=await evaluate("fixture.read('monaco')");
      await evaluate(`fixture.events.length=0;fixture.armFault(${JSON.stringify(fault)})`);
      let response,details;
      const value='fault case '+fault;
      try { response=await cli(['fill','#monaco',value]);details=await evaluate('fixture.fault'); }
      finally { await evaluate('fixture.disarmFault()'); }
      const observed=await evaluate("({model:fixture.read('monaco'),events:fixture.events.filter(e=>e.editor==='monaco')})");
      const after=await evaluate('fixture.clipboard()');
      const record={mode,fault,value,response,details,before,after,observed};
      (evidence.editorFaults??=[]).push(record);save();
      assert.equal(response.success,false,JSON.stringify(record));
      assert.equal(details.fired,true,'intended failure was reached');
      assert.match(response.error,new RegExp('fixture '+fault+' rejected'));
      if(fault==='restore') {
        assert.equal(observed.model,value);
        assert.equal(details.stages,1,'no destructive text fallback');
      } else {
        assert.deepEqual(after,before,'restore saved clipboard after setup failure');
        assert.equal(observed.model,oldModel,'no native edit after setup refusal');
        assert.ok(!observed.events.some(e=>['paste','copy'].includes(e.type)));
      }
      return record;
    });
  }
  if(mode==='relay') for(const fault of ['input','concurrent']) {
    await check(`relay: real Monaco ${fault} fault preserves clipboard and removes listeners`,async()=>{
      const tab=(await A.evaluate(worker.sid,'chrome.tabs.query({})')).find(t=>t.url===editorUrl);assert.ok(tab);
      const listenerCount=()=>A.evaluate(worker.sid,`(async()=>{
        const send=chrome.debugger.sendCommand.bind(chrome.debugger),target={tabId:${tab.id}};
        const object=await send(target,'Runtime.evaluate',{expression:'document',returnByValue:false});
        try { const data=await send(target,'DOMDebugger.getEventListeners',{objectId:object.result.objectId});return data.listeners.filter(l=>['paste','copy'].includes(l.type)).map(l=>({type:l.type,capture:l.useCapture})); }
        finally {await send(target,'Runtime.releaseObject',{objectId:object.result.objectId});}
      })()`);
      await evaluate(`navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['fault backup'],{type:'text/plain'}),'text/html':new Blob(['<b>fault backup</b>'],{type:'text/html'})})])`);
      const before=await evaluate('fixture.clipboard()'),listenersBefore=await listenerCount(),oldModel=await evaluate("fixture.read('monaco')");
      await evaluate('fixture.events.length=0');
      await A.evaluate(worker.sid,`(()=>{
        const original=chrome.debugger.sendCommand.bind(chrome.debugger);globalThis.editorFaultRestore=()=>{chrome.debugger.sendCommand=original;};globalThis.editorFaultSeen=0;
        chrome.debugger.sendCommand=async(...args)=>{
          if(args[1]==='Input.dispatchKeyEvent'&&args[2]?.commands?.includes('paste')) {
            editorFaultSeen++;
            if(${JSON.stringify(fault)}==='input')throw Error('fixture input rejected');
            const result=await original(...args);
            await original(args[0],'Runtime.evaluate',{expression:"navigator.clipboard.writeText('newer fixture clipboard')",awaitPromise:true,returnByValue:true});
            return result;
          }
          return original(...args);
        };return true;
      })()`);
      let response,seen;
      try {response=await cli(['fill','#monaco','fault case '+fault]);seen=await A.evaluate(worker.sid,'editorFaultSeen');}
      finally {await A.evaluate(worker.sid,'editorFaultRestore();delete globalThis.editorFaultRestore;delete globalThis.editorFaultSeen;true');}
      const after=await evaluate('fixture.clipboard()'),listenersAfter=await listenerCount();
      const observed=await evaluate("({model:fixture.read('monaco'),events:fixture.events.filter(e=>e.editor==='monaco')})");
      const record={mode,fault,response,seen,before,after,listenersBefore,listenersAfter,observed};
      (evidence.editorFaults??=[]).push(record);save();
      assert.equal(seen,1);assert.equal(response.success,false,JSON.stringify(record));
      assert.deepEqual(listenersAfter,listenersBefore,'temporary clipboard listeners removed before lease expiry');
      if(fault==='input') {assert.match(response.error,/fixture input rejected/);assert.deepEqual(after,before);assert.equal(observed.model,oldModel);}
      else {assert.match(response.error,/clipboard changed before editor input/);assert.equal(await evaluate('navigator.clipboard.readText()'),'newer fixture clipboard');assert.ok(!observed.events.some(e=>e.type==='copy'));}
      return record;
    });
  }
  // Research-only control, not a production proposal: inspect whether native
  // insertText plus observing/clearing a trusted copy avoids OS clipboard writes.
  // A stopped-propagation negative control tests the limit of that approach.
  await check(`${mode}: exploratory clipboard-free native input and copy control`,async()=>{
    const records=[];
    for(const blocked of [false,true]) {
      await evaluate(`fixture.copyProbe={seen:false};
        fixture.copyProbeListener=e=>{if(!e.target.closest('#monaco'))return;fixture.copyProbe={seen:true,trusted:e.isTrusted,prevented:e.defaultPrevented,text:e.clipboardData.getData('text/plain')};e.clipboardData.clearData();e.preventDefault();};
        fixture.copyStop=e=>e.stopImmediatePropagation();
        document.addEventListener('copy',fixture.copyProbeListener);
        ${blocked?"document.querySelector('#monaco textarea.inputarea').addEventListener('copy',fixture.copyStop);":""}
        document.querySelector('#monaco textarea.inputarea').focus();`);
      try {
        const value='const greeting = "你好";\nconsole.log(greeting);';
        await ok(['press','Control+a']);
        await ok(['keyboard','inserttext',value]);
        const model=await evaluate("fixture.read('monaco')");
        await evaluate("navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['concurrent clipboard sentinel'],{type:'text/plain'}),'text/html':new Blob(['<b>concurrent clipboard sentinel</b>'],{type:'text/html'})})])");
        const before=await evaluate('fixture.clipboard()');
        await ok(['press','Control+a']);
        await ok(['press','Control+c']);
        const probe=await evaluate('fixture.copyProbe');
        const after=await evaluate('fixture.clipboard()');
        const record={blocked,value,model,modelMatches:model===value,probe,before,after};
        records.push(record);(evidence.clipboardFreeProbe??=[]).push({mode,...record});save();
        if(!blocked){assert.equal(probe.seen,true);assert.equal(probe.trusted,true);assert.equal(probe.text,model);assert.deepEqual(after,before);}
        else {assert.equal(probe.seen,false);assert.notDeepEqual(after,before,'negative control: a stopped copy escapes the late observer');}
      } finally {
        await evaluate("document.removeEventListener('copy',fixture.copyProbeListener);document.querySelector('#monaco textarea.inputarea').removeEventListener('copy',fixture.copyStop);delete fixture.copyProbeListener;delete fixture.copyStop");
      }
    }
    return records;
  });
  if(production)await checkModelProduction({mode,url,ok,cli,evaluate,check,evidence,save});
  else if(mode==='relay')await checkModelReads({url,ok,evaluate,check,A,worker,evidence,save});
  } finally {launchPermissions?.close();}
}

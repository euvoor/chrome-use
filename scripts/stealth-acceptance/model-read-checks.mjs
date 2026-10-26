// Research-only matrix for clipboard-free model discovery. This is not the
// production fill implementation and never receives a fixture model handle.
import assert from 'node:assert/strict';
import { waitFor } from '../inspect-acceptance/lib.mjs';
import { inspectEditorHandles } from './editor-handles-probe.mjs';

export async function checkModelReads({url,ok,evaluate,check,A,worker,evidence,save}) {
  for(const variant of ['original','minified']) {
    const editorUrl=`${url}editors/${variant==='minified'?'minified/index.html':''}`;
    await ok(['open',editorUrl]);
    await waitFor(()=>evaluate('!!window.fixture?.ready'),{timeout:30000,label:`${variant} editor ready`});
    const tab=(await A.evaluate(worker.sid,'chrome.tabs.query({})')).find(t=>t.url===editorUrl);assert.ok(tab);
    const send=(method,params)=>A.evaluate(worker.sid,`chrome.debugger.sendCommand({tabId:${tab.id}},${JSON.stringify(method)},${JSON.stringify(params)})`);
    for(const target of ['monaco','monaco-secondary'])await check(`relay: ${variant} clipboard-free model read for ${target}`,async()=>{
      const selector=`#${target} textarea.inputarea`;
      const other=target==='monaco'?'monaco-secondary':'monaco';
      const result=await inspectEditorHandles(send,async(apiHandle,inputHandle)=>{
        const readModel=async(node=inputHandle)=>{
          const response=await send('Runtime.callFunctionOn',{
            objectId:apiHandle,arguments:[{objectId:node}],returnByValue:true,
            functionDeclaration:`function(input){
              const root=input.closest('.monaco-editor');
              if(!root?.isConnected||!input.isConnected)throw Error('editor target unavailable');
              const editors=this.getEditors();
              const matches=editors.filter(e=>e.getDomNode()===root);
              if(matches.length!==1)throw Error('ambiguous editor identity');
              const model=matches[0].getModel();
              if(!model)throw Error('editor has no live model');
              return {value:model.getValue(),uri:String(model.uri),editorCount:editors.length};
            }`,
          });
          if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
          return response.result.value;
        };
        const records=[];
        for(const value of ['const hello = "你好";\nconsole.log(hello);',Array.from({length:300},(_,i)=>`line ${i}`).join('\n'),'']) {
          await evaluate(`navigator.clipboard.writeText('model-probe clipboard sentinel');document.querySelector(${JSON.stringify(selector)}).focus();fixture.events.length=0`);
          const before=await evaluate(`(async()=>({clipboard:await fixture.clipboard(),globals:Object.getOwnPropertyNames(window).sort(),other:fixture.read(${JSON.stringify(other)})}))()`);
          const prior=await readModel();assert.ok(prior.editorCount>=2);
          await ok(['press','Control+a']);
          if(value)await ok(['keyboard','inserttext',value]);else await ok(['press','Backspace']);
          const model=await readModel();
          const after=await evaluate(`(async()=>({clipboard:await fixture.clipboard(),globals:Object.getOwnPropertyNames(window).sort(),oracle:fixture.read(${JSON.stringify(target)}),other:fixture.read(${JSON.stringify(other)}),events:fixture.events}))()`);
          assert.equal(model.value,value);assert.equal(after.oracle,value);assert.equal(after.other,before.other);
          assert.equal(model.uri,prior.uri);
          assert.deepEqual(after.clipboard,before.clipboard);assert.deepEqual(after.globals,before.globals);
          assert.ok(after.events.length>0,'native input must produce observed events');
          assert.ok(after.events.some(e=>e.type==='keydown'&&e.trusted),'trusted keyboard input was not observed');
          assert.ok(after.events.every(e=>e.trusted));
          assert.ok(after.events.every(e=>!['copy','paste'].includes(e.type)),'model probe must not use clipboard events');
          records.push({valueLength:value.length,model,events:after.events,otherUnchanged:true,clipboardUnchanged:true,globalsUnchanged:true});
        }
        const unrelated=await send('Runtime.evaluate',{expression:'document.querySelector("h1")',objectGroup:'editor-handle-probe'});
        await assert.rejects(()=>readModel(unrelated.result.objectId),/editor target unavailable/);
        return records;
      },selector);
      (evidence.modelReadMatrix??=[]).push({variant,target,result});save();
      assert.ok(result.modelProbe&&!result.modelProbe.error,JSON.stringify(result.modelProbe));
      return result;
    });
    await check(`relay: ${variant} unavailable model discovery performs no input`,async()=>{
      await evaluate('fixture.events.length=0');
      const before=await evaluate('fixture.clipboard()');
      const result=await inspectEditorHandles(send,()=>{throw Error('unrelated node must not discover an editor');},'h1');
      assert.equal(result.modelProbe,null);assert.deepEqual(await evaluate('fixture.events'),[]);
      assert.deepEqual(await evaluate('fixture.clipboard()'),before);
      return result;
    });
  }
}

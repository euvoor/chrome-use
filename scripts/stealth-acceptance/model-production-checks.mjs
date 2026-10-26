import assert from 'node:assert/strict';
import { waitFor } from '../inspect-acceptance/lib.mjs';

export async function checkModelProduction({mode,url,ok,cli,evaluate,check,evidence,save}) {
  for(const variant of ['original','minified']) {
    await ok(['open',`${url}editors/${variant==='minified'?'minified/index.html':''}`]);
    await waitFor(()=>evaluate('!!window.fixture?.ready'),{timeout:30000,label:`${variant} editor ready`});
    for(const target of ['monaco','monaco-secondary'])await check(`${mode}: production ${variant} native fill and get value for ${target}`,async()=>{
      const other=target==='monaco'?'monaco-secondary':'monaco';
      const records=[];
      for(const value of ['const hello = "你好";\nconsole.log(hello);',Array.from({length:300},(_,i)=>`line ${i}`).join('\n'),'']) {
        await evaluate("navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['native path sentinel'],{type:'text/plain'}),'text/html':new Blob(['<b>native path sentinel</b>'],{type:'text/html'})})])");
        const before=await evaluate(`(async()=>({clipboard:await fixture.clipboard(),globals:Object.getOwnPropertyNames(window).sort(),other:fixture.read(${JSON.stringify(other)})}))()`);
        await evaluate('fixture.events.length=0;fixture.clipboardCalls.length=0');
        const response=await cli(['fill',`#${target}`,value]);
        const read=await cli(['get','value',`#${target}`]);
        const apiCalls=await evaluate('fixture.clipboardCalls');
        const after=await evaluate(`(async()=>({clipboard:await fixture.clipboard(),globals:Object.getOwnPropertyNames(window).sort(),oracle:fixture.read(${JSON.stringify(target)}),other:fixture.read(${JSON.stringify(other)}),events:fixture.events,focus:document.activeElement===document.querySelector(${JSON.stringify(`#${target} textarea.inputarea`)})}))()`);
        const record={mode,variant,target,valueLength:value.length,response,read,before,after,apiCalls};
        (evidence.modelProduction??=[]).push(record);save();records.push(record);
        assert.equal(response.success,true,JSON.stringify(response));assert.equal(response.data.engine,'monaco-native');
        assert.equal(read.success,true,JSON.stringify(read));assert.equal(read.data.value,value);
        assert.equal(after.oracle,value);assert.equal(after.other,before.other);assert.equal(after.focus,true);
        assert.deepEqual(after.clipboard,before.clipboard);assert.deepEqual(after.globals,before.globals);
        assert.deepEqual(apiCalls,[],'production fill/read must not access the Clipboard API');
        assert.ok(after.events.some(e=>e.type==='keydown'&&e.trusted));
        assert.ok(after.events.every(e=>e.trusted));
        assert.ok(after.events.every(e=>!['copy','paste'].includes(e.type)));
      }
      return records;
    });
  }
  for(const kind of ['focus','swap','reject','concurrent']) await check(`${mode}: native model ${kind} control`,async()=>{
    await ok(['open',`${url}editors/`]);
    await waitFor(()=>evaluate('!!window.fixture?.ready'),{timeout:30000,label:'fault fixture ready'});
    await evaluate("navigator.clipboard.writeText('fault clipboard sentinel')");
    const before=await evaluate("({model:fixture.read('monaco'),other:fixture.read('monaco-secondary')})");
    await evaluate(`fixture.armModelFault(${JSON.stringify(kind)});fixture.clipboardCalls.length=0;fixture.events.length=0`);
    try {
      const response=await cli(['fill','#monaco','fault control input']);
      await evaluate('fixture.modelFault.pending || Promise.resolve()');
      const after=await evaluate("(async()=>({fired:fixture.modelFault.fired,model:fixture.read('monaco'),other:fixture.read('monaco-secondary'),calls:[...fixture.clipboardCalls],events:fixture.events,clipboard:await Object.getPrototypeOf(navigator.clipboard).readText.call(navigator.clipboard)}))()");
      (evidence.modelFaults??=[]).push({mode,kind,before,response,after});save();
      assert.equal(after.fired,true,'fault must actually fire');
      assert.deepEqual(after.calls,[],'no production Clipboard API access or fallback retry');
      assert.equal(after.other,before.other);
      assert.ok(after.events.every(e=>!['copy','paste'].includes(e.type)));
      if(kind==='concurrent') {
        assert.equal(response.success,true,JSON.stringify(response));
        assert.equal(response.data.engine,'monaco-native');
        assert.equal(after.model,'fault control input');
        assert.equal(after.clipboard,'new concurrent clipboard');
      } else {
        assert.equal(response.success,false,JSON.stringify(response));
        assert.equal(after.model,kind==='swap'?'replacement model':before.model);
        assert.equal(after.clipboard,'fault clipboard sentinel');
      }
      return {kind,response,after};
    } finally {await evaluate('fixture.clearModelFault()');}
  });
}

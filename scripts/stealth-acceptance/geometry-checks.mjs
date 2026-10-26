// Independent comparison: Chrome itself projects the same-origin control.
// An otherwise identical out-of-process frame must differ only by placement.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from '../inspect-acceptance/lib.mjs';

export async function checkGeometry({mode, ok, cli, evaluate, check, outDir, evidence, save, A, worker}) {
  const baseline = process.env.GEOMETRY_BASELINE === '1';
  const extended = process.env.GEOMETRY_EXTENDED === '1';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    res.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/leaf') {
      const name = url.searchParams.get('name');
      res.end(`<!doctype html><style>body{margin:0;${url.searchParams.has('scrollbars')?'width:600px;height:700px;':''}}button{position:absolute;left:20px;top:30px;width:80px;height:40px;border:0;background:rgb(12,180,80)}</style><button>${name}</button>`);
      return;
    }
    if (url.pathname === '/nested') {
      const name = url.searchParams.get('name');
      // Alternate hosts again for the OOP specimen, but keep the control in
      // one renderer. Both branches have identical layout and transforms.
      res.end(`<!doctype html><style>body{margin:0}iframe{position:absolute;left:30px;top:40px;width:160px;height:100px;border:0;transform-origin:0 0;transform:rotate(12deg) skewX(8deg)}</style><iframe src="http://127.0.0.1:${server.address().port}/leaf?name=${name}"></iframe>`);
      return;
    }
    const nested = url.searchParams.has('nested');
    const childQuery=url.searchParams.has('scrollbars')?'&scrollbars=1':'';
    res.end(`<!doctype html><style>body{margin:0;height:1400px}.slot{position:absolute;top:240px;left:100px}.slot+ .slot{left:600px}iframe{width:300px;height:220px;border:0;transform-origin:0 0}</style>
      <div id="pair" style="position:absolute;top:100px;left:50px;width:1000px;height:700px">
      <div class="slot"><iframe id="same" src="/${nested?'nested':'leaf'}?name=Control${childQuery}"></iframe></div>
      <div class="slot"><iframe id="cross" src="http://localhost:${server.address().port}/${nested?'nested':'leaf'}?name=Specimen${childQuery}"></iframe></div></div>
      <script>window.mutations=[];new MutationObserver(r=>mutations.push(...r)).observe(document.documentElement,{subtree:true,attributes:true,childList:true});</script>`);
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const cases = [
    ['scale','scale(.8)',false],
    ['rotate','rotate(25deg)',false],
    ['skew','skew(20deg,10deg)',false],
    ['mirror','translateX(300px) scaleX(-1)',false],
    ['perspective','perspective(450px) rotateY(30deg)',false],
    ['nested','rotate(-15deg) scale(.9)',true],
    ...(extended?[['scrollbars','skew(20deg,10deg)',false]]:[]),
  ];
  try {
    for (const [label, transform, nested] of cases) {
      await check(`${mode}: ${label} frame geometry`,async()=>{
        const fixtureUrl=`http://127.0.0.1:${server.address().port}/${nested?'?nested':label==='scrollbars'?'?scrollbars':''}`;
        await ok(['open',fixtureUrl]);
        // Extended projection coverage runs in an active owned fixture tab.
        // Background capture is separately measured, never counted as passed.
        if(extended&&mode==='relay') {
          const tab=(await A.evaluate(worker.sid,'chrome.tabs.query({})')).find(t=>t.url===fixtureUrl);
          assert.ok(tab);await A.evaluate(worker.sid,`chrome.tabs.update(${tab.id},{active:true})`);
          evidence.geometryContext='active owned fixture tab';save();
        }
        await waitFor(async()=> (await evaluate('document.readyState'))==='complete',{timeout:20000,label:'geometry fixture'});
        await evaluate(`for(const f of document.querySelectorAll('iframe')) f.style.transform=${JSON.stringify(transform)}`);
        const observations=[];
        const captures=[1,2].flatMap(dpr=>(extended?[['viewport',[]],['full',['--full']],['clip',['--clip','0,100,1200,700']],['selector',['--selector','#pair']]]:[['viewport',[]]]).map(([region,args])=>({dpr,scroll:dpr===2?80:0,region,args})));
        for (const {dpr,scroll,region,args} of captures) {
          await ok(['set','viewport','1100','750',String(dpr)]);
          await evaluate(`scrollTo(0,${scroll});mutations=[]`);
          const before=await evaluate('Object.getOwnPropertyNames(window).sort()');
          const file=path.join(outDir,`${mode}-geometry-${label}-${dpr}-${region}.png`);
          if(mode==='relay')await A.evaluate(worker.sid,'stealthCaptureTrace=[]');
          const result=await cli(['screenshot',file,'--annotate',...args]);
          const record={mode,label,transform,nested,dpr,scroll,region,result};
          if(result.success){const png=fs.readFileSync(file);record.raster={width:png.readUInt32BE(16),height:png.readUInt32BE(20)};}
          if(mode==='relay') {
            record.trace=await A.evaluate(worker.sid,'stealthCaptureTrace');
            if(!result.success) {
              // Reads only, recorded separately; never count a remedial retry
              // as the original capture passing. A raw control isolates the
              // image capture from the projection/annotation implementation.
              record.rawControl=await cli(['screenshot',path.join(outDir,`${mode}-raw-${label}-${dpr}.png`)]);
              const target=record.trace.find(t=>t.method==='Page.captureScreenshot')?.target;
              if(target) {
                record.captureControls=[];
                for(const kind of ['viewport-clip','full-clip']) {
                  const recovery=await cli(['get','title']);
                  const control=await A.evaluate(worker.sid,`(async()=>{
                    const target=${JSON.stringify(target)},kind=${JSON.stringify(kind)};
                    const metrics=await chrome.debugger.sendCommand(target,'Page.getLayoutMetrics');
                    const v=metrics.cssVisualViewport,c=metrics.cssContentSize;
                    const clip=kind==='viewport-clip'?{x:v.pageX,y:v.pageY,width:v.clientWidth,height:v.clientHeight,scale:1}:{x:0,y:0,width:c.width,height:c.height,scale:1};
                    const params={format:'png',fromSurface:true,captureBeyondViewport:true,clip};
                    const result=await Promise.race([chrome.debugger.sendCommand(target,'Page.captureScreenshot',params).then(r=>({bytes:r.data?.length})).catch(e=>({error:e.message})),new Promise(r=>setTimeout(()=>r({error:'diagnostic timeout'}),5000))]);
                    return {kind,params,result};
                  })()`);
                  record.captureControls.push({recovery,control});
                }
                if(label==='rotate') {
                  record.windowControl=await A.evaluate(worker.sid,`(async()=>{
                    const tab=await chrome.tabs.get(${target.tabId});
                    const windows=await chrome.windows.getAll();
                    const focused=windows.find(w=>w.focused);
                    const active=(await chrome.tabs.query({windowId:tab.windowId,active:true}))[0];
                    try {
                      await chrome.windows.update(tab.windowId,{focused:true});
                      await chrome.tabs.update(tab.id,{active:true});
                      const result=await Promise.race([chrome.debugger.sendCommand({tabId:tab.id},'Page.captureScreenshot',{format:'png',fromSurface:true}).then(r=>({bytes:r.data?.length})).catch(e=>({error:e.message})),new Promise(r=>setTimeout(()=>r({error:'diagnostic timeout'}),5000))]);
                      return {tab,windows,result};
                    } finally {
                      if(active)await chrome.tabs.update(active.id,{active:true});
                      if(focused)await chrome.windows.update(focused.id,{focused:true});
                    }
                  })()`);
                }
              }
            }
          }
          (evidence.geometry??=[]).push(record);save();
          assert.deepEqual(await evaluate('Object.getOwnPropertyNames(window).sort()'),before);
          assert.equal(await evaluate('mutations.length'),0);
          if(baseline && label!=='scale') {
            assert.equal(result.success,false,JSON.stringify(record));
            assert.match(result.error,/cannot safely project this iframe transform/);
          } else {
            assert.equal(result.success,true,JSON.stringify(record));
            const control=result.data.annotations.find(a=>a.name==='Control');
            const specimen=result.data.annotations.find(a=>a.name==='Specimen');
            assert.ok(control && specimen,JSON.stringify(record));
            for(const k of ['x','y','width','height']) {
              const expected=control.box[k]+(k==='x'?500:0);
              assert.ok(Math.abs(specimen.box[k]-expected)<=1,JSON.stringify({k,expected,record}));
            }
          }
          observations.push(record);
        }
        return observations;
      });
    }
    if(mode==='relay'&&!extended)await check('relay: controlled active/inactive capture observations',async()=>{
      const fixtureUrl=`http://127.0.0.1:${server.address().port}/?capture-control`;
      await ok(['open',fixtureUrl]);
      await waitFor(async()=>await evaluate('document.readyState')==='complete',{label:'capture control ready'});
      const tabs=await A.evaluate(worker.sid,'chrome.tabs.query({})');
      const tab=tabs.find(t=>t.url===fixtureUrl);assert.ok(tab);
      const prior=tabs.find(t=>t.windowId===tab.windowId&&t.active);
      const sibling=await A.evaluate(worker.sid,`chrome.tabs.create({windowId:${tab.windowId},url:'about:blank',active:false})`);
      const observations=[];
      try {
        for(const [index,active] of [false,true,false,true].entries()) {
          await A.evaluate(worker.sid,`chrome.tabs.update(${active?tab.id:sibling.id},{active:true})`);
          for(const dpr of [1,2]) {
            await ok(['set','viewport','1100','750',String(dpr)]);
            const state=await A.evaluate(worker.sid,`chrome.tabs.get(${tab.id})`);
            const before=await evaluate('({visibility:document.visibilityState,focus:document.hasFocus(),dpr:devicePixelRatio})');
            const result=await cli(['screenshot',path.join(outDir,`relay-activity-${index}-${dpr}.png`),'--annotate']);
            observations.push({index,active,dpr,state,before,result});
            evidence.captureActivity=observations;save();
            // Complete ordinary daemon health recovery before the next cell.
            if(!result.success)await cli(['get','title']);
          }
        }
      } finally {
        if(prior)await A.evaluate(worker.sid,`chrome.tabs.update(${prior.id},{active:true})`);
        await A.evaluate(worker.sid,`chrome.tabs.remove(${sibling.id})`);
      }
      return observations;
    });
  } finally { server.close(); }
}

// Independent comparison: Chrome itself projects the same-origin control.
// An otherwise identical out-of-process frame must differ only by placement.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { waitFor } from '../inspect-acceptance/lib.mjs';

export async function checkGeometry({mode, ok, cli, evaluate, check, outDir, evidence, save, A, worker}) {
  const baseline = process.env.GEOMETRY_BASELINE === '1';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    res.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/leaf') {
      const name = url.searchParams.get('name');
      res.end(`<!doctype html><style>body{margin:0}button{position:absolute;left:20px;top:30px;width:80px;height:40px;border:0;background:rgb(12,180,80)}</style><button>${name}</button>`);
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
    res.end(`<!doctype html><style>body{margin:0;height:1400px}.slot{position:absolute;top:240px;left:100px}.slot+ .slot{left:600px}iframe{width:300px;height:220px;border:0;transform-origin:0 0}</style>
      <div class="slot"><iframe id="same" src="/${nested?'nested':'leaf'}?name=Control"></iframe></div>
      <div class="slot"><iframe id="cross" src="http://localhost:${server.address().port}/${nested?'nested':'leaf'}?name=Specimen"></iframe></div>
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
  ];
  try {
    for (const [label, transform, nested] of cases) {
      await check(`${mode}: ${label} frame geometry`,async()=>{
        await ok(['open',`http://127.0.0.1:${server.address().port}/${nested?'?nested':''}`]);
        await waitFor(async()=> (await evaluate('document.readyState'))==='complete',{timeout:20000,label:'geometry fixture'});
        await evaluate(`for(const f of document.querySelectorAll('iframe')) f.style.transform=${JSON.stringify(transform)}`);
        const observations=[];
        for (const [dpr,scroll] of [[1,0],[2,80]]) {
          await ok(['set','viewport','1100','750',String(dpr)]);
          await evaluate(`scrollTo(0,${scroll});mutations=[]`);
          const before=await evaluate('Object.getOwnPropertyNames(window).sort()');
          const file=path.join(outDir,`${mode}-geometry-${label}-${dpr}.png`);
          if(mode==='relay')await A.evaluate(worker.sid,'stealthCaptureTrace=[]');
          const result=await cli(['screenshot',file,'--annotate']);
          const record={mode,label,transform,nested,dpr,scroll,result};
          if(mode==='relay') {
            record.trace=await A.evaluate(worker.sid,'stealthCaptureTrace');
            if(!result.success) {
              // Reads only, recorded separately; never count a remedial retry
              // as the original capture passing. A raw control isolates the
              // image capture from the projection/annotation implementation.
              record.rawControl=await cli(['screenshot',path.join(outDir,`${mode}-raw-${label}-${dpr}.png`)]);
              const target=record.trace.find(t=>t.method==='Page.captureScreenshot')?.target;
              if(target) record.viewControl=await A.evaluate(worker.sid,`Promise.race([chrome.debugger.sendCommand(${JSON.stringify(target)},'Page.captureScreenshot',{format:'png',fromSurface:false}).then(r=>({bytes:r.data?.length})).catch(e=>({error:e.message})),new Promise(r=>setTimeout(()=>r({error:'diagnostic timeout'}),5000))])`);
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
  } finally { server.close(); }
}

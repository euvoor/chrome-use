// Native protocol controls on fresh owned tabs, without the CLI capture path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from '../inspect-acceptance/lib.mjs';

export async function checkCaptureProtocols({url,A,worker,browser,check,evidence,save,outDir}) {
  for(const transport of ['extension','browser']) await check(`native ${transport}: sequential DPR capture observations`,async()=>{
    const initial=`${url}?native-capture=${transport}`;
    const tab=await A.evaluate(worker.sid,`chrome.tabs.create({url:${JSON.stringify(initial)},active:false})`);
    let session;
    const send=async(method,params={})=>transport==='extension'
      ? A.evaluate(worker.sid,`chrome.debugger.sendCommand({tabId:${tab.id}},${JSON.stringify(method)},${JSON.stringify(params)})`)
      : browser.send(method,params,session);
    const bounded=async(operation,ms=15000)=>{
      let timer;
      try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`observation timeout after ${ms}ms`)),ms);})]);}
      finally{clearTimeout(timer);}
    };
    const observations=[];
    try {
      if(transport==='extension')await A.evaluate(worker.sid,`chrome.debugger.attach({tabId:${tab.id}},'1.3')`);
      else {
        const target=await waitFor(async()=> (await browser.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url===initial),{label:'native capture target'});
        assert.equal(target.attached,false,'fresh control target must not have another debugger');
        session=(await browser.send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
      }
      await send('Page.enable');
      await send('Network.enable');
      await send('Emulation.setFocusEmulationEnabled',{enabled:true});
      const read=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true})).result.value;
      const state=()=>read('({visibility:document.visibilityState,focus:document.hasFocus(),dpr:devicePixelRatio,width:innerWidth,height:innerHeight,url:location.href,now:performance.now()})');
      for(const [label,transform] of [['scale','scale(.8)'],['rotate','rotate(25deg)'],['skew','skew(20deg,10deg)']]) {
        const navigation=`${initial}&phase=${label}`;
        await send('Page.navigate',{url:navigation});
        await waitFor(async()=>await read(`location.href===${JSON.stringify(navigation)}&&document.readyState==='complete'`),{label:'native capture navigation'});
        await read(`for(const f of document.querySelectorAll('iframe')) f.style.transform=${JSON.stringify(transform)}`);
        for(const dpr of [1,2]) {
          await send('Emulation.setDeviceMetricsOverride',{width:1100,height:750,deviceScaleFactor:dpr,mobile:false});
          await read(`scrollTo(0,${dpr===2?80:0})`);
          const record={transport,label,dpr,before:await state(),tab:await A.evaluate(worker.sid,`chrome.tabs.get(${tab.id})`)};
          await send('Emulation.setDefaultBackgroundColorOverride',{color:{r:255,g:255,b:255,a:255}});
          const start=performance.now();
          try {
            const result=await bounded(send('Page.captureScreenshot',{format:'png',fromSurface:true}));
            const png=Buffer.from(result.data,'base64');
            record.capture={ok:true,ms:performance.now()-start,bytes:png.length,width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
            fs.writeFileSync(path.join(outDir,`native-${transport}-${label}-${dpr}.png`),png);
          } catch(error) {record.capture={ok:false,ms:performance.now()-start,error:String(error)};}
          try {record.after=await bounded(state(),1500);} catch(error){record.after={error:String(error)};}
          observations.push(record);(evidence.captureProtocols??=[]).push(record);save();
          if(!record.capture.ok)return observations; // Do not mix recovery with the next control.
          await send('Emulation.setDefaultBackgroundColorOverride',{});
        }
      }
      return observations;
    } finally {
      if(transport==='extension')await A.evaluate(worker.sid,`chrome.debugger.detach({tabId:${tab.id}})`).catch(()=>{});
      else if(session)await browser.send('Target.detachFromTarget',{sessionId:session}).catch(()=>{});
      await A.evaluate(worker.sid,`chrome.tabs.remove(${tab.id})`);
    }
  });
}

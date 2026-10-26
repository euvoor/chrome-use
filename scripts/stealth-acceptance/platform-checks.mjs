// Hosted-only native controls for language reduction and GPU availability.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from '../inspect-acceptance/lib.mjs';

export async function platformFixture() {
  const server=http.createServer((req,res)=>{
    const header=req.headers['accept-language']??null;
    res.setHeader('Cache-Control','no-store');
    if(req.url.startsWith('/worker')) {
      res.setHeader('Content-Type','text/javascript');
      res.end(`postMessage({language:navigator.language,languages:navigator.languages,header:${JSON.stringify(header)}})`);
    } else {
      res.setHeader('Content-Type','text/html');
      res.end(`<!doctype html><title>Platform control</title><script>window.requestLanguage=${JSON.stringify(header)}</script>`);
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}/`,close:()=>server.close()};
}

const expression=`(async()=>{
  const worker=await new Promise((resolve,reject)=>{const w=new Worker('/worker.js');const t=setTimeout(()=>{w.terminate();reject(Error('worker timed out'))},5000);w.onmessage=e=>{clearTimeout(t);w.terminate();resolve(e.data)};w.onerror=e=>{clearTimeout(t);w.terminate();reject(Error(e.message))}});
  const canvas=document.createElement('canvas');
  const gl=canvas.getContext('webgl');
  const debug=gl&&gl.getExtension('WEBGL_debug_renderer_info');
  return {language:navigator.language,languages:navigator.languages,header:requestLanguage,worker,
    webgl:gl?{vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),unmaskedVendor:debug&&gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),unmaskedRenderer:debug&&gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)}:null};
})()`;

export async function checkPlatformCli({mode,ok,evaluate,check,evidence,save}) {
  const fixture=await platformFixture();
  try {
    await check(`${mode}: native locale and GPU observations`,async()=>{
      await ok(['open',fixture.url]);
      const result=await evaluate(expression);
      (evidence.platform??=[]).push({mode,result});save();
      assert.equal(result.language,'ja-JP');
      assert.deepEqual(result.languages,result.worker.languages);
      assert.equal(result.worker.language,result.language);
      assert.ok(result.header.startsWith('ja-JP'));
      return result;
    });
  } finally {fixture.close();}
}

export async function checkNativePlatform({startChrome,work,check,evidence,save}) {
  const fixture=await platformFixture();
  try {
    for(const [label,flags] of [
      ['default',[]],
      ['reduction-enabled',['--enable-features=ReduceAcceptLanguage']],
      ['reduction-disabled',['--disable-features=ReduceAcceptLanguage,ReduceAcceptLanguageHTTP']],
    ]) {
      await check(`native Chrome: ${label} language and GPU control`,async()=>{
        const profile=path.join(work,`native-platform-${label}`);fs.mkdirSync(profile,{recursive:true});
        const args=['--accept-lang=ja-JP,ja',...flags];
        const browser=await startChrome(profile,{PATH:process.env.PATH,DISPLAY:process.env.DISPLAY,XAUTHORITY:process.env.XAUTHORITY||'',HOME:profile,LANG:'en_US.UTF-8'},args);
        try {
          const {targetId}=await browser.send('Target.createTarget',{url:fixture.url});
          const {sessionId}=await browser.send('Target.attachToTarget',{targetId,flatten:true});
          await waitFor(async()=> (await browser.send('Runtime.evaluate',{expression:'typeof requestLanguage !== "undefined"',returnByValue:true},sessionId)).result.value,{label:'native platform fixture'});
          const response=await browser.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
          assert.ok(!response.exceptionDetails,JSON.stringify(response));
          const result=response.result.value;
          const gpu=await browser.send('SystemInfo.getInfo');
          const record={label,args,version:browser.version,result,gpu};
          (evidence.nativePlatform??=[]).push(record);save();
          if(label==='default') {
            // Same locale and challenge as the existing benchmark, but no
            // chrome-use daemon, extension, stealth patches or input actions.
            const challengeUrl='https://www.scrapingcourse.com/cloudflare-challenge';
            await browser.send('Page.navigate',{url:challengeUrl},sessionId);
            record.challenge={url:challengeUrl,samples:[]};save();
            const started=Date.now();
            for(const elapsed of [0,16000,32000,64000]) {
              await new Promise(resolve=>setTimeout(resolve,Math.max(0,started+elapsed-Date.now())));
              const sample=await browser.send('Runtime.evaluate',{expression:'({title:document.title,url:location.href,text:document.body?.innerText?.slice(0,500)})',returnByValue:true},sessionId);
              record.challenge.samples.push({elapsedMs:Date.now()-started,result:sample.result.value});save();
            }
          }
          assert.equal(result.language,'ja-JP');
          assert.deepEqual(result.languages,result.worker.languages);
          assert.ok(result.header.startsWith('ja-JP'));
          return record;
        } finally {await browser.close();}
      });
    }
  } finally {fixture.close();}
}

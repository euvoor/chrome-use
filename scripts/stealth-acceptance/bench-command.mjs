// Records the existing public benchmark's command results on its disposable VM.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [binary,...args]=process.argv.slice(2);
const started=Date.now();
const result=spawnSync(binary,args,{env:process.env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000});
fs.appendFileSync(process.env.BENCH_COMMAND_LOG,JSON.stringify({args,elapsedMs:Date.now()-started,status:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr})+'\n');
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
process.exitCode=result.status??1;

import fs from 'node:fs';
import {build} from 'esbuild';
const html=fs.readFileSync(new URL('./fixture.html',import.meta.url),'utf8');
const body=html.split("require(['vs/editor/editor.main'],function(){\n")[1].split('});</script>')[0];
await build({stdin:{contents:"import * as monaco from 'monaco-editor';\n"+body,resolveDir:new URL('.',import.meta.url).pathname,sourcefile:'fixture.mjs'},bundle:true,minify:true,format:'esm',outfile:new URL('./node_modules/monaco-editor/min/esm.js',import.meta.url).pathname,loader:{'.ttf':'file'}});
const esm=html.slice(0,html.indexOf('<script src="/vs/loader.js">'))+'<link rel="stylesheet" href="/esm.css"><script type="module" src="/esm.js"></script>';
fs.writeFileSync(new URL('./esm.html',import.meta.url),esm);

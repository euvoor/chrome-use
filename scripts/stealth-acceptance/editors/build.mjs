import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const outdir = path.resolve(process.env.EDITOR_DIST);
fs.mkdirSync(outdir, { recursive: true });
for(const minify of [false,true]) {
const destination=minify?path.join(outdir,'minified'):outdir;
await build({
  entryPoints: { editors: 'fixture.mjs', 'editor.worker': 'monaco-editor/editor/editor.worker.js' },
  bundle: true, minify, format: 'esm', outdir:destination, loader: { '.ttf': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
fs.writeFileSync(path.join(destination,'index.html'),fs.readFileSync('fixture.html','utf8').replaceAll('/editors/',minify?'/editors/minified/':'/editors/'));
}
fs.copyFileSync('pnpm-lock.yaml', path.join(outdir, 'pnpm-lock.yaml'));

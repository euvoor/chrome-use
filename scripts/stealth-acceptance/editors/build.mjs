import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const outdir = path.resolve(process.env.EDITOR_DIST);
fs.mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: { editors: 'fixture.mjs', 'editor.worker': 'monaco-editor/editor/editor.worker.js' },
  bundle: true, format: 'esm', outdir, loader: { '.ttf': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
fs.copyFileSync('fixture.html', path.join(outdir, 'index.html'));
fs.copyFileSync('pnpm-lock.yaml', path.join(outdir, 'pnpm-lock.yaml'));

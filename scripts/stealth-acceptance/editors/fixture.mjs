// The model instances stay in this module. Read-only fixture accessors verify
// application state without exposing the model APIs used by chrome-use fill.
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { registerPlainText } from '@lexical/plain-text';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from 'prosemirror-schema-basic';
import 'prosemirror-view/style/prosemirror.css';
import * as monaco from 'monaco-editor';

const events = [], errors = [];
window.fixture = { events, errors, ready: false };
for (const type of ['beforeinput','input','change','focusout','paste','copy','keydown','keyup']) {
  document.addEventListener(type, event => {
    const container = event.target.closest('#lexical,#prosemirror,#monaco,#monaco-secondary');
    if (!container) return;
    const record = { editor: container.id, type, trusted: event.isTrusted, key: event.key,
      formats: event.clipboardData ? [...event.clipboardData.types] : [] };
    if (type === 'paste' || type === 'copy') record.exposedState = [...document.querySelectorAll('#monaco,#monaco *')]
      .flatMap(node => Object.getOwnPropertyNames(node).filter(name => name.startsWith('__chromeUseMonaco')));
    const sample = () => ({ prevented: event.defaultPrevented, formats: event.clipboardData ? [...event.clipboardData.types].map(type=>[type,event.clipboardData.getData(type)]) : [] });
    if (event.clipboardData) {
      record.capture = sample();
      queueMicrotask(() => { record.microtask = sample(); });
      setTimeout(() => { record.task = sample(); }, 0);
    }
    setTimeout(() => { record.prevented = event.defaultPrevented; events.push(record); }, 0);
  }, true);
}

const lexical = createEditor({ namespace: 'stealth-fixture', onError: error => errors.push(String(error)) });
lexical.setRootElement(document.getElementById('lexical'));
registerPlainText(lexical);
lexical.update(() => $getRoot().append($createParagraphNode().append($createTextNode('old lexical'))), { discrete: true });
const prose = new EditorView(document.getElementById('prosemirror'), {
  state: EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('old prose')])]) }),
  attributes: { 'aria-label': 'ProseMirror fixture' },
});

self.MonacoEnvironment = { getWorker: () => new Worker(new URL('./editor.worker.js',import.meta.url), { type: 'module' }) };
const code = monaco.editor.create(document.getElementById('monaco'), {
  value: 'old monaco', language: 'plaintext', automaticLayout: true,
  // This audit concerns the existing textarea clipboard fallback. Current
  // Monaco also supports EditContext; that distinct input path is not claimed.
  editContext: false, minimap: { enabled: false },
});
const secondary = monaco.editor.create(document.getElementById('monaco-secondary'), {
  value:'independent secondary model',language:'plaintext',automaticLayout:true,
  editContext:false,minimap:{enabled:false},
});
window.fixture.language = name => monaco.editor.setModelLanguage(code.getModel(), name);
window.fixture.read = name => {
  if (name === 'lexical') return lexical.getEditorState().read(() => $getRoot().getTextContent());
  if (name === 'prosemirror') return prose.state.doc.textBetween(0, prose.state.doc.content.size, '\n');
  if (name === 'monaco') return code.getValue();
  if (name === 'monaco-secondary') return secondary.getValue();
  throw Error('unknown fixture');
};
const bounded = (promise, step) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('clipboard timeout: '+step)), 5000))]);
const clipboardBytes = async items => Promise.all(items.map(async item =>
  Promise.all([...item.types].sort().map(async type => [type, [...new Uint8Array(await bounded((await bounded(item.getType(type), 'getType '+type)).arrayBuffer(), 'bytes '+type))]]))));
window.fixture.clipboard = async () => clipboardBytes(await bounded(navigator.clipboard.read(), 'read'));
window.fixture.clipboardControl = async () => {
  const old = await bounded(navigator.clipboard.read(), 'control read');
  const before = await clipboardBytes(old);
  await bounded(navigator.clipboard.writeText('clipboard control temporary'), 'control stage');
  const oldAfterWrite = await clipboardBytes(old);
  await bounded(navigator.clipboard.write(old), 'control restore');
  return {before, oldAfterWrite, after: await window.fixture.clipboard()};
};
// Record the real package's Clipboard API calls separately from DOM events.
window.fixture.clipboardCalls = [];
const editorInput=document.querySelector('#monaco textarea.inputarea');
const originalFocus=editorInput.focus;
window.fixture.armFault = kind => {window.fixture.fault={kind,stages:0,fired:false};};
window.fixture.disarmFault = () => {editorInput.focus=originalFocus;window.fixture.fault=null;};
for (const name of ['read','write','readText','writeText']) {
  const original = navigator.clipboard[name].bind(navigator.clipboard);
  navigator.clipboard[name] = async (...args) => {
    const record = {name, started: performance.now(), stack: new Error().stack};
    window.fixture.clipboardCalls.push(record);
    const fault=window.fixture.fault;
    if(fault&&((name==='read'&&fault.kind==='backup')||(name==='write'&&fault.kind==='restore'&&fault.stages))) {
      fault.fired=true;throw Error('fixture '+fault.kind+' rejected');
    }
    try { const result = await original(...args); record.finished=performance.now();
      if(name === 'read') record.types=result.map(item=>[...item.types]);
      if(name==='writeText'&&fault) {
        fault.stages++;
        if(fault.kind==='focus') editorInput.focus=()=>{fault.fired=true;throw Error('fixture focus rejected');};
      }
      return result;
    } catch(error) { record.error=String(error); throw error; }
  };
}
document.addEventListener('copy', event => {
  if (!event.target.closest('#monaco')) return;
  const record = {type:'copy',phase:'bubble',trusted:event.isTrusted,formats:[...event.clipboardData.types].map(type=>[type,event.clipboardData.getData(type)])};
  events.push({editor:'monaco',...record});
});
window.fixture.ready = true;

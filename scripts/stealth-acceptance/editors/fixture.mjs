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
for (const type of ['beforeinput','input','change','focusout','paste','copy']) {
  document.addEventListener(type, event => {
    const container = event.target.closest('#lexical,#prosemirror,#monaco');
    if (!container) return;
    const record = { editor: container.id, type, trusted: event.isTrusted,
      formats: event.clipboardData ? [...event.clipboardData.types] : [] };
    if (type === 'paste' || type === 'copy') record.exposedState = [...document.querySelectorAll('#monaco,#monaco *')]
      .flatMap(node => Object.getOwnPropertyNames(node).filter(name => name.startsWith('__chromeUseMonaco')));
    queueMicrotask(() => { record.prevented = event.defaultPrevented; events.push(record); });
  }, !['paste','copy'].includes(type));
}

const lexical = createEditor({ namespace: 'stealth-fixture', onError: error => errors.push(String(error)) });
lexical.setRootElement(document.getElementById('lexical'));
registerPlainText(lexical);
lexical.update(() => $getRoot().append($createParagraphNode().append($createTextNode('old lexical'))), { discrete: true });
const prose = new EditorView(document.getElementById('prosemirror'), {
  state: EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('old prose')])]) }),
  attributes: { 'aria-label': 'ProseMirror fixture' },
});

self.MonacoEnvironment = { getWorker: () => new Worker('/editors/editor.worker.js', { type: 'module' }) };
const code = monaco.editor.create(document.getElementById('monaco'), {
  value: 'old monaco', language: 'plaintext', automaticLayout: true,
  // This audit concerns the existing textarea clipboard fallback. Current
  // Monaco also supports EditContext; that distinct input path is not claimed.
  editContext: false, minimap: { enabled: false },
});
window.fixture.read = name => {
  if (name === 'lexical') return lexical.getEditorState().read(() => $getRoot().getTextContent());
  if (name === 'prosemirror') return prose.state.doc.textBetween(0, prose.state.doc.content.size, '\n');
  if (name === 'monaco') return code.getValue();
  throw Error('unknown fixture');
};
window.fixture.clipboard = async () => Promise.all((await navigator.clipboard.read()).map(async item =>
  Promise.all([...item.types].sort().map(async type => [type, [...new Uint8Array(await (await item.getType(type)).arrayBuffer())]]))));
window.fixture.ready = true;

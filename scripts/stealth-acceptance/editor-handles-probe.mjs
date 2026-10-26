// Research-only CDP inspection on the owned editor fixture. Never evaluates
// getters, runs editor methods, or changes the system clipboard.
export async function inspectEditorHandles(send) {
  const group='editor-handle-probe';
  const records=[],candidates=[],queue=[],seen=new Set();
  const push=(value,route)=>{if(value?.objectId&&!seen.has(value.objectId)){seen.add(value.objectId);queue.push({value,route});}};
  try {
    const input=await send('Runtime.evaluate',{expression:'document.querySelector("#monaco textarea.inputarea")',objectGroup:group});
    const listeners=await send('DOMDebugger.getEventListeners',{objectId:input.result.objectId});
    for(const listener of listeners.listeners) {
      if(['input','copy','keydown'].includes(listener.type))push(listener.originalHandler||listener.handler,`listener:${listener.type}`);
    }
    for(let count=0;queue.length&&count<160;count++) {
      const {value,route}=queue.shift();
      const properties=await send('Runtime.getProperties',{objectId:value.objectId,ownProperties:true});
      const names=(properties.result||[]).map(p=>p.name);
      records.push({route,type:value.type,className:value.className,description:value.description?.slice(0,100),names,internals:(properties.internalProperties||[]).map(p=>p.name)});
      if(names.includes('_buffer')||names.includes('_modelData')||names.includes('_knownModel'))candidates.push({route,names,description:value.description});
      for(const p of properties.internalProperties||[]) {
        if(['[[Scopes]]','[[BoundThis]]','[[TargetFunction]]'].includes(p.name))push(p.value,route+'/'+p.name);
      }
      for(const p of properties.result||[]) {
        if(/^(?:\d+|this|_this\d*|listener|fn|callback|_host|_context|viewModel|model|_model|_modelData|_editor|editor|_textAreaInput|_view|_knownModel)$/.test(p.name))push(p.value,route+'/'+p.name);
      }
    }
    return {records,candidates,truncated:queue.length>0};
  } finally {await send('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});}
}

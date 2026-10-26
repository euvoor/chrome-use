// Research-only CDP inspection on the owned editor fixture. Discovery reads
// property descriptors without getters; optional exercise validates the found
// API with read-only model methods and native input, without copy/paste.
export async function inspectEditorHandles(send, exercise, selector='#monaco textarea.inputarea') {
  const group='editor-handle-probe';
  const records=[],candidates=[],queue=[],seen=new Set();
  let apiHandle;
  const push=(value,route)=>{if(value?.objectId&&!seen.has(value.objectId)){seen.add(value.objectId);queue.push({value,route});}};
  try {
    const input=await send('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)})`,objectGroup:group});
    const listeners=await send('DOMDebugger.getEventListeners',{objectId:input.result.objectId});
    for(const listener of listeners.listeners) {
      if(['input','copy','keydown'].includes(listener.type))push(listener.originalHandler||listener.handler,`listener:${listener.type}`);
    }
    for(let count=0;queue.length&&count<160;count++) {
      const {value,route}=queue.shift();
      const properties=await send('Runtime.getProperties',{objectId:value.objectId,ownProperties:true,generatePreview:true});
      const names=(properties.result||[]).map(p=>p.name);
      // A V8 scope mirror lists bindings but is not the actual namespace
      // object. Only invoke the namespace reached through a binding's value.
      if(!/\[\[Scopes\]\]\/\d+$/.test(route)&&names.includes('getEditors')&&names.includes('getModels'))apiHandle??=value.objectId;
      records.push({route,type:value.type,className:value.className,description:value.description?.slice(0,100),names,internals:(properties.internalProperties||[]).map(p=>p.name)});
      if(names.includes('_buffer')||names.includes('_modelData')||names.includes('_knownModel'))candidates.push({route,names,description:value.description});
      for(const p of properties.internalProperties||[]) {
        if(['[[Scopes]]','[[BoundThis]]','[[TargetFunction]]'].includes(p.name))push(p.value,route+'/'+p.name);
      }
      for(const p of properties.result||[]) {
        // Property names on an exported API survive ordinary minification;
        // the local variable naming that namespace does not. A native preview
        // lets us prioritize it without evaluating scope getters or all values.
        if(p.value?.preview?.properties?.some(property=>property.name==='getEditors'))push(p.value,route+'/'+p.name);
        if(/^(?:\d+|this|_this\d*|listener|fn|callback|_host|_context|viewModel|model|_model|_modelData|_editor|editor|_textAreaInput|_view|_knownModel)$/.test(p.name))push(p.value,route+'/'+p.name);
      }
    }
    let modelProbe=null;
    if(apiHandle&&exercise) {
      try {modelProbe=await exercise(apiHandle,input.result.objectId);}
      catch(error){modelProbe={error:error.stack};}
    }
    return {records,candidates,truncated:queue.length>0,modelProbe};
  } finally {await send('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});}
}

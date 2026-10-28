export function toolRequest(job){
  const tools=job.tool_choice==='none'?[]:job.tools??[];
  if(!tools.length)return {messages:job.messages,max_tokens:job.maxTokens,stream:true,stream_options:{include_usage:true},extra_body:{enable_thinking:false}};
  if(tools.length>128||tools.some(tool=>tool.type!=='function'||!tool.function?.name||!tool.function.parameters))throw new Error('Invalid browser tool definitions');
  const system=job.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n\n');
  const messages=[{role:'system',content:system+'\nYou are an assistant with tools. Return a JSON object. To call tools use {"type":"tool_calls","calls":[{"name":"tool_name","arguments":{}}]}. To answer use {"type":"message","content":"your answer"}. Do not claim a tool ran before receiving its result. Available tools:\n'+JSON.stringify(tools.map(tool=>tool.function))}];
  for(const message of job.messages){if(message.role==='system')continue;
    if(message.role==='tool')messages.push({role:'user',content:'Tool result for '+message.tool_call_id+':\n'+message.content});
    else if(message.tool_calls?.length)messages.push({role:'assistant',content:JSON.stringify({type:'tool_calls',calls:message.tool_calls.map(call=>({name:call.function.name,arguments:JSON.parse(call.function.arguments)}))})});
    else messages.push({role:message.role,content:message.content});
  }
  const schema={anyOf:[{type:'object',properties:{type:{const:'message'},content:{type:'string'}},required:['type','content'],additionalProperties:false},{type:'object',properties:{type:{const:'tool_calls'},calls:{type:'array',minItems:1,maxItems:8,items:{anyOf:tools.map(tool=>({type:'object',properties:{name:{const:tool.function.name},arguments:tool.function.parameters},required:['name','arguments'],additionalProperties:false}))}}},required:['type','calls'],additionalProperties:false}]};
  return {messages,max_tokens:job.maxTokens,stream:true,stream_options:{include_usage:true},response_format:{type:'json_object',schema:JSON.stringify(schema)},extra_body:{enable_thinking:false}};
}
export async function* browserInference(engine,job){
  const request=toolRequest(job),structured=Boolean(request.response_format);let text='',usage,finishReason='stop';
  const stream=await engine.chat.completions.create(request);
  for await(const chunk of stream){const choice=chunk.choices?.[0];if(choice?.delta?.content){if(structured){text+=choice.delta.content;if(text.length>131072)throw new Error('Browser tool response too large');}else yield {type:'delta',text:choice.delta.content};}if(choice?.finish_reason)finishReason=choice.finish_reason;if(chunk.usage)usage=chunk.usage;}
  if(!usage||!Number.isSafeInteger(usage.prompt_tokens)||!Number.isSafeInteger(usage.completion_tokens))throw new Error('Inference did not provide metered usage');
  if(structured){let result;try{result=JSON.parse(text);}catch{throw new Error('Browser tool output was incomplete. Use a larger output budget or a more capable worker.');}
    if(result.type==='message'&&typeof result.content==='string'){yield {type:'delta',text:result.content};}
    else if(result.type==='tool_calls'&&Array.isArray(result.calls)&&result.calls.length>0&&result.calls.length<=8){
      const allowed=new Set(job.tools.map(tool=>tool.function.name));const calls=result.calls.map((call,index)=>{if(!allowed.has(call.name)||!call.arguments||typeof call.arguments!=='object'||Array.isArray(call.arguments))throw new Error('Browser returned an invalid tool call');return {index,id:'call_'+crypto.randomUUID(),type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}};});
      yield {type:'tool_calls',calls};finishReason='tool_calls';
    }else throw new Error('Browser returned an invalid tool response');
  }
  yield {type:'done',promptTokens:usage.prompt_tokens,tokens:usage.completion_tokens,finishReason};
}
export async function probeBrowserTools(engine){
  try{let supported=false;for await(const part of browserInference(engine,{messages:[{role:'user',content:'Call ping with value hello. Do not answer with a message.'}],tools:[{type:'function',function:{name:'ping',description:'Return a ping',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}}],maxTokens:96}))if(part.type==='tool_calls')supported=part.calls[0]?.function.name==='ping'&&JSON.parse(part.calls[0].function.arguments).value==='hello';return supported;}catch{return false;}
}

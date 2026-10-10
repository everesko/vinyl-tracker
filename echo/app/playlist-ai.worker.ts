import {CreateMLCEngine,hasModelInCache,deleteModelAllInfoInCache,type MLCEngine} from '@mlc-ai/web-llm';
let engine:MLCEngine|undefined;
const variants={fast:['Qwen3-1.7B-q4f16_1-MLC','Qwen3-1.7B-q4f32_1-MLC'],balanced:['Qwen3-4B-q4f16_1-MLC','Qwen3-4B-q4f32_1-MLC']};
const allModels=Object.values(variants).flat();
const textSchema={type:'string',maxLength:250};
const planSchema={type:'object',additionalProperties:false,required:['title','criteria','artists','genres','language','years'],properties:{title:{type:'string',minLength:1,maxLength:100},criteria:{type:'array',minItems:1,maxItems:16,items:textSchema},artists:{type:'array',maxItems:100,items:{type:'string',maxLength:100}},genres:{type:'array',maxItems:16,items:{type:'string',enum:['rock','classic-rock','indie-rock','pop-punk','synth-pop','alternative','pop','metal','hiphop','dance','rnb','punk','country','jazz']}},language:{anyOf:[{type:'null'},{type:'string',maxLength:80}]},years:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['from','to'],properties:{from:{type:'integer',minimum:1900,maximum:2100},to:{type:'integer',minimum:1900,maximum:2100}}}]}}};
const trackSchema={type:'object',additionalProperties:false,required:['artist','title'],properties:{artist:{type:'string',minLength:1,maxLength:150},title:{type:'string',minLength:1,maxLength:200}}};
const schemas:Record<string,unknown>={planning:planSchema,searching:{type:'object',additionalProperties:false,required:['queries'],properties:{queries:{type:'array',maxItems:8,items:{type:'string',minLength:1,maxLength:150}}}},suggesting:{type:'object',additionalProperties:false,required:['tracks'],properties:{tracks:{type:'array',maxItems:64,items:trackSchema}}},reviewing:{type:'object',additionalProperties:false,required:['accepted'],properties:{accepted:{type:'array',maxItems:64,items:{type:'integer',minimum:0,maximum:63}}}}};
const adapter=()=> (navigator as Navigator&{gpu?:{requestAdapter:()=>Promise<{features:Set<string>}|null>}}).gpu?.requestAdapter();
const errorCode=(error:unknown)=>{const message=error instanceof Error?error.message:String(error);return /WebGPU unavailable/i.test(message)?'gpu':/quota|indexeddb|storage|cache.*(?:denied|failed)/i.test(message)?'storage':/out.of.memory|allocation|buffer.*(?:size|limit)|device.lost/i.test(message)?'memory':/fetch|network|download|HTTP|Failed to load/i.test(message)?'download':'failed';};
async function initialize(id:number,models:string[]){
 if(engine)return;const gpu=await adapter();if(!gpu)throw new Error('WebGPU unavailable');
 engine=await CreateMLCEngine(models[gpu.features.has('shader-f16')?0:1],{initProgressCallback:report=>self.postMessage({id,type:'load',progress:report.progress,stage:report.progress>=1||/shader|compil|initializ/i.test(report.text)?'preparing':'downloading'})});
}
let queue=Promise.resolve();
self.onmessage=(event:MessageEvent)=>{const {id,action,messages,model,purpose,limit}=event.data,models=variants[model==='balanced'?'balanced':'fast'];queue=queue.then(async()=>{
 try{
  if(action==='status'){self.postMessage({id,type:'result',value:{supported:!!await adapter(),cached:(await Promise.all(models.map(model=>hasModelInCache(model)))).some(Boolean)}});return;}
  if(action==='delete'){await engine?.unload();engine=undefined;for(const model of allModels)await deleteModelAllInfoInCache(model);if((await Promise.all(allModels.map(model=>hasModelInCache(model)))).some(Boolean))throw new Error('Storage cleanup failed');self.postMessage({id,type:'result',value:true});return;}
  if(action!=='init'&&action!=='generate')throw new Error('Unknown command');
  await initialize(id,models);
  if(action==='init'){self.postMessage({id,type:'result',value:true});return;}
  await engine!.resetChat();
  self.postMessage({id,type:'thinking'});
  const stream=await engine!.chat.completions.create({messages,temperature:.1,max_tokens:purpose==='playlist'?Math.min(8192,512+(limit??20)*80):purpose==='planning'?768:purpose==='reviewing'?512:purpose==='suggesting'?Math.min(8192,256+(limit??16)*80):1500,...(purpose==='playlist'?{}:{response_format:{type:'json_object',...(schemas[purpose]?{schema:JSON.stringify(schemas[purpose])}:{})}}),extra_body:{enable_thinking:false},stream:true});
  let value='',tokens=0;
  for await(const chunk of stream){value+=chunk.choices[0]?.delta.content??'';if(++tokens%20===0)self.postMessage({id,type:'generating',tokens});let complete=false;const visible=value.replace(/<think>[\s\S]*?<\/think>/gi,'');if(purpose==='playlist'){complete=visible.split(/\r?\n/).slice(0,-1).filter(row=>/^\s*(?:\d+[.)]\s*)?[^:\n]+:\s*\S.+/.test(row)).length>=(limit??20);}else try{const parsed=JSON.parse(visible.trim());complete=!!parsed&&typeof parsed==='object'&&!Array.isArray(parsed);}catch{/* Wait until the complete JSON object arrives. */}if(complete){await engine!.interruptGenerate();break;}}
  self.postMessage({id,type:'result',value});
 }catch(error){console.error('ECHO local AI operation failed',error);self.postMessage({id,type:'error',code:errorCode(error)});}
});};

// Run against the LOCAL Wrangler production server after npm run build.
// Real rendered app -> real runtime -> real native Worker -> real status response.
// API fixtures isolate this transport regression from account/DB credentials.
// This does not download model weights or pretend to test model inference.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ECHO_PLAYWRIGHT_PATH||'C:/Users/Danil/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin=new URL(process.env.ECHO_PRODUCTION_URL||process.argv[2]||'http://127.0.0.1:8787').origin;
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname),'This regression test only targets a local server.');
const browser=await chromium.launch({headless:true,executablePath:process.env.ECHO_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
const page=await context.newPage(),nativeWorkers=[],pageErrors=[];
page.setDefaultTimeout(30000);
page.on('worker',worker=>nativeWorkers.push(worker.url()));
page.on('pageerror',error=>pageErrors.push(error.message));
const profile={profile:{displayName:'Worker transport test',xp:0,games:0,correct:0,total:0,bestScore:0},progression:{practice:true,unlocks:{},resetAvailableAt:0},sessions:[],history:[]};
await context.route(origin+'/api/profile',route=>route.fulfill({status:200,json:profile}));
await context.route(origin+'/api/catalog',route=>route.fulfill({status:200,json:{collections:[]}}));
// Transparent constructor instrumentation: Reflect.construct calls the REAL
// browser Worker. No synthetic events, Worker replacement, or worker URL selection.
await page.addInitScript(()=>{
 const trace={constructed:[],posts:[],messages:[],errors:[]};
 Object.defineProperty(window,'__echoWorkerTrace',{value:trace});
 const NativeWorker=window.Worker;
 window.Worker=new Proxy(NativeWorker,{construct(target,args){
  const supplied=String(args[0]);
  trace.constructed.push({supplied,resolved:new URL(supplied,location.href).href,type:args[1]?.type??null});
  try{
   const real=Reflect.construct(target,args);
   real.addEventListener('message',event=>{
    const data=event.data;
    // Record status/progress only; no prompts, generated text, keys, or account data.
    trace.messages.push({id:data?.id,type:data?.type,code:data?.code,value:data?.value&&typeof data.value==='object'?{supported:data.value.supported,cached:data.value.cached}:null});
   });
   real.addEventListener('error',event=>trace.errors.push(event.message||'Native Worker error'));
   const post=real.postMessage;
   real.postMessage=function(data,...other){trace.posts.push({id:data?.id,action:data?.action});return post.call(this,data,...other);};
   return real;
  }catch(error){trace.errors.push(String(error));throw error;}
 }});
 localStorage.removeItem('echo-ai-auto-load');
});
let evidence;
try{
 const response=await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:45000});
 assert.equal(response.status(),200,'Local production app must return 200.');
 const html=await response.text();
 assert.ok(!html.includes('/@vite/client')&&!html.includes('/@react-refresh'),'Dev-mode page cannot exercise this regression.');
 assert.match(html,/_next\/static\/chunks\//,'Expected actual production client chunks in rendered HTML.');
 await page.waitForFunction(()=>window.__echoWorkerTrace.constructed.length>0,undefined,{timeout:15000});
 evidence=await page.evaluate(()=>window.__echoWorkerTrace);
 const launched=evidence.constructed.find(item=>item.supplied.includes('playlist-ai'))||evidence.constructed[0];
 const workerURL=new URL(launched.resolved);
 assert.ok(['http:','https:'].includes(workerURL.protocol),'Runtime launched a non-HTTP Worker: '+launched.resolved);
 assert.equal(workerURL.origin,origin,'Worker must load from the application origin.');
 assert.match(workerURL.pathname,/\/_next\/static\/.*\.js$/,'Must launch a built JS worker, not a TS dev source.');
 assert.equal(launched.type,'module');
 await page.waitForFunction(()=>{
  const trace=window.__echoWorkerTrace;
  const command=trace.posts.find(item=>item.action==='status');
  return command&&trace.messages.some(item=>item.id===command.id&&item.type==='result'&&typeof item.value?.supported==='boolean'&&typeof item.value?.cached==='boolean');
 },undefined,{timeout:60000});
 evidence=await page.evaluate(()=>window.__echoWorkerTrace);
 assert.ok(nativeWorkers.includes(workerURL.href),'Playwright did not observe the real browser Worker.');
 const statusCommand=evidence.posts.find(item=>item.action==='status');
 const statusResult=evidence.messages.find(item=>item.id===statusCommand.id&&item.type==='result');
 assert.ok(!evidence.posts.some(item=>['init','generate','delete'].includes(item.action)),'This test must not download weights, generate, or mutate model cache.');
 // This fetch derives its URL from the actual runtime launch; it does not choose
 // or execute a worker manually. It verifies static hosting and response MIME.
 const workerResponse=await context.request.get(workerURL.href);
 assert.equal(workerResponse.status(),200,'Actual worker URL must be hosted in the production assets.');
 assert.match(workerResponse.headers()['content-type']||'',/(java|ecma)script/i,'Worker must not receive fallback HTML.');
 assert.ok(!(await workerResponse.text()).trimStart().startsWith('<'),'Worker URL returned HTML.');
 await page.locator('.account-settings').click();
 const expected=!statusResult.value.supported?'unsupported':statusResult.value.cached?'cached':'idle';
 await page.locator('.ai-settings .ai-state-'+expected).waitFor({state:'visible'});
 const label=await page.locator('.ai-settings .ai-state-'+expected).innerText();
 assert.ok(label.trim(),'Actual status response must reach the visible UI.');
 assert.equal(await page.locator('.ai-settings .ai-state-error').count(),0,'UI must not display the Worker-load failure.');
 assert.deepEqual(evidence.errors,[],'Unexpected native Worker errors.');
 assert.deepEqual(pageErrors,[],'Unexpected application runtime errors.');
 console.log(JSON.stringify({result:'PASS',app:origin,worker:workerURL.href,nativeWorkerObserved:true,command:'status',uiStatus:expected,label,productionAssets:true},null,2));
}catch(error){
 evidence=await page.evaluate(()=>window.__echoWorkerTrace).catch(()=>evidence);
 console.error(JSON.stringify({result:'FAIL',app:origin,workerTrace:evidence,nativeWorkers,pageErrors},null,2));
 throw error;
}finally{await browser.close();}

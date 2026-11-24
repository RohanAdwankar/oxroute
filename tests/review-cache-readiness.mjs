// Persistent storage contention must not block available review content.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {chromium,webkit} from 'playwright';
const script=ts.transpileModule(await readFile(new URL('../app/lib/reviews.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const browser=await(process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch(process.env.WEBKIT_EXECUTABLE?{executablePath:process.env.WEBKIT_EXECUTABLE}:{});
try{
 const page=await browser.newPage();
 await page.route('**/cache-check',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Cache readiness check</title>'}));
 await page.route('**/cache-module.js',r=>r.fulfill({contentType:'text/javascript',body:script}));
 await page.route('**/cache-image*',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"/>'}));
 await page.goto(`${process.env.TEST_URL||'http://127.0.0.1:3939'}/cache-check`);
 const results=await page.evaluate(async()=>{
  const api=await import('/cache-module.js');
  await api.loadReviewImage('/cache-image','high',true);
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('oxroute.reviews.v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const lock=mode=>{let held=true;const transaction=db.transaction('responses',mode),store=transaction.objectStore('responses');const loop=()=>{const request=store.get('hold');request.onsuccess=()=>{if(held)loop();};};loop();return()=>{held=false;};};
  const results=[];
  for(const mode of['readwrite','readonly']){
   const release=lock(mode),start=performance.now();
   try{
    const blob=await Promise.race([api.loadReviewImage('/cache-image?'+mode),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Cache contention hid available image bytes')),2500))]);
    results.push({mode,elapsed:performance.now()-start,bytes:blob.size});
   }finally{release();}
   await new Promise(done=>setTimeout(done,20));
  }
  const release=lock('readwrite'),fetch=window.fetch,start=performance.now();
  window.fetch=()=>Promise.reject(new TypeError('Network unavailable'));
  setTimeout(release,900);
  try{
   const blob=await api.loadReviewImage('/cache-image');
   results.push({mode:'offline recovery',elapsed:performance.now()-start,bytes:blob.size});
  }finally{release();window.fetch=fetch;}
  db.close();return results;
 });
 for(const result of results){assert.ok(result.bytes>0);assert.ok(result.elapsed<2000);}
 console.log('Real persistent read and write contention preserves available review media:',results);
}finally{await browser.close();}

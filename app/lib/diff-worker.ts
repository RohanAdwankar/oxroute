import {diffCode, type Line} from "./diff-highlighting";

self.addEventListener("message", (event: MessageEvent<{id:number;rows:Line[];path:string}>) => {
  const {id,rows,path}=event.data;
  try { (self as unknown as Worker).postMessage({id,code:diffCode(rows,path)}); }
  catch(error) { (self as unknown as Worker).postMessage({id,error:String(error)}); }
});

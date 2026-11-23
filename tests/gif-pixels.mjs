// Compare composed pixels with opaque source frames and independently decoded transparent patches.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import ts from 'typescript';
const fixtures=JSON.parse(execFileSync('uv',['run','--no-project','--with','pillow','python','-c',`
from PIL import Image,ImageDraw
import io,json,base64,hashlib
result=[]
for transparent in [True,False]:
 images=[]
 for x,color in [(0,'red'),(6,'green'),(12,'blue'),(18,'yellow')]:
  image=Image.new('RGBA' if transparent else 'RGB',(24,16),(0,0,0,0) if transparent else 'white')
  ImageDraw.Draw(image).rectangle((x,4,x+5,11),fill=color);images.append(image)
 data=io.BytesIO();images[0].save(data,format='GIF',save_all=True,append_images=images[1:],duration=[70,110,150,90],disposal=[1,2,3,1],loop=0,optimize=True)
 gif=Image.open(io.BytesIO(data.getvalue()));expected=[]
 for i in range(gif.n_frames):
  gif.seek(i);pixels=bytearray((gif if transparent else images[i]).convert('RGBA').tobytes())
  for offset in range(0,len(pixels),4):
   if pixels[offset+3]==0:pixels[offset:offset+3]=bytes(3)
  expected.append(hashlib.sha256(pixels).hexdigest())
 result.append({'bytes':base64.b64encode(data.getvalue()).decode(),'expected':expected})
print(json.dumps(result))
`],{encoding:'utf8'}));
await mkdir(new URL('../.tmp/',import.meta.url),{recursive:true});const module=new URL('../.tmp/gif-pixel-runtime.mjs',import.meta.url);
try{
 await writeFile(module,ts.transpileModule(await readFile(new URL('../app/lib/gif-playback.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
 const {GifPlayback}=await import(module.href);
 for(const [variant,fixture] of fixtures.entries()){const b=Buffer.from(fixture.bytes,'base64'),player=new GifPlayback(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));for(let i=0;i<fixture.expected.length;i++){player.draw(i?player.ends[i-1]:0,i===0);assert.equal(createHash('sha256').update(player.pixels).digest('hex'),fixture.expected[i],`Variant ${variant} composed frame ${i} retains transparency, background and disposal`);}}
 console.log('Opaque and transparent GIF patches, background restoration and restore-previous disposal match reference pixels.');
}finally{await rm(module,{force:true});}

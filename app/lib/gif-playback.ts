import {parseGIF,decompressFrame,type ParsedGif,type ParsedFrame} from 'gifuct-js';

type Frame=Extract<ParsedGif['frames'][number],{image:unknown}>;
export class GifPlayback {
  readonly gif:ParsedGif;
  readonly frames:Frame[];
  readonly ends:number[]=[];
  readonly pixels:Uint8ClampedArray;
  private index=-1;
  private previous?:Pick<ParsedFrame,'dims'|'disposalType'>;
  private restore?:Uint8ClampedArray;
  constructor(bytes:ArrayBuffer){
    this.gif=parseGIF(bytes);
    this.frames=this.gif.frames.filter((frame):frame is Frame=>'image' in frame);
    if(!this.frames.length)throw new Error('GIF has no image frames');
    for(const frame of this.frames)this.ends.push((this.ends.at(-1)??0)+(frame.gce?.delay||10)*10);
    this.pixels=new Uint8ClampedArray(this.gif.lsd.width*this.gif.lsd.height*4);this.clear();
  }
  private clear(left=0,top=0,width=this.gif.lsd.width,height=this.gif.lsd.height){
    const background=this.frames[0].gce?.extras.transparentColorGiven?undefined:this.gif.gct?.[this.gif.lsd.backgroundColorIndex];
    for(let y=top;y<top+height;y++){
      const start=(y*this.gif.lsd.width+left)*4,end=start+width*4;
      if(!background)this.pixels.fill(0,start,end);
      else for(let at=start;at<end;at+=4){this.pixels[at]=background[0];this.pixels[at+1]=background[1];this.pixels[at+2]=background[2];this.pixels[at+3]=255;}
    }
  }
  get duration(){return this.ends.at(-1)!;}
  draw(time:number,reset:boolean){
    if(reset){this.index=-1;this.previous=undefined;this.restore=undefined;this.clear();}
    let changed=false;
    while(this.index+1<this.frames.length&&(this.index<0||time>=this.ends[this.index])){
      if(this.previous?.disposalType===2){
        const {left,top,width,height}=this.previous.dims;
        this.clear(left,top,width,height);
      }else if(this.previous?.disposalType===3&&this.restore)this.pixels.set(this.restore);
      const frame=decompressFrame(this.frames[++this.index],this.gif.gct,true);
      this.restore=frame.disposalType===3?this.pixels.slice():undefined;
      const {left,top,width,height}=frame.dims;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const source=(y*width+x)*4,target=((top+y)*this.gif.lsd.width+left+x)*4;
        if(frame.patch[source+3]){this.pixels[target]=frame.patch[source];this.pixels[target+1]=frame.patch[source+1];this.pixels[target+2]=frame.patch[source+2];this.pixels[target+3]=255;}
      }
      this.previous={dims:frame.dims,disposalType:frame.disposalType};changed=true;
    }
    return{changed,next:this.ends[this.index]};
  }
}

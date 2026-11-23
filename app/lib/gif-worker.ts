import {GifPlayback} from './gif-playback';
let players:GifPlayback[]=[],cycle=-1;
self.onmessage=(event:MessageEvent<{buffers?:ArrayBuffer[];time?:number;replay?:boolean;token?:number}>)=>{
  try{
    if(event.data.buffers)players=event.data.buffers.map(bytes=>new GifPlayback(bytes));
    const time=event.data.time??0,duration=Math.max(...players.map(player=>player.duration));
    const current=Math.floor(time/duration),phase=time%duration,reset=current!==cycle||!!event.data.replay;
    cycle=current;
    let next=(current+1)*duration;
    const sides=players.flatMap((player,side)=>{
      const frame=player.draw(phase,reset);
      if(frame.next>phase)next=Math.min(next,current*duration+frame.next);
      return frame.changed?[{side,width:player.gif.lsd.width,height:player.gif.lsd.height,pixels:player.pixels.slice().buffer}]:[];
    });
    self.postMessage({sides,next,token:event.data.token??0,replay:event.data.replay},{transfer:sides.map(side=>side.pixels)});
  }catch(error){self.postMessage({token:event.data.token??0,error:error instanceof Error?error.message:String(error)});}
};

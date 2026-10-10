'use client';
import {useEffect,useRef} from 'react';

type Player={loadVideoById:(value:{videoId:string;startSeconds:number;endSeconds:number})=>void;playVideo:()=>void;pauseVideo:()=>void;setVolume:(volume:number)=>void;getCurrentTime:()=>number;destroy:()=>void};
type Youtube={Player:new(element:HTMLElement,options:Record<string,unknown>)=>Player};
let api:Promise<Youtube>|undefined;
function loadYoutube(){
 if(api)return api;
 api=new Promise((resolve,reject)=>{
  const check=()=>{const yt=(window as unknown as {YT?:Youtube}).YT;if(yt?.Player){clearInterval(interval);clearTimeout(timeout);resolve(yt);}};
  const interval=window.setInterval(check,100),timeout=window.setTimeout(()=>{clearInterval(interval);api=undefined;reject(new Error('Video player timeout'));},12000);
  if(!document.querySelector('script[data-echo-youtube]')){const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.dataset.echoYoutube='true';script.onerror=()=>{script.remove();clearInterval(interval);clearTimeout(timeout);api=undefined;reject(new Error('Video player unavailable'));};document.head.appendChild(script);}
  check();
 });return api;
}
export default function MusicVideo({id,start,volume,playToken,onStarted,onPaused,onFinished,onError,onControl}:{id:string;start:number;volume:number;playToken:number;onStarted:()=>void;onPaused:()=>void;onFinished:()=>void;onError:()=>void;onControl:(stop:(()=>void)|null)=>void}){
 const host=useRef<HTMLDivElement>(null),player=useRef<Player|null>(null),latest=useRef({volume,onStarted,onPaused,onFinished,onError,onControl}),ready=useRef(false),lastToken=useRef(playToken);
 useEffect(()=>{latest.current={volume,onStarted,onPaused,onFinished,onError,onControl};},[volume,onStarted,onPaused,onFinished,onError,onControl]);
 useEffect(()=>{
  let cancelled=false,finished=false,timer:number|undefined,attempt=0,loadingTimer:number|undefined;
  const stop=()=>{clearInterval(timer);clearTimeout(loadingTimer);player.current?.pauseVideo();};
  const finish=()=>{if(finished||cancelled)return;finished=true;stop();latest.current.onFinished();};
  const fail=(reason?:unknown)=>{if(cancelled)return;const code=reason&&typeof reason==='object'&&'data' in reason?reason.data:reason instanceof Error?reason.message:'timeout';console.warn('ECHO music video unavailable:',code);stop();if(attempt===0){attempt++;player.current?.destroy();player.current=null;ready.current=false;void mountPlayer();return;}latest.current.onError();};
  const mountPlayer=async()=>{try{const yt=await loadYoutube();
   if(cancelled)return;
   const mount=document.createElement('iframe');mount.title='Music video';mount.referrerPolicy='strict-origin-when-cross-origin';mount.allow='autoplay; encrypted-media; picture-in-picture';mount.width='100%';mount.height='100%';
   const parameters=new URLSearchParams({enablejsapi:'1',autoplay:'0',controls:'0',disablekb:'1',playsinline:'1',rel:'0',start:String(start),end:String(start+10),origin:location.origin});
   mount.src=`https://${attempt?'www.youtube.com':'www.youtube-nocookie.com'}/embed/${id}?${parameters}`;host.current?.replaceChildren(mount);loadingTimer=window.setTimeout(fail,18000);
   player.current=new yt.Player(mount,{events:{
    onReady:()=>{if(cancelled)return;ready.current=true;player.current?.setVolume(latest.current.volume*100);player.current?.loadVideoById({videoId:id,startSeconds:start,endSeconds:start+10});latest.current.onControl(stop);},
    onStateChange:(event:{data:number})=>{if(cancelled)return;if(event.data===1){clearTimeout(loadingTimer);finished=false;latest.current.onStarted();clearInterval(timer);timer=window.setInterval(()=>{if((player.current?.getCurrentTime()??0)>=start+9.95)finish();},100);}if(event.data===0)finish();if(event.data===2&&!finished)latest.current.onPaused();},
    onError:fail,
    onAutoplayBlocked:()=>{clearTimeout(loadingTimer);latest.current.onPaused();},
   }});
  }catch(error){fail(error)}};void mountPlayer();
  return()=>{cancelled=true;clearInterval(timer);clearTimeout(loadingTimer);latest.current.onControl(null);player.current?.destroy();player.current=null;ready.current=false;};
 },[id,start]);
 useEffect(()=>{player.current?.setVolume(volume*100);},[volume]);
 useEffect(()=>{if(lastToken.current===playToken)return;lastToken.current=playToken;if(ready.current)player.current?.loadVideoById({videoId:id,startSeconds:start,endSeconds:start+10});},[playToken,id,start]);
 return <div className="reveal-youtube" ref={host}/>;
}

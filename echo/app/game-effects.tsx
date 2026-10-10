'use client';
import {useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {Zap} from 'lucide-react';
import {useI18n} from '@/lib/i18n';

type Flight={x:number;y:number;dx:number;dy:number};
/** Visual only: the durable server ledger has already settled, the parent refreshes at arrival. */
export function BalanceFlight({amount,onArrive}:{amount:number;onArrive:()=>void}){
 const {locale}=useI18n();
 const [flight,setFlight]=useState<Flight|null>(null);
 useEffect(()=>{
  let frame=0,clock:number|undefined;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  frame=requestAnimationFrame(()=>{
   const source=document.querySelector('[data-reward-anchor]')?.getBoundingClientRect();
   const target=document.getElementById('profile-wallet')?.getBoundingClientRect();
   if(!source||!target||reduced||amount===0){onArrive();return;}
   const x=source.x+source.width/2,y=source.y+source.height/2;
   setFlight({x,y,dx:target.x+target.width/2-x,dy:target.y+target.height/2-y});
   document.body.dataset.walletTransfer='true';
   clock=window.setTimeout(()=>{delete document.body.dataset.walletTransfer;setFlight(null);onArrive()},1900);
  });
  return()=>{cancelAnimationFrame(frame);clearTimeout(clock);delete document.body.dataset.walletTransfer};
 },[amount,onArrive]);
 if(!flight)return null;
 return createPortal(<div className={`balance-flight ${amount<0?'negative':''}`} aria-hidden="true">{Array.from({length:16},(_,i)=><span key={i} className="flying-credit" style={{left:flight.x,top:flight.y,'--dx':`${flight.dx}px`,'--dy':`${flight.dy}px`,'--scatter':`${(i%5-2)*20}px`,animationDelay:`${i*45}ms`} as React.CSSProperties}><Zap size={17}/></span>)}<strong className="flying-total" style={{left:flight.x,top:flight.y,'--dx':`${flight.dx}px`,'--dy':`${flight.dy}px`} as React.CSSProperties}>{amount>0?'+':''}{new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(amount)} XP</strong></div>,document.body);
}

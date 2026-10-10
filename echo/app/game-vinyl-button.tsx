'use client';

import {useEffect,useRef,useState} from 'react';
import {Check,Disc3,Loader2,Plus} from 'lucide-react';
import {useI18n} from '@/lib/i18n';

const copy={
 uk:{add:'Додати альбом',checking:'Перевіряємо вініл…',added:'Альбом додано',exists:'Уже в каталозі',connect:'Підключіть Discogs у вкладці «Вініл».',unconfirmed:'Вінілове видання цього альбому не підтверджено.',unavailable:'Каталог тимчасово недоступний. Повторіть спробу.',open:'Відкрити вініл',timeout:'Перевірка триває довше. Спробуйте ще раз.',unsupported:'Для цього запису немає підтверджених даних про альбом.'},
 en:{add:'Add album',checking:'Checking vinyl…',added:'Album added',exists:'Already in your catalog',connect:'Connect Discogs in the Vinyl tab.',unconfirmed:'A vinyl edition of this album could not be confirmed.',unavailable:'The catalog is temporarily unavailable. Try again.',open:'Open vinyl',timeout:'Verification is taking longer. Please retry.',unsupported:'Verified album metadata is unavailable for this recording.'},
 ru:{add:'Добавить альбом',checking:'Проверяем винил…',added:'Альбом добавлен',exists:'Уже в каталоге',connect:'Подключите Discogs во вкладке «Винил».',unconfirmed:'Виниловое издание этого альбома не подтверждено.',unavailable:'Каталог временно недоступен. Повторите попытку.',open:'Открыть винил',timeout:'Проверка занимает больше времени. Попробуйте ещё раз.',unsupported:'Для этой записи нет подтверждённых данных об альбоме.'}
};

export default function GameVinylButton({gameId,round}:{gameId:string;round:number}){
 const {locale}=useI18n(),c=copy[locale];
 const [status,setStatus]=useState<'idle'|'checking'|'added'|'exists'|'error'>('idle');
 const [detail,setDetail]=useState(''),[connection,setConnection]=useState(false);
 const request=useRef<AbortController|null>(null),key=useRef(`${gameId}:${round}`);
 useEffect(()=>{key.current=`${gameId}:${round}`;request.current?.abort();setStatus('idle');setDetail('');setConnection(false);return()=>{key.current='';request.current?.abort()}},[gameId,round]);
 const add=async()=>{
  if(status==='checking'||status==='added'||status==='exists')return;
  const current=key.current,controller=new AbortController();request.current=controller;
  const timeout=window.setTimeout(()=>controller.abort(),120000);
  setStatus('checking');setDetail('');setConnection(false);
  try{
   const response=await fetch(`/api/games/${encodeURIComponent(gameId)}/vinyl`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({round}),signal:controller.signal});
   const data=await response.json() as {error?:string;added?:boolean;tableName?:string};
   if(key.current!==current)return;
   if(!response.ok){const code=String(data.error??'');setConnection(/DISCOGS_(NOT_CONNECTED|TOKEN_INVALID|AUTH_REQUIRED)/.test(code));setDetail(/DISCOGS_(NOT_CONNECTED|TOKEN_INVALID|AUTH_REQUIRED)/.test(code)?c.connect:code==='VINYL_NOT_CONFIRMED'?c.unconfirmed:/UNSUPPORTED|ALBUM_METADATA/.test(code)?c.unsupported:c.unavailable);setStatus('error');return;}
   if(typeof data.added!=='boolean')throw new Error('Invalid response');
   setStatus(data.added?'added':'exists');setDetail(data.tableName??'');window.dispatchEvent(new CustomEvent('echo-vinyl-refresh'));
  }catch(error){if(key.current===current){setStatus('error');setDetail(error instanceof Error&&error.name==='AbortError'?c.timeout:c.unavailable)}}
  finally{clearTimeout(timeout);if(request.current===controller)request.current=null;}
 };
 return <div className={`game-vinyl-control ${status}`}>
  <button className="game-vinyl-button" onClick={()=>void add()} disabled={status==='checking'||status==='added'||status==='exists'} title={detail||c.add}>{status==='checking'?<Loader2 className="spin" size={16}/>:status==='added'||status==='exists'?<Check size={16}/>:<Disc3 size={16}/>}<span>{status==='checking'?c.checking:status==='added'?c.added:status==='exists'?c.exists:c.add}</span>{status==='idle'&&<Plus size={12}/>}</button>
  {status==='error'&&<div className="game-vinyl-notice" role="status"><span>{detail}</span><a href="/?tab=vinyl" target="_blank" rel="noopener noreferrer">{c.open}</a></div>}
 </div>;
}

'use client';

import {useEffect,useRef,useState} from 'react';
import {Check,Disc3,Loader2,Plus,X} from 'lucide-react';
import {useI18n} from '@/lib/i18n';

type Destination={id:string;name:string;count:number};
const destinationCopy={uk:{title:'Додати до таблиці',cancel:'Скасувати',checking:'Завантажуємо таблиці…',unverified:'Додано до бажаних альбомів. Вінілове видання ще не підтверджено.'},en:{title:'Add to a table',cancel:'Cancel',checking:'Loading tables…',unverified:'Saved to your album wishlist. A vinyl pressing is not yet confirmed.'},ru:{title:'Добавить в таблицу',cancel:'Отмена',checking:'Загружаем таблицы…',unverified:'Добавлено в желаемые альбомы. Виниловое издание пока не подтверждено.'}};
const copy={
 uk:{add:'Додати альбом',checking:'Визначаємо альбом…',added:'Альбом додано',exists:'Уже в каталозі',connect:'Підключіть Discogs у вкладці «Вініл».',unconfirmed:'Вінілове видання цього альбому не підтверджено.',unavailable:'Каталог тимчасово недоступний. Повторіть спробу.',open:'Відкрити вініл',timeout:'Перевірка триває довше. Спробуйте ще раз.',unsupported:'Для цього запису немає підтверджених даних про альбом.'},
 en:{add:'Add album',checking:'Finding the album…',added:'Album added',exists:'Already in your catalog',connect:'Connect Discogs in the Vinyl tab.',unconfirmed:'A vinyl edition of this album could not be confirmed.',unavailable:'The catalog is temporarily unavailable. Try again.',open:'Open vinyl',timeout:'Verification is taking longer. Please retry.',unsupported:'Verified album metadata is unavailable for this recording.'},
 ru:{add:'Добавить альбом',checking:'Определяем альбом…',added:'Альбом добавлен',exists:'Уже в каталоге',connect:'Подключите Discogs во вкладке «Винил».',unconfirmed:'Виниловое издание этого альбома не подтверждено.',unavailable:'Каталог временно недоступен. Повторите попытку.',open:'Открыть винил',timeout:'Проверка занимает больше времени. Попробуйте ещё раз.',unsupported:'Для этой записи нет подтверждённых данных об альбоме.'}
};

export default function GameVinylButton({gameId,round}:{gameId:string;round:number}){
 const {locale}=useI18n(),c=copy[locale];
 const [status,setStatus]=useState<'idle'|'choosing'|'checking'|'added'|'exists'|'error'>('idle');
 const [tables,setTables]=useState<Destination[]>([]);
 const [unverified,setUnverified]=useState(false);
 const [detail,setDetail]=useState(''),[connection,setConnection]=useState(false);
 const request=useRef<AbortController|null>(null),key=useRef(`${gameId}:${round}`);
 useEffect(()=>{key.current=`${gameId}:${round}`;request.current?.abort();setStatus('idle');setDetail('');setConnection(false);setUnverified(false);return()=>{key.current='';request.current?.abort()}},[gameId,round]);
 const add=async(tableId?:string)=>{
  if(status==='checking'||status==='added'||status==='exists')return;
  const current=key.current,controller=new AbortController();request.current=controller;
  const timeout=window.setTimeout(()=>controller.abort(),120000);
  setStatus('checking');setDetail('');setConnection(false);
  try{
   const response=await fetch(`/api/games/${encodeURIComponent(gameId)}/vinyl`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({round,tableId}),signal:controller.signal});
   const data=await response.json() as {error?:string;added?:boolean;tableName?:string;vinylVerified?:boolean};
   if(key.current!==current)return;
   if(!response.ok){const code=String(data.error??'');setConnection(/DISCOGS_(NOT_CONNECTED|TOKEN_INVALID|AUTH_REQUIRED)/.test(code));setDetail(/DISCOGS_(NOT_CONNECTED|TOKEN_INVALID|AUTH_REQUIRED)/.test(code)?c.connect:code==='VINYL_NOT_CONFIRMED'?c.unconfirmed:/UNSUPPORTED|ALBUM_METADATA/.test(code)?c.unsupported:c.unavailable);setStatus('error');return;}
   if(typeof data.added!=='boolean')throw new Error('Invalid response');
   setStatus(data.added?'added':'exists');setUnverified(data.vinylVerified===false);setDetail(data.tableName??'');window.dispatchEvent(new CustomEvent('echo-vinyl-refresh'));
  }catch(error){if(key.current===current){setStatus('error');setDetail(error instanceof Error&&error.name==='AbortError'?c.timeout:c.unavailable)}}
  finally{clearTimeout(timeout);if(request.current===controller)request.current=null;}
 };
 const choose=async()=>{
  if(status==='checking'||status==='added'||status==='exists')return;
  if(status==='choosing'){setStatus('idle');return;}
  const current=key.current,controller=new AbortController();request.current=controller;setStatus('checking');setDetail(destinationCopy[locale].checking);
  try{
   const response=await fetch(`/api/games/${encodeURIComponent(gameId)}/vinyl`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),cache:'no-store'});
   const data=await response.json() as {tables?:Destination[]};
   if(key.current!==current||controller.signal.aborted)return;
   if(!response.ok||!Array.isArray(data.tables))throw new Error('Unavailable');
   const destinations=data.tables.filter(table=>typeof table.id==='string'&&typeof table.name==='string');setTables(destinations);setDetail('');
   if(destinations.length>1)setStatus('choosing');else{setStatus('idle');await add(destinations[0]?.id);}
  }catch{if(key.current===current){setStatus('error');setDetail(c.unavailable);}}
  finally{if(request.current===controller)request.current=null;}
 };
 return <div className={`game-vinyl-control ${status}`}>
  <button className="game-vinyl-button" onClick={()=>void choose()} disabled={status==='checking'||status==='added'||status==='exists'} title={detail||c.add}>{status==='checking'?<Loader2 className="spin" size={16}/>:status==='added'||status==='exists'?<Check size={16}/>:<Disc3 size={16}/>}<span>{status==='checking'?c.checking:status==='added'?c.added:status==='exists'?c.exists:c.add}</span>{status==='idle'&&<Plus size={12}/>}</button>
  {status==='choosing'&&<div className="game-vinyl-destinations" role="dialog" aria-label={destinationCopy[locale].title}><div><strong>{destinationCopy[locale].title}</strong><button aria-label={destinationCopy[locale].cancel} onClick={()=>setStatus('idle')}><X size={14}/></button></div>{tables.map(table=><button key={table.id} onClick={()=>void add(table.id)}><Disc3 size={16}/><span>{table.name}</span><small>{table.count}</small></button>)}</div>}
  {unverified&&(status==='added'||status==='exists')&&<div className="game-vinyl-notice" role="status"><span>{destinationCopy[locale].unverified}</span><button className="game-vinyl-dismiss" aria-label={destinationCopy[locale].cancel} onClick={()=>setUnverified(false)}><X size={13}/></button></div>}
  {status==='error'&&<div className="game-vinyl-notice" role="status"><span>{detail}</span><a href="/?tab=vinyl" target="_blank" rel="noopener noreferrer">{c.open}</a></div>}
 </div>;
}

'use client';
import {useEffect,useState,useSyncExternalStore} from 'react';
import {Cloud,Check,LoaderCircle,Trash2,X} from 'lucide-react';
import {useI18n} from '@/lib/i18n';
import {Switch} from '@/components/ui/switch';
import {subscribeCloud,getCloudState,getCloudServerState,inspectCloud,saveCloud,verifyCloud,cancelCloud} from './cloud-ai-runtime';
import {RequestError} from './client-request';

export function CloudAvailability({onSettings}:{onSettings:()=>void}){
 const {t}=useI18n(),state=useSyncExternalStore(subscribeCloud,getCloudState,getCloudServerState);
 return <button type="button" className="ai-availability" onClick={onSettings}><Cloud size={15}/><span>Gemini · {t(state.checking?'cloud.checking':state.connected?'cloud.connected':state.configured?'cloud.configuredShort':'cloud.GEMINI_NOT_CONFIGURED')}</span><strong>{t('model.settings')}</strong></button>;
}

export default function CloudAISettings({disabled=false}:{disabled?:boolean}){
 const {t}=useI18n(),state=useSyncExternalStore(subscribeCloud,getCloudState,getCloudServerState),[key,setKey]=useState(''),[free,setFree]=useState(false),[action,setAction]=useState<'saving'|'testing'|'removing'|null>(null),[note,setNote]=useState('');
 const busy=action!==null,blocked=busy||state.working||disabled;
 useEffect(()=>{void inspectCloud().catch(()=>setNote(t('request.server')));},[t]);
 useEffect(()=>setFree(state.freeTier),[state.freeTier]);
 const perform=async(next:'save'|'remove'|'test')=>{
  if(blocked)return;
  setAction(next==='save'?'saving':next==='remove'?'removing':'testing');setNote('');let saved=false;
  try{
   if(next==='test'){await verifyCloud();setNote(t('cloud.testOK'));}
   else{
    await saveCloud(next==='remove'?{geminiKey:null,geminiFreeTier:false,aiProvider:'local'}:{...(key.trim()?{geminiKey:key.trim()}:{}),geminiFreeTier:free,aiProvider:'gemini'});
    saved=next==='save';setKey('');
    if(saved){setAction('testing');await verifyCloud();setNote(t('cloud.testOK'));}
    else setNote(t('progress.saved'));
   }
  }catch(error){
   const code=error instanceof RequestError?error.code:'';
   const message=code==='CANCELLED'?t('cloud.cancelled'):code&&t('cloud.'+code)!=='cloud.'+code?t('cloud.'+code):code==='AUTH_REQUIRED'?t('error.auth'):['SERVER_UNAVAILABLE','SERVER_ERROR'].includes(code)?t('request.server'):code==='TIMEOUT'?t('request.timeout'):t('request.network');
   setNote(saved&&code!=='CANCELLED'?`${t('cloud.saved')} ${message}`:message);
  }finally{setAction(null);}
 };

 const status=state.checking?t('cloud.checking'):action==='saving'?t('cloud.saving'):state.connected?t('cloud.connected'):state.configured?t('cloud.saved'):'';
 return <section className="ai-settings cloud-settings" aria-busy={busy||state.checking}>
  <div className="ai-settings-heading"><span className="ai-settings-icon"><Cloud size={22}/></span><div><h3>{t('cloud.title')}</h3><p>{state.connected&&state.model?state.model:'Gemini API'}</p></div>{state.connected&&<Check size={18}/>}</div>
  <p className="ai-settings-note">{t('cloud.playlistOnly')}</p><p className="ai-settings-note">{t('search.economy')}</p>
  <p className="ai-settings-note">{t('cloud.freeNote')} <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a></p>
  <label className="cloud-key"><span>{state.configured?t('cloud.replaceKey'):t('cloud.key')}</span><input type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder={state.configured?'••••••••':'AIza…'} disabled={blocked}/></label>
  <label className="ai-auto-load"><div><strong>{t('cloud.freeConfirm')}</strong><p>{t('cloud.subscription')}</p></div><Switch checked={free} onCheckedChange={setFree} disabled={blocked}/></label>
  <div className="ai-settings-actions">
   <button disabled={blocked||!free||!key.trim()&&!state.configured} onClick={()=>void perform('save')}>{action==='saving'?<LoaderCircle className="spin" size={16}/>:<Cloud size={16}/>} {t('cloud.save')}</button>
   <button disabled={blocked||!state.configured||!state.freeTier} onClick={()=>void perform('test')}>{state.checking&&<LoaderCircle className="spin" size={16}/>} {t(state.checking?'cloud.checking':'cloud.test')}</button>
   {state.checking&&<button disabled={disabled} onClick={cancelCloud}><X size={16}/>{t('cloud.cancelCheck')}</button>}
   {state.configured&&<button disabled={blocked} onClick={()=>void perform('remove')}><Trash2 size={16}/>{t('cloud.remove')}</button>}
  </div>
  {(note||status)&&<p className="ai-settings-note" role="status" aria-live="polite">{busy?status:note||status}</p>}
 </section>;
}

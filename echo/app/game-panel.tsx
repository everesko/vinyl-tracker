'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {createPortal} from 'react-dom';
import {useI18n} from '@/lib/i18n';
import {BalanceFlight} from './game-effects';
import ShareAchievement from './share-achievement';
import GameVinylButton from './game-vinyl-button';
import { Check, Clock3, Disc3, ExternalLink, Headphones, Layers3, Loader2, Mic, Music2, Play, RotateCcw, Trophy, UserRound, Volume2, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import {AlertDialog,AlertDialogContent,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction} from '@/components/ui/alert-dialog';
import { Slider } from '@/components/ui/slider';
import { createDemoPlayer, cutoffPlayback, gameRequest, preparePassage, recognitionConstructor, type DemoPlayer, type GameView, type Recognition } from '@/lib/client-media';
import { multiplier, type AnswerMode } from '@/lib/quiz';
export type { GameView } from '@/lib/client-media';

type Props = { initialGame: GameView; onExit: () => void; onFinished: (game: GameView) => void; onGameChange?: (game: GameView) => void; balanceXp?:number };
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие. Повторите попытку.';

function AnimatedNumber({value,delay=0}:{value:number;delay?:number}){
 const {locale}=useI18n();
 const [shown,setShown]=useState(delay?0:value),previous=useRef(delay?0:value);
 useEffect(()=>{const from=previous.current;previous.current=value;let frame=0;const start=performance.now()+delay,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;const update=(now:number)=>{const t=reduced?1:Math.max(0,Math.min(1,(now-start)/1100));setShown(Math.round((from+(value-from)*(1-(1-t)**3))*10)/10);if(t<1)frame=requestAnimationFrame(update)};frame=requestAnimationFrame(update);return()=>cancelAnimationFrame(frame)},[value,delay]);return <>{new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(shown)}</>;
}

export default function GamePanel({ initialGame, onExit, onFinished, onGameChange, balanceXp=0 }: Props) {
  const [game, setGame] = useState(initialGame), [artist, setArtist] = useState(''), [song, setSong] = useState('');
  const {locale,t}=useI18n();
  const format=(value:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(value);
  const [reportOpen,setReportOpen]=useState(false);
  const [manual,setManual]=useState(false);
  const [settled,setSettled]=useState(false),[revealDone,setRevealDone]=useState(false),[revealBusy,setRevealBusy]=useState(false),[revealStarted,setRevealStarted]=useState(0);
  const [spoken,setSpoken]=useState(''),[cancelOpen,setCancelOpen]=useState(false);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [retryAction, setRetryAction] = useState<'sync' | 'play' | 'answer' | 'next' | 'cancel' | 'hint'>('sync');
  const [now, setNow] = useState(() => Date.now()), [volume, setVolume] = useState(.7), [audible, setAudible] = useState(false);
  const [mediaError,setMediaError]=useState(''),[encore,setEncore]=useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false), [voiceField, setVoiceField] = useState<'artist' | 'song' | null>(null), [interim, setInterim] = useState(''), [voiceError, setVoiceError] = useState(''), [language, setLanguage] = useState(locale==='uk'?'uk-UA':locale==='en'?'en-US':'ru-RU');
  const state = useRef(game), locked = useRef(true), mounted = useRef(true), finished = useRef<string | null>(null);
  const callbacks = useRef({ onFinished, onGameChange, onExit });
  useEffect(() => { callbacks.current = { onFinished, onGameChange, onExit }; }, [onFinished, onGameChange, onExit]);
  const audio = useRef<HTMLAudioElement | null>(null), demo = useRef<DemoPlayer | null>(null);
  const recognition = useRef<Recognition | null>(null), mediaAbort = useRef<AbortController | null>(null), requestAbort = useRef(new AbortController());
  const stopCutoff = useRef<(() => void) | null>(null), encoreTimer = useRef<number | undefined>(undefined), autoReveal = useRef(false);
  const stalledTimer = useRef<number | undefined>(undefined), runtimeFailure = useRef<(reason: string) => void>(() => {});
  const freshPlayback = useRef(false);
  const boundaryKey = useRef('');
  const stopVoice = useCallback(() => { recognition.current?.abort(); recognition.current = null; setVoiceField(null); setInterim(''); }, []);
  const stopMedia = useCallback(() => {
    freshPlayback.current = false;
    mediaAbort.current?.abort(); stopCutoff.current?.(); stopCutoff.current = null;
    audio.current?.pause(); demo.current?.stop(); clearTimeout(encoreTimer.current);
    clearTimeout(stalledTimer.current);
    setAudible(false); setEncore(false); setRevealBusy(false);
  }, []);
  const accept = useCallback((next: GameView) => {
    if (!mounted.current) return;
    if (next.index !== state.current.index || next.id !== state.current.id) {
      stopMedia(); stopVoice(); setArtist(''); setSong(''); setSpoken('');setReportOpen(false); setManual(false); setRevealDone(false); setRevealStarted(0); setVoiceError(''); setMediaError(''); boundaryKey.current = '';
      void demo.current?.close().catch(() => {}); demo.current = null;
      if (audio.current) { audio.current.removeAttribute('src'); audio.current.load(); audio.current = null; }
    }
    if (next.phase !== 'answer') stopVoice();
    state.current = next; setGame(next); setNow(Date.now()); callbacks.current.onGameChange?.(next);

  }, [stopMedia, stopVoice]);

  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); requestAbort.current = controller; locked.current = true;
    // A resume always reads the server; no timer or media is restarted.
    void gameRequest(initialGame.id, undefined, undefined, controller.signal).then(next => { if (!controller.signal.aborted) { setVoiceAvailable(!!recognitionConstructor()); accept(next); } }).catch(e => { if (mounted.current && !controller.signal.aborted) { setError(message(e)); setRetryAction('sync'); } }).finally(() => { if (mounted.current && !controller.signal.aborted) { locked.current = false; setBusy(false); } });
    return () => {
      mounted.current = false; controller.abort(); mediaAbort.current?.abort(); stopCutoff.current?.();
      clearTimeout(encoreTimer.current); audio.current?.pause(); recognition.current?.abort();
      clearTimeout(stalledTimer.current);
      void demo.current?.close().catch(() => {}); demo.current = null;
    };
  }, [initialGame.id, accept]);

  const synchronize = useCallback(async () => {
    if (locked.current || !mounted.current) return;
    locked.current = true; setBusy(true); setError(''); setRetryAction('sync');
    try {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { const next = await gameRequest(state.current.id, undefined, undefined, requestAbort.current.signal); accept(next); return; }
        catch (e) { last = e; if (requestAbort.current.signal.aborted) return; if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 500 * (attempt + 1))); }
      }
      throw last;
    } catch (e) { if (mounted.current) setError(message(e)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }, [accept]);

  useEffect(() => {
    if (game.phase !== 'playing' && game.phase !== 'answer' && game.phase !== 'reveal') return;
    const clock = window.setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(clock);
  }, [game.phase]);
  useEffect(()=>{const frame=requestAnimationFrame(()=>{stopVoice();setLanguage(locale==='uk'?'uk-UA':locale==='en'?'en-US':'ru-RU')});return()=>cancelAnimationFrame(frame)},[locale,stopVoice]);
  useEffect(() => {
    const bound = game.phase === 'playing' ? game.clipEndsAt : game.phase === 'answer' ? game.deadline : undefined;
    const key = `${game.id}:${game.index}:${game.phase}:${bound}`;
    if (!bound || busy || boundaryKey.current === key) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== 'visible' || boundaryKey.current === key) return;
      if (game.phase === 'playing' && freshPlayback.current) return;
      boundaryKey.current = key; if (game.phase === 'playing') stopMedia(); void synchronize();
    }, Math.max(0, bound - Date.now()));
    return () => clearTimeout(timer);
  }, [game, busy, stopMedia, synchronize]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) { const current=state.current;if(current.phase==='playing'&&!locked.current){void gameRequest(current.id,'pause',{round:current.index}).then(accept).catch(()=>{});}stopMedia(); stopVoice(); }
      else { setNow(Date.now()); const current = state.current; if (current.phase === 'playing' || current.phase === 'answer') { boundaryKey.current = ''; void synchronize(); } }
    };
    document.addEventListener('visibilitychange', visibility); return () => document.removeEventListener('visibilitychange', visibility);
  }, [stopMedia, stopVoice, synchronize,accept]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; demo.current?.setVolume(volume); }, [volume]);

  const prepare = async () => {
    const track = state.current.track;
    if (!track) throw new Error('Фрагмент недоступен.');
    mediaAbort.current?.abort(); const controller = new AbortController(); mediaAbort.current = controller;
    if (track.audioUrl) {
      if (!audio.current) {
        const element = new Audio(); element.preload = 'auto'; element.volume = volume; element.src = track.audioUrl; audio.current = element;
        element.onerror = () => runtimeFailure.current('Воспроизведение прервалось. Повторите фрагмент без штрафа.');
        element.onstalled = () => { clearTimeout(stalledTimer.current); if (!element.paused) stalledTimer.current = window.setTimeout(() => { if (!element.paused && element.readyState < 3) runtimeFailure.current('Звук остановился при загрузке. Повторите фрагмент без штрафа.'); }, 800); };
        element.oncanplay = () => clearTimeout(stalledTimer.current);
        element.onended = () => { if ((state.current.clipEndsAt ?? 0) > Date.now() + 150) runtimeFailure.current('Аудиофрагмент закончился слишком рано. Повторите без штрафа.'); };
        element.load();
      }
      const current=state.current,resuming=current.phase==='paused',seconds=resuming?(current.pauseRemaining??current.settings.duration*1000)/1000:current.settings.duration;
      await preparePassage(audio.current,(track.verseStart??0)+(resuming?current.settings.duration-seconds:0),controller.signal,seconds);
    } else if (track.demoNotes?.length) {
      if (!demo.current) { const player = await createDemoPlayer(track.demoNotes); if (controller.signal.aborted || !mounted.current) { await player.close(); throw new DOMException('Cancelled', 'AbortError'); } demo.current = player; }
    } else throw new Error('У этого трека ещё нет аудио. Попробуйте другую коллекцию.');
  };
  const handleRuntimeFailure = useCallback((reason: string) => {
    const current = state.current;
    if (!mounted.current || locked.current || current.phase !== 'playing' || !current.clipEndsAt || Date.now() >= current.clipEndsAt) return;
    locked.current = true; setBusy(true); stopMedia(); setError(reason); setRetryAction('play');
    void gameRequest(current.id, 'media-error', { round: current.index, clipEndsAt: current.clipEndsAt }, requestAbort.current.signal)
      .then(accept).catch(e => { if (mounted.current) { setError(`${reason} ${message(e)}`); setRetryAction('sync'); } })
      .finally(() => { locked.current = false; if (mounted.current) setBusy(false); });
  }, [accept, stopMedia]);
  useEffect(() => { runtimeFailure.current = handleRuntimeFailure; }, [handleRuntimeFailure]);
  const playPrepared = async (seconds: number, fresh = false) => {
    if (document.hidden || !mounted.current) return;
    stopCutoff.current?.();
    freshPlayback.current = fresh;
    const stopped = () => {
      const completedFresh = freshPlayback.current; freshPlayback.current = false; setAudible(false);
      if (completedFresh && mounted.current) { boundaryKey.current = ''; void synchronize(); }
    };
    if (audio.current) {
      await audio.current.play();
      if (document.hidden || !mounted.current) { audio.current.pause(); return; }
      stopCutoff.current = cutoffPlayback(audio.current, seconds, () => { stopCutoff.current = null; stopped(); });
    } else if (demo.current) {
      await demo.current.play(seconds, volume);
      if (document.hidden || !mounted.current) { demo.current.stop(); return; }
      clearTimeout(encoreTimer.current); encoreTimer.current = window.setTimeout(stopped, seconds * 1000);
    }
    setAudible(true);
  };
  const playRound = async (replay = false) => {
    if (locked.current) return;
    if (replay && state.current.settings.timer) return;
    locked.current = true; setBusy(true); setError(''); setRetryAction('play');
    let started: GameView | undefined;
    try {
      await prepare();
      if (!mounted.current || document.hidden) return;
      if (!replay && state.current.phase === 'paused') {started=await gameRequest(state.current.id,'resume',{round:state.current.index},requestAbort.current.signal);accept(started);}
      else if (!replay && state.current.phase === 'ready') {
        started = await gameRequest(state.current.id, 'play', { round: state.current.index }, requestAbort.current.signal); accept(started);
      }
      const current = started ?? state.current;
      if (current.phase === 'reveal' || current.phase === 'finished'||current.phase === 'cancelled') return;
      const fresh = !!started && !replay;
      const seconds = replay ? current.settings.duration : Math.max(0, Math.min(current.settings.duration, ((current.clipEndsAt ?? Date.now() + current.settings.duration * 1000) - Date.now()) / 1000));
      if (seconds > 0) await playPrepared(seconds, fresh);
    } catch (e) {
      stopMedia();
      if (started?.clipEndsAt && mounted.current) {
        try { accept(await gameRequest(started.id, 'media-error', { round: started.index, clipEndsAt: started.clipEndsAt }, requestAbort.current.signal)); }
        catch (resetError) { setError(`${message(e)} ${message(resetError)}`); setRetryAction('sync'); return; }
      }
      if (mounted.current) setError(message(e));
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const pauseRound=async()=>{
    if(locked.current||state.current.phase!=='playing')return;locked.current=true;setBusy(true);stopMedia();
    try{accept(await gameRequest(game.id,'pause',{round:game.index},requestAbort.current.signal));}catch(e){setError(message(e));}finally{locked.current=false;if(mounted.current)setBusy(false)}
  };
  const replaceMedia=async(kind:'replace-fragment'|'replace-track')=>{
    if(locked.current)return;locked.current=true;setBusy(true);setError('');stopMedia();stopVoice();
    try{const next=await gameRequest(game.id,kind,{round:game.index},requestAbort.current.signal);if(audio.current){audio.current.removeAttribute('src');audio.current.load();audio.current=null;}accept(next);setReportOpen(false);setArtist('');setSong('');setSpoken('');boundaryKey.current='';}
    catch(e){setError(message(e));setRetryAction('sync');}finally{locked.current=false;if(mounted.current)setBusy(false)}
  };
  const act = async (action: 'answer' | 'next', empty = false, mode:AnswerMode = game.songOnly?'song':'both') => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setRetryAction(action); stopVoice(); stopMedia();
    try {
      autoReveal.current = action === 'answer';
      const current = state.current;
      accept(await gameRequest(current.id, action, { round: current.index, ...(action === 'answer' ? { artist: empty || mode === 'song' ? '' : artist, song: empty || mode === 'artist' ? '' : song, spoken:empty?'':spoken, mode } : {}) }, requestAbort.current.signal));
    } catch (e) { autoReveal.current = false; if (mounted.current) setError(message(e)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };

  const playReveal=useCallback(async()=>{
    const current=state.current;if(current.phase!=='reveal'||document.hidden)return;
    stopMedia();setMediaError('');setRevealBusy(true);
    const controller=new AbortController();mediaAbort.current=controller;
    const valid=()=>!controller.signal.aborted&&mounted.current&&state.current.id===current.id&&state.current.index===current.index&&state.current.phase==='reveal';
    const completed=()=>{if(!valid())return;stopCutoff.current=null;setEncore(false);setRevealDone(true)};
    try{
      const source=current.reveal?.audioUrl??current.track?.audioUrl;
      if(source){
        if(!audio.current||audio.current.getAttribute('src')!==source){audio.current?.pause();const element=new Audio(source);element.preload='auto';audio.current=element;element.load()}
        const element=audio.current;element.volume=volume;element.onerror=()=>{if(valid()){stopMedia();setMediaError('Фрагмент недоступен. Можно перейти дальше.');setRevealDone(true)}};
        element.onstalled=null;element.oncanplay=null;element.onended=completed;
        await preparePassage(element,current.reveal?.encoreStart??0,controller.signal,10);if(!valid()||document.hidden)return;
        await element.play();if(!valid()){element.pause();return}setEncore(true);setRevealStarted(Date.now());stopCutoff.current=cutoffPlayback(element,10,completed);
      }else if(current.track?.demoNotes?.length){
        if(!demo.current)demo.current=await createDemoPlayer(current.track.demoNotes);if(!valid())return;
        await demo.current.play(10,volume);if(!valid()){demo.current.stop();return}setEncore(true);setRevealStarted(Date.now());encoreTimer.current=window.setTimeout(completed,10000);
      }else setRevealDone(true);
    }catch(e){if(valid()){setMediaError(message(e));setRevealDone(false)}}finally{if(valid())setRevealBusy(false)}
  },[stopMedia,volume]);
  useEffect(()=>{if(game.phase==='reveal'&&autoReveal.current){autoReveal.current=false;void playReveal()}},[game.phase,playReveal]);

  const playHint=async()=>{
    if(locked.current||state.current.phase!=='answer'||state.current.hint?.used||!state.current.hint?.available)return;
    locked.current=true;setBusy(true);setError('');setRetryAction('hint');stopVoice();stopMedia();
    let reserved=false;
    try{
      const current=state.current,controller=new AbortController();mediaAbort.current=controller;
      if(audio.current)await preparePassage(audio.current,current.hint?.start??12,controller.signal,current.settings.duration);
      else if(current.track?.audioUrl){await prepare();if(audio.current)await preparePassage(audio.current,current.hint?.start??12,mediaAbort.current?.signal,current.settings.duration)}
      const next=await gameRequest(current.id,'hint',{round:current.index},requestAbort.current.signal);accept(next);reserved=!!next.hint?.used;
      if(next.phase!=='answer')return;
      await playPrepared(next.settings.duration);
    }catch(e){
      stopMedia();
      if(reserved){try{accept(await gameRequest(state.current.id,'hint-error',{round:state.current.index},requestAbort.current.signal))}catch{setRetryAction('sync')}}
      setRetryAction('sync');if(mounted.current)setError(message(e));
    }finally{locked.current=false;if(mounted.current)setBusy(false)}
  };

  const startVoice = (field: 'artist' | 'song') => {
    stopVoice(); stopMedia(); setVoiceError(''); const Constructor = recognitionConstructor();
    if (!Constructor) { setVoiceError('Голосовой ввод недоступен. Введите ответ с клавиатуры.'); return; }
    const instance = new Constructor(); instance.lang = language; instance.continuous = false; instance.interimResults = true;
    instance.onresult = event => {
      if (state.current.phase !== 'answer' || document.hidden) { instance.abort(); return; }
      let finalText = '', draft = '';
      for (let i = event.resultIndex; i < event.results.length; i++) { const text = event.results[i][0].transcript; if (event.results[i].isFinal) finalText += text; else draft += text; }
      if (finalText) { setSpoken(finalText.trim()); if(state.current.songOnly){if (field === 'artist') setArtist(finalText.trim()); else setSong(finalText.trim());} }
      setInterim(draft);
    };
    instance.onerror = event => { const messages: Record<string, string> = { 'not-allowed': 'Доступ к микрофону запрещён. Разрешите его в браузере или введите ответ.', 'no-speech': 'Речь не распознана. Попробуйте ещё раз.', network: 'Голосовой сервис недоступен. Введите ответ с клавиатуры.', 'audio-capture': 'Микрофон не найден.' }; if (event.error !== 'aborted') setVoiceError(messages[event.error] || 'Не удалось распознать речь. Введите ответ.'); };
    instance.onend = () => { if (recognition.current === instance) { recognition.current = null; setVoiceField(null); setInterim(''); } };
    recognition.current = instance;
    try { instance.start(); setVoiceField(field); } catch { recognition.current = null; setVoiceError('Не удалось включить микрофон. Введите ответ с клавиатуры.'); }
  };
  const exit = () => { const current=state.current;if(current.phase==='playing')void gameRequest(current.id,'pause',{round:current.index}).catch(()=>{});stopMedia(); stopVoice(); requestAbort.current.abort(); callbacks.current.onExit(); };
  const remaining = game.deadline ? Math.max(0, Math.ceil((game.deadline - now) / 1000)) : undefined;
  const factor = multiplier(game.settings),rewardFactor=game.practice?0:factor;
  const revealMode = game.reveal?.result.mode ?? (game.songOnly?'song':'both');
  const clipProgress = game.clipEndsAt ? Math.max(0, Math.min(100, (1 - (game.clipEndsAt - now) / (game.settings.duration * 1000)) * 100)) : 0;
  const blockedAnswer = busy || audible || !!(game.deadline && now >= game.deadline);

  const cancelGame=async()=>{
    if(locked.current)return;locked.current=true;setBusy(true);stopMedia();stopVoice();setError('');setRetryAction('cancel');
    try{accept(await gameRequest(game.id,'cancel',{},requestAbort.current.signal));setCancelOpen(false)}catch(e){setError(message(e));setCancelOpen(false)}finally{locked.current=false;if(mounted.current)setBusy(false)}
  };
  const closed=game.phase==='finished'||game.phase==='cancelled';
  const settlementArrived=useCallback(()=>{
    setSettled(true);
    if(finished.current!==state.current.id){finished.current=state.current.id;callbacks.current.onFinished(state.current)}
  },[]);
  useEffect(()=>{if(closed&&game.practice)settlementArrived()},[closed,game.practice,settlementArrived]);
  const reward=game.summary?.xpAwarded??0;
  const correctionEntries=Object.entries(game.reveal?.result.corrections??{});
  const speechReady=!!spoken.trim();
  const pending=game.pendingSettings;
  const cancelAmount=Math.round((game.score>0?game.score*.5:game.score)*10)/10;
  const revealProgress=encore&&revealStarted?Math.max(0,Math.min(100,(now-revealStarted)/100)):revealDone?100:0;
  const retry=()=>{
    if(retryAction==='cancel')void cancelGame();else if(retryAction==='hint')void playHint();
    else if(retryAction==='sync')void synchronize();else if(retryAction==='play')void playRound();else void act(retryAction);
  };
  return <section className={`quiz-window quiz-v5 phase-${game.phase} ${game.practice?'practice-game':''}`} aria-label={t('Музыкальная игра')}>
    {game.phase==='reveal'&&game.reveal?.artworkUrl&&typeof document!=='undefined'&&createPortal(<div className={`quiz-fullscreen-art ${encore?'playing':''}`} aria-hidden="true"><Image src={game.reveal.artworkUrl} alt="" fill unoptimized/><i/></div>,document.body)}
    {!closed&&game.phase!=='reveal'&&typeof document!=='undefined'&&createPortal(<div className="quiz-ambient" aria-hidden="true">{Array.from({length:16},(_,i)=><i key={i} style={{left:`${(i*37)%100}%`,animationDelay:`${-i*1.8}s`,animationDuration:`${16+i%7}s`}}>{i%2?'♫':'♪'}</i>)}</div>,document.body)}
    <header className="quiz-window-header"><div><span className="eyebrow">{t(closed?'РЕЗУЛЬТАТ':'МУЗЫКАЛЬНЫЙ КВИЗ')}</span><h2>{t(game.collectionTitle)}</h2></div>{!game.practice&&<div className="game-wallet"><ZapIcon/><span><AnimatedNumber value={balanceXp}/> XP</span></div>}<button className="icon-button" aria-label={t('Свернуть игру')} onClick={exit}><X size={21}/></button></header>
    <div className="quiz-mini-stats"><span><Headphones size={15}/>{closed?`${game.summary?.correct??0} / ${game.total}`:`${game.index+1} / ${game.total}`}</span>{!game.practice&&<><span><Trophy size={15}/><AnimatedNumber value={game.score}/> {t('очков')}</span><span>×{factor.toLocaleString(locale,{maximumFractionDigits:4})}</span></>}<span className={remaining!==undefined&&remaining<=3?'urgent':''}><Clock3 size={15}/>{game.settings.timer?`${remaining??10} ${t('сек')}`:t('Без таймера')}</span></div>
    <Progress className="quiz-round-progress" aria-label={t('Прогресс игры')} value={closed?100:game.index/game.total*100}/>
    {error&&<div className="quiz-error" role="alert"><span>{t(error)}</span><button disabled={busy} onClick={retry}><RotateCcw size={15}/>{t('Повторить')}</button></div>}
    <div className="quiz-body" key={`${game.index}:${game.phase}`}>
      {(game.phase==='ready'||game.phase==='playing'||game.phase==='paused')&&<div className="listen-surface"><div className={`vinyl-disc ${audible?'spinning':''}`} aria-hidden="true"><Disc3/><span>echo.</span></div><h1>{t('Слушай внимательно')}</h1><p>{t(audible?'Фрагмент играет…':'Название откроется после ответа')}</p><div className="listen-deck"><Wave active={audible}/><button className="listen-button" disabled={busy||game.mediaError?.retryAvailable===false} onClick={()=>audible?void pauseRound():void playRound()} aria-label={t('Слушать фрагмент')}>{busy?<Loader2 className="spin"/>:audible?<Headphones/>:<Play fill="currentColor"/>}<span>{busy?t('Готовим звук…'):audible?t('game.pause'):game.phase==='paused'?t('game.resume'):t('Слушать {count} сек',{count:game.settings.duration})}</span></button></div><div className="clip-timeline"><span>00:0{Math.min(game.settings.duration,Math.floor(game.settings.duration*clipProgress/100))}</span><Progress value={clipProgress} aria-label={t('Длительность фрагмента')}/><span>00:0{game.settings.duration}</span></div>{pending&&<span className="queued-settings-note">{t('Новые настройки — со следующего трека')}</span>}{game.mediaError?.retryAvailable===false&&<p role="status">{t('Запись недоступна. Можно отменить игру.')}</p>}<button className="guess-utility listen-report" disabled={busy} onClick={()=>setReportOpen(!reportOpen)}><Volume2 size={18}/>{t('game.incorrectMedia')}</button></div>}
      {game.phase==='answer'&&<div className={`answer-surface answer-v5 ${game.songOnly?'song-only':''}`}>
        <button className={`voice-tile ${voiceField?'recording':''}`} type="button" disabled={blockedAnswer||!voiceAvailable} aria-label={t(voiceField?'Остановить голосовой ввод':'Продиктовать ответ')} aria-pressed={!!voiceField} onClick={()=>voiceField?stopVoice():startVoice(game.songOnly?'song':'artist')}><span className="voice-orb"><Mic size={32}/><i/><i/></span><span className="voice-copy"><strong>{t(voiceField?'Слушаю тебя…':spoken?'Ответ распознан':'Скажи свой ответ')}</strong><span>{interim||spoken||t(voiceAvailable?(game.songOnly?'Назови песню':'Назови исполнителя и песню одной фразой'):'В этом браузере используй ручной ввод')}</span></span>{voiceField&&<Wave active/>}</button>
        <div className="manual-toggle-row"><button className="manual-toggle" aria-expanded={manual} onClick={()=>setManual(!manual)}>{t(manual?'Скрыть поля':'Ввести вручную')}</button><button className="voice-language" aria-label={t('Язык голосового ввода')} onClick={()=>{stopVoice();setLanguage(language==='uk-UA'?'en-US':language==='en-US'?'ru-RU':'uk-UA')}}>{language==='uk-UA'?'UK':language==='en-US'?'EN':'RU'} · {t('Совпадение от 40%')}</button></div>
        <div className={`guess-answer-cards ${game.songOnly?'single':''}`}>
          {(['artist','song'] as const).filter(field=>!game.songOnly||field==='song').map(field=><div className={`guess-answer-card ${manual?'expanded':''}`} key={field}><label htmlFor={`guess-${field}`}><span>{field==='artist'?<UserRound size={16}/>:<Music2 size={16}/>} {t(field==='artist'?'Исполнитель':'Название песни')}</span>{manual?<input id={`guess-${field}`} value={field==='artist'?artist:song} onChange={e=>{setSpoken('');if(field==='artist')setArtist(e.target.value);else setSong(e.target.value)}} placeholder={t(field==='artist'?'Кто поёт?':'Как называется?')} autoComplete="off" spellCheck={false} maxLength={200} disabled={blockedAnswer}/>:<small>{t(speechReady?'Голосовой ответ готов':'Ответь голосом или открой поле')}</small>}</label></div>)}
        </div>
        <div className={`guess-action-grid ${game.songOnly?'single':''}`}>
          {!game.songOnly&&<button className="guess-main" disabled={blockedAnswer||!(speechReady||artist.trim()||song.trim())} onClick={()=>void act('answer',false,'both')}><Layers3 size={24}/><strong>{t('game.guessAll')}</strong>{!game.practice&&<span>+{format(25*rewardFactor*(game.hint?.used?.valueOf()?0.75:1))}</span>}</button>}
          {(['artist','song'] as const).filter(field=>!game.songOnly||field==='song').map(field=><button className="guess-single" key={field} disabled={blockedAnswer||!(speechReady||(field==='artist'?artist:song).trim())} onClick={()=>void act('answer',false,field)}>{field==='artist'?<UserRound size={21}/>:<Music2 size={21}/>}<strong>{t(field==='artist'?'Угадать исполнителя':'Угадать песню')}</strong>{!game.practice&&<span>+{format(10*rewardFactor*(game.hint?.used?0.75:1))}</span>}</button>)}
        </div>
        <div className="guess-utility-grid"><button className={`guess-utility ${game.hint?.used?'used':''}`} disabled={blockedAnswer||!game.hint?.available||game.hint?.used} onClick={()=>void playHint()}><Headphones size={18}/><span>{t(game.practice?'game.anotherPractice':game.hint?.used?'Другой фрагмент использован · 75% награды':game.hint?.failed?'Другой фрагмент недоступен':'Другой фрагмент · 75% награды')}</span></button><button className="guess-utility" disabled={busy||audible} onClick={()=>setReportOpen(!reportOpen)}><Volume2 size={18}/><span>{t('game.incorrectMedia')}</span></button><button className="guess-utility guess-skip" disabled={busy||audible} onClick={()=>void act('answer',true)}><X size={18}/><strong>{t('Не знаю')}</strong></button></div>
        {(voiceError||remaining===0)&&<p className="inline-voice-status" role="status">{t(remaining===0?'Время вышло. Получаем результат…':voiceError)}</p>}
      </div>}
      {game.phase==='reveal'&&game.reveal&&<div className={`reveal-surface reveal-v5 `}>
        <div className={`points-burst ${game.reveal.result.correct?'positive':'negative'}`} role="status">{!game.practice&&<strong>{game.reveal.result.points>0?'+':''}<AnimatedNumber value={game.reveal.result.points} delay={100}/></strong>}<span>{t(game.reveal.result.correct?'Точно в ноту':'Теперь ты знаешь')}</span>{Array.from({length:8},(_,i)=><i key={i} style={{'--particle':i} as React.CSSProperties}/>)}</div>
        <div className="revealed-song">
          <div className={`reveal-cover-v5 ${encore?'pulsing':''}`}>{game.reveal.artworkUrl?<Image src={game.reveal.artworkUrl} width={170} height={170} alt={t('Обложка альбома')} unoptimized/>:<Disc3 size={62}/>}<span className="cover-play-ring"/></div>
          <div><h1 title={game.reveal.title}>{game.reveal.title}</h1><p>{game.reveal.artist}</p><div className="answer-checks">{revealMode!=='song'&&<span className={game.reveal.result.artistCorrect?'correct':'incorrect'}>{game.reveal.result.artistCorrect?<Check size={14}/>:<X size={14}/>} {t('Исполнитель')} {(Math.floor((game.reveal.result.artistConfidence??0)*1000)/10).toFixed(1)}%</span>}{revealMode!=='artist'&&<span className={game.reveal.result.songCorrect?'correct':'incorrect'}>{game.reveal.result.songCorrect?<Check size={14}/>:<X size={14}/>} {t('Песня')} {(Math.floor((game.reveal.result.songConfidence??0)*1000)/10).toFixed(1)}%</span>}</div>{game.reveal.sourceUrl&&<a className="media-source-link" href={game.reveal.sourceUrl} target="_blank" rel="noreferrer">{t('Открыть песню')}<ExternalLink size={13}/></a>}{game.reveal.verifiedYear&&<div className="reveal-proof"><span>{t('game.originalYear',{year:game.reveal.verifiedYear})}</span>{game.reveal.dateSources?.map((source,i)=><a key={i} href={source.url} target="_blank" rel="noreferrer">{i===0?'Deezer':source.url.includes('wikidata')?'Wikidata':source.url.includes('apple.com')?'Apple Music':'MusicBrainz'}</a>)}</div>}</div>
        </div>
        {!!correctionEntries.length&&<div className="correction-notes" role="status">{correctionEntries.map(([field,correction])=><p key={field}><span>{t('Правильное написание')}:</span><strong>{correction?.canonical}</strong></p>)}</div>}
        <div className="reveal-playback"><Wave active={encore}/><span>{t(revealBusy?'Готовим звук…':encore?'Ещё 10 секунд музыки':revealDone?'Фрагмент завершён':'Нажми, чтобы послушать')}</span><Progress value={revealProgress} aria-label={t('Проигрывание после ответа')}/>{!encore&&!revealBusy&&!revealDone&&<button onClick={()=>void playReveal()} aria-label={t('Воспроизвести')}><Play fill="currentColor" size={16}/></button>}</div>
        {mediaError&&<p className="inline-voice-status" role="alert">{t(mediaError)}</p>}
        {!game.practice&&<div className="round-settlement"><span>{t('Общий счёт')}: <strong className={game.score<0?'negative':''}>{format(game.score)}</strong></span><span>{game.reveal.result.hintUsed?t('Награда с подсказкой ×0,75'):t('Баланс профиля пока не меняется')}</span></div>}
        <button className="button-primary next-button" disabled={busy} onClick={()=>void act('next')}>{busy?<Loader2 className="spin" size={18}/>:<Disc3 size={18}/>} {t(game.index+1>=game.total?'Показать результат':'Следующий трек')}</button>
      </div>}
      {closed&&game.summary&&<div className="finish-surface finish-v5"><div className={`award-medal ${game.phase==='cancelled'?'cancelled':''}`}>{game.phase==='cancelled'?<X size={36}/>:<Trophy size={36}/>}</div><h1>{t(game.phase==='cancelled'?'Игра отменена':'Подборка пройдена!')}</h1><p>{game.phase==='cancelled'?t(game.practice?'progress.practiceNote':game.summary.score>0?'При отмене зачисляется 50% общего результата':game.summary.score<0?'Отрицательный счёт будет списан полностью.':'game.zeroBalance'):t('{correct} из {total} треков угадано',{correct:game.summary.correct,total:game.summary.total})}</p>{!game.practice&&<><div className="settlement-tiles"><div><span>{t('Итоговый счёт')}</span><strong><AnimatedNumber value={game.summary.score} delay={150}/></strong></div><div><span>{t('В профиль')}</span><strong className={reward<0?'negative':''}>{reward>0?'+':''}<AnimatedNumber value={reward} delay={300}/> XP</strong></div></div><div className={`reward-transfer ${reward<0?'negative':''}`} data-reward-anchor><span>{t(game.practice?'progress.practice':settled?'Зачислено в профиль':'Переводим в профиль')}</span><strong>{reward>0?'+':''}<AnimatedNumber value={reward} delay={600}/><small> XP</small></strong><p>{t('Общий баланс')}: {format(balanceXp)} XP</p></div></>}<div className="finish-actions"><ShareAchievement compact achievement={{correct:game.summary.correct,total:game.summary.total,score:game.summary.score,xpAwarded:reward,collectionTitle:game.collectionTitle,practice:game.practice}}/><button className="button-primary" onClick={exit}>{t('К подборкам')}</button></div>{!game.practice&&!settled&&<BalanceFlight amount={reward} onArrive={settlementArrived}/>}</div>}
    </div>
    {!closed&&<footer className="quiz-window-footer">{game.practice&&<span className="practice-label">{t('progress.practice')}</span>}<div className="compact-volume"><Volume2 size={16}/><Slider aria-label={t('Громкость')} min={0} max={100} step={1} value={[Math.round(volume*100)]} onValueChange={v=>setVolume(v[0]/100)}/></div><GameVinylButton gameId={game.id} round={game.index}/><button className="cancel-game-button" disabled={busy} onClick={()=>setCancelOpen(true)}>{t('Отменить игру')}</button></footer>}
    {reportOpen&&!closed&&<div className="media-report-panel"><span>{t('game.incorrectMedia')}</span><button disabled={busy} onClick={()=>void replaceMedia('replace-fragment')}>{t('game.replaceFragment')}</button><button disabled={busy} onClick={()=>void replaceMedia('replace-track')}>{t('game.replaceTrack')}</button><button className="icon-button" onClick={()=>setReportOpen(false)} aria-label={t('Закрыть')}><X size={16}/></button></div>}
    <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}><AlertDialogContent className="echo-dialog cancel-confirmation"><AlertDialogTitle>{t('Отменить эту игру?')}</AlertDialogTitle><AlertDialogDescription>{t(game.practice?'progress.practiceNote':game.score>0?'При отмене ты получишь 50% общего счёта.':game.score<0?'Отрицательный счёт будет списан полностью.':'game.zeroBalance')}{!game.practice&&<><strong className="cancel-settlement-amount">{cancelAmount>0?'+':''}{format(cancelAmount)} XP</strong>{t('Баланс профиля изменится один раз после отмены.')}</>}</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>{t('Продолжить')}</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={()=>void cancelGame()}>{t('Отменить игру')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
function ZapIcon(){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 10-13h-7z"/></svg>}
function Wave({active}:{active:boolean}){return <div className={`game-wave ${active?'playing':''}`} aria-hidden="true">{Array.from({length:36},(_,i)=><i key={i} style={{height:`${18+(Math.sin(i*1.9)+1)*28}px`,'--wave-height':`${18+(Math.sin(i*1.9)+1)*28}px`,animationDelay:`${i*.037}s`} as React.CSSProperties}/>)}</div>}

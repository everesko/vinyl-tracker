'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {useI18n} from '@/lib/i18n';
import {BalanceFlight} from './game-effects';
import ShareAchievement from './share-achievement';
import GameVinylButton from './game-vinyl-button';
import { Check, Clock3, Disc3, ExternalLink, Headphones, Layers3, Loader2, Mic, Music2, Pause, Play, RotateCcw, Trophy, UserRound, Volume2, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import {AlertDialog,AlertDialogContent,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction} from '@/components/ui/alert-dialog';
import { Slider } from '@/components/ui/slider';
import { createDemoPlayer, cutoffPlayback, gameRequest, preparePassage, recognitionConstructor, type DemoPlayer, type GameView, type Recognition } from '@/lib/client-media';
import { multiplier, type AnswerMode } from '@/lib/quiz';
export type { GameView } from '@/lib/client-media';

type Props = {
  initialGame: GameView;
  onExit: () => void;
  onFinished: (game: GameView) => void;
  onGameChange?: (game: GameView) => void;
  balanceXp?: number;
  noInputMode?: boolean;
  onToggleNoInputMode?: (value: boolean) => void;
};
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие. Повторите попытку.';

function AnimatedNumber({value,delay=0}:{value:number;delay?:number}){
 const {locale}=useI18n();
 const [shown,setShown]=useState(delay?0:value),previous=useRef(delay?0:value);
 useEffect(()=>{const from=previous.current;previous.current=value;let frame=0;const start=performance.now()+delay,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;const update=(now:number)=>{const t=reduced?1:Math.max(0,Math.min(1,(now-start)/1100));setShown(Math.round((from+(value-from)*(1-(1-t)**3))*10)/10);if(t<1)frame=requestAnimationFrame(update)};frame=requestAnimationFrame(update);return()=>cancelAnimationFrame(frame)},[value,delay]);return <>{new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(shown)}</>;
}

export default function GamePanel({ initialGame, onExit, onFinished, onGameChange, balanceXp=0, noInputMode: propNoInput, onToggleNoInputMode }: Props) {
  const [game, setGame] = useState(initialGame), [artist, setArtist] = useState(''), [song, setSong] = useState('');
  const {locale,t}=useI18n();
  const format=(value:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(value);
  const [localNoInput, setLocalNoInput] = useState<boolean>(() => {
    if (propNoInput !== undefined) return propNoInput;
    if (typeof window !== 'undefined') return localStorage.getItem('echo_no_input_mode') === 'true';
    return false;
  });
  const noInput = propNoInput !== undefined ? propNoInput : localNoInput;
  const toggleNoInput = () => {
    const next = !noInput;
    setLocalNoInput(next);
    try { localStorage.setItem('echo_no_input_mode', String(next)); } catch {}
    onToggleNoInputMode?.(next);
  };

  const [reportOpen,setReportOpen]=useState(false);
  const [manual,setManual]=useState(true);
  const [settled,setSettled]=useState(false),[revealDone,setRevealDone]=useState(false),[revealBusy,setRevealBusy]=useState(false),[revealStarted,setRevealStarted]=useState(0);
  const [spoken,setSpoken]=useState(''),[cancelOpen,setCancelOpen]=useState(false);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [retryAction, setRetryAction] = useState<'sync' | 'play' | 'answer' | 'next' | 'cancel' | 'hint'>('sync');
  const [now, setNow] = useState(() => Date.now()), [volume, setVolume] = useState(.75), [audible, setAudible] = useState(false);
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
  const clockSkew = useRef(0);
  const completedRound = useRef('');
  const clipWindow = useRef<{ start: number; duration: number } | null>(null);
  const serverNow = useCallback(() => Date.now() - clockSkew.current, []);

  const stopVoice = useCallback(() => { recognition.current?.abort(); recognition.current = null; setVoiceField(null); setInterim(''); }, []);
  const stopMedia = useCallback(() => {
    freshPlayback.current = false;
    clipWindow.current = null;
    mediaAbort.current?.abort(); stopCutoff.current?.(); stopCutoff.current = null;
    audio.current?.pause(); demo.current?.stop(); clearTimeout(encoreTimer.current);
    clearTimeout(stalledTimer.current);
    setAudible(false); setEncore(false); setRevealBusy(false);
  }, []);

  const accept = useCallback((rawNext: GameView) => {
    if (!mounted.current) return;
    if (typeof rawNext.serverTime === 'number' && Number.isFinite(rawNext.serverTime)) {
      clockSkew.current = Date.now() - rawNext.serverTime;
    }
    const roundId = `${rawNext.id}:${rawNext.index}`;
    if (rawNext.index !== state.current.index || rawNext.id !== state.current.id) {
      stopMedia(); stopVoice(); setArtist(''); setSong(''); setSpoken('');setReportOpen(false); setRevealDone(false); setRevealStarted(0); setVoiceError(''); setMediaError(''); boundaryKey.current = ''; completedRound.current = '';
      void demo.current?.close().catch(() => {}); demo.current = null;
      if (audio.current) { audio.current.removeAttribute('src'); audio.current.load(); audio.current = null; }
    } else if (rawNext.phase === 'ready' || rawNext.phase === 'paused') {
      completedRound.current = '';
    }
    const next: GameView = rawNext.phase === 'playing' && completedRound.current === roundId
      ? {
          ...rawNext,
          phase: 'answer',
          hint: rawNext.hint ? { ...rawNext.hint, available: rawNext.hintStart !== undefined && !rawNext.hint.used && !rawNext.hint.failed } : rawNext.hint,
        }
      : rawNext;
    if (next.phase !== 'answer') stopVoice();
    state.current = next; setGame(next); setNow(Date.now()); callbacks.current.onGameChange?.(next);
  }, [stopMedia, stopVoice]);

  const transitionToAnswer = useCallback(() => {
    if (!mounted.current) return;
    const current = state.current;
    if (current.phase !== 'playing') return;
    completedRound.current = `${current.id}:${current.index}`;
    freshPlayback.current = false;
    clipWindow.current = null;
    setAudible(false);
    const next: GameView = {
      ...current,
      phase: 'answer',
      hint: current.hint ? { ...current.hint, available: current.hintStart !== undefined && !current.hint.used && !current.hint.failed } : current.hint,
    };
    state.current = next;
    setGame(next);
    setNow(Date.now());
    callbacks.current.onGameChange?.(next);
  }, []);

  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); requestAbort.current = controller; locked.current = true;
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
    if (!audible && game.phase !== 'playing' && game.phase !== 'answer' && game.phase !== 'reveal') return;
    const clock = window.setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(clock);
  }, [audible, game.phase]);
  useEffect(()=>{const frame=requestAnimationFrame(()=>{stopVoice();setLanguage(locale==='uk'?'uk-UA':locale==='en'?'en-US':'ru-RU')});return()=>cancelAnimationFrame(frame)},[locale,stopVoice]);
  useEffect(() => {
    const bound = game.phase === 'playing' ? game.clipEndsAt : game.phase === 'answer' ? game.deadline : undefined;
    const key = `${game.id}:${game.index}:${game.phase}:${bound}`;
    if (!bound || busy || boundaryKey.current === key) return;
    const delay = Math.max(0, bound - serverNow());
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== 'visible' || boundaryKey.current === key) return;
      if (game.phase === 'playing') {
        if (freshPlayback.current) return;
        boundaryKey.current = key;
        stopMedia();
        transitionToAnswer();
        return;
      }
      boundaryKey.current = key;
      void synchronize().then(() => {
        if (mounted.current && state.current.phase === 'answer' && state.current.deadline === bound) {
          window.setTimeout(() => { boundaryKey.current = ''; setNow(Date.now()); }, 180);
        }
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [game, busy, serverNow, stopMedia, synchronize, transitionToAnswer]);
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
        element.onended = () => { if ((state.current.clipEndsAt ?? 0) > serverNow() + 250) runtimeFailure.current('Аудиофрагмент закончился слишком рано. Повторите без штрафа.'); };
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
    if (!mounted.current || locked.current || current.phase !== 'playing' || !current.clipEndsAt || serverNow() >= current.clipEndsAt) return;
    locked.current = true; setBusy(true); stopMedia(); setError(reason); setRetryAction('play');
    void gameRequest(current.id, 'media-error', { round: current.index, clipEndsAt: current.clipEndsAt }, requestAbort.current.signal)
      .then(accept).catch(e => { if (mounted.current) { setError(`${reason} ${message(e)}`); setRetryAction('sync'); } })
      .finally(() => { locked.current = false; if (mounted.current) setBusy(false); });
  }, [accept, serverNow, stopMedia]);
  useEffect(() => { runtimeFailure.current = handleRuntimeFailure; }, [handleRuntimeFailure]);
  const playPrepared = async (seconds: number, fresh = false) => {
    if (document.hidden || !mounted.current) return;
    stopCutoff.current?.();
    freshPlayback.current = fresh;
    clipWindow.current = { start: Date.now(), duration: seconds * 1000 };
    const stopped = () => {
      const completedFresh = freshPlayback.current; freshPlayback.current = false; clipWindow.current = null; setAudible(false);
      if (completedFresh && mounted.current) { boundaryKey.current = ''; transitionToAnswer(); }
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
    if (!replay && state.current.phase === 'playing' && serverNow() >= (state.current.clipEndsAt ?? 0)) {
      transitionToAnswer();
      return;
    }
    locked.current = true; setBusy(true); setError(''); setRetryAction('play');
    let started: GameView | undefined;
    const wasPaused = state.current.phase === 'paused';
    const pausedMs = state.current.pauseRemaining ?? state.current.settings.duration * 1000;
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
      const seconds = replay
        ? current.settings.duration
        : started
          ? (wasPaused ? pausedMs / 1000 : current.settings.duration)
          : Math.max(0, Math.min(current.settings.duration, ((current.clipEndsAt ?? serverNow() + current.settings.duration * 1000) - serverNow()) / 1000));
      if (seconds > 0) await playPrepared(seconds, fresh);
      else if (current.phase === 'playing') transitionToAnswer();
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
    try{const next=await gameRequest(game.id,kind,{round:game.index},requestAbort.current.signal);if(audio.current){audio.current.removeAttribute('src');audio.current.load();audio.current=null;}accept(next);setReportOpen(false);setArtist('');setSong('');setSpoken('');boundaryKey.current='';completedRound.current='';}
    catch(e){setError(message(e));setRetryAction('sync');}finally{locked.current=false;if(mounted.current)setBusy(false)}
  };
  const act = async (action: 'answer' | 'next', empty = false, mode:AnswerMode = game.songOnly?'song':'both') => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setRetryAction(action); stopVoice(); stopMedia();
    try {
      autoReveal.current = action === 'answer';
      const current = state.current;
      if (action === 'answer' && current.clipEndsAt) {
        const waitMs = current.clipEndsAt - serverNow();
        if (waitMs > 0 && waitMs <= 2000) await new Promise(resolve => window.setTimeout(resolve, waitMs + 30));
      }
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
        await preparePassage(element,current.reveal?.encoreStart??0,controller.signal,25);if(!valid()||document.hidden)return;
        await element.play();if(!valid()){element.pause();return}setEncore(true);setRevealStarted(Date.now());stopCutoff.current=cutoffPlayback(element,25,completed);
      }else if(current.track?.demoNotes?.length){
        if(!demo.current)demo.current=await createDemoPlayer(current.track.demoNotes);if(!valid())return;
        await demo.current.play(15,volume);if(!valid()){demo.current.stop();return}setEncore(true);setRevealStarted(Date.now());encoreTimer.current=window.setTimeout(completed,15000);
      }else setRevealDone(true);
    }catch(e){if(valid()){setMediaError(message(e));setRevealDone(false)}}finally{if(valid())setRevealBusy(false)}
  },[stopMedia,volume]);

  const toggleRevealPlayback = useCallback(() => {
    if (encore && audio.current && !audio.current.paused) {
      stopMedia();
    } else {
      void playReveal();
    }
  }, [encore, playReveal, stopMedia]);

  useEffect(()=>{if(game.phase==='reveal'&&autoReveal.current){autoReveal.current=false;void playReveal()}},[game.phase,playReveal]);

  const playHint=async()=>{
    if(locked.current||state.current.phase!=='answer'||state.current.hint?.used||!state.current.hint?.available)return;
    locked.current=true;setBusy(true);setError('');setRetryAction('hint');stopVoice();stopMedia();
    let reserved=false;
    try{
      const current=state.current,controller=new AbortController();mediaAbort.current=controller;
      if(audio.current)await preparePassage(audio.current,current.hint?.start??12,controller.signal,current.settings.duration);
      else if(current.track?.audioUrl){await prepare();if(audio.current)await preparePassage(audio.current,current.hint?.start??12,mediaAbort.current?.signal,current.settings.duration)}
      if (current.clipEndsAt) {
        const waitMs = current.clipEndsAt - serverNow();
        if (waitMs > 0 && waitMs <= 2000) await new Promise(resolve => window.setTimeout(resolve, waitMs + 30));
      }
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
  const effectiveNow = now - clockSkew.current;
  const remaining = game.deadline ? Math.max(0, Math.ceil((game.deadline - effectiveNow) / 1000)) : undefined;
  const factor = multiplier(game.settings),rewardFactor=game.practice?0:factor;
  const revealMode = game.reveal?.result.mode ?? (game.songOnly?'song':'both');
  const clipProgress = audible && clipWindow.current
    ? Math.max(0, Math.min(100, ((now - clipWindow.current.start) / clipWindow.current.duration) * 100))
    : game.phase === 'paused' && game.pauseRemaining !== undefined
      ? Math.max(0, Math.min(100, (1 - game.pauseRemaining / (game.settings.duration * 1000)) * 100))
      : game.clipEndsAt
        ? Math.max(0, Math.min(100, (1 - (game.clipEndsAt - effectiveNow) / (game.settings.duration * 1000)) * 100))
        : 0;
  const blockedAnswer = busy || audible || !!(game.deadline && effectiveNow >= game.deadline);

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
  const revealProgress=encore&&revealStarted?Math.max(0,Math.min(100,(now-revealStarted)/250)):revealDone?100:0;
  const stageKey = game.phase === 'ready' || game.phase === 'playing' || game.phase === 'paused' ? 'listen' : game.phase;
  const retry=()=>{
    if(retryAction==='cancel')void cancelGame();else if(retryAction==='hint')void playHint();
    else if(retryAction==='sync')void synchronize();else if(retryAction==='play')void playRound();else void act(retryAction);
  };

  return (
    <div className={`nb-quiz-stage ${game.phase === 'reveal' ? 'is-split-reveal' : ''}`}>
      {/* ЛЕВАЯ ЧАСТЬ ЭКРАНА ПРИ РАСКРЫТИИ ПЕСНИ: КРУПНАЯ ОБЛОЖКА АЛЬБОМА */}
      {game.phase === 'reveal' && game.reveal && (
        <aside className="nb-reveal-left-pane" aria-label={t('Обложка альбома')}>
          <div className="nb-cover-frame" onClick={toggleRevealPlayback}>
            <div className="nb-dossier-pin tl" />
            <div className="nb-dossier-pin tr" />
            <div className="nb-dossier-pin bl" />
            <div className="nb-dossier-pin br" />

            <div className={`nb-vinyl-peek ${encore ? 'spinning' : ''}`} aria-hidden="true">
              <div className="nb-vinyl-peek-label">ECHO</div>
            </div>

            <div className="nb-cover-artwork-box">
              {game.reveal.artworkUrl ? (
                <Image
                  src={game.reveal.artworkUrl}
                  width={560}
                  height={560}
                  alt={game.reveal.title}
                  unoptimized
                  className="nb-cover-large-img"
                />
              ) : (
                <div className="nb-cover-fallback">
                  <Disc3 size={88} />
                </div>
              )}

              <button
                type="button"
                className="nb-cover-play-pill"
                aria-label={encore ? 'Пауза' : 'Слушать'}
              >
                {encore ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}
                <span>{encore ? 'ЗВУЧИТ' : 'СЛУШАТЬ'}</span>
              </button>
            </div>

            <div className="nb-cover-caption">
              <span className="nb-stamp">ALBUM MASTER #{String(game.index + 1).padStart(2, '0')}</span>
              <strong>{game.reveal.artist}</strong>
            </div>
          </div>
        </aside>
      )}

      {/* ПРАВАЯ ЧАСТЬ (ИЛИ ЦЕНТРАЛЬНОЕ ОКНО ДО ОТКРЫТИЯ): ОКНО КВИЗА */}
      <section
        className={`quiz-window quiz-v5 phase-${game.phase} ${game.practice ? 'practice-game' : ''} ${
          game.phase === 'reveal' ? 'slid-right' : ''
        }`}
        aria-label={t('Музыкальная игра')}
      >
        <header className="quiz-window-header">
          <div>
            <span className="eyebrow">
              {closed
                ? t('РЕЗУЛЬТАТ')
                : `#${String(game.index + 1).padStart(2, '0')} / ${String(game.total).padStart(2, '0')}`}
            </span>
            <h2>{t(game.collectionTitle)}</h2>
          </div>

          <div className="nb-quiz-header-tools">
            {!closed && (
              <button
                type="button"
                className={`nb-mode-pill ${noInput ? 'active' : ''}`}
                onClick={toggleNoInput}
                title="Переключить режим без ввода названия песен"
              >
                {noInput ? '⚡ Без ввода (Далее)' : '⌨ С вводом'}
              </button>
            )}
            {!game.practice && !noInput && (
              <div className="game-wallet">
                <ZapIcon />
                <span>
                  <AnimatedNumber value={balanceXp} /> XP
                </span>
              </div>
            )}
            <button className="icon-button" aria-label={t('Свернуть игру')} onClick={exit}>
              <X size={20} />
            </button>
          </div>
        </header>

        <div className="quiz-mini-stats">
          <span>
            <Headphones size={14} />
            {closed
              ? `${game.summary?.correct ?? 0} / ${game.total}`
              : `${game.index + 1} / ${game.total}`}
          </span>
          {!game.practice && !noInput && (
            <>
              <span>
                <Trophy size={14} />
                <AnimatedNumber value={game.score} /> {t('очков')}
              </span>
              <span>×{factor.toLocaleString(locale, { maximumFractionDigits: 4 })}</span>
            </>
          )}
          <span className={remaining !== undefined && remaining <= 3 ? 'urgent' : ''}>
            <Clock3 size={14} />
            {game.settings.timer ? `${remaining ?? 10} ${t('сек')}` : `${game.settings.duration}с`}
          </span>
        </div>

        <Progress
          className="quiz-round-progress"
          aria-label={t('Прогресс игры')}
          value={closed ? 100 : (game.index / game.total) * 100}
        />

        {error && (
          <div className="quiz-error" role="alert">
            <span>{t(error)}</span>
            <button disabled={busy} onClick={retry}>
              <RotateCcw size={15} />
              {t('Повторить')}
            </button>
          </div>
        )}

        <div className="quiz-body" key={`${game.index}:${stageKey}`}>
          {(game.phase === 'ready' || game.phase === 'playing' || game.phase === 'paused') && (
            <div className="listen-surface">
              <div className={`vinyl-disc ${audible ? 'spinning' : ''}`} aria-hidden="true">
                <Disc3 />
                <span>echo.</span>
              </div>
              <h1>{audible ? t('Слушай фрагмент') : t('Запусти фрагмент')}</h1>
              <div className="listen-deck">
                <Wave active={audible} />
                <button
                  className="listen-button"
                  disabled={busy || game.mediaError?.retryAvailable === false}
                  onClick={() => (audible ? void pauseRound() : void playRound())}
                  aria-label={t('Слушать фрагмент')}
                >
                  {busy ? (
                    <Loader2 className="spin" />
                  ) : audible ? (
                    <Pause />
                  ) : (
                    <Play fill="currentColor" />
                  )}
                  <span>
                    {busy
                      ? t('Готовим…')
                      : audible
                        ? t('game.pause')
                        : game.phase === 'paused'
                          ? t('game.resume')
                          : t('Слушать {count} сек', { count: game.settings.duration })}
                  </span>
                </button>
              </div>
              <div className="clip-timeline">
                <span>
                  00:0
                  {Math.min(
                    game.settings.duration,
                    Math.floor((game.settings.duration * clipProgress) / 100)
                  )}
                </span>
                <Progress value={clipProgress} aria-label={t('Длительность фрагмента')} />
                <span>00:0{game.settings.duration}</span>
              </div>
              {pending && (
                <span className="queued-settings-note">
                  {t('Новые настройки — со следующего трека')}
                </span>
              )}
              <div className="nb-listen-bottom-row">
                <button
                  className="guess-utility listen-report"
                  disabled={busy}
                  onClick={() => setReportOpen(!reportOpen)}
                >
                  <Volume2 size={16} />
                  {t('game.incorrectMedia')}
                </button>
              </div>
            </div>
          )}

          {game.phase === 'answer' && (
            <div className={`answer-surface answer-v5 ${game.songOnly ? 'song-only' : ''}`}>
              {noInput ? (
                /* РЕЖИМ БЕЗ ВВОДА НАЗВАНИЯ ПЕСЕН (ПРОСТО КНОПКА «ДАЛЕЕ») */
                <div className="nb-noinput-deck">
                  <div className="nb-noinput-head">
                    <span className="nb-stamp">CUE LOCKED · СТОП</span>
                    <h3>Готовы открыть песню?</h3>
                  </div>

                  <button
                    type="button"
                    className="nb-btn nb-btn-primary nb-btn-xl nb-next-reveal-btn"
                    disabled={busy || audible}
                    onClick={() => void act('answer', true)}
                  >
                    <span>ДАЛЕЕ — ОТКРЫТЬ ПЕСНЮ</span>
                    <span className="nb-arrow-badge">→</span>
                  </button>

                  <div className="nb-noinput-tools">
                    <button
                      type="button"
                      className="guess-utility"
                      disabled={busy || audible || game.settings.timer}
                      onClick={() => void playRound(true)}
                    >
                      <RotateCcw size={16} />
                      <span>Повторить</span>
                    </button>
                    <button
                      type="button"
                      className={`guess-utility ${game.hint?.used ? 'used' : ''}`}
                      disabled={blockedAnswer || !game.hint?.available || game.hint?.used}
                      onClick={() => void playHint()}
                    >
                      <Headphones size={16} />
                      <span>Другой кусок</span>
                    </button>
                    <button
                      type="button"
                      className="guess-utility"
                      disabled={busy || audible}
                      onClick={() => setReportOpen(!reportOpen)}
                    >
                      <Volume2 size={16} />
                      <span>Заменить</span>
                    </button>
                  </div>
                </div>
              ) : (
                /* СТАНДАРТНЫЙ РЕЖИМ С ВВОДОМ + КНОПКА «ДАЛЕЕ» */
                <>
                  <div className="manual-toggle-row">
                    <button
                      className="manual-toggle"
                      aria-expanded={manual}
                      onClick={() => setManual(!manual)}
                    >
                      {t(manual ? 'Скрыть поля' : 'Ввести вручную')}
                    </button>
                    {voiceAvailable && (
                      <button
                        className={`voice-language ${voiceField ? 'recording' : ''}`}
                        onClick={() =>
                          voiceField
                            ? stopVoice()
                            : startVoice(game.songOnly ? 'song' : 'artist')
                        }
                      >
                        <Mic size={14} />{' '}
                        {voiceField ? t('Слушаю…') : spoken ? spoken : t('Голосом')}
                      </button>
                    )}
                  </div>

                  <div className={`guess-answer-cards ${game.songOnly ? 'single' : ''}`}>
                    {(['artist', 'song'] as const)
                      .filter((field) => !game.songOnly || field === 'song')
                      .map((field) => (
                        <div
                          className={`guess-answer-card ${manual ? 'expanded' : ''}`}
                          key={field}
                        >
                          <label htmlFor={`guess-${field}`}>
                            <span>
                              {field === 'artist' ? (
                                <UserRound size={15} />
                              ) : (
                                <Music2 size={15} />
                              )}{' '}
                              {t(field === 'artist' ? 'Исполнитель' : 'Название песни')}
                            </span>
                            {manual ? (
                              <input
                                id={`guess-${field}`}
                                value={field === 'artist' ? artist : song}
                                onChange={(e) => {
                                  setSpoken('');
                                  if (field === 'artist') setArtist(e.target.value);
                                  else setSong(e.target.value);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !blockedAnswer) {
                                    if (artist.trim() || song.trim() || speechReady) {
                                      void act(
                                        'answer',
                                        false,
                                        game.songOnly ? 'song' : 'both'
                                      );
                                    } else {
                                      void act('answer', true);
                                    }
                                  }
                                }}
                                placeholder={t(
                                  field === 'artist' ? 'Кто поёт?' : 'Как называется?'
                                )}
                                autoComplete="off"
                                spellCheck={false}
                                maxLength={200}
                                disabled={blockedAnswer}
                              />
                            ) : (
                              <small>
                                {t(speechReady ? 'Голосовой ответ готов' : 'Открой поле')}
                              </small>
                            )}
                          </label>
                        </div>
                      ))}
                  </div>

                  <div className={`guess-action-grid ${game.songOnly ? 'single' : ''}`}>
                    {!game.songOnly && (
                      <button
                        className="guess-main"
                        disabled={
                          blockedAnswer || !(speechReady || artist.trim() || song.trim())
                        }
                        onClick={() => void act('answer', false, 'both')}
                      >
                        <Layers3 size={18} />
                        <strong>{t('game.guessAll')}</strong>
                        {!game.practice && (
                          <span>
                            +
                            {format(
                              25 * rewardFactor * (game.hint?.used?.valueOf() ? 0.75 : 1)
                            )}
                          </span>
                        )}
                      </button>
                    )}
                    {(['artist', 'song'] as const)
                      .filter((field) => !game.songOnly || field === 'song')
                      .map((field) => (
                        <button
                          className="guess-single"
                          key={field}
                          disabled={
                            blockedAnswer ||
                            !(speechReady || (field === 'artist' ? artist : song).trim())
                          }
                          onClick={() => void act('answer', false, field)}
                        >
                          {field === 'artist' ? (
                            <UserRound size={17} />
                          ) : (
                            <Music2 size={17} />
                          )}
                          <strong>
                            {t(
                              field === 'artist' ? 'Исполнитель' : 'Угадать песню'
                            )}
                          </strong>
                          {!game.practice && (
                            <span>
                              +{format(10 * rewardFactor * (game.hint?.used ? 0.75 : 1))}
                            </span>
                          )}
                        </button>
                      ))}
                  </div>

                  <div className="guess-utility-grid">
                    <button
                      className="guess-utility"
                      disabled={busy || audible || game.settings.timer}
                      onClick={() => void playRound(true)}
                    >
                      <RotateCcw size={16} />
                      <span>Повторить</span>
                    </button>
                    <button
                      className={`guess-utility ${game.hint?.used ? 'used' : ''}`}
                      disabled={blockedAnswer || !game.hint?.available || game.hint?.used}
                      onClick={() => void playHint()}
                    >
                      <Headphones size={16} />
                      <span>Другой кусок</span>
                    </button>
                    <button
                      className="guess-utility guess-skip"
                      disabled={busy || audible}
                      onClick={() => void act('answer', true)}
                    >
                      <strong>Далее →</strong>
                    </button>
                  </div>
                </>
              )}
              {(voiceError || remaining === 0) && (
                <p className="inline-voice-status" role="status">
                  {t(remaining === 0 ? 'Время вышло. Получаем результат…' : voiceError)}
                </p>
              )}
            </div>
          )}

          {game.phase === 'reveal' && game.reveal && (
            <div className="reveal-surface reveal-v5">
              {!noInput && (
                <div
                  className={`points-burst ${
                    game.reveal.result.correct ? 'positive' : 'negative'
                  }`}
                  role="status"
                >
                  {!game.practice && (
                    <strong>
                      {game.reveal.result.points > 0 ? '+' : ''}
                      <AnimatedNumber value={game.reveal.result.points} delay={100} />
                    </strong>
                  )}
                  <span>
                    {t(game.reveal.result.correct ? 'Точно в ноту' : 'Ответ открыт')}
                  </span>
                </div>
              )}

              <div className="revealed-song">
                <div>
                  <span className="nb-stamp">
                    TRACK #{String(game.index + 1).padStart(2, '0')}
                    {game.reveal.verifiedYear ? ` · ${game.reveal.verifiedYear}` : ''}
                  </span>
                  <h1 title={game.reveal.title}>{game.reveal.title}</h1>
                  <p>{game.reveal.artist}</p>

                  {!noInput && (
                    <div className="answer-checks">
                      {revealMode !== 'song' && (
                        <span
                          className={
                            game.reveal.result.artistCorrect ? 'correct' : 'incorrect'
                          }
                        >
                          {game.reveal.result.artistCorrect ? (
                            <Check size={14} />
                          ) : (
                            <X size={14} />
                          )}{' '}
                          {t('Исполнитель')}{' '}
                          {(
                            Math.floor((game.reveal.result.artistConfidence ?? 0) * 1000) /
                            10
                          ).toFixed(1)}
                          %
                        </span>
                      )}
                      {revealMode !== 'artist' && (
                        <span
                          className={
                            game.reveal.result.songCorrect ? 'correct' : 'incorrect'
                          }
                        >
                          {game.reveal.result.songCorrect ? (
                            <Check size={14} />
                          ) : (
                            <X size={14} />
                          )}{' '}
                          {t('Песня')}{' '}
                          {(
                            Math.floor((game.reveal.result.songConfidence ?? 0) * 1000) /
                            10
                          ).toFixed(1)}
                          %
                        </span>
                      )}
                    </div>
                  )}

                  {game.reveal.sourceUrl && (
                    <a
                      className="media-source-link"
                      href={game.reveal.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('Открыть в источнике')}
                      <ExternalLink size={13} />
                    </a>
                  )}
                </div>
              </div>

              {!!correctionEntries.length && !noInput && (
                <div className="correction-notes" role="status">
                  {correctionEntries.map(([field, correction]) => (
                    <p key={field}>
                      <span>{t('Правильное написание')}:</span>
                      <strong>{correction?.canonical}</strong>
                    </p>
                  ))}
                </div>
              )}

              <div className="reveal-playback">
                <button
                  type="button"
                  className="nb-reveal-play-toggle"
                  onClick={toggleRevealPlayback}
                  aria-label={encore ? 'Пауза' : 'Воспроизвести'}
                >
                  {encore ? <Pause size={15} /> : <Play fill="currentColor" size={15} />}
                </button>
                <Wave active={encore} />
                <Progress
                  value={revealProgress}
                  aria-label={t('Проигрывание после ответа')}
                />
              </div>

              {mediaError && (
                <p className="inline-voice-status" role="alert">
                  {t(mediaError)}
                </p>
              )}

              <button
                className="button-primary next-button"
                disabled={busy}
                onClick={() => void act('next')}
              >
                {busy ? <Loader2 className="spin" size={18} /> : <Disc3 size={18} />}{' '}
                {t(
                  game.index + 1 >= game.total ? 'Показать результат' : 'Следующий трек →'
                )}
              </button>
            </div>
          )}

          {closed && game.summary && (
            <div className="finish-surface finish-v5">
              <div
                className={`award-medal ${
                  game.phase === 'cancelled' ? 'cancelled' : ''
                }`}
              >
                {game.phase === 'cancelled' ? <X size={32} /> : <Trophy size={32} />}
              </div>
              <h1>
                {t(game.phase === 'cancelled' ? 'Игра отменена' : 'Подборка пройдена!')}
              </h1>
              <p>
                {game.phase === 'cancelled'
                  ? t(
                      game.practice
                        ? 'progress.practiceNote'
                        : game.summary.score > 0
                          ? 'При отмене зачисляется 50% общего результата'
                          : game.summary.score < 0
                            ? 'Отрицательный счёт будет списан полностью.'
                            : 'game.zeroBalance'
                    )
                  : t('{correct} из {total} треков угадано', {
                      correct: game.summary.correct,
                      total: game.summary.total,
                    })}
              </p>
              {!game.practice && !noInput && (
                <>
                  <div className="settlement-tiles">
                    <div>
                      <span>{t('Итоговый счёт')}</span>
                      <strong>
                        <AnimatedNumber value={game.summary.score} delay={150} />
                      </strong>
                    </div>
                    <div>
                      <span>{t('В профиль')}</span>
                      <strong className={reward < 0 ? 'negative' : ''}>
                        {reward > 0 ? '+' : ''}
                        <AnimatedNumber value={reward} delay={300} /> XP
                      </strong>
                    </div>
                  </div>
                  <div
                    className={`reward-transfer ${reward < 0 ? 'negative' : ''}`}
                    data-reward-anchor
                  >
                    <span>
                      {t(
                        game.practice
                          ? 'progress.practice'
                          : settled
                            ? 'Зачислено в профиль'
                            : 'Переводим в профиль'
                      )}
                    </span>
                    <strong>
                      {reward > 0 ? '+' : ''}
                      <AnimatedNumber value={reward} delay={600} />
                      <small> XP</small>
                    </strong>
                    <p>
                      {t('Общий баланс')}: {format(balanceXp)} XP
                    </p>
                  </div>
                </>
              )}
              <div className="finish-actions">
                <ShareAchievement
                  compact
                  achievement={{
                    correct: game.summary.correct,
                    total: game.summary.total,
                    score: game.summary.score,
                    xpAwarded: reward,
                    collectionTitle: game.collectionTitle,
                    practice: game.practice,
                  }}
                />
                <button className="button-primary" onClick={exit}>
                  {t('К подборкам')}
                </button>
              </div>
              {!game.practice && !settled && (
                <BalanceFlight amount={reward} onArrive={settlementArrived} />
              )}
            </div>
          )}
        </div>

        {!closed && (
          <footer className="quiz-window-footer">
            <div className="compact-volume">
              <Volume2 size={16} />
              <Slider
                aria-label={t('Громкость')}
                min={0}
                max={100}
                step={1}
                value={[Math.round(volume * 100)]}
                onValueChange={(v) => setVolume(v[0] / 100)}
              />
            </div>
            <GameVinylButton gameId={game.id} round={game.index} />
            <button
              className="cancel-game-button"
              disabled={busy}
              onClick={() => setCancelOpen(true)}
            >
              {t('Завершить')}
            </button>
          </footer>
        )}

        {reportOpen && !closed && (
          <div className="media-report-panel">
            <span>{t('game.incorrectMedia')}</span>
            <button disabled={busy} onClick={() => void replaceMedia('replace-fragment')}>
              {t('game.replaceFragment')}
            </button>
            <button disabled={busy} onClick={() => void replaceMedia('replace-track')}>
              {t('game.replaceTrack')}
            </button>
            <button
              className="icon-button"
              onClick={() => setReportOpen(false)}
              aria-label={t('Закрыть')}
            >
              <X size={16} />
            </button>
          </div>
        )}

        <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
          <AlertDialogContent className="echo-dialog cancel-confirmation">
            <AlertDialogTitle>{t('Отменить эту игру?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                game.practice
                  ? 'progress.practiceNote'
                  : game.score > 0
                    ? 'При отмене ты получишь 50% общего счёта.'
                    : game.score < 0
                      ? 'Отрицательный счёт будет списан полностью.'
                      : 'game.zeroBalance'
              )}
              {!game.practice && (
                <>
                  <strong className="cancel-settlement-amount">
                    {cancelAmount > 0 ? '+' : ''}
                    {format(cancelAmount)} XP
                  </strong>
                  {t('Баланс профиля изменится один раз после отмены.')}
                </>
              )}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('Продолжить')}</AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={() => void cancelGame()}>
                {t('Отменить игру')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  );
}
function ZapIcon(){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 10-13h-7z"/></svg>}
function Wave({active}:{active:boolean}){return <div className={`game-wave ${active?'playing':''}`} aria-hidden="true">{Array.from({length:24},(_,i)=><i key={i} style={{height:`${14+(Math.sin(i*1.9)+1)*20}px`,'--wave-height':`${14+(Math.sin(i*1.9)+1)*20}px`,animationDelay:`${i*.04}s`} as React.CSSProperties}/>)}</div>}

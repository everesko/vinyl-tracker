import type { AnswerEvaluation, Settings } from './quiz';

export type GameView = {
  id: string; collectionId: string; collectionTitle: string; index: number; total: number;
  practice?:boolean;pauseRemaining?:number;settings: Settings; pendingSettings?: Settings; songOnly?: boolean; dynamicMode?: boolean;
  score: number; maxScore: number; xpPenalty?:number; cancelled?:boolean; phase: 'ready' | 'paused' | 'playing' | 'answer' | 'reveal' | 'finished' | 'cancelled';
  track?: { id: string; audioUrl?: string; verseStart?: number; demoNotes?: number[]; duration?: number };
  clipEndsAt?: number; deadline?: number;
  hintUsed?: boolean; hintStart?: number;
  hint?: { used: boolean; failed?: boolean; start?: number; duration: number; audioUrl?: string; available: boolean };
  mediaError?: { attempts: number; retryAvailable: boolean };
  reveal?: { verifiedYear?:number;dateSources?:{url:string;year:number}[];categorySources?:string[]; title: string; artist: string; videoUrl?: string; chorusStart?: number; videoAvailable?: boolean;
    artworkUrl?: string; sourceUrl?: string; provider?: 'audius'|'deezer'; encoreStart?: number; audioUrl?: string;
    result: AnswerEvaluation };
  summary?: { correct: number; total: number; score: number; xpAwarded: number; xpCredited?:number; xpPenalty?:number; maxScore: number; reward: string };
};

export async function gameRequest(id: string, action?: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<GameView> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = window.setTimeout(cancel, 12000);
  try {
    const response = await fetch(`/api/games/${encodeURIComponent(id)}${action ? `/${action}` : ''}`, {
      method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || payload.error) throw new Error(typeof payload.message === 'string' ? payload.message : 'Не удалось обновить игру. Попробуйте ещё раз.');
    if (typeof payload.id !== 'string' || typeof payload.phase !== 'string') throw new Error('Не удалось прочитать состояние игры.');
    return payload as unknown as GameView;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('Сервер не ответил. Проверьте соединение и повторите.');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}

function waitMedia(media: HTMLMediaElement, events: string[], ready: () => boolean, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); events.forEach(e => media.removeEventListener(e, check)); media.removeEventListener('error', fail); signal?.removeEventListener('abort', abort); };
    const check = () => { if (ready()) { cleanup(); resolve(); } };
    const fail = () => { cleanup(); reject(new Error('Медиа не загрузилось. Проверьте соединение и повторите.')); };
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    events.forEach(e => media.addEventListener(e, check));
    media.addEventListener('error', fail, { once: true }); signal?.addEventListener('abort', abort, { once: true });
    const timer = window.setTimeout(fail, 20000);
  });
}

/** Load and verify the requested passage before the server starts the round clock. */
export async function preparePassage(media: HTMLMediaElement, start: number, signal?: AbortSignal, seconds = 0) {
  await waitMedia(media, ['loadedmetadata'], () => media.readyState >= 1, signal);
  if (!Number.isFinite(start) || start < 0 || (Number.isFinite(media.duration) && start + seconds > media.duration + .05)) throw new Error('Нужный фрагмент недоступен.');
  if (Math.abs(media.currentTime - start) > .06) {
    media.currentTime = start;
    await waitMedia(media, ['seeked', 'timeupdate'], () => !media.seeking && Math.abs(media.currentTime - start) < .25, signal);
  }
  await waitMedia(media, ['canplay', 'canplaythrough', 'loadeddata', 'progress', 'seeked'], () => {
    if (media.readyState < 3 || media.seeking) return false;
    if (seconds <= 0) return true;
    for (let i = 0; i < media.buffered.length; i++) {
      if (media.buffered.start(i) <= start + .05 && media.buffered.end(i) >= start + seconds - .05) return true;
    }
    return false;
  }, signal);
}

export type DemoPlayer = { play: (seconds: number, volume: number) => Promise<void>; stop: () => void; setVolume: (volume: number) => void; close: () => Promise<void> };
export async function createDemoPlayer(notes: number[]): Promise<DemoPlayer> {
  const AudioConstructor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioConstructor) throw new Error('Ваш браузер не поддерживает демозвук. Попробуйте другой браузер.');
  const context = new AudioConstructor();
  const output = context.createGain(); output.connect(context.destination);
  let oscillators: OscillatorNode[] = [], stopper: number | undefined;
  const stop = () => { clearTimeout(stopper); oscillators.forEach(node => { try { node.stop(); } catch {} }); oscillators = []; };
  try { await context.resume(); } catch (error) { await context.close(); throw error; }
  return {
    async play(seconds, volume) {
      stop(); await context.resume();
      if (context.state !== 'running') throw new Error('Разрешите воспроизведение звука в браузере.');
      output.gain.value = Math.max(0, Math.min(1, volume)) * .2;
      const motif = notes.filter(n => Number.isFinite(n) && n >= 0 && n < 128);
      if (!motif.length) throw new Error('Демомелодия недоступна.');
      const origin = context.currentTime + .015, beat = .28;
      for (let i = 0; i * beat < seconds; i++) {
        const start = origin + i * beat, end = Math.min(origin + seconds, start + beat * .9);
        const oscillator = context.createOscillator(), envelope = context.createGain();
        oscillator.type = 'triangle'; oscillator.frequency.value = 440 * 2 ** ((motif[i % motif.length] - 69) / 12);
        envelope.gain.setValueAtTime(0, start); envelope.gain.linearRampToValueAtTime(.85, start + .015); envelope.gain.linearRampToValueAtTime(0, end);
        oscillator.connect(envelope); envelope.connect(output); oscillator.start(start); oscillator.stop(end); oscillators.push(oscillator);
        oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
      }
      stopper = window.setTimeout(stop, seconds * 1000 + 40);
    },
    stop, setVolume(volume) { output.gain.value = volume * .2; },
    async close() { stop(); if (context.state !== 'closed') await context.close(); },
  };
}

/** Pause at the earlier of media position or monotonic elapsed time. */
export function cutoffPlayback(media: HTMLMediaElement, seconds: number, onStop: () => void): () => void {
  const start = media.currentTime, origin = performance.now();
  let done = false;
  const cleanup = () => { clearTimeout(timer); media.removeEventListener('timeupdate', check); media.removeEventListener('ended', finish); };
  const finish = () => { if (done) return; done = true; cleanup(); media.pause(); onStop(); };
  const check = () => { if (media.currentTime >= start + seconds || performance.now() - origin >= seconds * 1000) finish(); };
  media.addEventListener('timeupdate', check); media.addEventListener('ended', finish);
  const timer = window.setTimeout(finish, Math.max(0, seconds * 1000));
  return () => { done = true; cleanup(); media.pause(); };
}

export type RecognitionEvent = { resultIndex: number; results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } } } };
export type Recognition = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null; start(): void; abort(): void; stop(): void };
export function recognitionConstructor(): (new () => Recognition) | undefined {
  const browser = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
}

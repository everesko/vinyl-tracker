import {readJson,storeJson} from './stored-json';
import { evaluateAnswer, maxPoints, shuffleTracks, type Track, type Settings, type AnswerEvaluation, difficultyLevel } from "@/lib/quiz";
import {spreadArtists} from "@/lib/track-order";
import { ApiError, database } from "./http";
import { ensureSettings } from "./progression";
import { gameCollection } from "./catalog";
import { playlistPromptForCollection, recordPlayedSong, playedSongsFromState, type PlayedSong } from './playlist-history';

type State = { playlistPrompt?: string; playedSongs?: PlayedSong[]; settings: Settings; creationRequest?:{collectionId:string;settings:Settings}; practice?:boolean; pauseRemaining?:number; passageStart?:number; excluded?:string[]; pendingSettings?: Settings; songOnly?: boolean; deck: Track[]; index: number; phase: "ready" | "paused" | "playing" | "reveal" | "finished" | "cancelled"; score: number; results: AnswerEvaluation[]; deadline?: number; clipEndsAt?: number; correct: number; cancelledAt?: number; mediaFailures?: Record<number, number>; hints?: Record<number, { used: boolean; start: number; attempted: boolean }> };
export type GameRow = { id: string; user_id: string; collection_id: string; collection_title: string; state: string; version: number; finished: number; score_tenths: number; correct: number; total: number; xp: number; created_at: number; updated_at: number };
function parse(row: GameRow): State {
  const state = JSON.parse(row.state) as State;
  // Legacy mixed custom collections restore artist guessing. Saved terminal XP is immutable.
  if(!row.finished&&row.collection_id.startsWith('custom-')&&new Set(state.deck.map(track=>track.artist)).size>1)state.songOnly=false;
  if(state.songOnly===undefined)state.songOnly=state.deck.every(track=>track.artist===row.collection_title);
  if (state.songOnly) state.settings.mode = "song";
  return state;
}
async function hydrateState(text:string):Promise<State>{const parsed=JSON.parse(text);return parsed.$externalState?readJson<State>(JSON.stringify({$echoChunks:parsed.$externalState})):parsed;}
async function storedState(id:string,state:State){const serialized=await storeJson(`game:${id}`,state),parsed=JSON.parse(serialized);return parsed.$echoChunks?JSON.stringify({$externalState:parsed.$echoChunks,phase:state.phase,practice:!!state.practice,deadline:state.deadline,index:state.index,playlistPrompt:state.playlistPrompt}):serialized;}
function round1(value: number) { return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 10) / 10; }
function terminal(state: State) { return state.phase === "finished" || state.phase === "cancelled"; }
function settlement(state: State) {
  return state.practice?0:terminal(state) ? round1(state.score * (state.phase === "cancelled" && state.score > 0 ? .5 : 1)) : 0;
}
function xpParts(state: State, awarded: number) {
  const xpAwarded = terminal(state) ? round1(awarded) : 0;
  return { xpPenalty: Math.min(0, xpAwarded), xpCredited: Math.max(0, xpAwarded), xpAwarded };
}
export function settingsFrom(value: unknown): Settings {
  const s = value as Settings;
  if (!s || ![3, 5, 7].includes(s.duration) || typeof s.timer !== "boolean" || (s.mode !== undefined && !["artist", "song", "both"].includes(s.mode)) || (s.difficulty !== undefined && !(typeof s.difficulty === "number" && Number.isInteger(s.difficulty) && s.difficulty>=1 && s.difficulty<=10) && !["easy", "medium", "advanced", "hard"].includes(s.difficulty as string)) || (s.count !== undefined && !(Number.isSafeInteger(s.count) && s.count > 0)) || (s.allowArtistRepeats !== undefined && typeof s.allowArtistRepeats !== "boolean")) throw new ApiError(400, "INVALID_SETTINGS", "Выберите длину фрагмента, сложность, число песен и таймер.");
  return { duration: s.duration, timer: s.timer, mode: s.mode ?? "both", difficulty: difficultyLevel(s.difficulty), count: s.count ?? 10, allowArtistRepeats: s.allowArtistRepeats ?? true };
}
export async function loadGame(userId: string, id: string): Promise<GameRow> {
  const row = await database().prepare("SELECT * FROM echo_games WHERE id = ? AND user_id = ?").bind(id, userId).first<GameRow>();
  if (!row) throw new ApiError(404, "GAME_NOT_FOUND", "Игра не найдена.");
  return {...row,state:JSON.stringify(await hydrateState(row.state))};
}
function answer(state: State, artist: string, song: string, mode?: "artist" | "song" | "both", spoken?: string) {
  const result = evaluateAnswer(state.deck[state.index], state.settings, { artist, song, mode, spoken, songOnly: state.songOnly, hintUsed: state.hints?.[state.index]?.used });
  if(state.practice)result.points=0;
  state.results[state.index] = result;
  state.score = round1(state.score + result.points);
  state.correct += result.correct ? 1 : 0;
  state.phase = "reveal";
}
function timeout(state: State, now: number) {
  if (state.phase === "playing" && state.deadline && now >= state.deadline) { answer(state, "", ""); return true; }
  return false;
}
async function save(row: GameRow, state: State) {
  // Existing terminal ledgers are immutable, including settlements under earlier rules.
  const xp = row.finished ? row.xp : settlement(state);
  const saved=await database().prepare("UPDATE echo_games SET state = ?, version = version + 1, finished = ?, score_tenths = ?, correct = ?, xp = ?, updated_at = ? WHERE id = ? AND user_id = ? AND version = ? RETURNING *")
    .bind(await storedState(row.id,state), terminal(state) ? 1 : 0, Math.round(state.score * 10), state.correct, xp, Date.now(), row.id, row.user_id, row.version).first<GameRow>();
  return saved?{...saved,state:JSON.stringify(state)}:null;
}
function hintStart(state: State) {
  const track = state.deck[state.index], start = track?.hintStart ?? (track?.provider === "deezer" ? 12 : undefined);
  if (start === undefined || !Number.isFinite(start) || start < 0 || !track.audioUrl || !Number.isFinite(track.duration) || start + state.settings.duration > track.duration! || Math.abs(start - (track.verseStart ?? 0)) < state.settings.duration) return undefined;
  return start;
}
export function gameView(row: GameRow, at = Date.now()) {
  const state = parse(row), track = state.deck[state.index];
  const phase = state.phase === "playing" && at >= (state.clipEndsAt ?? Infinity) ? "answer" : state.phase;
  const result = state.results[state.index], closed = terminal(state), hint = state.hints?.[state.index];
  const futureSettings = state.pendingSettings ?? state.settings;
  // Answered rounds retain the multiplier that was actually used, rather than new settings.
  const answeredMax = state.results.reduce((sum, evaluation) => sum + round1((evaluation.mode === "both" ? 25 : 10) * evaluation.multiplier * (evaluation.hintUsed ? .75 : 1)), 0);
  const remaining = state.deck.length - state.results.length;
  const currentUnanswered = remaining > 0 && !result;
  const currentMax = currentUnanswered ? maxPoints({ ...state.settings, mode: state.songOnly ? "song" : "both" }, 1) * (hint?.used ? .75 : 1) : 0;
  const maxScore = state.practice?0:round1(answeredMax + currentMax + maxPoints({ ...futureSettings, mode: state.songOnly ? "song" : "both" }, Math.max(0, remaining - (currentUnanswered ? 1 : 0))));
  const audioUrl = track.provider === "audius" || track.provider === "deezer" ? `/api/games/${row.id}/audio?round=${state.index}` : track.audioUrl;
  const start = hint?.start ?? hintStart(state);
  return {
    id: row.id, collectionId: row.collection_id, collectionTitle: row.collection_title, index: state.index, total: state.deck.length,
    settings: settingsFrom(state.settings), pendingSettings: state.pendingSettings, songOnly: !!state.songOnly, practice:!!state.practice, pauseRemaining:state.pauseRemaining, score: state.score, maxScore, dynamicMode: !state.songOnly, phase, cancelled: phase === "cancelled", status: phase === "cancelled" ? "cancelled" : phase === "finished" ? "completed" : "active", ...xpParts(state, row.xp),
    ...(!closed ? { track: { id: `${row.id}:${state.index}`, audioUrl, verseStart: state.passageStart??track.verseStart, demoNotes: track.demoNotes, duration: track.duration } } : {}),
    hintUsed: !!hint?.used, hintStart: start, hint: { used: !!hint?.used, failed: !!hint?.attempted && !hint.used, start, duration: state.settings.duration, audioUrl: !closed ? audioUrl : undefined, available: phase === "answer" && start !== undefined && !hint?.attempted },
    deadline: state.deadline, clipEndsAt: state.clipEndsAt,
    ...(phase === "reveal" ? { reveal: { title: track.title, artist: track.artist, audioUrl, videoUrl: track.videoUrl, videoAvailable: !!track.videoUrl, chorusStart: track.chorusStart, artworkUrl: track.artworkUrl, verifiedYear:track.dateSources?.length?track.year:undefined,dateSources:track.dateSources,categorySources:track.categorySources,provider: track.provider, sourceUrl: track.sourceUrl, encoreStart: track.encoreStart, result } } : {}),
    ...((state.mediaFailures?.[state.index] ?? 0) > 0 ? { mediaError: { attempts: state.mediaFailures![state.index], retryAvailable: state.mediaFailures![state.index] < 3 } } : {}),
    ...(closed ? { summary: { correct: state.correct, total: state.deck.length, answered: state.results.length, score: state.score, ...xpParts(state, row.xp), maxScore, dynamicMode: !state.songOnly, cancelled: phase === "cancelled", reward: phase === "cancelled" ? "При отмене сохраняется половина положительного результата или весь отрицательный." : "Опыт за завершённую игру" } } : {}),
  };
}
export async function createGame(userId: string, collectionId: string, settings: Settings, requestId?:unknown) {
  const normalizedSettings = settingsFrom(settings);
  if(requestId!==undefined&&(typeof requestId!=='string'||requestId.length!==36||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)))throw new ApiError(400,'INVALID_GAME_REQUEST','Неверный идентификатор запуска игры.');
  let id:string;
  if(typeof requestId==='string'){
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([userId,requestId.toLowerCase()]))));digest[6]=(digest[6]&15)|80;digest[8]=(digest[8]&63)|128;const hex=Array.from(digest.slice(0,16),byte=>byte.toString(16).padStart(2,'0')).join('');id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    const existing=await database().prepare('SELECT * FROM echo_games WHERE id = ? AND user_id = ?').bind(id,userId).first<GameRow>();
    if(existing){const row={...existing,state:JSON.stringify(await hydrateState(existing.state))},creation=parse(row).creationRequest;if(!creation||creation.collectionId!==collectionId||JSON.stringify(creation.settings)!==JSON.stringify(normalizedSettings))throw new ApiError(409,'GAME_REQUEST_CONFLICT','Параметры повторного запуска изменились. Начните новую игру.');return gameView(row);}
  }else id=crypto.randomUUID();
  const progress=await ensureSettings(userId,normalizedSettings);
  const { collection, deck, songOnly } = await gameCollection(userId, collectionId, normalizedSettings);
  if (!deck.length) throw new ApiError(409, "EMPTY_COLLECTION", "В подборке нет доступных фрагментов.");
  const playlistPrompt = await playlistPromptForCollection(userId, collectionId);
  const state: State = { ...(playlistPrompt?{playlistPrompt,playedSongs:[]}:{}), ...(requestId!==undefined?{creationRequest:{collectionId,settings:normalizedSettings}}:{}),practice:progress.practice, settings: { ...normalizedSettings, ...(songOnly?{mode:"song" as const}:{}), ...(new Set(deck.map(track=>track.artist)).size < normalizedSettings.count! ? {allowArtistRepeats:true}: {}) }, songOnly, deck: spreadArtists(shuffleTracks(deck)), index: 0, phase: "ready", score: 0, results: [], correct: 0 };
  const now = Date.now();
  await database().prepare("INSERT INTO echo_games (id, user_id, collection_id, collection_title, state, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").bind(id, userId, collectionId, collection.title, await storedState(id,state), deck.length, now, now).run();
  const row=await loadGame(userId,id);if(requestId!==undefined){const creation=parse(row).creationRequest;if(!creation||creation.collectionId!==collectionId||JSON.stringify(creation.settings)!==JSON.stringify(normalizedSettings))throw new ApiError(409,'GAME_REQUEST_CONFLICT','Параметры повторного запуска изменились. Начните новую игру.');}return gameView(row);
}
type SettingsChange = Partial<Pick<Settings, "duration" | "timer" | "difficulty">>;
type Action = { type: "get" } | { type: "cancel" } | { type: "play" | "pause" | "resume" | "replace-fragment" | "replace-track" | "hint" | "hint-error"; round: number } | { type: "settings"; round: number; settings: SettingsChange } | { type: "media-error"; round: number; clipEndsAt: number } | { type: "answer"; round: number; artist: string; song: string; spoken?: string; mode?: "artist" | "song" | "both" } | { type: "next"; round: number };
function queuedSettings(state: State, change: SettingsChange) {
  const current = state.pendingSettings ?? state.settings;
  const updated = settingsFrom({ ...current, ...change });
  if (difficultyLevel(updated.difficulty) < difficultyLevel(current.difficulty)) throw new ApiError(409, "DIFFICULTY_DECREASE", "Во время игры сложность можно только повысить.");
  if (updated.duration>current.duration)throw new ApiError(409,"DURATION_INCREASE","Во время игры фрагмент можно только сокращать.");
  if (current.timer && !updated.timer) throw new ApiError(409, "TIMER_DISABLE", "Во время игры таймер можно только включить.");
  return updated;
}
function responseView(row: GameRow, action: Action, now: number) {
  const state = parse(row);
  if (state.phase === "cancelled") return gameView(row, now);
  if (action.type === "answer" && state.results[action.round] && (action.round < state.index || state.phase === "finished")) {
    state.index = action.round; state.phase = "reveal"; state.deadline = undefined; state.clipEndsAt = undefined;
    state.score = round1(state.results.slice(0, action.round + 1).reduce((sum, result) => sum + result.points, 0));
    return gameView({ ...row, state: JSON.stringify(state) }, now);
  }
  return gameView(row, now);
}
export async function changeGame(userId: string, id: string, action: Action) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await loadGame(userId, id), state = parse(row), now = Date.now();
    if (terminal(state)) return responseView(row, action, now);
    if (action.type !== "get" && action.type !== "cancel" && (!Number.isInteger(action.round) || action.round < 0)) throw new ApiError(400, "INVALID_ROUND", "Укажите номер раунда.");
    if (action.type !== "get" && action.type !== "cancel" && action.round > state.index) throw new ApiError(409, "STALE_ROUND", "Обновите состояние игры.");
    let changed = timeout(state, now);
    let played: PlayedSong | undefined;
    if (action.type === "get") { if (!changed) return gameView(row, now); }
    else if (action.type === "cancel") {
      state.phase = "cancelled"; state.cancelledAt = now; state.deadline = undefined; state.clipEndsAt = undefined; changed = true;
    } else if (action.round === state.index) {
      if (action.type === "settings") { const updated=queuedSettings(state, action.settings);await ensureSettings(userId,updated,!!state.practice);state.pendingSettings = updated; changed = true; }
      else if (action.type === "pause") {
        if(state.phase==='playing'&&now<(state.clipEndsAt??0)){state.pauseRemaining=Math.max(1,state.clipEndsAt!-now);state.phase='paused';state.clipEndsAt=undefined;state.deadline=undefined;changed=true;}
      } else if(action.type==='resume'){
        if(state.phase==='paused'){state.phase='playing';state.clipEndsAt=now+(state.pauseRemaining??state.settings.duration*1000);state.deadline=state.settings.timer?state.clipEndsAt+10000:undefined;state.pauseRemaining=undefined;changed=true;}
      } else if(action.type==='replace-fragment'||action.type==='replace-track'){
        if(!changed&&['ready','playing','paused'].includes(state.phase)){
          if(action.type==='replace-track'){
            const banned=new Set([...state.deck.map(t=>t.id),...(state.excluded??[])]),seenArtists=new Set(state.deck.filter((_,i)=>i!==state.index).map(t=>t.artist));
            const {deck}=await gameCollection(userId,row.collection_id,{...state.settings,allowArtistRepeats:true});
            const replacement=deck.find(t=>!banned.has(t.id)&&(state.settings.allowArtistRepeats||!seenArtists.has(t.artist)));
            if(!replacement)throw new ApiError(409,'NO_REPLACEMENT','Не найден другой подходящий трек. Можно заменить фрагмент.');
            state.excluded=[...(state.excluded??[]),state.deck[state.index].id];state.deck[state.index]=replacement;state.passageStart=undefined;
          }else {const track=state.deck[state.index];const choices=[0,12,20].filter(start=>start+state.settings.duration<=(track.duration??30));state.passageStart=choices.find(start=>Math.abs(start-(state.passageStart??track.verseStart??0))>=state.settings.duration)??0;}
          state.phase='ready';state.pauseRemaining=undefined;state.clipEndsAt=undefined;state.deadline=undefined;if(state.hints)delete state.hints[state.index];if(state.mediaFailures)delete state.mediaFailures[state.index];changed=true;
        }else if(state.phase==='reveal')throw new ApiError(409,'ANSWER_ALREADY_REVEALED','После ответа запись заменить нельзя.');
      } else if (action.type === "play") {
        if (state.phase === "ready") {
          if ((state.mediaFailures?.[state.index] ?? 0) >= 3) throw new ApiError(409, "MEDIA_UNAVAILABLE", "Не удалось воспроизвести фрагмент после двух повторов. Начните другую игру; штраф за сбой не начислен.");
          state.playlistPrompt ??= await playlistPromptForCollection(userId, row.collection_id);
          if (state.playlistPrompt) {
            state.playedSongs ??= playedSongsFromState(state);
            const track = state.deck[state.index]; played = { artist: track.artist, title: track.title };
            if (!state.playedSongs.some(song => song.artist === played!.artist && song.title === played!.title)) state.playedSongs.push(played);
          }
          state.phase = "playing"; state.clipEndsAt = now + state.settings.duration * 1000;
          state.deadline = state.settings.timer ? state.clipEndsAt + 10000 : undefined; changed = true;
        }
      } else if (action.type === "hint") {
        if (!changed) {
          if (state.phase !== "playing" || now < (state.clipEndsAt ?? Infinity)) throw new ApiError(409, "HINT_NOT_AVAILABLE", "Дополнительный фрагмент доступен после основного, до ответа.");
          if (!state.hints?.[state.index]?.attempted) {
            const start = hintStart(state);
            if (start === undefined) throw new ApiError(409, "HINT_NOT_AVAILABLE", "В этой записи нет другого доступного фрагмента.");
            state.hints ??= {}; state.hints[state.index] = { used: true, start, attempted: true }; changed = true;
          }
        }
      } else if (action.type === "hint-error") {
        const hint = state.hints?.[state.index];
        if (state.phase === "playing" && hint?.used && !state.results[state.index]) { hint.used = false; changed = true; }
      } else if (action.type === "media-error") {
        if (!Number.isFinite(action.clipEndsAt)) throw new ApiError(400, "INVALID_PLAY_ATTEMPT", "Укажите время начала попытки воспроизведения.");
        if (state.phase === "playing" && state.clipEndsAt === action.clipEndsAt && !state.hints?.[state.index]?.attempted) {
          state.mediaFailures ??= {}; state.mediaFailures[state.index] = (state.mediaFailures[state.index] ?? 0) + 1;
          state.phase = "ready"; state.deadline = undefined; state.clipEndsAt = undefined; changed = true;
        }
      } else if (action.type === "answer") {
        if (state.phase === "paused")throw new ApiError(409,"CLIP_PAUSED","Продолжите воспроизведение фрагмента.");
        if (state.phase === "ready") throw new ApiError(409, "CLIP_NOT_PLAYED", "Сначала прослушайте фрагмент.");
        if (state.phase === "playing" && now < (state.clipEndsAt ?? 0)) throw new ApiError(409, "CLIP_PLAYING", "Дождитесь конца фрагмента.");
        if (state.phase !== "reveal") { answer(state, action.artist, action.song, action.mode, action.spoken); changed = true; }
      } else if (action.type === "next") {
        if (state.phase !== "reveal") throw new ApiError(409, "ANSWER_REQUIRED", "Сначала завершите этот раунд.");
        if (state.index === state.deck.length - 1) state.phase = "finished";
        else { state.index += 1; state.phase = "ready";state.passageStart=undefined;state.pauseRemaining=undefined; state.deadline = undefined; state.clipEndsAt = undefined;
          if (state.pendingSettings) { state.settings = state.pendingSettings; state.pendingSettings = undefined; }
        }
        changed = true;
      }
    }
    if (!changed) return responseView(row, action, now);
    const saved = await save(row, state);
    if (saved) {
      if (played && state.playlistPrompt) {
        // The CAS-saved state already contains the durable ledger. Its lookup index
        // may be retried from that ledger without making accepted playback fail.
        try { await recordPlayedSong(userId, state.playlistPrompt, played); } catch { /* The next history read recovers the game ledger. */ }
      }
      return responseView(saved, action, now);
    }
  }
  throw new ApiError(409, "CONCURRENT_UPDATE", "Игра изменилась в другой вкладке. Обновите страницу.");
}
export async function sessionView(row: GameRow) {
  const view = gameView({...row,state:JSON.stringify(await hydrateState(row.state))});
  return { id: view.id, collectionId: view.collectionId, collectionTitle: view.collectionTitle, index: view.index, total: view.total, score: view.score, settings: view.settings, pendingSettings: view.pendingSettings, songOnly: view.songOnly, practice:view.practice, phase: view.phase, status: view.status, cancelled: view.cancelled, active: view.status === "active", xpPenalty: view.xpPenalty };
}
export function audioTrack(row: GameRow, round: number) {
  const state = parse(row);
  if (state.phase === "cancelled") throw new ApiError(409, "GAME_CANCELLED", "Игра отменена.");
  if (!Number.isInteger(round) || round < 0 || round > state.index || round >= state.deck.length || (round < state.index && !state.results[round])) throw new ApiError(404, "ROUND_NOT_FOUND", "Аудиофрагмент не найден.");
  return state.deck[round];
}

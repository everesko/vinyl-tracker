import {readJson,storeJson} from './stored-json';
import { collections, demoCollection, getCollectionTracks, tracks } from "@/lib/catalog";
import type { Track, Collection, Settings } from "@/lib/quiz";
import { ApiError, database, runtime } from "./http";
import { audiusCollections, audiusDeck, getCanonicalTracks } from "./audius";
import { popularCollections, popularCards, popularDeck, validatePopularSnapshot, selectPopularTracks, constructPopularCollection, ukrainianPrompt, ukrainianTrackAllowed,constructArtistCollection,parsePopularPrompt } from "./popular";

type LicensedTrack = Partial<Track> & { id: string; chorusEnd?: number };
function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
function approvedOverrides(): Map<string, LicensedTrack> {
  const raw = runtime().LICENSED_CATALOG_JSON;
  if (!raw) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter((item): item is LicensedTrack => {
      if (!item || typeof item !== "object") return false;
      const t = item as LicensedTrack;
      return typeof t.id === "string" && typeof t.rights === "string" && t.rights.trim().length > 0 && httpsUrl(t.audioUrl) &&
        Number.isFinite(t.verseStart) && Number.isFinite(t.verseEnd) && Number.isFinite(t.chorusStart) && Number.isFinite(t.chorusEnd) &&
        t.verseStart! >= 0 && t.verseEnd! - t.verseStart! >= 7 && t.chorusStart! >= 0 && t.chorusEnd! > t.chorusStart! &&
        (t.verseEnd! <= t.chorusStart! || t.verseStart! >= t.chorusEnd!) && (!t.videoUrl || httpsUrl(t.videoUrl));
    }).map(t => [t.id, t]));
  } catch { return new Map(); }
}
type CustomRow = { id: string; title: string; subtitle: string; track_ids: string; track_data?: string | null; created_at: number; recipe?:string|null };
function customCollection(row: CustomRow): Collection {
  return { id: row.id, title: row.title, subtitle: row.subtitle, trackIds: JSON.parse(row.track_ids), color: "#a7a3f6", tag: row.subtitle.includes("поиск по каталогу Deezer") ? "CATALOG" : "AI" };
}
function collectionTracks(collection: Collection): Track[] {
  if (!collection.id.startsWith("custom-")) return getCollectionTracks(collection.id);
  const known = new Map(tracks.map(track => [track.id, track]));
  return collection.trackIds.map(id => known.get(id)).filter((track): track is Track => !!track);
}
export async function gameCollection(userId: string, id: string, settings?: Settings) {
  if (popularCollections.some(collection => collection.id === id)) return popularDeck(id, settings);
  if (audiusCollections.some(collection => collection.id === id)) { const found = await audiusDeck(userId, id); return { ...found, deck: selectPopularTracks(found.deck, settings), songOnly: false }; }
  let collection = [...collections, demoCollection].find((item: Collection) => item.id === id);
  let snapshot: Track[] | undefined;
  let aiSongOnly: boolean | undefined;
  if (!collection && id.startsWith("custom-")) {
    const row = await database().prepare("SELECT * FROM echo_collections WHERE id = ? AND user_id = ?").bind(id, userId).first<CustomRow>();
    if (row) {
      collection = customCollection(row);
      if(row.recipe&&JSON.parse(row.recipe).ai)aiSongOnly=JSON.parse(row.recipe).plan.artists.length===1;
      if (row.track_data) snapshot = await readJson<Track[]>(row.track_data);
      if(!row.recipe||!JSON.parse(row.recipe).ai)if(snapshot?.every(track=>track.provider==="deezer")||ukrainianPrompt(row.title)){
        const recipe=row.recipe?JSON.parse(row.recipe):{prompt:row.title};
        const query=recipe.artistIds?undefined:parsePopularPrompt(recipe.prompt);
        if((recipe.artistIds?.length??(query?.explicitArtists?query.artists.length:Infinity)) < (settings?.count??10))settings={...settings!,allowArtistRepeats:true};
        const repaired=recipe.artistIds?await constructArtistCollection(recipe.artistIds,recipe.title,settings):await constructPopularCollection(recipe.prompt,settings);
        snapshot=repaired.pool;collection.trackIds=snapshot.map(track=>track.id);
        await database().prepare("UPDATE echo_collections SET track_ids = ?, track_data = ?, subtitle = ? WHERE id = ? AND user_id = ?").bind(JSON.stringify(collection.trackIds),await storeJson(`collection:${row.id}`,snapshot),repaired.subtitle,row.id,userId).run();
      }
    }
  }
  if (!collection) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Подборка не найдена.");
  if (snapshot?.length && snapshot.every(track => track.provider === "deezer")) return { collection, deck: selectPopularTracks(validatePopularSnapshot(snapshot), settings, new Set(snapshot.map(track => track.artist)).size > 1), songOnly: aiSongOnly??new Set(snapshot.map(track=>track.artist)).size===1 };
  if (snapshot?.length && snapshot.every(track => track.provider === "audius")) {
    if (snapshot.length !== 50 || new Set(snapshot.map(track => track.id)).size !== 50) throw new ApiError(409, "INVALID_COLLECTION", "Подборка должна содержать 50 разных песен.");
    const chosen = selectPopularTracks(snapshot, settings);
    return { collection, deck: await getCanonicalTracks(userId, chosen.map(track => track.id)), songOnly: aiSongOnly??new Set(snapshot.map(track=>track.artist)).size===1 };
  }
  const overrides = approvedOverrides();
  const deck = collectionTracks(collection).map((track: Track) => {
    const custom = overrides.get(track.id);
    // Catalog credentials may attach licensed media, never replace answer metadata.
    return custom ? { ...track, audioUrl: custom.audioUrl, videoUrl: custom.videoUrl, verseStart: custom.verseStart, verseEnd: custom.verseEnd, chorusStart: custom.chorusStart, rights: custom.rights } : track;
  });
  if (!deck.length || deck.some((track: Track) => !track.demoNotes?.length && !overrides.has(track.id))) throw new ApiError(409, "MEDIA_NOT_READY", "Для этой подборки ещё не подключены разрешённые аудиофрагменты. Попробуйте демо ECHO LAB.");
  return { collection, deck: selectPopularTracks(deck, settings), songOnly: new Set(deck.map(track=>track.artist)).size===1 };
}
export function catalogSummary() {
  return { collections: [...popularCollections, ...collections.map(collection => collectionSummary(collection)).filter(card => card.playable)], demo: collectionSummary(demoCollection) };
}
export function collectionSummary(collection: Collection, snapshot?: Track[]) {
  const approved = approvedOverrides(), deck = snapshot ?? collectionTracks(collection);
  const availableArtists = new Set(deck.map(track => track.artist.toLowerCase())).size;
  const artworkByArtist = new Map<string, string>();
  for (const track of deck) if (track.artworkUrl && !artworkByArtist.has(track.artist)) artworkByArtist.set(track.artist, track.artworkUrl);
  const images = [...new Set(artworkByArtist.values())].slice(0, 4);
  return { id: collection.id, title: collection.title, subtitle: collection.subtitle, color: collection.color, tag: collection.tag, images, artistNames: [...new Set(deck.map(track => track.artist))], image: collection.image ?? deck.find(track => track.artworkUrl)?.artworkUrl, category: collection.id.startsWith("custom-") ? "custom" : "genre", songOnly: availableArtists===1, count: deck.length, availableTracks: deck.length, availableArtists, supportedCounts: [10, 20, 50, 100].filter(count => count <= deck.length), supportedUniqueCounts: [10, 20, 50, 100].filter(count => count <= availableArtists), playable: deck.length > 0 && deck.every((track: Track) => !!track.demoNotes?.length || track.provider === "audius" || track.provider === "deezer" || approved.has(track.id)), ...(deck.every(track => track.provider === "audius") && deck.length ? { source: "audius" as const, live: true } : {}), ...(deck.every(track => track.provider === "deezer") && deck.length ? { source: "deezer" as const, live: true, popularity: { provider: "Deezer", metric: "rank", minimum: Math.min(...deck.map(track => track.popularityRank ?? 0)), maximum: Math.max(...deck.map(track => track.popularityRank ?? 0)) } } : {}) };
}
export async function catalogSummaryForUser(userId: string) {
  const progress=await database().prepare('SELECT unlocks FROM echo_progression WHERE user_id = ?').bind(userId).first<{unlocks:string}>();
  const hidden:Record<string,boolean>=progress?JSON.parse(progress.unlocks):{};
  const custom = await database().prepare("SELECT * FROM echo_collections WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").bind(userId).all<CustomRow>();
  const base = catalogSummary();
  base.collections = [...await popularCards(), ...base.collections.filter(card => !card.id.startsWith("popular-"))];
  return { ...base, collections: [...await Promise.all(custom.results.map(async row => {
    const snapshot=row.track_data ? await readJson<Track[]>(row.track_data) : undefined;
    const card=collectionSummary(customCollection(row),snapshot);
    const recipe=row.recipe?JSON.parse(row.recipe):undefined;
    let explicit=recipe?.ai?recipe.plan.artists.length||undefined:recipe?.artistIds?.length;
    if(explicit===undefined&&!recipe?.ai)try{const parsed=parsePopularPrompt(recipe?.prompt??row.title);if(parsed.explicitArtists)explicit=parsed.artists.length;}catch{/* A legacy unsupported recipe cannot hide the rest of the library. */}
    Object.assign(card,{ai:!!recipe?.ai,aiPrompt:recipe?.ai?recipe.prompt:undefined,aiPlan:recipe?.ai?recipe.plan:undefined,selectedArtistCount:explicit,...(recipe?.ai?{songOnly:explicit===1}: {})});
    return !recipe?.ai&&ukrainianPrompt(row.title)&&(!snapshot?.length||!snapshot.every(ukrainianTrackAllowed)) ? {...card,image:"https://upload.wikimedia.org/wikipedia/commons/4/49/Flag_of_Ukraine.svg",images:[],artistNames:[],supportedCounts:undefined,supportedUniqueCounts:undefined,availableTracks:undefined,availableArtists:undefined,playable:true} : card;
  })), ...base.collections].filter(card=>!hidden[`hidden:${card.id}`]) };
}

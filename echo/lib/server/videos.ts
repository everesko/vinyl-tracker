import type { Track } from "@/lib/quiz";
import { database } from "./http";
import { verifiedVideos } from "./video-registry";

type Recording = { id: string; title: string; disambiguation?:string; video?: boolean; "artist-credit"?: { name?: string; artist?: { name: string } }[]; relations?: { type: string; url?: { resource: string } }[] };
export type MusicVideo = { id: string; start: number; sourceUrl: string; source: "youtube" };
const normalize = (value: string) => (/\p{Script=Cyrillic}/u.test(value)?value.replace(/i/g,"і"):value).normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
const cleanTitle = (value: string) => value.replace(/\s*[([](?:remaster(?:ed)?|\d{4}\s*remaster(?:ed)?|single version|album version|kalush orchestra|feat\.?)[^\])]*[\])]/gi, "").trim();
export function youtubeId(value: string) {
  try { const u = new URL(value); const id = u.hostname === "youtu.be" ? u.pathname.slice(1) : ["www.youtube.com", "youtube.com"].includes(u.hostname) ? u.searchParams.get("v") : null; return id && /^[\w-]{11}$/.test(id) ? id : undefined; } catch { return undefined; }
}
export function sameRecording(recording: Recording, track: Pick<Track,"artist"|"title"|"titleAliases">) {
  return [track.title,...(track.titleAliases??[])].some(title=>normalize(cleanTitle(title))===normalize(cleanTitle(recording.title))) && recording["artist-credit"]?.some(credit => normalize(credit.artist?.name??credit.name??"")===normalize(track.artist));
}
let nextRequestAt = 0;
async function musicBrainz(path: string) {
  const slot = Math.max(Date.now(), nextRequestAt);
  if(slot-Date.now()>6000)throw new Error("Music metadata busy");
  nextRequestAt=slot+1100;
  if(slot>Date.now())await new Promise(resolve=>setTimeout(resolve,slot-Date.now()));
  const response=await fetch(`https://musicbrainz.org/ws/2/${path}`,{headers:{"User-Agent":"EchoMusicQuiz/1.0 (https://echo-music-quiz-danil.everesko1.chatgpt.site)",Accept:"application/json"},signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw new Error("Music metadata unavailable");return response.json();
}
const artistAliases:Record<string,string[]>={"okeanelzy":["океанельзи"],"kalush":["kalushorchestra"],"скрябін":["skryabin"],"антитіла":["antytila"],"христинасоловіи":["khrystynasoloviy"]};
const sameArtist=(a:string,b:string)=>{const x=normalize(a),y=normalize(b);return x===y||artistAliases[x]?.includes(y)||artistAliases[y]?.includes(x);};
export async function resolveMusicVideo(track: Track): Promise<MusicVideo|null> {
  const registered=verifiedVideos.find(item=>sameArtist(item.artist,track.artist)&&[track.title,...(track.titleAliases??[])].some(title=>normalize(cleanTitle(title))===normalize(item.title)));
  if(registered)return {id:registered.id,start:registered.start,source:"youtube",sourceUrl:`https://www.youtube.com/watch?v=${registered.id}`};
  const key=`music-video-v1:${track.id}`;
  const cached=await database().prepare("SELECT track_data, updated_at FROM echo_media_collections WHERE id = ?").bind(key).first<{track_data:string;updated_at:number}>();
  if(cached&&cached.updated_at>Date.now()-86400000)return JSON.parse(cached.track_data) as MusicVideo|null;
  let video:MusicVideo|null=null;
  try {
    const escape=(value:string)=>value.replace(/["\\]/g," ");
    const query=`recording:"${escape(cleanTitle(track.title))}" AND artist:"${escape(track.artist)}" AND video:true AND NOT comment:live`;
    const result=await musicBrainz(`recording?fmt=json&limit=8&query=${encodeURIComponent(query)}`) as {recordings?:Recording[]};
    const candidates=(result.recordings??[]).filter(item=>item.video&&sameRecording(item,track)&&!/(?:live|karaoke|lyric|audio only|concert|making.of|remix)/i.test(`${item.title} ${item.disambiguation??""}`)).sort((a,b)=>Number(/official|music video/i.test(b.disambiguation??""))-Number(/official|music video/i.test(a.disambiguation??""))).slice(0,3);
    for(const candidate of candidates) {
      if(!/^[a-f0-9-]{36}$/.test(candidate.id))continue;
      const full=await musicBrainz(`recording/${candidate.id}?fmt=json&inc=artist-credits+url-rels`) as Recording;
      if(!full.video||!sameRecording(full,track))continue;
      const id=full.relations?.filter(relation=>relation.type==="free streaming"||relation.type==="streaming").map(relation=>youtubeId(relation.url?.resource??"")).find(Boolean);
      if(id){video={id,start:45,source:"youtube",sourceUrl:`https://www.youtube.com/watch?v=${id}`};break;}
    }
  } catch { return null; } // Transient provider errors never become durable missing-video entries.
  await database().prepare("INSERT INTO echo_media_collections (id, track_data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET track_data = excluded.track_data, updated_at = excluded.updated_at").bind(key,JSON.stringify(video),Date.now()).run();
  return video;
}

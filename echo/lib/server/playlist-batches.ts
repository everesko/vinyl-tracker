import type {Track} from '@/lib/quiz';
import {database} from './http';
import {readJson,storeJson} from './stored-json';
import {deezerRequest,eligibleRecording,recordingTrack,resolveArtist,rememberDiscoveredArtist} from './popular';
import type {PlaylistPlan} from '../playlist-plan';

const norm=(v:string)=>v.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const canonical=(v:string)=>v.normalize('NFC').trim().toLowerCase().replace(/\s+/g,' ');
async function hash(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function put(id:string,value:unknown){await database().prepare('INSERT INTO echo_media_collections(id,track_data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at').bind(id,await storeJson(id,value),Date.now()).run();}
async function read<T>(id:string){const row=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id=?').bind(id).first<{track_data:string;updated_at:number}>();return row?{value:await readJson<T>(row.track_data),at:row.updated_at}:null;}

export async function mapConcurrent<T,R>(items:T[],limit:number,work:(item:T,index:number)=>Promise<R>):Promise<R[]>{
 const output:R[]=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const index=next++;output[index]=await work(items[index],index);}}));
 return output;
}
async function conditionKey(owner:string,plan:PlaylistPlan,difficulty:number,prompt:string){return hash([owner,canonical(prompt),difficulty,plan.criteria.map(canonical).sort(),plan.artists.map(norm).sort(),[...plan.genres].sort(),plan.language?.toLowerCase()??null,plan.years]);}
type MiniCategory={owner:string;title:string;prompt:string;difficulty:number;expires:number;tracks:Track[];facets:{kind:string;label:string}[]};
export async function readMiniCategory(owner:string,plan:PlaylistPlan,difficulty:number,prompt:string){
 const saved=await read<MiniCategory>('ai-mini-v1:'+await hash(owner)+':'+await conditionKey(owner,plan,difficulty,prompt));
 return saved?.value.owner===owner&&saved.value.expires>Date.now()?saved.value:null;
}
export async function indexMiniCategory(owner:string,plan:PlaylistPlan,difficulty:number,tracks:Track[],expires:number,prompt:string){
 const facets=[...plan.genres.map(label=>({kind:'genre',label})),...(plan.language?[{kind:'language',label:plan.language}]:[]),...(plan.years?[{kind:'era',label:plan.years.from+'–'+plan.years.to}]:[]),...plan.criteria.map(label=>({kind:'theme',label}))];
 const key=await conditionKey(owner,plan,difficulty,prompt);
 await put('ai-mini-v1:'+await hash(owner)+':'+key,{owner,title:plan.title,prompt,difficulty,expires,tracks,facets});
 // Facet membership is indexed by primary key. Combined conditions still need their own proof.
 await mapConcurrent(facets,4,async facet=>{await put('ai-mini-facet-v1:'+await hash([owner,facet.kind,canonical(facet.label)])+':'+key,{category:key,facet,expires,count:tracks.length});});
 return facets.length;
}

export async function listMiniCategories(owner:string){
 const prefix='ai-mini-v1:'+await hash(owner)+':';
 // Indexed range avoids D1's short LIKE/GLOB pattern limit for SHA-256 keys.
 const rows=await database().prepare('SELECT track_data FROM echo_media_collections WHERE id >= ? AND id < ? ORDER BY updated_at DESC LIMIT 32').bind(prefix,prefix.slice(0,-1)+';').all<{track_data:string}>();
 const categories=await Promise.all(rows.results.map(row=>readJson<MiniCategory>(row.track_data)));
 const seen=new Set<string>();return categories.filter(c=>{const key=canonical(c.prompt);if(c.owner!==owner||c.expires<=Date.now()||seen.has(key))return false;seen.add(key);return true;}).slice(0,12).map(c=>({title:c.title,prompt:c.prompt,count:c.tracks.length,difficulty:c.difficulty,facets:c.facets}));
}

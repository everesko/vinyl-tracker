import type {PlaylistPlan} from './server/ai-playlists';

export type SongName={artist:string;title:string};
export const songKey=(song:SongName)=>[song.artist,song.title].map(v=>v.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')).join(':');

// Formatting is not evidence of availability. Every parsed pair must still resolve in Deezer.
export function parseSongList(value:string,limit=64):SongName[]{
 const text=value.replace(/<think>[\s\S]*?<\/think>/gi,'').trim().replace(/^```[^\n]*\n?|\n?```$/g,'');
 const clean=(v:string)=>v.trim().replace(/^\*\*|\*\*$/g,'').replace(/^["“«]|["”»]$/g,'').trim();
 const line=(v:string):SongName|null=>{
  const row=v.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s*)/,'');
  if(/^(?:https?:|#|@)/i.test(row)||/^(?:artist|автор|виконавець)\s*:\s*(?:title|название|назва)\s*$/i.test(row))return null;
  const match=/^(.+?)\s*[:：]\s*(.+)$/.exec(row)??/^(.+?)\s+[–—-]\s+(.+)$/.exec(row);
  return match?{artist:clean(match[1]),title:clean(match[2])}:null;
 };
 let rows:unknown[]=[];
 try{const parsed=JSON.parse(text);rows=Array.isArray(parsed)?parsed:Array.isArray(parsed?.tracks)?parsed.tracks:[];}catch{
  // A token-limited response can still contain complete rows. Ignore its unfinished final row.
  rows=text.split(/\r?\n/).map(line);
  if(/^[{[]/.test(text))rows=[...text.matchAll(/\{\s*"artist"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"title"\s*:\s*("(?:\\.|[^"\\])*")\s*\}/g)].flatMap(m=>{try{return[{artist:JSON.parse(m[1]),title:JSON.parse(m[2])}];}catch{return[];}});
 }
 const seen=new Set<string>(),songs:SongName[]=[];
 for(const row of rows){const pair=typeof row==='string'?line(row):Array.isArray(row)?{artist:row[0],title:row[1]}:row as SongName|null;
  if(!pair||typeof pair.artist!=='string'||typeof pair.title!=='string')continue;
  const song={artist:clean(pair.artist),title:clean(pair.title)};
  if(!song.artist||!song.title||song.artist.length>150||song.title.length>200||!/[\p{L}\p{N}]/u.test(song.artist)||!/[\p{L}\p{N}]/u.test(song.title)||/https?:\/\//i.test(song.artist+song.title))continue;
  const key=songKey(song);if(seen.has(key))continue;seen.add(key);songs.push(song);if(songs.length>=limit)break;
 }
 return songs;
}

// The full request remains the AI's instruction. Extract explicit catalog constraints without an extra AI call.
export function planFromPrompt(prompt:string):PlaylistPlan{
 const text=prompt.normalize('NFC').trim().replace(/\s+/g,' '),lower=text.toLowerCase();
 let years:PlaylistPlan['years']=null;
 const range=/\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b/.exec(lower);
 const decades=[...lower.matchAll(/(?:^|[^\d])((?:19|20)?[0-9]0)(?:\s*[-–]?\s*(?:х|ті|ые|s)|\s*р(?:ок|ік)|\s*год)/g)].map(m=>{const n=Number(m[1]);return n<100?(n>=30?1900+n:2000+n):n;});
 if(range&&Number(range[1])<=Number(range[2]))years={from:Number(range[1]),to:Number(range[2])};
 else if(new Set(decades).size===1)years={from:decades[0],to:decades[0]+9};
 else if(/\b(?:noughties|2000s)\b/.test(lower))years={from:2000,to:2009};
 const language=!/(?:без|не|except|excluding)\s+(?:укра[їи]н|ukrain)/i.test(lower)&&/укра[їи]н|ukrain/i.test(lower)?'Ukrainian':/англ[іи]йськ|английск|english.language|english.lyrics/i.test(lower)?'English':null;
 const definitions:[string,RegExp][]=[['classic-rock',/класичн\w* рок|классическ\w* рок|classic rock/],['indie-rock',/інді.рок|инди.рок|indie rock/],['pop-punk',/поп.п[ау]нк|pop.punk/],['synth-pop',/синт.поп|synth.pop/],['alternative',/альтернатив|alternative/],['metal',/метал|metal/],['hiphop',/хіп.хоп|хип.хоп|hip.hop/],['rnb',/r[&n]b|ар.ен.бі/],['country',/кантрі|кантри|country/],['jazz',/джаз|jazz/],['dance',/танцювальн|танцевальн|dance/],['punk',/панк|punk/],['rock',/рок|rock/],['pop',/(?:^|\s)поп(?:\s|$)|(?:^|\s)pop(?:\s|$)/]];
 const positive=lower.replace(/(?:без|except|excluding)\s+[^,;.]+/g,'');let genres=definitions.filter(([,re])=>re.test(positive)).map(([name])=>name);
 if(genres.some(g=>['classic-rock','indie-rock','pop-punk'].includes(g)))genres=genres.filter(g=>g!=='rock'&&g!=='punk'&&g!=='pop');if(genres.includes('synth-pop'))genres=genres.filter(g=>g!=='pop');
 const named=/(?:пісні|песни|треки|songs|tracks|hits)\s+(?:(гурту|группы|виконавця|исполнителя|артиста|by|of|від|от)\s+)?(.+)$/i.exec(text);
 const name=named?.[2]?.replace(/\s+(?:за|из|з|from|без|without)\s+.+$/i,'').trim();
 const artists=name&&(named?.[1]||!years&&!language&&!genres.length)&&!(/^(?:для|про|о|на|for|about|with|of the|that|which|the)(?:\s|$)|[\d,:;]|балад|романт|хіт|хит|love|ballad|romanti|популяр|popular/i.test(name))?name.split(/\s+(?:і|и|and|та)\s+|\s*&\s*/).filter(Boolean):[];
 const criteria=text.match(/.{1,250}(?:\s|$)|.{1,250}/g)??[text];
 return{title:text.slice(0,100),criteria:criteria.map(v=>v.trim()),artists,genres,language,years};
}

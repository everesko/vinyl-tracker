import {ApiError,database} from './http';
const CHUNK=160000;
export async function storeJson(key:string,value:unknown):Promise<string>{
 const text=JSON.stringify(value);if(text.length<=CHUNK)return text;
 const revision=crypto.randomUUID(),parts:string[]=[];
 for(let index=0;index<text.length;index+=CHUNK){const id=`json-part:${key}:${revision}:${parts.length}`;parts.push(id);await database().prepare('INSERT INTO echo_media_collections (id,track_data,updated_at) VALUES (?,?,?)').bind(id,JSON.stringify(text.slice(index,index+CHUNK)),Date.now()).run()}
 return JSON.stringify({$echoChunks:parts});
}
export async function readJson<T>(text:string):Promise<T>{
 const value=JSON.parse(text);if(!value?.$echoChunks)return value as T;
 if(!Array.isArray(value.$echoChunks)||!value.$echoChunks.every((key:unknown)=>typeof key==='string'&&key.startsWith('json-part:')))throw new ApiError(409,'INVALID_SNAPSHOT','Сохранённые данные повреждены.');
 const result:string[]=[];for(const id of value.$echoChunks){const row=await database().prepare('SELECT track_data FROM echo_media_collections WHERE id = ?').bind(id).first<{track_data:string}>();if(!row)throw new ApiError(409,'INVALID_SNAPSHOT','Сохранённые данные недоступны.');result.push(JSON.parse(row.track_data))}return JSON.parse(result.join('')) as T;
}

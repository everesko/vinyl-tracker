import {ApiError} from './server/http';
export type PlaylistPlan={title:string;criteria:string[];artists:string[];genres:string[];language:string|null;years:{from:number;to:number}|null};
const supported=new Set(['rock','classic-rock','indie-rock','pop-punk','synth-pop','alternative','pop','metal','hiphop','dance','rnb','punk','country','jazz']);
export function validatePlan(value:any):PlaylistPlan{
 if(!value||typeof value.title!=='string'||!value.title.trim()||value.title.length>100||!Array.isArray(value.criteria)||!value.criteria.length||value.criteria.length>16||!value.criteria.every((v:any)=>typeof v==='string'&&v.length<=250)||!Array.isArray(value.artists)||value.artists.length>100||!value.artists.every((v:any)=>typeof v==='string'&&v.length<=100)||!Array.isArray(value.genres)||value.genres.length>16||!value.genres.every((v:any)=>supported.has(v))||!(value.language===null||typeof value.language==='string'&&value.language.length<=80))throw new ApiError(400,'AI_INVALID_PLAN','ИИ вернул некорректные условия подборки. Повторите запрос.');
 if(value.years!==null&&(!value.years||!Number.isInteger(value.years.from)||!Number.isInteger(value.years.to)||value.years.from<1900||value.years.to>2100||value.years.to<value.years.from))throw new ApiError(400,'AI_INVALID_PLAN','Некорректный диапазон лет.');
 return {title:value.title.trim(),criteria:value.criteria,artists:[...new Set<string>(value.artists)],genres:[...new Set<string>(value.genres)],language:value.language,years:value.years};
}

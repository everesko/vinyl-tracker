import {difficultyLevel,type Difficulty} from './quiz';

/** Enough verified alternatives to draw different popularity bands, without an unbounded AI crawl. */
export function playlistPoolTarget(count:number,difficulty?:Difficulty){
 return Math.max(count,Math.ceil(count*(1.5+(difficultyLevel(difficulty)-1)/6)));
}
export function playlistProgress(available:number,count:number,poolTarget:number){
 return Math.min(count,Math.floor(available*count/Math.max(count,poolTarget)));
}

export type CollectionInfo = {id:string;title:string;subtitle:string;color:string;tag:string;art:string;word:string;count?:number;playable?:boolean};
export const collectionInfo: CollectionInfo[] = [
 {id:'rock',title:'Рок-песни',subtitle:'От Queen до Linkin Park',color:'#3775ed',tag:'ROCK',art:'rock',word:'LOUD.'},
 {id:'poppunk',title:'Поп-панк',subtitle:'Громко, быстро, навсегда',color:'#ff637b',tag:'POP PUNK',art:'pop',word:'REBEL.'},
 {id:'alternative',title:'Альтернатива',subtitle:'По ту сторону мейнстрима',color:'#91ba67',tag:'ALTERNATIVE',art:'rock',word:'OTHER.'},
 {id:'pop',title:'Поп-хиты',subtitle:'Те самые песни на повторе',color:'#e893c7',tag:'POP',art:'pop',word:'REPEAT.'},
 {id:'80s',title:'Хиты 80-х',subtitle:'Синтезаторы и большие чувства',color:'#cba5ff',tag:'80s',art:'disco',word:'80s.'},
 {id:'00s',title:'Хиты 00-х',subtitle:'Верни свой первый плейлист',color:'#eea65c',tag:'00s',art:'pop',word:'00s.'},
 {id:'eurovision',title:'Евровидение',subtitle:'Большая сцена. Большие хиты.',color:'#8f85ed',tag:'EUROVISION',art:'disco',word:'EURO.'},
];
export const demoInfo: CollectionInfo = {id:'demo',title:'ECHO Lab',subtitle:'Оригинальные демомелодии',color:'#d8fc71',tag:'DEMO',art:'disco',word:'PLAY.',count:50,playable:true};

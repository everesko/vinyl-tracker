import { difficultyLevel, type Settings } from './quiz';
export const upgrades = [
 ...Array.from({length:9},(_,i)=>({id:`difficulty-${i+2}`,kind:'difficulty',value:i+2,cost:50+(i+1)*50,requires:i?`difficulty-${i+1}`:undefined})),
 {id:'duration-5',kind:'duration',value:5,cost:150,requires:undefined},{id:'duration-3',kind:'duration',value:3,cost:350,requires:'duration-5'},
 {id:'timer',kind:'timer',value:1,cost:200,requires:undefined},
 {id:'count-20',kind:'count',value:20,cost:100,requires:undefined},{id:'count-50',kind:'count',value:50,cost:250,requires:'count-20'},
 {id:'count-100',kind:'count',value:100,cost:500,requires:'count-50'},{id:'count-unlimited',kind:'count',value:Infinity,cost:1000,requires:'count-100'},
] as const;
export type Progression={practice:boolean;unlocks:Record<string,boolean>;resetAvailableAt:number};
export function difficultyCap(progress?:Progression){return progress?.practice?10:Math.max(1,...upgrades.filter(u=>u.kind==='difficulty'&&progress?.unlocks?.[u.id]).map(u=>u.value));}
export function countCap(progress?:Progression){return progress?.practice?Infinity:Math.max(10,...upgrades.filter(u=>u.kind==='count'&&progress?.unlocks?.[u.id]).map(u=>u.value));}
export function purchased(id:string,progress?:Progression){return !!progress?.unlocks?.[id]||id.startsWith('difficulty-')&&difficultyCap({...progress!,practice:false})>=Number(id.slice(11))||id==='duration-5'&&!!progress?.unlocks?.['duration-3']||id.startsWith('count-')&&countCap({...progress!,practice:false})>=(id==='count-unlimited'?Infinity:Number(id.slice(6)));}
export function permitted(id:string,progress?:Progression){return !!progress?.practice||purchased(id,progress);}
export function nextRequired(id:string,progress?:Progression):string|undefined {const upgrade=upgrades.find(u=>u.id===id);if(!upgrade)return;return upgrade.requires&&!purchased(upgrade.requires,progress)?nextRequired(upgrade.requires,progress)??upgrade.requires:id;}
export function availableSettings(settings:Settings,progress?:Progression):Settings{
 return {...settings,difficulty:Math.min(difficultyLevel(settings.difficulty),difficultyCap(progress)),duration:settings.duration===3&&permitted('duration-3',progress)?3:settings.duration<=5&&permitted('duration-5',progress)?5:7,timer:settings.timer&&permitted('timer',progress),count:Math.min(settings.count??10,countCap(progress))};
}

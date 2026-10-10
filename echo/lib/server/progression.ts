import { availableSettings, upgrades, purchased, type Progression } from '@/lib/progression';
import { type Settings } from '@/lib/quiz';
import { ApiError,database } from './http';

export async function progressFor(userId:string):Promise<Progression>{
 const db=database();const [row,reset]=await Promise.all([db.prepare('SELECT * FROM echo_progression WHERE user_id = ?').bind(userId).first<{unlocks:string;practice:number}>(),db.prepare('SELECT reset_at FROM echo_profile_balances WHERE user_id = ?').bind(userId).first<{reset_at:number}>()]);
 return {practice:!!row?.practice,unlocks:row?JSON.parse(row.unlocks):{},resetAvailableAt:reset?reset.reset_at+86400000:0};
}
export async function wallet(userId:string){const row=await database().prepare('SELECT MAX(0, CAST(ROUND(COALESCE((SELECT SUM(xp) FROM echo_games WHERE user_id = ? AND finished = 1),0)*10) AS INTEGER) - COALESCE((SELECT offset_tenths FROM echo_profile_balances WHERE user_id = ?),0) - COALESCE((SELECT spent_tenths FROM echo_progression WHERE user_id = ?),0)) / 10.0 AS xp').bind(userId,userId,userId).first<{xp:number}>();return row?.xp??0;}
export async function ensureSettings(userId:string,settings:Settings,practice?:boolean){const progress=await progressFor(userId);if(practice!==undefined)progress.practice=practice;const allowed=availableSettings(settings,progress);if(['duration','difficulty','timer','count'].some(key=>allowed[key as keyof Settings]!==settings[key as keyof Settings]))throw new ApiError(403,'SETTING_LOCKED','Откройте настройку за XP в профиле или включите тренировку без очков.');return progress;}
export async function profileAction(userId:string,payload:Record<string,unknown>){
 const db=database(),now=Date.now();
 if(payload.action==='practice'){
  if(typeof payload.practice!=='boolean')throw new ApiError(400,'INVALID_SETTINGS','Укажите режим игры.');
  await db.prepare("INSERT INTO echo_progression (user_id,practice) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET practice = excluded.practice").bind(userId,payload.practice?1:0).run();return {updated:true};
 }
 if(payload.action==='unlock'){
  const upgrade=upgrades.find(item=>item.id===payload.id);if(!upgrade)throw new ApiError(400,'INVALID_UPGRADE','Настройка не найдена.');
  const prior=await progressFor(userId);if(purchased(upgrade.id,prior))return {unlocked:upgrade.id};
  if(upgrade.requires&&!purchased(upgrade.requires,prior))throw new ApiError(409,'UPGRADE_ORDER','Сначала откройте предыдущую ступень.',{required:upgrade.requires});
  await db.prepare('INSERT INTO echo_progression (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING').bind(userId).run();
  const row=await db.prepare("UPDATE echo_progression SET spent_tenths = spent_tenths + ?, unlocks = json_set(unlocks, ?, json('true')) WHERE user_id = ? AND COALESCE(json_extract(unlocks, ?),0) = 0 AND CAST(ROUND(COALESCE((SELECT SUM(xp) FROM echo_games WHERE user_id = ? AND finished = 1),0)*10) AS INTEGER) - COALESCE((SELECT offset_tenths FROM echo_profile_balances WHERE user_id = ?),0) - spent_tenths >= ? AND (? IS NULL OR COALESCE(json_extract(unlocks, ?),0) = 1) RETURNING user_id").bind(upgrade.cost*10,`$."${upgrade.id}"`,userId,`$."${upgrade.id}"`,userId,userId,upgrade.cost*10,upgrade.requires??null,`$."${upgrade.requires??""}"`).first();
  if(!row&&!(await progressFor(userId)).unlocks[upgrade.id])throw new ApiError(409,'INSUFFICIENT_XP','Недостаточно XP для открытия настройки.');return {unlocked:upgrade.id};
 }
 if(payload.action!==undefined&&payload.action!=='reset')throw new ApiError(400,'INVALID_ACTION','Неизвестное действие.');
 const row=await db.prepare('INSERT INTO echo_profile_balances (user_id,offset_tenths,reset_at) SELECT ?, CAST(ROUND(COALESCE((SELECT SUM(xp) FROM echo_games WHERE user_id = ? AND finished = 1),0)*10) AS INTEGER) - COALESCE((SELECT spent_tenths FROM echo_progression WHERE user_id = ?),0), ? ON CONFLICT(user_id) DO UPDATE SET offset_tenths = excluded.offset_tenths,reset_at = excluded.reset_at WHERE echo_profile_balances.reset_at <= ? RETURNING user_id').bind(userId,userId,userId,now,now-86400000).first();
 if(!row)throw new ApiError(429,'RESET_COOLDOWN','Баланс можно сбросить раз в 24 часа.',{resetAvailableAt:(await progressFor(userId)).resetAvailableAt});return {reset:true};
}

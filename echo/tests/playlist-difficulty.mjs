import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const module={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/playlist-difficulty.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Number,Math,Map,Set});
const {difficultyPolicy,selectDifficultyTracks,categoryPopularityPercentiles,recognitionMatchesDifficulty,playlistArtistKey}=module.exports;
const plain=value=>JSON.parse(JSON.stringify(value));

test('each slider value has its own familiarity instructions and monotonically harder measured target',()=>{
  const policies=Array.from({length:10},(_,index)=>difficultyPolicy(index+1));
  assert.equal(new Set(policies.map(policy=>policy.label)).size,10);
  assert.equal(new Set(policies.map(policy=>policy.promptInstruction)).size,10);
  for(let index=1;index<policies.length;index++){
    assert.ok(policies[index].targetPopularityPercentile<policies[index-1].targetPopularityPercentile);
    assert.ok(policies[index].minRecognition<=policies[index-1].minRecognition);
    assert.ok(policies[index].maxRecognition<=policies[index-1].maxRecognition);
  }
  assert.equal(difficultyPolicy(-5).level,1);assert.equal(difficultyPolicy(18).level,10);assert.equal(difficultyPolicy(NaN).level,1);
});

test('difficulty preserves language, era, exact romantic mood and explicit hit requirements',()=>{
  for(let level=1;level<=10;level++){
    const instruction=difficultyPolicy(level).promptInstruction;
    assert.ok(instruction.includes('language, place, era, genre and mood'));
    assert.ok(instruction.includes('romantic and a ballad'));
    assert.ok(instruction.includes('rather than changing to non-hits'));
    assert.equal(difficultyPolicy(level).catalogRankReference,'within-category');
  }
});

test('a slider change deterministically changes catalog popularity preference without global cutoffs',()=>{
  const regional=Array.from({length:11},(_,index)=>({artist:`Український виконавець ${index}`,popularityRank:10+index,title:String(index)}));
  assert.equal(selectDifficultyTracks(regional,1,1)[0].title,'10');
  assert.equal(selectDifficultyTracks(regional,1,10)[0].title,'0');
  assert.deepEqual(plain(selectDifficultyTracks(regional,3,5)),plain(selectDifficultyTracks(regional,3,5)));
  assert.equal(selectDifficultyTracks(regional,11,1).length,11);
});

test('unknown rank is never interpreted as evidence of an obscure track; equal ranks tie equally',()=>{
  assert.deepEqual(plain(categoryPopularityPercentiles([{artist:'A',rank:0},{artist:'B'},{artist:'C',rank:1},{artist:'D',rank:1},{artist:'E',rank:3}])),[null,null,25,25,100]);
  assert.deepEqual(plain(categoryPopularityPercentiles([{artist:'A',rank:10}])),[50]);
  assert.deepEqual(plain(selectDifficultyTracks([{artist:'A'},{artist:'B'},{artist:'C'}],2,10)).map(track=>track.artist),['A','B']);
});

test('Gemini recognition values outside the selected difficulty never sneak into a full result',()=>{
  const songs=[{artist:'Iconic',rank:1000,recognition:10},{artist:'Niche',rank:10,recognition:2}];
  assert.deepEqual(plain(selectDifficultyTracks(songs,2,1)).map(track=>track.artist),['Iconic']);
  assert.deepEqual(plain(selectDifficultyTracks(songs,2,10)).map(track=>track.artist),['Niche']);
  assert.equal(recognitionMatchesDifficulty(NaN,4),false);
  assert.equal(recognitionMatchesDifficulty(11,1),false);
});

test('allowing repeated performers never repeats while enough other suitable performers exist',()=>{
  const songs=[{artist:'A',catalogArtistId:1,rank:100},{artist:'A alias',catalogArtistId:1,rank:99},{artist:'B',catalogArtistId:2,rank:70},{artist:'C',catalogArtistId:3,rank:60}];
  for(const allowArtistRepeats of [false,true]){
    const result=selectDifficultyTracks(songs,3,1,{allowArtistRepeats});
    assert.equal(new Set(result.map(playlistArtistKey)).size,3);
  }
  assert.equal(selectDifficultyTracks(songs,4,1,{allowArtistRepeats:false}).length,3);
  assert.equal(selectDifficultyTracks(songs,4,1,{allowArtistRepeats:true}).length,4);
});

test('catalog identity dominates spelling; fallback artist normalization collapses typographic variants',()=>{
  assert.equal(playlistArtistKey({artist:'A',catalogArtistId:5}),playlistArtistKey({artist:'A alias',catalogArtistId:5}));
  assert.equal(playlistArtistKey({artist:'Океан Ельзи'}),playlistArtistKey({artist:'ОКЕАН-ЕЛЬЗИ'}));
  assert.equal(playlistArtistKey({artist:{name:'Artist',id:7}}),'id:7');
  assert.equal(playlistArtistKey({artist:'Artist',catalogArtistId:0}),'name:artist');
});

import type { Track } from './quiz';
/** Preserve the draw, but separate artist runs whenever another artist remains. */
export function spreadArtists<T extends Pick<Track,'artist'>>(tracks:T[]):T[]{
 const groups=new Map<string,T[]>();
 for(const track of tracks){const key=track.artist.normalize('NFKC').toLocaleLowerCase().trim();const group=groups.get(key)??[];group.push(track);groups.set(key,group)}
 const output:T[]=[];let last='';
 while(groups.size){let choice='';let largest=-1;for(const [key,group]of groups){if(key!==last&&group.length>largest){choice=key;largest=group.length}}
  if(largest<0)choice=groups.keys().next().value!;
  const group=groups.get(choice)!;output.push(group.shift()!);if(!group.length)groups.delete(choice);last=choice;
 }return output;
}

/** Public, deterministic playlist recipes. Recordings are always resolved from Deezer. */
export type LibraryDirection = {
  slug: string;
  titles: { uk: string; en: string; ru: string };
  category: 'genre' | 'era' | 'mix';
  genre?: string;
  decade?: number;
  region?: 'UA';
  theme?: 'ballads';
  artists?: string[];
};

const eraGenres: [string, string, string, string, number[]][] = [
  ['rock', 'Рок', 'Rock', 'Рок', [1970, 1980, 1990, 2000, 2010]],
  ['pop', 'Поп', 'Pop', 'Поп', [1970, 1980, 1990, 2000, 2010, 2020]],
  ['alternative', 'Альтернатива', 'Alternative', 'Альтернатива', [1990, 2000, 2010]],
  ['dance', 'Танцювальні хіти', 'Dance hits', 'Танцевальные хиты', [1990, 2000, 2010]],
  ['hiphop', 'Хіп-хоп', 'Hip-hop', 'Хип-хоп', [1990]],
];
const genreEras: LibraryDirection[] = eraGenres.flatMap(([genre, uk, en, ru, decades]) => decades.map(decade => ({
  slug: `${genre}-${decade}`, category: 'era', genre, decade,
  titles: { uk: `${uk} ${String(decade).slice(2)}-х`, en: `${en} · ${decade}s`, ru: `${ru} ${String(decade).slice(2)}-х` },
})));

const ukrainian: LibraryDirection[] = [
  { slug: 'ua-hits', category: 'mix', region: 'UA', titles: { uk: 'Українські хіти', en: 'Ukrainian hits', ru: 'Украинские хиты' } },
  { slug: 'ua-rock', category: 'genre', genre: 'rock', region: 'UA', titles: { uk: 'Український рок', en: 'Ukrainian rock', ru: 'Украинский рок' } },
  { slug: 'ua-pop', category: 'genre', genre: 'pop', region: 'UA', titles: { uk: 'Український поп', en: 'Ukrainian pop', ru: 'Украинский поп' } },
  ...[1990, 2000, 2010, 2020].map(decade => ({
    slug: `ua-${decade}`, category: 'era' as const, region: 'UA' as const, decade,
    titles: { uk: `Українські хіти ${String(decade).slice(2)}-х`, en: `Ukrainian hits · ${decade}s`, ru: `Украинские хиты ${String(decade).slice(2)}-х` },
  })),
  { slug: 'ua-ballads', category: 'genre', region: 'UA', theme: 'ballads', titles: { uk: 'Українські романтичні балади', en: 'Ukrainian romantic ballads', ru: 'Украинские романтические баллады' } },
];
const romanticEras: LibraryDirection[] = [1980, 1990, 2000, 2010].map(decade => ({
  slug: `ballads-${decade}`, category: 'era', theme: 'ballads', decade,
  titles: { uk: `Романтичні балади ${String(decade).slice(2)}-х`, en: `Romantic ballads · ${decade}s`, ru: `Романтические баллады ${String(decade).slice(2)}-х` },
}));

// Exact artist mixes reuse checked previews, without asserting a mood or release decade.
const artistMixes: [string, string[]][] = [
  ['mix-british-icons', ['Queen', 'The Beatles', 'Coldplay', 'Muse', 'Depeche Mode']],
  ['mix-american-icons', ['Michael Jackson', 'Madonna', 'Beyoncé', 'Bruno Mars', 'Taylor Swift']],
  ['mix-ukrainian-bands', ['Okean Elzy', 'The Hardkiss', 'Антитіла', 'Бумбокс']],
  ['mix-guitar-giants', ['Nirvana', 'Green Day', 'Red Hot Chili Peppers', 'Metallica']],
  ['mix-queen-bonjovi-coldplay', ['Queen', 'Bon Jovi', 'Coldplay']],
  ['mix-pop-queens', ['Madonna', 'Lady Gaga', 'Dua Lipa', 'Katy Perry']],
  ['mix-songwriter-voices', ['Ed Sheeran', 'Taylor Swift', 'Adele', 'Bruno Mars']],
  ['mix-abba-dualipa-rihanna', ['ABBA', 'Dua Lipa', 'Rihanna']],
  ['mix-nirvana-muse-arctic', ['Nirvana', 'Muse', 'Arctic Monkeys']],
  ['mix-metallica-linkin-greenday', ['Metallica', 'Linkin Park', 'Green Day']],
  ['mix-beatles-abba-queen', ['The Beatles', 'ABBA', 'Queen']],
  ['mix-coldplay-imagine-maroon', ['Coldplay', 'Imagine Dragons', 'Maroon 5']],
  ['mix-eminem-rihanna-beyonce', ['Eminem', 'Rihanna', 'Beyoncé']],
  ['mix-beyonce-rihanna-britney', ['Beyoncé', 'Rihanna', 'Britney Spears']],
  ['mix-madonna-michael-abba', ['Madonna', 'Michael Jackson', 'ABBA']],
  ['mix-arctic-muse-rhcp', ['Arctic Monkeys', 'Muse', 'Red Hot Chili Peppers']],
];
const mixNames: Record<string, { uk: string; en: string; ru: string }> = {
  'mix-british-icons': { uk: 'Британські ікони', en: 'British icons', ru: 'Британские иконы' },
  'mix-american-icons': { uk: 'Американські ікони', en: 'American icons', ru: 'Американские иконы' },
  'mix-ukrainian-bands': { uk: 'Українські гурти', en: 'Ukrainian bands', ru: 'Украинские группы' },
  'mix-guitar-giants': { uk: 'Гітарні гіганти', en: 'Guitar giants', ru: 'Гитарные гиганты' },
  'mix-pop-queens': { uk: 'Королеви попмузики', en: 'Pop queens', ru: 'Королевы поп-музыки' },
  'mix-songwriter-voices': { uk: 'Голоси та історії', en: 'Voices and stories', ru: 'Голоса и истории' },
};

export const additionalDirections: LibraryDirection[] = [
  ...genreEras, ...ukrainian, ...romanticEras,
  ...artistMixes.map(([slug, artists]) => ({
    slug, artists, category: 'mix' as const, ...(slug === 'mix-ukrainian-bands' ? { region: 'UA' as const } : {}),
    titles: mixNames[slug] ?? { uk: artists.join(' × '), en: artists.join(' × '), ru: artists.join(' × ') },
  })),
];

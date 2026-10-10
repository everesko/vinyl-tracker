import type { Collection, Track } from './quiz';

// Metadata only. These entries do not grant playback rights and contain no invented media URLs.
// A real recording becomes playable only after a licensed source is supplied by the application.
const library = new Map<string, Track>();
function addRows(genre: string, rows: string): string[] {
  return rows.trim().split('\n').map(row => {
    const [artist, title, year] = row.trim().split('|');
    const id = `${artist}-${title}`.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = library.get(id);
    if (existing) { if (!existing.genres.includes(genre)) existing.genres.push(genre); return id; }
    library.set(id, { id, artist, title, year: Number(year), genres: [genre], rights: 'Метаданные. Для воспроизведения требуется разрешённый аудиоисточник.' });
    return id;
  });
}

const rock = addRows('rock', `
Queen|Bohemian Rhapsody|1975
Queen|We Will Rock You|1977
Queen|Don't Stop Me Now|1978
AC/DC|Back in Black|1980
AC/DC|Thunderstruck|1990
AC/DC|Highway to Hell|1979
Led Zeppelin|Stairway to Heaven|1971
Led Zeppelin|Whole Lotta Love|1969
Deep Purple|Smoke on the Water|1972
Deep Purple|Highway Star|1972
Guns N' Roses|Sweet Child O' Mine|1987
Guns N' Roses|Welcome to the Jungle|1987
Guns N' Roses|November Rain|1991
Metallica|Enter Sandman|1991
Metallica|Nothing Else Matters|1991
Metallica|Master of Puppets|1986
Nirvana|Smells Like Teen Spirit|1991
Nirvana|Come as You Are|1991
The Rolling Stones|Paint It Black|1966
The Rolling Stones|Satisfaction|1965
The Who|Baba O'Riley|1971
The Who|My Generation|1965
Pink Floyd|Another Brick in the Wall, Part 2|1979
Pink Floyd|Comfortably Numb|1979
The Eagles|Hotel California|1976
Fleetwood Mac|Go Your Own Way|1977
Bon Jovi|Livin' on a Prayer|1986
Bon Jovi|It's My Life|2000
Aerosmith|Dream On|1973
Aerosmith|Walk This Way|1975
Foo Fighters|Everlong|1997
Foo Fighters|The Pretender|2007
Red Hot Chili Peppers|Californication|1999
Red Hot Chili Peppers|Can't Stop|2002
Linkin Park|In the End|2000
Linkin Park|Numb|2003
Muse|Uprising|2009
Muse|Supermassive Black Hole|2006
The White Stripes|Seven Nation Army|2003
The Killers|Mr. Brightside|2003
Kings of Leon|Sex on Fire|2008
Arctic Monkeys|I Bet You Look Good on the Dancefloor|2005
Rage Against the Machine|Killing in the Name|1992
System of a Down|Chop Suey!|2001
Green Day|American Idiot|2004
Oasis|Wonderwall|1995
Scorpions|Wind of Change|1990
Kiss|I Was Made for Lovin' You|1979
Journey|Don't Stop Believin'|1981
The Cranberries|Zombie|1994
`);

const poppunk = addRows('poppunk', `
Green Day|Basket Case|1994
Green Day|When I Come Around|1994
Green Day|Longview|1994
Green Day|Good Riddance (Time of Your Life)|1997
Green Day|American Idiot|2004
Green Day|Holiday|2004
Green Day|Boulevard of Broken Dreams|2004
Green Day|Wake Me Up When September Ends|2004
blink-182|All the Small Things|1999
blink-182|What's My Age Again?|1999
blink-182|Dammit|1997
blink-182|First Date|2001
blink-182|The Rock Show|2001
blink-182|I Miss You|2003
blink-182|Feeling This|2003
Sum 41|Fat Lip|2001
Sum 41|In Too Deep|2001
Sum 41|Still Waiting|2002
Sum 41|The Hell Song|2002
Sum 41|Over My Head (Better Off Dead)|2002
Sum 41|With Me|2007
The Offspring|Pretty Fly (for a White Guy)|1998
The Offspring|The Kids Aren't Alright|1998
The Offspring|Want You Bad|2000
The Offspring|Come Out and Play|1994
The Offspring|Why Don't You Get a Job?|1998
Good Charlotte|The Anthem|2002
Good Charlotte|Lifestyles of the Rich & Famous|2002
Good Charlotte|Girls & Boys|2002
Good Charlotte|I Just Wanna Live|2004
Simple Plan|I'm Just a Kid|2002
Simple Plan|I'd Do Anything|2002
Simple Plan|Perfect|2002
Simple Plan|Welcome to My Life|2004
Simple Plan|Shut Up!|2004
Avril Lavigne|Sk8er Boi|2002
Avril Lavigne|Complicated|2002
Avril Lavigne|Girlfriend|2007
Avril Lavigne|My Happy Ending|2004
Paramore|Misery Business|2007
Paramore|That's What You Get|2007
Paramore|crushcrushcrush|2007
Paramore|Ignorance|2009
Fall Out Boy|Sugar, We're Goin Down|2005
Fall Out Boy|Dance, Dance|2005
Fall Out Boy|Thnks fr th Mmrs|2007
New Found Glory|My Friends Over You|2002
Yellowcard|Ocean Avenue|2003
All Time Low|Dear Maria, Count Me In|2007
Bowling for Soup|1985|2004
`);

const alternative = addRows('alternative', `
Radiohead|Creep|1992
Radiohead|Karma Police|1997
Radiohead|No Surprises|1997
Radiohead|Paranoid Android|1997
Radiohead|High and Dry|1995
Muse|Plug In Baby|2001
Muse|Time Is Running Out|2003
Muse|Hysteria|2003
Muse|Starlight|2006
Muse|Uprising|2009
Linkin Park|Crawling|2000
Linkin Park|One Step Closer|2000
Linkin Park|In the End|2000
Linkin Park|Numb|2003
Linkin Park|Somewhere I Belong|2003
Linkin Park|Faint|2003
Linkin Park|What I've Done|2007
Linkin Park|Bleed It Out|2007
Nirvana|Lithium|1991
Nirvana|Heart-Shaped Box|1993
Nirvana|Smells Like Teen Spirit|1991
Pearl Jam|Alive|1991
Pearl Jam|Even Flow|1991
Pearl Jam|Black|1991
Soundgarden|Black Hole Sun|1994
Alice in Chains|Would?|1992
Alice in Chains|Man in the Box|1990
The Smashing Pumpkins|1979|1995
The Smashing Pumpkins|Bullet with Butterfly Wings|1995
Nine Inch Nails|Closer|1994
Nine Inch Nails|Hurt|1994
Placebo|Every You Every Me|1998
Placebo|Pure Morning|1998
Placebo|The Bitter End|2003
Garbage|Only Happy When It Rains|1995
Garbage|Stupid Girl|1995
Deftones|Change (In the House of Flies)|2000
Deftones|My Own Summer (Shove It)|1997
System of a Down|Toxicity|2001
System of a Down|Aerials|2001
System of a Down|B.Y.O.B.|2005
Evanescence|Bring Me to Life|2003
Evanescence|Going Under|2003
Evanescence|My Immortal|2003
The Killers|Somebody Told Me|2004
Arctic Monkeys|Do I Wanna Know?|2013
Arctic Monkeys|R U Mine?|2012
The Strokes|Last Nite|2001
The White Stripes|Fell in Love with a Girl|2001
Weezer|Buddy Holly|1994
`);

const pop = addRows('pop', `
Michael Jackson|Billie Jean|1982
Michael Jackson|Thriller|1982
Michael Jackson|Beat It|1982
Madonna|Like a Prayer|1989
Madonna|Vogue|1990
Madonna|Hung Up|2005
Britney Spears|...Baby One More Time|1998
Britney Spears|Oops!... I Did It Again|2000
Britney Spears|Toxic|2003
Christina Aguilera|Genie in a Bottle|1999
Christina Aguilera|Beautiful|2002
Backstreet Boys|I Want It That Way|1999
NSYNC|Bye Bye Bye|2000
Spice Girls|Wannabe|1996
Kylie Minogue|Can't Get You Out of My Head|2001
Kylie Minogue|Spinning Around|2000
Lady Gaga|Just Dance|2008
Lady Gaga|Poker Face|2008
Lady Gaga|Bad Romance|2009
Lady Gaga|Born This Way|2011
Katy Perry|I Kissed a Girl|2008
Katy Perry|Hot N Cold|2008
Katy Perry|Firework|2010
Rihanna|Umbrella|2007
Rihanna|Don't Stop the Music|2007
Rihanna|Diamonds|2012
Beyoncé|Crazy in Love|2003
Beyoncé|Single Ladies (Put a Ring on It)|2008
Shakira|Whenever, Wherever|2001
Shakira|Hips Don't Lie|2006
Justin Timberlake|Cry Me a River|2002
Justin Timberlake|SexyBack|2006
Nelly Furtado|I'm Like a Bird|2000
Nelly Furtado|Maneater|2006
Gwen Stefani|Hollaback Girl|2004
P!nk|So What|2008
P!nk|Just Like a Pill|2001
Avril Lavigne|Complicated|2002
Kelly Clarkson|Since U Been Gone|2004
Taylor Swift|Shake It Off|2014
Taylor Swift|Blank Space|2014
Adele|Rolling in the Deep|2010
Adele|Someone Like You|2011
Bruno Mars|Just the Way You Are|2010
Bruno Mars|Locked Out of Heaven|2012
Ed Sheeran|Shape of You|2017
Dua Lipa|Don't Start Now|2019
Dua Lipa|Levitating|2020
The Weeknd|Blinding Lights|2019
Harry Styles|As It Was|2022
`);

const eighties = addRows('80s', `
a-ha|Take On Me|1985
a-ha|The Sun Always Shines on T.V.|1985
Tears for Fears|Everybody Wants to Rule the World|1985
Tears for Fears|Shout|1984
Depeche Mode|Just Can't Get Enough|1981
Depeche Mode|People Are People|1984
Depeche Mode|Never Let Me Down Again|1987
New Order|Blue Monday|1983
New Order|Bizarre Love Triangle|1986
The Human League|Don't You Want Me|1981
Eurythmics|Sweet Dreams (Are Made of This)|1983
Eurythmics|Here Comes the Rain Again|1983
Pet Shop Boys|West End Girls|1984
Pet Shop Boys|It's a Sin|1987
Duran Duran|Hungry Like the Wolf|1982
Duran Duran|Rio|1982
Wham!|Wake Me Up Before You Go-Go|1984
Wham!|Last Christmas|1984
George Michael|Faith|1987
George Michael|Careless Whisper|1984
Michael Jackson|Billie Jean|1982
Michael Jackson|Beat It|1982
Michael Jackson|Smooth Criminal|1987
Madonna|Like a Virgin|1984
Madonna|Material Girl|1984
Madonna|Like a Prayer|1989
Whitney Houston|I Wanna Dance with Somebody (Who Loves Me)|1987
Cyndi Lauper|Girls Just Want to Have Fun|1983
Cyndi Lauper|Time After Time|1983
Prince|Purple Rain|1984
Prince|When Doves Cry|1984
Rick Astley|Never Gonna Give You Up|1987
Rick Astley|Together Forever|1987
Europe|The Final Countdown|1986
Bon Jovi|Livin' on a Prayer|1986
Guns N' Roses|Sweet Child O' Mine|1987
Journey|Don't Stop Believin'|1981
The Police|Every Breath You Take|1983
The Police|Every Little Thing She Does Is Magic|1981
U2|With or Without You|1987
U2|Sunday Bloody Sunday|1983
Bruce Springsteen|Dancing in the Dark|1984
Bruce Springsteen|Born in the U.S.A.|1984
David Bowie|Let's Dance|1983
Billy Idol|Rebel Yell|1983
INXS|Need You Tonight|1987
Simple Minds|Don't You (Forget About Me)|1985
Soft Cell|Tainted Love|1981
Culture Club|Karma Chameleon|1983
The Cure|Lovesong|1989
`);

const eurovision = addRows('eurovision', `
ABBA|Waterloo|1974
Loreen|Euphoria|2012
Loreen|Tattoo|2023
Måneskin|Zitti e buoni|2021
Lordi|Hard Rock Hallelujah|2006
Alexander Rybak|Fairytale|2009
Lena|Satellite|2010
Conchita Wurst|Rise Like a Phoenix|2014
Duncan Laurence|Arcade|2019
Netta|Toy|2018
Salvador Sobral|Amar pelos dois|2017
Jamala|1944|2016
Kalush Orchestra|Stefania|2022
Nemo|The Code|2024
Emmelie de Forest|Only Teardrops|2013
Ell & Nikki|Running Scared|2011
Dima Bilan|Believe|2008
Marija Šerifović|Molitva|2007
Helena Paparizou|My Number One|2005
Ruslana|Wild Dances|2004
Sertab Erener|Everyway That I Can|2003
Marie N|I Wanna|2002
Tanel Padar, Dave Benton & 2XL|Everybody|2001
Olsen Brothers|Fly on the Wings of Love|2000
Charlotte Nilsson|Take Me to Your Heaven|1999
Dana International|Diva|1998
Katrina and the Waves|Love Shine a Light|1997
Eimear Quinn|The Voice|1996
Secret Garden|Nocturne|1995
Paul Harrington & Charlie McGettigan|Rock 'n' Roll Kids|1994
Niamh Kavanagh|In Your Eyes|1993
Linda Martin|Why Me?|1992
Carola|Fångad av en stormvind|1991
Toto Cutugno|Insieme: 1992|1990
Riva|Rock Me|1989
Céline Dion|Ne partez pas sans moi|1988
Johnny Logan|Hold Me Now|1987
Sandra Kim|J'aime la vie|1986
Bobbysocks!|La det swinge|1985
Herreys|Diggi-Loo Diggi-Ley|1984
Corinne Hermès|Si la vie est cadeau|1983
Nicole|Ein bißchen Frieden|1982
Bucks Fizz|Making Your Mind Up|1981
Johnny Logan|What's Another Year|1980
Gali Atari & Milk and Honey|Hallelujah|1979
Izhar Cohen & Alphabeta|A-Ba-Ni-Bi|1978
Marie Myriam|L'oiseau et l'enfant|1977
Brotherhood of Man|Save Your Kisses for Me|1976
Teach-In|Ding-a-dong|1975
Käärijä|Cha Cha Cha|2023
`);

const noughties = [...library.values()].filter(track => track.year >= 2000 && track.year <= 2009).slice(0, 50).map(track => {
  track.genres.push('00s'); return track.id;
});

const artistAliases: Record<string, string[]> = {
  'Linkin Park': ['Линкин Парк', 'Линкин Парк', 'LinkinPark'],
  'Green Day': ['Грин Дэй', 'Грин Дей'], 'Queen': ['Куин', 'Квин'], 'Nirvana': ['Нирвана'],
  'AC/DC': ['ACDC', 'Эй Си Ди Си'], 'Guns N\' Roses': ['Guns and Roses', 'Ганс энд Роузес'],
  'Metallica': ['Металлика'], 'Muse': ['Мьюз'], 'Radiohead': ['Радиохед'],
  'Red Hot Chili Peppers': ['RHCP', 'Ред Хот Чили Пепперс'], 'The Eagles': ['Eagles', 'Иглз'],
  'The Rolling Stones': ['Rolling Stones', 'Роллинг Стоунз'], 'The Who': ['Who', 'Зе Ху'],
  'The Killers': ['Killers', 'Киллерс'], 'The White Stripes': ['White Stripes', 'Уайт Страйпс'],
  'blink-182': ['Blink 182', 'Блинк 182'], 'Sum 41': ['Сам 41'], 'The Offspring': ['Offspring', 'Оффспринг'],
  'Avril Lavigne': ['Аврил Лавин'], 'Paramore': ['Парамор'], 'Fall Out Boy': ['Фол Аут Бой'],
  'System of a Down': ['SOAD', 'Систем оф э Даун'], 'Evanescence': ['Эванесенс'],
  'Michael Jackson': ['Майкл Джексон'], 'Madonna': ['Мадонна'], 'Britney Spears': ['Бритни Спирс'],
  'Lady Gaga': ['Леди Гага'], 'Rihanna': ['Рианна'], 'Beyoncé': ['Бейонсе'], 'Shakira': ['Шакира'],
  'Katy Perry': ['Кэти Перри'], 'P!nk': ['Pink', 'Пинк'], 'Adele': ['Адель'],
  'Loreen': ['Лорин'], 'Måneskin': ['Maneskin', 'Монескин'], 'Dima Bilan': ['Дима Билан'],
  'ABBA': ['Абба'], 'Käärijä': ['Kaarija', 'Кяэрийя'], 'Céline Dion': ['Celine Dion', 'Селин Дион'],
};
for (const track of library.values()) {
  if (artistAliases[track.artist]) track.artistAliases = [...new Set(artistAliases[track.artist])];
  const noParentheses = track.title.replace(/\s*\([^)]*\)/g, '').trim();
  if (noParentheses !== track.title && noParentheses.length > 3) track.titleAliases = [noParentheses];
  if (track.title === 'Satisfaction') track.titleAliases = ["(I Can't Get No) Satisfaction"];
}

const demoTitles = [
  'Первый свет', 'Ночной трамвай', 'Бумажный самолёт', 'Тёплый дождь', 'Лунный берег',
  'Синий горизонт', 'Тихий город', 'Золотая искра', 'Пульс океана', 'Звёздная пыль',
  'Цветные окна', 'Медленный рассвет', 'Ритм улиц', 'Дальний маяк', 'Солнечный круг',
  'Хрустальный мост', 'Ветер перемен', 'След кометы', 'Шёпот листвы', 'Пустой перрон',
  'Космос внутри', 'Огни проспекта', 'Волна за волной', 'Лёгкий шаг', 'Летний маршрут',
  'Искры неона', 'Северный ветер', 'Мелодия утра', 'Письмо без адреса', 'Танец облаков',
  'Дорога домой', 'Оранжевый закат', 'Электрический сад', 'Второе дыхание', 'Линия метро',
  'Капли на стекле', 'Сердце города', 'Далёкий сигнал', 'Мягкий фокус', 'Яркая сторона',
  'Невесомость', 'Стеклянный лес', 'Лавандовый вечер', 'Параллельный мир', 'Пятый сезон',
  'Звук тишины', 'Поворот ключа', 'Свет в окне', 'Открытое небо', 'Последний аккорд',
];
const scale = [60, 62, 64, 65, 67, 69, 71, 72];
export const demoTracks: Track[] = demoTitles.map((title, index) => ({
  id: `demo-${String(index + 1).padStart(2, '0')}`, title, artist: 'Echo Lab',
  artistAliases: ['Эхо Лаб', 'ECHO LAB'], titleAliases: title.includes('ё') ? [title.replace(/ё/g, 'е')] : undefined, genres: ['demo'], year: 2026,
  // Unique base-eight motifs, generated locally; these are not covers of catalog recordings.
  demoNotes: [scale[index % 8], scale[Math.floor(index / 8) % 8], scale[(index * 3 + 1) % 8], scale[(index + 4) % 8],
    scale[(index * 5 + 2) % 8], scale[(index + 2) % 8], scale[(Math.floor(index / 8) + 3) % 8], scale[index % 8]],
  rights: 'DEMO: оригинальная синтетическая последовательность нот, созданная для ECHO. Без сторонней записи.',
}));

export const demoCollection: Collection = {
  id: 'demo', title: 'ECHO LAB', subtitle: '50 синтетических мелодий · демо без сторонних записей',
  color: '#89f58c', tag: 'DEMO', trackIds: demoTracks.map(track => track.id),
};
export const collections: Collection[] = [
  { id: 'rock', title: 'Рок', subtitle: 'Риффы, которые узнаешь с первой ноты', color: '#f2a171', tag: 'ROCK', trackIds: rock },
  { id: 'poppunk', title: 'Поп-панк', subtitle: 'Гитары громче, настроение выше', color: '#a7a3f6', tag: 'POP PUNK', trackIds: poppunk },
  { id: 'alternative', title: 'Альтернатива', subtitle: 'От гранжа до стадионных припевов', color: '#95b7df', tag: 'ALT', trackIds: alternative },
  { id: 'pop', title: 'Поп', subtitle: 'Большие голоса и знакомые хуки', color: '#f5a7bd', tag: 'POP', trackIds: pop },
  { id: '80s', title: 'Хиты 80-х', subtitle: 'Синтезаторы, неон и вечная классика', color: '#c8a3ed', tag: '1980–1989', trackIds: eighties },
  { id: '00s', title: 'Хиты 00-х', subtitle: 'Плейлист твоего первого плеера', color: '#a6d9ba', tag: '2000–2009', trackIds: noughties },
  { id: 'eurovision', title: 'Евровидение', subtitle: 'Победители и яркие выступления разных лет', color: '#e1cd91', tag: 'EUROVISION', trackIds: eurovision },
];
export const tracks: Track[] = [...library.values(), ...demoTracks];
const trackById = new Map(tracks.map(track => [track.id, track]));
export function getCollectionTracks(id: string): Track[] {
  const collection = id === demoCollection.id ? demoCollection : collections.find(item => item.id === id);
  return collection ? collection.trackIds.map(trackId => trackById.get(trackId)).filter((track): track is Track => !!track) : [];
}

/** Honest local keyword selection. This does not call an AI model or invent new tracks. */
export function resolveCollection(prompt: string): Collection | undefined {
  const text = prompt.toLowerCase().trim();
  if (!text) return undefined;
  const rules: [string, RegExp][] = [
    ['demo', /демо|demo|echo lab|эхо лаб/], ['eurovision', /евровид|eurovision/],
    ['80s', /80|восьмидесят/], ['00s', /00|нулев|двухтысяч|200[0-9]/],
    ['poppunk', /панк|punk|blink|блинк|sum 41|green day|грин д/],
    ['alternative', /альтернатив|alternative|гранж|grunge|linkin|линкин|radiohead|радиохед|muse|мьюз/],
    ['rock', /рок|rock|metal|металл|queen|квин|куин|ac\/dc/], ['pop', /поп|pop|gaga|гага|rihanna|рианна|spears|спирс/],
  ];
  const found = rules.find(([, pattern]) => pattern.test(text));
  return found ? found[0] === 'demo' ? demoCollection : collections.find(collection => collection.id === found[0]) : undefined;
}

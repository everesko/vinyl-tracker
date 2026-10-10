import {eurovisionSongs} from './eurovision-registry';
import {readyPresets} from './ready-presets';
import {additionalDirections} from '@/lib/library-directions';
import {spreadArtists} from '@/lib/track-order';
import {verifyEraPool,verifyGenrePool} from './era-verification';
import { difficultyLevel, type Collection, type Difficulty, type Settings, type Track } from "@/lib/quiz";
import {readJson,storeJson} from './stored-json';
import {ballads} from "./theme-registry";
import { ApiError, database } from "./http";

// Deezer's public API supplies original recording metadata, popularity and 30s previews.
// No full-stream access, DRM bypass, unofficial mirrors, keys or generated metadata.
const API = "https://api.deezer.com";
const MIN_RANK = 0;
let nextRequestAt = 0;
const artistCache = new Map<string, { value: Artist; expiresAt: number }>();
export type Artist = { id: number; name: string; nb_fan?: number; picture_big?: string; picture_medium?: string; link?: string };
type Album = { id: number; title: string; release_date?: string; fans?: number; artist?: Artist; cover_big?: string; tracks?: { data: Recording[] } };
type Recording = { id: number; title: string; title_short?: string; title_version?: string; readable?: boolean; preview?: string; rank?: number; duration?: number; release_date?: string; artist?: Artist; album?: Album; link?: string };
type Definition = { slug: string; title: string; category: "genre" | "era" | "artist" | "mix"; artists: string[]; aliases?: string[]; decade?: number; genreSlugs?: string[]; theme?: "ballads"; region?: "UA"; canonicalIds?: string[] };
const genres: Definition[] = [
  {slug:'classic-rock',title:'Классический рок',category:'genre',aliases:['classic rock','классический рок','класичний рок'],artists:['Queen','The Beatles','Led Zeppelin','Pink Floyd','The Rolling Stones','AC/DC','Eagles','Dire Straits','Fleetwood Mac','The Who','Deep Purple','David Bowie','Journey','Guns N\' Roses','Bon Jovi','Aerosmith']},
  {slug:'pop-punk',title:'Поп-панк',category:'genre',aliases:['pop punk','поп панк'],artists:['blink-182','Green Day','Sum 41','The Offspring','Avril Lavigne','Paramore','Fall Out Boy','Good Charlotte','Simple Plan','Yellowcard','All Time Low','New Found Glory','Bowling For Soup','Jimmy Eat World','The All-American Rejects','Neck Deep']},
  {slug:'indie-rock',title:'Инди-рок',category:'genre',aliases:['indie rock','инди рок','інді рок'],artists:['Arctic Monkeys','The Strokes','The Killers','Franz Ferdinand','The Black Keys','The White Stripes','The Kooks','Kasabian','Foals','Bloc Party','Vampire Weekend','Yeah Yeah Yeahs','The Wombats','Two Door Cinema Club','Tame Impala','Interpol']},
  {slug:'synth-pop',title:'Синти-поп',category:'genre',aliases:['synth pop','synthpop','синти поп','синті поп'],artists:['Depeche Mode','Pet Shop Boys','a-ha','Eurythmics','Erasure','New Order','The Human League','Duran Duran','Tears For Fears','Soft Cell','OMD','Yazoo','Alphaville','Bronski Beat','Ultravox','Visage']},
  {slug:"ballads",title:"Романтические баллады",category:"genre",aliases:["ballads","баллады","балади"],artists:[...new Set(ballads.filter(t=>t.region!=="UA").map(t=>t.artist))]},
  { slug: "rock", title: "Рок", category: "genre", aliases: ["rock", "рок"], artists: ["Queen", "AC/DC", "Guns N' Roses", "Bon Jovi", "Aerosmith", "The Rolling Stones", "Foo Fighters", "Led Zeppelin"] },
  { slug: "pop", title: "Поп", category: "genre", aliases: ["pop", "поп", "попса", "попмузика"], artists: ["Taylor Swift", "Madonna", "Michael Jackson", "Lady Gaga", "Dua Lipa", "Britney Spears", "Katy Perry", "ABBA"] },
  { slug: "alternative", title: "Альтернатива", category: "genre", aliases: ["alternative", "альтернатива", "альтернативный", "альтернативний", "альтернативна", "гранж", "grunge"], artists: ["Linkin Park", "Coldplay", "Radiohead", "Muse", "Nirvana", "Red Hot Chili Peppers", "The Killers", "Arctic Monkeys"] },
  { slug: "metal", title: "Метал", category: "genre", aliases: ["metal", "метал", "металл"], artists: ["Metallica", "Iron Maiden", "Black Sabbath", "Judas Priest", "Slipknot", "System Of A Down", "Megadeth", "Rammstein"] },
  { slug: "hiphop", title: "Хип-хоп / Рэп", category: "genre", aliases: ["hip hop", "hiphop", "rap", "хип хоп", "хіп хоп", "рэп", "реп"], artists: ["Eminem", "2Pac", "Kendrick Lamar", "Drake", "Snoop Dogg", "Jay-Z", "50 Cent", "Nas"] },
  { slug: "dance", title: "Танцевальная электроника", category: "genre", aliases: ["dance", "edm", "electronic", "электроника", "электронная", "танцевальная", "електроніка", "електронна", "танцювальна", "диско", "disco"], artists: ["Daft Punk", "The Chemical Brothers", "David Guetta", "Calvin Harris", "Avicii", "The Prodigy", "Fatboy Slim", "Disclosure"] },
  { slug: "rnb", title: "R&B / Соул", category: "genre", aliases: ["r&b", "rnb", "soul", "соул", "ар энд би"], artists: ["The Weeknd", "Beyoncé", "Rihanna", "Alicia Keys", "Usher", "Stevie Wonder", "Marvin Gaye", "Aretha Franklin"] },
  { slug: "punk", title: "Панк / Поп-панк", category: "genre", aliases: ["punk", "панк", "поп панк", "pop punk"], artists: ["Green Day", "blink-182", "The Offspring", "Sum 41", "Paramore", "My Chemical Romance", "Ramones", "Fall Out Boy"] },
  { slug: "country", title: "Кантри", category: "genre", aliases: ["country", "кантри", "кантрі"], artists: ["Johnny Cash", "Dolly Parton", "Shania Twain", "Willie Nelson", "Luke Combs", "Chris Stapleton", "Carrie Underwood", "Kenny Rogers"] },
  { slug: "jazz", title: "Джаз", category: "genre", aliases: ["jazz", "джаз"], artists: ["Louis Armstrong", "Ella Fitzgerald", "Nina Simone", "Frank Sinatra", "Miles Davis", "John Coltrane", "Billie Holiday", "Norah Jones"] },
];
const eras: Definition[] = [
  { slug: "70s", title: "Хиты 70-х", category: "era", decade: 1970, artists: ["Queen", "ABBA", "Fleetwood Mac", "Elton John", "Pink Floyd", "David Bowie"] },
  { slug: "80s", title: "Хиты 80-х", category: "era", decade: 1980, artists: ["Michael Jackson", "Madonna", "Queen", "Depeche Mode", "Bon Jovi", "Whitney Houston"] },
  { slug: "90s", title: "Хиты 90-х", category: "era", decade: 1990, artists: ["Nirvana", "Oasis", "Radiohead", "Red Hot Chili Peppers", "2Pac", "Mariah Carey"] },
  { slug: "00s", title: "Хиты нулевых", category: "era", decade: 2000, artists: ["Linkin Park", "Coldplay", "Eminem", "Beyoncé", "Britney Spears", "Rihanna"] },
  { slug: "10s", title: "Хиты 2010-х", category: "era", decade: 2010, artists: ["Taylor Swift", "Adele", "Ed Sheeran", "The Weeknd", "Drake", "Bruno Mars"] },
  { slug: "20s", title: "Хиты 2020-х", category: "era", decade: 2020, artists: ["Taylor Swift", "Dua Lipa", "Billie Eilish", "Olivia Rodrigo", "The Weeknd", "Harry Styles"] },
];
// Curated artist identities define a scene, not fabricated track metadata. Every
// recording is subsequently obtained from that canonical artist and measured by Deezer.
const genreExtensions: Record<string, string> = {
  rock: "The Beatles|The Who|The Doors|Pink Floyd|Deep Purple|Jimi Hendrix|Fleetwood Mac|Eagles|David Bowie|Elton John|Dire Straits|Bruce Springsteen|Billy Joel|Bryan Adams|U2|Journey|Foreigner|Boston|Kansas|Toto|Heart|ZZ Top|Lynyrd Skynyrd|The Police|Sting|Genesis|Phil Collins|Peter Gabriel|Yes|Rush|Supertramp|Electric Light Orchestra|The Kinks|Creedence Clearwater Revival|Steve Miller Band|Santana|Bad Company|Free|Thin Lizzy|Scorpions|Def Leppard|KISS|Alice Cooper|Van Halen|Motley Crue|Whitesnake|Europe|REO Speedwagon|Cheap Trick|Styx|Bachman-Turner Overdrive|Nazareth|The Animals|The Moody Blues|The Alan Parsons Project|Jethro Tull|King Crimson|Emerson, Lake & Palmer|Procol Harum|Traffic|Jefferson Airplane|Grateful Dead|The Allman Brothers Band|Tom Petty and the Heartbreakers|John Mellencamp|Bob Seger|Neil Young|Bob Dylan|Lou Reed|Iggy Pop|Patti Smith|Roxy Music|The Velvet Underground|Talking Heads|INXS|Midnight Oil|The Cult|Billy Idol|The Cars|Simple Minds|Duran Duran|R.E.M.|Pearl Jam|Soundgarden|Alice In Chains|Stone Temple Pilots|Nirvana|Radiohead|Muse|Coldplay|Oasis|Blur|Pulp|The Verve|Stereophonics|Travis|Keane|The Killers|Arctic Monkeys|The Strokes|Kings Of Leon|The White Stripes|The Black Keys|Jack White|Queens Of The Stone Age|Red Hot Chili Peppers|Incubus|Linkin Park|Audioslave|Rage Against The Machine|Faith No More|Tool|A Perfect Circle|Deftones|Placebo|The Smashing Pumpkins|Garbage|Bush|Weezer|Pixies|Sonic Youth|The Cure|The Smiths|Joy Division|New Order|Nick Cave & The Bad Seeds|The National|Interpol|Franz Ferdinand|Kaiser Chiefs|Bloc Party|Yeah Yeah Yeahs|Florence + The Machine|Imagine Dragons|OneRepublic|Maroon 5|Fall Out Boy|Panic! At The Disco|Paramore|My Chemical Romance|Green Day|The Offspring|blink-182|Sum 41|The Cranberries|No Doubt|Avril Lavigne|Alanis Morissette|Sheryl Crow|Melissa Etheridge|Lenny Kravitz|Chris Rea|Nickelback|Creed|3 Doors Down|Daughtry|Shinedown|Breaking Benjamin|Evanescence|Skillet|Seether|Alter Bridge|The Pretty Reckless|Volbeat|Royal Blood|Nothing But Thieves|Bring Me The Horizon",
  pop: "Adele|Ed Sheeran|Bruno Mars|Justin Bieber|Justin Timberlake|Harry Styles|Billie Eilish|Olivia Rodrigo|Sabrina Carpenter|Ariana Grande|Miley Cyrus|Selena Gomez|Demi Lovato|Shawn Mendes|Charlie Puth|Sam Smith|Sia|P!nk|Kelly Clarkson|Christina Aguilera|Jennifer Lopez|Shakira|Ricky Martin|Enrique Iglesias|Gloria Estefan|Roxette|Ace of Base|a-ha|Tears For Fears|Duran Duran|Pet Shop Boys|Erasure|Eurythmics|George Michael|Wham!|Prince|Whitney Houston|Mariah Carey|Céline Dion|Cher|Tina Turner|Donna Summer|Diana Ross|Bee Gees|Boney M.|Village People|Chic|Earth, Wind & Fire|Kool & The Gang|The Jackson 5|Lionel Richie|Phil Collins|Elton John|Billy Joel|Rod Stewart|Paul McCartney|Paul Simon|Paul Young|Richard Marx|Rick Astley|Belinda Carlisle|Cyndi Lauper|Kim Wilde|Kylie Minogue|Anastacia|Natalie Imbruglia|Nelly Furtado|Gwen Stefani|Fergie|Avril Lavigne|Alanis Morissette|Sheryl Crow|Dido|Lana Del Rey|Lorde|Halsey|Ellie Goulding|Jessie J|Rita Ora|Bebe Rexha|Ava Max|Meghan Trainor|Zara Larsson|Tate McRae|Camila Cabello|Niall Horan|ZAYN|Louis Tomlinson|One Direction|Backstreet Boys|NSYNC|Take That|Westlife|Boyzone|Spice Girls|Sugababes|Girls Aloud|Little Mix|Fifth Harmony|Destiny's Child|TLC|Beyoncé|Rihanna|The Weeknd|Alicia Keys|Akon|Jason Derulo|Sean Paul|Pitbull|Flo Rida|Nelly|Will Smith|Black Eyed Peas|The Pussycat Dolls|Maroon 5|OneRepublic|Imagine Dragons|Coldplay|Keane|The Script|Train|Bastille|Fun.|James Blunt|James Arthur|Lewis Capaldi|Benson Boone|Tom Odell|George Ezra|John Legend|John Mayer|Jack Johnson|Jason Mraz|Colbie Caillat|Vanessa Carlton|Michelle Branch|Natasha Bedingfield|Daniel Bedingfield|Robbie Williams|Mika|Lily Allen|Amy Winehouse|Paloma Faith|Duffy|Florence + The Machine|Robyn|Tove Lo|Carly Rae Jepsen|Charli xcx|Gracie Abrams|Chappell Roan|Sophie Ellis-Bextor|Bananarama|The Bangles|The Go-Go's|Culture Club|Soft Cell|The Human League|Spandau Ballet|Simply Red|Wet Wet Wet|Seal|Sade|Michael Bublé|Norah Jones|Katie Melua|James Morrison|Leonard Cohen|Simon & Garfunkel|Carpenters|The Beach Boys|The Monkees|Tom Jones|Neil Diamond|Barry Manilow|Barbra Streisand|Dionne Warwick|Dusty Springfield",
  alternative: "Oasis|Blur|Pulp|The Verve|The Strokes|The White Stripes|The Black Keys|Kings Of Leon|Pearl Jam|Soundgarden|Alice In Chains|Stone Temple Pilots|The Smashing Pumpkins|Garbage|Bush|Placebo|Weezer|Pixies|Sonic Youth|Dinosaur Jr.|Pavement|Beck|R.E.M.|The Cure|The Smiths|Joy Division|New Order|Depeche Mode|Nine Inch Nails|Tool|A Perfect Circle|Deftones|Incubus|Faith No More|Rage Against The Machine|Audioslave|Queens Of The Stone Age|Interpol|The National|Nick Cave & The Bad Seeds|Franz Ferdinand|Bloc Party|Kaiser Chiefs|Editors|Kasabian|Yeah Yeah Yeahs|MGMT|Foster The People|Cage The Elephant|Phoenix|The xx|LCD Soundsystem|Tame Impala|Vampire Weekend|Arcade Fire|The Shins|Modest Mouse|Death Cab for Cutie|Bright Eyes|Bon Iver|Fleet Foxes|The War On Drugs|Alt-J|Spoon|Wilco|The Raconteurs|Jack White|Royal Blood|Nothing But Thieves|Biffy Clyro|Foals|Florence + The Machine|Wolf Alice|The 1975|Twenty One Pilots|Panic! At The Disco|Fall Out Boy|Paramore|My Chemical Romance|The Cranberries|No Doubt|Evanescence|Bring Me The Horizon|The Neighbourhood|Lana Del Rey|Billie Eilish|Lorde|Bastille|Keane|Travis|Stereophonics|Snow Patrol|The Script|Imagine Dragons|OneRepublic|Portugal. The Man|AWOLNATION|Milky Chance|Of Monsters and Men|Two Door Cinema Club|The Kooks|The Wombats|The Vaccines|The Libertines|The Fratellis",
  metal: "Pantera|Slayer|Anthrax|Testament|Sepultura|Kreator|Helloween|Gamma Ray|Blind Guardian|Nightwish|Within Temptation|Epica|Evanescence|Lacuna Coil|Amorphis|Children Of Bodom|In Flames|Dark Tranquillity|Arch Enemy|Amon Amarth|Gojira|Mastodon|Lamb of God|Machine Head|Killswitch Engage|Trivium|Bullet For My Valentine|Avenged Sevenfold|Disturbed|Korn|Deftones|Limp Bizkit|Papa Roach|Mudvayne|Static-X|Rob Zombie|Marilyn Manson|Fear Factory|Soulfly|Drowning Pool|Godsmack|Five Finger Death Punch|Volbeat|Ghost|Sabaton|Powerwolf|DragonForce|HammerFall|Stratovarius|Sonata Arctica|Rhapsody Of Fire|Manowar|Dio|Rainbow|Ozzy Osbourne|Saxon|Accept|Motörhead|Scorpions|W.A.S.P.|Dream Theater|Opeth|Tool|A Perfect Circle|Meshuggah|Periphery|Animals As Leaders|Porcupine Tree|Devin Townsend|Suffocation|Cannibal Corpse|Death|Morbid Angel|Behemoth|Dimmu Borgir|Cradle Of Filth|Emperor|Satyricon|Mayhem|Burzum|Immortal|Enslaved|Bathory|Electric Wizard|Candlemass|Paradise Lost|Katatonia|My Dying Bride|Type O Negative|Anathema|Therion|Sodom|Exodus|Overkill|Destruction|Nuclear Assault|Suicidal Tendencies|Corrosion Of Conformity|Black Label Society|Alter Bridge|Tremonti|Spiritbox|Sleep Token|Bad Omens|Architects|Bring Me The Horizon|Parkway Drive|While She Sleeps|Northlane|August Burns Red|As I Lay Dying",
  hiphop: "J. Cole|Travis Scott|Kanye West|Lil Wayne|Nicki Minaj|Cardi B|Megan Thee Stallion|Doja Cat|Post Malone|Juice WRLD|XXXTENTACION|Lil Uzi Vert|Playboi Carti|Future|Young Thug|Gunna|Lil Baby|DaBaby|21 Savage|Metro Boomin|A$AP Rocky|Tyler, The Creator|Childish Gambino|Mac Miller|Chance the Rapper|Logic|NF|Joyner Lucas|Busta Rhymes|DMX|Ice Cube|Dr. Dre|N.W.A|Public Enemy|Beastie Boys|Run-D.M.C.|LL Cool J|Rakim|Eric B. & Rakim|KRS-One|Wu-Tang Clan|Method Man|Redman|Ghostface Killah|Raekwon|Ol' Dirty Bastard|GZA|Mobb Deep|Outkast|A Tribe Called Quest|De La Soul|The Roots|Common|Mos Def|Talib Kweli|Lauryn Hill|Fugees|Wyclef Jean|Cypress Hill|House Of Pain|Black Sheep|Gang Starr|Big Daddy Kane|Slick Rick|Biz Markie|EPMD|Onyx|Bone Thugs-N-Harmony|Three 6 Mafia|T.I.|Ludacris|Nelly|Ja Rule|Fat Joe|Big Pun|The Game|Rick Ross|Meek Mill|Wiz Khalifa|Schoolboy Q|Ab-Soul|Jay Rock|Vince Staples|Denzel Curry|JID|Joey Bada$$|Benny The Butcher|Freddie Gibbs|Pusha T|Clipse|Killer Mike|Run The Jewels|El-P|JPEGMAFIA|Danny Brown|Earl Sweatshirt|Kid Cudi|Big Sean|Don Toliver|Jack Harlow|Central Cee|Dave|Stormzy|Skepta|Dizzee Rascal|AJ Tracey|Headie One|MHD|Ninho|Orelsan|IAM|MC Solaar|PNL|Nekfeu|Booba|Damso",
  dance: "Swedish House Mafia|Eric Prydz|Deadmau5|Tiësto|Armin van Buuren|Paul van Dyk|Above & Beyond|Ferry Corsten|ATB|Robert Miles|Faithless|Moby|Massive Attack|Portishead|Groove Armada|Basement Jaxx|Underworld|Orbital|Leftfield|The Crystal Method|Röyksopp|Air|Justice|Kavinsky|Gesaffelstein|Moderat|Apparat|Bonobo|Caribou|Four Tet|Bicep|Jon Hopkins|Nicolas Jaar|Nils Frahm|Rufus Du Sol|ODESZA|Flume|Porter Robinson|Madeon|Skrillex|Diplo|Major Lazer|DJ Snake|Martin Garrix|Dimitri Vegas & Like Mike|Hardwell|Afrojack|Nicky Romero|Alesso|Axwell|Steve Angello|Sebastian Ingrosso|Oliver Heldens|Don Diablo|Robin Schulz|Lost Frequencies|Kygo|Alan Walker|Marshmello|The Chainsmokers|Zedd|Clean Bandit|Sigala|Joel Corry|Jax Jones|Meduza|Purple Disco Machine|Fisher|Chris Lake|John Summit|Dom Dolla|Peggy Gou|Fred again..|Jamie xx|Duke Dumont|Gorgon City|CamelPhat|Elderbrook|Bob Sinclar|Martin Solveig|Benny Benassi|Alex Gaudino|Roger Sanchez|Armand Van Helden|Duck Sauce|Stardust|Modjo|Moloko|Chicane|Darude|Scooter|Cascada|Alice Deejay|Lasgo|Ian Van Dahl|Milk Inc.|2 Unlimited|Snap!|Haddaway|Culture Beat|Dr. Alban|Corona|La Bouche|Captain Hollywood Project|Real McCoy|Vengaboys|Aqua|Eiffel 65|Gigi D'Agostino|Gabry Ponte|Sash!|Dario G|Safri Duo|Pendulum|The Prodigy|Netsky|Rudimental|Chase & Status|Sub Focus|Wilkinson|Sigma|Dimension|High Contrast",
  rnb: "Sade|Prince|D'Angelo|Erykah Badu|Jill Scott|Mary J. Blige|Toni Braxton|Brandy|Monica|Aaliyah|TLC|Destiny's Child|En Vogue|SWV|Xscape|Boyz II Men|Jodeci|Blackstreet|Dru Hill|New Edition|Bell Biv DeVoe|Keith Sweat|Bobby Brown|Babyface|Joe|Ginuwine|Tyrese|R. Kelly|Ne-Yo|Chris Brown|Trey Songz|Miguel|Frank Ocean|SZA|Summer Walker|H.E.R.|Kehlani|Jhené Aiko|Tinashe|Kali Uchis|Daniel Caesar|Giveon|Brent Faiyaz|PARTYNEXTDOOR|Bryson Tiller|Jacquees|6LACK|Ella Mai|Snoh Aalegra|Mahalia|Jorja Smith|Jessie Reyez|Dvsn|Leon Bridges|Anderson .Paak|Silk Sonic|Bruno Mars|John Legend|Amy Winehouse|Duffy|Adele|Sam Smith|Seal|Simply Red|Luther Vandross|Anita Baker|Patti LaBelle|Chaka Khan|Rufus|Diana Ross|The Supremes|The Temptations|The Four Tops|The Isley Brothers|The O'Jays|The Stylistics|The Spinners|Al Green|Otis Redding|Sam Cooke|Wilson Pickett|James Brown|Curtis Mayfield|Donny Hathaway|Bill Withers|Bobby Womack|Barry White|Isaac Hayes|Smokey Robinson|Lionel Richie|Commodores|Earth, Wind & Fire|Kool & The Gang|Parliament|Funkadelic|Sly & The Family Stone|The Gap Band|Ohio Players|Rick James|Teena Marie|Bette Midler|Roberta Flack|Dionne Warwick|Dusty Springfield|Ben E. King|Percy Sledge|Etta James",
  punk: "Bad Religion|NOFX|Rancid|Social Distortion|Pennywise|The Clash|Sex Pistols|Buzzcocks|The Damned|Dead Kennedys|Black Flag|Circle Jerks|Minor Threat|Fugazi|Misfits|Descendents|The Stooges|Iggy Pop|Patti Smith|Television|Richard Hell|The New York Dolls|The Cramps|The Undertones|Stiff Little Fingers|The Stranglers|The Jam|Generation X|Billy Idol|The Specials|Madness|Sublime|Reel Big Fish|Less Than Jake|Goldfinger|Streetlight Manifesto|The Mighty Mighty Bosstones|Operation Ivy|Flogging Molly|Dropkick Murphys|The Pogues|Gogol Bordello|Rise Against|Anti-Flag|Against Me!|Alkaline Trio|AFI|Billy Talent|Good Charlotte|Simple Plan|New Found Glory|Yellowcard|All Time Low|The Used|Taking Back Sunday|Brand New|Dashboard Confessional|Jimmy Eat World|Motion City Soundtrack|Mayday Parade|The Maine|We The Kings|Boys Like Girls|A Day To Remember|Pierce The Veil|Sleeping With Sirens|Falling In Reverse|Escape The Fate|Bring Me The Horizon|Waterparks|Neck Deep|The Story So Far|State Champs|Knuckle Puck|The Wonder Years|Modern Baseball|The Menzingers|The Gaslight Anthem|The Bouncing Souls|Lagwagon|Strung Out|Millencolin|No Use For A Name|MxPx|Zebrahead|Lit|SR-71|American Hi-Fi|Bowling For Soup|The All-American Rejects|Avril Lavigne|No Doubt|The Interrupters|Turnstile|Idles|Fontaines D.C.|Amyl and The Sniffers|The Hives|Refused|At The Drive-In|Enter Shikari|Frank Turner|Frank Carter & The Rattlesnakes",
  country: "George Strait|Garth Brooks|Alan Jackson|Brooks & Dunn|Tim McGraw|Faith Hill|Reba McEntire|Trisha Yearwood|Martina McBride|LeAnn Rimes|Toby Keith|Trace Adkins|Brad Paisley|Keith Urban|Kenny Chesney|Blake Shelton|Miranda Lambert|Luke Bryan|Jason Aldean|Eric Church|Dierks Bentley|Zac Brown Band|Lady A|Little Big Town|Rascal Flatts|Sugarland|The Chicks|Alison Krauss|Emmylou Harris|Linda Ronstadt|Loretta Lynn|Patsy Cline|Tammy Wynette|Conway Twitty|Merle Haggard|Waylon Jennings|George Jones|Hank Williams|Hank Williams, Jr.|Hank Williams III|Kris Kristofferson|Glen Campbell|John Denver|Don Williams|Roger Miller|Buck Owens|Charley Pride|Jim Reeves|Ray Price|Marty Robbins|Roy Acuff|Ernest Tubb|Eddy Arnold|Jerry Reed|Charlie Rich|Earl Thomas Conley|Ronnie Milsap|The Bellamy Brothers|Alabama|The Oak Ridge Boys|Restless Heart|Diamond Rio|Lonestar|Clint Black|Vince Gill|Randy Travis|Dwight Yoakam|Steve Earle|Lyle Lovett|Townes Van Zandt|Guy Clark|Lucinda Williams|Gillian Welch|Nanci Griffith|Mary Chapin Carpenter|Patty Loveless|Suzy Bogguss|Dustin Lynch|Cole Swindell|Thomas Rhett|Brett Young|Jordan Davis|Dylan Scott|Jon Pardi|Cody Johnson|Parker McCollum|Morgan Wallen|Zach Bryan|Tyler Childers|Sturgill Simpson|Jason Isbell|Turnpike Troubadours|Whiskey Myers|Colter Wall|Charley Crockett|Billy Strings|Sierra Ferrell|Lainey Wilson|Kacey Musgraves|Maren Morris|Kelsea Ballerini|Ashley McBryde|Carly Pearce|Gabby Barrett|Megan Moroney|Nate Smith|Bailey Zimmerman|Hardy|Jelly Roll|Dasha|Shaboozey",
  jazz: "Duke Ellington|Count Basie|Benny Goodman|Glenn Miller|Artie Shaw|Tommy Dorsey|Woody Herman|Stan Kenton|Dave Brubeck|Chet Baker|Stan Getz|Gerry Mulligan|Paul Desmond|Art Blakey|Horace Silver|Hank Mobley|Dexter Gordon|Sonny Rollins|Cannonball Adderley|Charles Mingus|Thelonious Monk|Bill Evans|Oscar Peterson|Ahmad Jamal|Erroll Garner|Bud Powell|McCoy Tyner|Herbie Hancock|Chick Corea|Keith Jarrett|Joe Zawinul|Wayne Shorter|Weather Report|Return To Forever|Mahavishnu Orchestra|John McLaughlin|Pat Metheny|Wes Montgomery|George Benson|Grant Green|Kenny Burrell|Joe Pass|Django Reinhardt|Charlie Christian|Tal Farlow|Jim Hall|John Scofield|Al Di Meola|Mike Stern|Charlie Parker|Dizzy Gillespie|Fats Navarro|Clifford Brown|Lee Morgan|Freddie Hubbard|Donald Byrd|Wynton Marsalis|Roy Hargrove|Christian Scott aTunde Adjuah|Louis Prima|Cab Calloway|Nat King Cole|Sarah Vaughan|Dinah Washington|Anita O'Day|Peggy Lee|Julie London|Blossom Dearie|Mel Tormé|Tony Bennett|Sammy Davis Jr.|Dean Martin|Bobby Darin|Michael Bublé|Diana Krall|Madeleine Peyroux|Melody Gardot|Stacey Kent|Cassandra Wilson|Dianne Reeves|Kurt Elling|Jamie Cullum|Gregory Porter|Jose James|Esperanza Spalding|Robert Glasper|Kamasi Washington|Snarky Puppy|GoGo Penguin|BADBADNOTGOOD|The Comet Is Coming|Yussef Dayes|Ezra Collective|Nubya Garcia|Shabaka Hutchings|Moses Boyd|Christian McBride|Marcus Miller|Jaco Pastorius|Victor Wooten|Stanley Clarke|Avishai Cohen|Tigran Hamasyan|Brad Mehldau|E.S.T.|Lars Danielsson|Nils Landgren|Jan Garbarek|Terje Rypdal|Arve Henriksen|Bugge Wesseltoft|Saxophone Summit",
};
for (const definition of genres) definition.artists = [...new Set([...definition.artists, ...(genreExtensions[definition.slug] ?? "").split("|").filter(Boolean)])];
// Album dates, rather than an artist's career dates, decide era eligibility.
for (const definition of eras) definition.artists = [...new Set([...definition.artists, ...interleave(genres.map(genre => genre.artists))])];
const featured: [string, string, string[]][] = [
  ["queen", "Queen", ["куин", "квин", "квін"]], ["linkin-park", "Linkin Park", ["линкин парк", "линкинпарк", "лінкін парк", "лінкінпарк"]],
  ["coldplay", "Coldplay", ["колдплей", "колдплэй"]], ["eminem", "Eminem", ["эминем", "еминем", "емінем"]],
  ["abba", "ABBA", ["абба"]], ["taylor-swift", "Taylor Swift", ["тейлор свифт", "тэйлор свифт", "тейлор свіфт"]],
];
const artistDefinitions: Definition[] = featured.map(([slug, title, aliases]) => ({ slug, title, aliases, category: "artist", artists: [title] }));
// Participation identities: Eurovision's official media handbook list of winners,
// and official2018/2009participant lists. This is their repertoire, not a promise
// that every recording was performed in the contest.
const eurovision: Definition = { slug: "eurovision", title: "Песни Евровидения", category: "mix", aliases: ["eurovision", "евровидение", "евровидения","евровиденье","евровиденья","євробачення"], artists: ["ABBA", "Céline Dion", "Loreen", "Måneskin", "Duncan Laurence", "Alexander Rybak", "Lordi", "Conchita Wurst", "Kalush Orchestra", "Netta", "Måns Zelmerlöw", "Jamala", "Ruslana", "Dima Bilan", "Lena", "Salvador Sobral", "Emmelie de Forest", "Helena Paparizou", "Sertab Erener", "Johnny Logan", "Marija Šerifović", "Charlotte Perrelli", "Carola", "Katrina and the Waves", "Secret Garden", "Olsen Brothers", "Toto Cutugno", "France Gall", "Udo Jürgens", "Sandie Shaw", "Lulu", "Vicky Leandros", "Anne-Marie David", "Teach-In", "Brotherhood of Man", "Bucks Fizz", "Nicole", "Herreys", "Bobbysocks", "Sandra Kim", "Dana International", "Patricia Kaas", "Hadise", "Arash", "Benjamin Ingrosso", "Michael Schulte", "Eleni Foureira", "Mikolas Josef", "Jessica Mauboy", "Waylon", "Saara Aalto", "Madame Monsieur", "Il Volo", "Francesco Gabbani", "Barbara Pravi", "Sergey Lazarev"] };
const definitions: Definition[] = [...genres, ...eras, ...artistDefinitions, ...Object.entries(readyPresets).filter(([slug])=>!artistDefinitions.some(a=>a.slug===slug)).map(([slug,preset])=>({slug,title:preset.title,artists:[preset.title],category:'artist' as const})), eurovision];
const verifiedUkrainianFans:Record<string,number> = {"796042": 144214, "4394817": 115889, "2544561": 100162, "1365309": 100122, "7063077": 79599, "4814224": 71780, "75567382": 67773, "1432088": 55602, "5337130": 43413, "9828422": 41960, "6486539": 37744, "114053322": 32211, "13436891": 31655, "113002362": 29430, "11495570": 29421, "7872896": 28814, "54213952": 23912, "5848638": 23175, "5492952": 22457, "4396972": 21922, "1110556": 21553, "11498862": 20011, "876284": 19644, "6773641": 18772, "116247522": 15706, "13009335": 15567, "1217869": 15031, "162861367": 14739, "5740652": 14613, "225100035": 14354, "4554978": 13109, "6790765": 11188, "160988752": 9418, "10521433": 8981, "6168696": 8870, "12751613": 8491, "69399722": 8425, "5269324": 7379, "6548715": 7197, "9141352": 6708, "13687311": 6595, "169710707": 6412, "10147002": 5985, "11529071": 5795, "56751292": 5451, "166523867": 5369, "215102": 5257, "4444748": 5159, "78019052": 5149, "12588868": 4878, "10838738": 4873, "108911822": 4298, "182282107": 4147, "14570229": 3854, "5593392": 3720, "4611681": 3491, "14447813": 3180, "65459832": 3154, "191480187": 3145, "12049160": 2916, "5559710": 2802, "5475037": 2684, "12360076": 2562, "208125427": 2418, "1365961": 2398, "194127167": 2247, "5841778": 1991, "5947066": 1968, "5300725": 1941, "60120252": 1835, "11372960": 1724, "102262192": 1665, "5841789": 1541, "227459315": 1522, "1465720": 1473, "12371770": 1433, "100048592": 1409, "13507067": 1280, "6182544": 1262, "5788044": 1228, "122088282": 1228, "4913073": 1165, "183204577": 1132, "5294663": 1050, "5250720": 953, "369308892": 899, "144851832": 878, "5300723": 877, "13085023": 822, "1643782": 756, "144150372": 738, "137234852": 728, "12021844": 711, "5551804": 702, "5332240": 648, "80163882": 560, "178585087": 488, "11520419": 338, "4462738": 311, "8891028": 290, "7122709": 281, "77031622": 272, "172413857": 270, "8891024": 254, "13725509": 243, "76793": 225, "10118402": 196, "68020632": 170, "5204348": 104, "139384092": 40};
const ukrainianArtistDiscovery = ["Okean Elzy", "The Hardkiss", "Бумбокс", "Скрябін", "Один в каное", "ONUKA", "KAZKA", "alyona alyona", "KALUSH", "Jerry Heil", "Artem Pivovarov", "Tina Karol", "Jamala", "DOROFEEVA", "Skofka", "Kola", "Антитіла", "Друга Ріка", "Христина Соловій", "YAKTAK", "БЕЗ ОБМЕЖЕНЬ", "SHUMEI", "TVORCHI", "Go_A", "Jinjer", "MAX BARSKIH", "MONATIK", "DakhaBrakha", "NK", "Stoned Jesus", "YARMAK", "SadSvit", "Жадан і Собаки", "СКАЙ", "Klavdia Petrivna", "Kozak System", "Vivienne Mort", "MamaRika", "ТНМК", "Карна", "Wellboy", "Тартак", "Somali Yacht Club", "Тінь Сонця", "СТРУКТУРА ЩАСТЯ", "MÉLOVIN", "Dakh Daughters", "Parfeniuk", "хейтспіч", "Pianoboy", "CHEEV", "LATEXFAUNA", "Воплі Відоплясова", "Tember Blanche", "Drevo", "Alina Pash", "Фіолет", "Zlata Ognevich", "The Unsleeping", "Плач Єремії", "KOZAK SIROMAHA", "TAYANNA", "Мері", "Michelle Andrade", "Adam", "Ot Vinta", "Lely45", "Мертвий півень", "Panivalkova", "Олександр Пономарьов", "Саша Чемеров", "Ivan NAVI", "OTOY", "Фліт", "Ziferblat", "Zapaska", "Yuko", "Enleo", "Димна суміш", "Ірина Білик", "Kadnay", "POSITIFF", "Bloom Twins", "Golubenko", "Руслана", "Гайдамаки", "NAZVA", "Віктор Павлік", "Іво Бобул", "Qarpa", "Victoria NIRO", "ROXOLANA", "Мандри", "Гайтана", "Роллікс", "Схожа", "MOLODI", "Павло Зібров", "Олег Скрипка", "Наталія Могилевська", "Марія Бурмака", "Fiinka", "NICHKA", "Андрій Хливнюк", "Оксана Білозір", "Anka", "Taras Chubay", "Оксана Муха", "Yuvi", "Друже музико"];
const discoveryNames = [...new Set([...featured.map(([, name]) => name), ...interleave(genres.map(definition => definition.artists)), ...ukrainianArtistDiscovery])];
export type DeckOptions = { count?: number; allowArtistRepeats?: boolean; difficulty?: Difficulty };
export function collectionOptions(payload: Record<string, unknown>): DeckOptions {
  const count = payload.count ?? payload.songCount ?? 50, allowArtistRepeats = payload.allowArtistRepeats ?? true;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) throw new ApiError(400, "INVALID_COUNT", "Укажите положительное целое число песен.");
  if (typeof allowArtistRepeats !== "boolean") throw new ApiError(400, "INVALID_ARTIST_REPEATS", "Настройка повторов исполнителей должна быть включена или выключена.");
  const difficulty=payload.difficulty;
  if(difficulty!==undefined&&!(typeof difficulty==='number'&&Number.isInteger(difficulty)&&difficulty>=1&&difficulty<=10||['easy','medium','advanced','hard'].includes(String(difficulty))))throw new ApiError(400,'INVALID_DIFFICULTY','Неверный уровень сложности.');
  return { count: count as DeckOptions["count"], allowArtistRepeats, ...(difficulty!==undefined?{difficulty:difficulty as Difficulty}:{}) };
}
function symbolicCover(label: string, color: string) {
  const text = label.replace(/[<>&"']/g, "").slice(0, 18);
  const symbol = /^\d{4}$/.test(text)
    ? `<text x="320" y="320" text-anchor="middle" fill="none" stroke="${color}" stroke-width="2" font-family="Arial,sans-serif" font-size="220" font-weight="700">${text.slice(2)}</text>`
    : /рок|rock|метал|metal|панк|punk/i.test(text)
      ? `<path d="M350 110 225 285h100l-35 115 130-180H320z" fill="${color}" fill-opacity=".23" stroke="${color}" stroke-width="3"/>`
      : `<circle cx="320" cy="250" r="137"/><circle cx="320" cy="250" r="100" opacity=".4"/><circle cx="320" cy="250" r="58" opacity=".5"/><circle cx="320" cy="250" r="18" fill="${color}" fill-opacity=".7"/>`;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><defs><radialGradient id="g"><stop stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="#111d2b"/></radialGradient></defs><rect width="640" height="640" fill="#101b29"/><rect width="640" height="640" fill="url(#g)"/><path d="M0 78h640M0 455h640M80 0v640M560 0v640" fill="none" stroke="${color}" opacity=".08"/><path d="M35 105V35h70M535 35h70v70M35 535v70h70M535 605h70v-70" fill="none" stroke="${color}" opacity=".45"/><g fill="none" stroke="${color}" stroke-width="2">${symbol}</g><path d="m470 0 170 170v-80L550 0" fill="${color}" opacity=".07"/></svg>`)}`;
}
function normalized(value: string) { return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " "); }
function contains(text: string, token: string) { return ` ${normalized(text)} `.includes(` ${normalized(token)} `); }
const russianArtistAliases: Record<string, string[]> = { "Metallica": ["металлика"], "Rammstein": ["раммштайн"], "Nirvana": ["нирвана"], "Radiohead": ["радиохед"], "Muse": ["мьюз"], "Green Day": ["грин дэй", "гриндей"], "The Weeknd": ["уикнд", "викенд"], "Madonna": ["мадонна"], "Michael Jackson": ["майкл джексон"], "Rihanna": ["рианна"], "Lady Gaga": ["леди гага"], "Beyoncé": ["бейонсе"], "Britney Spears": ["бритни спирс"], "Dua Lipa": ["дуа липа"], "Adele": ["адель"], "Ed Sheeran": ["эд ширан"], "2Pac": ["тупак"], "Daft Punk": ["дафт панк"], "Arctic Monkeys": ["арктик манкис"], "Red Hot Chili Peppers": ["ред хот чили пепперс"] };
// Editorial Ukrainian song identities, verified in the original artist catalog.
// Official band history identifies Mad Heads XL as the expanded Mad Heads line-up.
// https://madheads.kiev.ua/en/history?id=122
russianArtistAliases["Mad Heads"]=["Mad Heads XL"];
const ukrainianArtists = [{"id": "796042", "name": "Okean Elzy", "aliases": ["Океан Ельзи"], "genres": ["rock", "pop"], "titles": ["Обійми", "На небі", "Місто весни", "Я їду додому", "Без бою", "Я так хочу...", "Кавачай", "Відпусти", "Коли ми двоє", "Як ніколи", "Квітка"]}, {"id": "1432088", "name": "The Hardkiss", "aliases": ["THE HARDKISS"], "genres": ["rock", "dance"], "titles": ["Коханці", "Журавлі", "Гора", "Кобра", "7 вітрів"]}, {"id": "4394817", "name": "Бумбокс", "aliases": ["Boombox"], "genres": ["pop", "rock", "hiphop"], "titles": ["Квiти в волоссi", "Зцапала-злапала", "Люди", "Наодинці", "Сталеві квіти", "Ким ми були", "Твій на 100%", "Дурень", "Вiддаю", "Поліна"]}, {"id": "4814224", "name": "Скрябін", "aliases": ["Скрябин", "Skryabin"], "genres": ["pop", "rock", "dance"], "titles": ["Спи собі сама", "Мам", "Люди як кораблі", "Старі фотографіі", "Сам собі країна", "Місця щасливих людей", "Кольорова", "100 годин", "Не треба", "Мовчати", "Не думай про завтра", "Маршрутка"]}, {"id": "9828422", "name": "Один в каное", "aliases": ["Odyn v kanoe"], "genres": ["alternative", "folk"], "titles": ["Човен", "У мене немає дому", "Будь мені кимось", "Небо", "Пообіцяй мені", "Мамма", "Демони", "Пам’яті мало", "Подобається, як ти ідеш", "Один в полі воїн", "Маленький хлопчик", "Кому то тре"]}, {"id": "5848638", "name": "ONUKA", "aliases": [], "genres": ["dance", "folk"], "titles": ["Vidlik", "Misto", "Svitanok", "DESNA", "Твій день", "VDOMA", "Zavtra", "GOLOS", "UYAVY"]}, {"id": "6486539", "name": "KAZKA", "aliases": ["Казка"], "genres": ["pop", "dance", "folk"], "titles": ["ПЛАКАЛА", "М'ята", "Пісня Сміливих Дівчат", "СВЯТА", "Все по колу", "Палала", "АЛЛО, ПІДТРИМКА!", "Поруч", "САМА", "МОВЧАТИ", "Золото", "Цілувати тебе (From \"Моя улюблена Страшко\")"]}, {"id": "54213952", "name": "alyona alyona", "aliases": ["Альона Альона"], "genres": ["hiphop"], "titles": ["Teresa & Maria", "KUPALA", "Рідні мої", "Небо хилиться", "Чому?", "Не втратимо зв'язок", "Zozulia", "Dai Boh", "Запроси мене", "Щедра ніч", "Viter viie"]}, {"id": "75567382", "name": "KALUSH", "aliases": ["Kalush Orchestra"], "genres": ["hiphop", "folk"], "titles": ["Stefania (Kalush Orchestra)", "Dodomu", "Kalus'ki vechornici (feat. Tember Blanche) (feat. Tember Blanche)", "Gori (Gory)", "Zori", "Fajna", "Khvili (feat. Jerry Heil) (feat. Jerry Heil)", "Останній раз", "Taksi", "Tipok", "Кропива"]}, {"id": "13436891", "name": "Jerry Heil", "aliases": ["Джері Хейл"], "genres": ["pop"], "titles": ["Дві весни", "Додай гучності (12 points)", "З якого ти поверху неба?", "ВИМОЛИВ", "ТРИ ПОЛОСИ", "ПОДОЛЯНОЧКА (GET UP)", "ТУК ТУК ТУК"]}, {"id": "12360076", "name": "Artem Pivovarov", "aliases": ["Артем Пивоваров"], "genres": ["pop"], "titles": ["Барабан", "Дежавю", "Очі", "О, Панно!", "8 диво", "Там у тополі", "Так ніхто не кохав", "Тішся"]}, {"id": "215102", "name": "Tina Karol", "aliases": ["Тіна Кароль", "Тина Кароль"], "genres": ["pop"], "titles": ["Ми", "Вiльна", "Україна – це ти", "Дзвони", "Людині потрібна людина", "НЕ СВЯТІ", "Вище хмар", "Вабити", "Небесами", "Тепер я знаю"]}, {"id": "1217869", "name": "Jamala", "aliases": ["Джамала"], "genres": ["pop", "jazz", "rnb"], "titles": ["Крила", "Жалі", "Злива", "Закохана", "Заманили", "КЛИЧУ", "Заплуталась", "Замовкни"]}, {"id": "114053322", "name": "DOROFEEVA", "aliases": ["Дорофєєва", "Надя Дорофеева"], "genres": ["pop"], "titles": ["747", "Хартбіт", "Додайте світла", "Японія", "Смак-печаль", "Думи", "Спитай у чата джипіті", "Хай пишуть", "Щоб не було", "Кохаю, але не зовсім", "вотсап", "крапають"]}, {"id": "113002362", "name": "Skofka", "aliases": ["СКОФКА"], "genres": ["hiphop"], "titles": ["Чути гімн", "Крузак", "Батьківщина", "Не забудем і не пробачим", "Береза стара", "ЗАГЛОХ", "Ой на ой", "Погані сусіди", "V dorogu", "СІРНИК", "Геть, за забор", "Я там"]}, {"id": "369308892", "name": "Kola", "aliases": ["KOLA", "Кола"], "genres": ["pop"], "titles": ["Біля серця", "Чи разом?", "Листопад", "Піт-стоп", "Цінувати життя", "Температура", "Тебе - собі", "Дотикам", "Каблучка", "Тюльпани", "Зорепади", "Ба"]}, {"id": "5337130", "name": "Антитіла", "aliases": ["Антитела", "Antytila"], "genres": ["rock", "pop"], "titles": ["Люди як кораблі", "Лови момент", "ВДОМА", "Фортеця Бахмут", "Бери своє", "Молоком", "ОК", "Все красиво", "Танцюй", "Кіно", "Одинак"]}, {"id": "4396972", "name": "Друга Ріка", "aliases": ["Друга Река", "Druha Rika"], "genres": ["rock"], "titles": ["Секрет", "Три хвилини", "Так мало тут тебе", "ЧИ ТИ ПОЧУВ for Mariupol", "Вже не сам", "Відчиняй", "П’ю з твоїх долонь", "Доки я не пішов", "Париж", "Ангел", "Математика", "Денніч"]}, {"id": "7872896", "name": "Христина Соловій", "aliases": ["Христина Соловей", "Khrystyna Soloviy"], "genres": ["pop", "folk"], "titles": ["Тримай", "Fortepiano", "Галіція", "Хто, як не ти?", "Синя пісня", "Шкідлива звичка", "Любий друг", "2:00 (Друга ночі)", "Я твоя зброя", "Стежечка"]}, {"id": "162861367", "name": "YAKTAK", "aliases": ["ЯКТАК"], "genres": ["pop"], "titles": ["Погляд", "Уночі", "Порічка", "Якби не було тебе", "Чекає вдома", "На нічному небі", "Небо", "Ендорфін", "Селяві", "Нижча зростом", "Букети", "Люди"]}, {"id": "11495570", "name": "БЕЗ ОБМЕЖЕНЬ", "aliases": ["Без обмежень"], "genres": ["rock", "pop"], "titles": ["ДИМ", "Без неї ніяк", "Вільні люди", "Героям", "Якби", "Мовчати", "Зорі запалали", "Буду з тобою", "Весь світ", "Народжені вільними", "24/02", "Мільярди"]}, {"id": "160988752", "name": "SHUMEI", "aliases": ["Шумей"], "genres": ["pop"], "titles": ["Буревіями", "Біля тополі", "Волосся", "Цілуй", "Родимка", "Ти занадто красива", "Вище хмар", "Пробач", "Вона була така", "Бонсуа", "Комета"]}, {"id": "13687311", "name": "TVORCHI", "aliases": ["Творчі"], "genres": ["dance", "pop", "rnb"], "titles": ["Мила моя", "Мрійники", "Орбіти", "Каланхое", "Надія", "Вихідний", "Досить", "#не_танцюю"]}, {"id": "11498862", "name": "Go_A", "aliases": ["Go A", "Го А"], "genres": ["dance", "folk"], "titles": ["SHUM", "Kalyna", "Krip", "Rusalochki", "Dumala", "Dim", "Ruta"]}, {"id": "2544561", "name": "Jinjer", "aliases": [], "genres": ["rock"], "titles": []}, {"id": "1365309", "name": "MAX BARSKIH", "aliases": ["Макс Барських"], "genres": ["pop"], "titles": []}, {"id": "7063077", "name": "MONATIK", "aliases": ["Монатік"], "genres": ["pop"], "titles": []}, {"id": "5492952", "name": "DakhaBrakha", "aliases": ["ДахаБраха"], "genres": ["pop"], "titles": []}, {"id": "1110556", "name": "NK", "aliases": ["Настя Каменських"], "genres": ["pop"], "titles": []}, {"id": "876284", "name": "Stoned Jesus", "aliases": [], "genres": ["pop"], "titles": []}, {"id": "6773641", "name": "YARMAK", "aliases": ["Ярмак"], "genres": ["hip-hop"], "titles": []}, {"id": "116247522", "name": "SadSvit", "aliases": ["СедСвіт"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "13009335", "name": "Жадан і Собаки", "aliases": ["Zhadan i Sobaky"], "genres": ["pop"], "titles": []}, {"id": "5740652", "name": "СКАЙ", "aliases": ["SKAI", "Skay"], "genres": ["rock"], "titles": []}, {"id": "225100035", "name": "Klavdia Petrivna", "aliases": [], "genres": ["pop"], "titles": []}, {"id": "4554978", "name": "Kozak System", "aliases": ["Козак Систем"], "genres": ["rock"], "titles": []}, {"id": "6790765", "name": "Vivienne Mort", "aliases": ["Вів’єн Морт"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "10521433", "name": "MamaRika", "aliases": ["МамаРіка"], "genres": ["pop"], "titles": []}, {"id": "6168696", "name": "ТНМК", "aliases": ["TNMK"], "genres": ["hip-hop"], "titles": []}, {"id": "12751613", "name": "Карна", "aliases": ["KARNA"], "genres": ["rock"], "titles": []}, {"id": "69399722", "name": "Wellboy", "aliases": ["Велбой"], "genres": ["pop"], "titles": []}, {"id": "5269324", "name": "Тартак", "aliases": ["Tartak"], "genres": ["rock"], "titles": []}, {"id": "6548715", "name": "Somali Yacht Club", "aliases": [], "genres": ["pop"], "titles": []}, {"id": "9141352", "name": "Тінь Сонця", "aliases": ["Tin Sontsya"], "genres": ["rock"], "titles": []}, {"id": "169710707", "name": "СТРУКТУРА ЩАСТЯ", "aliases": ["Struktura Shchastia"], "genres": ["pop"], "titles": []}, {"id": "10147002", "name": "MÉLOVIN", "aliases": ["Меловін"], "genres": ["pop"], "titles": []}, {"id": "11529071", "name": "Dakh Daughters", "aliases": [], "genres": ["pop"], "titles": []}, {"id": "56751292", "name": "Parfeniuk", "aliases": ["Парфенюк"], "genres": ["pop"], "titles": []}, {"id": "166523867", "name": "хейтспіч", "aliases": ["hate speech"], "genres": ["hip-hop"], "titles": []}, {"id": "4444748", "name": "Pianoboy", "aliases": ["Pianoбой"], "genres": ["pop"], "titles": []}, {"id": "78019052", "name": "CHEEV", "aliases": ["Чів"], "genres": ["pop"], "titles": []}, {"id": "12588868", "name": "LATEXFAUNA", "aliases": [], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "10838738", "name": "Воплі Відоплясова", "aliases": ["Vopli Vidopliassova", "Вопли Видоплясова"], "genres": ["pop"], "titles": []}, {"id": "108911822", "name": "Tember Blanche", "aliases": ["Тембер Бланш"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "182282107", "name": "Drevo", "aliases": ["Древо"], "genres": ["pop"], "titles": []}, {"id": "14570229", "name": "Alina Pash", "aliases": ["Аліна Паш"], "genres": ["hip-hop"], "titles": []}, {"id": "5593392", "name": "Фіолет", "aliases": ["Fiolet"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "4611681", "name": "Zlata Ognevich", "aliases": ["Злата Огнєвіч"], "genres": ["pop"], "titles": []}, {"id": "14447813", "name": "The Unsleeping", "aliases": [], "genres": ["rock"], "titles": []}, {"id": "65459832", "name": "Плач Єремії", "aliases": ["Plach Yeremiyi"], "genres": ["rock"], "titles": []}, {"id": "191480187", "name": "KOZAK SIROMAHA", "aliases": ["Козак Сіромаха"], "genres": ["pop"], "titles": []}, {"id": "12049160", "name": "TAYANNA", "aliases": ["Таянна"], "genres": ["pop"], "titles": []}, {"id": "5559710", "name": "Мері", "aliases": ["Meri"], "genres": ["rock"], "titles": []}, {"id": "5475037", "name": "Michelle Andrade", "aliases": ["Мішель Андраде"], "genres": ["pop"], "titles": []}, {"id": "208125427", "name": "Adam", "aliases": ["Адам"], "genres": ["pop"], "titles": []}, {"id": "1365961", "name": "Ot Vinta", "aliases": ["От Вінта"], "genres": ["rock"], "titles": []}, {"id": "194127167", "name": "Lely45", "aliases": ["Лелі45"], "genres": ["pop"], "titles": []}, {"id": "5841778", "name": "Мертвий півень", "aliases": ["Mertvyy Piven"], "genres": ["rock"], "titles": []}, {"id": "5947066", "name": "Panivalkova", "aliases": ["ПаніВалькова"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "5300725", "name": "Олександр Пономарьов", "aliases": ["Oleksandr Ponomariov"], "genres": ["pop"], "titles": []}, {"id": "60120252", "name": "Саша Чемеров", "aliases": ["Sasha Chemerov"], "genres": ["rock"], "titles": []}, {"id": "11372960", "name": "Ivan NAVI", "aliases": ["Іван Наві"], "genres": ["pop"], "titles": []}, {"id": "102262192", "name": "OTOY", "aliases": ["Отой"], "genres": ["hip-hop"], "titles": []}, {"id": "5841789", "name": "Фліт", "aliases": ["Flit"], "genres": ["rock"], "titles": []}, {"id": "227459315", "name": "Ziferblat", "aliases": ["Циферблат"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "1465720", "name": "Zapaska", "aliases": ["Запаска"], "genres": ["pop"], "titles": []}, {"id": "12371770", "name": "Yuko", "aliases": ["Юко"], "genres": ["pop"], "titles": []}, {"id": "100048592", "name": "Enleo", "aliases": ["Енлео"], "genres": ["pop"], "titles": []}, {"id": "13507067", "name": "Димна суміш", "aliases": ["Dymna Sumish"], "genres": ["rock"], "titles": []}, {"id": "6182544", "name": "Ірина Білик", "aliases": ["Iryna Bilyk"], "genres": ["pop"], "titles": []}, {"id": "5788044", "name": "Kadnay", "aliases": [], "genres": ["pop"], "titles": []}, {"id": "122088282", "name": "POSITIFF", "aliases": ["Позитив"], "genres": ["pop"], "titles": []}, {"id": "4913073", "name": "Bloom Twins", "aliases": [], "genres": ["pop"], "titles": []}, {"id": "183204577", "name": "Golubenko", "aliases": ["Голубенко"], "genres": ["pop"], "titles": []}, {"id": "5294663", "name": "Руслана", "aliases": ["Ruslana"], "genres": ["pop"], "titles": []}, {"id": "5250720", "name": "Гайдамаки", "aliases": ["Haydamaky"], "genres": ["rock"], "titles": []}, {"id": "144851832", "name": "NAZVA", "aliases": ["Назва"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "5300723", "name": "Віктор Павлік", "aliases": ["Viktor Pavlik"], "genres": ["pop"], "titles": []}, {"id": "13085023", "name": "Іво Бобул", "aliases": ["Ivo Bobul"], "genres": ["pop"], "titles": []}, {"id": "1643782", "name": "Qarpa", "aliases": ["Карпа"], "genres": ["rock"], "titles": []}, {"id": "144150372", "name": "Victoria NIRO", "aliases": ["Вікторія Ніро"], "genres": ["pop"], "titles": []}, {"id": "137234852", "name": "ROXOLANA", "aliases": ["Роксолана"], "genres": ["pop"], "titles": []}, {"id": "12021844", "name": "Мандри", "aliases": ["Mandry"], "genres": ["rock"], "titles": []}, {"id": "5551804", "name": "Гайтана", "aliases": ["Gaitana"], "genres": ["pop"], "titles": []}, {"id": "5332240", "name": "Роллікс", "aliases": ["Rolliks"], "genres": ["rock"], "titles": []}, {"id": "80163882", "name": "Схожа", "aliases": ["Skhozha"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "178585087", "name": "MOLODI", "aliases": ["Молоді"], "genres": ["pop"], "titles": []}, {"id": "11520419", "name": "Павло Зібров", "aliases": ["Pavlo Zibrov"], "genres": ["pop"], "titles": []}, {"id": "4462738", "name": "Олег Скрипка", "aliases": ["Oleg Skrypka"], "genres": ["rock"], "titles": []}, {"id": "8891028", "name": "Наталія Могилевська", "aliases": ["Natalia Mogilevska"], "genres": ["pop"], "titles": []}, {"id": "7122709", "name": "Марія Бурмака", "aliases": ["Maria Burmaka"], "genres": ["pop"], "titles": []}, {"id": "77031622", "name": "Fiinka", "aliases": ["Фіїнка", "Фіінка"], "genres": ["pop"], "titles": []}, {"id": "172413857", "name": "NICHKA", "aliases": ["Нічка"], "genres": ["pop"], "titles": []}, {"id": "8891024", "name": "Андрій Хливнюк", "aliases": ["Andriy Khlyvnyuk"], "genres": ["pop"], "titles": []}, {"id": "13725509", "name": "Оксана Білозір", "aliases": ["Oksana Bilozir"], "genres": ["pop"], "titles": []}, {"id": "76793", "name": "Anka", "aliases": ["Анка"], "genres": ["pop"], "titles": []}, {"id": "10118402", "name": "Taras Chubay", "aliases": ["Тарас Чубай"], "genres": ["rock"], "titles": []}, {"id": "68020632", "name": "Оксана Муха", "aliases": ["Oksana Mukha"], "genres": ["pop"], "titles": []}, {"id": "5204348", "name": "Yuvi", "aliases": ["Юві"], "genres": ["indie-rock", "alternative"], "titles": []}, {"id": "139384092", "name": "Друже музико", "aliases": ["Druzhe Muzyko"], "genres": ["rock"], "titles": []}];

export const ukrainianPrompt = (prompt:string) => /укра[їи]н|ukrain/i.test(prompt);
// Canonical spelling and common inflections share the same verified performer ID.
ukrainianArtists.find(artist=>artist.id==='54213952')!.aliases.push('Альони Альони','Альону Альону','Алёна Алёна','Алены Алены','Алена Алена','Aliona Aliona','AlyonaAlyona');

for (const direction of additionalDirections) {
  const regional = direction.region === 'UA' ? ukrainianArtists.filter(artist =>
    (!direction.artists || direction.artists.includes(artist.name)) && (!direction.genre || artist.genres.includes(direction.genre))) : [];
  const artists = direction.artists ?? (direction.region === 'UA' ? regional.map(artist => artist.name)
    : direction.theme === 'ballads' ? [...new Set(ballads.filter(song => song.region !== 'UA').map(song => song.artist))]
    : genres.find(genre => genre.slug === direction.genre)?.artists ?? []);
  definitions.push({ slug: direction.slug, title: direction.titles.uk, category: direction.category, artists,
    genreSlugs: direction.genre ? [direction.genre] : [], decade: direction.decade, region: direction.region,
    canonicalIds: direction.region === 'UA' ? regional.map(artist => artist.id) : undefined, theme: direction.theme });
}

// Artist mixes are composed from existing provider records, never invented identities.
// Genre/era/language recipes resolve and verify their exact recordings at game start.
const readyDecks = new Map<string, Track[]>();
for (const definition of definitions) {
  const preset = readyPresets[definition.slug];
  if (preset) readyDecks.set(definition.slug, deduplicateRecordings(preset.deck));
  else if (definition.category === 'mix' && additionalDirections.some(direction => direction.slug === definition.slug && direction.artists?.length)) {
    const members = definition.artists.map(name => Object.values(readyPresets).find(item => normalized(item.title) === normalized(name)));
    if (members.every(Boolean)) {
      const pool = deduplicateRecordings(members.flatMap(member => member!.deck));
      readyDecks.set(definition.slug, definition.region === 'UA' ? pool.filter(ukrainianTrackAllowed) : pool);
    }
  }
}
export const popularCollections = definitions.map((definition, index) => {
  const deck = readyDecks.get(definition.slug), color = ["#a7a3f6", "#e6a585", "#a5c9ba", "#f5a7bd", "#95b7df"][index % 5];
  const artwork = new Map<string, string>();
  for (const track of deck ?? []) if (track.artworkUrl && !artwork.has(track.artist)) artwork.set(track.artist, track.artworkUrl);
  const images = [...artwork.values()].slice(0, 4);
  return {
    id: `popular-${definition.slug}`, title: definition.title,
    subtitle: definition.decade ? `${definition.decade}–${definition.decade + 9}` : definition.category === 'mix' ? definition.artists.slice(0, 4).join(' · ') : '',
    category: definition.category, kind: definition.category, songOnly: definition.category === "artist",
    maximumUniqueArtists: definition.artists.length,
    selectedArtistCount: definition.category === 'artist' || definition.category === 'mix' && !!deck ? definition.artists.length : undefined,
    color, tag: definition.category === "era" ? "DECADE" : definition.category === "artist" ? "ARTIST" : definition.category === 'mix' ? 'MIX' : "GENRE",
    image: images[0] ?? (definition.category === "artist" ? undefined : definition.region === 'UA' ? 'https://upload.wikimedia.org/wikipedia/commons/4/49/Flag_of_Ukraine.svg'
      : definition.slug === "eurovision" ? "https://upload.wikimedia.org/wikipedia/commons/b/b7/Flag_of_Europe.svg"
      : symbolicCover(definition.decade ? String(definition.decade) : definition.title, color)),
    images, artistNames: deck ? [...new Set(deck.map(track => track.artist))] : [],
    count: deck?.length, ready: !!deck?.length, playable: true, source: "deezer" as const, live: true,
    supportedCounts: deck ? [10, 20, 50, 100].filter(count => count <= deck.length) : undefined,
    supportedUniqueCounts: deck ? [10, 20, 50, 100].filter(count => count <= new Set(deck.map(track => track.artist)).size) : undefined,
    popularity: { provider: "Deezer", metric: "rank", minimum: MIN_RANK },
  };
});

export function ukrainianTrackAllowed(track:Pick<Track,"artist"|"title">){return ukrainianArtists.some(artist=>[artist.name,...artist.aliases].some(name=>normalized(name)===normalized(track.artist))&&(!/[ыэъё]/i.test(track.title))&&(artist.titles.some(title=>normalized(title)===normalized(track.title))||/[іїєґ]/i.test(track.title)));}
export type PopularQuery = { theme?:"ballads"|"eurovision"; artists: string[]; genreSlugs: string[]; decade?: number; title: string; category: "genre" | "era" | "artist" | "mix"; explicitArtists?: boolean; canonicalIds?: string[]; region?: "UA" };
export function parsePopularPrompt(prompt: string): PopularQuery {
  const isEurovision = eurovision.aliases!.some(alias=>contains(prompt,alias));
  const isBallad=/бал[а]?д|баллад|ballad|романтич|romantic|love songs|пісні про кохання|песни о любви/i.test(prompt);
  if(isEurovision&&isBallad)throw new ApiError(422,'PROMPT_NOT_UNDERSTOOD','Для баллад Евровидения пока нет подтверждённого пересечения. Выберите баллады или конкурсные песни.');
  if(!isBallad&&/сумн|грустн|sad|весел|happy|тренув|трениров|workout|сон|sleep|агресив|агрессив|relax|розслаб|расслаб/i.test(prompt))throw new ApiError(422,'PROMPT_NOT_UNDERSTOOD','Для этой темы пока нет проверенного списка песен. Выберите жанр, эпоху, исполнителя или романтические баллады.');
  const named = [...new Set([...definitions.flatMap(item => item.artists),...ukrainianArtists.map(artist=>artist.name),...eurovisionSongs.map(song=>song.artist)])].filter(name => [name,...(ukrainianArtists.find(artist=>artist.name===name)?.aliases??[]), ...(russianArtistAliases[name] ?? []), ...(artistDefinitions.find(item => item.title === name)?.aliases ?? [])].some(alias => contains(prompt, alias)));
  let selectedGenres = genres.filter(item => item.aliases?.some(alias => contains(prompt, alias)));
  // A more specific subgenre takes precedence over its parent word.
  if(selectedGenres.some(g=>['classic-rock','indie-rock'].includes(g.slug)))selectedGenres=selectedGenres.filter(g=>g.slug!=='rock');
  if(selectedGenres.some(g=>g.slug==='pop-punk'))selectedGenres=selectedGenres.filter(g=>!['pop','punk'].includes(g.slug));
  if(selectedGenres.some(g=>g.slug==='synth-pop'))selectedGenres=selectedGenres.filter(g=>g.slug!=='pop');
  const decadeMatch = prompt.match(/\b(19[7-9]0|20[0-2]0)(?:\s*[-–]?\s*(?:е|ые|х|s|ті|тіх))?/i) ?? prompt.match(/(?:^|\s)([789]0|00|10|20)\s*[-–]?\s*(?:е|ые|х|s|ті|тіх)(?=\s|$|[,.;])/i);
  let decade = decadeMatch ? Number(decadeMatch[1]) : undefined;
  if (decade !== undefined && decade < 100) decade += decade >= 70 ? 1900 : 2000;
  if (/нулев|нульов|noughties/i.test(prompt)) decade = 2000;
  const requestedYears = [...prompt.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match=>Number(match[0]));
  const shortEras = [...prompt.matchAll(/(?:^|\s)([789]0|00|10|20)\s*[-–]?\s*(?:е|ые|х|s|ті|тіх)(?=\s|$|[,.;])/gi)].map(match=>Number(match[1])+(Number(match[1])>=70?1900:2000));
  const periods = new Set([...requestedYears, ...shortEras, ...(/нулев|нульов|noughties/i.test(prompt)?[2000]:[])]);
  if((selectedGenres.length||isBallad||isEurovision||decade!==undefined)&&([ ...periods ].some(value=>value%10!==0||value<1970||value>2020)||periods.size>1))throw new ApiError(422,'PROMPT_NOT_UNDERSTOOD','Укажите одно десятилетие: 70-х, 80-х, 90-х, 00-х, 10-х или 20-х. Несколько эпох и точные годы пока не поддерживаются.');
  const era = eras.find(item => item.decade === decade);
  // Do not silently discard an unsupported theme just because a genre word was found.
  if((named.length||selectedGenres.length||era||isBallad||isEurovision)&&!(/русск|росси[йя]|russian|француз|french|німець|немец|german|japanese|korean|spanish|italian|american|british|english/i.test(prompt))){
    let remainder=` ${normalized(prompt)} `;
    const aliases=[...named.flatMap(name=>[name,...(russianArtistAliases[name]??[]),...(ukrainianArtists.find(a=>a.name===name)?.aliases??[]),...(artistDefinitions.find(a=>a.title===name)?.aliases??[])]),...genres.flatMap(g=>g.aliases??[]),...eurovision.aliases!].sort((a,b)=>b.length-a.length);
    for(const alias of aliases)remainder=remainder.replaceAll(` ${normalized(alias)} `,' ');
    const generic=/^(?:create|make|build|generate|only|тільки|только|a|an|the|of|for|with|and|or|by|my|me|please|playlist|collection|quiz|mix|songs?|tracks?|hits?|top|popular|famous|favorites?|favourites?|greatest|best|романтич\p{L}*|romantic|ballads?|love|нулев\p{L}*|нульов\p{L}*|noughties|укра[їиі]н\p{L}*|ukrain\p{L}*|кохання|любви|про|создай|создать|сделай|зроби|створи|підбери|подбери|подборк\p{L}*|добірк\p{L}*|коллекци\p{L}*|колекці\p{L}*|песн\p{L}*|пісн\p{L}*|трек\p{L}*|хит\p{L}*|хіт\p{L}*|известн\p{L}*|відом\p{L}*|популярн\p{L}*|лучши\p{L}*|найкращ\p{L}*|любим\p{L}*|улюблен\p{L}*|музык\p{L}*|музик\p{L}*|для|меня|мені|я|мне|пожалуйста|будь|ласка|по|с|s|із|з|и|і|або|та|в|на|от|до|из|х|е|ые|ті|\d+)$/u;
    if(remainder.trim().split(/\s+/).filter(Boolean).some(word=>!generic.test(word)))throw new ApiError(422,'PROMPT_NOT_UNDERSTOOD','Часть запроса не распознана. Укажите жанр, эпоху, исполнителей или романтические баллады; неизвестные условия не игнорируются.');
  }
  // Explicit artist names constrain the pool; unrelated chart entries never fill it.

  const seeds = named.length ? named : selectedGenres.length ? interleave(selectedGenres.map(item => item.artists)) : isEurovision ? eurovision.artists : era?.artists ?? [];
  if(ukrainianPrompt(prompt)){
    if(named.some(name=>!ukrainianArtists.some(artist=>artist.name===name)))throw new ApiError(422,"PROMPT_CONFLICT","Указанный исполнитель не входит в украинскую подборку. Уберите конфликтующее условие.");
    const regional=ukrainianArtists.filter(artist=>(!named.length||named.includes(artist.name))&&(!selectedGenres.length||selectedGenres.some(genre=>genre.slug==="ballads"||artist.genres.includes(genre.slug))));
    if(!regional.length)throw new ApiError(422,"PROMPT_NOT_UNDERSTOOD","Для этого сочетания языка и жанра нет проверенного каталога. Уточните запрос.");
    return {theme:isBallad?"ballads":isEurovision?"eurovision":undefined,artists:regional.map(artist=>artist.name),canonicalIds:regional.map(artist=>artist.id),genreSlugs:selectedGenres.filter(genre=>genre.slug!=="ballads").map(genre=>genre.slug),region:"UA",decade,title:prompt.slice(0,100),category:named.length===1?"artist":"mix",explicitArtists:named.length>0};
  }
  if(/русск|росси[йя]|russian|француз|французь|french|німець|немец|german|японсь|японск|japanese|корей|korean|іспан|испан|spanish|італ|итал|italian|американ|american|британ|british|англомов|английск|english/i.test(prompt))throw new ApiError(422,"REGIONAL_CATALOG_UNAVAILABLE","Для указанного региона или языка пока нет проверенного каталога. Укажите конкретных исполнителей.");
  const category = named.length === 1 && !selectedGenres.length && !era ? "artist" : !named.length && selectedGenres.length === 1 && !era ? "genre" : !named.length && !selectedGenres.length && era ? "era" : "mix";
  return { theme:isBallad?"ballads":isEurovision?"eurovision":undefined, artists: isBallad&&!named.length?ballads.filter(t=>t.region!=="UA").map(t=>t.artist):seeds, genreSlugs: selectedGenres.filter(item=>item.slug!=="ballads").map(item => item.slug), decade, title: prompt.slice(0, 100), category, explicitArtists: named.length > 0 };
}
function interleave(groups: string[][]) { return [...new Set(Array.from({ length: Math.max(0, ...groups.map(group => group.length)) }, (_, index) => groups.map(group => group[index]).filter(Boolean)).flat())]; }
export async function deezerRequest<T>(path: string): Promise<T> {
  // Public API quotas are shared by egress IP. Pace independent metadata reads;
  // never turn a rate-limit error into an empty or fabricated collection.
  const slot = Math.max(Date.now(), nextRequestAt);
  if (slot - Date.now() > 10000) throw new ApiError(429, "MUSIC_RATE_LIMIT", "Каталог занят другими запросами. Подождите несколько секунд и повторите.");
  nextRequestAt = slot + 150;
  const delay = slot - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  let response: Response;
  try { response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" } }); }
  catch { throw new ApiError(504, "MUSIC_TIMEOUT", "Каталог Deezer не ответил вовремя. Повторите запрос."); }
  if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, "MUSIC_PROVIDER_ERROR", "Каталог Deezer временно недоступен. Повторите запрос позже.");
  let payload: T & { error?: { code?: number } };
  try { payload = await response.json() as T & { error?: { code?: number } }; }
  catch { throw new ApiError(502, "MUSIC_INVALID_RESPONSE", "Музыкальный каталог вернул некорректный ответ. Повторите запрос позже."); }
  if (!payload || typeof payload !== "object") throw new ApiError(502, "MUSIC_INVALID_RESPONSE", "Музыкальный каталог вернул некорректный ответ.");
  if (payload.error) throw new ApiError(payload.error.code === 4 ? 429 : 502, payload.error.code === 4 ? "MUSIC_RATE_LIMIT" : "MUSIC_PROVIDER_ERROR", payload.error.code === 4 ? "Deezer временно ограничил число запросов. Подождите несколько секунд и повторите." : "Deezer не смог предоставить запрошенную запись.", { providerCode: payload.error.code });
  return payload;
}
export async function resolveArtist(name: string): Promise<Artist> {
  const discovered=await discoveryForQuery(name);
  if(discovered.length===1)return canonicalArtistId(String(discovered[0].id));
  const aliasName=Object.entries(russianArtistAliases).find(([,aliases])=>aliases.some(alias=>normalized(alias)===normalized(name)))?.[0]??artistDefinitions.find(item=>item.aliases?.some(alias=>normalized(alias)===normalized(name)))?.title;
  if(aliasName&&normalized(aliasName)!==normalized(name))return resolveArtist(aliasName);
  const cached = artistCache.get(normalized(name));
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const regional=ukrainianArtists.find(artist=>[artist.name,...artist.aliases].some(alias=>normalized(alias)===normalized(name)));
  if(regional)return canonicalArtistId(regional.id);
  const key = `deezer-artist-name:${normalized(name)}`;
  const stored = await database().prepare("SELECT track_data, updated_at FROM echo_media_collections WHERE id = ?").bind(key).first<{ track_data: string; updated_at: number }>();
  if (stored && stored.updated_at > Date.now() - 86400000) {
    const value = await readJson<Artist>(stored.track_data);
    artistCache.set(normalized(name), { value, expiresAt: Date.now() + 21600000 });
    return value;
  }
  const result = await deezerRequest<{ data?: Artist[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=100`);
  const matches = (result.data ?? []).filter(artist => Number.isSafeInteger(artist.id) && normalized(artist.name) === normalized(name)).sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0));
  if (!matches.length) throw new ApiError(422, "ARTIST_NOT_FOUND", `Не найден известный исполнитель «${name}». Уточните имя по-русски или по-английски.`);
  artistCache.set(normalized(name), { value: matches[0], expiresAt: Date.now() + 21600000 });
  await cacheMetadata(key, matches[0]);
  await cacheMetadata(`deezer-artist-id:${matches[0].id}`, matches[0]);
  await rememberDiscoveredArtist(matches[0]);
  return matches[0];
}
export async function rememberDiscoveredArtist(artist:Artist){
 if(!Number.isSafeInteger(artist.id)||artist.id<=0||!artist.name?.trim())throw new ApiError(400,'INVALID_ARTIST_IDS','Некоректний виконавець.');
 await cacheMetadata(`deezer-discovered-artist:${artist.id}`,artist);
}
export async function rememberArtistQuery(query:string,artists:Artist[]){
 if(query.trim().length<2||query.length>100)return;
 await cacheMetadata(`deezer-discovered-query:${normalized(query)}`,artists.map(a=>String(a.id)));
}
async function discoveryForQuery(query:string):Promise<Artist[]>{
 const row=await database().prepare('SELECT track_data FROM echo_media_collections WHERE id = ?').bind(`deezer-discovered-query:${normalized(query)}`).first<{track_data:string}>();
 if(!row)return [];const ids=await readJson<string[]>(row.track_data),found:Artist[]=[];
 for(const id of ids.slice(0,5)){const saved=await database().prepare('SELECT track_data FROM echo_media_collections WHERE id = ?').bind(`deezer-discovered-artist:${id}`).first<{track_data:string}>();if(saved)found.push(await readJson<Artist>(saved.track_data));}return found;
}
async function discoveredArtists(){const result=await database().prepare('SELECT track_data FROM echo_media_collections WHERE id LIKE ? ORDER BY updated_at DESC').bind('deezer-discovered-artist:%').all<{track_data:string}>();return Promise.all((result.results??[]).map(row=>readJson<Artist>(row.track_data)));}
async function cacheMetadata(key: string, value: unknown) {
  await database().prepare("INSERT INTO echo_media_collections (id, track_data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET track_data = excluded.track_data, updated_at = excluded.updated_at").bind(key, await storeJson(key,value), Date.now()).run();
}
function portrait(artist: Artist) { const image = artist.picture_big || artist.picture_medium; return image?.startsWith("https://cdn-images.dzcdn.net/images/artist/") ? image : undefined; }
function artistCard(artist: Artist) { return { id: String(artist.id), name: artist.name, image: portrait(artist), fans: artist.nb_fan ?? 0, source: "deezer" as const }; }
async function canonicalArtistId(value: string): Promise<Artist> {
  if (!/^[1-9]\d{0,10}$/.test(value)) throw new ApiError(400, "INVALID_ARTIST_IDS", "Выберите исполнителей из каталога.");
  const key = `deezer-artist-id:${value}`;
  const stored = await database().prepare("SELECT track_data, updated_at FROM echo_media_collections WHERE id = ?").bind(key).first<{ track_data: string; updated_at: number }>();
  let artist: Artist;
  try { artist = stored && stored.updated_at > Date.now() - 86400000 ? await readJson<Artist>(stored.track_data) : await deezerRequest<Artist>(`/artist/${value}`); }
  catch (error) { if (error instanceof ApiError && error.extra?.providerCode === 800) throw new ApiError(422, "ARTIST_NOT_FOUND", "Выбранный исполнитель не найден. Обновите каталог и выберите другого."); throw error; }
  if (artist.id !== Number(value) || !artist.name?.trim()) throw new ApiError(422, "ARTIST_NOT_FOUND", "Этот исполнитель не найден в популярном каталоге. Выберите другого.");
  if (!stored || stored.updated_at <= Date.now() - 86400000) {await cacheMetadata(key, artist);await rememberDiscoveredArtist(artist);}
  return artist;
}
export async function artistBrowser(query: string, cursor = 0, limit = 24, sort = "popular") {
  if (query.length > 100 || !Number.isInteger(cursor) || cursor < 0 || !Number.isSafeInteger(cursor) || !Number.isInteger(limit) || limit < 1 || limit > 60) throw new ApiError(400, "INVALID_ARTIST_SEARCH", "Некорректный поиск исполнителей.");
  if(!["popular","name"].includes(sort))throw new ApiError(400,"INVALID_ARTIST_SEARCH","Некорректная сортировка.");
  if(ukrainianPrompt(query)){const list=[...ukrainianArtists].sort((a,b)=>sort==="name"?a.name.localeCompare(b.name,"uk"):Number(verifiedUkrainianFans[b.id]??0)-Number(verifiedUkrainianFans[a.id]??0));const chosen=list.slice(cursor,cursor+limit);return {artists:await Promise.all(chosen.map(async a=>artistCard(await canonicalArtistId(a.id)))),nextCursor:cursor+limit<list.length?cursor+limit:null,total:list.length};}
  const regionalMatch=ukrainianArtists.find(artist=>[artist.name,...artist.aliases].some(alias=>normalized(alias)===normalized(query)));
  if(regionalMatch){const artist=await canonicalArtistId(regionalMatch.id);return {artists:cursor===0?[artistCard(artist)]:[],nextCursor:null,total:1};}
  const remembered=query.trim()?await discoveryForQuery(query):[];
  if(remembered.length)return {artists:cursor===0?remembered.map(artistCard):[],nextCursor:null,total:remembered.length,discovered:true};
  if (!query.trim()) {
    limit = Math.min(limit, 40); // Discovery resolves names individually; remain under50cold external reads.
    const registered=await discoveredArtists(),allNames=[...new Set([...discoveryNames,...registered.map(a=>a.name).sort((a,b)=>a.localeCompare(b))])];
    if(sort==='name')allNames.sort((a,b)=>a.localeCompare(b));
    const names = allNames.slice(cursor, cursor + limit), found: Artist[] = [];
    for (let index = 0; index < names.length; index += 12) {
      const values = await Promise.allSettled(names.slice(index, index + 12).map(resolveArtist));
      for (const value of values) {
        if (value.status === "fulfilled") found.push(value.value);
        else if (!(value.reason instanceof ApiError) || value.reason.code !== "ARTIST_NOT_FOUND") throw value.reason;
      }
    }
    return { artists: [...new Map(found.map(artist => [artist.id, artistCard(artist)])).values()], nextCursor: cursor + limit < allNames.length ? cursor + limit : null, total: allNames.length };
  }
  const aliases = [...new Set(definitions.flatMap(item => item.artists))].filter(name => [...(russianArtistAliases[name] ?? []), ...(artistDefinitions.find(item => item.title === name)?.aliases ?? [])].some(alias => normalized(alias).includes(normalized(query))));
  const searched = aliases.length === 1 ? aliases[0] : query.trim();
  const response = await deezerRequest<{ data?: Artist[]; total?: number }>(`/search/artist?q=${encodeURIComponent(searched)}&index=${cursor}&limit=${limit}&order=${sort==="name"?"ARTIST_ASC":"RANKING"}`);
  const unique = new Map<string, Artist>();
  for (const artist of response.data ?? []) {
    if (!Number.isSafeInteger(artist.id) || artist.id <= 0 || !artist.name) continue;
    const key = String(artist.id), preceding = unique.get(key);
    if (!preceding || (artist.nb_fan ?? 0) > (preceding.nb_fan ?? 0)) unique.set(key, artist);
  }
  for (const artist of unique.values()){await cacheMetadata(`deezer-artist-id:${artist.id}`, artist);await cacheMetadata(`deezer-artist-name:${normalized(artist.name)}`,artist);await rememberDiscoveredArtist(artist);}
  return { artists: [...unique.values()].map(artistCard), nextCursor: cursor + limit < (response.total ?? 0) ? cursor + limit : null, total: response.total ?? unique.size, needsDiscovery:cursor===0&&!Array.from(unique.values()).some(artist=>normalized(artist.name).includes(normalized(searched))) };
}
export async function popularCards(){return [...popularCollections].sort((a,b)=>Number(b.ready)-Number(a.ready));}

function previewUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && /(^|\.)dzcdn\.net$/.test(url.hostname) && url.pathname.endsWith(".mp3"); } catch { return false; }
}
export function eligibleRecording(track: Recording, artistId?: number) {
  return Number.isSafeInteger(track.id) && track.id > 0 && track.readable !== false && previewUrl(track.preview) && !!track.artist?.name &&
    (!artistId || track.artist.id === artistId) && Number.isFinite(track.rank) && track.rank! >= MIN_RANK && track.rank! <= 1000000 &&
    Number.isFinite(track.duration) && track.duration! >= 60 && !!track.title?.trim() && track.title.length <= 200 &&
    !/\b(live|karaoke|instrumental|tribute|cover|demo|commentary|remix|sped up|slowed|radio edit)\b|concert|made famous|originally performed/i.test(`${track.title} ${track.title_version ?? ""} ${track.artist.name}`);
}
export function recordingTrack(track: Recording, genre = "Popular", releaseDate?: string): Track {
  const title = (track.title_short || track.title).trim(), year = Number((releaseDate || track.release_date || "").slice(0, 4));
  return { id: `deezer-${track.id}`, provider: "deezer", providerId: String(track.id), title, titleAliases: title !== track.title ? [track.title] : undefined,
    artist: track.artist!.name, genres: [genre], year: Number.isFinite(year) && year >= 1900 ? year : 0, popularityRank: track.rank,
    audioUrl: track.preview, duration: 30, verseStart: 2, verseEnd: 9, hintStart: 12, encoreStart: 15,
    artworkUrl: track.album?.cover_big?.startsWith("https://cdn-images.dzcdn.net/") ? track.album.cover_big : undefined,
    sourceUrl: `https://www.deezer.com/track/${track.id}`, rights: "Deezer API: личное некоммерческое использование, публичное 30-секундное превью. Не полный трек.",
  };
}
export function deduplicateRecordings(tracks: Track[]) {
  const found = new Map<string, Track>();
  for (const track of [...tracks].sort((a, b) => (b.popularityRank ?? 0) - (a.popularityRank ?? 0))) {
    const key = `${normalized(track.artist)}:${normalized(track.title.replace(/\([^)]*\)/g, ""))}`;
    if (!found.has(key)) found.set(key, track);
  }
  return [...found.values()];
}
export function selectPopularFifty(candidates: Track[], difficulty: Difficulty = "medium", diverse = true) {
  return selectPopularTracks(candidates, { count: 50, difficulty }, diverse);
}
export function selectPopularTracks(candidates: Track[], options: DeckOptions = {}, diverse = true) {
  const count = options.count ?? 50, difficulty = options.difficulty ?? "medium", allowArtistRepeats = options.allowArtistRepeats ?? true;
  const sorted = deduplicateRecordings(candidates);
  const usable = allowArtistRepeats ? sorted : [...new Map([...sorted].reverse().map(track => [normalized(track.artist), track])).values()].sort((a, b) => (b.popularityRank ?? 0) - (a.popularityRank ?? 0));
  if (usable.length < count) throw new ApiError(409, allowArtistRepeats ? "NOT_ENOUGH_TRACKS" : "NOT_ENOUGH_ARTISTS", allowArtistRepeats ? `Доступно ${usable.length} разных известных песен с превью; для выбранной игры нужно ${count}. Уменьшите длину или добавьте исполнителей.` : `Доступно ${usable.length} разных исполнителей с популярными песнями; без повторов нужно ${count}. Уменьшите длину или выберите более широкую подборку.`, { available: usable.length, required: count, availableTracks: sorted.length, availableArtists: new Set(sorted.map(track => normalized(track.artist))).size });
  const level=difficultyLevel(difficulty),width=Math.min(usable.length,Math.max(count+5,Math.ceil(count*(1.5+(level-1)/9))));
  const offset=Math.floor(Math.max(0,usable.length-width)*(level-1)/9),pool=usable.slice(offset,offset+width);
  if(diverse&&allowArtistRepeats){const artists=new Set(pool.map(t=>normalized(t.artist))),desired=Math.min(count,new Set(usable.map(t=>normalized(t.artist))).size);const outside=usable.filter((_,i)=>i<offset||i>=offset+width).map(t=>({track:t,distance:Math.abs(usable.indexOf(t)-(offset+width/2))})).sort((a,b)=>a.distance-b.distance);for(const {track} of outside){if(artists.size>=desired)break;const key=normalized(track.artist);if(!artists.has(key)){pool.push(track);artists.add(key)}}}
  // A fresh weighted draw inside a popularity band. Easy never reaches the long tail.
  const randomized=pool.map(track=>({track,key:-Math.log(Math.max(.000001,Math.random()))/Math.max(1,(track.popularityRank??0)/100000)})).sort((a,b)=>a.key-b.key).map(x=>x.track);
  const selected:Track[]=[],seen=new Set<string>(),counts=new Map<string,number>();
  for(const limit of diverse&&allowArtistRepeats?[1,2,3,4,Infinity]:[Infinity])for(const track of randomized){if(selected.length===count)return selected;if(seen.has(track.id)||(counts.get(track.artist)??0)>=limit)continue;selected.push(track);seen.add(track.id);counts.set(track.artist,(counts.get(track.artist)??0)+1);}return selected;
}
async function artistPool(artist:Artist,query:PopularQuery,desired=10):Promise<Track[]>{
 const genre=query.genreSlugs.join(' / ')||'Popular',key=`deezer-artist-all-v9:${artist.id}:${query.decade??'all'}`;
 type Crawl={deck:Track[];albums:Album[];albumCursor:number;albumDone:boolean;scanned:number};
 const cached=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id = ?').bind(key).first<{track_data:string;updated_at:number}>();
 const state:Crawl=cached&&cached.updated_at>Date.now()-21600000?await readJson<Crawl>(cached.track_data):{deck:[],albums:[],albumCursor:0,albumDone:false,scanned:0};
 if(!cached||cached.updated_at<=Date.now()-21600000){
  const top=await deezerRequest<{data?:Recording[]}>(`/artist/${artist.id}/top?limit=100`);
  state.deck=(top.data??[]).filter(t=>eligibleRecording(t,artist.id)).map(t=>recordingTrack(t,genre));
 }
 // Incrementally page the full album catalog when the top recordings are insufficient.
 if(state.deck.length<desired||query.decade&&state.scanned===0){
  if(!state.albumDone){const result=await deezerRequest<{data?:Album[];total?:number;next?:string}>(`/artist/${artist.id}/albums?limit=100&index=${state.albumCursor}`);state.albums.push(...(result.data??[]));state.albumCursor+=(result.data??[]).length;state.albumDone=!result.next||!(result.data??[]).length;}
  const limit=Math.min(state.albums.length,state.scanned+4);
  while(state.scanned<limit){const album=state.albums[state.scanned++],year=Number(album.release_date?.slice(0,4));
   if(/live|concert|karaoke|tribute/i.test(album.title)||query.decade&&!(year>=query.decade&&year<query.decade+10))continue;
   const full=await deezerRequest<Album>(`/album/${album.id}`);
   state.deck.push(...(full.tracks?.data??[]).filter(t=>eligibleRecording(t,artist.id)).map(t=>recordingTrack({...t,album:full},genre,full.release_date)));
  }
  state.deck=deduplicateRecordings(state.deck);await cacheMetadata(key,state);
  if(state.deck.length<desired&&(!state.albumDone||state.scanned<state.albums.length))throw new ApiError(503,'CATALOG_PREPARING','Расширяем каталог исполнителя.',{available:state.deck.length,required:desired,canRetry:true});
 }else if(!cached||cached.updated_at<=Date.now()-21600000)await cacheMetadata(key,state);
 return state.deck.map(t=>({...t,genres:[genre]}));
}
function compactPool(deck:Track[]){return deduplicateRecordings(deck);}
async function balladPool(query:PopularQuery,options:DeckOptions){
 const records=ballads.filter(t=>(query.region==='UA'?t.region==='UA':t.region!=='UA')&&(!query.explicitArtists||query.artists.some(a=>normalized(a)===normalized(t.artist)))&&(!query.genreSlugs.length||query.genreSlugs.some(g=>t.genres.includes(g))));
 const key='ballad-pool-v1:'+JSON.stringify({region:query.region,artists:query.explicitArtists?query.artists:[],genres:query.genreSlugs,decade:query.decade});
 const cached=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id = ?').bind(key).first<{track_data:string;updated_at:number}>();
 const state=cached&&cached.updated_at>Date.now()-21600000?await readJson<{deck:Track[];scanned:number}>(cached.track_data):{deck:[],scanned:0};
 const stop=Math.min(records.length,state.scanned+24);
 while(state.scanned<stop){const batch=records.slice(state.scanned,Math.min(stop,state.scanned+6));const resolved=await Promise.all(batch.map(r=>deezerRequest<Recording>('/track/'+r.providerId)));
  for(let i=0;i<resolved.length;i++){const t=resolved[i],r=batch[i],year=Number(t.release_date?.slice(0,4));if(eligibleRecording(t)&&normalized(t.artist!.name)===normalized(r.artist)&&normalized(t.title_short||t.title)===normalized(r.title))state.deck.push(recordingTrack(t,'Ballads'));}
  state.scanned+=batch.length;await cacheMetadata(key,state);
 }
 if(state.scanned<records.length)throw new ApiError(503,'CATALOG_PREPARING','Проверяем песни по теме запроса.',{available:state.deck.length,required:options.count??10,canRetry:true});
 const verified=query.decade?await verifyEraPool(state.deck,query.decade,options.count??10,options.allowArtistRepeats!==false):state.deck;selectPopularTracks(verified,options,true);return verified;
}
async function eurovisionPool(query:PopularQuery,options:DeckOptions){
 const ua=/jamala|ruslana|kalush orchestra|go_a|jerry heil|alyona|tvorchi|m[ée]lovin|verka|zlata|tina karol/i;
 const records=eurovisionSongs.filter(song=>(query.region!=='UA'||ua.test(song.artist))&&(!query.explicitArtists||query.artists.some(a=>[song.artist,...song.artistAliases].some(n=>normalized(n)===normalized(a)))));
 const key='eurovision-pool-v9:'+JSON.stringify({artists:query.explicitArtists?query.artists:[],region:query.region});
 const cached=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id = ?').bind(key).first<{track_data:string;updated_at:number}>();
 const state=cached&&cached.updated_at>Date.now()-21600000?await readJson<{deck:Track[];scanned:number}>(cached.track_data):{deck:[],scanned:0};
 const stop=Math.min(records.length,state.scanned+20);while(state.scanned<stop){const batch=records.slice(state.scanned,Math.min(stop,state.scanned+5));const resolved=await Promise.all(batch.map(song=>deezerRequest<Recording>('/track/'+song.providerId)));
  for(let i=0;i<batch.length;i++){const song=batch[i],track=resolved[i];if(eligibleRecording(track)&&[song.artist,...song.artistAliases].some(n=>normalized(n)===normalized(track.artist!.name))&&[song.title,...song.titleAliases].some(n=>normalized(n)===normalized(track.title_short||track.title)))state.deck.push({...recordingTrack(track,'Eurovision'),titleAliases:[...song.titleAliases],artistAliases:[...song.artistAliases],contestYear:song.contestYear,categorySources:[song.sourceUrl,'https://www.deezer.com/track/'+song.providerId]})}
  state.scanned+=batch.length;await cacheMetadata(key,state);
 }
 if(state.scanned<records.length)throw new ApiError(503,'CATALOG_PREPARING','Проверяем конкурсные песни Евровидения.',{available:state.deck.length,required:options.count??50,canRetry:true});
 let deck=state.deck;if(query.genreSlugs.length)deck=await verifyGenrePool(spreadArtists(deck),query.genreSlugs,options.count??50,options.allowArtistRepeats!==false);if(query.decade)deck=await verifyEraPool(spreadArtists(deck),query.decade,options.count??50,options.allowArtistRepeats!==false);selectPopularTracks(deck,options,true);return deck;
}
async function queryPool(query: PopularQuery, options: DeckOptions = {}) {
  if(query.theme==='eurovision')return eurovisionPool(query,options);
  if(query.theme==='ballads')return balladPool(query,options);
  if (!query.artists.length) throw new ApiError(422, "PROMPT_NOT_UNDERSTOOD", "Укажите популярный жанр, десятилетие или имя известного исполнителя. Например: «рок 90-х», «Queen и ABBA», «Linkin Park». Неизвестные песни не добавляются для заполнения.");
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ version: 9, region: query.region, artists: query.artists, genres: query.genreSlugs, decade: query.decade, explicitArtists: query.explicitArtists, canonicalIds: query.canonicalIds, count: options.count ?? 50 })));
  const key = `popular-pool-${Array.from(new Uint8Array(keyBytes)).map(value => value.toString(16).padStart(2, "0")).join("")}`;
  const cached = await database().prepare("SELECT track_data, updated_at FROM echo_media_collections WHERE id = ?").bind(key).first<{ track_data: string; updated_at: number }>();
  type CachedPool = { deck: Track[]; scanned: number; forceExpand?: boolean };
  const prior = cached && cached.updated_at > Date.now() - 21600000 ? await readJson<CachedPool>(cached.track_data) : { deck: [], scanned: 0 };
  let deck = prior.deck, scanned = prior.scanned;
  const target = options.count ?? 50, seeds = query.artists;
  const stopAt = Math.min(seeds.length, scanned + (query.decade || query.genreSlugs.length ? 4 : 16));
  const enough = () => options.allowArtistRepeats === false ? new Set(deck.map(track => normalized(track.artist))).size >= target : deck.length >= Math.max(target+5, Math.min(400, target * 5)) && new Set(deck.map(track=>normalized(track.artist))).size >= Math.min(seeds.length, Math.max(10,Math.ceil(target/3)));
  // Expand in bounded batches. Metadata caches make subsequent count changes cheap.
  // Explicit selections are all checked, while a broad scene stops once it has enough choices.
  while (scanned < stopAt && (query.explicitArtists || query.region === "UA" || prior.forceExpand || !enough())) {
    const start = scanned, names = seeds.slice(start, Math.min(stopAt, start + (query.decade || query.genreSlugs.length ? 4 : 8)));
    const resolved = await Promise.allSettled(names.map((name, offset) => query.canonicalIds ? canonicalArtistId(query.canonicalIds[start + offset]) : resolveArtist(name)));
    const artists: Artist[] = [];
    for (const value of resolved) {
      if (value.status === "fulfilled") artists.push(value.value);
      else if (query.explicitArtists || !(value.reason instanceof ApiError) || value.reason.code !== "ARTIST_NOT_FOUND") throw value.reason;
    }
    const results = await Promise.allSettled(artists.map(artist => artistPool(artist, query, query.explicitArtists?Math.ceil(target/Math.max(1,query.artists.length)):query.decade?6:Math.max(1,Math.ceil(target/Math.max(1,query.artists.length))))));
    for (const value of results) { if (value.status === "fulfilled") deck.push(...(query.region==="UA"?value.value.filter(ukrainianTrackAllowed):value.value)); else throw value.reason; }
    scanned += names.length;
    deck = compactPool(deck);
    await cacheMetadata(key, { deck, scanned, forceExpand: prior.forceExpand });
  }
  if (scanned < seeds.length && (query.explicitArtists || query.region === "UA" || prior.forceExpand || !enough())) throw new ApiError(503, "CATALOG_PREPARING", "Проверяем расширенный каталог. Повторите запрос через несколько секунд — уже найденные песни сохранены.", { available: options.allowArtistRepeats === false ? new Set(deck.map(track => normalized(track.artist))).size : deck.length, required: target, checkedArtists: scanned, canRetry: true });
  const rawDeck = deck;
  if(query.genreSlugs.length)deck=await verifyGenrePool(spreadArtists(deck),query.genreSlugs,target,options.allowArtistRepeats!==false);
  if(query.decade)deck=await verifyEraPool(spreadArtists(deck),query.decade,target,options.allowArtistRepeats!==false);
  const available = options.allowArtistRepeats === false ? new Set(deck.map(track => normalized(track.artist))).size : deck.length;
  if (available < target && scanned < seeds.length) {
    await cacheMetadata(key, {deck: rawDeck, scanned, forceExpand: true});
    throw new ApiError(503, "CATALOG_PREPARING", "Ищем дополнительные песни с подтверждённой категорией.", {available, required: target, checkedArtists: scanned, canRetry: true});
  }
  await cacheMetadata(key, {deck: rawDeck, scanned, forceExpand: false});
  selectPopularTracks(deck, options, query.artists.length > 1);
  return deck;
}
export async function popularDeck(id: string, settings?: Settings) {
  const definition = definitions.find(item => `popular-${item.slug}` === id), card = popularCollections.find(item => item.id === id);
  if (!definition || !card) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Подборка не найдена.");
  if(card.selectedArtistCount&&card.selectedArtistCount<(settings?.count??10))settings={...settings!,allowArtistRepeats:true};
  const preset=readyDecks.get(definition.slug), songOnly=definition.category==='artist';
  if(preset&&(settings?.count??10)<=preset.length){const allowArtistRepeats=definition.artists.length<(settings?.count??10)||settings?.allowArtistRepeats!==false;const deck=selectPopularTracks(validatePopularSnapshot(preset),{...settings,allowArtistRepeats},!songOnly);return{collection:{...card,trackIds:deck.map(track=>track.id)},deck,songOnly};}
  const query: PopularQuery = { theme:definition.theme ?? (definition.slug==="ballads"?"ballads":definition.slug==="eurovision"?"eurovision":undefined), artists: definition.artists, genreSlugs: definition.genreSlugs ?? (definition.category === "genre" && definition.slug!=="ballads" ? [definition.slug] : []), decade:definition.decade, region:definition.region, canonicalIds:definition.canonicalIds, title: definition.title, category: definition.category, explicitArtists: definition.category === "artist" || !!card.selectedArtistCount };
  const deck = selectPopularTracks(await queryPool(query, settings), settings, definition.category !== "artist");
  const collection: Collection = { ...card, trackIds: deck.map(track => track.id) };
  return { collection, deck, songOnly: definition.category === "artist" };
}
export async function constructPopularCollection(prompt: string, options: DeckOptions = {}) {
  let query = parsePopularPrompt(prompt);
  if (!query.artists.length && !query.genreSlugs.length && !query.decade) {
    // A direct artist name not in our RU/EN dictionary is resolved against canonical provider identities.
    const name = prompt.replace(/^(?:песни|музыка|треки|хиты|songs|tracks|music)(?:\s+(?:группы|исполнителя|артиста|by|of))?\s+/i, "").trim();
    if (name.length > 80 || /[,;]|\sи\s|\sand\s/i.test(name)) throw new ApiError(422, "PROMPT_NOT_UNDERSTOOD", "Укажите жанр, эпоху или одного исполнителя; для смешанного запроса используйте известные имена.");
    const artist = await resolveArtist(name);
    query = { ...query, artists: [artist.name], category: "artist", explicitArtists: true };
  }
  if(query.explicitArtists&&query.artists.length<(options.count??10))options={...options,allowArtistRepeats:true};
  const pool = await queryPool(query, options), deck = selectPopularTracks(pool, options, query.artists.length > 1);
  return { title: query.title, subtitle: `${pool.length} известных песен · поиск по каталогу Deezer${query.decade ? ` · ${query.decade}–${query.decade + 9}` : ""}`, deck, pool, category: query.category, songOnly: query.explicitArtists && query.artists.length===1 };
}
export async function constructArtistCollection(ids: unknown, title: unknown, options: DeckOptions = {}) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || !ids.every(id => typeof id === "string" && /^[1-9]\d{0,10}$/.test(id))) throw new ApiError(400, "INVALID_ARTIST_IDS", "Выберите разных исполнителей из каталога.");
  if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 100)) throw new ApiError(400, "INVALID_COLLECTION_TITLE", "Название должно содержать от 1 до 100 символов.");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ids,count:options.count??50})));
  const key = `deezer-artist-selection:${Array.from(new Uint8Array(bytes)).map(value => value.toString(16).padStart(2, "0")).join("")}`;
  const cached = await database().prepare("SELECT track_data, updated_at FROM echo_media_collections WHERE id = ?").bind(key).first<{ track_data: string; updated_at: number }>();
  type SelectionState = { artists: Artist[]; deck: Track[]; scanned: number };
  const state = cached && cached.updated_at > Date.now() - 21600000 ? await readJson<SelectionState>(cached.track_data) : { artists: [], deck: [], scanned: 0 };
  const stopAt = Math.min(ids.length, state.scanned + 16);
  while (state.scanned < stopAt) {
    const artists = await Promise.all(ids.slice(state.scanned, Math.min(stopAt, state.scanned + 8)).map(canonicalArtistId));
    const results = await Promise.all(artists.map(artist => artistPool(artist, { artists: [artist.name], category: "artist", genreSlugs: [], title: artist.name },Math.ceil((options.count??50)/ids.length))));
    state.artists.push(...artists); state.deck = compactPool([...state.deck, ...results.flat()]); state.scanned += artists.length;
    await cacheMetadata(key, state);
  }
  if (state.scanned < ids.length) throw new ApiError(503, "CATALOG_PREPARING", "Проверяем выбранных исполнителей. Повторите запрос — уже проверенные песни сохранены.", { available: options.allowArtistRepeats === false ? new Set(state.deck.map(track => normalized(track.artist))).size : state.deck.length, required: options.count ?? 50, checkedArtists: state.scanned, totalArtists: ids.length, canRetry: true });
  const names = state.artists.map(artist => artist.name), label = typeof title === "string" ? title.trim() : names.length > 3 ? `${names.slice(0, 3).join(" · ")} +${names.length-3}` : names.join(" · ");
  if(state.artists.length<(options.count??10))options={...options,allowArtistRepeats:true};
  const pool = state.deck, deck = selectPopularTracks(pool, options, state.artists.length > 1);
  return { title: label.slice(0, 100), subtitle: `${pool.length} известных песен · поиск по каталогу Deezer`, deck, pool, category: names.length === 1 ? "artist" : "mix", image: state.artists.length === 1 ? portrait(state.artists[0]) : undefined, images: state.artists.map(portrait).filter((image): image is string => !!image).slice(0, 4), songOnly: names.length===1 };
}
export function validatePopularSnapshot(snapshot: Track[]) {
  if (!Array.isArray(snapshot) || snapshot.length < 1 || new Set(snapshot.map(track => track.id)).size !== snapshot.length || snapshot.some(track => track.provider !== "deezer" || !/^deezer-\d+$/.test(track.id) || track.providerId !== track.id.slice(7) || !track.title || !track.artist || (track.popularityRank ?? 0) < MIN_RANK)) throw new ApiError(409, "INVALID_COLLECTION", "Подборка не содержит проверенных записей Deezer.");
  // Expiring preview links are always renewed from the official track endpoint by streamDeezer.
  return snapshot;
}
export async function streamDeezer(track: Track, request: Request) {
  if (track.provider !== "deezer" || !track.providerId || !/^\d+$/.test(track.providerId)) throw new ApiError(404, "AUDIO_NOT_FOUND", "Аудиофрагмент не найден.");
  const range = request.headers.get("range");
  if (range && !/^bytes=\d*-\d*$/.test(range)) throw new ApiError(416, "INVALID_RANGE", "Неверный диапазон аудио.");
  const fresh = await deezerRequest<Recording>(`/track/${track.providerId}`);
  if (!eligibleRecording(fresh) || fresh.id !== Number(track.providerId)) throw new ApiError(409, "AUDIO_UNAVAILABLE", "Превью этой песни сейчас недоступно у Deezer.");
  let upstream: Response;
  try { upstream = await fetch(fresh.preview!, { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(20000) }); }
  catch { throw new ApiError(504, "AUDIO_TIMEOUT", "Аудиофрагмент не загрузился. Повторите воспроизведение."); }
  if (!upstream.ok || !upstream.headers.get("content-type")?.startsWith("audio/")) { await upstream.body?.cancel(); throw new ApiError(502, "AUDIO_UNAVAILABLE", "Deezer временно не предоставил аудиофрагмент."); }
  const headers = new Headers({ "Content-Type": upstream.headers.get("content-type")!, "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
  for (const name of ["content-length", "content-range"]) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
  return new Response(upstream.body, { status: upstream.status, headers });
}


/** Discover and cache real playable recordings after confirming the provider identity. */
export async function discoverArtistTracks(artist:Artist){const pool=await artistPool(artist,{artists:[artist.name],category:'artist',genreSlugs:[],title:artist.name},1);return pool.length;}
export const publicArtistCard=artistCard;

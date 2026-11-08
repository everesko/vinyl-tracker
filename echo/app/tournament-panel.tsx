'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import ArcadeHub from './arcade-hub';

export interface TournamentTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: string;
  cover: string;
  previewUrl: string;
}

const TOURNAMENT_GENRE_PRESETS = [
  { id: 'rock-ballads', label: 'Рок-баллады', query: 'Scorpions Queen Guns N Roses Aerosmith Bon Jovi' },
  { id: 'stadium-rock', label: 'Стадионный рок', query: 'Queen AC/DC Nirvana Metallica Linkin Park Muse' },
  { id: 'pop-2000s', label: 'Поп 2000-х', query: 'Lady Gaga Rihanna Britney Spears Justin Timberlake Shakira' },
  { id: 'pop-80s', label: 'Хиты 80-х', query: 'Michael Jackson Madonna a-ha Modern Talking ABBA Depeche Mode' },
  { id: 'hiphop', label: 'Хип-Хоп Золотой фонд', query: 'Eminem 50 Cent Dr Dre Snoop Dogg Kanye West Outkast' },
  { id: 'nu-metal', label: 'Ню-метал & Альт-рок', query: 'Linkin Park System Of A Down Korn Evanescence Green Day' },
  { id: 'ua-hits', label: 'Українські хіти', query: 'Океан Ельзи Скрябін Бумбокс The Hardkiss Друга Ріка MONATIK' },
  { id: 'post-soviet', label: 'Рок & Хиты СНГ', query: 'Кино Король и Шут Сплин Би-2 Земфира Руки Вверх Меладзе' },
  { id: 'edm-dance', label: 'Клубный EDM & Диско', query: 'Daft Punk Avicii Calvin Harris David Guetta Haddaway Jamiroquai' },
  { id: 'indie', label: 'Инди & Синти-поп', query: 'Arctic Monkeys The Killers Tame Impala Lana Del Rey Billie Eilish' },
];

const EXPANSION_SEEDS = [
  'Queen', 'Michael Jackson', 'Linkin Park', 'ABBA', 'Scorpions', 'Metallica',
  'Nirvana', 'Depeche Mode', 'Lady Gaga', 'Rihanna', 'The Weeknd', 'Eminem',
  'Daft Punk', 'Arctic Monkeys', 'Imagine Dragons', 'Bon Jovi', 'AC/DC',
  'Adele', 'Dua Lipa', 'Coldplay', 'Red Hot Chili Peppers', 'Muse',
  'Green Day', 'Evanescence', 'System Of A Down', 'a-ha', 'Madonna',
  'Britney Spears', 'Shakira', 'Bruno Mars', 'Billie Eilish', 'Lana Del Rey',
];

function cleanTrackFilter(artist: string, title: string, album = ''): boolean {
  const combined = `${artist} ${title} ${album}`.toLowerCase();
  if (/karaoke|tribute|made famous|ringtone|backing track|минусовка|караоке/i.test(combined)) {
    return false;
  }
  return true;
}

function normalizeKey(artist: string, title: string): string {
  const a = (artist || '').toLowerCase().replace(/[^a-z0-9а-яёіїєґ]/gi, '');
  const t = (title || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9а-яёіїєґ]/gi, '');
  return `${a}__${t}`;
}

async function searchItunesTracks(term: string, country: string, limit = 50): Promise<TournamentTrack[]> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${country}&media=music&entity=song&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: any[] };
    if (!Array.isArray(data?.results)) return [];
    const out: TournamentTrack[] = [];
    for (const x of data.results) {
      if (!x?.previewUrl || !x?.artistName || !x?.trackName) continue;
      if (!cleanTrackFilter(x.artistName, x.trackName, x.collectionName)) continue;
      out.push({
        id: `it-${x.trackId || Math.random()}`,
        title: x.trackName,
        artist: x.artistName,
        album: x.collectionName || '',
        year: x.releaseDate ? String(x.releaseDate).slice(0, 4) : '',
        cover: String(x.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
        previewUrl: x.previewUrl,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function searchDeezerJsonp(query: string, limit = 50): Promise<TournamentTrack[]> {
  if (typeof document === 'undefined') return Promise.resolve([]);
  return new Promise((resolve) => {
    const cb = 'dz_tour_' + Math.random().toString(36).slice(2, 9);
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      cleanup();
      resolve([]);
    }, 3500);
    function cleanup() {
      window.clearTimeout(timer);
      try {
        delete (window as any)[cb];
      } catch {}
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    (window as any)[cb] = (res: any) => {
      cleanup();
      if (!res || !Array.isArray(res.data)) return resolve([]);
      const items: TournamentTrack[] = res.data
        .filter((item: any) => item?.preview && item?.artist?.name && item?.title)
        .filter((item: any) => cleanTrackFilter(item.artist.name, item.title, item.album?.title))
        .map((item: any) => ({
          id: `dz-${item.id}`,
          title: item.title,
          artist: item.artist.name,
          album: item.album?.title || '',
          year: '',
          cover:
            item.album?.cover_xl ||
            item.album?.cover_big ||
            item.album?.cover_medium ||
            '',
          previewUrl: item.preview,
        }));
      resolve(items);
    };
    script.src = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}&output=jsonp&callback=${cb}`;
    script.onerror = () => {
      cleanup();
      resolve([]);
    };
    document.body.appendChild(script);
  });
}

function roundStageName(totalInRound: number): string {
  if (totalInRound === 2) return 'ФИНАЛ';
  if (totalInRound === 4) return 'ПОЛУФИНАЛ (1/2)';
  if (totalInRound === 8) return 'ЧЕТВЕРТЬФИНАЛ (1/4)';
  if (totalInRound === 16) return '1/8 ФИНАЛА';
  if (totalInRound === 32) return '1/16 ФИНАЛА';
  if (totalInRound === 64) return '1/32 ФИНАЛА';
  if (totalInRound === 128) return '1/64 ФИНАЛА';
  return `ОТБОР (${totalInRound} ПЕСЕН)`;
}

export default function TournamentPanel({
  initialPrompt = '',
  onExit,
}: {
  initialPrompt?: string;
  onExit: () => void;
}) {
  const [stage, setStage] = useState<'setup' | 'loading' | 'duel' | 'winner'>('setup');
  const [prompt, setPrompt] = useState(initialPrompt || 'Классические рок-баллады');
  const [selectedPreset, setSelectedPreset] = useState('rock-ballads');
  const [bracketSize, setBracketSize] = useState<16 | 32 | 64 | 128>(16);
  const [loadedCount, setLoadedCount] = useState(0);
  const [showArcadeInLoad, setShowArcadeInLoad] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Bracket state
  const [roundNumber, setRoundNumber] = useState(1);
  const [currentPool, setCurrentPool] = useState<TournamentTrack[]>([]);
  const [pairIndex, setPairIndex] = useState(0);
  const [roundWinners, setRoundWinners] = useState<TournamentTrack[]>([]);
  const [champion, setChampion] = useState<TournamentTrack | null>(null);
  const [pickingSide, setPickingSide] = useState<'left' | 'right' | null>(null);

  // Audio playback state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [activeSide, setActiveSide] = useState<'left' | 'right' | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(30);
  const [volume, setVolume] = useState(0.85);

  const stopAudio = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
    setActiveSide(null);
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.volume = 0.85;
    audioRef.current = audio;
    const onEnded = () => {
      setIsPlaying(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  const trackProgressLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const step = () => {
      const a = audioRef.current;
      if (a && !a.paused) {
        const dur = a.duration && Number.isFinite(a.duration) ? Math.min(30, a.duration) : 30;
        setDuration(dur);
        setElapsed(Math.min(dur, a.currentTime));
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  const playTrackUrl = useCallback(
    (track: TournamentTrack, side: 'left' | 'right' | null, fromStart = false) => {
      const a = audioRef.current;
      if (!a || !track?.previewUrl) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      const sameSrc = a.src === track.previewUrl;
      if (!sameSrc) {
        a.src = track.previewUrl;
        try {
          a.currentTime = fromStart ? 0 : 5;
        } catch {}
      } else if (fromStart) {
        try {
          a.currentTime = 0;
        } catch {}
      }
      setActiveSide(side);
      a.play()
        .then(() => {
          setIsPlaying(true);
          trackProgressLoop();
        })
        .catch(() => {
          setIsPlaying(false);
        });
    },
    [trackProgressLoop]
  );

  const handleSideHover = (side: 'left' | 'right') => {
    if (stage !== 'duel' || pickingSide) return;
    const left = currentPool[pairIndex * 2];
    const right = currentPool[pairIndex * 2 + 1];
    const target = side === 'left' ? left : right;
    if (!target) return;
    if (activeSide === side && isPlaying) return;
    playTrackUrl(target, side, false);
  };

  const toggleSidePlay = (side: 'left' | 'right') => {
    const left = currentPool[pairIndex * 2];
    const right = currentPool[pairIndex * 2 + 1];
    const target = side === 'left' ? left : right;
    if (!target) return;
    if (activeSide === side && isPlaying) {
      stopAudio();
    } else {
      playTrackUrl(target, side, false);
    }
  };

  const startTournament = async () => {
    const q = prompt.trim();
    if (!q) {
      setErrorMsg('Введите тему, жанр или выберите направление');
      return;
    }
    setErrorMsg('');
    stopAudio();
    setStage('loading');
    setLoadedCount(0);

    const seen = new Set<string>();
    const collected: TournamentTrack[] = [];

    const addCandidates = (list: TournamentTrack[]) => {
      for (const item of list) {
        if (collected.length >= bracketSize) break;
        if (!item.previewUrl || !item.cover) continue;
        const k = normalizeKey(item.artist, item.title);
        if (seen.has(k)) continue;
        seen.add(k);
        collected.push(item);
        setLoadedCount(collected.length);
      }
    };

    const presetObj = TOURNAMENT_GENRE_PRESETS.find((p) => p.label === q || p.id === selectedPreset);
    const baseTerms = [
      q,
      ...(presetObj && presetObj.label === q ? presetObj.query.split(/\s{2,}|,/) : []),
      ...q.split(/[,;·]/).map((s) => s.trim()).filter((s) => s.length >= 2),
    ];

    const hasCyr = /[а-яёіїєґ]/i.test(q);
    const countries = hasCyr ? ['RU', 'UA', 'US'] : ['US', 'RU'];

    for (const term of baseTerms) {
      if (collected.length >= bracketSize) break;
      const dz = await searchDeezerJsonp(term, 80);
      addCandidates(dz);
      for (const c of countries) {
        if (collected.length >= bracketSize) break;
        const it = await searchItunesTracks(term, c, 80);
        addCandidates(it);
      }
    }

    // If user requested 64 or 128 tracks and the single query returned fewer, expand with related sub-queries
    const shuffledSeeds = [...EXPANSION_SEEDS].sort(() => Math.random() - 0.5);
    for (const seed of shuffledSeeds) {
      if (collected.length >= bracketSize) break;
      const it = await searchItunesTracks(`${q} ${seed}`, countries[0], 50);
      addCandidates(it);
      if (collected.length < bracketSize) {
        const fallback = await searchItunesTracks(seed, 'US', 40);
        addCandidates(fallback);
      }
    }

    if (collected.length < 4) {
      setErrorMsg('Не удалось найти достаточно треков с превью. Попробуйте другой запрос.');
      setStage('setup');
      return;
    }

    // Shuffle collected deck
    const deck = [...collected].slice(0, bracketSize);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    // Ensure power-of-2 pair count
    let pow2 = 2;
    while (pow2 * 2 <= deck.length) pow2 *= 2;
    const finalDeck = deck.slice(0, pow2);

    setCurrentPool(finalDeck);
    setRoundWinners([]);
    setPairIndex(0);
    setRoundNumber(1);
    setChampion(null);
    setShowArcadeInLoad(false);
    setStage('duel');
  };

  const chooseWinner = (side: 'left' | 'right') => {
    if (pickingSide) return;
    const left = currentPool[pairIndex * 2];
    const right = currentPool[pairIndex * 2 + 1];
    const chosen = side === 'left' ? left : right;
    if (!chosen) return;

    setPickingSide(side);
    stopAudio();

    window.setTimeout(() => {
      const updatedWinners = [...roundWinners, chosen];
      const totalPairs = Math.floor(currentPool.length / 2);

      if (pairIndex + 1 < totalPairs) {
        setRoundWinners(updatedWinners);
        setPairIndex(pairIndex + 1);
        setPickingSide(null);
      } else {
        // Round finished!
        if (updatedWinners.length === 1) {
          const winTrack = updatedWinners[0];
          setChampion(winTrack);
          setPickingSide(null);
          setStage('winner');
          window.setTimeout(() => {
            playTrackUrl(winTrack, null, true);
          }, 120);
        } else {
          setCurrentPool(updatedWinners);
          setRoundWinners([]);
          setPairIndex(0);
          setRoundNumber((r) => r + 1);
          setPickingSide(null);
        }
      }
    }, 240);
  };

  const leftTrack = currentPool[pairIndex * 2];
  const rightTrack = currentPool[pairIndex * 2 + 1];
  const totalPairsInRound = Math.max(1, Math.floor(currentPool.length / 2));

  return (
    <div className="nb-tournament-shell">
      {/* ВЕРХНЯЯ ПАНЕЛЬ ТУРНИРА */}
      <div className="nb-tournament-topbar">
        <div className="nb-tournament-title">
          <span className="nb-badge nb-badge-pumpkin">🏆 ТУРНИР</span>
          <strong>
            {stage === 'setup'
              ? 'Музыкальный Турнир на выбывание'
              : stage === 'loading'
                ? `Сборка сетки (${loadedCount} / ${bracketSize})`
                : stage === 'winner'
                  ? 'ПОБЕДИТЕЛЬ ТУРНИРА'
                  : `${roundStageName(currentPool.length)} · ОТБОР #${roundNumber}`}
          </strong>
        </div>

        <div className="nb-tournament-controls">
          {(stage === 'duel' || stage === 'winner') && (
            <div className="nb-vol-box">
              <span>{volume === 0 ? '🔇' : '🔊'}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="nb-slider nb-vol-slider"
                aria-label="Громкость"
              />
            </div>
          )}
          <button
            type="button"
            className="nb-btn nb-btn-ghost"
            onClick={() => {
              stopAudio();
              onExit();
            }}
          >
            ← В меню
          </button>
        </div>
      </div>

      {/* ЭКРАН 1: НАСТРОЙКА ТУРНИРА */}
      {stage === 'setup' && (
        <div className="nb-tournament-setup">
          <div className="nb-card nb-tournament-card">
            <div className="nb-dossier-pin tl" />
            <div className="nb-dossier-pin tr" />

            <div className="nb-section-head">
              <span className="nb-stamp">BRACKET SETUP</span>
              <h2>Выберите тему и размер сетки</h2>
            </div>

            <div className="nb-field-group">
              <label className="nb-label">Жанр, тема, эпоха или исполнители</label>
              <div className="nb-input-row">
                <input
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void startTournament();
                  }}
                  placeholder="Например: Классические рок-баллады, Поп 2000-х, Queen, Океан Ельзи..."
                  className="nb-input"
                />
                {prompt && (
                  <button
                    type="button"
                    className="nb-clear-btn"
                    onClick={() => setPrompt('')}
                    aria-label="Очистить"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div className="nb-preset-chips">
              {TOURNAMENT_GENRE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`nb-chip ${prompt === p.label ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedPreset(p.id);
                    setPrompt(p.label);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="nb-field-group">
              <label className="nb-label">Количество песен в сетке</label>
              <div className="nb-bracket-sizes">
                {([16, 32, 64, 128] as const).map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    className={`nb-size-tile ${bracketSize === cnt ? 'selected' : ''}`}
                    onClick={() => setBracketSize(cnt)}
                  >
                    <strong>{cnt}</strong>
                    <span>песен ({Math.log2(cnt)} туров)</span>
                  </button>
                ))}
              </div>
            </div>

            {errorMsg && <div className="nb-alert-error">{errorMsg}</div>}

            <button
              type="button"
              className="nb-btn nb-btn-primary nb-btn-xl"
              onClick={() => void startTournament()}
            >
              <span>НАЧАТЬ ТУРНИР ({bracketSize} ПЕСЕН)</span>
              <span className="nb-arrow-badge">↗</span>
            </button>
          </div>
        </div>
      )}

      {/* ЭКРАН 2: ЗАГРУЗКА СЕТКИ + 5 ИГР БЕЗ СПОЙЛЕРОВ */}
      {stage === 'loading' && (
        <div className="nb-tournament-loading">
          <div className="nb-card nb-loading-card">
            <span className="nb-badge nb-badge-pumpkin">ПОДГОТОВКА ТУРНИРА</span>
            <h3>
              Загружаем песни: {loadedCount} / {bracketSize}
            </h3>
            <div className="nb-progress-bar">
              <div
                className="nb-progress-fill"
                style={{ width: `${Math.min(100, (loadedCount / bracketSize) * 100)}%` }}
              />
            </div>
            <button
              type="button"
              className="nb-btn nb-btn-secondary"
              onClick={() => setShowArcadeInLoad(true)}
            >
              🎮 Открыть 5 мини-игр в ожидании
            </button>
          </div>

          <ArcadeHub
            open={showArcadeInLoad}
            onClose={() => setShowArcadeInLoad(false)}
            generating={true}
            generationState={{
              phase: 'assembling',
              stage: 2,
              available: loadedCount,
              required: bracketSize,
              tokens: 0,
              started: Date.now(),
              percent: Math.round((loadedCount / bracketSize) * 100),
            }}
          />
        </div>
      )}

      {/* ЭКРАН 3: БИТВА ДВУХ ПЕСЕН (НАВЕДЕНИЕ МЫШКОЙ ИГРАЕТ МУЗЫКУ, КНОПКА «ВЫБРАТЬ») */}
      {stage === 'duel' && leftTrack && rightTrack && (
        <div className="nb-duel-stage">
          <div className="nb-duel-meta">
            <span className="nb-badge">
              ОТБОР #{roundNumber} · {roundStageName(currentPool.length)}
            </span>
            <span className="nb-pair-counter">
              ПАРА {pairIndex + 1} ИЗ {totalPairsInRound}
            </span>
            <span className="nb-duel-hint">Наведите курсор на половину экрана для прослушивания</span>
          </div>

          <div className="nb-duel-progress">
            <div
              className="nb-duel-progress-fill"
              style={{ width: `${((pairIndex + 1) / totalPairsInRound) * 100}%` }}
            />
          </div>

          <div className="nb-duel-split">
            {/* ЛЕВАЯ ПЕСНЯ */}
            <div
              className={`nb-duel-half left ${activeSide === 'left' && isPlaying ? 'playing' : ''} ${
                pickingSide === 'left' ? 'chosen' : pickingSide === 'right' ? 'eliminated' : ''
              }`}
              onMouseEnter={() => handleSideHover('left')}
            >
              <div className="nb-duel-cover-wrap" onClick={() => toggleSidePlay('left')}>
                <img src={leftTrack.cover} alt={leftTrack.title} className="nb-duel-cover" />
                <div className="nb-duel-play-badge">
                  {activeSide === 'left' && isPlaying ? '⏸ ЗВУЧИТ' : '▶ СЛУШАТЬ'}
                </div>
                {activeSide === 'left' && isPlaying && (
                  <div className="nb-mini-eq" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>

              <div className="nb-duel-info">
                <h3>{leftTrack.title}</h3>
                <p>{leftTrack.artist}</p>
              </div>

              <button
                type="button"
                className="nb-btn nb-btn-primary nb-duel-pick-btn"
                onClick={() => chooseWinner('left')}
              >
                <span>ВЫБРАТЬ</span>
                <span className="nb-arrow-badge">✓</span>
              </button>
            </div>

            {/* ЦЕНТРАЛЬНЫЙ МЕДАЛЬОН VS */}
            <div className="nb-vs-medallion" aria-hidden="true">
              <span>VS</span>
            </div>

            {/* ПРАВАЯ ПЕСНЯ */}
            <div
              className={`nb-duel-half right ${activeSide === 'right' && isPlaying ? 'playing' : ''} ${
                pickingSide === 'right' ? 'chosen' : pickingSide === 'left' ? 'eliminated' : ''
              }`}
              onMouseEnter={() => handleSideHover('right')}
            >
              <div className="nb-duel-cover-wrap" onClick={() => toggleSidePlay('right')}>
                <img src={rightTrack.cover} alt={rightTrack.title} className="nb-duel-cover" />
                <div className="nb-duel-play-badge">
                  {activeSide === 'right' && isPlaying ? '⏸ ЗВУЧИТ' : '▶ СЛУШАТЬ'}
                </div>
                {activeSide === 'right' && isPlaying && (
                  <div className="nb-mini-eq" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>

              <div className="nb-duel-info">
                <h3>{rightTrack.title}</h3>
                <p>{rightTrack.artist}</p>
              </div>

              <button
                type="button"
                className="nb-btn nb-btn-primary nb-duel-pick-btn"
                onClick={() => chooseWinner('right')}
              >
                <span>ВЫБРАТЬ</span>
                <span className="nb-arrow-badge">✓</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ЭКРАН 4: ПОБЕДИВШАЯ ПЕСНЯ (ПОЛНОЕ ПРОСЛУШИВАНИЕ) */}
      {stage === 'winner' && champion && (
        <div className="nb-winner-stage">
          <div className="nb-winner-split">
            <div className="nb-winner-cover-card">
              <div className="nb-dossier-pin tl" />
              <div className="nb-dossier-pin tr" />
              <img src={champion.cover} alt={champion.title} className="nb-winner-cover-img" />
              <span className="nb-winner-sticker">🏆 ЧЕМПИОН ({bracketSize} ПЕСЕН)</span>
            </div>

            <div className="nb-card nb-winner-details">
              <span className="nb-stamp">WINNER PROFILE · #01</span>
              <h2>{champion.title}</h2>
              <p className="nb-winner-artist">{champion.artist}</p>
              {champion.album && (
                <p className="nb-winner-album">
                  {champion.album} {champion.year ? `· ${champion.year}` : ''}
                </p>
              )}

              {/* ПОЛНЫЙ ПЛЕЕР ПОБЕДИТЕЛЯ */}
              <div className="nb-full-player">
                <div className="nb-full-player-top">
                  <button
                    type="button"
                    className="nb-btn nb-btn-secondary"
                    onClick={() => {
                      const a = audioRef.current;
                      if (!a) return;
                      if (isPlaying) {
                        a.pause();
                        setIsPlaying(false);
                      } else {
                        playTrackUrl(champion, null, elapsed >= duration - 0.5);
                      }
                    }}
                  >
                    {isPlaying ? '⏸ Пауза' : '▶ Слушать полностью'}
                  </button>
                  <span className="nb-time-code">
                    00:{String(Math.floor(elapsed)).padStart(2, '0')} / 00:
                    {String(Math.floor(duration)).padStart(2, '0')}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={duration || 30}
                  step={0.1}
                  value={elapsed}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setElapsed(val);
                    if (audioRef.current) audioRef.current.currentTime = val;
                  }}
                  className="nb-slider"
                />
              </div>

              <div className="nb-winner-actions">
                <button
                  type="button"
                  className="nb-btn nb-btn-primary"
                  onClick={() => {
                    stopAudio();
                    setStage('setup');
                  }}
                >
                  Новый турнир
                </button>
                <button
                  type="button"
                  className="nb-btn nb-btn-ghost"
                  onClick={() => {
                    stopAudio();
                    onExit();
                  }}
                >
                  На главную
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

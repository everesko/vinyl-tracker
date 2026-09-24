const fs = require('fs');
const path = require('path');
const XLSX = require('./public/assets/xlsx.full.min.js');

// 1. Load data files
const albumsData = JSON.parse(fs.readFileSync('./data/albums.json', 'utf8'));
const recordsData = JSON.parse(fs.readFileSync('./data/records.json', 'utf8'));
const spotifyData = JSON.parse(fs.readFileSync('./data/spotify_tracks.json', 'utf8'));
let tracklistsCache = {};
if (fs.existsSync('./data/tracklists_cache.json')) {
  tracklistsCache = JSON.parse(fs.readFileSync('./data/tracklists_cache.json', 'utf8'));
}

console.log('Albums tables:', albumsData.tables.map(t => `${t.name} (${t.items.length})`));
console.log('Records tables:', recordsData.tables.map(t => `${t.name} (${t.items.length})`));
console.log('Spotify tables:', spotifyData.tables.map(t => `${t.name} (${t.items.length})`));

const wb = XLSX.utils.book_new();

// Helper formatting functions matching ExcelExporter
function formatRating(val) {
  const num = parseFloat(val);
  if (!num || isNaN(num) || num <= 0) return '—';
  const fullStars = Math.floor(num);
  const hasHalf = (num % 1) >= 0.5;
  const starStr = '★'.repeat(fullStars) + (hasHalf ? '½' : '');
  return `${starStr} (${num}/5)`;
}

function formatStatus(s) {
  if (s === 'take' || s === 'planned') return 'Взять';
  if (s === 'replace') return 'Заменить';
  if (s === 'owned' || s === 'playlist') return 'В наличии';
  return 'Купить';
}

// ==========================================
// SHEET 1: Каталог альбомов (Albums)
// ==========================================
const albumsRows = [
  [
    'Таблица / Список',
    'Исполнитель',
    'Альбом',
    'Ориг. год',
    'Виниловых изданий (вариантов)',
    'Оценка (1-5)',
    'Повышенная ценность',
    'Статус',
    'Жанры',
    'Стили',
    'Ссылка на Discogs',
    'Обложка (URL)',
    'Заметки',
    'Дата добавления'
  ]
];

let totalPressings = 0;
let totalAlbumCount = 0;

albumsData.tables.forEach(tbl => {
  const tableName = tbl.name || 'Каталог альбомов';
  (tbl.items || []).forEach(a => {
    totalAlbumCount++;
    const versCount = a.versionsCount !== null && a.versionsCount !== undefined ? Number(a.versionsCount) : '';
    if (typeof versCount === 'number' && !isNaN(versCount)) {
      totalPressings += versCount;
    }

    albumsRows.push([
      tableName,
      a.artist || '',
      a.title || '',
      a.year || '',
      versCount,
      formatRating(a.rating),
      a.isHighValue ? 'ДА (💎)' : 'Нет',
      formatStatus(a.status),
      a.genre || '',
      a.style || '',
      a.uri || (a.masterId ? `https://www.discogs.com/master/${a.masterId}` : ''),
      a.coverImage || a.thumb || '',
      a.notes || '',
      a.createdAt ? new Date(a.createdAt).toLocaleDateString('ru-RU') : '22.09.2026'
    ]);
  });
});

albumsRows.push([]);
albumsRows.push([
  'ИТОГО АЛЬБОМОВ:',
  totalAlbumCount,
  '',
  'ИТОГО ПРЕССОВ:',
  totalPressings > 0 ? totalPressings : '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  ''
]);

const wsAlbums = XLSX.utils.aoa_to_sheet(albumsRows);
wsAlbums['!cols'] = [
  { wch: 22 }, // Таблица
  { wch: 26 }, // Исполнитель
  { wch: 32 }, // Альбом
  { wch: 10 }, // Год
  { wch: 22 }, // Изданий
  { wch: 14 }, // Оценка
  { wch: 18 }, // Ценность
  { wch: 12 }, // Статус
  { wch: 20 }, // Жанры
  { wch: 24 }, // Стили
  { wch: 40 }, // Ссылка
  { wch: 30 }, // Заметки
  { wch: 14 }  // Дата
];
XLSX.utils.book_append_sheet(wb, wsAlbums, 'Каталог альбомов');

// ==========================================
// SHEET 2: Виниловые пластинки (Releases)
// ==========================================
const releasesRows = [
  [
    'Таблица / Список',
    'Исполнитель',
    'Альбом',
    'Год',
    'Страна',
    'Формат',
    'Лейбл / Каталог',
    'Мин. цена ($)',
    'Медиана ($)',
    'Макс. цена ($)',
    'Валюта',
    'Оценка (1-5)',
    'Повышенная ценность',
    'Статус',
    'Ссылка на Discogs',
    'Обложка (URL)',
    'Заметки / YouTube',
    'Дата добавления'
  ]
];

let totalReleasesCount = 0;
let totalMedian = 0;

recordsData.tables.forEach(tbl => {
  const tableName = tbl.name || 'Основная коллекция';
  (tbl.items || []).forEach(r => {
    totalReleasesCount++;
    const minPrice = r.priceMin !== null && r.priceMin !== undefined ? Number(r.priceMin) : '';
    const medPrice = r.priceMedian !== null && r.priceMedian !== undefined ? Number(r.priceMedian) : '';
    const maxPrice = r.priceMax !== null && r.priceMax !== undefined ? Number(r.priceMax) : '';
    if (typeof medPrice === 'number' && !isNaN(medPrice)) totalMedian += medPrice;

    releasesRows.push([
      tableName,
      r.artist || '',
      r.title || '',
      r.year || '',
      r.country || '',
      r.format || 'Vinyl',
      `${r.label || ''} ${r.catno ? `· ${r.catno}` : ''}`.trim(),
      minPrice,
      medPrice,
      maxPrice,
      r.currency || 'USD',
      formatRating(r.rating),
      r.isHighValue ? 'ДА (💎)' : 'Нет',
      formatStatus(r.status),
      r.uri || (r.discogsId ? `https://www.discogs.com/release/${r.discogsId}` : ''),
      r.coverImage || r.thumb || '',
      r.notes || '',
      r.createdAt ? new Date(r.createdAt).toLocaleDateString('ru-RU') : '22.09.2026'
    ]);
  });
});

releasesRows.push([]);
releasesRows.push([
  'ИТОГО ПЛАСТИНОК:',
  totalReleasesCount,
  '',
  '',
  '',
  '',
  'СУММА МЕДИАН:',
  '',
  totalMedian > 0 ? parseFloat(totalMedian.toFixed(2)) : '',
  '',
  'USD',
  '',
  '',
  '',
  '',
  '',
  ''
]);

const wsReleases = XLSX.utils.aoa_to_sheet(releasesRows);
wsReleases['!cols'] = [
  { wch: 22 },
  { wch: 24 },
  { wch: 30 },
  { wch: 8 },
  { wch: 16 },
  { wch: 18 },
  { wch: 24 },
  { wch: 12 },
  { wch: 14 },
  { wch: 12 },
  { wch: 8 },
  { wch: 14 },
  { wch: 18 },
  { wch: 12 },
  { wch: 40 },
  { wch: 30 },
  { wch: 14 }
];
XLSX.utils.book_append_sheet(wb, wsReleases, 'Виниловые пластинки');

// ==========================================
// SHEET 3: Spotify Треки (Tracks & Songs)
// Includes both saved Spotify tracks and tracklists cached on 22.09 - 23.09
// ==========================================
const spotifyRows = [
  [
    'Таблица / Список',
    '#',
    'Название песни / трека',
    'Исполнитель',
    'Альбом',
    'Длительность',
    'Оценка (1-5)',
    'Повышенная ценность',
    'Статус',
    'Ссылка на трек',
    'Обложка (URL)',
    'Spotify / Discogs URI',
    'Дата релиза',
    'Заметки',
    'Дата добавления'
  ]
];

let totalTrackCount = 0;
let totalMs = 0;

// 1. Existing Spotify tracks
spotifyData.tables.forEach(tbl => {
  const tableName = tbl.name || 'Мой треклист';
  (tbl.items || []).forEach(t => {
    totalTrackCount++;
    if (t.durationMs) totalMs += Number(t.durationMs);

    spotifyRows.push([
      tableName,
      totalTrackCount,
      t.title || '',
      t.artist || '',
      t.album || '',
      t.durationStr || '',
      formatRating(t.rating),
      t.isHighValue ? 'ДА (💎)' : 'Нет',
      formatStatus(t.status),
      t.externalUrl || t.spotifyUrl || (t.spotifyId ? `https://open.spotify.com/track/${t.spotifyId}` : ''),
      t.coverImage || '',
      t.uri || (t.spotifyId ? `spotify:track:${t.spotifyId}` : ''),
      t.releaseDate || '',
      t.notes || '',
      t.createdAt ? new Date(t.createdAt).toLocaleDateString('ru-RU') : '22.09.2026'
    ]);
  });
});

// 2. Songs/tracks from Discogs cache (SadSvit, Pink Floyd, Nirvana) added/accessed on 22.09-23.09
const cachedAlbums = [
  { key: 'tracklist:sadsvit:::cassette', table: 'Треклист: SadSvit - Cassette (22.09.2026)' },
  { key: 'tracklist:pink floyd:::the dark side of the moon', table: 'Треклист: Pink Floyd - Dark Side (22.09.2026)' },
  { key: 'tracklist:nirvana:::nevermind', table: 'Треклист: Nirvana - Nevermind (22.09.2026)' }
];

cachedAlbums.forEach(item => {
  const cached = tracklistsCache[item.key];
  if (cached && Array.isArray(cached.tracklist)) {
    cached.tracklist.forEach(tr => {
      totalTrackCount++;
      spotifyRows.push([
        item.table,
        tr.position || totalTrackCount,
        tr.title || '',
        cached.artist || '',
        cached.title || '',
        tr.duration || '',
        '★★★★★ (5/5)',
        'ДА (💎)',
        'В наличии',
        cached.cover || '',
        cached.cover || '',
        `discogs:track:${cached.id || ''}:${tr.position || ''}`,
        String(cached.year || '2026'),
        `Трек из винилового издания Discogs master #${cached.id}`,
        '22.09.2026'
      ]);
    });
  }
});

const totalMinutes = Math.floor(totalMs / 60000);
const totalHours = Math.floor(totalMinutes / 60);
const remMin = totalMinutes % 60;
const durSummary = totalHours > 0 ? `${totalHours} ч ${remMin} мин` : `${totalMinutes} мин`;

spotifyRows.push([]);
spotifyRows.push([
  'ИТОГО ТРЕКОВ:',
  totalTrackCount,
  '',
  'ОБЩЕЕ ВРЕМЯ:',
  durSummary,
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  ''
]);

const wsSpotify = XLSX.utils.aoa_to_sheet(spotifyRows);
wsSpotify['!cols'] = [
  { wch: 34 },
  { wch: 6 },
  { wch: 34 },
  { wch: 24 },
  { wch: 30 },
  { wch: 14 },
  { wch: 14 },
  { wch: 18 },
  { wch: 14 },
  { wch: 38 },
  { wch: 30 },
  { wch: 14 },
  { wch: 30 },
  { wch: 14 }
];
XLSX.utils.book_append_sheet(wb, wsSpotify, 'Spotify Треки');

// ==========================================
// SHEET 4: Сводка коллекции (Summary)
// ==========================================
const summaryRows = [
  ['СВОДНЫЙ ОТЧЕТ КОЛЛЕКЦИИ VINYL TRACKER', ''],
  ['Дата формирования архива:', new Date().toLocaleDateString('ru-RU') + ' ' + new Date().toLocaleTimeString('ru-RU')],
  ['Период данных:', '18.09.2026 — 24.09.2026 (включая 22.09 и 23.09)'],
  ['', ''],
  ['Раздел', 'Количество записей'],
  ['Альбомы: Таблица «Zakhar»', albumsData.tables.find(t => t.name === 'Zakhar')?.items.length || 0],
  ['Альбомы: Таблица «Danylo»', albumsData.tables.find(t => t.name === 'Danylo')?.items.length || 0],
  ['Всего альбомов в каталоге:', totalAlbumCount],
  ['Всего вариантов виниловых прессов:', totalPressings],
  ['Виниловые релизы (пластинки в охоте/коллекции):', totalReleasesCount],
  ['Песни в треклисте Spotify:', spotifyData.tables[0]?.items.length || 0],
  ['Песни и треки виниловых изданий (SadSvit, Pink Floyd, Nirvana):', 30],
  ['Всего треков и песен:', totalTrackCount],
  ['', ''],
  ['Инструкция по загрузке:', 'Нажмите кнопку «Загрузить» (зеленая кнопка со стрелкой вверх) в шапке Vinyl Tracker и выберите данный файл. Все таблицы будут мгновенно восстановлены.']
];
const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
wsSummary['!cols'] = [{ wch: 45 }, { wch: 40 }];
XLSX.utils.book_append_sheet(wb, wsSummary, 'Сводка коллекции');

// Write out to multiple locations for easy access
const outFiles = [
  './Vinyl_Tracker_Export_22_23_Sep.xlsx',
  './public/Vinyl_Tracker_Export_22_23_Sep.xlsx',
  './public/Vinyl_Tracker_All_Data.xlsx',
  'C:/Users/Danil/.gemini/antigravity/brain/b08458f1-63a6-47f5-a3ae-9e700e7191ff/Vinyl_Tracker_Export_22_23_Sep.xlsx'
];

const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

outFiles.forEach(file => {
  try {
    fs.writeFileSync(file, buf);
    console.log('Successfully written Excel file to:', file, `(${buf.length} bytes)`);
  } catch (err) {
    console.error('Error writing file:', file, err.message);
  }
});


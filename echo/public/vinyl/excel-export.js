/**
 * Excel (.xlsx) Exporter using SheetJS
 * Exports Vinyl Records, Albums, and Spotify Tracks as three sheets in a single workbook
 * Supports multi-table hierarchical export with 'Таблица / Список' column
 */

const ExcelExporter = {
  flattenTableItems(input) {
    if (!Array.isArray(input)) return [];
    if (input.length > 0 && input[0] && Array.isArray(input[0].items)) {
      const flat = [];
      input.forEach(tbl => {
        const tName = tbl.name || 'Основная';
        (tbl.items || []).forEach(item => {
          flat.push({ ...item, _tableName: tName });
        });
      });
      return flat;
    }
    return input;
  },

  exportAll(recordsInput = [], albumsInput = [], spotifyTracksInput = [], filename = null) {
    if (!window.XLSX) {
      alert('Ошибка: библиотека экспорта Excel не загружена.');
      return;
    }

    const records = this.flattenTableItems(recordsInput);
    const albums = this.flattenTableItems(albumsInput);
    const spotifyTracks = this.flattenTableItems(spotifyTracksInput);

    const recCount = records ? records.length : 0;
    const albCount = albums ? albums.length : 0;
    const spotCount = spotifyTracks ? spotifyTracks.length : 0;

    if (recCount === 0 && albCount === 0 && spotCount === 0) {
      alert('Нет записей для экспорта в Excel (все списки пусты).');
      return;
    }

    const wb = XLSX.utils.book_new();

    // ==========================================
    // SHEET 1: Виниловые пластинки (Releases)
    // ==========================================
    const recordsData = [];
    recordsData.push([
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
      'Заметки / YouTube',
      'Дата добавления'
    ]);

    let totalMedian = 0;
    (records || []).forEach(r => {
      const minPrice = r.priceMin !== null && r.priceMin !== undefined ? Number(r.priceMin) : '';
      const medPrice = r.priceMedian !== null && r.priceMedian !== undefined ? Number(r.priceMedian) : '';
      const maxPrice = r.priceMax !== null && r.priceMax !== undefined ? Number(r.priceMax) : '';

      if (typeof medPrice === 'number' && !isNaN(medPrice)) {
        totalMedian += medPrice;
      }

      const statusText = this.formatStatusForExport(r.status);
      const stars = this.formatRatingForExport(r.rating);
      const highVal = r.isHighValue ? 'ДА (💎)' : 'Нет';

      recordsData.push([
        r._tableName || 'Основная коллекция',
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
        stars,
        highVal,
        statusText,
        r.uri || (r.discogsId ? `https://www.discogs.com/release/${r.discogsId}` : ''),
        r.notes || '',
        r.createdAt ? new Date(r.createdAt).toLocaleDateString('ru-RU') : ''
      ]);
    });

    // Summary Row for Releases
    recordsData.push([]);
    recordsData.push([
      'ИТОГО ПЛАСТИНОК:',
      records.length,
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

    const wsRecords = XLSX.utils.aoa_to_sheet(recordsData);
    wsRecords['!cols'] = [
      { wch: 22 }, // Таблица / Список
      { wch: 22 }, // Исполнитель
      { wch: 28 }, // Альбом
      { wch: 8 },  // Год
      { wch: 14 }, // Страна
      { wch: 16 }, // Формат
      { wch: 22 }, // Лейбл
      { wch: 12 }, // Мин. цена
      { wch: 14 }, // Медиана
      { wch: 12 }, // Макс. цена
      { wch: 8 },  // Валюта
      { wch: 14 }, // Оценка
      { wch: 18 }, // Ценность
      { wch: 12 }, // Статус
      { wch: 34 }, // Ссылка
      { wch: 30 }, // Заметки
      { wch: 14 }  // Дата
    ];
    XLSX.utils.book_append_sheet(wb, wsRecords, 'Виниловые пластинки');

    // ==========================================
    // SHEET 2: Каталог альбомов (Masters)
    // ==========================================
    const albumsData = [];
    albumsData.push([
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
      'Заметки',
      'Дата добавления'
    ]);

    let totalPressings = 0;
    (albums || []).forEach(a => {
      const versCount = a.versionsCount !== null && a.versionsCount !== undefined ? Number(a.versionsCount) : '';
      if (typeof versCount === 'number' && !isNaN(versCount)) {
        totalPressings += versCount;
      }

      const statusText = this.formatStatusForExport(a.status);
      const stars = this.formatRatingForExport(a.rating);
      const highVal = a.isHighValue ? 'ДА (💎)' : 'Нет';

      albumsData.push([
        a._tableName || 'Каталог альбомов',
        a.artist || '',
        a.title || '',
        a.year || '',
        versCount,
        stars,
        highVal,
        statusText,
        a.genre || '',
        a.style || '',
        a.uri || (a.masterId ? `https://www.discogs.com/master/${a.masterId}` : ''),
        a.notes || '',
        a.createdAt ? new Date(a.createdAt).toLocaleDateString('ru-RU') : ''
      ]);
    });

    // Summary Row for Albums
    albumsData.push([]);
    albumsData.push([
      'ИТОГО АЛЬБОМОВ:',
      albums.length,
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

    const wsAlbums = XLSX.utils.aoa_to_sheet(albumsData);
    wsAlbums['!cols'] = [
      { wch: 22 }, // Таблица / Список
      { wch: 24 }, // Исполнитель
      { wch: 30 }, // Альбом
      { wch: 10 }, // Год
      { wch: 22 }, // Изданий
      { wch: 14 }, // Оценка
      { wch: 18 }, // Ценность
      { wch: 12 }, // Статус
      { wch: 18 }, // Жанры
      { wch: 22 }, // Стили
      { wch: 34 }, // Ссылка
      { wch: 30 }, // Заметки
      { wch: 14 }  // Дата
    ];
    XLSX.utils.book_append_sheet(wb, wsAlbums, 'Каталог альбомов');

    // ==========================================
    // SHEET 3: Spotify Песни (Треки)
    // ==========================================
    const spotifyData = [];
    spotifyData.push([
      'Таблица / Список',
      '#',
      'Название песни / трека',
      'Исполнитель',
      'Альбом',
      'Длительность',
      'Оценка (1-5)',
      'Повышенная ценность',
      'Статус',
      'Ссылка Spotify',
      'Spotify URI',
      'Дата релиза',
      'Заметки',
      'Дата добавления'
    ]);

    let totalMs = 0;
    (spotifyTracks || []).forEach((t, idx) => {
      if (t.durationMs) {
        totalMs += Number(t.durationMs);
      }

      const statusText = this.formatStatusForExport(t.status);
      const stars = this.formatRatingForExport(t.rating);
      const highVal = t.isHighValue ? 'ДА (💎)' : 'Нет';

      spotifyData.push([
        t._tableName || 'Мой треклист',
        idx + 1,
        t.title || '',
        t.artist || '',
        t.album || '',
        t.durationStr || '',
        stars,
        highVal,
        statusText,
        t.externalUrl || t.spotifyUrl || (t.spotifyId ? `https://open.spotify.com/track/${t.spotifyId}` : ''),
        t.uri || (t.spotifyId ? `spotify:track:${t.spotifyId}` : ''),
        t.releaseDate || '',
        t.notes || '',
        t.createdAt ? new Date(t.createdAt).toLocaleDateString('ru-RU') : ''
      ]);
    });

    // Calculate total duration in min/hours
    const totalMinutes = Math.floor(totalMs / 60000);
    const totalHours = Math.floor(totalMinutes / 60);
    const remMin = totalMinutes % 60;
    const durSummary = totalHours > 0 ? `${totalHours} ч ${remMin} мин` : `${totalMinutes} мин`;

    spotifyData.push([]);
    spotifyData.push([
      'ИТОГО ТРЕКОВ:',
      spotifyTracks.length,
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

    const wsSpotify = XLSX.utils.aoa_to_sheet(spotifyData);
    wsSpotify['!cols'] = [
      { wch: 22 }, // Таблица / Список
      { wch: 6 },  // #
      { wch: 32 }, // Название трека
      { wch: 24 }, // Исполнитель
      { wch: 28 }, // Альбом
      { wch: 14 }, // Длительность
      { wch: 14 }, // Оценка
      { wch: 18 }, // Ценность
      { wch: 14 }, // Статус
      { wch: 38 }, // Ссылка Spotify
      { wch: 34 }, // Spotify URI
      { wch: 14 }, // Дата релиза
      { wch: 30 }, // Заметки
      { wch: 14 }  // Дата добавления
    ];
    XLSX.utils.book_append_sheet(wb, wsSpotify, 'Spotify Треки');

    // Generate filename with current date
    const dateStr = new Date().toISOString().slice(0, 10);
    const outName = filename || `vinyl_hunter_export_${dateStr}.xlsx`;

    XLSX.writeFile(wb, outName);
  },

  formatStatusForExport(status) {
    const s = status || 'buy';
    if (s === 'take' || s === 'planned') return 'Взять';
    if (s === 'replace') return 'Заменить';
    if (s === 'owned' || s === 'playlist') return 'В наличии';
    return 'Купить';
  },

  parseStatusFromImport(text) {
    const t = String(text || '').trim().toLowerCase();
    if (t.includes('взят') || t.includes('план')) return 'take';
    if (t.includes('замен')) return 'replace';
    if (t.includes('наличи') || t.includes('куплен') || t.includes('плейлист')) return 'owned';
    return 'buy';
  },

  formatRatingForExport(val) {
    const num = parseFloat(val);
    if (!num || isNaN(num) || num <= 0) return '—';
    const fullStars = Math.floor(num);
    const hasHalf = (num % 1) >= 0.5;
    const starStr = '★'.repeat(fullStars) + (hasHalf ? '½' : '');
    return `${starStr} (${num}/5)`;
  },

  parseRatingFromImport(val) {
    if (!val) return 0;
    const str = String(val).trim();
    const match = str.match(/([0-5](?:\.[0-9])?)\s*\/\s*5/);
    if (match) return parseFloat(match[1]);
    const starCount = (str.match(/★/g) || []).length;
    const hasHalf = str.includes('½') || str.includes('1/2') || str.includes('.5');
    if (starCount > 0 || hasHalf) {
      return starCount + (hasHalf ? 0.5 : 0);
    }
    const num = parseFloat(str);
    if (!isNaN(num) && num >= 0.5 && num <= 5) return num;
    return 0;
  },

  parseHighValueFromImport(val) {
    if (!val) return false;
    const str = String(val).toUpperCase();
    return str.includes('ДА') || str.includes('💎') || str === 'TRUE' || str === '1';
  },

  parseWorkbook(data) {
    if (!window.XLSX) {
      throw new Error('Библиотека XLSX не загружена.');
    }
    const wb = XLSX.read(data, { type: 'array' });
    const result = {
      releases: {},
      albums: {},
      spotify: {}
    };

    wb.SheetNames.forEach(sheetName => {
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      if (!rows || rows.length < 2) return;

      const header = rows[0].map(h => String(h || '').trim().toLowerCase());
      const sName = sheetName.toLowerCase();

      let mode = null;
      if (sName.includes('пластинк') || sName.includes('release')) {
        mode = 'releases';
      } else if (sName.includes('альбом') || sName.includes('master')) {
        mode = 'albums';
      } else if (sName.includes('песн') || sName.includes('трек') || sName.includes('spotify')) {
        mode = 'spotify';
      } else {
        if (header.some(h => h.includes('длительност') || h.includes('песни'))) mode = 'spotify';
        else if (header.some(h => h.includes('виниловых изданий') || h.includes('стили'))) mode = 'albums';
        else mode = 'releases';
      }

      const colMap = {};
      header.forEach((h, idx) => {
        if (h.includes('таблица') || h.includes('список')) colMap.table = idx;
        else if (h.includes('исполнитель') || h.includes('артист')) colMap.artist = idx;
        else if (h.includes('альбом')) colMap.album = idx;
        else if (h.includes('песни') || h.includes('трек') || h.includes('название')) colMap.title = idx;
        else if (h.includes('год') || h.includes('релиз')) colMap.year = idx;
        else if (h.includes('страна')) colMap.country = idx;
        else if (h.includes('формат')) colMap.format = idx;
        else if (h.includes('лейбл')) colMap.label = idx;
        else if (h.includes('мин') && h.includes('цена')) colMap.priceMin = idx;
        else if (h.includes('медиана')) colMap.priceMedian = idx;
        else if (h.includes('макс') && h.includes('цена')) colMap.priceMax = idx;
        else if (h.includes('валюта')) colMap.currency = idx;
        else if (h.includes('оценка')) colMap.rating = idx;
        else if (h.includes('ценност')) colMap.highValue = idx;
        else if (h.includes('статус')) colMap.status = idx;
        else if (h.includes('ссылка')) colMap.link = idx;
        else if (h.includes('заметки') || h.includes('youtube')) colMap.notes = idx;
        else if (h.includes('дата')) colMap.date = idx;
        else if (h.includes('изданий') || h.includes('вариантов')) colMap.versionsCount = idx;
        else if (h.includes('жанр')) colMap.genre = idx;
        else if (h.includes('стил')) colMap.style = idx;
        else if (h.includes('длительност')) colMap.duration = idx;
        else if (h.includes('обложк') || h.includes('cover')) colMap.cover = idx;
        else if (h.includes('uri')) colMap.uri = idx;
      });

      if (mode === 'releases' && colMap.album !== undefined && colMap.title === undefined) {
        colMap.title = colMap.album;
      }
      if (mode === 'albums' && colMap.album !== undefined && colMap.title === undefined) {
        colMap.title = colMap.album;
      }

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const firstCell = String(row[0] || '').trim();
        if (firstCell.startsWith('ИТОГО') || firstCell.startsWith('ИТОГ:')) continue;

        const tableName = (colMap.table !== undefined && row[colMap.table]) 
          ? String(row[colMap.table]).trim() 
          : (mode === 'releases' ? 'Основная коллекция' : (mode === 'albums' ? 'Каталог альбомов' : 'Мой треклист'));

        const artist = (colMap.artist !== undefined && row[colMap.artist]) ? String(row[colMap.artist]).trim() : '';
        const title = (colMap.title !== undefined && row[colMap.title]) ? String(row[colMap.title]).trim() : '';

        if (!artist && !title) continue;

        if (!result[mode][tableName]) {
          result[mode][tableName] = [];
        }

        const rating = colMap.rating !== undefined ? this.parseRatingFromImport(row[colMap.rating]) : 0;
        const isHighValue = colMap.highValue !== undefined ? this.parseHighValueFromImport(row[colMap.highValue]) : false;
        const status = colMap.status !== undefined ? this.parseStatusFromImport(row[colMap.status]) : 'buy';
        const year = (colMap.year !== undefined && row[colMap.year]) ? String(row[colMap.year]).trim() : '';
        const notes = (colMap.notes !== undefined && row[colMap.notes]) ? String(row[colMap.notes]).trim() : '';
        const link = (colMap.link !== undefined && row[colMap.link]) ? String(row[colMap.link]).trim() : '';
        const cover = (colMap.cover !== undefined && row[colMap.cover]) ? String(row[colMap.cover]).trim() : '';
        const importedDate = (colMap.date !== undefined && row[colMap.date]) ? String(row[colMap.date]).trim() : '';

        // Preserve the original date from the file
        let createdAt = new Date().toISOString();
        if (importedDate) {
          const numDate = Number(importedDate);
          if (!isNaN(numDate) && numDate > 20000 && numDate < 80000) {
            // Excel serial date number (days since 1899-12-30)
            createdAt = new Date(Math.round((numDate - 25569) * 86400 * 1000)).toISOString();
          } else {
            // Try parsing common date formats: dd.mm.yyyy, yyyy-mm-dd, mm/dd/yyyy
            const dotMatch = importedDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
            const isoMatch = importedDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
            const slashMatch = importedDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (dotMatch) {
              createdAt = new Date(`${dotMatch[3]}-${dotMatch[2].padStart(2,'0')}-${dotMatch[1].padStart(2,'0')}T12:00:00.000Z`).toISOString();
            } else if (isoMatch) {
              createdAt = new Date(`${isoMatch[1]}-${isoMatch[2].padStart(2,'0')}-${isoMatch[3].padStart(2,'0')}T12:00:00.000Z`).toISOString();
            } else if (slashMatch) {
              createdAt = new Date(`${slashMatch[3]}-${slashMatch[1].padStart(2,'0')}-${slashMatch[2].padStart(2,'0')}T12:00:00.000Z`).toISOString();
            } else {
              const parsed = Date.parse(importedDate);
              if (!isNaN(parsed)) createdAt = new Date(parsed).toISOString();
            }
          }
        }

        const item = {
          id: `import_${mode}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          artist,
          title,
          year,
          rating,
          isHighValue,
          status,
          notes,
          uri: link,
          coverImage: cover || undefined,
          thumb: cover || undefined,
          createdAt
        };

        if (mode === 'releases') {
          item.country = (colMap.country !== undefined && row[colMap.country]) ? String(row[colMap.country]).trim() : '';
          item.format = (colMap.format !== undefined && row[colMap.format]) ? String(row[colMap.format]).trim() : 'Vinyl';
          item.label = (colMap.label !== undefined && row[colMap.label]) ? String(row[colMap.label]).trim() : '';
          item.currency = (colMap.currency !== undefined && row[colMap.currency]) ? String(row[colMap.currency]).trim() : 'USD';
          item.priceMin = (colMap.priceMin !== undefined && row[colMap.priceMin] !== '') ? Number(row[colMap.priceMin]) : null;
          item.priceMedian = (colMap.priceMedian !== undefined && row[colMap.priceMedian] !== '') ? Number(row[colMap.priceMedian]) : null;
          item.priceMax = (colMap.priceMax !== undefined && row[colMap.priceMax] !== '') ? Number(row[colMap.priceMax]) : null;
          
          if (link) {
            const m = link.match(/release\/(\d+)/);
            if (m) {
              item.discogsId = parseInt(m[1], 10);
              item.id = `discogs-${m[1]}`;
            }
          }
        } else if (mode === 'albums') {
          item.versionsCount = (colMap.versionsCount !== undefined && row[colMap.versionsCount] !== '') ? Number(row[colMap.versionsCount]) : null;
          item.genre = (colMap.genre !== undefined && row[colMap.genre]) ? String(row[colMap.genre]).trim() : '';
          item.style = (colMap.style !== undefined && row[colMap.style]) ? String(row[colMap.style]).trim() : '';
          if (link) {
            const m = link.match(/master\/(\d+)/);
            if (m) {
              item.masterId = parseInt(m[1], 10);
              item.id = `master-${m[1]}`;
            }
          }
        } else if (mode === 'spotify') {
          item.album = (colMap.album !== undefined && row[colMap.album]) ? String(row[colMap.album]).trim() : '';
          item.durationStr = (colMap.duration !== undefined && row[colMap.duration]) ? String(row[colMap.duration]).trim() : '';
          item.uri = (colMap.uri !== undefined && row[colMap.uri]) ? String(row[colMap.uri]).trim() : '';
          if (link) {
            const m = link.match(/track\/([a-zA-Z0-9]+)/);
            if (m) {
              item.spotifyId = m[1];
              item.id = m[1];
            }
          }
        }

        result[mode][tableName].push(item);
      }
    });

    return result;
  },

  // Backward compatibility alias
  exportRecords(records, filename = null) {
    this.exportAll(
      records,
      window.App ? (window.App.tables?.albums || window.App.albums) : [],
      window.App ? (window.App.tables?.spotify || window.App.spotifyTracks) : [],
      filename
    );
  }
};

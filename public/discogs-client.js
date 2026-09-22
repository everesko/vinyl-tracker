/**
 * Discogs Client Helper
 * Handles communication with the backend Discogs proxy with client-side caching
 * Supports both Vinyl Releases and Master Albums
 */

const clientMemoryCache = new Map();

const DiscogsClient = {
  getToken() {
    return localStorage.getItem('vinyl_discogs_token') || '';
  },

  setToken(token) {
    if (token) {
      localStorage.setItem('vinyl_discogs_token', token.trim());
    } else {
      localStorage.removeItem('vinyl_discogs_token');
    }
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem('vinyl_discogs_user') || 'null');
    } catch (e) {
      return null;
    }
  },

  setUser(user) {
    if (user) {
      localStorage.setItem('vinyl_discogs_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('vinyl_discogs_user');
    }
  },

  getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) {
      headers['x-discogs-token'] = token;
    }
    return headers;
  },

  /**
   * Search for Vinyl releases
   */
  /**
   * Search for Vinyl Records (Releases)
   */
  async searchVinyl(query, page = 1, perPage = 25) {
    if (!query || !query.trim() || query.trim().length < 2) {
      return { results: [], pagination: {} };
    }

    const trimmed = query.trim();
    const cacheKey = `search_release_v4_${trimmed}_${page}_${perPage}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }

    let fetchPromises = [];
    if (trimmed.includes(' - ')) {
      const parts = trimmed.split(' - ');
      const art = parts[0].trim();
      const tit = parts.slice(1).join(' - ').trim();
      fetchPromises = [
        fetch(`/api/discogs/search?artist=${encodeURIComponent(art)}&release_title=${encodeURIComponent(tit)}&type=release&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null),
        fetch(`/api/discogs/search?q=${encodeURIComponent(trimmed)}&type=release&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null)
      ];
    } else {
      fetchPromises = [
        fetch(`/api/discogs/search?artist=${encodeURIComponent(trimmed)}&type=release&sort=have&sort_order=desc&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null),
        fetch(`/api/discogs/search?q=${encodeURIComponent(trimmed)}&type=release&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null)
      ];
    }

    const responses = await Promise.all(fetchPromises);
    const dataList = await Promise.all(responses.map(async r => {
      if (r && r.ok) return await r.json().catch(() => ({ results: [] }));
      return { results: [] };
    }));

    const rawResults = [];
    const seenIds = new Set();
    for (const d of dataList) {
      if (Array.isArray(d.results)) {
        for (const item of d.results) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            rawResults.push(item);
          }
        }
      }
    }

    const results = rawResults.map(item => {
      let artist = '';
      let title = item.title || '';

      if (item.title && item.title.includes(' - ')) {
        const parts = item.title.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }

      // Clean trailing edition markers and artist numbering
      artist = artist.replace(/\s*\(\d+\)$/, '').replace(/\*+$/, '').trim();

      const formatStr = Array.isArray(item.format) ? item.format.join(', ') : (item.format || 'Vinyl');
      const labelStr = Array.isArray(item.label) ? item.label[0] : (item.label || '');
      const catnoStr = item.catno || '';

      return {
        id: item.id,
        artist: artist,
        title: title,
        rawTitle: item.title,
        year: item.year || '',
        country: item.country || '',
        format: formatStr,
        label: labelStr,
        catno: catnoStr,
        thumb: item.thumb || '',
        coverImage: item.cover_image || item.thumb || '',
        uri: item.uri ? `https://www.discogs.com${item.uri}` : `https://www.discogs.com/release/${item.id}`,
        community: item.community || {},
        num_for_sale: item.num_for_sale !== undefined ? item.num_for_sale : (item.numForSale !== undefined ? item.numForSale : null)
      };
    });

    const output = {
      results,
      pagination: dataList[0]?.pagination || dataList[1]?.pagination || {}
    };

    clientMemoryCache.set(cacheKey, output);
    return output;
  },

  /**
   * Search for Albums (finds ALL artists and albums, whether indexed as Master or standalone Vinyl Release)
   */
  async searchAlbums(query, page = 1, perPage = 25) {
    if (!query || !query.trim()) {
      return { results: [], pagination: {} };
    }

    const trimmed = query.trim();
    const cacheKey = `search_master_v4_${trimmed}_${page}_${perPage}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }

    let fetchPromises = [];
    if (trimmed.includes(' - ')) {
      const parts = trimmed.split(' - ');
      const art = parts[0].trim();
      const tit = parts.slice(1).join(' - ').trim();
      fetchPromises = [
        fetch(`/api/discogs/search?artist=${encodeURIComponent(art)}&release_title=${encodeURIComponent(tit)}&type=master&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null),
        fetch(`/api/discogs/search?q=${encodeURIComponent(trimmed)}&type=release&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null)
      ];
    } else {
      fetchPromises = [
        // 1. If artist name: query masters ordered by popularity/have desc
        fetch(`/api/discogs/search?artist=${encodeURIComponent(trimmed)}&type=master&sort=have&sort_order=desc&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null),
        // 2. Fulltext keyword search across masters (for albums, keywords)
        fetch(`/api/discogs/search?q=${encodeURIComponent(trimmed)}&type=master&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null)
      ];
    }

    const responses = await Promise.all(fetchPromises);
    const [dFirst, dSecond] = await Promise.all(responses.map(async r => {
      if (r && r.ok) return await r.json().catch(() => ({ results: [] }));
      return { results: [] };
    }));

    const rawTargetedMasters = trimmed.includes(' - ') ? (Array.isArray(dFirst?.results) ? dFirst.results : []) : [];
    const rawArtistMasters = trimmed.includes(' - ') ? [] : (Array.isArray(dFirst?.results) ? dFirst.results : []);
    const rawKeywordMasters = trimmed.includes(' - ') ? [] : (Array.isArray(dSecond?.results) ? dSecond.results : []);
    const rawReleases = trimmed.includes(' - ') ? (Array.isArray(dSecond?.results) ? dSecond.results : []) : [];

    // Fast fallback if neither masters nor artist produced results (rare indie releases)
    if (rawTargetedMasters.length === 0 && rawArtistMasters.length === 0 && rawKeywordMasters.length === 0 && rawReleases.length === 0) {
      try {
        const fallbackRel = await fetch(`/api/discogs/search?q=${encodeURIComponent(trimmed)}&type=release&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null);
        if (fallbackRel && fallbackRel.ok) {
          const fbData = await fallbackRel.json().catch(() => ({ results: [] }));
          if (Array.isArray(fbData.results)) rawReleases.push(...fbData.results);
        }
      } catch (e) {}
    }

    const seenAlbums = new Set();
    const results = [];

    // Helper to add master/release item
    const addMasterItem = (item) => {
      let artist = '';
      let title = item.title || '';
      if (item.title && item.title.includes(' - ')) {
        const parts = item.title.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }

      // Clean artist name (remove Discogs numbering like "(2)" or trailing "*")
      const cleanArtist = artist.replace(/\s*\(\d+\)$/, '').replace(/\*+$/, '').trim();
      const cleanTitle = title.replace(/\s*\([^)]*\)$/, '').trim();
      const dedupeKey = `${cleanArtist.toLowerCase()} - ${cleanTitle.toLowerCase()}`;

      if (!seenAlbums.has(dedupeKey)) {
        seenAlbums.add(dedupeKey);
        results.push({
          id: item.id || item.master_id,
          masterId: item.master_id || item.id,
          artist: cleanArtist || artist,
          title: cleanTitle || title,
          rawTitle: item.title,
          year: item.year || '',
          thumb: item.thumb || '',
          coverImage: item.cover_image || item.thumb || '',
          genre: Array.isArray(item.genre) ? item.genre.join(', ') : (item.genre || ''),
          style: Array.isArray(item.style) ? item.style.join(', ') : (item.style || ''),
          uri: item.uri ? `https://www.discogs.com${item.uri}` : `https://www.discogs.com/master/${item.master_id || item.id}`,
          versionsCount: typeof item.versionsCount === 'number' ? item.versionsCount : null,
          community: item.community || {},
          num_for_sale: item.num_for_sale !== undefined ? item.num_for_sale : null
        });
      }
    };

    // 1. Add targeted / artist masters first (most relevant albums)
    for (const item of rawTargetedMasters) {
      addMasterItem(item);
    }
    for (const item of rawArtistMasters) {
      addMasterItem(item);
    }

    // 2. Add keyword masters
    for (const item of rawKeywordMasters) {
      addMasterItem(item);
    }

    // 3. Add releases that have no master or were not included in masters
    for (const item of rawReleases) {
      let artist = '';
      let title = item.title || '';
      if (item.title && item.title.includes(' - ')) {
        const parts = item.title.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }

      const cleanArtist = artist.replace(/\s*\(\d+\)$/, '').replace(/\*+$/, '').trim();
      const cleanTitle = title.replace(/\s*\([^)]*\)$/, '').trim();
      const dedupeKey = `${cleanArtist.toLowerCase()} - ${cleanTitle.toLowerCase()}`;

      if (!seenAlbums.has(dedupeKey)) {
        seenAlbums.add(dedupeKey);
        const formatStr = Array.isArray(item.format) ? item.format.join(', ') : (item.format || 'Vinyl');
        results.push({
          id: item.master_id || item.id,
          masterId: item.master_id || null,
          releaseId: item.id,
          isReleaseOnly: !item.master_id,
          artist: cleanArtist || artist,
          title: cleanTitle || title,
          rawTitle: item.title,
          year: item.year || '',
          country: item.country || '',
          format: formatStr,
          thumb: item.thumb || '',
          coverImage: item.cover_image || item.thumb || '',
          uri: item.uri ? `https://www.discogs.com${item.uri}` : `https://www.discogs.com/release/${item.id}`,
          versionsCount: item.master_id ? (typeof item.versionsCount === 'number' ? item.versionsCount : null) : 1,
          community: item.community || {},
          num_for_sale: item.num_for_sale !== undefined ? item.num_for_sale : null
        });
      }
    }

    const output = {
      results,
      pagination: dFirst?.pagination || dSecond?.pagination || {}
    };

    clientMemoryCache.set(cacheKey, output);
    return output;
  },

  /**
   * Search for an artist by name
   */
  async searchArtist(query) {
    if (!query || !query.trim()) return null;
    const clean = query.trim();
    const artPart = clean.includes(' - ') ? clean.split(' - ')[0].trim() : clean;
    if (!artPart) return null;

    const cacheKey = `artist_search_${artPart.toLowerCase()}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }

    try {
      const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(artPart)}&type=artist&per_page=5`, {
        headers: this.getHeaders()
      });
      if (!res.ok) return null;
      const data = await res.json();
      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) {
        clientMemoryCache.set(cacheKey, null);
        return null;
      }

      const normalize = s => (s || '').toLowerCase().replace(/\s*\(\d+\)$/, '').replace(/[^a-z0-9а-яё]/gi, '');
      const normQuery = normalize(artPart);

      let matched = results.find(r => normalize(r.title) === normQuery);
      if (!matched && results.length > 0) {
        matched = results.find(r => {
          const nTitle = normalize(r.title);
          return nTitle.startsWith(normQuery) || normQuery.startsWith(nTitle);
        });
      }
      if (!matched && results.length > 0) {
        matched = results[0];
        const n0 = normalize(matched.title);
        if (!n0.includes(normQuery) && !normQuery.includes(n0)) {
          matched = null;
        }
      }

      if (!matched) {
        clientMemoryCache.set(cacheKey, null);
        return null;
      }

      const cleanName = matched.title.replace(/\s*\(\d+\)$/, '').trim();
      const output = {
        id: matched.id,
        name: cleanName,
        rawTitle: matched.title,
        thumb: matched.thumb || matched.cover_image || '',
        uri: matched.uri ? `https://www.discogs.com${matched.uri}` : `https://www.discogs.com/artist/${matched.id}`
      };

      clientMemoryCache.set(cacheKey, output);
      return output;
    } catch (e) {
      console.warn('searchArtist error:', e);
      return null;
    }
  },

  /**
   * Get all vinyl editions of an artist
   */
  async getArtistAlbums(artistId, artistName = '', page = 1, perPage = 50) {
    if (!artistName && !artistId) return { results: [], pagination: {} };
    const cleanArtistName = (artistName || '').replace(/\s*\(\d+\)$/, '').trim();
    const cacheKey = `artist_vinyl_editions_${cleanArtistName.toLowerCase()}_${page}_${perPage}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }

    try {
      // 1. Fetch canonical vinyl masters (format=Vinyl, type=master)
      // 2. Fetch specific vinyl releases (format=Vinyl, type=release)
      const [mastersRes, releasesRes] = await Promise.all([
        fetch(`/api/discogs/search?artist=${encodeURIComponent(cleanArtistName)}&format=Vinyl&type=master&sort=have&sort_order=desc&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null),
        fetch(`/api/discogs/search?artist=${encodeURIComponent(cleanArtistName)}&format=Vinyl&type=release&sort=have&sort_order=desc&page=${page}&per_page=${perPage}`, { headers: this.getHeaders() }).catch(() => null)
      ]);

      const [mastersData, releasesData] = await Promise.all([
        (mastersRes && mastersRes.ok) ? mastersRes.json().catch(() => ({ results: [] })) : { results: [] },
        (releasesRes && releasesRes.ok) ? releasesRes.json().catch(() => ({ results: [] })) : { results: [] }
      ]);

      const rawMasters = Array.isArray(mastersData.results) ? mastersData.results : [];
      const rawReleases = Array.isArray(releasesData.results) ? releasesData.results : [];

      const seenTitles = new Set();
      const results = [];

      const processItem = (item, isMaster) => {
        let title = (item.title || '').trim();
        // Remove "Artist - " prefix if present in title
        if (title.toLowerCase().startsWith(cleanArtistName.toLowerCase() + ' - ')) {
          title = title.substring(cleanArtistName.length + 3).trim();
        } else if (title.includes(' - ')) {
          title = title.split(' - ').slice(1).join(' - ').trim();
        }

        const cleanTitle = title.replace(/\s*\([^)]*\)$/, '').trim();
        const dedupeKey = cleanTitle.toLowerCase();
        if (seenTitles.has(dedupeKey)) return;
        seenTitles.add(dedupeKey);

        const formatStr = Array.isArray(item.format) ? item.format.join(', ') : (item.format || 'Vinyl, LP, Album');

        results.push({
          id: item.master_id || item.id,
          masterId: item.master_id || (isMaster ? item.id : null),
          releaseId: !isMaster ? item.id : null,
          artist: cleanArtistName || item.artist || '',
          title: cleanTitle || title,
          rawTitle: item.title,
          year: item.year || '',
          country: item.country || '',
          thumb: item.thumb || '',
          coverImage: item.cover_image || item.thumb || '',
          format: formatStr,
          versionsCount: (isMaster || item.master_id) ? null : 1,
          type: (isMaster || item.master_id) ? 'master' : 'release'
        });
      };

      // Canonical vinyl masters first, then unique vinyl releases
      for (const m of rawMasters) processItem(m, true);
      for (const r of rawReleases) processItem(r, false);

      const output = {
        results,
        pagination: mastersData.pagination || releasesData.pagination || {}
      };

      clientMemoryCache.set(cacheKey, output);
      return output;
    } catch (e) {
      console.warn('getArtistAlbums error:', e);
      return { results: [], pagination: {} };
    }
  },

  /**
   * Get exact count of Vinyl Editions for multiple Masters in a fast batch
   */
  async getBatchMasterVersionsCounts(masterIds) {
    if (!Array.isArray(masterIds) || masterIds.length === 0) return {};
    const uncachedIds = [];
    const counts = {};

    for (const id of masterIds) {
      const cacheKey = `master_versions_count_${id}`;
      if (clientMemoryCache.has(cacheKey)) {
        counts[id] = clientMemoryCache.get(cacheKey);
      } else {
        uncachedIds.push(id);
      }
    }

    if (uncachedIds.length === 0) return counts;

    try {
      const res = await fetch(`/api/discogs/masters/versions-counts?ids=${uncachedIds.join(',')}`, {
        headers: this.getHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        const serverCounts = data.counts || {};
        for (const [id, count] of Object.entries(serverCounts)) {
          const num = typeof count === 'number' ? count : 1;
          counts[id] = num;
          clientMemoryCache.set(`master_versions_count_${id}`, num);
        }
      }
    } catch (e) {
      console.warn('Batch versions counts fetch error:', e);
    }

    return counts;
  },

  async getMasterVersionsCount(masterId) {
    if (!masterId) return 1;
    const cacheKey = `master_versions_count_${masterId}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }
    try {
      const res = await fetch(`/api/discogs/master/${masterId}/versions-count`, {
        headers: this.getHeaders()
      });
      if (!res.ok) return 1;
      const data = await res.json();
      const count = (data && typeof data.versions_count === 'number') ? data.versions_count : 1;
      clientMemoryCache.set(cacheKey, count);
      return count;
    } catch (e) {
      console.warn('Failed to load master versions count:', e);
      return 1;
    }
  },

  /**
   * Get Master Vinyl Stats (backward compatibility)
   */
  async getMasterVinylStats(masterId) {
    if (!masterId) return null;
    const cacheKey = `master_vinyl_stats_${masterId}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }
    try {
      const res = await fetch(`/api/discogs/master/${masterId}/vinyl-stats`, {
        headers: this.getHeaders()
      });
      if (!res.ok) return null;
      const data = await res.json();
      clientMemoryCache.set(cacheKey, data);
      return data;
    } catch (e) {
      console.warn('Failed to load master vinyl stats:', e);
      return null;
    }
  },

  /**
   * Get Master Release details (including num_for_sale across all formats)
   */
  async getMaster(masterId) {
    if (!masterId) return null;

    const cacheKey = `master_${masterId}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }

    try {
      const res = await fetch(`/api/discogs/master/${masterId}`, {
        headers: this.getHeaders()
      });

      if (!res.ok) return null;
      const data = await res.json();
      clientMemoryCache.set(cacheKey, data);
      return data;
    } catch (e) {
      console.warn('Failed to fetch master info:', e);
      return null;
    }
  },

  /**
   * Get all Vinyl versions/pressings of a Master Album
   */
  async getMasterVersions(masterId, page = 1, perPage = 50) {
    if (!masterId) return { versions: [], pagination: {} };

    const cacheKey = `master_vers_${masterId}_${page}_${perPage}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }

    try {
      const res = await fetch(`/api/discogs/master/${masterId}/versions?format=Vinyl&page=${page}&per_page=${perPage}`, {
        headers: this.getHeaders()
      });

      if (!res.ok) {
        return { versions: [], pagination: {} };
      }

      const data = await res.json();
      if (data && Array.isArray(data.versions) && data.versions.length > 0) {
        data.versions.forEach(v => {
          const yr = parseInt(v.released || v.year, 10);
          if (yr && !isNaN(yr) && yr > 1900) {
            v.year = String(yr);
          }
        });
        const validYears = data.versions
          .map(v => parseInt(v.year || v.released, 10))
          .filter(y => !isNaN(y) && y > 1900 && y <= new Date().getFullYear());
        if (validYears.length > 0) {
          data.firstPressYear = Math.min(...validYears);
        }
      }
      clientMemoryCache.set(cacheKey, data);
      return data;
    } catch (e) {
      console.warn('Failed to fetch master versions:', e);
      return { versions: [], pagination: {} };
    }
  },

  /**
   * Get pricing statistics for a release (Min, Median, Max)
   */
  async getPriceStats(releaseId) {
    if (!releaseId) return null;

    const cacheKey = `price_${releaseId}`;
    if (clientMemoryCache.has(cacheKey)) {
      return clientMemoryCache.get(cacheKey);
    }

    try {
      const res = await fetch(`/api/discogs/price-stats?release_id=${releaseId}`, {
        headers: this.getHeaders()
      });

      if (!res.ok) return null;
      const data = await res.json();
      clientMemoryCache.set(cacheKey, data);
      return data;
    } catch (e) {
      console.warn('Failed to load price stats:', e);
      return null;
    }
  },

  hasPriceInCache(releaseId) {
    return clientMemoryCache.has(`price_stats_${releaseId}`);
  },

  /**
   * Check token validity and get user profile
   */
  async checkIdentity(token) {
    const tokenToTest = token || this.getToken();
    if (!tokenToTest) throw new Error('Токен не указан');

    const res = await fetch(`/api/discogs/user/identity`, {
      headers: {
        'x-discogs-token': tokenToTest
      }
    });

    const data = await res.json();
    if (!res.ok || !data.valid) {
      throw new Error(data.error || 'Неверный токен Discogs');
    }

    return data;
  },

  /**
   * Get user's collection folders
   */
  async getFolders(username) {
    const user = username || (this.getUser() ? this.getUser().username : null);
    if (!user) throw new Error('Имя пользователя Discogs не определено');

    const res = await fetch(`/api/discogs/user/folders?username=${encodeURIComponent(user)}`, {
      headers: this.getHeaders()
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Ошибка загрузки папок');
    }

    const data = await res.json();
    return data.folders || [];
  },

  /**
   * Create a new folder in user's Discogs collection
   */
  async createFolder(folderName, username) {
    const user = username || (this.getUser() ? this.getUser().username : null);
    if (!user) throw new Error('Пользователь Discogs не подключен');

    const res = await fetch(`/api/discogs/user/folders?username=${encodeURIComponent(user)}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ folderName })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Ошибка создания папки в Discogs');
    }

    return await res.json();
  },

  /**
   * Batch sync records to Discogs collection folder or wantlist
   */
  async syncRecords(releases, options = {}) {
    const user = options.username || (this.getUser() ? this.getUser().username : null);
    if (!user) throw new Error('Пользователь Discogs не подключен');

    const folderId = options.folderId;
    const mode = options.mode || 'collection';

    const res = await fetch(`/api/discogs/user/sync?username=${encodeURIComponent(user)}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        folderId,
        mode,
        releases
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Ошибка синхронизации с Discogs');
    }

    return await res.json();
  },

  /**
   * Get releases in a user's collection folder (Import from Discogs)
   */
  async getFolderReleases(folderId = 0, page = 1, perPage = 50, username = null) {
    const user = username || (this.getUser() ? this.getUser().username : null);
    if (!user) throw new Error('Пользователь Discogs не подключен');

    const res = await fetch(`/api/discogs/user/collection/releases?username=${encodeURIComponent(user)}&folder_id=${folderId}&page=${page}&per_page=${perPage}`, {
      headers: this.getHeaders()
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Ошибка загрузки релизов из Discogs');
    }

    return await res.json();
  },

  /**
   * Get releases in user's Wantlist (Import from Discogs)
   */
  async getUserWants(page = 1, perPage = 50, username = null) {
    const user = username || (this.getUser() ? this.getUser().username : null);
    if (!user) throw new Error('Пользователь Discogs не подключен');

    const res = await fetch(`/api/discogs/user/wants?username=${encodeURIComponent(user)}&page=${page}&per_page=${perPage}`, {
      headers: this.getHeaders()
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Ошибка загрузки Wantlist из Discogs');
    }

    return await res.json();
  }
};

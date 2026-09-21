/**
 * VINYL HUNTER — Main Application Logic
 * Dual-Mode Architecture:
 * 1. Releases Mode: Specific vinyl pressings with live prices
 * 2. Albums Mode: Canonical albums with live editions count & interactive pressings breakdown
 */

const App = {
  appMode: 'releases', // 'releases', 'albums', or 'spotify'
  tables: {
    releases: [],
    albums: [],
    spotify: []
  },
  activeTableId: null,
  records: [],         // specific vinyl releases (synced view)
  albums: [],          // master albums (synced view)
  spotifyTracks: [],   // spotify songs / tracks (synced view)
  playingAudio: null,  // active HTML5 Audio element for preview
  selectedIds: new Set(),
  filterStatus: 'all',
  tableSearchQuery: '',
  sortCol: 'createdAt',
  sortAsc: false,
  editingRecordId: null,
  companionSearchTimeout: null,
  lastCompanionSearchResults: [],
  currentMasterModalData: null,
  filters: {
    status: new Set(['buy', 'take', 'replace', 'owned']),
    ratings: new Set([1, 2, 3, 4, 5]),
    highValueOnly: false,
    yearMin: null,
    yearMax: null,
    metricMin: null,
    metricMax: null,
    countries: new Set()
  },
  masterVersionsObserver: null,
  lazyPriceQueue: [],
  isProcessingPriceQueue: false,
  tracklistCache: new Map(),

  async init() {
    this.handleOAuthCallback();
    const spToken = SpotifyClient.handleHashCallback() || SpotifyClient.getToken();
    if (spToken) {
      SpotifyClient.checkIdentity(spToken).then(user => {
        SpotifyClient.setUser(user);
        this.updateSpotifyUIStatus();
      }).catch((err) => {
        console.warn('Spotify token expired or invalid:', err);
        SpotifyClient.setToken('');
        SpotifyClient.setUser(null);
        this.updateSpotifyUIStatus();
      });
    }
    if (window.location.search && window.location.search.includes('spotify_auth_success=1')) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    // Fetch server saved Spotify credentials if local is missing
    try {
      const spCredsRes = await fetch('/api/spotify/credentials');
      if (spCredsRes.ok) {
        const spCreds = await spCredsRes.json();
        if (spCreds.clientId) {
          SpotifyClient.setClientId(spCreds.clientId);
          if (spCreds.hasSecret && !SpotifyClient.getClientSecret()) {
            SpotifyClient.setClientSecret('••••••••');
          }
          if (!SpotifyClient.getUser()) {
            SpotifyClient.setUser({
              id: spCreds.clientId.substring(0, 8),
              display_name: `Ключ API (${spCreds.clientId.substring(0, 6)}...)`,
              isApiKey: true
            });
          }
        }
      }
    } catch (e) {}

    this.bindEvents();
    this.updateDiscogsUIStatus();
    this.updateSpotifyUIStatus();

    // Restore collapsible states
    if (localStorage.getItem('filters_collapsed') === '1') {
      const fCard = document.getElementById('advancedFiltersCard');
      if (fCard) fCard.classList.add('collapsed');
      const icon = document.getElementById('filtersCollapseIcon');
      const text = document.getElementById('filtersCollapseText');
      if (icon) icon.textContent = '▶';
      if (text) text.textContent = 'Развернуть фильтры';
    }

    if (localStorage.getItem('pinned_collapsed') === '1') {
      const pSec = document.getElementById('pinnedShowcaseSection');
      if (pSec) pSec.classList.add('collapsed');
      const icon = document.getElementById('pinnedCollapseIcon');
      const text = document.getElementById('pinnedCollapseText');
      if (icon) icon.textContent = '▶';
      if (text) text.textContent = 'Развернуть';
    }

    // Load saved mode preference
    const savedMode = localStorage.getItem('vinyl_app_mode') || 'releases';
    this.setAppMode(savedMode, false);

    // Initialize Firebase Sync for Releases
    FirebaseSync.onStatusChange((statusInfo) => {
      this.renderCloudStatus(statusInfo);
    });

    await this.loadAllReleases();

    await FirebaseSync.init((updatedRecords) => {
      if (updatedRecords && Array.isArray(updatedRecords) && updatedRecords.length > 0) {
        if (!this.tables.releases || this.tables.releases.length === 0) {
          this.tables.releases = this.normalizeTables(updatedRecords, 'releases', 'Основная коллекция');
        } else {
          this.tables.releases[0].items = updatedRecords;
        }
        this.syncLegacyArrays();
        if (this.appMode === 'releases') this.render();
      }
    });

    // Load local albums
    await this.loadAlbums();

    // Load local Spotify songs
    await this.loadSpotifyTracks();

    this.render();
  },

  handleOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('discogs_auth') === 'success') {
      const token = urlParams.get('discogs_token');
      const secret = urlParams.get('discogs_token_secret');
      const username = urlParams.get('discogs_username');

      if (token) {
        DiscogsClient.setToken(token);
        DiscogsClient.setUser({
          username: username || '',
          tokenSecret: secret || ''
        });

        DiscogsClient.checkIdentity(token).then(fullUser => {
          DiscogsClient.setUser(fullUser);
          this.updateDiscogsUIStatus();
        }).catch(() => {});

        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  },

  // ----------------------------------------------------
  // App Mode Switcher
  // ----------------------------------------------------
  setAppMode(mode, doRender = true) {
    if (mode === 'albums') this.appMode = 'albums';
    else if (mode === 'spotify') this.appMode = 'spotify';
    else this.appMode = 'releases';

    localStorage.setItem('vinyl_app_mode', this.appMode);

    if (this.appMode === 'albums') {
      document.body.className = 'mode-albums';
    } else if (this.appMode === 'spotify') {
      document.body.className = 'mode-spotify';
    } else {
      document.body.className = 'mode-releases';
    }

    const btnReleases = document.getElementById('btnModeReleases');
    const btnAlbums = document.getElementById('btnModeAlbums');
    const btnSpotify = document.getElementById('btnModeSpotify');
    const brandTag = document.getElementById('brandTag');
    const companionInput = document.getElementById('companionInput');
    const searchModalTitle = document.getElementById('discogsSearchModalTitle');
    const discogsHeaderBadge = document.getElementById('discogsHeaderBadge');
    const spotifyHeaderBadge = document.getElementById('spotifyHeaderBadge');
    const btnSyncDiscogs = document.getElementById('btnSyncSelectedRecords');
    const btnTransferSpotify = document.getElementById('btnTransferToSpotify');
    const btnOpenDiscogsSearch = document.getElementById('btnOpenDiscogsSearch');

    btnReleases?.classList.remove('active');
    btnAlbums?.classList.remove('active');
    btnSpotify?.classList.remove('active');

    if (this.appMode === 'spotify') {
      btnSpotify?.classList.add('active');
      if (brandTag) brandTag.textContent = 'SPOTIFY TRACKS';
      if (companionInput) companionInput.placeholder = 'Поиск песен в Spotify: Bohemian Rhapsody, Daft Punk, Кино...';
      if (searchModalTitle) searchModalTitle.textContent = 'Поиск песен в Spotify (с аудио-превью)';
      if (discogsHeaderBadge) discogsHeaderBadge.style.display = 'none';
      if (spotifyHeaderBadge) spotifyHeaderBadge.style.display = 'inline-flex';
      if (btnSyncDiscogs) btnSyncDiscogs.style.display = 'none';
      if (btnTransferSpotify) btnTransferSpotify.style.display = 'inline-flex';
      if (btnOpenDiscogsSearch) {
        btnOpenDiscogsSearch.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg> Искать в Spotify`;
      }
    } else if (this.appMode === 'albums') {
      btnAlbums?.classList.add('active');
      if (brandTag) brandTag.textContent = 'ALBUM CATALOG';
      if (companionInput) companionInput.placeholder = 'Поиск по альбомам: Pink Floyd The Wall, Miles Davis, Кино...';
      if (searchModalTitle) searchModalTitle.textContent = 'Поиск альбомов на Discogs (каждый альбом один раз)';
      if (discogsHeaderBadge) discogsHeaderBadge.style.display = 'inline-flex';
      if (spotifyHeaderBadge) spotifyHeaderBadge.style.display = 'none';
      if (btnSyncDiscogs) btnSyncDiscogs.style.display = 'inline-flex';
      if (btnTransferSpotify) btnTransferSpotify.style.display = 'none';
      if (btnOpenDiscogsSearch) {
        btnOpenDiscogsSearch.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg> Найти на Discogs`;
      }
    } else {
      btnReleases?.classList.add('active');
      if (brandTag) brandTag.textContent = 'CRATE DIGGER';
      if (companionInput) companionInput.placeholder = 'Например: Pink Floyd Time, Miles Davis, Daft Punk...';
      if (searchModalTitle) searchModalTitle.textContent = 'Поиск виниловых пластинок на Discogs';
      if (discogsHeaderBadge) discogsHeaderBadge.style.display = 'inline-flex';
      if (spotifyHeaderBadge) spotifyHeaderBadge.style.display = 'none';
      if (btnSyncDiscogs) btnSyncDiscogs.style.display = 'inline-flex';
      if (btnTransferSpotify) btnTransferSpotify.style.display = 'none';
      if (btnOpenDiscogsSearch) {
        btnOpenDiscogsSearch.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg> Найти на Discogs`;
      }
    }

    this.selectedIds.clear();
    if (doRender) this.render();
  },

  // ----------------------------------------------------
  // Multi-Tables Storage & Data Normalization
  // ----------------------------------------------------
  normalizeTables(data, mode, defaultName) {
    if (data && data.tables && Array.isArray(data.tables) && data.tables.length > 0) {
      return data.tables;
    }
    if (Array.isArray(data) && data.length > 0) {
      if (data[0] && Array.isArray(data[0].items) && data[0].hasOwnProperty('name')) {
        return data;
      }
      return [{
        id: `tbl_${mode}_default`,
        name: defaultName,
        isCollapsed: false,
        items: data
      }];
    }
    return [{
      id: `tbl_${mode}_default`,
      name: defaultName,
      isCollapsed: false,
      items: []
    }];
  },

  async loadAllReleases() {
    let data = null;
    try {
      const localTbl = localStorage.getItem('vinyl_releases_tables');
      if (localTbl) data = JSON.parse(localTbl);
    } catch (e) {}

    if (!data) {
      try {
        const res = await fetch('/api/storage/records?type=release');
        if (res.ok) data = await res.json();
      } catch (e) {}
    }

    if (!data) {
      data = await FirebaseSync.loadLocalRecords();
    }

    this.tables.releases = this.normalizeTables(data, 'releases', 'Основная коллекция');
    this.records = this.getAllItemsInMode('releases');
  },

  async loadAlbums() {
    let data = null;
    try {
      const localTbl = localStorage.getItem('vinyl_albums_tables');
      if (localTbl) data = JSON.parse(localTbl);
    } catch (e) {}

    if (!data) {
      try {
        const res = await fetch('/api/storage/records?type=album');
        if (res.ok) data = await res.json();
      } catch (e) {}
    }

    if (!data) {
      try {
        const local = localStorage.getItem('vinyl_albums_local');
        if (local) data = JSON.parse(local);
      } catch (e) {}
    }

    this.tables.albums = this.normalizeTables(data, 'albums', 'Каталог альбомов');
    this.albums = this.getAllItemsInMode('albums');
  },

  async loadSpotifyTracks() {
    let data = null;
    try {
      const localTbl = localStorage.getItem('vinyl_spotify_tables');
      if (localTbl) data = JSON.parse(localTbl);
    } catch (e) {}

    if (!data) {
      try {
        const res = await fetch('/api/storage/records?type=spotify');
        if (res.ok) data = await res.json();
      } catch (e) {}
    }

    if (!data) {
      try {
        const local = localStorage.getItem('vinyl_spotify_tracks_local');
        if (local) data = JSON.parse(local);
      } catch (e) {}
    }

    this.tables.spotify = this.normalizeTables(data, 'spotify', 'Мой треклист');
    this.spotifyTracks = this.getAllItemsInMode('spotify');
  },

  getActiveModeTables(mode = this.appMode) {
    if (!this.tables[mode] || this.tables[mode].length === 0) {
      const defaultNames = { releases: 'Основная коллекция', albums: 'Каталог альбомов', spotify: 'Мой треклист' };
      this.tables[mode] = [{
        id: `tbl_${mode}_default`,
        name: defaultNames[mode] || 'Основная коллекция',
        isCollapsed: false,
        items: []
      }];
    }
    return this.tables[mode];
  },

  getAllItemsInMode(mode = this.appMode) {
    const tbls = this.tables[mode] || [];
    const items = [];
    tbls.forEach(t => {
      if (Array.isArray(t.items)) {
        items.push(...t.items);
      }
    });
    return items;
  },

  syncLegacyArrays() {
    this.records = this.getAllItemsInMode('releases');
    this.albums = this.getAllItemsInMode('albums');
    this.spotifyTracks = this.getAllItemsInMode('spotify');
  },

  saveModeTables(mode = this.appMode) {
    this.syncLegacyArrays();
    const tables = this.tables[mode] || [];
    if (mode === 'releases') {
      try {
        localStorage.setItem('vinyl_releases_tables', JSON.stringify(tables));
        fetch('/api/storage/records?type=release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tables })
        }).catch(() => {});
        FirebaseSync.saveLocalRecords(this.records);
      } catch (e) {}
    } else if (mode === 'albums') {
      try {
        localStorage.setItem('vinyl_albums_tables', JSON.stringify(tables));
        fetch('/api/storage/records?type=album', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tables })
        }).catch(() => {});
        localStorage.setItem('vinyl_albums_local', JSON.stringify(this.albums));
      } catch (e) {}
    } else if (mode === 'spotify') {
      try {
        localStorage.setItem('vinyl_spotify_tables', JSON.stringify(tables));
        fetch('/api/storage/records?type=spotify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tables })
        }).catch(() => {});
        localStorage.setItem('vinyl_spotify_tracks_local', JSON.stringify(this.spotifyTracks));
      } catch (e) {}
    }
  },

  saveAlbumsLocally() {
    this.saveModeTables('albums');
  },

  saveSpotifyTracksLocally() {
    this.saveModeTables('spotify');
  },

  findTableAndItem(itemId, mode = this.appMode, fallbackOtherModes = false) {
    const sId = String(itemId);
    const pureId = sId.replace(/^(discogs-|master-|sp-|manual-sp-|manual-album-|manual-)/, '');
    const tbls = this.getActiveModeTables(mode);
    for (const tbl of tbls) {
      if (Array.isArray(tbl.items)) {
        const idx = tbl.items.findIndex(it => {
          const itId = String(it.id || '');
          const itPure = itId.replace(/^(discogs-|master-|sp-|manual-sp-|manual-album-|manual-)/, '');
          return itId === sId || 
                 (pureId && itPure === pureId && !pureId.startsWith('track_')) || 
                 (it.discogsId && String(it.discogsId) === sId) || 
                 (it.masterId && String(it.masterId) === sId) || 
                 (it.spotifyId && String(it.spotifyId) === sId);
        });
        if (idx !== -1) {
          return { table: tbl, index: idx, item: tbl.items[idx] };
        }
      }
    }
    // Only search across all other modes if explicitly requested
    if (fallbackOtherModes) {
      for (const m of ['releases', 'albums', 'spotify']) {
        if (m === mode) continue;
        const otherTbls = this.getActiveModeTables(m);
        for (const tbl of otherTbls) {
          if (Array.isArray(tbl.items)) {
            const idx = tbl.items.findIndex(it => String(it.id) === sId);
            if (idx !== -1) {
              return { table: tbl, index: idx, item: tbl.items[idx], actualMode: m };
            }
          }
        }
      }
    }
    return null;
  },

  addItemToActiveTable(newItem, targetTableId = null, mode = this.appMode) {
    const tbls = this.getActiveModeTables(mode);
    let targetTable = null;
    if (targetTableId) {
      targetTable = tbls.find(t => t.id === targetTableId);
    }
    if (!targetTable && this.activeTableId) {
      targetTable = tbls.find(t => t.id === this.activeTableId);
    }
    if (!targetTable) {
      targetTable = tbls[0];
    }
    if (!targetTable.items) targetTable.items = [];
    targetTable.isCollapsed = false;

    if (!newItem.createdAt) {
      newItem.createdAt = new Date().toISOString();
    }

    const existing = this.findTableAndItem(newItem.id, mode, true);
    if (existing) {
      existing.table.items[existing.index] = { ...existing.item, ...newItem };
    } else {
      targetTable.items.unshift(newItem);
    }
    this.saveModeTables(mode);
    return newItem;
  },

  deleteItemFromMode(itemId, mode = this.appMode) {
    const found = this.findTableAndItem(itemId, mode);
    if (found) {
      found.table.items.splice(found.index, 1);
      this.selectedIds.delete(String(itemId));
      this.saveModeTables(mode);
      return true;
    }
    return false;
  },

  // Table Management Operations
  promptCreateTable() {
    const currentCount = (this.tables[this.appMode] || []).length;
    const defaultName = `Таблица ${currentCount + 1}`;
    const name = prompt('Введите название новой таблицы:', defaultName);
    if (!name || !name.trim()) return;
    const newTable = {
      id: `tbl_${this.appMode}_${Date.now()}`,
      name: name.trim(),
      isCollapsed: false,
      items: []
    };
    this.getActiveModeTables().push(newTable);
    this.activeTableId = newTable.id;
    this.saveModeTables();
    this.render();
  },

  promptRenameTable(tableId) {
    const tbls = this.getActiveModeTables();
    const table = tbls.find(t => t.id === tableId);
    if (!table) return;
    const newName = prompt('Новое название таблицы:', table.name);
    if (!newName || !newName.trim() || newName.trim() === table.name) return;
    table.name = newName.trim();
    this.saveModeTables();
    this.render();
  },

  deleteTable(tableId) {
    const tbls = this.getActiveModeTables();
    if (tbls.length <= 1) {
      alert('Нельзя удалить единственную таблицу. Вы можете переименовать её или очистить записи.');
      return;
    }
    const table = tbls.find(t => t.id === tableId);
    if (!table) return;
    const count = table.items?.length || 0;
    const confirmMsg = count > 0 
      ? `Удалить таблицу «${table.name}» и все её ${count} записей?`
      : `Удалить пустую таблицу «${table.name}»?`;
    if (!confirm(confirmMsg)) return;

    (table.items || []).forEach(it => this.selectedIds.delete(String(it.id)));
    this.tables[this.appMode] = tbls.filter(t => t.id !== tableId);
    if (this.activeTableId === tableId) {
      this.activeTableId = this.tables[this.appMode][0]?.id || null;
    }
    this.saveModeTables();
    this.render();
  },

  toggleTableCollapse(tableId) {
    const tbls = this.getActiveModeTables();
    const table = tbls.find(t => t.id === tableId);
    if (!table) return;
    table.isCollapsed = !table.isCollapsed;
    this.saveModeTables();
    this.render();
  },

  selectAllInTable(tableId, isChecked) {
    const tbls = this.getActiveModeTables();
    const table = tbls.find(t => t.id === tableId);
    if (!table || !table.items) return;
    table.items.forEach(it => {
      const sId = String(it.id);
      if (isChecked) {
        this.selectedIds.add(sId);
      } else {
        this.selectedIds.delete(sId);
      }
    });
    this.updateSelectionToolbar();
    this.render();
  },

  promptMoveItem(itemId) {
    const found = this.findTableAndItem(itemId, this.appMode);
    if (!found) return;
    const tbls = this.getActiveModeTables();
    if (tbls.length < 2) {
      alert('Для перемещения создайте хотя бы еще одну таблицу кнопкой «+ Новая таблица».');
      return;
    }
    const otherTables = tbls.filter(t => t.id !== found.table.id);
    const optionsText = otherTables.map((t, idx) => `${idx + 1}. ${t.name}`).join('\n');
    const input = prompt(`Переместить «${found.item.title || found.item.artist || 'запись'}» в другую таблицу:\n\n${optionsText}\n\nВведите номер таблицы:`, "1");
    if (!input) return;
    const choiceIdx = parseInt(input.trim(), 10) - 1;
    if (choiceIdx >= 0 && choiceIdx < otherTables.length) {
      const targetTable = otherTables[choiceIdx];
      found.table.items.splice(found.index, 1);
      if (!targetTable.items) targetTable.items = [];
      targetTable.items.unshift(found.item);
      this.saveModeTables();
      this.render();
    }
  },

  handleCompanionPlusClick() {
    const input = document.getElementById('companionInput');
    const q = input ? input.value.trim() : '';
    this.openDiscogsSearchModal(q);
  },

  openAddForTable(tableId) {
    this._explicitTargetTableId = tableId;
    this.activeTableId = tableId;
    const compQ = document.getElementById('companionInput')?.value?.trim() || '';
    const tblQ = document.getElementById('tableSearchInput')?.value?.trim() || '';
    const q = compQ || tblQ || '';
    this.openDiscogsSearchModal(q);
  },

  // Collapse Toggles for Filters and Pinned Table
  toggleFiltersCollapse() {
    const card = document.getElementById('advancedFiltersCard');
    if (!card) return;
    const isCollapsed = card.classList.toggle('collapsed');
    const icon = document.getElementById('filtersCollapseIcon');
    const text = document.getElementById('filtersCollapseText');
    if (icon) icon.textContent = isCollapsed ? '▶' : '▼';
    if (text) text.textContent = isCollapsed ? 'Развернуть фильтры' : 'Свернуть фильтры';
    localStorage.setItem('filters_collapsed', isCollapsed ? '1' : '0');
  },

  togglePinnedCollapse() {
    const section = document.getElementById('pinnedShowcaseSection');
    if (!section) return;
    const isCollapsed = section.classList.toggle('collapsed');
    const icon = document.getElementById('pinnedCollapseIcon');
    const text = document.getElementById('pinnedCollapseText');
    if (icon) icon.textContent = isCollapsed ? '▶' : '▼';
    if (text) text.textContent = isCollapsed ? 'Развернуть' : 'Свернуть';
    localStorage.setItem('pinned_collapsed', isCollapsed ? '1' : '0');
  },

  // ----------------------------------------------------
  // Event Bindings
  // ----------------------------------------------------
  bindEvents() {
    const companionInput = document.getElementById('companionInput');
    const companionClearBtn = document.getElementById('companionClearBtn');
    if (companionInput) {
      companionInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (companionClearBtn) {
          companionClearBtn.style.display = val ? 'block' : 'none';
        }

        clearTimeout(this.companionSearchTimeout);
        this.companionSearchTimeout = setTimeout(() => {
          this.handleCompanionLiveSearch(val);
        }, 650);
      });

      companionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === '+') {
          e.preventDefault();
          const q = companionInput.value.trim().replace(/\+$/, '').trim();
          if (q) {
            clearTimeout(this.companionSearchTimeout);
            this.openDiscogsSearchModal(q);
          }
        }
      });
    }

    if (companionClearBtn) {
      companionClearBtn.addEventListener('click', () => {
        companionInput.value = '';
        companionClearBtn.style.display = 'none';
        clearTimeout(this.companionSearchTimeout);
        this.handleCompanionLiveSearch('');
      });
    }

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filterStatus = btn.dataset.filter;
        this.renderTable();
      });
    });

    const tableSearch = document.getElementById('tableSearchInput');
    if (tableSearch) {
      tableSearch.addEventListener('input', (e) => {
        this.tableSearchQuery = e.target.value.toLowerCase().trim();
        this.renderTable();
      });
      tableSearch.addEventListener('keydown', (e) => {
        if (e.key === '+') {
          const q = tableSearch.value.trim().replace(/\+$/, '').trim();
          if (q) {
            e.preventDefault();
            this.openDiscogsSearchModal(q);
          }
        }
      });
    }

    const discogsSearchInput = document.getElementById('discogsSearchInput');
    if (discogsSearchInput) {
      discogsSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.performDiscogsSearch();
        }
      });
    }

    document.getElementById('btnOpenDiscogsSearch')?.addEventListener('click', () => {
      const currentQ = document.getElementById('companionInput')?.value.trim() || document.getElementById('tableSearchInput')?.value.trim() || '';
      this.openDiscogsSearchModal(currentQ);
    });

    document.getElementById('btnOpenManualAdd')?.addEventListener('click', () => {
      this.openManualAddModal();
    });

    document.getElementById('btnOpenDiscogsModal')?.addEventListener('click', () => {
      this.openDiscogsSettingsModal();
    });

    document.getElementById('btnOpenFirebaseModal')?.addEventListener('click', () => {
      this.openFirebaseModal();
    });

    document.getElementById('btnExportExcel')?.addEventListener('click', () => {
      ExcelExporter.exportAll(this.records, this.albums, this.spotifyTracks);
    });

    document.getElementById('btnTransferToSpotify')?.addEventListener('click', () => {
      this.openSpotifyModal();
    });

    document.getElementById('spotifyHeaderBadge')?.addEventListener('click', () => {
      this.openSpotifyModal();
    });

    document.getElementById('selectAllCheckbox')?.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      const targetList = this.appMode === 'spotify' ? this.spotifyTracks : (this.appMode === 'albums' ? this.albums : this.records);
      if (isChecked) {
        targetList.forEach(r => this.selectedIds.add(String(r.id)));
      } else {
        this.selectedIds.clear();
      }
      this.renderTable();
      this.updateSelectionToolbar();
    });

    document.getElementById('discogsSearchForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.performDiscogsSearch();
    });

    document.getElementById('manualRecordForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveManualRecord();
    });

    document.getElementById('lightboxModal')?.addEventListener('click', () => {
      document.getElementById('lightboxModal').classList.remove('open');
    });

    // Keyboard shortcuts: Escape to close modals, '+' to search
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const tracklistModal = document.getElementById('albumTracklistModal');
        if (tracklistModal && (tracklistModal.classList.contains('open') || tracklistModal.classList.contains('active'))) {
          this.closeAlbumTracklistModal();
          return;
        }

        const searchModal = document.getElementById('discogsSearchModal');
        if (searchModal && (searchModal.classList.contains('open') || searchModal.classList.contains('active'))) {
          this.closeDiscogsSearchModal();
          return;
        }

        const chooseModal = document.getElementById('chooseTableModal');
        if (chooseModal && (chooseModal.classList.contains('open') || chooseModal.classList.contains('active'))) {
          chooseModal.classList.remove('open');
          chooseModal.classList.remove('active');
          this._pendingTableCallback = null;
          return;
        }

        const openModals = document.querySelectorAll('.modal-backdrop.open, .modal-backdrop.active');
        openModals.forEach(m => {
          m.classList.remove('open');
          m.classList.remove('active');
        });
        return;
      }

      // Global '+' key shortcut when not typing in an input
      if (e.key === '+' || e.key === '=') {
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        const isEditing = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';
        if (!isEditing) {
          const compQ = document.getElementById('companionInput')?.value?.trim() || '';
          const tblQ = document.getElementById('tableSearchInput')?.value?.trim() || '';
          const q = compQ || tblQ || '';
          this.openDiscogsSearchModal(q);
        }
      }
    });

    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          // Do NOT close search modal or tracklist modal by clicking outside
          if (modal.id === 'discogsSearchModal' || modal.id === 'albumTracklistModal' || modal.id === 'chooseTableModal') {
            return;
          }
          modal.classList.remove('open');
          modal.classList.remove('active');
        }
      });
    });

    document.querySelectorAll('.modal-close-btn, .modal-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal-backdrop');
        if (modal) {
          if (modal.id === 'albumTracklistModal') {
            this.closeAlbumTracklistModal();
          } else if (modal.id === 'discogsSearchModal') {
            this.closeDiscogsSearchModal();
          } else {
            modal.classList.remove('open');
            modal.classList.remove('active');
          }
        }
      });
    });

    // Close status popover menus when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.status-cell-container')) {
        document.querySelectorAll('.status-menu-popover.open').forEach(p => p.classList.remove('open'));
      }
    });
  },

  // ----------------------------------------------------
  // YouTube Companion: Live Search
  // ----------------------------------------------------
  async handleCompanionLiveSearch(query) {
    const q = query.trim();
    const resultBox = document.getElementById('companionResult');
    if (!resultBox) return;

    if (!q || q.length < 3) {
      resultBox.style.display = 'none';
      resultBox.innerHTML = '';
      return;
    }

    const qLower = q.toLowerCase();
    const targetList = this.appMode === 'spotify' ? this.spotifyTracks : (this.appMode === 'albums' ? this.albums : this.records);

    const localMatches = targetList.filter(r => {
      const artist = (r.artist || '').toLowerCase();
      const title = (r.title || '').toLowerCase();
      const notes = (r.notes || '').toLowerCase();
      return artist.includes(qLower) || title.includes(qLower) || notes.includes(qLower);
    });

    resultBox.style.display = 'block';
    resultBox.className = 'companion-result';

    let html = '';

    if (localMatches.length > 0) {
      const m = localMatches[0];
      let statusLabel = 'В поиске';
      if (m.status === 'owned' || m.status === 'playlist') statusLabel = this.appMode === 'spotify' ? 'В плейлисте' : 'Куплено';
      if (m.status === 'planned') statusLabel = 'В планах';

      html += `
        <div style="padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:space-between;">
          <div>
            <span style="color:var(--status-owned); font-weight:700;">✓ Уже есть в вашем списке:</span>
            <strong>${this.escapeHtml(m.artist)}</strong> — <em>${this.escapeHtml(m.title)}</em> 
            <span style="color:var(--text-muted); font-size:11px;">(${statusLabel})</span>
          </div>
          <button class="btn btn-sm btn-secondary" onclick="App.highlightRecord('${m.id}')">Подсветить</button>
        </div>
      `;
    }

    let modeLabel = 'винила';
    let serviceName = 'Discogs';
    if (this.appMode === 'spotify') {
      modeLabel = 'песен';
      serviceName = 'Spotify';
    } else if (this.appMode === 'albums') {
      modeLabel = 'альбомов';
      serviceName = 'Discogs';
    }

    html += `
      <div style="margin-top: 6px; display:flex; align-items:center; justify-content:space-between;">
        <span style="font-size:11.5px; color:var(--text-secondary);">Поиск ${modeLabel} в ${serviceName} по запросу «${this.escapeHtml(q)}»...</span>
        <button class="btn btn-sm btn-primary" onclick="App.openDiscogsSearchModal('${this.escapeHtml(q)}')">
          Полный поиск ${serviceName} →
        </button>
      </div>
      <div id="companionLiveDiscogsItems" style="margin-top: 8px;">
        <div style="font-size:11px; color:var(--text-muted); padding:4px 0;">Загрузка из ${serviceName}...</div>
      </div>
    `;

    resultBox.innerHTML = html;

    try {
      let data;
      if (this.appMode === 'spotify') {
        data = await SpotifyClient.searchTracks(q, 4);
      } else if (this.appMode === 'albums') {
        data = await DiscogsClient.searchAlbums(q, 1, 4);
      } else {
        data = await DiscogsClient.searchVinyl(q, 1, 4);
      }

      const itemsContainer = document.getElementById('companionLiveDiscogsItems');
      if (!itemsContainer) return;

      const results = data.results || [];
      if (results.length === 0) {
        itemsContainer.innerHTML = `
          <div style="font-size:11.5px; color:var(--text-muted); padding:4px 0;">
            В ${serviceName} совпадений не найдено.
          </div>
        `;
        return;
      }

      this.lastCompanionSearchResults = results;

      if (this.appMode === 'spotify') {
        // SPOTIFY TRACKS MODE
        itemsContainer.innerHTML = results.map(item => {
          const cover = item.coverImage;
          const playBtn = item.previewUrl
            ? `<button class="preview-audio-btn" onclick="App.togglePreviewAudio('${this.escapeHtml(item.previewUrl)}', this)" title="Слушать 30-сек аудио">▶</button>`
            : '';
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid rgba(255,255,255,0.04);">
              <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                ${cover ? `<img src="${this.escapeHtml(cover)}" style="width:34px; height:34px; border-radius:3px; object-fit:cover;">` : '<div style="width:34px; height:34px; background:#1ed760; border-radius:3px; display:flex; align-items:center; justify-content:center; color:#000;">S</div>'}
                <div style="min-width:0;">
                  <div style="font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    ${this.escapeHtml(item.title)}
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    ${this.escapeHtml(item.artist)} · ${this.escapeHtml(item.album || '')}
                    <span class="track-duration-pill" style="margin-left:4px; font-size:10px; padding:1px 5px;">⏱ ${item.durationStr}</span>
                  </div>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                ${playBtn}
                <button class="btn btn-sm btn-primary" onclick="App.addSpotifyTrackFromData('${this.escapeHtml(item.id)}')">
                  + В список
                </button>
              </div>
            </div>
          `;
        }).join('');

      } else if (this.appMode === 'albums') {
        // ALBUMS MODE: show albums with version counts
        itemsContainer.innerHTML = results.map(item => {
          const cover = item.thumb || item.coverImage;
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid rgba(255,255,255,0.04);">
              <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal(${item.id})" style="width:34px; height:34px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  ${cover ? `<img src="${this.escapeHtml(cover)}" style="width:34px; height:34px; border-radius:3px; object-fit:cover;">` : '<div style="width:34px; height:34px; background:#222; border-radius:3px;"></div>'}
                </div>
                <div style="min-width:0;">
                  <div style="font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    ${this.escapeHtml(item.artist || item.rawTitle)}
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal(${item.id})" title="Нажмите, чтобы открыть треклист и слушать">${this.escapeHtml(item.title || '')}</a> ${item.year ? `(${item.year})` : ''} 
                    <span id="companionVersCount-${item.id}" style="color:var(--accent-theme); font-weight:600; font-size:10.5px;"></span>
                  </div>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal(${item.id})" title="Посмотреть список песен и прослушать">🎵 ▶</button>
                <button class="btn btn-sm btn-primary" onclick="App.addAlbumFromCompanion(${item.id})">
                  + В альбомы
                </button>
              </div>
            </div>
          `;
        }).join('');

        // Load version count for albums
        results.forEach(async item => {
          const versData = await DiscogsClient.getMasterVersions(item.id, 1, 1);
          const count = versData && versData.pagination ? versData.pagination.items : null;
          item.versionsCount = count;
          const countEl = document.getElementById(`companionVersCount-${item.id}`);
          if (countEl && count !== null) {
            countEl.textContent = `· ${count} винилов`;
          }
        });

      } else {
        // RELEASES MODE
        itemsContainer.innerHTML = results.map(item => {
          const cover = item.thumb || item.coverImage;
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid rgba(255,255,255,0.04);">
              <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal(${item.id})" style="width:34px; height:34px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  ${cover ? `<img src="${this.escapeHtml(cover)}" style="width:34px; height:34px; border-radius:3px; object-fit:cover;">` : '<div style="width:34px; height:34px; background:#222; border-radius:3px;"></div>'}
                </div>
                <div style="min-width:0;">
                  <div style="font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    ${this.escapeHtml(item.artist || item.rawTitle)}
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal(${item.id})" title="Нажмите, чтобы открыть треклист и слушать">${this.escapeHtml(item.title || '')}</a> ${item.year ? `(${item.year})` : ''} ${item.country ? `[${item.country}]` : ''}
                  </div>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal(${item.id})" title="Посмотреть список песен и прослушать">🎵 ▶</button>
                <button class="btn btn-sm btn-primary" onclick="App.addRecordFromCompanion(${item.id})">
                  + Добавить
                </button>
              </div>
            </div>
          `;
        }).join('');
      }

    } catch (err) {
      const itemsContainer = document.getElementById('companionLiveDiscogsItems');
      if (itemsContainer) {
        itemsContainer.innerHTML = `<div style="font-size:11px; color:var(--danger)">${this.escapeHtml(err.message)}</div>`;
      }
    }
  },

  _pendingTableCallback: null,

  promptDestinationTable(itemTitle, mode, callback) {
    const tbls = this.getActiveModeTables(mode);
    if (this._explicitTargetTableId && tbls.some(t => t.id === this._explicitTargetTableId)) {
      callback(this._explicitTargetTableId);
      return;
    }

    if (tbls.length <= 1) {
      callback(tbls[0] ? tbls[0].id : null);
      return;
    }

    const modal = document.getElementById('chooseTableModal');
    const promptText = document.getElementById('chooseTablePromptText');
    const listEl = document.getElementById('chooseTableList');

    if (!modal || !listEl) {
      callback(tbls[0].id);
      return;
    }

    if (promptText) {
      promptText.textContent = `В какую таблицу добавить «${itemTitle || 'запись'}»?`;
    }

    listEl.innerHTML = tbls.map(tbl => `
      <button type="button" class="choose-table-item-btn" onclick="App.onDestinationTableChosen('${tbl.id}')">
        <span class="choose-table-item-name">📁 ${this.escapeHtml(tbl.name)}</span>
        <span class="choose-table-item-badge">${(tbl.items || []).length} ${this.formatRecordsWord((tbl.items || []).length)}</span>
      </button>
    `).join('');

    this._pendingTableCallback = callback;
    modal.classList.add('open');
    modal.classList.add('active');
  },

  onDestinationTableChosen(tableId) {
    this._explicitTargetTableId = tableId;
    const modal = document.getElementById('chooseTableModal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.remove('active');
    }
    if (this._pendingTableCallback) {
      const cb = this._pendingTableCallback;
      this._pendingTableCallback = null;
      cb(tableId);
    }
  },

  closeChooseTableModal() {
    const modal = document.getElementById('chooseTableModal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.remove('active');
    }
    this._pendingTableCallback = null;
  },

  async addAlbumFromCompanion(masterId) {
    const item = (this.lastCompanionSearchResults || []).find(r => r.id === masterId);
    if (!item) return;

    let versionsCount = item.versionsCount;
    if (versionsCount === null || versionsCount === undefined) {
      const versData = await DiscogsClient.getMasterVersions(masterId, 1, 1);
      versionsCount = versData && versData.pagination ? versData.pagination.items : null;
    }

    const newAlbum = {
      id: `master-${item.id}`,
      masterId: item.id,
      artist: item.artist || item.rawTitle,
      title: item.title || item.rawTitle,
      year: item.year || '',
      coverImage: item.coverImage || item.thumb,
      thumb: item.thumb,
      uri: item.uri,
      versionsCount: versionsCount,
      genre: item.genre || '',
      style: item.style || '',
      status: 'buy',
      notes: '',
      createdAt: new Date().toISOString()
    };

    const existing = this.findTableAndItem(`master-${item.id}`, 'albums');
    if (existing) {
      alert(`Альбом «${newAlbum.artist} - ${newAlbum.title}» уже есть в вашем каталоге!`);
      return;
    }

    this.promptDestinationTable(newAlbum.title || newAlbum.artist, 'albums', (targetTableId) => {
      this.addItemToActiveTable(newAlbum, targetTableId, 'albums');
      this.render();

      const input = document.getElementById('companionInput');
      if (input) input.value = '';
      const resultBox = document.getElementById('companionResult');
      if (resultBox) resultBox.style.display = 'none';

      this.highlightRecord(newAlbum.id);
    });
  },

  async addRecordFromCompanion(releaseId) {
    const item = (this.lastCompanionSearchResults || []).find(r => r.id === releaseId);
    if (!item) return;

    let stats = item.priceStats;
    if (!stats) {
      stats = await DiscogsClient.getPriceStats(releaseId);
    }

    const companionQ = document.getElementById('companionInput')?.value.trim() || '';

    const newRecord = {
      id: `discogs-${item.id}`,
      discogsId: item.id,
      artist: item.artist || item.rawTitle,
      title: item.title || item.rawTitle,
      year: item.year || '',
      country: item.country || '',
      format: item.format || 'Vinyl',
      label: item.label || '',
      catno: item.catno || '',
      priceMin: stats && stats.min ? stats.min : (stats && stats.lowest_price ? stats.lowest_price : null),
      priceMedian: stats && stats.median ? stats.median : null,
      priceMax: stats && stats.max ? stats.max : null,
      currency: stats ? stats.currency : 'USD',
      status: 'buy',
      coverImage: item.coverImage || item.thumb,
      thumb: item.thumb,
      uri: item.uri,
      notes: companionQ ? `Найдено по запросу: ${companionQ}` : '',
      createdAt: new Date().toISOString()
    };

    const existing = this.findTableAndItem(newRecord.id, 'releases');
    if (existing) {
      alert(`Пластинка «${newRecord.artist} - ${newRecord.title}» уже есть в вашем списке!`);
      return;
    }

    this.promptDestinationTable(newRecord.title || newRecord.artist, 'releases', (targetTableId) => {
      this.addItemToActiveTable(newRecord, targetTableId, 'releases');
      this.render();

      const input = document.getElementById('companionInput');
      if (input) input.value = '';
      const resultBox = document.getElementById('companionResult');
      if (resultBox) resultBox.style.display = 'none';

      this.highlightRecord(newRecord.id);
    });
  },

  highlightRecord(id) {
    if (!id) return;
    this.filterStatus = 'all';
    this.tableSearchQuery = '';
    const searchInput = document.getElementById('tableSearchInput');
    if (searchInput) searchInput.value = '';
    document.querySelectorAll('.filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === 'all');
    });

    const found = this.findTableAndItem(id, this.appMode, true);
    if (found && found.table) {
      found.table.isCollapsed = false;
    }

    this.render();

    setTimeout(() => {
      const sId = String(id);
      const row = document.getElementById(`record-row-${sId}`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.transition = 'background-color 0.4s ease';
        row.style.backgroundColor = 'rgba(56, 189, 248, 0.25)';
        setTimeout(() => {
          row.style.backgroundColor = '';
        }, 2000);
      }
    }, 120);
  },

  // ----------------------------------------------------
  // Table & Stats Rendering
  // ----------------------------------------------------
  render() {
    try { this.renderStats(); } catch (e) { console.error('Error in renderStats:', e); }
    try { this.renderDestinationFolderSelect(); } catch (e) { console.error('Error in renderDestinationFolderSelect:', e); }
    try { this.renderTableHeader(); } catch (e) { console.error('Error in renderTableHeader:', e); }
    try { this.populateCountryFilterChips(); } catch (e) { console.error('Error in populateCountryFilterChips:', e); }
    try { this.updateRangeSliderBounds(); } catch (e) { console.error('Error in updateRangeSliderBounds:', e); }
    try { this.renderPinnedTable(); } catch (e) { console.error('Error in renderPinnedTable:', e); }
    try { this.renderTable(); } catch (e) { console.error('Error in renderTable:', e); }
  },

  renderDestinationFolderSelect() {
    const sel = document.getElementById('destTableSelect');
    if (!sel) return;
    const tables = this.getActiveModeTables();
    if (tables.length === 0) {
      sel.innerHTML = '<option value="">Нет таблиц</option>';
      return;
    }
    const curVal = this.currentDestinationTableId || this.activeTableId || tables[0].id;
    sel.innerHTML = tables.map(t => `<option value="${t.id}" ${t.id === curVal ? 'selected' : ''}>${this.escapeHtml(t.name || 'Таблица')}</option>`).join('');
    this.currentDestinationTableId = curVal;
  },

  onDestinationTableChange(val) {
    this.currentDestinationTableId = val;
    this.activeTableId = val;
    this.render();
  },

  renderStats() {
    const isSpotify = this.appMode === 'spotify';
    const isAlbums = this.appMode === 'albums';
    const list = isSpotify ? this.spotifyTracks : (isAlbums ? this.albums : this.records);

    const total = list.length;
    let buyCount = 0;
    let takeCount = 0;
    let replaceCount = 0;
    let ownedCount = 0;

    list.forEach(r => {
      const st = this.getStatusInfo(r.status).status;
      if (st === 'buy') buyCount++;
      else if (st === 'take') takeCount++;
      else if (st === 'replace') replaceCount++;
      else if (st === 'owned') ownedCount++;
    });

    let totalMedian = 0;
    if (!isAlbums && !isSpotify) {
      this.records.forEach(r => {
        if (r.priceMedian && typeof r.priceMedian === 'number') {
          totalMedian += r.priceMedian;
        }
      });
    }

    const statTotalEl = document.getElementById('statTotalCount');
    const statPressesEl = document.getElementById('statPressesCount');
    const statMedianEl = document.getElementById('statTotalMedian');
    const statHuntingEl = document.getElementById('statHuntingCount');
    const statOwnedEl = document.getElementById('statOwnedCount');
    const statMedianTitle = document.getElementById('statMedianTitle');
    const statMedianSub = document.getElementById('statMedianSub');

    if (statTotalEl) statTotalEl.textContent = total;
    if (statHuntingEl) statHuntingEl.textContent = buyCount;
    if (statOwnedEl) statOwnedEl.textContent = ownedCount;

    // Total presses / editions across saved albums
    let totalPressings = 0;
    this.albums.forEach(a => {
      if (typeof a.versionsCount === 'number') totalPressings += a.versionsCount;
    });
    if (statPressesEl) statPressesEl.textContent = totalPressings > 0 ? totalPressings : (isAlbums ? '0' : '—');

    // Min & Max prices of available items (Requirement 12)
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    this.records.forEach(r => {
      const p = r.priceLowest || r.priceMin || r.priceMedian;
      if (typeof p === 'number' && p > 0) {
        if (p < minPrice) minPrice = p;
        if (p > maxPrice) maxPrice = p;
      }
    });
    const priceRangeEl = document.getElementById('statHeaderPriceRange');
    if (priceRangeEl) {
      if (minPrice !== Infinity && maxPrice !== -Infinity) {
        priceRangeEl.textContent = `Мин: $${Math.round(minPrice)} · Макс: $${Math.round(maxPrice)}`;
      } else {
        priceRangeEl.textContent = `Мин: — · Макс: —`;
      }
    }

    if (isSpotify) {
      if (statMedianTitle) statMedianTitle.textContent = 'Общая длительность';
      let totalMs = 0;
      this.spotifyTracks.forEach(t => { if (t.durationMs) totalMs += Number(t.durationMs); });
      const totalMinutes = Math.floor(totalMs / 60000);
      const totalHours = Math.floor(totalMinutes / 60);
      const remMin = totalMinutes % 60;
      const durSummary = totalHours > 0 ? `${totalHours} ч ${remMin} мин` : `${totalMinutes} мин`;
      if (statMedianEl) statMedianEl.textContent = totalMs > 0 ? durSummary : '0 мин';
      if (statMedianSub) statMedianSub.textContent = 'время звучания песен';
    } else if (isAlbums) {
      if (statMedianTitle) statMedianTitle.textContent = 'Всего вариантов прессов';
      if (statMedianEl) statMedianEl.textContent = totalPressings > 0 ? `${totalPressings}` : '—';
      if (statMedianSub) statMedianSub.textContent = 'по сохраненным альбомам';
    } else {
      if (statMedianTitle) statMedianTitle.textContent = 'Оценочная стоимость';
      if (statMedianEl) statMedianEl.textContent = totalMedian > 0 ? `$${Math.round(totalMedian)}` : '—';
      if (statMedianSub) statMedianSub.textContent = 'по медиане Discogs';
    }

    const countAllEl = document.getElementById('filterCountAll');
    const countBuyEl = document.getElementById('filterCountBuy');
    const countTakeEl = document.getElementById('filterCountTake');
    const countReplaceEl = document.getElementById('filterCountReplace');
    const countOwnedEl = document.getElementById('filterCountOwned');
    if (countAllEl) countAllEl.textContent = total;
    if (countBuyEl) countBuyEl.textContent = buyCount;
    if (countTakeEl) countTakeEl.textContent = takeCount;
    if (countReplaceEl) countReplaceEl.textContent = replaceCount;
    if (countOwnedEl) countOwnedEl.textContent = ownedCount;

    const countHuntingEl = document.getElementById('filterCountHunting');
    if (countHuntingEl) countHuntingEl.textContent = buyCount;
  },

  setSortFromSelect(val) {
    if (!val) return;
    const parts = val.split('_');
    const dir = parts[parts.length - 1];
    const col = parts.slice(0, parts.length - 1).join('_');
    this.sortCol = col;
    this.sortAsc = (dir === 'asc');
    this.renderTableHeader();
    this.renderTable();
  },

  setSort(col) {
    if (this.sortCol === col) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortCol = col;
      this.sortAsc = (col === 'priceMedian' || col === 'versionsCount' || col === 'rating' || col === 'isHighValue' || col === 'durationMs') ? false : true;
    }
    const sortVal = `${this.sortCol}_${this.sortAsc ? 'asc' : 'desc'}`;
    const sel = document.getElementById('tableSortSelect');
    if (sel) {
      const match = Array.from(sel.options).find(o => o.value === sortVal);
      if (match) sel.value = sortVal;
    }
    this.renderTableHeader();
    this.renderTable();
  },

  getSortIndicator(col) {
    if (this.sortCol !== col) return ' <span class="sort-icon">↕</span>';
    return this.sortAsc ? ' <span class="sort-icon active">▲</span>' : ' <span class="sort-icon active">▼</span>';
  },

  formatCompactDateTime(isoStr) {
    if (!isoStr) return '<span style="color:var(--text-muted)">—</span>';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '<span style="color:var(--text-muted)">—</span>';
    const pad = n => String(n).padStart(2, '0');
    const day = pad(d.getDate());
    const mon = pad(d.getMonth() + 1);
    const yr = String(d.getFullYear()).slice(-2);
    const hrs = pad(d.getHours());
    const min = pad(d.getMinutes());
    return `<span class="compact-date-badge" title="${d.toLocaleString('ru-RU')}">${day}.${mon}.${yr} ${hrs}:${min}</span>`;
  },

  renderTableHeader() {
    const thead = document.getElementById('vinylTableHead');
    if (!thead) return;

    if (this.appMode === 'spotify') {
      thead.innerHTML = `
        <tr>
          <th class="cell-checkbox">
            <input type="checkbox" id="selectAllCheckbox" title="Выбрать все">
          </th>
          <th class="cell-cover">Обложка</th>
          <th class="sortable" onclick="App.setSort('title')">
            Название песни &amp; Артист${this.getSortIndicator('title')}
          </th>
          <th class="sortable" onclick="App.setSort('album')">
            Альбом${this.getSortIndicator('album')}
          </th>
          <th class="sortable" onclick="App.setSort('durationMs')">
            Длительность${this.getSortIndicator('durationMs')}
          </th>
          <th style="text-align:center;">Превью</th>
          <th class="sortable" onclick="App.setSort('rating')">
            Оценка${this.getSortIndicator('rating')}
          </th>
          <th class="sortable" onclick="App.setSort('isHighValue')">
            Ценность${this.getSortIndicator('isHighValue')}
          </th>
          <th class="sortable" onclick="App.setSort('status')">
            Статус${this.getSortIndicator('status')}
          </th>
          <th class="sortable cell-date" onclick="App.setSort('createdAt')">
            Добавлен${this.getSortIndicator('createdAt')}
          </th>
          <th style="text-align: right;">Действия</th>
        </tr>
      `;
    } else if (this.appMode === 'albums') {
      thead.innerHTML = `
        <tr>
          <th class="cell-checkbox">
            <input type="checkbox" id="selectAllCheckbox" title="Выбрать все">
          </th>
          <th class="cell-cover">Обложка</th>
          <th class="sortable" onclick="App.setSort('artist')">
            Исполнитель и Альбом${this.getSortIndicator('artist')}
          </th>
          <th class="sortable" onclick="App.setSort('year')">
            Год выпуска${this.getSortIndicator('year')}
          </th>
          <th class="sortable" onclick="App.setSort('versionsCount')">
            Виниловые издания${this.getSortIndicator('versionsCount')}
          </th>
          <th class="sortable" onclick="App.setSort('rating')">
            Оценка${this.getSortIndicator('rating')}
          </th>
          <th class="sortable" onclick="App.setSort('isHighValue')">
            Ценность${this.getSortIndicator('isHighValue')}
          </th>
          <th class="sortable" onclick="App.setSort('status')">
            Статус${this.getSortIndicator('status')}
          </th>
          <th class="sortable cell-date" onclick="App.setSort('createdAt')">
            Добавлен${this.getSortIndicator('createdAt')}
          </th>
          <th style="text-align: right;">Действия</th>
        </tr>
      `;
    } else {
      thead.innerHTML = `
        <tr>
          <th class="cell-checkbox">
            <input type="checkbox" id="selectAllCheckbox" title="Выбрать все">
          </th>
          <th class="cell-cover">Обложка</th>
          <th class="sortable" onclick="App.setSort('artist')">
            Исполнитель и Альбом${this.getSortIndicator('artist')}
          </th>
          <th class="sortable" onclick="App.setSort('year')">
            Год / Страна${this.getSortIndicator('year')}
          </th>
          <th class="sortable" onclick="App.setSort('priceMedian')">
            Цены (Медиана / Мин-Макс)${this.getSortIndicator('priceMedian')}
          </th>
          <th class="sortable" onclick="App.setSort('rating')">
            Оценка${this.getSortIndicator('rating')}
          </th>
          <th class="sortable" onclick="App.setSort('isHighValue')">
            Ценность${this.getSortIndicator('isHighValue')}
          </th>
          <th class="sortable" onclick="App.setSort('status')">
            Статус${this.getSortIndicator('status')}
          </th>
          <th class="sortable cell-date" onclick="App.setSort('createdAt')">
            Добавлен${this.getSortIndicator('createdAt')}
          </th>
          <th style="text-align: right;">Действия</th>
        </tr>
      `;
    }
  },

  renderStarRating(item) {
    const r = parseFloat(item.rating) || 0;
    const ratingLabel = r > 0 ? `${r} из 5` : 'Не оценено';
    let html = `<div class="star-rating" id="star-rating-${item.id}" data-rating="${r}" title="Оценка: ${ratingLabel}" onmouseleave="App.resetStarHover('${item.id}')" onclick="event.stopPropagation()">`;
    for (let i = 1; i <= 5; i++) {
      const isLeftFilled = r >= i - 0.5;
      const isRightFilled = r >= i;
      const halfVal = i - 0.5;
      const fullVal = i;
      html += `
        <span class="star-item" data-star="${i}">
          <svg viewBox="0 0 24 24" class="star-svg" width="16" height="16">
            <path class="star-half-path star-left-path ${isLeftFilled ? 'filled' : ''}" d="M12 2 L12 17.27 L5.82 21 L7.46 13.97 L2 9.24 L9.19 8.63 Z" />
            <path class="star-half-path star-right-path ${isRightFilled ? 'filled' : ''}" d="M12 2 L12 17.27 L18.18 21 L16.54 13.97 L22 9.24 L14.81 8.63 Z" />
          </svg>
          <button type="button" class="star-half-btn star-half-left" 
            onmouseenter="App.onStarHover('${item.id}', ${halfVal})" 
            onclick="App.setRating('${item.id}', ${halfVal})" 
            title="${halfVal} из 5"></button>
          <button type="button" class="star-half-btn star-half-right" 
            onmouseenter="App.onStarHover('${item.id}', ${fullVal})" 
            onclick="App.setRating('${item.id}', ${fullVal})" 
            title="${fullVal} из 5"></button>
        </span>
      `;
    }
    html += `</div>`;
    return html;
  },

  onStarHover(itemId, hoverVal) {
    const el = document.getElementById(`star-rating-${itemId}`);
    if (!el) return;
    const starItems = el.querySelectorAll('.star-item');
    starItems.forEach(item => {
      const starIdx = parseInt(item.dataset.star, 10);
      const leftPath = item.querySelector('.star-left-path');
      const rightPath = item.querySelector('.star-right-path');
      if (leftPath) {
        if (hoverVal >= starIdx - 0.5) leftPath.classList.add('filled');
        else leftPath.classList.remove('filled');
      }
      if (rightPath) {
        if (hoverVal >= starIdx) rightPath.classList.add('filled');
        else rightPath.classList.remove('filled');
      }
    });
  },

  resetStarHover(itemId) {
    const el = document.getElementById(`star-rating-${itemId}`);
    if (!el) return;
    const curVal = parseFloat(el.dataset.rating) || 0;
    const starItems = el.querySelectorAll('.star-item');
    starItems.forEach(item => {
      const starIdx = parseInt(item.dataset.star, 10);
      const leftPath = item.querySelector('.star-left-path');
      const rightPath = item.querySelector('.star-right-path');
      if (leftPath) {
        if (curVal >= starIdx - 0.5) leftPath.classList.add('filled');
        else leftPath.classList.remove('filled');
      }
      if (rightPath) {
        if (curVal >= starIdx) rightPath.classList.add('filled');
        else rightPath.classList.remove('filled');
      }
    });
  },

  async setRating(id, stars) {
    const found = this.findTableAndItem(id, this.appMode);
    let item = found ? found.item : null;
    if (!item) {
      const list = this.appMode === 'spotify' ? this.spotifyTracks : (this.appMode === 'albums' ? this.albums : this.records);
      item = list.find(x => String(x.id) === String(id));
    }
    if (!item) return;

    item.rating = Number(item.rating) === Number(stars) ? 0 : Number(stars);

    this.saveModeTables();
    if (this.appMode === 'releases') {
      await FirebaseSync.saveRecord(item);
    }

    this.renderPinnedTable();
    this.render();
  },

  renderHighValueBadge(item) {
    const isDiamond = Boolean(item.isHighValue || item.isDiamond);
    const active = isDiamond ? 'is-diamond' : '';
    const title = isDiamond ? 'Закреплено в блоке высокой ценности (💎). Нажмите чтобы снять' : 'Отметить как высокую ценность (💎)';
    return `
      <button type="button" class="btn-diamond-toggle ${active}" onclick="event.stopPropagation(); App.toggleHighValue('${item.id}')" title="${title}">
        💎
      </button>
    `;
  },

  async toggleHighValue(id) {
    const found = this.findTableAndItem(id, this.appMode);
    let item = found ? found.item : null;
    if (!item) {
      const list = this.appMode === 'spotify' ? this.spotifyTracks : (this.appMode === 'albums' ? this.albums : this.records);
      item = list.find(x => String(x.id) === String(id));
    }
    if (!item) return;

    const newVal = !(item.isHighValue || item.isDiamond);
    item.isHighValue = newVal;
    item.isDiamond = newVal;

    this.saveModeTables();
    if (this.appMode === 'releases') {
      await FirebaseSync.saveRecord(item);
    }

    this.renderPinnedTable();
    this.render();
  },

  renderPinnedTable() {
    const tbody = document.getElementById('pinnedTableBody');
    const emptyEl = document.getElementById('pinnedEmptyState');
    const countEl = document.getElementById('pinnedCountPill');
    if (!tbody) return;

    const tables = this.getActiveModeTables();
    const list = tables.reduce((acc, t) => acc.concat(t.items || []), []);

    // Strictly items marked with the diamond icon (💎)
    const pinned = list.filter(item => Boolean(item.isHighValue || item.isDiamond));

    if (countEl) countEl.textContent = pinned.length;

    if (pinned.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    tbody.innerHTML = pinned.map(item => {
      const coverUrl = item.coverImage || item.thumb;
      const isAlbum = !!item.masterId;
      const isSpotify = this.appMode === 'spotify';
      let detailMetric = '—';
      if (isSpotify) {
        detailMetric = item.durationStr ? `⏱ ${item.durationStr}` : 'Трек';
      } else if (isAlbum) {
        detailMetric = item.versionsCount ? `💿 ${item.versionsCount} винилов` : 'Альбом';
      } else {
        detailMetric = item.priceMedian ? `$${Number(item.priceMedian).toFixed(2)}` : '—';
      }

      const stInfo = this.getStatusInfo(item.status);

      return `
        <tr>
          <td style="width:36px;">
            <div class="cover-thumb-wrapper" onclick="App.openLightbox('${coverUrl || ''}')">
              ${coverUrl ? `<img src="${this.escapeHtml(coverUrl)}" style="width:32px; height:32px; border-radius:3px; object-fit:cover;">` : '<div style="width:32px; height:32px; background:#222; border-radius:3px;"></div>'}
            </div>
          </td>
          <td>
            <div style="font-weight:700; color:var(--text-primary); font-size:12px;">${this.escapeHtml(item.artist)}</div>
            <div style="font-size:11px; color:var(--text-secondary);">${this.escapeHtml(item.title)}</div>
          </td>
          <td>
            <span style="font-size:11px;">${item.year || item.releaseDate || '—'} ${item.country ? `· ${item.country}` : ''}</span>
          </td>
          <td>
            ${this.renderStarRating(item)}
          </td>
          <td>
            ${this.renderHighValueBadge(item)}
          </td>
          <td>
            <span style="font-family:var(--font-mono); font-size:11.5px; color:var(--accent-theme); font-weight:700;">
              ${detailMetric}
            </span>
          </td>
          <td>
            <span class="status-pill ${stInfo.class}" style="font-size:10px; padding:2px 6px;">${stInfo.label}</span>
          </td>
          <td style="text-align:right;">
            <button class="btn btn-secondary btn-sm" style="font-size:10.5px; padding:3px 8px;" onclick="App.highlightRecord('${item.id}')">
              К записи ↓
            </button>
          </td>
        </tr>
      `;
    }).join('');
  },

  populateCountryFilterChips() {
    const container = document.getElementById('filterCountriesGroup');
    if (!container) return;

    const list = this.appMode === 'albums' ? this.albums : this.records;
    const countryCounts = {};
    list.forEach(r => {
      const c = r.country || 'Не указана';
      countryCounts[c] = (countryCounts[c] || 0) + 1;
    });

    const countries = Object.keys(countryCounts).sort();
    if (countries.length === 0) {
      container.innerHTML = '<span style="font-size:11px; color:var(--text-muted);">Нет данных о странах</span>';
      return;
    }

    container.innerHTML = countries.map(c => {
      const checked = this.filters.countries.size === 0 || this.filters.countries.has(c);
      return `
        <label class="filter-chip ${checked ? 'active' : ''}">
          <input type="checkbox" name="f_country" value="${this.escapeHtml(c)}" ${checked ? 'checked' : ''} onchange="App.onCountryFilterChange()">
          <span>${this.escapeHtml(c)}</span>
          <span style="font-size:10px; opacity:0.75;">(${countryCounts[c]})</span>
        </label>
      `;
    }).join('');
  },

  onCountryFilterChange() {
    const checked = Array.from(document.querySelectorAll('input[name="f_country"]:checked')).map(cb => cb.value);
    const total = document.querySelectorAll('input[name="f_country"]').length;
    if (checked.length === 0 || checked.length === total) {
      this.filters.countries.clear();
    } else {
      this.filters.countries = new Set(checked);
    }
    this.renderTable();
  },

  toggleAllCountries(select) {
    document.querySelectorAll('input[name="f_country"]').forEach(cb => {
      cb.checked = select;
    });
    this.onCountryFilterChange();
  },

  updateRangeSliderBounds() {
    const isAlbums = this.appMode === 'albums';
    const list = isAlbums ? this.albums : this.records;

    const metricTitle = document.getElementById('filterMetricTitle');
    if (metricTitle) {
      metricTitle.textContent = isAlbums ? 'Количество изданий' : 'Медианная цена ($)';
    }

    let minYr = 9999;
    let maxYr = 0;
    list.forEach(r => {
      const y = parseInt(r.year, 10);
      if (!isNaN(y)) {
        if (y < minYr) minYr = y;
        if (y > maxYr) maxYr = y;
      }
    });

    if (minYr === 9999) { minYr = 1960; maxYr = 2026; }
    if (minYr === maxYr) minYr -= 5;

    const yearSlider = document.getElementById('filterYearSlider');
    if (yearSlider) {
      yearSlider.min = minYr;
      yearSlider.max = maxYr;
      if (this.filters.yearMax === null) {
        yearSlider.value = maxYr;
      }
    }

    let maxMetric = 0;
    list.forEach(r => {
      const m = isAlbums ? Number(r.versionsCount) || 0 : Number(r.priceMedian) || 0;
      if (m > maxMetric) maxMetric = m;
    });
    maxMetric = Math.max(50, Math.ceil(maxMetric * 1.1));

    const metricSlider = document.getElementById('filterMetricSlider');
    if (metricSlider) {
      metricSlider.max = maxMetric;
      if (this.filters.metricMax === null) {
        metricSlider.value = maxMetric;
      }
    }
  },

  onYearSliderChange() {
    const slider = document.getElementById('filterYearSlider');
    const minInput = document.getElementById('filterYearMinInput');
    const maxInput = document.getElementById('filterYearMaxInput');
    const label = document.getElementById('filterYearLabel');

    if (!slider) return;
    const maxVal = Number(slider.value);
    if (maxInput) maxInput.value = maxVal;
    this.filters.yearMax = maxVal;
    this.filters.yearMin = minInput && minInput.value ? Number(minInput.value) : null;

    if (label) {
      label.textContent = this.filters.yearMin ? `${this.filters.yearMin} – ${maxVal}` : `До ${maxVal}`;
    }
    this.renderTable();
  },

  onYearInputChange() {
    const minInput = document.getElementById('filterYearMinInput');
    const maxInput = document.getElementById('filterYearMaxInput');
    const slider = document.getElementById('filterYearSlider');
    const label = document.getElementById('filterYearLabel');

    const min = minInput && minInput.value ? Number(minInput.value) : null;
    const max = maxInput && maxInput.value ? Number(maxInput.value) : null;

    this.filters.yearMin = min;
    this.filters.yearMax = max;

    if (max !== null && slider) {
      slider.value = max;
    }
    if (label) {
      if (min && max) label.textContent = `${min} – ${max}`;
      else if (min) label.textContent = `От ${min}`;
      else if (max) label.textContent = `До ${max}`;
      else label.textContent = 'Все';
    }
    this.renderTable();
  },

  onMetricSliderChange() {
    const slider = document.getElementById('filterMetricSlider');
    const minInput = document.getElementById('filterMetricMinInput');
    const maxInput = document.getElementById('filterMetricMaxInput');
    const label = document.getElementById('filterMetricLabel');

    if (!slider) return;
    const maxVal = Number(slider.value);
    if (maxInput) maxInput.value = maxVal;
    this.filters.metricMax = maxVal;
    this.filters.metricMin = minInput && minInput.value ? Number(minInput.value) : null;

    const unit = this.appMode === 'albums' ? ' изд.' : ' $';
    if (label) {
      label.textContent = this.filters.metricMin ? `${this.filters.metricMin} – ${maxVal}${unit}` : `До ${maxVal}${unit}`;
    }
    this.renderTable();
  },

  onMetricInputChange() {
    const minInput = document.getElementById('filterMetricMinInput');
    const maxInput = document.getElementById('filterMetricMaxInput');
    const slider = document.getElementById('filterMetricSlider');
    const label = document.getElementById('filterMetricLabel');

    const min = minInput && minInput.value ? Number(minInput.value) : null;
    const max = maxInput && maxInput.value ? Number(maxInput.value) : null;

    this.filters.metricMin = min;
    this.filters.metricMax = max;

    if (max !== null && slider) {
      slider.value = max;
    }

    const unit = this.appMode === 'albums' ? ' изд.' : ' $';
    if (label) {
      if (min && max) label.textContent = `${min} – ${max}${unit}`;
      else if (min) label.textContent = `От ${min}${unit}`;
      else if (max) label.textContent = `До ${max}${unit}`;
      else label.textContent = 'Все';
    }
    this.renderTable();
  },

  applyFilters() {
    const statusCbs = document.querySelectorAll('input[name="f_status"]:checked');
    this.filters.status = new Set(Array.from(statusCbs).map(cb => cb.value));

    const ratingCbs = document.querySelectorAll('input[name="f_rating"]:checked');
    this.filters.ratings = new Set(Array.from(ratingCbs).map(cb => Number(cb.value)));

    const hvCb = document.getElementById('filterHighValueOnly');
    this.filters.highValueOnly = hvCb ? hvCb.checked : false;

    this.renderTable();
  },

  resetAllFilters() {
    this.filters.status = new Set(['buy', 'take', 'replace', 'owned']);
    this.filters.ratings = new Set([1, 2, 3, 4, 5]);
    this.filters.highValueOnly = false;
    this.filters.yearMin = null;
    this.filters.yearMax = null;
    this.filters.metricMin = null;
    this.filters.metricMax = null;
    this.filters.countries.clear();
    this.filterStatus = 'all';
    this.tableSearchQuery = '';

    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="all"]')?.classList.add('active');

    document.querySelectorAll('input[name="f_status"]').forEach(cb => cb.checked = true);
    document.querySelectorAll('input[name="f_rating"]').forEach(cb => cb.checked = true);
    const hvCb = document.getElementById('filterHighValueOnly');
    if (hvCb) hvCb.checked = false;

    const yMin = document.getElementById('filterYearMinInput');
    const yMax = document.getElementById('filterYearMaxInput');
    const yLbl = document.getElementById('filterYearLabel');
    if (yMin) yMin.value = '';
    if (yMax) yMax.value = '';
    if (yLbl) yLbl.textContent = 'Все';

    const mMin = document.getElementById('filterMetricMinInput');
    const mMax = document.getElementById('filterMetricMaxInput');
    const mLbl = document.getElementById('filterMetricLabel');
    if (mMin) mMin.value = '';
    if (mMax) mMax.value = '';
    if (mLbl) mLbl.textContent = 'Все';

    const searchInput = document.getElementById('tableSearchInput');
    if (searchInput) searchInput.value = '';

    this.populateCountryFilterChips();
    this.updateRangeSliderBounds();
    this.renderTable();
  },

  toggleFiltersCollapse() {
    const card = document.getElementById('advancedFiltersCard');
    const icon = document.getElementById('filtersCollapseIcon');
    const text = document.getElementById('filtersCollapseText');
    if (!card) return;
    card.classList.toggle('collapsed');
    const isCollapsed = card.classList.contains('collapsed');
    if (icon) icon.textContent = isCollapsed ? '▲' : '▼';
    if (text) text.textContent = isCollapsed ? 'Развернуть фильтры' : 'Свернуть фильтры';
  },

  togglePinnedCollapse() {
    const section = document.getElementById('pinnedShowcaseSection');
    const icon = document.getElementById('pinnedCollapseIcon');
    const text = document.getElementById('pinnedCollapseText');
    if (!section) return;
    section.classList.toggle('collapsed');
    const isCollapsed = section.classList.contains('collapsed');
    if (icon) icon.textContent = isCollapsed ? '▲' : '▼';
    if (text) text.textContent = isCollapsed ? 'Развернуть' : 'Свернуть';
  },

  renderTable() {
    this.renderTables();
  },

  renderTables() {
    const container = document.getElementById('tablesContainer');
    if (!container) return;

    const tables = this.getActiveModeTables();
    if (tables.length === 0) {
      container.innerHTML = `
        <div class="empty-table">
          <div class="empty-icon">📁</div>
          <h3>Нет созданных таблиц</h3>
          <p>Создайте первую таблицу для организации вашей коллекции</p>
          <button class="btn btn-primary" onclick="App.promptCreateTable()">+ Создать таблицу</button>
        </div>
      `;
      return;
    }

    container.innerHTML = tables.map(tbl => {
      const items = tbl.items || [];
      const filtered = this.filterAndSortItems(items);
      const isAllSelected = items.length > 0 && items.every(it => this.selectedIds.has(String(it.id)));
      const collapsedClass = tbl.isCollapsed ? 'collapsed' : '';
      const chevron = tbl.isCollapsed ? '▶' : '▼';

      let rowsHtml = '';
      if (filtered.length === 0) {
        const colSpan = this.appMode === 'spotify' ? 10 : 9;
        const msg = items.length === 0 
          ? 'Таблица пуста. Нажмите «+ Добавить» или воспользуйтесь поиском.' 
          : 'Нет записей, соответствующих активным фильтрам.';
        rowsHtml = `<tr><td colspan="${colSpan}" class="empty-user-table-msg">${msg}</td></tr>`;
      } else {
        rowsHtml = filtered.map(it => this.renderTableRow(it)).join('');
      }

      return `
        <div class="user-table-wrapper">
          <div class="user-table-card ${collapsedClass}" data-table-id="${tbl.id}">
            <div class="user-table-header">
              <div class="user-table-title-group" style="display:flex; align-items:center; gap:8px;">
                <button class="table-collapse-btn" onclick="App.toggleTableCollapse('${tbl.id}')" title="Свернуть / Развернуть">${chevron}</button>
                <span class="user-table-title" onclick="App.promptRenameTable('${tbl.id}')" title="Нажмите, чтобы переименовать">
                  ${this.escapeHtml(tbl.name)}
                  <span style="font-size:11px; opacity:0.5; margin-left:4px;">✏</span>
                </span>
                <span class="user-table-count-badge">${items.length} ${this.formatRecordsWord(items.length)}</span>
              </div>

              <div class="user-table-actions">
                <label class="table-select-all-label" title="Выбрать или снять выбор со всех записей этой таблицы">
                  <input type="checkbox" ${isAllSelected ? 'checked' : ''} onchange="App.selectAllInTable('${tbl.id}', this.checked)">
                  Выбрать все в таблице
                </label>

                <button class="btn-table-add-circle" onclick="App.openAddForTable('${tbl.id}')" title="Добавить запись в эту таблицу">
                  +
                </button>
              </div>
            </div>

            <div class="user-table-body">
              <div class="table-responsive">
                <table class="records-table">
                  <thead>
                    ${this.getTableHeadHtml(tbl.id, isAllSelected)}
                  </thead>
                  <tbody id="userTableBody-${tbl.id}">
                    ${rowsHtml}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          ${tbl.isCollapsed ? `
            <button type="button" class="btn-delete-table-outside" onclick="App.deleteTable('${tbl.id}')" title="Удалить свернутую таблицу «${this.escapeHtml(tbl.name)}»">
              🗑
            </button>
          ` : ''}
        </div>
      `;
    }).join('');

    this.updateSelectionToolbar();
  },

  getTableHeadHtml(tableId, isAllSelected) {
    if (this.appMode === 'spotify') {
      return `
        <tr>
          <th class="cell-checkbox">
            <input type="checkbox" ${isAllSelected ? 'checked' : ''} onchange="App.selectAllInTable('${tableId}', this.checked)" title="Выбрать все в этой таблице">
          </th>
          <th class="cell-cover">Обложка</th>
          <th class="sortable" onclick="App.setSort('title')">
            Название песни &amp; Артист${this.getSortIndicator('title')}
          </th>
          <th class="sortable" onclick="App.setSort('album')">
            Альбом${this.getSortIndicator('album')}
          </th>
          <th class="sortable" onclick="App.setSort('durationMs')">
            Длительность${this.getSortIndicator('durationMs')}
          </th>
          <th style="text-align:center;">Превью</th>
          <th class="sortable" onclick="App.setSort('rating')">
            Оценка${this.getSortIndicator('rating')}
          </th>
          <th class="sortable" onclick="App.setSort('isHighValue')">
            Ценность${this.getSortIndicator('isHighValue')}
          </th>
          <th class="sortable" onclick="App.setSort('status')">
            Статус${this.getSortIndicator('status')}
          </th>
          <th class="sortable cell-date" onclick="App.setSort('createdAt')">
            Добавлен${this.getSortIndicator('createdAt')}
          </th>
          <th style="text-align: right;">Действия</th>
        </tr>
      `;
    } else if (this.appMode === 'albums') {
      return `
        <tr>
          <th class="cell-checkbox">
            <input type="checkbox" ${isAllSelected ? 'checked' : ''} onchange="App.selectAllInTable('${tableId}', this.checked)" title="Выбрать все в этой таблице">
          </th>
          <th class="cell-cover">Обложка</th>
          <th class="sortable" onclick="App.setSort('artist')">
            Исполнитель и Альбом${this.getSortIndicator('artist')}
          </th>
          <th class="sortable" onclick="App.setSort('year')">
            Год выпуска${this.getSortIndicator('year')}
          </th>
          <th class="sortable" onclick="App.setSort('versionsCount')">
            Виниловые издания${this.getSortIndicator('versionsCount')}
          </th>
          <th class="sortable" onclick="App.setSort('rating')">
            Оценка${this.getSortIndicator('rating')}
          </th>
          <th class="sortable" onclick="App.setSort('isHighValue')">
            Ценность${this.getSortIndicator('isHighValue')}
          </th>
          <th class="sortable" onclick="App.setSort('status')">
            Статус${this.getSortIndicator('status')}
          </th>
          <th class="sortable cell-date" onclick="App.setSort('createdAt')">
            Добавлен${this.getSortIndicator('createdAt')}
          </th>
          <th style="text-align: right;">Действия</th>
        </tr>
      `;
    } else {
      return `
        <tr>
          <th class="cell-checkbox">
            <input type="checkbox" ${isAllSelected ? 'checked' : ''} onchange="App.selectAllInTable('${tableId}', this.checked)" title="Выбрать все в этой таблице">
          </th>
          <th class="cell-cover">Обложка</th>
          <th class="sortable" onclick="App.setSort('artist')">
            Исполнитель и Альбом${this.getSortIndicator('artist')}
          </th>
          <th class="sortable" onclick="App.setSort('year')">
            Год / Страна${this.getSortIndicator('year')}
          </th>
          <th class="sortable" onclick="App.setSort('priceMedian')">
            Цены (Медиана / Мин-Макс)${this.getSortIndicator('priceMedian')}
          </th>
          <th class="sortable" onclick="App.setSort('rating')">
            Оценка${this.getSortIndicator('rating')}
          </th>
          <th class="sortable" onclick="App.setSort('isHighValue')">
            Ценность${this.getSortIndicator('isHighValue')}
          </th>
          <th class="sortable" onclick="App.setSort('status')">
            Статус${this.getSortIndicator('status')}
          </th>
          <th class="sortable cell-date" onclick="App.setSort('createdAt')">
            Добавлен${this.getSortIndicator('createdAt')}
          </th>
          <th style="text-align: right;">Действия</th>
        </tr>
      `;
    }
  },

  filterAndSortItems(items) {
    const isSpotify = this.appMode === 'spotify';
    const isAlbums = this.appMode === 'albums';

    let filtered = items.filter(r => {
      // Status filter (Toolbar filter + Advanced panel filter)
      const itemStatus = this.getStatusInfo(r.status).status;
      if (this.filterStatus && this.filterStatus !== 'all') {
        if (itemStatus !== this.filterStatus) return false;
      }
      if (this.filters.status && this.filters.status.size > 0 && this.filters.status.size < 4) {
        if (!this.filters.status.has(itemStatus)) return false;
      }

      // High value only
      if (this.filters.highValueOnly && !r.isHighValue) return false;

      // Rating filter
      if (this.filters.ratings.size > 0 && this.filters.ratings.size < 5) {
        const ratingVal = Number(r.rating) || 0;
        if (ratingVal === 0) return false;
        const floorVal = Math.floor(ratingVal);
        const ceilVal = Math.ceil(ratingVal);
        if (!this.filters.ratings.has(floorVal) && !this.filters.ratings.has(ceilVal)) return false;
      }

      // Year range filter
      const yrVal = r.year || (r.releaseDate ? r.releaseDate.substring(0, 4) : null);
      const yr = parseInt(yrVal, 10);
      if (!isNaN(yr)) {
        if (this.filters.yearMin !== null && yr < this.filters.yearMin) return false;
        if (this.filters.yearMax !== null && yr > this.filters.yearMax) return false;
      } else if (this.filters.yearMin !== null || this.filters.yearMax !== null) {
        return false;
      }

      // Metric range filter
      if (isSpotify) {
        const durSec = Math.round((Number(r.durationMs) || 0) / 1000);
        if (this.filters.metricMin !== null && durSec < this.filters.metricMin) return false;
        if (this.filters.metricMax !== null && durSec > this.filters.metricMax) return false;
      } else if (isAlbums) {
        const vc = Number(r.versionsCount) || 0;
        if (this.filters.metricMin !== null && vc < this.filters.metricMin) return false;
        if (this.filters.metricMax !== null && vc > this.filters.metricMax) return false;
      } else {
        const pm = Number(r.priceMedian || r.priceMin) || 0;
        if (this.filters.metricMin !== null && pm < this.filters.metricMin) return false;
        if (this.filters.metricMax !== null && pm > this.filters.metricMax) return false;
      }

      // Country filter
      if (!isSpotify && this.filters.countries.size > 0) {
        const c = r.country || 'Не указана';
        if (!this.filters.countries.has(c)) return false;
      }

      // Text search
      if (this.tableSearchQuery) {
        const str = `${r.artist || ''} ${r.title || ''} ${r.album || ''} ${r.year || r.releaseDate || ''} ${r.country || ''} ${r.notes || ''}`.toLowerCase();
        if (!str.includes(this.tableSearchQuery)) return false;
      }

      return true;
    });

    filtered.sort((a, b) => {
      let valA = a[this.sortCol];
      let valB = b[this.sortCol];

      if (this.sortCol === 'isHighValue') {
        valA = a.isHighValue ? 1 : 0;
        valB = b.isHighValue ? 1 : 0;
      } else if (this.sortCol === 'rating') {
        valA = Number(a.rating) || 0;
        valB = Number(b.rating) || 0;
      } else if (this.sortCol === 'priceMedian') {
        valA = Number(a.priceMedian || a.priceMin) || 0;
        valB = Number(b.priceMedian || b.priceMin) || 0;
      } else if (this.sortCol === 'versionsCount' || this.sortCol === 'durationMs') {
        valA = Number(valA) || 0;
        valB = Number(valB) || 0;
      } else if (this.sortCol === 'year') {
        valA = parseInt(valA || a.releaseDate, 10) || 0;
        valB = parseInt(valB || b.releaseDate, 10) || 0;
      } else if (this.sortCol === 'status') {
        const order = { 'buy': 1, 'take': 2, 'replace': 3, 'owned': 4 };
        valA = order[this.getStatusInfo(a.status).status] || 99;
        valB = order[this.getStatusInfo(b.status).status] || 99;
      } else if (this.sortCol === 'createdAt') {
        valA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        valB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      } else if (typeof valA === 'string') {
        valA = valA.toLowerCase();
        valB = (valB || '').toLowerCase();
      }

      if (valA < valB) return this.sortAsc ? -1 : 1;
      if (valA > valB) return this.sortAsc ? 1 : -1;
      return 0;
    });

    return filtered;
  },

  renderTableRow(item) {
    const isSelected = this.selectedIds.has(String(item.id));
    if (this.appMode === 'spotify') {
      return this.renderSpotifyRow(item, isSelected);
    } else if (this.appMode === 'albums') {
      return this.renderAlbumRow(item, isSelected);
    } else {
      return this.renderReleaseRow(item, isSelected);
    }
  },

  renderSpotifyRow(t, isSelected) {
    const coverUrl = t.coverImage;
    const spotifyLink = t.spotifyUrl || (t.id ? `https://open.spotify.com/track/${t.id}` : null);

    const playBtn = t.previewUrl
      ? `<button class="preview-audio-btn" onclick="App.playAudio('${this.escapeHtml(t.previewUrl)}', '${this.escapeHtml(t.title)}', '${this.escapeHtml(t.artist)}', '${this.escapeHtml(coverUrl || '')}', this)" title="Слушать 30-сек аудио превью">▶</button>`
      : '<span style="color:var(--text-muted); font-size:11px;">—</span>';

    return `
      <tr id="record-row-${t.id}" class="${isSelected ? 'selected-row' : ''}">
        <td class="cell-checkbox">
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="App.toggleSelectRecord('${t.id}', this.checked)">
        </td>
        <td class="cell-cover">
          <div class="cover-thumb-wrapper" onclick="App.openLightbox('${coverUrl || ''}')">
            ${coverUrl ? `<img src="${this.escapeHtml(coverUrl)}" alt="Cover" loading="lazy">` : `<div class="cover-placeholder">TRACK</div>`}
          </div>
        </td>
        <td class="artist-album-col">
          <div class="record-artist" style="font-weight:700; color:var(--text-primary); font-size:13.5px;">
            <a href="javascript:void(0)" onclick="App.openAlbumTracklistModal('${t.id}')" class="clickable-album-title" title="Нажмите, чтобы открыть треклист альбома">${this.escapeHtml(t.title || 'Без названия')}</a>
          </div>
          <div class="record-title" style="font-size:12px; color:var(--text-secondary);">
            ${this.escapeHtml(t.artist || 'Неизвестный исполнитель')}
          </div>
        </td>
        <td>
          <div class="spotify-track-album" title="${this.escapeHtml(t.album || '')}">
            ${t.album ? `<a href="javascript:void(0)" onclick="App.openAlbumTracklistModal('${t.id}')" class="clickable-album-title" title="Нажмите, чтобы открыть треклист альбома">${this.escapeHtml(t.album)}</a>` : '<span style="color:var(--text-muted)">—</span>'}
          </div>
        </td>
        <td>
          <span class="track-duration-pill">⏱ ${t.durationStr || '—'}</span>
        </td>
        <td style="text-align:center;">
          ${playBtn}
        </td>
        <td>
          ${this.renderStarRating(t)}
        </td>
        <td>
          ${this.renderHighValueBadge(t)}
        </td>
        <td>
          ${this.renderStatusPill(t)}
        </td>
        <td class="cell-date">
          ${this.formatCompactDateTime(t.createdAt)}
        </td>
        <td style="text-align: right;">
          <div class="row-actions" style="justify-content: flex-end;">
            ${spotifyLink ? `
              <a href="${spotifyLink}" target="_blank" rel="noopener noreferrer" class="icon-btn" title="Открыть в Spotify">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--accent-theme)"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
              </a>
            ` : ''}
            <button class="icon-btn" onclick="App.promptMoveItem('${t.id}')" title="Переместить в другую таблицу">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
            </button>
            <button class="icon-btn" onclick="App.openEditRecordModal('${t.id}')" title="Редактировать песню">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
            </button>
            <button class="icon-btn danger" onclick="App.deleteSpotifyTrack('${t.id}')" title="Удалить песню">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  renderAlbumRow(a, isSelected) {
    const coverUrl = a.coverImage || a.thumb;
    const discogsLink = a.uri || `https://www.discogs.com/master/${a.masterId}`;

    const countText = a.versionsCount !== null && a.versionsCount !== undefined
      ? `${a.versionsCount} виниловых изданий`
      : 'Посмотреть издания';

    return `
      <tr id="record-row-${a.id}" class="${isSelected ? 'selected-row' : ''}">
        <td class="cell-checkbox">
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="App.toggleSelectRecord('${a.id}', this.checked)">
        </td>
        <td class="cell-cover">
          <div class="cover-thumb-wrapper" onclick="App.openLightbox('${coverUrl || ''}')">
            ${coverUrl ? `<img src="${this.escapeHtml(coverUrl)}" alt="Cover" loading="lazy">` : `<div class="cover-placeholder">ALBUM</div>`}
          </div>
        </td>
        <td class="artist-album-col">
          <div class="record-artist">${this.escapeHtml(a.artist || 'Неизвестный исполнитель')}</div>
          <div class="record-title">
            <a href="javascript:void(0)" onclick="App.openAlbumTracklistModal('${a.id}')" class="clickable-album-title" title="Нажмите, чтобы просмотреть треклист альбома">${this.escapeHtml(a.title || 'Без названия')}</a>
            <a href="${discogsLink}" target="_blank" rel="noopener noreferrer" class="external-discogs-link" title="Открыть на Discogs">↗</a>
          </div>
        </td>
        <td>
          ${a.year ? `<span class="meta-badge">${this.escapeHtml(a.year)}</span>` : '<span style="color:var(--text-muted)">—</span>'}
        </td>
        <td>
          <button class="editions-badge-btn" onclick="App.openMasterVersionsModal(${a.masterId}, '${this.escapeHtml(a.artist)}', '${this.escapeHtml(a.title)}', '${a.year || ''}', '${this.escapeHtml(coverUrl || '')}')" title="Нажмите, чтобы открыть все виниловые прессы этого альбома">
            💿 ${countText} 🔍
          </button>
        </td>
        <td>
          ${this.renderStarRating(a)}
        </td>
        <td>
          ${this.renderHighValueBadge(a)}
        </td>
        <td>
          ${this.renderStatusPill(a)}
        </td>
        <td class="cell-date">
          ${this.formatCompactDateTime(a.createdAt)}
        </td>
        <td style="text-align: right;">
          <div class="row-actions" style="justify-content: flex-end;">
            <a href="${discogsLink}" target="_blank" rel="noopener noreferrer" class="icon-btn" title="Открыть на Discogs">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </a>
            <button class="icon-btn" onclick="App.promptMoveItem('${a.id}')" title="Переместить в другую таблицу">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
            </button>
            <button class="icon-btn" onclick="App.openEditRecordModal('${a.id}')" title="Редактировать альбом">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
            </button>
            <button class="icon-btn danger" onclick="App.deleteAlbum('${a.id}')" title="Удалить">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  renderReleaseRow(r, isSelected) {
    const coverUrl = r.coverImage || r.thumb;
    
    let medianStr = '—';
    if (r.priceMedian) {
      medianStr = `$${Number(r.priceMedian).toFixed(2)}`;
    } else if (r.priceMin) {
      medianStr = `от $${Number(r.priceMin).toFixed(2)}`;
    }

    const minStr = r.priceMin ? `$${Number(r.priceMin).toFixed(2)}` : '—';
    const maxStr = r.priceMax ? `$${Number(r.priceMax).toFixed(2)}` : '—';

    let rangeSub = '';
    if (r.minSold || r.medianSold || r.maxSold) {
      const minS = r.minSold ? `$${Math.round(r.minSold)}` : minStr;
      const medS = r.medianSold ? `$${Math.round(r.medianSold)}` : medianStr;
      const maxS = r.maxSold ? `$${Math.round(r.maxSold)}` : maxStr;
      rangeSub = `<div class="price-range" title="Продажи (мин / медиана / макс)">Продажи: ${minS} / ${medS} / ${maxS}</div>`;
    } else if (r.priceMin && r.priceMax) {
      rangeSub = `<div class="price-range">мин ${minStr} · макс ${maxStr}</div>`;
    } else if (r.numForSale) {
      rangeSub = `<div class="price-range">в продаже: ${r.numForSale} шт.</div>`;
    }

    const discogsLink = r.uri || (r.discogsId ? `https://www.discogs.com/release/${r.discogsId}` : null);

    return `
      <tr id="record-row-${r.id}" class="${isSelected ? 'selected-row' : ''}">
        <td class="cell-checkbox">
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="App.toggleSelectRecord('${r.id}', this.checked)">
        </td>
        <td class="cell-cover">
          <div class="cover-thumb-wrapper" onclick="App.openLightbox('${coverUrl || ''}')">
            ${coverUrl ? `<img src="${this.escapeHtml(coverUrl)}" alt="Cover" loading="lazy">` : `<div class="cover-placeholder">VINYL</div>`}
          </div>
        </td>
        <td class="artist-album-col">
          <div class="record-artist">${this.escapeHtml(r.artist || 'Неизвестный исполнитель')}</div>
          <div class="record-title">
            <a href="javascript:void(0)" onclick="App.openAlbumTracklistModal('${r.id}')" class="clickable-album-title" title="Нажмите, чтобы просмотреть треклист альбома">${this.escapeHtml(r.title || 'Без названия')}</a>
            ${discogsLink ? `<a href="${discogsLink}" target="_blank" rel="noopener noreferrer" class="external-discogs-link" title="Открыть на Discogs">↗</a>` : ''}
          </div>
        </td>
        <td>
          <div class="meta-badge-group">
            ${r.year ? `<span class="meta-badge">${this.escapeHtml(r.year)}</span>` : ''}
            ${r.country ? `<span class="meta-badge">${this.escapeHtml(r.country)}</span>` : ''}
            ${r.format ? `<span class="meta-badge" title="${this.escapeHtml(r.format)}">${this.escapeHtml(r.format.split(',')[0])}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="price-box">
            <div class="price-median">${medianStr}</div>
            ${rangeSub}
          </div>
        </td>
        <td>
          ${this.renderStarRating(r)}
        </td>
        <td>
          ${this.renderHighValueBadge(r)}
        </td>
        <td>
          ${this.renderStatusPill(r)}
        </td>
        <td class="cell-date">
          ${this.formatCompactDateTime(r.createdAt)}
        </td>
        <td style="text-align: right;">
          <div class="row-actions" style="justify-content: flex-end;">
            ${discogsLink ? `
              <a href="${discogsLink}" target="_blank" rel="noopener noreferrer" class="icon-btn" title="Открыть на Discogs">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              </a>
            ` : ''}
            <button class="icon-btn" onclick="App.promptMoveItem('${r.id}')" title="Переместить в другую таблицу">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
            </button>
            <button class="icon-btn" onclick="App.openEditRecordModal('${r.id}')" title="Редактировать">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
            </button>
            <button class="icon-btn danger" onclick="App.deleteRecord('${r.id}')" title="Удалить">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  formatRecordsWord(n) {
    if (this.appMode === 'spotify') {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod100 >= 11 && mod100 <= 19) return 'песен';
      if (mod10 === 1) return 'песня';
      if (mod10 >= 2 && mod10 <= 4) return 'песни';
      return 'песен';
    } else if (this.appMode === 'albums') {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod100 >= 11 && mod100 <= 19) return 'альбомов';
      if (mod10 === 1) return 'альбом';
      if (mod10 >= 2 && mod10 <= 4) return 'альбома';
      return 'альбомов';
    } else {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod100 >= 11 && mod100 <= 19) return 'пластинок';
      if (mod10 === 1) return 'пластинка';
      if (mod10 >= 2 && mod10 <= 4) return 'пластинки';
      return 'пластинок';
    }
  },

  formatCompactDateTime(isoStr) {
    if (!isoStr) return '<span style="color:var(--text-muted); font-size:11px;">—</span>';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return '<span style="color:var(--text-muted); font-size:11px;">—</span>';
      const pad = n => (n < 10 ? '0' : '') + n;
      const day = pad(d.getDate());
      const month = pad(d.getMonth() + 1);
      const year = String(d.getFullYear()).slice(-2);
      const hours = pad(d.getHours());
      const mins = pad(d.getMinutes());
      return `<span class="compact-date-badge" title="${d.toLocaleString()}">${day}.${month}.${year} ${hours}:${mins}</span>`;
    } catch (e) {
      return '<span style="color:var(--text-muted); font-size:11px;">—</span>';
    }
  },

  formatNotes(notes) {
    if (!notes) return '<span style="color:var(--text-muted)">—</span>';
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return this.escapeHtml(notes).replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">Ссылка ↗</a>`;
    });
  },

  toggleSelectRecord(id, isChecked) {
    if (isChecked) {
      this.selectedIds.add(String(id));
    } else {
      this.selectedIds.delete(String(id));
    }
    const row = document.getElementById(`record-row-${id}`);
    if (row) {
      if (isChecked) row.classList.add('selected-row');
      else row.classList.remove('selected-row');
    }
    this.updateSelectionToolbar();
  },

  updateSelectionToolbar() {
    const count = this.selectedIds.size;
    const btnSyncSelected = document.getElementById('btnSyncSelectedRecords');
    if (btnSyncSelected) {
      btnSyncSelected.textContent = count > 0 ? `Перенести выбранные в Discogs (${count})` : 'Перенести в Discogs';
    }
    const btnTransferSpotify = document.getElementById('btnTransferToSpotify');
    if (btnTransferSpotify) {
      btnTransferSpotify.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg> ${count > 0 ? `Перенести выбранные в Spotify (${count})` : 'Перенести в Spotify'}`;
    }
  },

  getStatusInfo(status) {
    const s = status || 'buy';
    if (s === 'take' || s === 'planned') {
      return { status: 'take', class: 'take', label: 'Взять' };
    }
    if (s === 'replace') {
      return { status: 'replace', class: 'replace', label: 'Заменить' };
    }
    if (s === 'owned' || s === 'playlist') {
      return { status: 'owned', class: 'owned', label: 'В наличии' };
    }
    return { status: 'buy', class: 'buy', label: 'Купить' };
  },

  renderStatusPill(item) {
    const info = this.getStatusInfo(item.status);
    const curStatus = info.status;
    return `
      <div class="status-cell-container" id="status-container-${item.id}">
        <span class="status-pill ${info.class}" onclick="App.toggleStatusMenu('${item.id}', event)" title="Нажмите, чтобы выбрать статус">
          ${info.label} <span class="status-pill-arrow">▾</span>
        </span>
        <div class="status-menu-popover" id="status-menu-${item.id}" onclick="event.stopPropagation()">
          <div class="status-menu-item ${curStatus === 'buy' ? 'selected' : ''}" onclick="App.setStatusDirectly('${item.id}', 'buy')">
            <span class="status-menu-dot buy"></span> 🔵 Купить
          </div>
          <div class="status-menu-item ${curStatus === 'take' ? 'selected' : ''}" onclick="App.setStatusDirectly('${item.id}', 'take')">
            <span class="status-menu-dot take"></span> 🟣 Взять
          </div>
          <div class="status-menu-item ${curStatus === 'replace' ? 'selected' : ''}" onclick="App.setStatusDirectly('${item.id}', 'replace')">
            <span class="status-menu-dot replace"></span> 🟠 Заменить
          </div>
          <div class="status-menu-item ${curStatus === 'owned' ? 'selected' : ''}" onclick="App.setStatusDirectly('${item.id}', 'owned')">
            <span class="status-menu-dot owned"></span> 🟢 В наличии
          </div>
        </div>
      </div>
    `;
  },

  toggleStatusMenu(itemId, event) {
    if (event) event.stopPropagation();
    const popover = document.getElementById(`status-menu-${itemId}`);
    const isOpen = popover && popover.classList.contains('open');
    document.querySelectorAll('.status-menu-popover.open').forEach(p => p.classList.remove('open'));
    if (popover && !isOpen) {
      popover.classList.add('open');
    }
  },

  async setStatusDirectly(itemId, newStatus) {
    document.querySelectorAll('.status-menu-popover.open').forEach(p => p.classList.remove('open'));
    const found = this.findTableAndItem(itemId, this.appMode);
    let item = found ? found.item : null;
    if (!item) {
      const list = this.appMode === 'spotify' ? this.spotifyTracks : (this.appMode === 'albums' ? this.albums : this.records);
      item = list.find(x => String(x.id) === String(itemId));
    }
    if (!item) return;

    item.status = newStatus;
    this.saveModeTables();
    if (this.appMode === 'releases') {
      await FirebaseSync.saveRecord(item);
    }
    this.render();
  },

  async cycleStatus(id) {
    const found = this.findTableAndItem(id, this.appMode);
    if (!found) return;
    const item = found.item;

    const curr = this.getStatusInfo(item.status).status;
    if (curr === 'buy') {
      item.status = 'take';
    } else if (curr === 'take') {
      item.status = 'replace';
    } else if (curr === 'replace') {
      item.status = 'owned';
    } else {
      item.status = 'buy';
    }

    this.saveModeTables();
    if (this.appMode === 'releases') {
      await FirebaseSync.saveRecord(item);
    }
    this.render();
  },

  deleteSpotifyTrack(id) {
    const found = this.findTableAndItem(id, 'spotify');
    const title = found ? `${found.item.artist} - ${found.item.title}` : 'этот трек';
    if (!confirm(`Удалить ${title} из списка песен Spotify?`)) return;

    this.deleteItemFromMode(id, 'spotify');
    this.render();
  },

  async deleteRecord(id) {
    const found = this.findTableAndItem(id, 'releases');
    const title = found ? `${found.item.artist} - ${found.item.title}` : 'эту пластинку';
    if (!confirm(`Удалить ${title} из списка?`)) return;

    await FirebaseSync.deleteRecord(id);
    this.deleteItemFromMode(id, 'releases');
    this.render();
  },

  deleteAlbum(id) {
    const found = this.findTableAndItem(id, 'albums');
    const title = found ? `${found.item.artist} - ${found.item.title}` : 'этот альбом';
    if (!confirm(`Удалить ${title} из каталога альбомов?`)) return;

    this.deleteItemFromMode(id, 'albums');
    this.render();
  },

  // ----------------------------------------------------
  // MASTER ALBUM VERSIONS BREAKDOWN MODAL
  // Lists all vinyl pressings with country, year, format, prices
  // ----------------------------------------------------
  async openMasterVersionsModal(masterId, artist, title, year, coverUrl) {
    const modal = document.getElementById('masterVersionsModal');
    const headerTitle = document.getElementById('masterModalTitle');
    const headerSub = document.getElementById('masterModalSub');
    const coverImg = document.getElementById('masterModalCover');
    const versionsBody = document.getElementById('masterVersionsBody');
    const countryFilter = document.getElementById('masterCountryFilter');

    if (!modal) return;

    this.currentMasterModalData = { masterId, artist, title, year, coverUrl, allVersions: [] };

    if (headerTitle) headerTitle.textContent = `${artist} — ${title}`;
    if (headerSub) headerSub.textContent = `Оригинальный выпуск: ${year || '—'} · Загрузка виниловых изданий с Discogs...`;
    if (coverImg) coverImg.src = coverUrl || '';
    if (versionsBody) {
      versionsBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--accent-theme);">Загрузка всех виниловых изданий из базы Discogs...</td></tr>`;
    }

    modal.classList.add('open');

    try {
      const data = await DiscogsClient.getMasterVersions(masterId, 1, 100);
      const versions = data.versions || [];
      const totalCount = data.pagination ? data.pagination.items : versions.length;

      this.currentMasterModalData.allVersions = versions;

      if (headerSub) {
        headerSub.innerHTML = `Оригинальный выпуск: <strong>${year || '—'}</strong> · Всего виниловых прессов на Discogs: <strong style="color:var(--accent-theme);">${totalCount}</strong>`;
      }

      // Populate Country filter options
      if (countryFilter) {
        const countries = new Set();
        versions.forEach(v => { if (v.country) countries.add(v.country); });
        countryFilter.innerHTML = '<option value="">Все страны выпуска</option>' + 
          Array.from(countries).sort().map(c => `<option value="${this.escapeHtml(c)}">${this.escapeHtml(c)}</option>`).join('');
      }

      this.renderMasterVersionsTable(versions);

    } catch (err) {
      if (versionsBody) {
        versionsBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--danger);">${this.escapeHtml(err.message)}</td></tr>`;
      }
    }
  },

  renderMasterVersionsTable(versions) {
    const versionsBody = document.getElementById('masterVersionsBody');
    if (!versionsBody) return;

    if (this.masterVersionsObserver) {
      this.masterVersionsObserver.disconnect();
      this.masterVersionsObserver = null;
    }
    this.lazyPriceQueue = [];

    if (!versions || versions.length === 0) {
      versionsBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">Виниловых изданий не найдено</td></tr>`;
      return;
    }

    versionsBody.innerHTML = versions.map(v => {
      const thumbUrl = v.thumb;
      const formatStr = Array.isArray(v.major_formats) ? v.major_formats.join(', ') : (v.format || 'Vinyl');
      const labelStr = v.label || '';
      const catnoStr = v.catno || '';
      const discogsUrl = `https://www.discogs.com/release/${v.id}`;

      return `
        <tr id="master-ver-row-${v.id}" class="lazy-price-row" data-release-id="${v.id}">
          <td style="width:40px;">
            ${thumbUrl ? `<img src="${this.escapeHtml(thumbUrl)}" style="width:36px; height:36px; object-fit:cover; border-radius:3px;">` : '<div style="width:36px; height:36px; background:#222; border-radius:3px;"></div>'}
          </td>
          <td>
            <strong>${v.country ? this.escapeHtml(v.country) : '<span style="color:var(--text-muted)">Не указана</span>'}</strong>
          </td>
          <td>
            ${v.released ? `<span class="meta-badge">${this.escapeHtml(v.released)}</span>` : '<span style="color:var(--text-muted)">—</span>'}
          </td>
          <td>
            <div style="font-size:12px;">${this.escapeHtml(formatStr)}</div>
            <div style="font-size:11px; color:var(--text-muted);">${this.escapeHtml(labelStr)} ${catnoStr ? `· ${this.escapeHtml(catnoStr)}` : ''}</div>
          </td>
          <td class="col-price col-price-min" id="ver-min-${v.id}">...</td>
          <td class="col-price col-price-med" id="ver-med-${v.id}">...</td>
          <td class="col-price col-price-max" id="ver-max-${v.id}">...</td>
          <td style="text-align:right;">
            <div style="display:flex; gap:6px; align-items:center; justify-content:flex-end;">
              <a href="${discogsUrl}" target="_blank" rel="noopener noreferrer" class="icon-btn" title="Открыть на Discogs">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              </a>
              <button class="btn btn-sm btn-primary" onclick="App.addSpecificPressingToWishlist(${v.id})">
                + В вишлист
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Setup IntersectionObserver for visible rows
    const scrollContainer = versionsBody.closest('div');
    this.masterVersionsObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const row = entry.target;
          const releaseId = row.getAttribute('data-release-id');
          this.masterVersionsObserver.unobserve(row);
          if (releaseId) {
            this.enqueuePriceLoad(Number(releaseId));
          }
        }
      });
    }, {
      root: scrollContainer || null,
      rootMargin: '80px 0px',
      threshold: 0.05
    });

    document.querySelectorAll('.lazy-price-row').forEach(row => {
      this.masterVersionsObserver.observe(row);
    });
  },

  enqueuePriceLoad(releaseId) {
    if (DiscogsClient.hasPriceInCache(releaseId)) {
      this.loadPriceForVersionRow(releaseId);
      return;
    }
    if (!this.lazyPriceQueue.includes(releaseId)) {
      this.lazyPriceQueue.push(releaseId);
      this.processLazyPriceQueue();
    }
  },

  async processLazyPriceQueue() {
    if (this.isProcessingPriceQueue) return;
    this.isProcessingPriceQueue = true;

    while (this.lazyPriceQueue.length > 0) {
      const releaseId = this.lazyPriceQueue.shift();
      await this.loadPriceForVersionRow(releaseId);
      await new Promise(r => setTimeout(r, 650));
    }

    this.isProcessingPriceQueue = false;
  },

  async loadPriceForVersionRow(releaseId) {
    const elMin = document.getElementById(`ver-min-${releaseId}`);
    const elMed = document.getElementById(`ver-med-${releaseId}`);
    const elMax = document.getElementById(`ver-max-${releaseId}`);

    try {
      const stats = await DiscogsClient.getPriceStats(releaseId);
      if (!elMed) return;

      if (stats && (stats.median !== null && stats.median !== undefined)) {
        if (elMin) elMin.textContent = stats.min ? `$${stats.min}` : '—';
        if (elMed) elMed.textContent = `$${stats.median}`;
        if (elMax) elMax.textContent = stats.max ? `$${stats.max}` : '—';
      } else if (stats && stats.lowest_price) {
        if (elMin) elMin.textContent = `$${stats.lowest_price}`;
        if (elMed) elMed.textContent = `от $${stats.lowest_price}`;
        if (elMax) elMax.textContent = stats.num_for_sale ? `(${stats.num_for_sale} шт)` : '—';
      } else {
        if (elMin) elMin.textContent = '—';
        if (elMed) elMed.textContent = '—';
        if (elMax) elMax.textContent = '—';
      }
    } catch (e) {
      if (elMed) elMed.textContent = '—';
    }
  },

  // Add specific pressing from master modal into releases wishlist
  async addSpecificPressingToWishlist(releaseId) {
    const version = (this.currentMasterModalData?.allVersions || []).find(v => v.id === releaseId);
    if (!version) return;

    const stats = await DiscogsClient.getPriceStats(releaseId);
    const meta = this.currentMasterModalData;

    const formatStr = Array.isArray(version.major_formats) ? version.major_formats.join(', ') : (version.format || 'Vinyl');

    const newRecord = {
      id: `discogs-${version.id}`,
      discogsId: version.id,
      artist: meta.artist,
      title: meta.title,
      year: version.released || meta.year || '',
      country: version.country || '',
      format: formatStr,
      label: version.label || '',
      catno: version.catno || '',
      priceMin: stats && stats.min ? stats.min : (stats && stats.lowest_price ? stats.lowest_price : null),
      priceMedian: stats && stats.median ? stats.median : null,
      priceMax: stats && stats.max ? stats.max : null,
      currency: stats ? stats.currency : 'USD',
      status: 'buy',
      coverImage: version.thumb || meta.coverUrl,
      thumb: version.thumb,
      uri: `https://www.discogs.com/release/${version.id}`,
      notes: `Выбрано издание: ${version.country || ''} (${version.released || ''}) ${version.catno || ''}`,
      createdAt: new Date().toISOString()
    };

    const existing = this.findTableAndItem(newRecord.id, 'releases');
    if (existing) {
      alert(`Это издание «${newRecord.artist} - ${newRecord.title}» уже есть в вашем виниловом вишлисте!`);
      return;
    }

    this.promptDestinationTable(newRecord.title || newRecord.artist, 'releases', (targetTableId) => {
      this.addItemToActiveTable(newRecord, targetTableId, 'releases');
      this.render();
      alert(`✓ Издание (${version.country || 'пресс'} ${version.released || ''}) успешно добавлено в вашу таблицу!`);
    });
  },

  // ----------------------------------------------------
  // Discogs & Spotify Search Modal
  // ----------------------------------------------------
  searchProvider: 'discogs',

  setSearchProvider(provider, executeSearch = true) {
    this.searchProvider = provider === 'spotify' ? 'spotify' : 'discogs';
    const tabDiscogs = document.getElementById('searchTabDiscogs');
    const tabSpotify = document.getElementById('searchTabSpotify');
    const input = document.getElementById('discogsSearchInput');
    const titleEl = document.getElementById('discogsSearchModalTitle');

    if (tabDiscogs) tabDiscogs.classList.toggle('active', this.searchProvider === 'discogs');
    if (tabSpotify) tabSpotify.classList.toggle('active', this.searchProvider === 'spotify');

    if (this.searchProvider === 'spotify') {
      if (titleEl) {
        titleEl.textContent = (this.appMode === 'albums' || this.appMode === 'releases')
          ? 'Поиск альбомов в Spotify'
          : 'Поиск треков в Spotify';
      }
      if (input) {
        input.placeholder = (this.appMode === 'albums' || this.appMode === 'releases')
          ? 'Исполнитель или название альбома в Spotify...'
          : 'Название песни, исполнитель или альбом...';
      }
    } else {
      if (titleEl) {
        titleEl.textContent = this.appMode === 'albums' 
          ? 'Поиск альбомов на Discogs (каждый альбом один раз)' 
          : 'Поиск виниловых пластинок на Discogs';
      }
      if (input) {
        input.placeholder = this.appMode === 'albums'
          ? 'Исполнитель или название альбома...'
          : 'Исполнитель, альбом или название песни...';
      }
    }

    if (tabDiscogs) {
      tabDiscogs.innerHTML = this.appMode === 'albums' 
        ? '💽 Discogs (Альбомы)' 
        : (this.appMode === 'spotify' ? '💽 Каталог Discogs' : '💽 Discogs (Винилы)');
    }
    if (tabSpotify) {
      tabSpotify.innerHTML = '🟢 Spotify (Песни)';
    }

    if (executeSearch && input && input.value.trim()) {
      this.performDiscogsSearch();
    }
  },

  transferSpotifyAlbumToSearch(artist, album) {
    const input = document.getElementById('discogsSearchInput');
    const cleanArtist = (artist || '').trim();
    const cleanAlbum = (album || '').trim();
    const query = cleanArtist && cleanAlbum ? `${cleanArtist} ${cleanAlbum}` : (cleanAlbum || cleanArtist);
    if (input) input.value = query;

    // Switch search provider back to Discogs for finding vinyl records of this album
    this.setSearchProvider('discogs', false);

    // Run vinyl search immediately on Discogs!
    this.performDiscogsSearch();
    this.showToastNotification(`🔍 Ищем винилы альбома «${query}» на Discogs`);
  },

  openDiscogsSearchModal(prefillQuery = '') {
    const modal = document.getElementById('discogsSearchModal');
    const input = document.getElementById('discogsSearchInput');
    const resultsContainer = document.getElementById('discogsSearchResults');

    const defaultProvider = this.appMode === 'spotify' ? 'spotify' : 'discogs';
    this.setSearchProvider(defaultProvider, false);

    if (modal) modal.classList.add('open');

    // Priority for search query:
    // 1. Explicit prefill argument
    // 2. Existing text already in the search input (NEVER auto-clear it if user typed something!)
    // 3. Companion input or table search input
    let query = '';
    if (prefillQuery && prefillQuery.trim()) {
      query = prefillQuery.trim();
    } else if (input && input.value && input.value.trim()) {
      query = input.value.trim();
    } else {
      const compQ = document.getElementById('companionInput')?.value?.trim() || '';
      const tblQ = document.getElementById('tableSearchInput')?.value?.trim() || '';
      query = compQ || tblQ || '';
    }

    if (input) {
      if (query) {
        input.value = query;
      }
      setTimeout(() => input.focus(), 100);
    }

    if (resultsContainer && (!resultsContainer.children.length || !query)) {
      let modeText = 'виниловой пластинки или альбома';
      if (this.appMode === 'spotify' || this.searchProvider === 'spotify') modeText = 'песни';
      resultsContainer.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted)">Нажмите <b>Enter</b> для поиска ${modeText}</div>`;
    }
  },

  closeDiscogsSearchModal() {
    this._explicitTargetTableId = null;
    const modal = document.getElementById('discogsSearchModal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.remove('active');
    }
  },

  isAlbumInLibrary(item) {
    if (!item) return { inLibrary: false };

    const norm = s => (s || '')
      .toLowerCase()
      .replace(/\s*\(\d+\)$/, '') // remove Discogs artist disambiguation like "Artist (2)"
      .replace(/\*+$/, '')        // remove Discogs trailing asterisk
      .replace(/[^a-z0-9а-яёіїєґ]/gi, '')
      .trim();

    let rawArtist = item.artist || '';
    let rawTitle = item.title || item.album || '';
    if (!rawArtist && item.rawTitle && item.rawTitle.includes(' - ')) {
      const parts = item.rawTitle.split(' - ');
      rawArtist = parts[0];
      rawTitle = parts.slice(1).join(' - ');
    }

    const getVariants = str => {
      if (!str) return [];
      const list = [str];
      if (str.includes('=')) {
        str.split('=').forEach(p => list.push(p.trim()));
      }
      return list.map(norm).filter(Boolean);
    };

    const itemArtists = getVariants(rawArtist);
    const itemTitles = getVariants(rawTitle);

    const cleanId = id => String(id || '').replace(/^(master-|discogs-|sp-)/, '').trim();
    const mId = cleanId(item.masterId || item.id || item.discogsId);
    const sId = cleanId(item.spotifyId || item.id);

    // Check in albums tables
    for (const tbl of (this.tables.albums || [])) {
      for (const a of (tbl.items || [])) {
        const aMId = cleanId(a.masterId || a.id || a.discogsId);
        if (mId && aMId && mId === aMId) {
          return { inLibrary: true, table: tbl, item: a, mode: 'albums' };
        }
        const aTitles = getVariants(a.title);
        const titleMatch = itemTitles.some(t => aTitles.includes(t));
        if (titleMatch) {
          const aArtists = getVariants(a.artist);
          if (itemArtists.some(art => aArtists.includes(art)) || (!itemArtists.length && !aArtists.length)) {
            return { inLibrary: true, table: tbl, item: a, mode: 'albums' };
          }
        }
      }
    }

    // Check in releases tables
    for (const tbl of (this.tables.releases || [])) {
      for (const r of (tbl.items || [])) {
        const rId = cleanId(r.discogsId || r.id);
        if (mId && rId && mId === rId) {
          return { inLibrary: true, table: tbl, item: r, mode: 'releases' };
        }
        const rTitles = getVariants(r.title);
        const titleMatch = itemTitles.some(t => rTitles.includes(t));
        if (titleMatch) {
          const rArtists = getVariants(r.artist);
          if (itemArtists.some(art => rArtists.includes(art)) || (!itemArtists.length && !rArtists.length)) {
            return { inLibrary: true, table: tbl, item: r, mode: 'releases' };
          }
        }
      }
    }

    // Check in spotify tables
    for (const tbl of (this.tables.spotify || [])) {
      for (const t of (tbl.items || [])) {
        const tSId = cleanId(t.spotifyId || t.id);
        if (sId && tSId && sId === tSId) {
          return { inLibrary: true, table: tbl, item: t, mode: 'spotify' };
        }
        const tTitles = getVariants(t.title).concat(getVariants(t.album));
        const titleMatch = itemTitles.some(t => tTitles.includes(t));
        if (titleMatch) {
          const tArtists = getVariants(t.artist);
          if (itemArtists.some(art => tArtists.includes(art)) || (!itemArtists.length && !tArtists.length)) {
            return { inLibrary: true, table: tbl, item: t, mode: 'spotify' };
          }
        }
      }
    }

    return { inLibrary: false };
  },

  formatVinylVersions(count) {
    const n = Math.abs(Number(count)) || 0;
    if (n === 0) return '0 виниловых изданий';
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 19) return `${n} виниловых изданий`;
    if (mod10 === 1) return `${n} виниловое издание`;
    if (mod10 >= 2 && mod10 <= 4) return `${n} виниловых издания`;
    return `${n} виниловых изданий`;
  },

  getVinylSortScore(it) {
    if (!it) return 0;
    if (typeof it.versionsCount === 'number' && it.versionsCount >= 0) return it.versionsCount * 100;
    if (it.community && typeof it.community.have === 'number') return it.community.have;
    if (typeof it.popularity === 'number') return it.popularity;
    if (typeof it.num_for_sale === 'number' && it.num_for_sale >= 0) return it.num_for_sale;
    return 0;
  },

  resortDiscogsSearchResults() {
    const resultsContainer = document.getElementById('discogsSearchResults');
    if (!resultsContainer) return;
    const allChildren = Array.from(resultsContainer.children);
    if (allChildren.length <= 1) return;

    const pinnedElements = allChildren.filter(el => 
      el.classList.contains('search-artist-banner') || 
      el.classList.contains('artist-discography-header')
    );
    const cards = allChildren.filter(el => 
      !el.classList.contains('search-artist-banner') && 
      !el.classList.contains('artist-discography-header')
    );

    cards.sort((cardA, cardB) => {
      const aInLib = (cardA.classList.contains('search-item-in-library') || cardA.classList.contains('tracklist-item-added')) ? 1 : 0;
      const bInLib = (cardB.classList.contains('search-item-in-library') || cardB.classList.contains('tracklist-item-added')) ? 1 : 0;
      if (bInLib !== aInLib) return bInLib - aInLib;

      const aId = cardA.getAttribute('data-item-id');
      const bId = cardB.getAttribute('data-item-id');
      const aItem = (this.lastSearchResults || []).find(it => String(it.id) === String(aId) || String(it.masterId) === String(aId));
      const bItem = (this.lastSearchResults || []).find(it => String(it.id) === String(bId) || String(it.masterId) === String(bId));

      const aScore = this.getVinylSortScore(aItem);
      const bScore = this.getVinylSortScore(bItem);
      return bScore - aScore; // Descending: largest to smallest available vinyls
    });

    pinnedElements.forEach(el => resultsContainer.appendChild(el));
    cards.forEach(card => resultsContainer.appendChild(card));
  },

  isAudioPlayingForAlbum(item) {
    if (!this.playingAudio || this.playingAudio.paused) return false;
    if (!this.currentAudioTrackTitle && !this.currentAudioAlbumTitle) return false;
    const norm = s => (s || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
    const itArt = norm(item.artist || item.rawTitle);
    const itTitle = norm(item.title || item.album);
    
    const curArt = norm(this.currentAudioArtist);
    const curTitle = norm(this.currentAudioTrackTitle);
    const curAlb = norm(this.currentAudioAlbumTitle);

    if (curAlb && itTitle && curAlb === itTitle) return true;
    if (itArt && curArt && itArt === curArt) {
      if (itTitle && (itTitle === curTitle || itTitle === curAlb)) return true;
    }
    return false;
  },

  setCoverPulsing(isPulsing) {
    const wrap = document.getElementById('tracklistCoverWrap');
    const stage = document.getElementById('tracklistCoverStage') || document.querySelector('.tracklist-cover-waves-stage');
    if (wrap) {
      if (isPulsing) {
        wrap.classList.add('album-playing-pulse');
      } else {
        wrap.classList.remove('album-playing-pulse');
      }
    }
    if (stage) {
      if (isPulsing) {
        stage.classList.add('playing-waves');
      } else {
        stage.classList.remove('playing-waves');
      }
    }
  },

  updateSearchPlayingHighlights() {
    const isPlaying = Boolean(this.playingAudio && !this.playingAudio.paused);
    const curArtist = (this.currentAudioArtist || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
    const curTitle = (this.currentAudioTrackTitle || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
    const curAlbum = (this.currentAudioAlbumTitle || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');

    // 1. Search modal cards
    document.querySelectorAll('.spotify-album-card, .spotify-track-card, .search-result-item').forEach(card => {
      const art = (card.getAttribute('data-artist') || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
      const alb = (card.getAttribute('data-album') || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');

      let matches = false;
      if (isPlaying && (curTitle || curAlbum)) {
        if (curAlbum && alb && curAlbum === alb) matches = true;
        else if (art && curArtist && art === curArtist) {
          if (alb && (alb === curTitle || alb === curAlbum)) matches = true;
        }
      }

      if (matches) {
        card.classList.add('search-item-now-playing');
        let badge = card.querySelector('.now-playing-album-indicator');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'now-playing-album-indicator';
          badge.textContent = '🔊 Сейчас играет';
          const badgesRow = card.querySelector('.sp-album-badges, .search-tags');
          if (badgesRow) badgesRow.prepend(badge);
        }
      } else {
        card.classList.remove('search-item-now-playing');
        const badge = card.querySelector('.now-playing-album-indicator');
        if (badge) badge.remove();
      }
    });

    // 2. Collection table rows
    document.querySelectorAll('tr[id^="record-row-"]').forEach(row => {
      const artEl = row.querySelector('.record-artist');
      const titleEl = row.querySelector('.record-title, .clickable-album-title');
      const rowArtist = (artEl ? artEl.textContent : '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
      const rowTitle = (titleEl ? titleEl.textContent : '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');

      let matches = false;
      if (isPlaying && (curTitle || curAlbum)) {
        if (curAlbum && rowTitle && (curAlbum === rowTitle || rowTitle.includes(curAlbum))) matches = true;
        else if (curTitle && rowTitle && curTitle === rowTitle) matches = true;
        else if (rowArtist && curArtist && rowArtist === curArtist && (rowTitle === curTitle || rowTitle === curAlbum)) matches = true;
      }

      if (matches) {
        row.classList.add('table-row-now-playing');
      } else {
        row.classList.remove('table-row-now-playing');
      }
    });

    // 3. Album cover pulsation in modal
    this.setCoverPulsing(isPlaying);
  },

  dualSearchActive: false,

  toggleDualSearch() {
    this.dualSearchActive = !this.dualSearchActive;
    const btn = document.getElementById('btnDualSearchLink');
    if (btn) {
      if (this.dualSearchActive) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
    const input = document.getElementById('discogsSearchInput');
    if (input && input.value.trim()) {
      this.performDiscogsSearch();
    }
  },

  async toggleSearchVersionsDrawer(itemId, masterId) {
    const drawer = document.getElementById(`search-versions-drawer-${itemId}`);
    if (!drawer) return;
    if (drawer.style.display === 'block') {
      drawer.style.display = 'none';
      return;
    }
    drawer.style.display = 'block';
    drawer.innerHTML = '<div style="color:var(--accent-theme); text-align:center; padding:10px;">⏳ Загрузка вариантов виниловых изданий...</div>';

    try {
      const qId = masterId || itemId;
      const data = await DiscogsClient.getMasterVersions(qId);
      const versions = (data && data.versions) || [];
      if (versions.length === 0) {
        drawer.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:8px;">Варианты виниловых изданий не найдены.</div>';
        return;
      }
      drawer.innerHTML = `
        <div style="font-weight:700; color:var(--accent-theme); margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
          <span>💽 Доступные виниловые издания (${versions.length}):</span>
          <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('search-versions-drawer-${itemId}').style.display='none'" style="font-size:10px; padding:1px 6px;">✕ Закрыть</button>
        </div>
        <div class="search-versions-grid">
          ${versions.slice(0, 35).map(v => {
            const formatStr = Array.isArray(v.major_formats) ? v.major_formats.join(', ') : (v.format || 'Vinyl');
            const catNo = v.catno || '—';
            return `
              <div class="search-version-row">
                <div class="search-version-meta">
                  <span style="font-weight:700; color:#fff;">${this.escapeHtml(v.country || 'Все страны')}</span>
                  <span style="color:var(--text-muted);">·</span>
                  <span>${this.escapeHtml(v.released || v.year || '—')}</span>
                  <span style="color:var(--text-muted);">·</span>
                  <span style="color:var(--accent-theme);">${this.escapeHtml(v.label || '—')}</span>
                  <span style="color:var(--text-muted); font-size:10px;">(${this.escapeHtml(catNo)})</span>
                  <span class="badge" style="font-size:10px;">${this.escapeHtml(formatStr)}</span>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" style="font-size:10.5px; padding:2px 8px;" onclick="App.addRecordFromDiscogs(${v.id})">
                  + В вишлист
                </button>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } catch (err) {
      drawer.innerHTML = `<div style="color:var(--danger); text-align:center; padding:8px;">Ошибка загрузки: ${this.escapeHtml(err.message)}</div>`;
    }
  },

  async performDiscogsSearch() {
    const input = document.getElementById('discogsSearchInput');
    const resultsContainer = document.getElementById('discogsSearchResults');
    if (!input || !resultsContainer) return;

    const q = input.value.trim();
    if (!q) return;

    const isSpotify = this.searchProvider === 'spotify';
    const isAlbumsSearch = isSpotify ? (this.appMode === 'albums' || this.appMode === 'releases') : (this.appMode === 'albums');
    const serviceName = isSpotify ? 'Spotify' : 'Discogs';

    try {
      if (this.dualSearchActive) {
        resultsContainer.innerHTML = `<div style="text-align:center; padding:30px; color:var(--accent-theme)">Объединенный поиск (Discogs 💽 + Spotify 🟢)...</div>`;
        const [artistRes, discogsData, spotifyData] = await Promise.all([
          DiscogsClient.searchArtist(q).catch(() => null),
          (this.appMode === 'albums' ? DiscogsClient.searchAlbums(q, 1, 20) : DiscogsClient.searchVinyl(q, 1, 20)).catch(() => ({ results: [] })),
          SpotifyClient.searchTracks(q, 20).catch(() => ({ results: [] }))
        ]);
        const matchedArtist = artistRes;
        this.currentSearchArtist = matchedArtist;
        const discogsResults = (discogsData && discogsData.results) || [];
        const spotifyResults = (spotifyData && spotifyData.results) || [];

        let artistBannerHtml = '';
        if (matchedArtist) {
          const safeArtistName = this.escapeHtml(matchedArtist.name);
          const safeArtistThumb = this.escapeHtml(matchedArtist.thumb || '');
          const transferArt = safeArtistName.replace(/'/g, "\\'");
          const transferThumb = safeArtistThumb.replace(/'/g, "\\'");
          artistBannerHtml = `
            <div class="search-artist-banner" onclick="App.showArtistAlbums(${matchedArtist.id}, '${transferArt}', '${transferThumb}')" title="Нажмите, чтобы открыть все виниловые издания ${safeArtistName}">
              <div class="search-artist-banner-left">
                <div class="search-artist-avatar-wrap">
                  <img src="${matchedArtist.thumb || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'52\' height=\'52\' fill=\'%23222\'><circle cx=\'26\' cy=\'26\' r=\'26\'/></svg>'}" class="search-artist-avatar" alt="${safeArtistName}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'52\' height=\'52\' fill=\'%23222\'><circle cx=\'26\' cy=\'26\' r=\'26\'/></svg>'">
                </div>
                <div class="search-artist-banner-meta">
                  <span class="search-artist-tag">🎤 ИСПОЛНИТЕЛЬ</span>
                  <div class="search-artist-name">${safeArtistName}</div>
                  <div class="search-artist-sub">Виниловые издания · Нажмите, чтобы открыть все винилы ➔</div>
                </div>
              </div>
              <div class="search-artist-banner-right">
                <button type="button" class="btn btn-sm btn-primary search-artist-btn">
                  Смотреть все винилы ➔
                </button>
              </div>
            </div>
          `;
        }

        const dColHtml = discogsResults.length === 0 ? '<div style="color:var(--text-muted); text-align:center; padding:20px;">Ничего не найдено в Discogs</div>' : discogsResults.map(item => {
          const coverImg = item.thumb || item.coverImage;
          const libInfo = this.isAlbumInLibrary(item);
          const inLib = libInfo.inLibrary;
          const isMaster = !!item.masterId;
          const safeItemJson = JSON.stringify(item).replace(/"/g, '&quot;');
          return `
            <div class="search-result-item ${inLib ? 'search-item-in-library' : ''}" style="margin-bottom:8px; padding:8px 10px;">
              <div class="search-result-left">
                <img src="${coverImg || ''}" style="width:38px; height:38px; border-radius:4px; object-fit:cover; background:#222; flex-shrink:0;">
                <div class="search-meta" style="min-width:0;">
                  <div class="search-artist" style="font-size:11.5px; color:#cbd5e1; font-weight:600;">${this.escapeHtml(item.artist || item.rawTitle)}</div>
                  <div class="search-title" style="font-size:12.5px; font-weight:700;">
                    <a href="javascript:void(0)" class="dual-album-link" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" style="color:#ffffff; text-decoration:none;">${this.escapeHtml(item.title || '')}</a>
                  </div>
                  <div class="search-tags" style="font-size:10.5px; color:#94a3b8;">
                    ${item.year ? `<span style="color:#cbd5e1;">${this.escapeHtml(item.year)}</span> • ` : ''}
                    <span style="color:#38bdf8;">${this.formatVinylVersions(item.versionsCount || 1)}</span>
                  </div>
                </div>
              </div>
              <div class="search-result-right" style="gap:4px;">
                <button type="button" class="btn btn-sm ${inLib ? 'btn-secondary' : 'btn-primary'}" onclick="${isMaster ? `App.addAlbumFromModal(${item.id})` : `App.addRecordFromDiscogs(${item.id})`}" ${inLib ? 'disabled' : ''} style="font-size:11px; padding:3px 8px;">
                  ${inLib ? '✓ Есть' : '+ Добавить'}
                </button>
              </div>
            </div>
          `;
        }).join('');

        const spColHtml = spotifyResults.length === 0 ? '<div style="color:var(--text-muted); text-align:center; padding:20px;">Ничего не найдено в Spotify</div>' : spotifyResults.map(item => {
          const coverImg = item.coverImage;
          const transferArt = (item.artist || '').replace(/'/g, "\\'");
          const transferAlb = (item.album || item.title || '').replace(/'/g, "\\'");
          return `
            <div class="search-result-item dual-sp-item-clickable" style="margin-bottom:8px; padding:8px 10px;" onclick="App.transferSpotifyAlbumToSearch('${transferArt}', '${transferAlb}')" title="Кликните, чтобы сразу найти винилы этого альбома на Discogs!">
              <div class="search-result-left">
                <img src="${coverImg || ''}" style="width:38px; height:38px; border-radius:4px; object-fit:cover; background:#222; flex-shrink:0;">
                <div class="search-meta" style="min-width:0;">
                  <div class="search-artist" style="font-size:11.5px; color:#4ade80; font-weight:700;">${this.escapeHtml(item.artist)}</div>
                  <div class="search-title" style="font-size:12.5px; font-weight:700; color:#ffffff;">${this.escapeHtml(item.title)}</div>
                  <div class="dual-sp-parent-alb" style="font-size:11px; color:#cbd5e1; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; margin-top:2px;">💽 Альбом: <b style="color:#f8fafc;">${this.escapeHtml(item.album || item.title)}</b></div>
                </div>
              </div>
              <div class="search-result-right" style="gap:4px;">
                <button type="button" class="btn btn-secondary btn-sm" style="font-size:10.5px; padding:3px 8px; border-color:#1ed760; color:#1ed760;" onclick="event.stopPropagation(); App.transferSpotifyAlbumToSearch('${transferArt}', '${transferAlb}')" title="Найти винилы альбома на Discogs">
                  💽 В Discogs ➔
                </button>
              </div>
            </div>
          `;
        }).join('');

        resultsContainer.innerHTML = `
          ${artistBannerHtml}
          <div class="dual-search-container">
            <div class="dual-search-col">
              <div class="dual-col-header">
                <span>💽 Discogs (Винилы & Альбомы)</span>
                <span class="badge" style="font-size:10px;">${discogsResults.length}</span>
              </div>
              <div class="dual-col-content">
                ${dColHtml}
              </div>
            </div>
            <div class="dual-search-col">
              <div class="dual-col-header">
                <span>🟢 Spotify (Клик переносит в Discogs)</span>
                <span class="badge" style="font-size:10px; background:rgba(30,215,96,0.2); color:#1ed760;">${spotifyResults.length}</span>
              </div>
              <div class="dual-col-content">
                ${spColHtml}
              </div>
            </div>
          </div>
        `;
        return;
      }

      resultsContainer.innerHTML = `<div style="text-align:center; padding:30px; color:var(--accent-theme)">Поиск в ${serviceName}...</div>`;

      let data;
      let matchedArtist = null;

      if (isSpotify) {
        // In Spotify search: always search tracks so user can see songs and their albums!
        data = await SpotifyClient.searchTracks(q, 20);
      } else {
        const [artistRes, searchData] = await Promise.all([
          DiscogsClient.searchArtist(q).catch(() => null),
          (this.appMode === 'albums' ? DiscogsClient.searchAlbums(q, 1, 25) : DiscogsClient.searchVinyl(q, 1, 25))
        ]);
        matchedArtist = artistRes;
        data = searchData || { results: [] };
      }

      this.currentSearchArtist = matchedArtist;
      this.previousSearchState = null;

      const results = data.results || [];

      // Generate Artist Banner HTML if artist was found
      let artistBannerHtml = '';
      if (matchedArtist) {
        const safeArtistName = this.escapeHtml(matchedArtist.name);
        const safeArtistThumb = this.escapeHtml(matchedArtist.thumb || '');
        const transferArt = safeArtistName.replace(/'/g, "\\'");
        const transferThumb = safeArtistThumb.replace(/'/g, "\\'");
        artistBannerHtml = `
          <div class="search-artist-banner" onclick="App.showArtistAlbums(${matchedArtist.id}, '${transferArt}', '${transferThumb}')" title="Нажмите, чтобы открыть все виниловые издания ${safeArtistName}">
            <div class="search-artist-banner-left">
              <div class="search-artist-avatar-wrap">
                <img src="${matchedArtist.thumb || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'52\' height=\'52\' fill=\'%23222\'><circle cx=\'26\' cy=\'26\' r=\'26\'/></svg>'}" class="search-artist-avatar" alt="${safeArtistName}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'52\' height=\'52\' fill=\'%23222\'><circle cx=\'26\' cy=\'26\' r=\'26\'/></svg>'">
              </div>
              <div class="search-artist-banner-meta">
                <span class="search-artist-tag">🎤 ИСПОЛНИТЕЛЬ</span>
                <div class="search-artist-name">${safeArtistName}</div>
                <div class="search-artist-sub">Виниловые издания · Нажмите, чтобы открыть все винилы ➔</div>
              </div>
            </div>
            <div class="search-artist-banner-right">
              <button type="button" class="btn btn-sm btn-primary search-artist-btn">
                Смотреть все винилы ➔
              </button>
            </div>
          </div>
        `;
      }

      if (results.length === 0) {
        resultsContainer.innerHTML = `
          ${artistBannerHtml}
          <div style="text-align:center; padding:30px; color:var(--text-secondary)">
            ${matchedArtist ? `Нажмите на блок исполнителя выше, чтобы загрузить всю дискографию «${this.escapeHtml(matchedArtist.name)}».` : `По запросу «${this.escapeHtml(q)}» ничего не найдено в ${serviceName}.`}<br><br>
            <button class="btn btn-primary btn-sm" onclick="App.switchToManualAdd('${this.escapeHtml(q)}')">
              Добавить запись вручную
            </button>
          </div>
        `;
        return;
      }

      // Sort:
      // 1. Albums/items already in user's table are shown at the very top!
      // 2. Remaining items are ordered from largest to smallest by vinyls available for sale
      results.sort((a, b) => {
        const aLib = this.isAlbumInLibrary(a).inLibrary ? 1 : 0;
        const bLib = this.isAlbumInLibrary(b).inLibrary ? 1 : 0;
        if (bLib !== aLib) return bLib - aLib;
        return this.getVinylSortScore(b) - this.getVinylSortScore(a);
      });

      this.lastSearchResults = results;
      // Pre-warm tracklist cache for top results immediately
      results.slice(0, 5).forEach(it => this.prefetchAlbumTracklist(it));

      if (isSpotify) {
        // SPOTIFY TRACK SEARCH RESULTS (Shows song, its parent album, and one-click transfer to Discogs vinyl search)
        resultsContainer.innerHTML = artistBannerHtml + results.map(item => {
          const coverImg = item.coverImage;
          const playBtn = item.previewUrl
            ? `<button type="button" class="preview-audio-btn" onclick="App.togglePreviewAudio('${this.escapeHtml(item.previewUrl)}', this)" title="Слушать 30-сек аудио превью">▶</button>`
            : '';
          const libInfo = this.isAlbumInLibrary(item);
          const alreadyAdded = libInfo.inLibrary || this.spotifyTracks.some(t => String(t.spotifyId) === String(item.id) || String(t.id) === `sp-${item.id}`);
          const tableName = libInfo.table ? libInfo.table.name : 'песен';
          const isNowPlaying = this.isAudioPlayingForAlbum(item);
          const link = item.spotifyUrl || item.externalUrl || (item.id ? `https://open.spotify.com/track/${item.id}` : null);
          const safeItemJson = JSON.stringify(item).replace(/"/g, '&quot;');
          const transferArtist = (item.artist || '').replace(/'/g, "\\'");
          const transferAlbum = (item.album || item.title || '').replace(/'/g, "\\'");

          return `
            <div class="spotify-track-card ${alreadyAdded ? 'search-item-in-library' : ''} ${isNowPlaying ? 'search-item-now-playing' : ''}" 
                 id="sp-track-${item.id}"
                 data-artist="${this.escapeHtml(item.artist || '')}"
                 data-album="${this.escapeHtml(item.album || item.title || '')}"
                 data-item-id="${this.escapeHtml(item.id)}"
                 onmouseenter="App.prefetchAlbumTracklist(${safeItemJson})">
              <div class="sp-card-main">
                <div class="sp-album-cover-wrap" onclick="App.transferSpotifyAlbumToSearch('${transferArtist}', '${transferAlbum}')" title="Нажмите, чтобы искать винилы альбома «${this.escapeHtml(item.album || item.title)}» на Discogs">
                  <img src="${coverImg || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'64\' height=\'64\' fill=\'%231ed760\'><rect width=\'64\' height=\'64\'/></svg>'}" class="sp-album-cover" alt="Track Cover" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'64\' height=\'64\' fill=\'%231ed760\'><rect width=\'64\' height=\'64\'/></svg>'">
                  <div class="sp-cover-overlay"><span class="sp-overlay-icon">💽</span></div>
                </div>
                <div class="sp-album-info">
                  <div class="sp-track-title" onclick="App.addSpotifyTrackFromData('${this.escapeHtml(item.id)}')" style="cursor:pointer;" title="Нажмите, чтобы выбрать эту песню">${this.escapeHtml(item.title)}</div>
                  <div class="sp-track-artist">${this.escapeHtml(item.artist)}</div>
                  <div class="sp-album-parent-row" style="margin: 4px 0 6px 0;">
                    <span class="sp-album-parent-pill" onclick="App.transferSpotifyAlbumToSearch('${transferArtist}', '${transferAlbum}')" title="Нажмите, чтобы искать винилы этого альбома на Discogs">
                      💽 Альбом: <u>${this.escapeHtml(item.album || item.title)}</u> ↗
                    </span>
                  </div>
                  <div class="sp-album-badges">
                    ${alreadyAdded ? `<span class="in-library-badge">✓ В таблице: ${this.escapeHtml(tableName)}</span>` : ''}
                    ${isNowPlaying ? `<span class="now-playing-album-indicator">🔊 Сейчас играет</span>` : ''}
                    ${item.durationStr ? `<span class="sp-badge time-badge">⏱ ${this.escapeHtml(item.durationStr)}</span>` : ''}
                    ${link ? `<a href="${this.escapeHtml(link)}" target="_blank" rel="noopener noreferrer" class="sp-badge link-badge">Spotify ↗</a>` : ''}
                  </div>
                </div>
              </div>
              <div class="sp-card-actions">
                ${playBtn}
                <button type="button" class="sp-btn sp-btn-transfer" onclick="App.transferSpotifyAlbumToSearch('${transferArtist}', '${transferAlbum}')" title="Искать винилы альбома «${this.escapeHtml(item.album || item.title)}» на Discogs">
                  💽 Найти винилы ↗
                </button>
                <button type="button" class="sp-btn sp-btn-tracklist" onclick="App.openAlbumTracklistModal('sp-${item.id}', ${safeItemJson})" title="Посмотреть треклист альбома">
                  🎵 Треклист
                </button>
                <button class="sp-btn ${alreadyAdded ? 'sp-btn-added' : 'sp-btn-add'}" id="modalBtnAddTrack-${item.id}" onclick="App.addSpotifyTrackFromData('${this.escapeHtml(item.id)}')" ${alreadyAdded ? 'disabled' : ''}>
                  ${alreadyAdded ? '✓ В коллекции' : '+ В треки'}
                </button>
              </div>
            </div>
          `;
        }).join('');

      } else if (this.appMode === 'albums') {
        // ALBUMS SEARCH RESULTS (each album once, sorted by library then editions count)
        resultsContainer.innerHTML = artistBannerHtml + results.map(item => {
          const coverImg = item.thumb || item.coverImage;
          const safeItemJson = JSON.stringify(item).replace(/"/g, '&quot;');
          const libInfo = this.isAlbumInLibrary(item);
          const inLib = libInfo.inLibrary;
          const tableName = libInfo.table ? libInfo.table.name : 'альбомов';
          const isNowPlaying = this.isAudioPlayingForAlbum(item);
          const hasCount = typeof item.versionsCount === 'number';
          const isZero = hasCount && item.versionsCount === 0;
          const versionsText = hasCount
            ? (isZero ? '🚫 Нет виниловых изданий' : `💽 ${this.formatVinylVersions(item.versionsCount)}`)
            : '⏳ Загрузка изданий...';

          return `
            <div class="search-result-item ${inLib ? 'search-item-in-library' : ''} ${isNowPlaying ? 'search-item-now-playing' : ''} ${isZero ? 'search-item-no-sale' : ''}" 
                 id="search-item-${item.id}"
                 data-artist="${this.escapeHtml(item.artist || item.rawTitle || '')}"
                 data-album="${this.escapeHtml(item.title || '')}"
                 data-item-id="${this.escapeHtml(item.id)}"
                 onmouseenter="App.prefetchAlbumTracklist(${safeItemJson})">
              <div class="search-result-left">
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" style="width:48px; height:48px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  <img src="${coverImg || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' fill=\'%23222\'><rect width=\'48\' height=\'48\'/></svg>'}" class="search-cover" alt="Album">
                </div>
                <div class="search-meta">
                  <div class="search-artist">${this.escapeHtml(item.artist || item.rawTitle)}</div>
                  <div class="search-title">
                    <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" title="Нажмите, чтобы открыть треклист и слушать">
                      ${this.escapeHtml(item.title || '')}
                    </a>
                  </div>
                  <div class="search-tags">
                    ${inLib ? `<span class="in-library-badge">✓ В таблице: ${this.escapeHtml(tableName)}</span> •` : ''}
                    ${isNowPlaying ? `<span class="now-playing-album-indicator">🔊 Сейчас играет</span> •` : ''}
                    ${item.year ? `<span>Год: ${this.escapeHtml(item.year)}</span> •` : ''}
                    <span id="modalAlbumVersCount-${item.id}" class="versions-badge ${isZero ? 'versions-badge-zero' : ''}" style="color:var(--accent-theme); font-weight:600;">${versionsText}</span>
                  </div>
                </div>
              </div>
              <div class="search-result-right" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <button type="button" class="btn-search-versions-toggle" onclick="event.stopPropagation(); App.toggleSearchVersionsDrawer('${item.id}', '${item.masterId || ''}')" title="Посмотреть список вариантов прессов прямо здесь">
                  💽 Издания ▾
                </button>
                <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" title="Посмотреть список песен и прослушать">
                  🎵 Треклист ▶
                </button>
                <button class="btn btn-sm ${inLib ? 'btn-secondary sp-btn-added' : 'btn-primary'}" id="modalBtnAddAlbum-${item.id}" onclick="App.addAlbumFromModal(${item.id})" ${inLib ? 'disabled' : ''}>
                  ${inLib ? '✓ В коллекции' : '+ В список альбомов'}
                </button>
              </div>
            </div>
            <div id="search-versions-drawer-${item.id}" class="search-versions-drawer" style="display:none;"></div>
          `;
        }).join('');

        // Fetch exact vinyl versions count in fast parallel batches and sort swiftly
        (async () => {
          const uncachedItems = results.filter(it => it.masterId && typeof it.versionsCount !== 'number');
          const masterIds = uncachedItems.map(it => it.masterId);

          const chunkSize = 10;
          for (let i = 0; i < masterIds.length; i += chunkSize) {
            const chunk = masterIds.slice(i, i + chunkSize);
            const batchCounts = await DiscogsClient.getBatchMasterVersionsCounts(chunk);

            for (const item of results) {
              if (item.masterId && batchCounts[item.masterId] !== undefined) {
                item.versionsCount = batchCounts[item.masterId];
              } else if (!item.masterId && typeof item.versionsCount !== 'number') {
                item.versionsCount = 1;
              }

              if (typeof item.versionsCount === 'number') {
                const countEl = document.getElementById(`modalAlbumVersCount-${item.id}`);
                const card = document.getElementById(`search-item-${item.id}`);
                if (countEl) {
                  if (item.versionsCount === 0) {
                    countEl.textContent = '🚫 Нет виниловых изданий';
                    countEl.className = 'versions-badge versions-badge-zero';
                    if (card) card.classList.add('search-item-no-sale');
                  } else {
                    countEl.textContent = `💽 ${this.formatVinylVersions(item.versionsCount)}`;
                    countEl.className = 'versions-badge';
                    if (card) card.classList.remove('search-item-no-sale');
                  }
                }
              }
            }

            this.resortDiscogsSearchResults();
          }
        })();

      } else {
        // RELEASES SEARCH RESULTS
        resultsContainer.innerHTML = artistBannerHtml + results.map(item => {
          const coverImg = item.thumb || item.coverImage;
          const safeItemJson = JSON.stringify(item).replace(/"/g, '&quot;');
          const libInfo = this.isAlbumInLibrary(item);
          const inLib = libInfo.inLibrary;
          const tableName = libInfo.table ? libInfo.table.name : 'релизов';
          const isNowPlaying = this.isAudioPlayingForAlbum(item);

          return `
            <div class="search-result-item ${inLib ? 'search-item-in-library' : ''} ${isNowPlaying ? 'search-item-now-playing' : ''}" 
                 id="search-item-${item.id}"
                 data-artist="${this.escapeHtml(item.artist || item.rawTitle || '')}"
                 data-album="${this.escapeHtml(item.title || '')}"
                 data-item-id="${this.escapeHtml(item.id)}"
                 onmouseenter="App.prefetchAlbumTracklist(${safeItemJson})">
              <div class="search-result-left">
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" style="width:48px; height:48px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  <img src="${coverImg || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' fill=\'%23222\'><rect width=\'48\' height=\'48\'/></svg>'}" class="search-cover" alt="Vinyl">
                </div>
                <div class="search-meta">
                  <div class="search-artist">${this.escapeHtml(item.artist || item.rawTitle)}</div>
                  <div class="search-title">
                    <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" title="Нажмите, чтобы открыть треклист и слушать">
                      ${this.escapeHtml(item.title || '')}
                    </a>
                  </div>
                  <div class="search-tags">
                    ${inLib ? `<span class="in-library-badge">✓ В таблице: ${this.escapeHtml(tableName)}</span> •` : ''}
                    ${isNowPlaying ? `<span class="now-playing-album-indicator">🔊 Сейчас играет</span> •` : ''}
                    ${item.year ? `<span>${this.escapeHtml(item.year)}</span> •` : ''}
                    ${item.country ? `<span>${this.escapeHtml(item.country)}</span> •` : ''}
                    <span>${this.escapeHtml(item.format || 'Vinyl')}</span>
                    ${item.label ? `• <span>${this.escapeHtml(item.label)}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="search-result-right" style="display:flex; align-items:center; gap:8px;">
                <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" title="Посмотреть список песен и прослушать">
                  🎵 Треклист ▶
                </button>
                <div class="search-price-preview" id="price-preview-${item.id}">
                  <button class="btn btn-sm btn-secondary" onclick="App.loadPriceForModalItem(${item.id})">Узнать цену</button>
                </div>
                <button class="btn btn-sm ${inLib ? 'btn-secondary sp-btn-added' : 'btn-primary'}" id="modalBtnAddRelease-${item.id}" onclick="App.addRecordFromDiscogs(${item.id})" ${inLib ? 'disabled' : ''}>
                  ${inLib ? '✓ В вишлисте' : '+ В вишлист'}
                </button>
              </div>
            </div>
          `;
        }).join('');

        // Sequentially fetch price preview for releases (if needed)
        (async () => {
          for (const item of results.slice(0, 10)) {
            try {
              const stats = await DiscogsClient.getPriceStats(item.id);
              if (stats) {
                const pricePreviewEl = document.getElementById(`price-preview-${item.id}`);
                if (pricePreviewEl && (stats.min || stats.lowest_price)) {
                  const p = stats.min || stats.lowest_price;
                  const cur = stats.currency || 'USD';
                  const curSym = cur === 'EUR' ? '€' : (cur === 'GBP' ? '£' : '$');
                  pricePreviewEl.innerHTML = `<span style="color:var(--accent-theme); font-weight:600;">от ${curSym}${p.toFixed(2)}</span>`;
                }
              }
            } catch (e) {
              console.warn('Failed to load stats for release', item.id, e);
            }
            await new Promise(r => setTimeout(r, 150));
          }
        })();
      }

    } catch (err) {
      resultsContainer.innerHTML = `
        <div style="text-align:center; padding:30px; color:var(--danger)">
          ${this.escapeHtml(err.message)}<br><br>
          <button class="btn btn-secondary btn-sm" onclick="App.switchToManualAdd()">Добавить вручную</button>
        </div>
      `;
    }
  },

  async showArtistAlbums(artistId, artistName, artistThumb) {
    const resultsContainer = document.getElementById('discogsSearchResults');
    if (!resultsContainer) return;

    if (!this.previousSearchState) {
      this.previousSearchState = {
        html: resultsContainer.innerHTML,
        results: [...(this.lastSearchResults || [])]
      };
    }

    resultsContainer.innerHTML = `
      <div class="artist-discography-header">
        <button type="button" class="btn btn-sm btn-secondary" onclick="App.restoreLastSearchResults()">
          ← Назад к поиску
        </button>
        <div style="display:flex; align-items:center; gap:10px;">
          ${artistThumb ? `<img src="${this.escapeHtml(artistThumb)}" style="width:34px; height:34px; border-radius:50%; object-fit:cover; border:2px solid var(--accent-theme);">` : ''}
          <div style="font-weight:700; font-size:14px; color:#fff;">
            ${this.escapeHtml(artistName)}
          </div>
        </div>
      </div>
      <div style="text-align:center; padding:40px; color:var(--accent-theme)">
        ⏳ Загрузка всех альбомов ${this.escapeHtml(artistName)}...
      </div>
    `;

    try {
      const data = await DiscogsClient.getArtistAlbums(artistId, artistName, 1, 100);
      const results = data.results || [];

      if (results.length === 0) {
        resultsContainer.innerHTML = `
          <div class="artist-discography-header">
            <button type="button" class="btn btn-sm btn-secondary" onclick="App.restoreLastSearchResults()">
              ← Назад к поиску
            </button>
            <div style="font-weight:700; font-size:14px; color:#fff;">${this.escapeHtml(artistName)}</div>
          </div>
          <div style="text-align:center; padding:30px; color:var(--text-secondary)">
            У исполнителя «${this.escapeHtml(artistName)}» не найдено альбомов в каталоге.
          </div>
        `;
        return;
      }

      // Sort:
      // 1. Albums/items already in user's table are shown at the very top!
      // 2. Remaining items are ordered from largest to smallest by vinyls available for sale
      results.sort((a, b) => {
        const aLib = this.isAlbumInLibrary(a).inLibrary ? 1 : 0;
        const bLib = this.isAlbumInLibrary(b).inLibrary ? 1 : 0;
        if (bLib !== aLib) return bLib - aLib;
        return this.getVinylSortScore(b) - this.getVinylSortScore(a);
      });

      this.lastSearchResults = results;
      // Pre-warm tracklist cache for top results
      results.slice(0, 5).forEach(it => this.prefetchAlbumTracklist(it));

      const headerHtml = `
        <div class="artist-discography-header">
          <button type="button" class="btn btn-sm btn-secondary" onclick="App.restoreLastSearchResults()">
            ← Назад к поиску
          </button>
          <div style="display:flex; align-items:center; gap:10px;">
            ${artistThumb ? `<img src="${this.escapeHtml(artistThumb)}" style="width:34px; height:34px; border-radius:50%; object-fit:cover; border:2px solid var(--accent-theme);">` : ''}
            <div>
              <span style="font-weight:700; font-size:14px; color:#fff;">${this.escapeHtml(artistName)}</span>
              <span class="badge" style="margin-left:6px; font-size:11px; background:rgba(30,215,96,0.15); color:var(--accent-theme); border:1px solid rgba(30,215,96,0.3);">
                ${results.length} виниловых изданий
              </span>
            </div>
          </div>
        </div>
      `;

      const cardsHtml = results.map(item => {
        const coverImg = item.thumb || item.coverImage;
        const safeItemJson = JSON.stringify(item).replace(/"/g, '&quot;');
        const libInfo = this.isAlbumInLibrary(item);
        const inLib = libInfo.inLibrary;
        const tableName = libInfo.table ? libInfo.table.name : 'альбомов';
        const isNowPlaying = this.isAudioPlayingForAlbum(item);
        const hasCount = typeof item.versionsCount === 'number';
        const isZero = hasCount && item.versionsCount === 0;
        const versionsText = hasCount
          ? (isZero ? '🚫 Нет виниловых изданий' : `💽 ${this.formatVinylVersions(item.versionsCount)}`)
          : '⏳ Загрузка изданий...';

        return `
          <div class="search-result-item ${inLib ? 'search-item-in-library' : ''} ${isNowPlaying ? 'search-item-now-playing' : ''} ${isZero ? 'search-item-no-sale' : ''}" 
               id="search-item-${item.id}"
               data-artist="${this.escapeHtml(item.artist || item.rawTitle || '')}"
               data-album="${this.escapeHtml(item.title || '')}"
               data-item-id="${this.escapeHtml(item.id)}"
               onmouseenter="App.prefetchAlbumTracklist(${safeItemJson})">
            <div class="search-result-left">
              <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" style="width:48px; height:48px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                <img src="${coverImg || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' fill=\'%23222\'><rect width=\'48\' height=\'48\'/></svg>'}" class="search-cover" alt="Album">
              </div>
              <div class="search-meta">
                <div class="search-artist">${this.escapeHtml(item.artist || item.rawTitle)}</div>
                <div class="search-title">
                  <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" title="Нажмите, чтобы открыть треклист и слушать">
                    ${this.escapeHtml(item.title || '')}
                  </a>
                </div>
                <div class="search-tags">
                  ${inLib ? `<span class="in-library-badge">✓ В таблице: ${this.escapeHtml(tableName)}</span> •` : ''}
                  ${isNowPlaying ? `<span class="now-playing-album-indicator">🔊 Сейчас играет</span> •` : ''}
                  ${item.year ? `<span>Год: ${this.escapeHtml(item.year)}</span> •` : ''}
                  <span id="modalAlbumVersCount-${item.id}" class="versions-badge ${isZero ? 'versions-badge-zero' : ''}" style="color:var(--accent-theme); font-weight:600;">${versionsText}</span>
                </div>
              </div>
            </div>
            <div class="search-result-right" style="display:flex; align-items:center; gap:8px;">
              <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal(${item.id}, ${safeItemJson})" title="Посмотреть список песен и прослушать">
                🎵 Треклист ▶
              </button>
              <button class="btn btn-sm ${inLib ? 'btn-secondary sp-btn-added' : 'btn-primary'}" id="modalBtnAddAlbum-${item.id}" onclick="App.addAlbumFromModal(${item.id})" ${inLib ? 'disabled' : ''}>
                ${inLib ? '✓ В коллекции' : '+ В список альбомов'}
              </button>
            </div>
          </div>
        `;
      }).join('');

      resultsContainer.innerHTML = headerHtml + cardsHtml;

      // Fetch exact vinyl versions count in fast parallel batches and sort swiftly
      (async () => {
        const uncachedItems = results.filter(it => it.masterId && typeof it.versionsCount !== 'number');
        const masterIds = uncachedItems.map(it => it.masterId);

        const chunkSize = 10;
        for (let i = 0; i < masterIds.length; i += chunkSize) {
          const chunk = masterIds.slice(i, i + chunkSize);
          const batchCounts = await DiscogsClient.getBatchMasterVersionsCounts(chunk);

          for (const item of results) {
            if (item.masterId && batchCounts[item.masterId] !== undefined) {
              item.versionsCount = batchCounts[item.masterId];
            } else if (!item.masterId && typeof item.versionsCount !== 'number') {
              item.versionsCount = 1;
            }

            if (typeof item.versionsCount === 'number') {
              const countEl = document.getElementById(`modalAlbumVersCount-${item.id}`);
              const card = document.getElementById(`search-item-${item.id}`);
              if (countEl) {
                if (item.versionsCount === 0) {
                  countEl.textContent = '🚫 Нет виниловых изданий';
                  countEl.className = 'versions-badge versions-badge-zero';
                  if (card) card.classList.add('search-item-no-sale');
                } else {
                  countEl.textContent = `💽 ${this.formatVinylVersions(item.versionsCount)}`;
                  countEl.className = 'versions-badge';
                  if (card) card.classList.remove('search-item-no-sale');
                }
              }
            }
          }

          this.resortDiscogsSearchResults();
        }
      })();

    } catch (err) {
      console.warn('showArtistAlbums error:', err);
      resultsContainer.innerHTML = `
        <div class="artist-discography-header">
          <button type="button" class="btn btn-sm btn-secondary" onclick="App.restoreLastSearchResults()">
            ← Назад к поиску
          </button>
        </div>
        <div style="text-align:center; padding:30px; color:var(--text-secondary)">
          Ошибка загрузки дискографии: ${this.escapeHtml(err.message || 'Сбой соединения')}
        </div>
      `;
    }
  },

  restoreLastSearchResults() {
    const resultsContainer = document.getElementById('discogsSearchResults');
    if (!resultsContainer || !this.previousSearchState) return;
    resultsContainer.innerHTML = this.previousSearchState.html;
    this.lastSearchResults = this.previousSearchState.results;
    this.previousSearchState = null;
  },

  async addAlbumFromModal(masterId) {
    const item = (this.lastSearchResults || []).find(r => r.id === masterId);
    if (!item) return;

    let versionsCount = item.versionsCount;
    if (versionsCount === null || versionsCount === undefined) {
      if (item.masterId) {
        const versData = await DiscogsClient.getMasterVersions(item.masterId, 1, 1).catch(() => null);
        versionsCount = versData && versData.pagination ? versData.pagination.items : 1;
      } else {
        versionsCount = 1;
      }
    }

    const newAlbum = {
      id: `master-${item.id}`,
      masterId: item.id,
      artist: item.artist || item.rawTitle,
      title: item.title || item.rawTitle,
      year: item.year || '',
      coverImage: item.coverImage || item.thumb,
      thumb: item.thumb,
      uri: item.uri,
      versionsCount: versionsCount,
      genre: item.genre || '',
      style: item.style || '',
      status: 'buy',
      notes: '',
      createdAt: new Date().toISOString()
    };

    const existing = this.findTableAndItem(`master-${masterId}`, 'albums');
    if (existing) {
      alert(`Альбом «${newAlbum.artist} - ${newAlbum.title}» уже есть в вашем каталоге!`);
      return;
    }

    this.promptDestinationTable(newAlbum.title || newAlbum.artist, 'albums', (targetTableId) => {
      this.addItemToActiveTable(newAlbum, targetTableId, 'albums');
      this.render();

      const targetTable = (this.tables.albums || []).find(t => t.id === targetTableId);
      const tableName = targetTable ? targetTable.name : 'альбомов';

      // Keep search modal OPEN and mark item as added, move to top!
      const modalBtn = document.getElementById(`modalBtnAddAlbum-${masterId}`) 
        || document.getElementById(`modalBtnAdd-${masterId}`);
      if (modalBtn) {
        modalBtn.textContent = '✓ В коллекции';
        modalBtn.classList.remove('btn-primary');
        modalBtn.classList.add('btn-secondary');
        modalBtn.classList.add('sp-btn-added');
        modalBtn.disabled = true;
      }

      const card = document.getElementById(`search-item-${masterId}`)
        || document.getElementById(`sp-album-${masterId}`)
        || document.querySelector(`[data-item-id="${masterId}"]`)
        || modalBtn?.closest('.search-result-item, .spotify-album-card');
      if (card) {
        card.classList.add('search-item-in-library');
        card.classList.add('tracklist-item-added');
        card.style.opacity = '0.58';
        card.style.filter = 'grayscale(100%)';
        card.style.background = 'rgba(255, 255, 255, 0.02)';
        let badge = card.querySelector('.in-library-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'in-library-badge';
          badge.textContent = `✓ В таблице: ${tableName}`;
          const badgesRow = card.querySelector('.search-tags, .sp-album-badges');
          if (badgesRow) badgesRow.prepend(badge);
        }
        if (card.parentElement) {
          card.parentElement.prepend(card);
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }

      this.highlightRecord(newAlbum.id);
      this.showToastNotification(`✓ Альбом «${newAlbum.title}» добавлен в «${tableName}»`);
    });
  },

  addSpotifyTrackFromData(trackId) {
    const list = [
      ...(this.lastSearchResults || []),
      ...(this.lastCompanionSearchResults || [])
    ];
    const sId = String(trackId).replace(/^sp-/, '');
    const item = list.find(r => {
      const rId = String(r.id || '').replace(/^sp-/, '');
      const rSpId = String(r.spotifyId || '').replace(/^sp-/, '');
      return rId === sId || rSpId === sId || String(r.id) === String(trackId);
    });
    if (!item) {
      console.warn('Track not found in search results:', trackId);
      return;
    }

    const rawId = item.id || item.spotifyId || Date.now();
    const cleanId = String(rawId).startsWith('sp-') ? rawId : `sp-${rawId}`;

    const exists = this.findTableAndItem(cleanId, 'spotify', false);
    if (exists) {
      alert(`Песня «${item.artist} - ${item.title}» уже есть в вашей таблице «${exists.table?.name || 'треков'}»!`);
      return;
    }

    const newTrack = {
      id: cleanId,
      spotifyId: item.spotifyId || item.id,
      uri: item.uri || item.spotifyUri || `spotify:track:${item.id}`,
      title: item.title || 'Без названия',
      artist: item.artist || 'Неизвестный исполнитель',
      album: item.album || '',
      durationMs: item.durationMs || 0,
      durationStr: item.durationStr || '0:00',
      previewUrl: item.previewUrl || null,
      coverImage: item.coverImage || '',
      externalUrl: item.externalUrl || (item.id ? `https://open.spotify.com/track/${item.id}` : ''),
      status: 'buy',
      rating: 0,
      isHighValue: false,
      notes: '',
      createdAt: new Date().toISOString()
    };

    this.promptDestinationTable(newTrack.title || newTrack.artist, 'spotify', (targetTableId) => {
      this.addItemToActiveTable(newTrack, targetTableId, 'spotify');
      this.render();

      const targetTable = (this.tables.spotify || []).find(t => t.id === targetTableId);
      const tableName = targetTable ? targetTable.name : 'треков';

      // Keep search modal OPEN and mark item as added, move to top!
      const modalBtn = document.getElementById(`modalBtnAddTrack-${item.id}`);
      if (modalBtn) {
        modalBtn.textContent = '✓ В коллекции';
        modalBtn.classList.remove('btn-primary', 'sp-btn-add');
        modalBtn.classList.add('btn-secondary', 'sp-btn-added');
        modalBtn.disabled = true;
      }

      const card = document.getElementById(`sp-track-${item.id}`)
        || document.querySelector(`[data-item-id="${item.id}"]`)
        || modalBtn?.closest('.spotify-track-card');
      if (card) {
        card.classList.add('search-item-in-library');
        card.classList.add('tracklist-item-added');
        card.style.opacity = '0.58';
        card.style.filter = 'grayscale(100%)';
        card.style.background = 'rgba(255, 255, 255, 0.02)';
        let badge = card.querySelector('.in-library-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'in-library-badge';
          badge.textContent = `✓ В таблице: ${tableName}`;
          const badgesRow = card.querySelector('.sp-album-badges, .sp-track-badges');
          if (badgesRow) badgesRow.prepend(badge);
        }
        if (card.parentElement) {
          card.parentElement.prepend(card);
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }

      const companionBox = document.getElementById('companionResult');
      if (companionBox) companionBox.style.display = 'none';

      this.highlightRecord(newTrack.id);
      this.showToastNotification(`✓ «${newTrack.title}» добавлена в таблицу «${tableName}»`);
    });
  },

  currentAudioTrackTitle: null,
  currentAudioArtist: null,
  currentAudioAlbumTitle: null,
  currentAudioBtnId: null,
  isAudioScrubbing: false,

  formatAudioTime(seconds) {
    const s = Math.floor(seconds || 0);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
  },

  playAudio(url, title = '', artist = '', coverUrl = '', btnElementOrId = null, album = '', source = '') {
    if (!url) return;

    if (this.currentAudioBtnId) {
      const prevBtn = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
      if (prevBtn) {
        prevBtn.classList.remove('playing');
        prevBtn.textContent = '▶';
      }
    }

    if (this.playingAudio && this.playingAudio.src === url) {
      this.toggleAudioPlayPause();
      return;
    }

    if (this.playingAudio) {
      this.playingAudio.pause();
      this.playingAudio = null;
    }

    this.currentAudioTrackTitle = title;
    this.currentAudioArtist = artist;
    this.currentAudioAlbumTitle = album;
    this.currentAudioBtnId = btnElementOrId;

    const playerEl = document.getElementById('bottomAudioPlayer');
    const trackCoverEl = document.getElementById('playerTrackCover');
    const trackTitleEl = document.getElementById('playerTrackTitle');
    const trackArtistEl = document.getElementById('playerTrackArtist');
    const sourceBadge = document.getElementById('playerSourceBadge');
    const playPauseIcon = document.getElementById('playerPlayPauseIcon');
    const scrubber = document.getElementById('playerScrubber');
    const currentTimeEl = document.getElementById('playerCurrentTime');
    const durationTimeEl = document.getElementById('playerDurationTime');

    if (playerEl) playerEl.style.display = 'block';
    if (trackCoverEl) {
      trackCoverEl.src = coverUrl || '';
      trackCoverEl.style.display = coverUrl ? 'block' : 'none';
    }
    if (trackTitleEl) trackTitleEl.textContent = title || 'Аудио-трек';
    if (trackArtistEl) trackArtistEl.textContent = artist || '—';
    if (sourceBadge) {
      if (source) {
        sourceBadge.textContent = `🔊 Источник: ${source}`;
        sourceBadge.style.display = 'inline-flex';
      } else {
        sourceBadge.style.display = 'none';
      }
    }
    if (scrubber) scrubber.value = 0;
    if (currentTimeEl) currentTimeEl.textContent = '0:00';
    if (durationTimeEl) durationTimeEl.textContent = '0:30';

    const audio = new Audio(url);
    const volumeSlider = document.getElementById('playerVolume');
    if (volumeSlider) audio.volume = parseFloat(volumeSlider.value) || 0.8;
    this.playingAudio = audio;

    const btn = typeof btnElementOrId === 'string' ? document.getElementById(btnElementOrId) : btnElementOrId;
    if (btn) {
      btn.classList.add('playing');
      btn.textContent = '⏸';
    }
    if (playPauseIcon) playPauseIcon.textContent = '⏸';

    audio.ontimeupdate = () => {
      const cur = audio.currentTime || 0;
      const dur = audio.duration && !isNaN(audio.duration) ? audio.duration : 30;
      if (currentTimeEl) currentTimeEl.textContent = this.formatAudioTime(cur);
      if (durationTimeEl && audio.duration) durationTimeEl.textContent = this.formatAudioTime(dur);
      if (scrubber && !this.isAudioScrubbing && dur > 0) {
        scrubber.value = ((cur / dur) * 100).toFixed(1);
      }
    };

    audio.onplay = () => {
      if (playPauseIcon) playPauseIcon.textContent = '⏸';
      const b = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
      if (b) {
        b.classList.add('playing');
        b.textContent = '⏸';
      }
      this.updateSearchPlayingHighlights();
    };

    audio.onpause = () => {
      if (playPauseIcon) playPauseIcon.textContent = '▶';
      const b = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
      if (b) {
        b.classList.remove('playing');
        b.textContent = '▶';
      }
      this.updateSearchPlayingHighlights();
    };

    audio.onended = () => {
      if (playPauseIcon) playPauseIcon.textContent = '▶';
      if (scrubber) scrubber.value = 0;
      if (currentTimeEl) currentTimeEl.textContent = '0:00';
      const b = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
      if (b) {
        b.classList.remove('playing');
        b.textContent = '▶';
      }
      this.currentAudioTrackTitle = null;
      this.currentAudioArtist = null;
      this.currentAudioAlbumTitle = null;
      this.updateSearchPlayingHighlights();
    };

    audio.onerror = (e) => {
      console.warn('Audio playback error:', e);
      if (playPauseIcon) playPauseIcon.textContent = '▶';
      const b = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
      if (b) {
        b.classList.remove('playing');
        b.textContent = '▶';
      }
      this.currentAudioTrackTitle = null;
      this.currentAudioArtist = null;
      this.currentAudioAlbumTitle = null;
      this.updateSearchPlayingHighlights();
    };

    audio.play().then(() => {
      this.updateSearchPlayingHighlights();
    }).catch(e => {
      console.warn('Audio play() error:', e);
      if (playPauseIcon) playPauseIcon.textContent = '▶';
      if (btn) {
        btn.classList.remove('playing');
        btn.textContent = '▶';
      }
      this.updateSearchPlayingHighlights();
    });
  },

  toggleAudioPlayPause() {
    if (!this.playingAudio) return;
    if (this.playingAudio.paused) {
      this.playingAudio.play().catch(() => {});
    } else {
      this.playingAudio.pause();
    }
  },

  seekAudioRelative(seconds) {
    if (!this.playingAudio) return;
    const dur = this.playingAudio.duration || 30;
    const newTime = Math.max(0, Math.min(dur, this.playingAudio.currentTime + seconds));
    this.playingAudio.currentTime = newTime;
  },

  onAudioScrub(percent) {
    if (!this.playingAudio) return;
    const dur = this.playingAudio.duration || 30;
    if (dur > 0) {
      this.playingAudio.currentTime = (parseFloat(percent) / 100) * dur;
    }
  },

  setAudioVolume(val) {
    if (this.playingAudio) {
      this.playingAudio.volume = Math.max(0, Math.min(1, parseFloat(val)));
    }
  },

  stopAndCloseAudioPlayer() {
    if (this.playingAudio) {
      this.playingAudio.pause();
      this.playingAudio = null;
    }
    const b = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
    if (b) {
      b.classList.remove('playing');
      b.textContent = '▶';
    }
    this.currentAudioTrackTitle = null;
    this.currentAudioArtist = null;
    this.currentAudioAlbumTitle = null;
    this.currentAudioBtnId = null;
    this.updateSearchPlayingHighlights();
    const playerEl = document.getElementById('bottomAudioPlayer');
    if (playerEl) playerEl.style.display = 'none';
  },

  togglePreviewAudio(url, btnElement) {
    this.playAudio(url, 'Превью трека', '', '', btnElement);
  },

  // ----------------------------------------------------
  // Album Tracklist Modal & Media Tabs (Cover / Video)
  // ----------------------------------------------------
  currentTracklistData: null,
  currentTracklistIndex: -1,
  currentMediaTab: 'cover',

  switchTracklistMedia(tab) {
    this.currentMediaTab = tab;
    const tabCover = document.getElementById('tabMediaCover');
    const tabVideo = document.getElementById('tabMediaVideo');
    const coverView = document.getElementById('tracklistCoverView');
    const videoView = document.getElementById('tracklistVideoView');

    if (tab === 'video') {
      if (tabCover) tabCover.classList.remove('active');
      if (tabVideo) tabVideo.classList.add('active');
      if (coverView) coverView.style.display = 'none';
      if (videoView) videoView.style.display = 'block';

      // Sound must come directly from video: stop Spotify audio preview
      if (this.playingAudio) {
        this.playingAudio.pause();
        this.playingAudio = null;
        const playerEl = document.getElementById('bottomAudioPlayer');
        if (playerEl) playerEl.style.display = 'none';
        this.setCoverPulsing(false);
        this.updateSearchPlayingHighlights();
      }

      // If a track is already active/selected, start video for it
      if (this.currentTracklistIndex >= 0) {
        this.loadAndPlayVideoForTrack(this.currentTracklistIndex);
      } else {
        const placeholder = document.getElementById('tracklistVideoPlaceholder');
        const frame = document.getElementById('tracklistVideoFrame');
        const player = document.getElementById('tracklistVideoPlayer');
        const loading = document.getElementById('tracklistVideoLoading');
        const nowPlaying = document.getElementById('tracklistNowPlayingInfo');
        if (placeholder) placeholder.style.display = 'flex';
        if (frame) { frame.src = ''; frame.style.display = 'none'; }
        if (player) { player.pause(); player.src = ''; player.style.display = 'none'; }
        if (loading) loading.style.display = 'none';
        if (nowPlaying) nowPlaying.style.display = 'none';
      }
    } else {
      // Switch back to Cover view
      if (tabCover) tabCover.classList.add('active');
      if (tabVideo) tabVideo.classList.remove('active');
      if (coverView) coverView.style.display = 'block';
      if (videoView) videoView.style.display = 'none';

      // Stop any video playback
      this.stopTrackVideo();

      // Check if audio is currently playing and pulse cover
      const isPlaying = Boolean(this.playingAudio && !this.playingAudio.paused);
      this.setCoverPulsing(isPlaying);
    }
  },

  stopTrackVideo() {
    const frame = document.getElementById('tracklistVideoFrame');
    const player = document.getElementById('tracklistVideoPlayer');
    const loading = document.getElementById('tracklistVideoLoading');
    const placeholder = document.getElementById('tracklistVideoPlaceholder');
    const nowPlaying = document.getElementById('tracklistNowPlayingInfo');
    const playingTitle = document.getElementById('tracklistPlayingSongName');

    if (frame) {
      frame.src = '';
      frame.style.display = 'none';
    }
    if (player) {
      player.pause();
      player.src = '';
      player.style.display = 'none';
    }
    if (loading) loading.style.display = 'none';
    if (placeholder) placeholder.style.display = 'flex';
    if (nowPlaying) nowPlaying.style.display = 'none';
    if (playingTitle) playingTitle.textContent = '';
  },

  clearTrackVideo() {
    this.stopTrackVideo();
    this.currentTracklistIndex = -1;
    document.querySelectorAll('.tracklist-item-row').forEach(row => {
      row.classList.remove('active-track');
      const btn = row.querySelector('.tracklist-play-btn');
      if (btn) {
        btn.classList.remove('playing');
        btn.textContent = '▶';
      }
    });
    this.switchTracklistMedia('cover');
  },

  showMediaCoverView() {
    this.switchTracklistMedia('cover');
  },

  showMediaVideoView(songLabel = '') {
    this.switchTracklistMedia('video');
  },

  getTracklistFromCache(key) {
    if (!key) return null;
    const k = String(key);
    if (this.tracklistCache.has(k)) return this.tracklistCache.get(k);
    try {
      const raw = localStorage.getItem(`vh_tl_${k}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.tracklist && parsed.tracklist.length > 0) {
          this.tracklistCache.set(k, parsed);
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  },

  saveTracklistToCache(key, data) {
    if (!key || !data || !data.tracklist || data.tracklist.length === 0) return;
    const k = String(key);
    this.tracklistCache.set(k, data);
    try {
      localStorage.setItem(`vh_tl_${k}`, JSON.stringify(data));
    } catch (e) {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const lk = localStorage.key(i);
          if (lk && lk.startsWith('vh_tl_')) {
            localStorage.removeItem(lk);
          }
        }
        localStorage.setItem(`vh_tl_${k}`, JSON.stringify(data));
      } catch (err) {}
    }
  },

  prefetchAlbumTracklist(item) {
    if (!item || (!item.id && !item.masterId && !item.discogsId && !item.spotifyId)) return;
    const cacheKey = item.masterId || item.discogsId || item.id;
    const nameKey = (item.artist && (item.album || item.title))
      ? `${String(item.artist).toLowerCase().trim()}:::${String(item.album || item.title).toLowerCase().trim()}`
      : null;

    if (this.getTracklistFromCache(cacheKey) || (nameKey && this.getTracklistFromCache(nameKey))) {
      return;
    }

    (async () => {
      try {
        let queryId = item.masterId || item.discogsId || null;
        let queryType = (this.appMode === 'albums' || item.type === 'master') ? 'master' : 'release';
        const strId = String(item.id || '');
        if (!queryId && strId) {
          if (strId.startsWith('master-')) {
            queryId = strId.replace('master-', '');
            queryType = 'master';
          } else if (strId.startsWith('discogs-')) {
            queryId = strId.replace('discogs-', '');
            queryType = 'release';
          } else if (/^\d+$/.test(strId)) {
            queryId = strId;
            queryType = (this.appMode === 'albums' || item.type === 'master') ? 'master' : 'release';
          }
        }

        const res = await fetch(`/api/discogs/tracklist?id=${encodeURIComponent(queryId || '')}&type=${queryType}&artist=${encodeURIComponent(item.artist || '')}&album=${encodeURIComponent(item.album || item.title || '')}`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.tracklist && data.tracklist.length > 0) {
            if (cacheKey) this.saveTracklistToCache(cacheKey, data);
            if (nameKey) this.saveTracklistToCache(nameKey, data);
            if (item.masterId) this.saveTracklistToCache(item.masterId, data);
          }
        }
      } catch (e) {}
    })();
  },

  renderTracklistData(data, item = {}) {
    const modalCover = document.getElementById('tracklistModalCover');
    const largeCover = document.getElementById('tracklistModalLargeCover');
    const modalTitle = document.getElementById('tracklistModalTitle');
    const modalSub = document.getElementById('tracklistModalSub');
    const metaArtist = document.getElementById('tracklistMetaArtist');
    const metaAlbum = document.getElementById('tracklistMetaAlbum');
    const metaBadges = document.getElementById('tracklistMetaBadges');
    const loadingEl = document.getElementById('tracklistModalLoading');
    const listEl = document.getElementById('tracklistModalList');

    this.currentTracklistData = data;
    this.currentTracklistIndex = -1;

    if (loadingEl) loadingEl.style.display = 'none';

    if (!data || !data.tracklist || data.tracklist.length === 0) {
      if (listEl) {
        listEl.style.display = 'block';
        listEl.innerHTML = '<div style="text-align:center; padding:24px; color:var(--text-muted);">К сожалению, треклист для этого релиза не найден в базе Discogs.</div>';
      }
      return;
    }

    const coverUrl = data.cover || item.coverImage || item.thumb || '';
    if (modalCover && coverUrl) {
      modalCover.src = coverUrl;
      modalCover.style.display = 'block';
    }
    if (largeCover && coverUrl) {
      largeCover.src = coverUrl;
      largeCover.style.display = 'block';
    }
    if (modalTitle && (data.title || item.album || item.title)) {
      modalTitle.textContent = data.title || item.album || item.title;
    }
    if (modalSub && (data.artist || item.artist)) {
      modalSub.textContent = `${data.artist || item.artist}${data.year || item.year ? ` · ${data.year || item.year}` : ''}`;
    }
    if (metaArtist) metaArtist.textContent = data.artist || item.artist || '';
    if (metaAlbum) metaAlbum.textContent = data.title || item.album || item.title || '';
    if (metaBadges) {
      metaBadges.innerHTML = `
        ${(data.year || item.year) ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">📅 ${this.escapeHtml(data.year || item.year)}</span>` : ''}
        <span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">🎵 Треков: ${data.tracklist.length}</span>
        ${item.format ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">💽 ${this.escapeHtml(item.format)}</span>` : ''}
        ${item.country ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">🌍 ${this.escapeHtml(item.country)}</span>` : ''}
      `;
    }

    const artistName = data.artist || item.artist || '';

    const isSpotifyFallback = Boolean(data.discogsNotFound || data.source === 'Spotify');
    const fallbackBanner = isSpotifyFallback ? `
      <div class="spotify-fallback-notice" style="background:rgba(30, 215, 96, 0.12); border:1px solid rgba(30, 215, 96, 0.35); border-radius:6px; padding:8px 12px; margin-bottom:12px; font-size:11.5px; color:#a7f3d0; display:flex; align-items:center; gap:8px;">
        <span style="font-size:14px;">🟢</span>
        <span>${this.escapeHtml(data.message || 'Треклист на Discogs отсутствовал — автоматически загружен оригинальный треклист из Spotify')}</span>
      </div>
    ` : '';

    if (listEl) {
      listEl.innerHTML = fallbackBanner + data.tracklist.map((t, idx) => {
        const btnId = `tracklist-play-btn-${idx}`;
        return `
          <div class="tracklist-item-row" id="tracklist-row-${idx}">
            <div class="tracklist-left-info">
              <span class="tracklist-pos-badge">${this.escapeHtml(t.position || String(idx + 1))}</span>
              <button class="tracklist-play-btn" id="${btnId}" onclick="App.playTrackByIndex(${idx})" title="Воспроизвести аудио-превью">
                ▶
              </button>
              <div class="album-track-info">
                <span class="tracklist-title-text" onclick="App.selectTrackByIndex(${idx})" style="cursor:pointer;" title="Нажмите для воспроизведения">${this.escapeHtml(t.title)}</span>
                <span class="album-track-artist">${this.escapeHtml(t.artist || artistName)}</span>
              </div>
            </div>
            <div class="tracklist-right-actions" style="display:flex; align-items:center; gap:8px;">
              <span class="tracklist-duration-text">${this.escapeHtml(t.duration || '—')}</span>
              <button type="button" class="sp-btn sp-btn-add" style="padding:3px 8px; font-size:11px;" onclick="App.addTrackByIndex(${idx})" title="Добавить песню в треки">
                + В треки
              </button>
            </div>
          </div>
        `;
      }).join('');
      listEl.style.display = 'block';
    }
  },

  async openAlbumTracklistModal(itemId, fallbackObj = null) {
    let item = (fallbackObj && typeof fallbackObj === 'object') ? fallbackObj : null;
    if (!item) {
      const found = this.findTableAndItem(itemId, this.appMode, true);
      if (found) item = found.item;
    }
    if (!item) {
      const all = [...this.records, ...this.albums, ...this.spotifyTracks];
      item = all.find(it => String(it.id) === String(itemId) || String(it.spotifyId) === String(itemId) || String(it.discogsId) === String(itemId));
    }
    if (!item) {
      const searchAll = [...(this.lastSearchResults || []), ...(this.lastCompanionSearchResults || [])];
      item = searchAll.find(it => String(it.id) === String(itemId) || String(it.spotifyId) === String(itemId) || String(it.masterId) === String(itemId));
    }
    if (!item && (typeof itemId === 'number' || /^\d+$/.test(String(itemId)))) {
      item = { id: itemId, artist: '', title: '' };
    }
    if (!item) return;

    const modal = document.getElementById('albumTracklistModal');
    if (!modal) return;

    const modalCover = document.getElementById('tracklistModalCover');
    const largeCover = document.getElementById('tracklistModalLargeCover');
    const metaArtist = document.getElementById('tracklistMetaArtist');
    const metaAlbum = document.getElementById('tracklistMetaAlbum');
    const metaBadges = document.getElementById('tracklistMetaBadges');
    const modalTitle = document.getElementById('tracklistModalTitle');
    const modalSub = document.getElementById('tracklistModalSub');
    const loadingEl = document.getElementById('tracklistModalLoading');
    const listEl = document.getElementById('tracklistModalList');

    const coverUrl = item.coverImage || item.thumb || '';
    if (modalCover) {
      modalCover.src = coverUrl || '';
      modalCover.style.display = coverUrl ? 'block' : 'none';
    }
    if (largeCover) {
      largeCover.src = coverUrl || '';
      largeCover.style.display = coverUrl ? 'block' : 'none';
    }

    const displayTitle = item.album || item.title || 'Треклист альбома';
    const displaySub = `${item.artist || 'Неизвестный исполнитель'}${item.year ? ` · ${item.year}` : (item.album && item.title !== item.album ? ` · ${item.title}` : '')}`;
    if (modalTitle) modalTitle.textContent = displayTitle;
    if (modalSub) modalSub.textContent = displaySub;

    if (metaArtist) metaArtist.textContent = item.artist || 'Неизвестный исполнитель';
    if (metaAlbum) metaAlbum.textContent = displayTitle;
    if (metaBadges) {
      metaBadges.innerHTML = `
        ${item.year ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">📅 ${this.escapeHtml(item.year)}</span>` : ''}
        ${item.format ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">💽 ${this.escapeHtml(item.format)}</span>` : ''}
        ${item.country ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">🌍 ${this.escapeHtml(item.country)}</span>` : ''}
      `;
    }

    this.currentTracklistData = null;
    this.currentTracklistIndex = -1;
    this.switchTracklistMedia('cover');

    const isPlaying = Boolean(this.playingAudio && !this.playingAudio.paused);
    const curArtist = (this.currentAudioArtist || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
    const curAlbum = (this.currentAudioAlbumTitle || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
    const itemArtist = (item.artist || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
    const itemAlbum = (item.album || item.title || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]/gi, '');
    if (isPlaying && (curAlbum || curArtist)) {
      if ((curAlbum && itemAlbum && curAlbum === itemAlbum) || (curArtist && itemArtist && curArtist === itemArtist)) {
        this.setCoverPulsing(true);
      }
    } else {
      this.setCoverPulsing(false);
    }

    modal.classList.add('open');
    modal.classList.add('active');

    // Instant display from persistent/memory cache if available! (0 ms response)
    const cacheKey = item.masterId || item.discogsId || item.id;
    const nameKey = (item.artist && (item.album || item.title))
      ? `${String(item.artist).toLowerCase().trim()}:::${String(item.album || item.title).toLowerCase().trim()}`
      : null;

    let cached = this.getTracklistFromCache(cacheKey) || (nameKey ? this.getTracklistFromCache(nameKey) : null);
    if (!cached && Array.isArray(item.tracklist) && item.tracklist.length > 0) {
      cached = {
        id: item.id,
        title: item.album || item.title,
        artist: item.artist,
        year: item.year,
        cover: item.coverImage || item.thumb,
        tracklist: item.tracklist
      };
      this.saveTracklistToCache(cacheKey, cached);
      if (nameKey) this.saveTracklistToCache(nameKey, cached);
    }

    if (cached && cached.tracklist && cached.tracklist.length > 0) {
      this.renderTracklistData(cached, item);
      return;
    }

    if (loadingEl) {
      loadingEl.style.display = 'block';
      loadingEl.textContent = '⏳ Моментальная загрузка треклиста...';
    }
    if (listEl) {
      listEl.style.display = 'none';
      listEl.innerHTML = '';
    }

    try {
      let queryId = item.masterId || item.discogsId || null;
      let queryType = (this.appMode === 'albums' || item.type === 'master') ? 'master' : 'release';

      const strId = String(item.id || itemId || '');
      if (!queryId && strId) {
        if (strId.startsWith('master-')) {
          queryId = strId.replace('master-', '');
          queryType = 'master';
        } else if (strId.startsWith('discogs-')) {
          queryId = strId.replace('discogs-', '');
          queryType = 'release';
        } else if (/^\d+$/.test(strId)) {
          queryId = strId;
          queryType = (this.appMode === 'albums' || item.type === 'master') ? 'master' : 'release';
        }
      }

      const rawSpId = item.spotifyId || (strId.startsWith('sp-') ? strId.replace('sp-', '') : '');
      const reqs = [];

      // Concurrent fetch: 1. Discogs tracklist (server falls back to Spotify/Deezer automatically)
      if (queryId || (item.artist && (item.album || item.title))) {
        reqs.push(
          fetch(`/api/discogs/tracklist?id=${encodeURIComponent(queryId || '')}&type=${queryType}&artist=${encodeURIComponent(item.artist || '')}&album=${encodeURIComponent(item.album || item.title || '')}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        );
      }

      // Concurrent fetch: 2. Spotify album tracks directly
      if (rawSpId || (item.artist && (item.album || item.title))) {
        reqs.push(
          fetch(`/api/spotify/album/tracks?id=${encodeURIComponent(rawSpId || '')}&artist=${encodeURIComponent(item.artist || '')}&album=${encodeURIComponent(item.album || item.title || '')}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        );
      }

      // Settle as soon as the first request with valid tracks arrives
      let data = null;
      if (reqs.length > 0) {
        data = await new Promise(resolve => {
          let pending = reqs.length;
          let settled = false;
          reqs.forEach(p => {
            p.then(res => {
              if (settled) return;
              if (res && res.tracklist && res.tracklist.length > 0) {
                settled = true;
                resolve(res);
              } else {
                pending--;
                if (pending <= 0) {
                  settled = true;
                  resolve(res || null);
                }
              }
            }).catch(() => {
              pending--;
              if (pending <= 0 && !settled) {
                settled = true;
                resolve(null);
              }
            });
          });
        });
      }

      if (data && data.tracklist && data.tracklist.length > 0) {
        if (cacheKey) this.saveTracklistToCache(cacheKey, data);
        if (nameKey) this.saveTracklistToCache(nameKey, data);
        if (item.masterId) this.saveTracklistToCache(item.masterId, data);
      }

      this.renderTracklistData(data, item);

    } catch (err) {
      console.warn('Tracklist fetch error:', err);
      if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.textContent = `Ошибка загрузки треклиста: ${err.message || 'Сбой соединения'}`;
      }
    }
  },

  async playTrackByIndex(idx) {
    if (!this.currentTracklistData || !this.currentTracklistData.tracklist) return;
    const track = this.currentTracklistData.tracklist[idx];
    if (!track) return;

    this.currentTracklistIndex = idx;
    const title = track.title || 'Без названия';
    const artist = track.artist || this.currentTracklistData.artist || '';
    const album = this.currentTracklistData.title || '';
    const cover = this.currentTracklistData.cover || '';
    const btnId = `tracklist-play-btn-${idx}`;

    // Highlight selected row in tracklist
    document.querySelectorAll('.tracklist-item-row').forEach(r => r.classList.remove('active-track'));
    const activeRow = document.getElementById(`tracklist-row-${idx}`);
    if (activeRow) activeRow.classList.add('active-track');

    // 1. If currently in the 'video' tab, load and play video with sound from video
    if (this.currentMediaTab === 'video') {
      if (this.playingAudio) {
        this.playingAudio.pause();
        this.playingAudio = null;
        const playerEl = document.getElementById('bottomAudioPlayer');
        if (playerEl) playerEl.style.display = 'none';
        this.setCoverPulsing(false);
      }
      await this.loadAndPlayVideoForTrack(idx);
      return;
    }

    // 2. Otherwise we are in 'cover' tab (primary playback mode):
    // Play preview audio from Spotify/Deezer, keep cover visible, and pulse album!
    this.stopTrackVideo();

    // If currently playing this exact track preview, toggle play/pause
    if (this.playingAudio && this.currentAudioBtnId === btnId) {
      this.toggleAudioPlayPause();
      return;
    }

    // Reset other play buttons in the tracklist
    document.querySelectorAll('.tracklist-play-btn').forEach(b => {
      b.classList.remove('playing');
      b.textContent = '▶';
    });
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.textContent = '⏳';
      btn.classList.add('playing');
    }

    // Get preview audio URL
    let audioUrl = track.previewUrl || null;
    let previewSource = track.source || 'Spotify';
    if (!audioUrl) {
      try {
        const aRes = await fetch(`/api/track/preview?track=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);
        if (aRes.ok) {
          const aData = await aRes.json();
          if (aData && aData.previewUrl) {
            audioUrl = aData.previewUrl;
            previewSource = aData.source || 'Spotify';
          }
        }
      } catch (e) {
        console.warn('Track preview fetch error:', e);
      }
    }

    if (audioUrl) {
      this.playAudio(audioUrl, title, artist, cover, btnId, album, previewSource);
      this.setCoverPulsing(true);
      this.showToastNotification(`🎵 Воспроизведение [${previewSource}]: «${artist ? artist + ' — ' : ''}${title}»`);
    } else {
      if (btn) {
        btn.classList.remove('playing');
        btn.textContent = '✕';
        btn.title = 'Превью не найдено';
        setTimeout(() => { if (btn) btn.textContent = '▶'; }, 2000);
      }
      this.setCoverPulsing(false);
      this.showToastNotification(`Аудио-превью для «${title}» не найдено в Spotify/Deezer`);
    }
  },

  async loadAndPlayVideoForTrack(idx) {
    if (!this.currentTracklistData || !this.currentTracklistData.tracklist) return;
    const track = this.currentTracklistData.tracklist[idx];
    if (!track) return;

    const title = track.title || 'Без названия';
    const artist = track.artist || this.currentTracklistData.artist || '';

    const frame = document.getElementById('tracklistVideoFrame');
    const player = document.getElementById('tracklistVideoPlayer');
    const loading = document.getElementById('tracklistVideoLoading');
    const placeholder = document.getElementById('tracklistVideoPlaceholder');
    const loadingText = document.getElementById('tracklistVideoLoadingText');
    const nowPlaying = document.getElementById('tracklistNowPlayingInfo');
    const playingTitle = document.getElementById('tracklistPlayingSongName');
    const btn = document.getElementById(`tracklist-play-btn-${idx}`);

    if (placeholder) placeholder.style.display = 'none';
    if (frame) { frame.src = ''; frame.style.display = 'none'; }
    if (player) { player.pause(); player.src = ''; player.style.display = 'none'; }
    if (loading) loading.style.display = 'flex';
    if (loadingText) loadingText.textContent = `🎬 Загрузка официального клипа для «${artist ? artist + ' — ' : ''}${title}»...`;
    if (nowPlaying) nowPlaying.style.display = 'none';

    try {
      const res = await fetch(`/api/video/search?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.found) {
          if (loading) loading.style.display = 'none';

          if (data.type === 'youtube' && data.embedUrl) {
            if (frame) {
              frame.src = data.embedUrl.includes('autoplay=') ? data.embedUrl : `${data.embedUrl}?autoplay=1&enablejsapi=1`;
              frame.style.display = 'block';
            }
          } else if ((data.type === 'video' || data.type === 'mp4') && (data.videoUrl || data.url)) {
            if (player) {
              player.src = data.videoUrl || data.url;
              player.style.display = 'block';
              player.play().catch(() => {});
            }
          }

          if (nowPlaying) nowPlaying.style.display = 'flex';
          if (playingTitle) playingTitle.textContent = `${artist ? artist + ' — ' : ''}${title}`;
          if (btn) {
            btn.classList.add('playing');
            btn.textContent = '⏸';
          }

          this.showToastNotification(`🎬 Воспроизводится клип: «${title}» (звук из видео)`);
          return;
        }
      }
    } catch (e) {
      console.warn('Video fetch failed:', e);
    }

    if (loading) loading.style.display = 'none';
    if (placeholder) {
      placeholder.style.display = 'flex';
      placeholder.innerHTML = `<span style="font-size:28px; margin-bottom:6px;">⚠️</span><span>Видеоклип для «${this.escapeHtml(title)}» не найден</span>`;
    }
    this.showToastNotification(`Видеоклип для «${title}» не найден`);
  },

  selectTrackByIndex(idx) {
    this.playTrackByIndex(idx);
  },

  addTrackByIndex(idx) {
    if (!this.currentTracklistData || !this.currentTracklistData.tracklist) return;
    const track = this.currentTracklistData.tracklist[idx];
    if (!track) return;
    const title = track.title || 'Без названия';
    const artist = track.artist || this.currentTracklistData.artist || '';
    const album = this.currentTracklistData.title || '';
    const cover = this.currentTracklistData.cover || '';
    const duration = track.duration || '0:00';
    const rowEl = document.getElementById(`tracklist-row-${idx}`);
    this.addSongFromTracklist(title, artist, album, cover, duration, rowEl);
  },

  addSongFromTracklist(title, artist, album, coverImage, durationStr, rowEl = null) {
    const rawId = `track_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const newTrack = {
      id: `sp-${rawId}`,
      spotifyId: rawId,
      uri: '',
      title: title || 'Без названия',
      artist: artist || 'Неизвестный исполнитель',
      album: album || '',
      durationMs: 0,
      durationStr: durationStr || '0:00',
      previewUrl: null,
      coverImage: coverImage || '',
      externalUrl: '',
      status: 'buy',
      rating: 0,
      isHighValue: false,
      notes: '',
      createdAt: new Date().toISOString()
    };

    this.promptDestinationTable(newTrack.title || newTrack.artist, 'spotify', (targetTableId) => {
      this.addItemToActiveTable(newTrack, targetTableId, 'spotify');
      this.render();

      const targetTable = (this.tables.spotify || []).find(t => t.id === targetTableId);
      const tableName = targetTable ? targetTable.name : 'треков';

      // Keep modal OPEN so user can add multiple tracks!
      if (rowEl) {
        rowEl.classList.add('tracklist-item-added');
        const btn = rowEl.querySelector('.sp-btn-add, .sp-btn');
        if (btn) {
          btn.textContent = '✓ В треках';
          btn.classList.add('sp-btn-added');
          btn.classList.remove('sp-btn-add');
          btn.disabled = true;
        }
        if (rowEl.parentElement) {
          rowEl.parentElement.prepend(rowEl);
          rowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }

      this.highlightRecord(newTrack.id);
      this.showToastNotification(`✓ Песня «${newTrack.title}» добавлена в «${tableName}»`);
    });
  },

  closeAlbumTracklistModal() {
    this.clearTrackVideo();
    this.setCoverPulsing(false);
    const modal = document.getElementById('albumTracklistModal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.remove('active');
    }
  },

  showToastNotification(msg) {
    let toast = document.getElementById('appToastNotice');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'appToastNotice';
      toast.style.position = 'fixed';
      toast.style.bottom = '80px';
      toast.style.left = '50%';
      toast.style.transform = 'translateX(-50%)';
      toast.style.backgroundColor = 'rgba(23, 24, 28, 0.95)';
      toast.style.border = '1px solid rgba(255, 255, 255, 0.2)';
      toast.style.color = '#fff';
      toast.style.padding = '10px 20px';
      toast.style.borderRadius = '24px';
      toast.style.fontSize = '12.5px';
      toast.style.fontWeight = '600';
      toast.style.boxShadow = '0 8px 24px rgba(0,0,0,0.6)';
      toast.style.zIndex = '100000';
      toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      toast.style.pointerEvents = 'none';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      if (toast) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(10px)';
      }
    }, 2800);
  },

  // ----------------------------------------------------
  // Excel Import (.xlsx)
  // Merges sheets into existing tables without data loss
  // ----------------------------------------------------
  async handleExcelImport(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const parsed = ExcelExporter.parseWorkbook(data);

        let addedReleases = 0;
        let addedAlbums = 0;
        let addedSpotify = 0;

        // 1. Process Releases
        if (parsed.releases) {
          for (const [tName, items] of Object.entries(parsed.releases)) {
            let targetTable = (this.tables.releases || []).find(t => t.name.toLowerCase() === tName.toLowerCase());
            if (!targetTable) {
              targetTable = {
                id: `tbl_releases_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                name: tName,
                isCollapsed: false,
                items: []
              };
              if (!this.tables.releases) this.tables.releases = [];
              this.tables.releases.push(targetTable);
            }
            items.forEach(newItem => {
              const dup = (targetTable.items || []).some(it => 
                (it.discogsId && it.discogsId === newItem.discogsId) ||
                (it.artist?.toLowerCase() === newItem.artist?.toLowerCase() && it.title?.toLowerCase() === newItem.title?.toLowerCase())
              );
              if (!dup) {
                targetTable.items.push(newItem);
                addedReleases++;
              }
            });
          }
          this.saveModeTables('releases');
        }

        // 2. Process Albums
        if (parsed.albums) {
          for (const [tName, items] of Object.entries(parsed.albums)) {
            let targetTable = (this.tables.albums || []).find(t => t.name.toLowerCase() === tName.toLowerCase());
            if (!targetTable) {
              targetTable = {
                id: `tbl_albums_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                name: tName,
                isCollapsed: false,
                items: []
              };
              if (!this.tables.albums) this.tables.albums = [];
              this.tables.albums.push(targetTable);
            }
            items.forEach(newItem => {
              const dup = (targetTable.items || []).some(it => 
                (it.masterId && it.masterId === newItem.masterId) ||
                (it.artist?.toLowerCase() === newItem.artist?.toLowerCase() && it.title?.toLowerCase() === newItem.title?.toLowerCase())
              );
              if (!dup) {
                targetTable.items.push(newItem);
                addedAlbums++;
              }
            });
          }
          this.saveModeTables('albums');
        }

        // 3. Process Spotify Tracks
        if (parsed.spotify) {
          for (const [tName, items] of Object.entries(parsed.spotify)) {
            let targetTable = (this.tables.spotify || []).find(t => t.name.toLowerCase() === tName.toLowerCase());
            if (!targetTable) {
              targetTable = {
                id: `tbl_spotify_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                name: tName,
                isCollapsed: false,
                items: []
              };
              if (!this.tables.spotify) this.tables.spotify = [];
              this.tables.spotify.push(targetTable);
            }
            items.forEach(newItem => {
              const dup = (targetTable.items || []).some(it => 
                (it.spotifyId && it.spotifyId === newItem.spotifyId) ||
                (it.artist?.toLowerCase() === newItem.artist?.toLowerCase() && it.title?.toLowerCase() === newItem.title?.toLowerCase())
              );
              if (!dup) {
                targetTable.items.push(newItem);
                addedSpotify++;
              }
            });
          }
          this.saveModeTables('spotify');
        }

        this.render();
        alert(`✅ Успешно импортировано из Excel!\n• Пластинок: +${addedReleases}\n• Альбомов: +${addedAlbums}\n• Песен Spotify: +${addedSpotify}\nВсе ваши существующие таблицы сохранены без потерь.`);
      } catch (err) {
        console.error('Import error:', err);
        alert(`Ошибка импорта Excel: ${err.message}`);
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  },

  async loadPriceForModalItem(releaseId) {
    const previewEl = document.getElementById(`price-preview-${releaseId}`);
    if (previewEl) previewEl.innerHTML = '<span style="color:var(--text-muted); font-size:10.5px">Загрузка...</span>';

    const stats = await DiscogsClient.getPriceStats(releaseId);
    const item = (this.lastSearchResults || []).find(r => r.id === releaseId);
    if (item && stats) {
      item.priceStats = stats;
      if (typeof stats.num_for_sale === 'number') {
        item.num_for_sale = stats.num_for_sale;
      }
    }

    const saleEl = document.getElementById(`modalReleaseSaleCount-${releaseId}`);
    const card = document.getElementById(`search-item-${releaseId}`);
    if (stats && typeof stats.num_for_sale === 'number') {
      if (stats.num_for_sale > 0) {
        if (card) card.classList.remove('search-item-no-sale');
        if (saleEl) {
          saleEl.className = 'sale-badge';
          saleEl.innerHTML = `🏷 В продаже: <b>${Number(stats.num_for_sale).toLocaleString('ru-RU')} шт.</b>`;
        }
      } else {
        if (card) card.classList.add('search-item-no-sale');
        if (saleEl) {
          saleEl.className = 'sale-badge sale-badge-zero';
          saleEl.textContent = `🚫 Нет винилов в продаже`;
        }
      }
    }

    if (previewEl) {
      if (stats && (stats.has_sold_stats || stats.median_sold || stats.min_sold)) {
        const minS = stats.min_sold ? `$${Math.round(stats.min_sold)}` : '—';
        const medS = stats.median_sold ? `$${Math.round(stats.median_sold)}` : (stats.median ? `$${stats.median}` : '—');
        const maxS = stats.max_sold ? `$${Math.round(stats.max_sold)}` : '—';
        previewEl.innerHTML = `
          <div class="search-price-val" title="Медианная цена реальных прошлых продаж">${medS}</div>
          <div style="font-size:9.5px; color:var(--text-muted); line-height:1.2;">Продажи: ${minS} / ${medS} / ${maxS}</div>
        `;
      } else if (stats && stats.median) {
        previewEl.innerHTML = `
          <div class="search-price-val">$${stats.median}</div>
          <div style="font-size:10px; color:var(--text-muted)">медиана</div>
        `;
      } else if (stats && (stats.lowest_price || stats.min)) {
        const p = stats.lowest_price || stats.min;
        const cur = stats.currency || 'USD';
        const curSym = cur === 'EUR' ? '€' : (cur === 'GBP' ? '£' : '$');
        previewEl.innerHTML = `
          <div class="search-price-val">от ${curSym}${Number(p).toFixed(2)}</div>
          <div style="font-size:10px; color:var(--text-muted)">в продаже</div>
        `;
      } else {
        previewEl.innerHTML = `<span style="color:var(--text-muted); font-size:11px">Нет продаж</span>`;
      }
    }

    this.resortDiscogsSearchResults();
  },

  async addRecordFromDiscogs(releaseId) {
    const item = (this.lastSearchResults || []).find(r => r.id === releaseId);
    if (!item) return;

    let stats = item.priceStats;
    if (!stats) {
      stats = await DiscogsClient.getPriceStats(releaseId);
    }

    const companionQ = document.getElementById('companionInput')?.value.trim() || '';

    const newRecord = {
      id: `discogs-${item.id}`,
      discogsId: item.id,
      artist: item.artist || item.rawTitle,
      title: item.title || item.rawTitle,
      year: item.year || '',
      country: item.country || '',
      format: item.format || 'Vinyl',
      label: item.label || '',
      catno: item.catno || '',
      priceMin: stats && stats.min ? stats.min : (stats && stats.lowest_price ? stats.lowest_price : null),
      priceMedian: stats && stats.median ? stats.median : null,
      priceMax: stats && stats.max ? stats.max : null,
      minSold: stats && stats.min_sold ? stats.min_sold : null,
      medianSold: stats && stats.median_sold ? stats.median_sold : null,
      maxSold: stats && stats.max_sold ? stats.max_sold : null,
      currency: stats ? stats.currency : 'USD',
      status: 'buy',
      coverImage: item.coverImage || item.thumb,
      thumb: item.thumb,
      uri: item.uri,
      notes: companionQ ? `Найдено по запросу: ${companionQ}` : '',
      createdAt: new Date().toISOString()
    };

    const existing = this.findTableAndItem(newRecord.id, 'releases');
    if (existing) {
      alert(`Пластинка «${newRecord.artist} - ${newRecord.title}» уже есть в вашем списке!`);
      return;
    }

    this.promptDestinationTable(newRecord.title || newRecord.artist, 'releases', (targetTableId) => {
      this.addItemToActiveTable(newRecord, targetTableId, 'releases');
      this.render();

      const targetTable = (this.tables.releases || []).find(t => t.id === targetTableId);
      const tableName = targetTable ? targetTable.name : 'релизов';

      // Keep search modal OPEN and mark item as added, move to top!
      const modalBtn = document.getElementById(`modalBtnAddRelease-${releaseId}`)
        || document.getElementById(`modalBtnAdd-${releaseId}`);
      if (modalBtn) {
        modalBtn.textContent = '✓ В вишлисте';
        modalBtn.classList.remove('btn-primary');
        modalBtn.classList.add('btn-secondary', 'sp-btn-added');
        modalBtn.disabled = true;
      }

      const card = document.getElementById(`search-item-${releaseId}`)
        || document.querySelector(`[data-item-id="${releaseId}"]`)
        || modalBtn?.closest('.search-result-item');
      if (card) {
        card.classList.add('search-item-in-library');
        card.classList.add('tracklist-item-added');
        card.style.opacity = '0.58';
        card.style.filter = 'grayscale(100%)';
        card.style.background = 'rgba(255, 255, 255, 0.02)';
        let badge = card.querySelector('.in-library-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'in-library-badge';
          badge.textContent = `✓ В таблице: ${tableName}`;
          const badgesRow = card.querySelector('.search-tags');
          if (badgesRow) badgesRow.prepend(badge);
        }
        if (card.parentElement) {
          card.parentElement.prepend(card);
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }

      this.highlightRecord(newRecord.id);
      this.showToastNotification(`✓ Пластинка «${newRecord.title}» добавлена в «${tableName}»`);
    });
  },

  switchToManualAdd(prefill = '') {
    document.getElementById('discogsSearchModal')?.classList.remove('open');
    this.openManualAddModal({
      artist: prefill,
      title: ''
    });
  },

  // ----------------------------------------------------
  // Manual Add / Edit Modal
  // ----------------------------------------------------
  openManualAddModal(prefill = null) {
    this.editingRecordId = null;
    const form = document.getElementById('manualRecordForm');
    if (form) form.reset();

    document.getElementById('manualModalTitle').textContent = this.appMode === 'spotify'
      ? 'Добавить песню вручную'
      : (this.appMode === 'albums' ? 'Добавить альбом вручную' : 'Добавить виниловую пластинку вручную');

    const statusEl = document.getElementById('manualStatus');
    if (statusEl) statusEl.value = 'buy';

    const targetSel = document.getElementById('manualTargetTable');
    if (targetSel) {
      const tbls = this.getActiveModeTables();
      targetSel.innerHTML = tbls.map(t => `<option value="${t.id}" ${t.id === this.activeTableId ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('');
    }

    if (prefill) {
      if (prefill.artist) document.getElementById('manualArtist').value = prefill.artist;
      if (prefill.title) document.getElementById('manualTitle').value = prefill.title;
    }

    document.getElementById('manualRecordModal')?.classList.add('open');
    setTimeout(() => document.getElementById('manualArtist')?.focus(), 100);
  },

  openEditRecordModal(id) {
    const found = this.findTableAndItem(id, this.appMode, true);
    if (!found) return;
    const record = found.item;

    this.editingRecordId = id;
    document.getElementById('manualModalTitle').textContent = this.appMode === 'spotify' 
      ? 'Редактировать песню' 
      : (this.appMode === 'albums' ? 'Редактировать альбом' : 'Редактировать пластинку');

    document.getElementById('manualArtist').value = record.artist || '';
    document.getElementById('manualTitle').value = record.title || '';
    document.getElementById('manualYear').value = record.year || '';
    document.getElementById('manualCountry').value = record.country || '';
    document.getElementById('manualFormat').value = record.format || 'Vinyl';
    document.getElementById('manualLabel').value = record.album || record.label || '';
    document.getElementById('manualPriceMin').value = record.priceMin || '';
    document.getElementById('manualPriceMedian').value = record.priceMedian || '';
    document.getElementById('manualPriceMax').value = record.priceMax || '';
    document.getElementById('manualCoverUrl').value = record.coverImage || '';
    document.getElementById('manualStatus').value = this.getStatusInfo(record.status).status;
    document.getElementById('manualNotes').value = record.notes || '';

    const targetSel = document.getElementById('manualTargetTable');
    if (targetSel) {
      const tbls = this.getActiveModeTables();
      targetSel.innerHTML = tbls.map(t => `<option value="${t.id}" ${t.id === found.table.id ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('');
    }

    document.getElementById('manualRecordModal')?.classList.add('open');
  },

  async saveManualRecord() {
    const artist = document.getElementById('manualArtist').value.trim();
    const title = document.getElementById('manualTitle').value.trim();
    const year = document.getElementById('manualYear').value.trim();
    const country = document.getElementById('manualCountry').value.trim();
    const format = document.getElementById('manualFormat').value.trim();
    const label = document.getElementById('manualLabel').value.trim();
    const priceMin = parseFloat(document.getElementById('manualPriceMin').value) || null;
    const priceMedian = parseFloat(document.getElementById('manualPriceMedian').value) || null;
    const priceMax = parseFloat(document.getElementById('manualPriceMax').value) || null;
    const coverImage = document.getElementById('manualCoverUrl').value.trim();
    const status = document.getElementById('manualStatus').value || 'buy';
    const notes = document.getElementById('manualNotes').value.trim();
    const targetTableId = document.getElementById('manualTargetTable')?.value || null;

    if (!artist || !title) {
      alert('Укажите как минимум исполнителя и название');
      return;
    }

    let savedId = null;

    if (this.appMode === 'spotify') {
      if (this.editingRecordId) {
        const found = this.findTableAndItem(this.editingRecordId, 'spotify', true);
        if (found) {
          found.item.title = title;
          found.item.artist = artist;
          found.item.album = label || found.item.album || '';
          found.item.coverImage = coverImage || found.item.coverImage;
          found.item.status = status;
          found.item.notes = notes;
          savedId = found.item.id;
          if (targetTableId && targetTableId !== found.table.id) {
            found.table.items.splice(found.index, 1);
            const newTarget = this.tables.spotify.find(t => t.id === targetTableId);
            if (newTarget) {
              newTarget.isCollapsed = false;
              (newTarget.items = newTarget.items || []).unshift(found.item);
            }
          }
          this.saveModeTables('spotify');
        }
      } else {
        const track = {
          id: `manual-sp-${Date.now()}`,
          spotifyId: `manual_${Date.now()}`,
          title,
          artist,
          album: label || '',
          durationMs: 180000,
          durationStr: '3:00',
          coverImage,
          status: status || 'buy',
          rating: 0,
          isHighValue: false,
          notes,
          createdAt: new Date().toISOString()
        };
        this.addItemToActiveTable(track, targetTableId, 'spotify');
        savedId = track.id;
      }
    } else if (this.appMode === 'albums') {
      if (this.editingRecordId) {
        const found = this.findTableAndItem(this.editingRecordId, 'albums', true);
        if (found) {
          found.item.title = title;
          found.item.artist = artist;
          found.item.year = year;
          found.item.coverImage = coverImage || found.item.coverImage;
          found.item.status = status;
          found.item.notes = notes;
          savedId = found.item.id;
          if (targetTableId && targetTableId !== found.table.id) {
            found.table.items.splice(found.index, 1);
            const newTarget = this.tables.albums.find(t => t.id === targetTableId);
            if (newTarget) {
              newTarget.isCollapsed = false;
              (newTarget.items = newTarget.items || []).unshift(found.item);
            }
          }
          this.saveModeTables('albums');
        }
      } else {
        const album = {
          id: `manual-album-${Date.now()}`,
          masterId: `m-${Date.now()}`,
          artist,
          title,
          year,
          coverImage,
          versionsCount: 1,
          status: status || 'buy',
          rating: 0,
          isHighValue: false,
          notes,
          createdAt: new Date().toISOString()
        };
        this.addItemToActiveTable(album, targetTableId, 'albums');
        savedId = album.id;
      }
    } else {
      let record;
      if (this.editingRecordId) {
        const found = this.findTableAndItem(this.editingRecordId, 'releases', true);
        if (found) {
          record = found.item;
          record.artist = artist;
          record.title = title;
          record.year = year;
          record.country = country;
          record.format = format;
          record.label = label;
          record.priceMin = priceMin;
          record.priceMedian = priceMedian;
          record.priceMax = priceMax;
          record.coverImage = coverImage || record.coverImage;
          record.status = status;
          record.notes = notes;
          savedId = record.id;

          // If target table changed
          if (targetTableId && targetTableId !== found.table.id) {
            found.table.items.splice(found.index, 1);
            const newTarget = this.tables.releases.find(t => t.id === targetTableId);
            if (newTarget) {
              newTarget.isCollapsed = false;
              (newTarget.items = newTarget.items || []).unshift(record);
            }
          }

          this.saveModeTables('releases');
          FirebaseSync.saveRecord(record);
        }
      } else {
        record = {
          id: `manual-${Date.now()}`,
          artist,
          title,
          year,
          country,
          format: format || 'Vinyl',
          label,
          priceMin,
          priceMedian,
          priceMax,
          currency: 'USD',
          coverImage,
          status: status || 'buy',
          rating: 0,
          isHighValue: false,
          notes,
          createdAt: new Date().toISOString()
        };
        this.addItemToActiveTable(record, targetTableId, 'releases');
        savedId = record.id;
      }
    }

    this.editingRecordId = null;
    const modal = document.getElementById('manualRecordModal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.remove('active');
    }
    const form = document.getElementById('manualRecordForm');
    if (form) form.reset();

    this.render();

    if (savedId) {
      this.highlightRecord(savedId);
    }
  },

  // ----------------------------------------------------
  // Discogs Account & OAuth Flow
  // ----------------------------------------------------
  openDiscogsSettingsModal() {
    const tokenInput = document.getElementById('discogsTokenInput');
    const currentToken = DiscogsClient.getToken();
    if (tokenInput) tokenInput.value = currentToken;

    this.updateDiscogsUIStatus();
    document.getElementById('discogsSettingsModal')?.classList.add('open');
  },

  loginWithDiscogsOAuth() {
    const consumerKey = document.getElementById('discogsConsumerKey')?.value.trim() || '';
    const consumerSecret = document.getElementById('discogsConsumerSecret')?.value.trim() || '';

    let url = '/api/discogs/auth/login';
    if (consumerKey && consumerSecret) {
      url += `?consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`;
    }

    window.location.href = url;
  },

  async updateDiscogsUIStatus() {
    const user = DiscogsClient.getUser();
    const badge = document.getElementById('discogsHeaderBadge');
    const profileBox = document.getElementById('discogsProfileBox');

    if (user && user.username) {
      if (badge) {
        badge.innerHTML = `<span class="dot online"></span> Discogs: <strong>@${this.escapeHtml(user.username)}</strong>`;
        badge.classList.add('active');
      }
      if (profileBox) {
        profileBox.style.display = 'block';
        profileBox.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:var(--bg-surface-elevated); border-radius:var(--radius-sm); border:1px solid rgba(34, 197, 94, 0.3);">
            <div style="display:flex; align-items:center; gap:12px;">
              ${user.avatar_url ? `<img src="${this.escapeHtml(user.avatar_url)}" style="width:42px; height:42px; border-radius:50%; object-fit:cover;">` : '<div style="width:42px; height:42px; background:#333; border-radius:50%; display:flex; align-items:center; justify-content:center;">👤</div>'}
              <div>
                <div style="font-weight:700; color:var(--text-primary); font-size:14px;">@${this.escapeHtml(user.username)}</div>
                <div style="font-size:11.5px; color:var(--text-secondary)">
                  В коллекции на Discogs: <strong>${user.num_collection || 0}</strong> пластинок
                </div>
              </div>
            </div>
            <button class="btn btn-sm btn-secondary" onclick="App.logoutDiscogs()">Выйти</button>
          </div>
        `;
      }
    } else {
      if (badge) {
        badge.innerHTML = `<span class="dot"></span> Войти через Discogs`;
        badge.classList.remove('active');
      }
      if (profileBox) {
        profileBox.style.display = 'none';
      }
    }
  },

  logoutDiscogs() {
    DiscogsClient.setToken('');
    DiscogsClient.setUser(null);
    this.updateDiscogsUIStatus();
    alert('Вы вышли из аккаунта Discogs.');
  },

  async verifyAndSaveDiscogsToken() {
    const tokenInput = document.getElementById('discogsTokenInput');
    const token = tokenInput ? tokenInput.value.trim() : '';
    const statusMsg = document.getElementById('discogsTokenStatus');

    if (!token) {
      DiscogsClient.setToken('');
      DiscogsClient.setUser(null);
      this.updateDiscogsUIStatus();
      if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--text-muted)">Токен удален.</span>';
      return;
    }

    if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--accent-theme)">Проверка токена на Discogs...</span>';

    try {
      const user = await DiscogsClient.checkIdentity(token);
      DiscogsClient.setToken(token);
      DiscogsClient.setUser(user);
      this.updateDiscogsUIStatus();

      if (statusMsg) {
        statusMsg.innerHTML = `<span style="color:var(--status-owned)">✓ Успешно авторизован как @${this.escapeHtml(user.username)}!</span>`;
      }
    } catch (err) {
      if (statusMsg) {
        statusMsg.innerHTML = `<span style="color:var(--danger)">Ошибка: ${this.escapeHtml(err.message)}</span>`;
      }
    }
  },

  async startDiscogsTransfer() {
    const user = DiscogsClient.getUser();
    if (!user || !user.username) {
      alert('Сначала войдите в свой аккаунт Discogs.');
      return;
    }

    const folderNameInput = document.getElementById('discogsFolderNameInput');
    const folderName = (folderNameInput ? folderNameInput.value.trim() : '') || 'YouTube Wishlist';
    const targetMode = document.querySelector('input[name="discogsTargetMode"]:checked')?.value || 'collection';
    const scopeMode = document.querySelector('input[name="discogsScopeMode"]:checked')?.value || 'all';

    let toExport = [];
    if (scopeMode === 'selected') {
      toExport = this.records.filter(r => this.selectedIds.has(String(r.id)) && r.discogsId);
    } else {
      toExport = this.records.filter(r => r.discogsId);
    }

    if (toExport.length === 0) {
      alert('Нет записей с привязкой к Discogs для экспорта. Переключитесь в режим винила и добавьте пластинки.');
      return;
    }

    const progressBox = document.getElementById('discogsSyncProgressBox');
    const progressBar = document.getElementById('discogsProgressBar');
    const progressText = document.getElementById('discogsProgressText');
    const btnStart = document.getElementById('btnStartTransfer');

    if (progressBox) progressBox.style.display = 'block';
    if (progressBar) progressBar.style.width = '0%';
    if (btnStart) btnStart.disabled = true;

    try {
      let folderId = 1;

      if (targetMode === 'collection') {
        progressText.textContent = `Создание / поиск папки «${folderName}» на Discogs...`;
        
        const existingFolders = await DiscogsClient.getFolders(user.username);
        const found = existingFolders.find(f => f.name.toLowerCase() === folderName.toLowerCase());

        if (found) {
          folderId = found.id;
        } else {
          const newFolder = await DiscogsClient.createFolder(folderName, user.username);
          folderId = newFolder.id;
        }
      }

      progressText.textContent = `Синхронизация ${toExport.length} пластинок (с паузой для соблюдения лимитов API Discogs)...`;

      const result = await DiscogsClient.syncRecords(
        toExport.map(r => ({ id: r.discogsId, notes: r.notes })),
        {
          username: user.username,
          folderId: folderId,
          mode: targetMode
        }
      );

      if (progressBar) progressBar.style.width = '100%';
      if (progressText) {
        progressText.innerHTML = `<span style="color:var(--status-owned)">✓ Готово! Успешно перенесено: ${result.successCount} из ${result.total}.</span>`;
      }

    } catch (err) {
      if (progressText) {
        progressText.innerHTML = `<span style="color:var(--danger)">Ошибка переноса: ${this.escapeHtml(err.message)}</span>`;
      }
    } finally {
      if (btnStart) btnStart.disabled = false;
    }
  },

  switchDiscogsTab(tab) {
    const tabExport = document.getElementById('tabBtnExportDiscogs');
    const tabImport = document.getElementById('tabBtnImportDiscogs');
    const panelExport = document.getElementById('discogsExportTab');
    const panelImport = document.getElementById('discogsImportTab');
    const progressBox = document.getElementById('discogsSyncProgressBox');
    if (progressBox) progressBox.style.display = 'none';

    if (tab === 'import') {
      tabImport?.classList.add('active');
      tabExport?.classList.remove('active');
      if (panelExport) panelExport.style.display = 'none';
      if (panelImport) panelImport.style.display = 'block';
      this.loadDiscogsFolders();
    } else {
      tabExport?.classList.add('active');
      tabImport?.classList.remove('active');
      if (panelExport) panelExport.style.display = 'block';
      if (panelImport) panelImport.style.display = 'none';
    }
  },

  async loadDiscogsFolders() {
    const user = DiscogsClient.getUser();
    const select = document.getElementById('discogsImportFolderSelect');
    if (!select) return;

    if (!user || !user.username) {
      select.innerHTML = '<option value="">Сначала авторизуйтесь в Discogs</option>';
      return;
    }

    try {
      const folders = await DiscogsClient.getFolders(user.username);
      let html = '<option value="0">Все пластинки коллекции (All - папка 0)</option>';
      folders.forEach(f => {
        if (f.id !== 0) {
          html += `<option value="${f.id}">${this.escapeHtml(f.name)} (${f.count || 0})</option>`;
        }
      });
      html += '<option value="wantlist">⭐ Официальный Wantlist (Список желаемого)</option>';
      select.innerHTML = html;
    } catch (e) {
      console.error('Error loading Discogs folders:', e);
      select.innerHTML = '<option value="0">Все пластинки (All)</option><option value="wantlist">⭐ Официальный Wantlist</option>';
    }
  },

  async startDiscogsImport() {
    const user = DiscogsClient.getUser();
    if (!user || !user.username) {
      alert('Сначала войдите в свой аккаунт Discogs (кнопка выше).');
      return;
    }

    const select = document.getElementById('discogsImportFolderSelect');
    const folderVal = select ? select.value : '0';
    const destMode = document.querySelector('input[name="discogsImportDest"]:checked')?.value || 'releases';

    const progressBox = document.getElementById('discogsSyncProgressBox');
    const progressBar = document.getElementById('discogsProgressBar');
    const progressText = document.getElementById('discogsProgressText');
    const btnImport = document.getElementById('btnStartImport');

    if (progressBox) progressBox.style.display = 'block';
    if (progressBar) progressBar.style.width = '10%';
    if (btnImport) btnImport.disabled = true;

    try {
      progressText.textContent = folderVal === 'wantlist'
        ? 'Загрузка списка Wantlist из Discogs...'
        : `Загрузка пластинок из папки #${folderVal} на Discogs...`;

      let items = [];
      if (folderVal === 'wantlist') {
        const res = await DiscogsClient.getUserWants(1, 100, user.username);
        items = res.wants || [];
      } else {
        const res = await DiscogsClient.getFolderReleases(Number(folderVal), 1, 100, user.username);
        items = res.releases || [];
      }

      if (items.length === 0) {
        if (progressText) progressText.innerHTML = '<span style="color:var(--text-muted)">В выбранной папке/Wantlist нет записей.</span>';
        return;
      }

      if (progressBar) progressBar.style.width = '40%';
      progressText.textContent = `Обработка ${items.length} записей из Discogs...`;

      let importedCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const info = item.basic_information || {};
        const discogsId = info.id || item.id;
        const artist = Array.isArray(info.artists) && info.artists.length > 0
          ? info.artists.map(a => a.name.replace(/\\s\\(\\d+\\)$/, '')).join(', ')
          : 'Unknown Artist';
        const title = info.title || 'Untitled';
        const year = info.year || null;
        const country = info.country || 'Unknown';
        const format = Array.isArray(info.formats) && info.formats.length > 0
          ? info.formats.map(f => f.name).join(', ')
          : 'Vinyl';
        const label = Array.isArray(info.labels) && info.labels.length > 0
          ? info.labels[0].name
          : '';
        const coverImage = info.thumb || info.cover_image || '';

        if (destMode === 'releases') {
          const allReleases = this.getAllItemsInMode('releases');
          const exists = allReleases.some(r => String(r.discogsId) === String(discogsId));
          if (exists) {
            skippedCount++;
            continue;
          }

          const record = {
            id: 'rec_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            discogsId: discogsId,
            artist,
            title,
            year,
            country,
            format,
            label,
            priceMin: null,
            priceMedian: null,
            priceMax: null,
            currency: 'USD',
            coverImage,
            status: folderVal === 'wantlist' ? 'buy' : 'owned',
            rating: 0,
            isHighValue: false,
            notes: 'Импорт из Discogs: ' + (folderVal === 'wantlist' ? 'Wantlist' : `Папка #${folderVal}`),
            createdAt: new Date().toISOString()
          };

          this.addItemToActiveTable(record, null, 'releases');
          importedCount++;
        } else {
          const masterId = info.master_id || discogsId;
          const allAlbums = this.getAllItemsInMode('albums');
          const exists = allAlbums.some(a => String(a.masterId) === String(masterId));
          if (exists) {
            skippedCount++;
            continue;
          }

          const album = {
            id: 'alb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            masterId: masterId,
            artist,
            title,
            year,
            country,
            versionsCount: 1,
            coverImage,
            status: folderVal === 'wantlist' ? 'buy' : 'owned',
            rating: 0,
            isHighValue: false,
            notes: 'Импорт из Discogs: ' + (folderVal === 'wantlist' ? 'Wantlist' : `Папка #${folderVal}`),
            createdAt: new Date().toISOString()
          };

          this.addItemToActiveTable(album, null, 'albums');
          importedCount++;
        }

        const pct = Math.min(95, Math.round(40 + (i / items.length) * 55));
        if (progressBar) progressBar.style.width = `${pct}%`;
      }

      this.saveModeTables(destMode);

      if (progressBar) progressBar.style.width = '100%';
      if (progressText) {
        progressText.innerHTML = `<span style="color:var(--status-owned)">✓ Готово! Импортировано: ${importedCount}, пропущено дубликатов: ${skippedCount}.</span>`;
      }

      this.render();
    } catch (err) {
      console.error('Discogs Import Error:', err);
      if (progressText) {
        progressText.innerHTML = `<span style="color:var(--danger)">Ошибка импорта: ${this.escapeHtml(err.message)}</span>`;
      }
    } finally {
      if (btnImport) btnImport.disabled = false;
    }
  },

  exportAlbumsExcel() {
    if (!window.XLSX) {
      alert('Библиотека экспорта не загружена.');
      return;
    }
    if (this.albums.length === 0) {
      alert('В каталоге альбомов нет записей для экспорта.');
      return;
    }

    const data = [
      ['Исполнитель', 'Альбом', 'Год выпуска', 'Кол-во виниловых изданий', 'Статус', 'Ссылка Discogs', 'Заметки']
    ];

    this.albums.forEach(a => {
      let statusText = 'В поиске';
      if (a.status === 'owned') statusText = 'Куплено';
      if (a.status === 'planned') statusText = 'В планах';

      data.push([
        a.artist || '',
        a.title || '',
        a.year || '',
        a.versionsCount || '',
        statusText,
        a.uri || (a.masterId ? `https://www.discogs.com/master/${a.masterId}` : ''),
        a.notes || ''
      ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 22 }, { wch: 30 }, { wch: 12 }, { wch: 25 }, { wch: 14 }, { wch: 36 }, { wch: 30 }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Альбомы');
    const dateStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `albums_catalog_${dateStr}.xlsx`);
  },

  // ----------------------------------------------------
  // Spotify Account & Playlist Transfer Modal
  // ----------------------------------------------------
  openSpotifyModal() {
    const user = SpotifyClient.getUser();
    const clientId = SpotifyClient.getClientId();
    const clientSecret = SpotifyClient.getClientSecret();
    const token = SpotifyClient.getToken();

    const clientIdInput = document.getElementById('spotifyClientIdInput');
    const clientSecretInput = document.getElementById('spotifyClientSecretInput');
    const tokenInput = document.getElementById('spotifyTokenInput');
    const warningEl = document.getElementById('spotifyAuthWarning');
    const scopeSelCount = document.getElementById('spotifyScopeSelCount');
    const zeroNotice = document.getElementById('spotifyZeroSelectedNotice');
    const btnStart = document.getElementById('btnStartSpotifyTransfer');

    if (clientIdInput) clientIdInput.value = clientId || '';
    if (clientSecretInput) clientSecretInput.value = clientSecret || '';
    if (tokenInput) tokenInput.value = token || '';
    const redirectInput = document.getElementById('spotifyRedirectUriInput');
    if (redirectInput) {
      redirectInput.value = window.location.origin + '/api/spotify/auth/callback';
    }

    const selectedCount = this.selectedIds.size;
    if (scopeSelCount) scopeSelCount.textContent = selectedCount;
    if (zeroNotice) zeroNotice.style.display = selectedCount === 0 ? 'block' : 'none';
    if (btnStart) btnStart.disabled = (selectedCount === 0);

    if (warningEl) {
      warningEl.style.display = (user && (user.id || user.display_name)) ? 'none' : 'block';
    }

    this.updateSpotifyUIStatus();
    document.getElementById('spotifyModal')?.classList.add('open');
  },

  copySpotifyRedirectUri() {
    const uri = window.location.origin + '/api/spotify/auth/callback';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(uri).then(() => {
        alert('Redirect URI скопирован в буфер обмена:\n' + uri);
      }).catch(() => {
        prompt('Скопируйте Redirect URI:', uri);
      });
    } else {
      prompt('Скопируйте Redirect URI:', uri);
    }
  },

  switchSpotifyTab(tab) {
    const tabTransfer = document.getElementById('tabBtnSpotifyTransfer');
    const tabAccount = document.getElementById('tabBtnSpotifyAccount');
    const panelTransfer = document.getElementById('spotifyTransferTab');
    const panelAccount = document.getElementById('spotifyAccountTab');
    const progressBox = document.getElementById('spotifyTransferProgressBox');
    if (progressBox) progressBox.style.display = 'none';

    if (tab === 'account') {
      tabAccount?.classList.add('active');
      tabTransfer?.classList.remove('active');
      if (panelTransfer) panelTransfer.style.display = 'none';
      if (panelAccount) panelAccount.style.display = 'block';
    } else {
      tabTransfer?.classList.add('active');
      tabAccount?.classList.remove('active');
      if (panelTransfer) panelTransfer.style.display = 'block';
      if (panelAccount) panelAccount.style.display = 'none';
    }
  },

  async saveSpotifyCredentials() {
    const clientId = document.getElementById('spotifyClientIdInput')?.value.trim() || '';
    const clientSecret = document.getElementById('spotifyClientSecretInput')?.value.trim() || '';
    const token = document.getElementById('spotifyTokenInput')?.value.trim() || '';
    const statusMsg = document.getElementById('spotifyTokenStatus');

    if (!clientId || !clientSecret) {
      alert('Укажите оба ключа: Spotify Client ID и Spotify Client Secret из вашего Spotify Dashboard.');
      return;
    }

    if (statusMsg) {
      statusMsg.innerHTML = '<span style="color:var(--accent-theme);">Проверка ключей в Spotify API...</span>';
    }

    try {
      if (clientId && clientSecret) {
        const res = await SpotifyClient.saveCredentials(clientId, clientSecret);
        SpotifyClient.setUser({
          id: clientId.substring(0, 8),
          display_name: `Ключ API (${clientId.substring(0, 6)}...)`,
          isApiKey: true
        });
        this.updateSpotifyUIStatus();
        if (statusMsg) {
          statusMsg.innerHTML = `
            <div style="color:var(--status-owned); margin-bottom: 4px; font-weight:700; font-size:13px;">
              ✓ Вход по ключу выполнен! Аккаунт Spotify подключен.
            </div>
            <div style="color:var(--text-secondary); font-size: 11.5px;">
              Ключи сохранены и проверены в Spotify API. Вы можете переносить выбранные треки в плейлисты.
            </div>
          `;
        }
      }

      if (token) {
        SpotifyClient.setToken(token);
        await this.verifyAndSaveSpotifyToken();
      }
    } catch (err) {
      if (statusMsg) {
        statusMsg.innerHTML = `<span style="color:var(--danger); font-weight:600;">⚠️ ${this.escapeHtml(err.message)}</span>`;
      }
    }
  },

  async verifyAndSaveSpotifyToken() {
    const input = document.getElementById('spotifyTokenInput');
    const token = input ? input.value.trim() : '';
    const statusMsg = document.getElementById('spotifyTokenStatus');

    if (!token) {
      SpotifyClient.setToken('');
      SpotifyClient.setUser(null);
      this.updateSpotifyUIStatus();
      if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--text-muted)">Токен удален.</span>';
      return;
    }

    if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--accent-theme)">Проверка токена Spotify...</span>';

    try {
      const user = await SpotifyClient.checkIdentity(token);
      SpotifyClient.setToken(token);
      SpotifyClient.setUser(user);
      this.updateSpotifyUIStatus();

      const warningEl = document.getElementById('spotifyAuthWarning');
      if (warningEl) warningEl.style.display = 'none';

      if (statusMsg) {
        statusMsg.innerHTML = `<span style="color:var(--accent-theme)">✓ Авторизован как <strong>${this.escapeHtml(user.display_name || user.id)}</strong>!</span>`;
      }
    } catch (err) {
      if (statusMsg) {
        statusMsg.innerHTML = `<span style="color:var(--danger)">Ошибка проверки: ${this.escapeHtml(err.message)}</span>`;
      }
    }
  },

  loginWithSpotifyOAuth() {
    const cidInput = document.getElementById('spotifyClientIdInput');
    const csecInput = document.getElementById('spotifyClientSecretInput');
    const clientId = (cidInput ? cidInput.value.trim() : '') || SpotifyClient.getClientId();
    const clientSecret = (csecInput ? csecInput.value.trim() : '') || SpotifyClient.getClientSecret();

    if (!clientId || !clientSecret) {
      alert('Перед входом укажите Client ID и Client Secret из Spotify Developer Dashboard и нажмите «Сохранить».');
      this.switchSpotifyTab('account');
      return;
    }

    SpotifyClient.setClientId(clientId);
    SpotifyClient.setClientSecret(clientSecret);

    const redirectUri = window.location.origin + '/api/spotify/auth/callback';
    const url = `/api/spotify/auth/login?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    window.location.href = url;
  },

  updateSpotifyUIStatus() {
    const user = SpotifyClient.getUser();
    const badge = document.getElementById('spotifyHeaderBadge');
    const profileBox = document.getElementById('spotifyProfileBox');
    const warningEl = document.getElementById('spotifyAuthWarning');

    if (warningEl) {
      warningEl.style.display = SpotifyClient.isAuthenticated() ? 'none' : 'block';
    }

    if (user && (user.id || user.display_name)) {
      const name = user.display_name || user.id;
      if (badge) {
        badge.innerHTML = `<span class="dot online"></span> Spotify: <strong>@${this.escapeHtml(name)}</strong>`;
        badge.classList.add('active');
      }
      if (profileBox) {
        profileBox.style.display = 'block';
        if (user.isApiKey) {
          profileBox.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:var(--bg-surface-elevated); border-radius:var(--radius-sm); border:1px solid rgba(30, 215, 96, 0.4);">
              <div style="display:flex; align-items:center; gap:12px;">
                <div style="width:42px; height:42px; background:#1ed760; color:#000; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:18px;">🔑</div>
                <div>
                  <div style="font-weight:700; color:var(--text-primary); font-size:14px;">Spotify подключен по ключу API</div>
                  <div style="font-size:11.5px; color:var(--text-secondary)">
                    Client ID: <code>${this.escapeHtml(SpotifyClient.getClientId().substring(0, 8))}...</code> • Статус: <strong>Активен</strong>
                  </div>
                </div>
              </div>
              <button class="btn btn-sm btn-secondary" onclick="App.logoutSpotify()">Отвязать</button>
            </div>
          `;
        } else {
          const avatar = user.images && user.images.length > 0 ? user.images[0].url : null;
          profileBox.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:var(--bg-surface-elevated); border-radius:var(--radius-sm); border:1px solid rgba(30, 215, 96, 0.3);">
              <div style="display:flex; align-items:center; gap:12px;">
                ${avatar ? `<img src="${this.escapeHtml(avatar)}" style="width:42px; height:42px; border-radius:50%; object-fit:cover;">` : '<div style="width:42px; height:42px; background:#1ed760; color:#000; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700;">S</div>'}
                <div>
                  <div style="font-weight:700; color:var(--text-primary); font-size:14px;">${this.escapeHtml(name)}</div>
                  <div style="font-size:11.5px; color:var(--text-secondary)">
                    Подписчиков: <strong>${user.followers?.total || 0}</strong> • Страна: <strong>${user.country || '—'}</strong>
                  </div>
                </div>
              </div>
              <button class="btn btn-sm btn-secondary" onclick="App.logoutSpotify()">Выйти</button>
            </div>
          `;
        }
      }
    } else {
      if (badge) {
        badge.innerHTML = `<span class="dot"></span> Войти в Spotify`;
        badge.classList.remove('active');
      }
      if (profileBox) {
        profileBox.style.display = 'none';
      }
    }
  },

  logoutSpotify() {
    SpotifyClient.setToken('');
    SpotifyClient.setUser(null);
    SpotifyClient.setClientId('');
    SpotifyClient.setClientSecret('');
    this.updateSpotifyUIStatus();
    const warningEl = document.getElementById('spotifyAuthWarning');
    if (warningEl) warningEl.style.display = 'block';
    alert('Вы вышли из аккаунта Spotify и отвязали ключи.');
  },

  async startSpotifyPlaylistTransfer() {
    if (!SpotifyClient.isAuthenticated()) {
      this.switchSpotifyTab('account');
      alert('Сначала укажите ключи Spotify (вкладка «Аккаунт Spotify»).');
      return;
    }

    const nameInput = document.getElementById('spotifyPlaylistNameInput');
    const playlistName = (nameInput ? nameInput.value.trim() : '') || 'Vinyl Hunter Tracks';
    const isPublic = document.getElementById('spotifyPlaylistIsPublic')?.checked !== false;

    // Strict selection-only transfer
    const allTracks = this.getAllItemsInMode('spotify');
    const targetTracks = allTracks.filter(t => this.selectedIds.has(String(t.id)));

    if (targetTracks.length === 0) {
      alert('Внимание: перенос выполняется ТОЛЬКО для выбранных позиций! Пожалуйста, отметьте галочками нужные треки в таблице.');
      return;
    }

    // Collect Spotify track URIs (spotify:track:...)
    const uris = targetTracks.map(t => {
      if (t.uri && t.uri.startsWith('spotify:track:')) return t.uri;
      if (t.spotifyUri && t.spotifyUri.startsWith('spotify:track:')) return t.spotifyUri;
      if (t.spotifyId && !t.spotifyId.startsWith('itunes_') && !t.spotifyId.startsWith('manual_')) return `spotify:track:${t.spotifyId}`;
      if (t.id && !String(t.id).includes('-') && !isNaN(t.id)) return `spotify:track:${t.id}`;
      return null;
    }).filter(Boolean);

    if (uris.length === 0) {
      alert('У выбранных треков нет валидных Spotify URI для добавления в плейлист.');
      return;
    }

    const progressBox = document.getElementById('spotifyTransferProgressBox');
    const progressBar = document.getElementById('spotifyProgressBar');
    const progressText = document.getElementById('spotifyProgressText');
    const btnStart = document.getElementById('btnStartSpotifyTransfer');

    if (progressBox) progressBox.style.display = 'block';
    if (progressBar) progressBar.style.width = '20%';
    if (btnStart) btnStart.disabled = true;

    try {
      progressText.textContent = `Подготовка переноса треков «${playlistName}» в Spotify...`;
      if (progressBar) progressBar.style.width = '50%';

      let res = null;
      if (SpotifyClient.getToken()) {
        try {
          res = await SpotifyClient.createPlaylistAndAddTracks(playlistName, uris, isPublic);
        } catch (apiErr) {
          console.warn('Direct API playlist creation requires user token, providing direct transfer bridge:', apiErr);
        }
      }

      if (progressBar) progressBar.style.width = '100%';

      // Copy URIs to clipboard
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(uris.join('\n'));
        }
      } catch (e) {}

      if (res && res.success) {
        const playlistUrl = res.playlistUrl || (res.playlistId ? `https://open.spotify.com/playlist/${res.playlistId}` : '#');
        progressText.innerHTML = `
          <span style="color:var(--accent-theme); font-weight:700;">✓ Плейлист успешно создан в вашем Spotify!</span><br>
          Добавлено треков: <strong>${res.addedCount || uris.length}</strong>.<br>
          <a href="${playlistUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block; margin-top:8px;" class="btn btn-sm btn-primary">
            🎵 Открыть созданный плейлист в Spotify ↗
          </a>
        `;
      } else {
        const urisText = uris.join('\n');
        progressText.innerHTML = `
          <div style="background:rgba(30,215,96,0.1); border:1px solid rgba(30,215,96,0.4); border-radius:8px; padding:12px; margin-top:6px; text-align:left;">
            <div style="color:var(--accent-theme); font-weight:700; font-size:13.5px; margin-bottom:4px;">
              ✓ Треки готовы к переносу в Spotify (${uris.length} шт.)!
            </div>
            <div style="color:var(--text-secondary); font-size:12px; line-height:1.5; margin-bottom:10px;">
              Список треков <strong>скопирован в ваш буфер обмена</strong>. Откройте Spotify (Desktop или Web), создайте плейлист «${this.escapeHtml(playlistName)}» и нажмите <strong>Ctrl+V</strong> (вставить). Все песни мгновенно добавятся!
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              <a href="https://open.spotify.com" target="_blank" class="btn btn-sm btn-primary" style="text-decoration:none;">
                🎵 Открыть Spotify Web Player ↗
              </a>
              <button type="button" class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText(${JSON.stringify(urisText)}); alert('Список Spotify URI скопирован!');">
                📋 Скопировать треки еще раз
              </button>
            </div>
            <div style="margin-top:10px; font-size:11px; color:var(--text-muted); border-top:1px dashed rgba(255,255,255,0.1); padding-top:6px;">
              💡 Для создания плейлиста напрямую через API укажите личный User Token в настройках или нажмите «Войти через Spotify (OAuth)».
            </div>
          </div>
        `;
      }

      // Mark transferred tracks as 'playlist' status
      targetTracks.forEach(t => {
        t.status = 'playlist';
      });
      this.saveModeTables('spotify');
      this.render();

    } catch (err) {
      console.error('Spotify Playlist Transfer Error:', err);
      if (progressBar) progressBar.style.width = '0%';
      if (progressText) {
        progressText.innerHTML = `<span style="color:var(--danger)">Ошибка: ${this.escapeHtml(err.message)}</span>`;
      }
    } finally {
      if (btnStart) btnStart.disabled = false;
    }
  },

  // ----------------------------------------------------
  // Firebase Settings Modal
  // ----------------------------------------------------
  openFirebaseModal() {
    const config = FirebaseSync.getConfig();
    const configInput = document.getElementById('firebaseConfigJson');
    if (configInput && config) {
      configInput.value = JSON.stringify(config, null, 2);
    }
    document.getElementById('firebaseSettingsModal')?.classList.add('open');
  },

  async saveFirebaseConfig() {
    const configInput = document.getElementById('firebaseConfigJson');
    const raw = configInput ? configInput.value.trim() : '';

    if (!raw) {
      FirebaseSync.setConfig(null);
      alert('Конфигурация Firebase сброшена.');
      document.getElementById('firebaseSettingsModal')?.classList.remove('open');
      window.location.reload();
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      FirebaseSync.setConfig(parsed);
      alert('Конфигурация Firebase сохранена! Перезагрузка страницы.');
      window.location.reload();
    } catch (e) {
      alert('Ошибка парсинга JSON: ' + e.message);
    }
  },

  renderCloudStatus(info) {
    const badge = document.getElementById('cloudHeaderBadge');
    if (!badge) return;

    if (info.isFirebaseActive) {
      badge.innerHTML = `<span class="dot online"></span> Firebase Cloud`;
      badge.classList.add('active');
    } else {
      badge.innerHTML = `<span class="dot warn"></span> Локально (Offline)`;
      badge.classList.remove('active');
    }
  },

  openLightbox(url) {
    if (!url) return;
    const modal = document.getElementById('lightboxModal');
    const img = document.getElementById('lightboxImg');
    if (modal && img) {
      img.src = url;
      modal.classList.add('open');
    }
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

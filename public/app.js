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
  selectedSearchAlbumIds: new Set(),
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
  searchItemsMap: new Map(),
  currentModalAlbumItem: null,
  experiments: {
    compactTable: false,
    smartRecs: false,
    turntableAsmr: false
  },
  searchViewMode: 'stands', // 'stands' or 'list'
  threeTurntable: {
    isInitialized: false,
    renderer: null,
    scene: null,
    camera: null,
    platterMesh: null,
    vinylMesh: null,
    jacketMesh: null,
    tonearmPivot: null,
    discProgress: 0,
    targetDiscProgress: 0,
    discHoverOut: false,
    animFrameId: null
  },
  audioCtx: null,
  vinylCracklingNode: null,

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
    this.initAudioSystem();
    this.updateDiscogsUIStatus();
    this.updateSpotifyUIStatus();

    // Restore experiments
    try {
      const savedExp = localStorage.getItem('vh_experiments');
      if (savedExp) {
        this.experiments = { ...this.experiments, ...JSON.parse(savedExp) };
      }
    } catch (e) {}
    this.applyExperimentEffects();
    this.updateActiveFiltersBadge();
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
    this.initTurntableDragging();
    this.initTurntableWidgetDragging();
    this.updateFloatingPlayerButtonUI();
    this.prefetchCollectionTracklists();
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
        results.forEach(it => this.searchItemsMap.set(String(it.id), it));
        // ALBUMS MODE: show albums with version counts
        itemsContainer.innerHTML = results.map(item => {
          const cover = item.thumb || item.coverImage;
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid rgba(255,255,255,0.04);">
              <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal('${item.id}')" style="width:34px; height:34px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  ${cover ? `<img src="${this.escapeHtml(cover)}" style="width:34px; height:34px; border-radius:3px; object-fit:cover;">` : '<div style="width:34px; height:34px; background:#222; border-radius:3px;"></div>'}
                </div>
                <div style="min-width:0;">
                  <div style="font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    ${this.escapeHtml(item.artist || item.rawTitle)}
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal('${item.id}')" title="Нажмите, чтобы открыть треклист и слушать">${this.escapeHtml(item.title || '')}</a> ${item.year ? `(${item.year})` : ''} 
                    <span id="companionVersCount-${item.id}" style="color:var(--accent-theme); font-weight:600; font-size:10.5px;"></span>
                  </div>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal('${item.id}')" title="Посмотреть список песен и прослушать">🎵 ▶</button>
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
        results.forEach(it => this.searchItemsMap.set(String(it.id), it));
        // RELEASES MODE
        itemsContainer.innerHTML = results.map(item => {
          const cover = item.thumb || item.coverImage;
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid rgba(255,255,255,0.04);">
              <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal('${item.id}')" style="width:34px; height:34px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  ${cover ? `<img src="${this.escapeHtml(cover)}" style="width:34px; height:34px; border-radius:3px; object-fit:cover;">` : '<div style="width:34px; height:34px; background:#222; border-radius:3px;"></div>'}
                </div>
                <div style="min-width:0;">
                  <div style="font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    ${this.escapeHtml(item.artist || item.rawTitle)}
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal('${item.id}')" title="Нажмите, чтобы открыть треклист и слушать">${this.escapeHtml(item.title || '')}</a> ${item.year ? `(${item.year})` : ''} ${item.country ? `[${item.country}]` : ''}
                  </div>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal('${item.id}')" title="Посмотреть список песен и прослушать">🎵 ▶</button>
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

      this.highlightRecord(newAlbum.id, false);
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

      this.highlightRecord(newRecord.id, false);
    });
  },

  highlightRecord(id, shouldScroll = false) {
    if (!id) return;
    if (shouldScroll) {
      this.filterStatus = 'all';
      this.tableSearchQuery = '';
      const searchInput = document.getElementById('tableSearchInput');
      if (searchInput) searchInput.value = '';
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.filter === 'all');
      });
    }

    const found = this.findTableAndItem(id, this.appMode, true);
    if (found && found.table) {
      found.table.isCollapsed = false;
    }

    this.render();

    if (shouldScroll) {
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
    }
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

    // Total Collection Sales Valuation (от $min до $max, медиана $med)
    let totalSellMin = 0;
    let totalSellMed = 0;
    let totalSellMax = 0;
    let pricedCount = 0;
    this.records.forEach(r => {
      const med = Number(r.priceMedian || r.priceLowest || r.priceMin || 25);
      const min = Number(r.priceMin || (med * 0.7));
      const max = Number(r.priceMax || (med * 1.45));
      if (med > 0) {
        totalSellMin += min;
        totalSellMed += med;
        totalSellMax += max;
        pricedCount++;
      }
    });

    const priceRangeEl = document.getElementById('statHeaderPriceRange');
    if (priceRangeEl) {
      if (pricedCount > 0) {
        priceRangeEl.innerHTML = `💰 Оценка продажи: от $${Math.round(totalSellMin)} до $${Math.round(totalSellMax)} <span style="opacity:0.85; font-size:11px;">(медиана $${Math.round(totalSellMed)})</span>`;
        priceRangeEl.title = `Если продать все ${pricedCount} виниловых пластинок в коллекции: выручка от $${Math.round(totalSellMin)} до $${Math.round(totalSellMax)}, медиана $${Math.round(totalSellMed)}`;
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

    this.updateActiveFiltersBadge();
    this.renderTable();
  },

  openFiltersModal() {
    const modal = document.getElementById('filtersModal');
    if (modal) {
      modal.classList.add('open');
      modal.classList.add('active');
    }
  },

  closeFiltersModal() {
    const modal = document.getElementById('filtersModal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.remove('active');
    }
    this.updateActiveFiltersBadge();
  },

  updateActiveFiltersBadge() {
    const badge = document.getElementById('activeFiltersBadge');
    if (!badge) return;
    let count = 0;
    if (this.filters.status && this.filters.status.size < 4) count++;
    if (this.filters.ratings && this.filters.ratings.size < 5) count++;
    if (this.filters.highValueOnly) count++;
    if (this.filters.yearMin || this.filters.yearMax) count++;
    if (this.filters.metricMin || this.filters.metricMax) count++;
    if (this.filters.countries && this.filters.countries.size > 0) count++;

    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
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
    this.updateActiveFiltersBadge();
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
    if (this.experiments.smartRecs) {
      this.renderSmartRecommendations();
    }
    this.updateActiveFiltersBadge();
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
          <th class="sortable cell-versions-count" onclick="App.setSort('versionsCount')" title="Сортировать по количеству виниловых изданий">
            Виниловых изданий${this.getSortIndicator('versionsCount')}
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
      <tr id="record-row-${t.id}" class="record-row ${isSelected ? 'selected-row' : ''}" onclick="App.onTableRowClick(event, '${t.id}')">
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
    const coverUrl = this.getSafeCoverUrl(a.coverImage || a.thumb, a.artist, a.title);
    const discogsLink = a.uri || `https://www.discogs.com/master/${a.masterId}`;

    const trackCount = this.getAlbumTrackCount(a);
    const countVal = (typeof a.versionsCount === 'number') ? a.versionsCount : (a.versionsCount ? Number(a.versionsCount) : null);
    const displayCount = countVal !== null && !isNaN(countVal) ? countVal : (a.masterId ? '—' : '1');

    return `
      <tr id="record-row-${a.id}" class="record-row ${isSelected ? 'selected-row' : ''}" onclick="App.onTableRowClick(event, '${a.id}')">
        <td class="cell-checkbox">
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="App.toggleSelectRecord('${a.id}', this.checked)">
        </td>
        <td class="cell-cover">
          <div class="cover-thumb-wrapper" onclick="App.openLightbox('${coverUrl || ''}')">
            ${coverUrl ? `<img src="${this.escapeHtml(coverUrl)}" alt="Cover" loading="lazy" onerror="if (!this.dataset.err) { this.dataset.err='1'; this.src='/api/cover-image?artist='+encodeURIComponent('${this.escapeHtml(a.artist)}')+'&album='+encodeURIComponent('${this.escapeHtml(a.title)}'); }">` : `<div class="cover-placeholder">ALBUM</div>`}
          </div>
        </td>
        <td class="artist-album-col">
          <div class="record-artist">${this.escapeHtml(a.artist || 'Неизвестный исполнитель')}</div>
          <div class="record-title">
            <a href="javascript:void(0)" onclick="App.openAlbumTracklistModal('${a.id}')" class="clickable-album-title" title="Нажмите, чтобы просмотреть треклист альбома">${this.escapeHtml(a.title || 'Без названия')}${trackCount ? `<span class="album-tracks-slash" title="Песен в альбоме: ${trackCount}"> / ${trackCount}</span>` : ''}</a>
            <a href="${discogsLink}" target="_blank" rel="noopener noreferrer" class="external-discogs-link" title="Открыть на Discogs">↗</a>
          </div>
        </td>
        <td>
          ${a.year ? `<span class="meta-badge" title="Год первопресса: ${this.escapeHtml(a.year)}">📅 ${this.escapeHtml(a.year)}</span>` : '<span style="color:var(--text-muted)">—</span>'}
        </td>
        <td class="cell-versions-count">
          <button type="button" class="editions-count-badge ${countVal === 0 ? 'is-zero' : ''}" onclick="App.openMasterVersionsModal(${a.masterId}, '${this.escapeHtml(a.artist)}', '${this.escapeHtml(a.title)}', '${a.year || ''}', '${this.escapeHtml(coverUrl || '')}')" title="Виниловых изданий: ${displayCount}. Нажмите, чтобы открыть все прессы на Discogs">
            <span class="editions-count-icon">💿</span>
            <span class="editions-count-num">${displayCount}</span>
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
    const coverUrl = this.getSafeCoverUrl(r.coverImage || r.thumb, r.artist, r.title);
    const discogsLink = r.uri || (r.discogsId ? `https://www.discogs.com/release/${r.discogsId}` : '');
    const trackCount = this.getAlbumTrackCount(r);
    
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

    let bargainBadge = '';
    if (r.lowest_price && r.priceMedian) {
      const low = Number(r.lowest_price);
      const med = Number(r.priceMedian);
      if (low < med) {
        const discount = Math.round(((med - low) / med) * 100);
        bargainBadge = `<div class="prominent-deal-banner" title="Цена $${low} на ${discount}% ниже рыночной медианы $${med}"><span class="deal-fire">🔥 ВЫГОДА</span> <span class="deal-save">-${discount}%</span> ($${low})</div>`;
      } else if (low > med * 1.6) {
        bargainBadge = `<div class="prominent-deal-banner rarity-deal" title="Редкий коллекционный пресс"><span class="deal-fire">💎 РАРИТЕТ</span> ($${low})</div>`;
      }
    }

    return `
      <tr id="record-row-${r.id}" class="record-row ${isSelected ? 'selected-row' : ''}" onclick="App.onTableRowClick(event, '${r.id}')">
        <td class="cell-checkbox">
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="App.toggleSelectRecord('${r.id}', this.checked)">
        </td>
        <td class="cell-cover">
          <div class="cover-thumb-wrapper" onclick="App.openLightbox('${coverUrl || ''}')">
            ${coverUrl ? `<img src="${this.escapeHtml(coverUrl)}" alt="Cover" loading="lazy" onerror="if (!this.dataset.err) { this.dataset.err='1'; this.src='/api/cover-image?artist='+encodeURIComponent('${this.escapeHtml(r.artist)}')+'&album='+encodeURIComponent('${this.escapeHtml(r.title)}'); }">` : `<div class="cover-placeholder">VINYL</div>`}
          </div>
        </td>
        <td class="artist-album-col">
          <div class="record-artist">${this.escapeHtml(r.artist || 'Неизвестный исполнитель')}</div>
          <div class="record-title">
            <a href="javascript:void(0)" onclick="App.openAlbumTracklistModal('${r.id}')" class="clickable-album-title" title="Нажмите, чтобы просмотреть треклист альбома">${this.escapeHtml(r.title || 'Без названия')}${trackCount ? `<span class="album-tracks-slash" title="Песен в альбоме: ${trackCount}"> / ${trackCount}</span>` : ''}</a>
            ${discogsLink ? `<a href="${discogsLink}" target="_blank" rel="noopener noreferrer" class="external-discogs-link" title="Открыть на Discogs">↗</a>` : ''}
          </div>
        </td>
        <td>
          <div class="meta-badge-group">
            ${r.year ? `<span class="meta-badge" title="Год первопресса / издания: ${this.escapeHtml(r.year)}">📅 ${this.escapeHtml(r.year)}</span>` : ''}
            ${r.country ? `<span class="meta-badge">${this.escapeHtml(r.country)}</span>` : ''}
            ${r.format ? `<span class="meta-badge" title="${this.escapeHtml(r.format)}">${this.escapeHtml(r.format.split(',')[0])}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="price-box">
            <div class="price-median">${medianStr}</div>
            ${bargainBadge}
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

  getSafeCoverUrl(url, artist = '', album = '') {
    if (!url) {
      if (artist && album) {
        return `/api/cover-image?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`;
      }
      return '';
    }
    const str = String(url).trim();
    if (str.includes('discogs.com') || str.includes('i.discogs.com')) {
      const art = encodeURIComponent(artist || '');
      const alb = encodeURIComponent(album || '');
      return `/api/image-proxy?url=${encodeURIComponent(str)}&artist=${art}&album=${alb}`;
    }
    return str;
  },

  updateAlbumYearToFirstPress(masterId, firstPressYear) {
    if (!masterId || !firstPressYear) return;
    const strMaster = String(masterId);
    let updated = false;

    (this.tables.albums || []).forEach(tbl => {
      if (Array.isArray(tbl.items)) {
        tbl.items.forEach(a => {
          if (String(a.masterId) === strMaster || String(a.id) === `master-${strMaster}` || String(a.id) === strMaster) {
            if (String(a.year) !== String(firstPressYear)) {
              a.year = String(firstPressYear);
              updated = true;
            }
          }
        });
      }
    });

    if (updated) {
      this.saveModeTables('albums');
      this.renderTable();
    }
  },

  prefetchCollectionTracklists() {
    setTimeout(async () => {
      try {
        const albums = (this.getAllItemsInMode('albums') || []);
        const releases = (this.getAllItemsInMode('releases') || []);
        const combined = [...albums, ...releases];
        for (const item of combined) {
          if (!item) continue;
          const cacheKey = item.masterId || item.discogsId || item.id;
          const nameKey = (item.artist && (item.album || item.title))
            ? `${String(item.artist).toLowerCase().trim()}:::${String(item.album || item.title).toLowerCase().trim()}`
            : null;

          if (this.getTracklistFromCache(cacheKey) || (nameKey && this.getTracklistFromCache(nameKey))) {
            continue;
          }

          const queryId = item.masterId || item.discogsId || (String(item.id || '').replace(/^master-|^discogs-/, ''));
          const queryType = (item.masterId || item.type === 'master' || String(item.id || '').startsWith('master-')) ? 'master' : 'release';
          const qArtist = item.artist || '';
          const qAlbum = item.album || item.title || '';
          const qFull = [qArtist, qAlbum].filter(Boolean).join(' - ');

          try {
            const res = await fetch(`/api/discogs/tracklist?id=${encodeURIComponent(queryId || '')}&type=${queryType}&artist=${encodeURIComponent(qArtist)}&album=${encodeURIComponent(qAlbum)}&q=${encodeURIComponent(qFull)}`);
            if (res.ok) {
              const data = await res.json();
              if (data && data.tracklist && data.tracklist.length > 0) {
                if (cacheKey) this.saveTracklistToCache(cacheKey, data);
                if (nameKey) this.saveTracklistToCache(nameKey, data);
              }
            }
          } catch (e) {}

          await new Promise(r => setTimeout(r, 200));
        }
      } catch (err) {}
    }, 1500);
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

    const safeCover = this.getSafeCoverUrl(coverUrl, artist, title);
    this.currentMasterModalData = { masterId, artist, title, year, coverUrl: safeCover, allVersions: [] };

    if (headerTitle) headerTitle.textContent = `${artist} — ${title}`;
    if (headerSub) headerSub.textContent = `Оригинальный первопресс: ${year || '—'} · Загрузка виниловых изданий с Discogs...`;
    if (coverImg) {
      coverImg.src = safeCover || '';
      coverImg.onerror = () => {
        coverImg.onerror = null;
        coverImg.src = `/api/cover-image?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(title)}`;
      };
    }
    if (versionsBody) {
      versionsBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--accent-theme);">Загрузка всех виниловых изданий из базы Discogs...</td></tr>`;
    }

    modal.classList.add('open');

    try {
      const data = await DiscogsClient.getMasterVersions(masterId, 1, 100);
      const versions = data.versions || [];
      const totalCount = data.pagination ? data.pagination.items : versions.length;

      // Calculate TRUE first press year across all versions
      const validYears = versions.map(v => parseInt(v.year || v.released, 10)).filter(y => !isNaN(y) && y > 1900 && y <= new Date().getFullYear());
      const firstPressYear = (validYears.length > 0) ? Math.min(...validYears) : (data.firstPressYear || year || '');

      this.currentMasterModalData.allVersions = versions;
      this.currentMasterModalData.year = firstPressYear;

      if (headerSub) {
        headerSub.innerHTML = `Оригинальный первопресс: <strong style="color:var(--accent-theme);">${firstPressYear || '—'}</strong> · Всего виниловых прессов на Discogs: <strong style="color:var(--accent-theme);">${totalCount}</strong>`;
      }

      // Automatically sync year in table to first press year!
      if (firstPressYear) {
        this.updateAlbumYearToFirstPress(masterId, String(firstPressYear));
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
    this.searchProvider = (provider === 'spotify' || provider === 'youtube') ? provider : 'discogs';
    const tabDiscogs = document.getElementById('searchTabDiscogs');
    const tabSpotify = document.getElementById('searchTabSpotify');
    const tabYouTube = document.getElementById('searchTabYouTube');
    const input = document.getElementById('discogsSearchInput');
    const titleEl = document.getElementById('discogsSearchModalTitle');

    if (tabDiscogs) tabDiscogs.classList.toggle('active', this.searchProvider === 'discogs');
    if (tabSpotify) tabSpotify.classList.toggle('active', this.searchProvider === 'spotify');
    if (tabYouTube) tabYouTube.classList.toggle('active', this.searchProvider === 'youtube');

    if (this.searchProvider === 'youtube') {
      if (titleEl) titleEl.textContent = 'YouTube Режим: Быстрый чекер & видео';
      if (input) input.placeholder = 'Введите название песни, исполнителя или видео YouTube...';
    } else if (this.searchProvider === 'spotify') {
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
    this.selectedSearchAlbumIds.clear();
    this.updateSearchMultiSelectBar();
    const modal = document.getElementById('discogsSearchModal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.remove('active');
    }
  },

  getAlbumEarliestYear(item) {
    if (!item) return '';
    if (item.firstPressYear) return String(item.firstPressYear);
    
    // For specific releases without masterId, the explicit release pressing year is authoritative
    if (!item.masterId && item.year) {
      return String(item.year);
    }

    const cacheKey = item.masterId || item.discogsId || item.id;
    const nameKey = (item.artist && (item.album || item.title))
      ? `${String(item.artist).toLowerCase().trim()}:::${String(item.album || item.title).toLowerCase().trim()}`
      : null;
    const cached = this.getTracklistFromCache(cacheKey) || (nameKey && this.getTracklistFromCache(nameKey));

    let y1 = parseInt(item.year, 10);
    let y2 = cached && cached.year ? parseInt(cached.year, 10) : null;
    if (isNaN(y1) || y1 <= 1900) y1 = null;
    if (isNaN(y2) || y2 <= 1900) y2 = null;

    if (y1 && y2) return String(Math.min(y1, y2));
    if (y1) return String(y1);
    if (y2) return String(y2);
    return item.year || '';
  },

  getAlbumTrackCount(item) {
    if (!item) return '';
    if (typeof item.trackCount === 'number' && item.trackCount > 0) return item.trackCount;
    if (Array.isArray(item.tracklist) && item.tracklist.length > 0) return item.tracklist.length;
    const cacheKey = item.masterId || item.discogsId || item.id;
    const nameKey = (item.artist && (item.album || item.title))
      ? `${String(item.artist).toLowerCase().trim()}:::${String(item.album || item.title).toLowerCase().trim()}`
      : null;
    const cached = this.getTracklistFromCache(cacheKey) || (nameKey && this.getTracklistFromCache(nameKey));
    if (cached && Array.isArray(cached.tracklist) && cached.tracklist.length > 0) {
      return cached.tracklist.length;
    }
    return '';
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

    this.selectedSearchAlbumIds.clear();
    this.updateSearchMultiSelectBar();

    const isSpotify = this.searchProvider === 'spotify';
    const isAlbumsSearch = isSpotify ? (this.appMode === 'albums' || this.appMode === 'releases') : (this.appMode === 'albums');
    const serviceName = isSpotify ? 'Spotify' : 'Discogs';

    try {
      if (this.searchProvider === 'youtube') {
        resultsContainer.innerHTML = `<div style="text-align:center; padding:24px; color:var(--accent-theme)">Проверка коллекции и поиск видео/треков...</div>`;
        const qLower = q.toLowerCase();
        const targetList = this.appMode === 'spotify' ? this.spotifyTracks : (this.appMode === 'albums' ? this.albums : this.records);
        const localMatch = targetList.find(r => (r.artist || '').toLowerCase().includes(qLower) || (r.title || '').toLowerCase().includes(qLower));

        let banner = '';
        if (localMatch) {
          banner = `
            <div style="background:rgba(34,197,94,0.15); border:1px solid #22c55e; border-radius:8px; padding:10px 14px; margin-bottom:12px; display:flex; align-items:center; justify-content:space-between;">
              <div>
                <span style="color:#4ade80; font-weight:700;">✓ Уже есть в коллекции:</span>
                <strong style="color:#ffffff;">${this.escapeHtml(localMatch.artist)} — ${this.escapeHtml(localMatch.title)}</strong>
              </div>
              <button class="btn btn-sm btn-secondary" onclick="App.highlightRecord('${localMatch.id}')">Подсветить</button>
            </div>
          `;
        }

        const spData = await SpotifyClient.searchTracks(q, 15).catch(() => ({ results: [] }));
        const tracks = spData.results || [];

        if (tracks.length === 0) {
          resultsContainer.innerHTML = banner + `<div style="text-align:center; padding:24px; color:var(--text-muted)">По запросу «${this.escapeHtml(q)}» ничего не найдено.</div>`;
          return;
        }

        tracks.forEach(item => {
          this.searchItemsMap.set(String(item.id), item);
          this.searchItemsMap.set('sp-' + String(item.id), item);
        });
        resultsContainer.innerHTML = banner + tracks.map(item => {
          return `
            <div class="search-card" style="display:flex; align-items:center; justify-content:space-between; padding:10px; border-bottom:1px solid rgba(255,255,255,0.06);">
              <div style="display:flex; align-items:center; gap:12px; min-width:0;">
                ${item.coverImage ? `<img src="${this.escapeHtml(item.coverImage)}" style="width:44px; height:44px; border-radius:6px; object-fit:cover; flex-shrink:0;">` : ''}
                <div style="min-width:0;">
                  <div style="font-weight:700; color:#ffffff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(item.title)}</div>
                  <div style="font-size:12px; color:#cbd5e1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(item.artist)} · <span style="color:#94a3b8;">${this.escapeHtml(item.album || '')}</span></div>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                ${item.previewUrl ? `<button class="btn btn-sm btn-secondary" onclick="App.playAudio('${this.escapeHtml(item.previewUrl)}', '${this.escapeHtml(item.title)}', '${this.escapeHtml(item.artist)}', '${this.escapeHtml(item.coverImage || '')}', this)">▶</button>` : ''}
                <button class="btn btn-sm btn-primary" onclick="App.openAlbumTracklistModal('sp-${item.id}')">🎵 Треклист</button>
                <button class="btn btn-sm btn-secondary" onclick="App.transferSpotifyAlbumToSearch('${this.escapeHtml(item.artist).replace(/'/g, "\\'")}', '${this.escapeHtml(item.album || item.title).replace(/'/g, "\\'")}')">💽 Винил</button>
              </div>
            </div>
          `;
        }).join('');
        return;
      }

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

        discogsResults.forEach(item => this.searchItemsMap.set(String(item.id), item));
        const dColHtml = discogsResults.length === 0 ? '<div style="color:var(--text-muted); text-align:center; padding:20px;">Ничего не найдено в Discogs</div>' : discogsResults.map(item => {
          const coverImg = item.thumb || item.coverImage;
          const libInfo = this.isAlbumInLibrary(item);
          const inLib = libInfo.inLibrary;
          const isMaster = !!item.masterId;
          const isChecked = this.selectedSearchAlbumIds.has(String(item.id));
          const earliestYear = this.getAlbumEarliestYear(item);
          const trackCount = this.getAlbumTrackCount(item);
          return `
            <div class="search-result-item ${inLib ? 'search-item-in-library' : ''}" id="search-item-${item.id}" style="margin-bottom:8px; padding:8px 10px;">
              <div class="search-result-left">
                <label class="search-item-checkbox-wrap" onclick="event.stopPropagation()" title="${inLib ? 'Уже в коллекции' : 'Выбрать для мультидобавления'}">
                  <input type="checkbox" class="search-item-checkbox" data-id="${item.id}" ${inLib ? 'disabled' : ''} ${isChecked ? 'checked' : ''} onchange="App.onSearchItemCheckboxChange('${item.id}', this.checked)">
                </label>
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal('${item.id}')" style="width:38px; height:38px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  <img src="${coverImg || ''}" style="width:38px; height:38px; border-radius:4px; object-fit:cover; background:#222; flex-shrink:0;">
                </div>
                <div class="search-meta" style="min-width:0;">
                  <div class="search-artist" style="font-size:11.5px; color:#cbd5e1; font-weight:600;">${this.escapeHtml(item.artist || item.rawTitle)}</div>
                  <div class="search-title" style="font-size:12.5px; font-weight:700;">
                    <a href="javascript:void(0)" class="dual-album-link" onclick="App.openAlbumTracklistModal('${item.id}')" style="color:#ffffff; text-decoration:none;">${this.escapeHtml(item.title || '')}<span class="album-tracks-slash" id="titleTracksSlash-${item.id}" title="Песен в альбоме">${trackCount ? ` / ${trackCount}` : ''}</span></a>
                  </div>
                  <div class="search-tags" style="font-size:10.5px; color:#94a3b8;">
                    <span id="searchYear-${item.id}" style="${earliestYear ? '' : 'display:none;'} color:#cbd5e1;">Год: ${this.escapeHtml(earliestYear)} • </span>
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
        results.forEach(item => {
          this.searchItemsMap.set(String(item.id), item);
          this.searchItemsMap.set('sp-' + String(item.id), item);
        });
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
          const transferArtist = (item.artist || '').replace(/'/g, "\\'");
          const transferAlbum = (item.album || item.title || '').replace(/'/g, "\\'");

          return `
            <div class="spotify-track-card ${alreadyAdded ? 'search-item-in-library' : ''} ${isNowPlaying ? 'search-item-now-playing' : ''}" 
                 id="sp-track-${item.id}"
                 data-artist="${this.escapeHtml(item.artist || '')}"
                 data-album="${this.escapeHtml(item.album || item.title || '')}"
                 data-item-id="${this.escapeHtml(item.id)}"
                 onmouseenter="App.prefetchAlbumTracklist('sp-${item.id}')">
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
                <button type="button" class="sp-btn sp-btn-tracklist" onclick="App.openAlbumTracklistModal('sp-${item.id}')" title="Посмотреть треклист альбома">
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
        results.forEach(item => this.searchItemsMap.set(String(item.id), item));
        resultsContainer.innerHTML = artistBannerHtml + results.map(item => {
          const coverImg = item.thumb || item.coverImage;
          const libInfo = this.isAlbumInLibrary(item);
          const inLib = libInfo.inLibrary;
          const tableName = libInfo.table ? libInfo.table.name : 'альбомов';
          const isNowPlaying = this.isAudioPlayingForAlbum(item);
          const hasCount = typeof item.versionsCount === 'number';
          const isZero = hasCount && item.versionsCount === 0;
          const versionsText = hasCount
            ? (isZero ? '🚫 Нет виниловых изданий' : `💽 ${this.formatVinylVersions(item.versionsCount)}`)
            : '⏳ Загрузка изданий...';

          const isChecked = this.selectedSearchAlbumIds.has(String(item.id));
          const earliestYear = this.getAlbumEarliestYear(item);
          const trackCount = this.getAlbumTrackCount(item);
          return `
            <div class="search-result-item ${inLib ? 'search-item-in-library' : ''} ${isNowPlaying ? 'search-item-now-playing' : ''} ${isZero ? 'search-item-no-sale' : ''}" 
                 id="search-item-${item.id}"
                 data-artist="${this.escapeHtml(item.artist || item.rawTitle || '')}"
                 data-album="${this.escapeHtml(item.title || '')}"
                 data-item-id="${this.escapeHtml(item.id)}"
                 onmouseenter="App.prefetchAlbumTracklist('${item.id}')">
              <div class="search-result-left">
                <label class="search-item-checkbox-wrap" onclick="event.stopPropagation()" title="${inLib ? 'Уже в коллекции' : 'Выбрать для мультидобавления'}">
                  <input type="checkbox" class="search-item-checkbox" data-id="${item.id}" ${inLib ? 'disabled' : ''} ${isChecked ? 'checked' : ''} onchange="App.onSearchItemCheckboxChange('${item.id}', this.checked)">
                </label>
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal('${item.id}')" style="width:48px; height:48px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  <img src="${coverImg || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' fill=\'%23222\'><rect width=\'48\' height=\'48\'/></svg>'}" class="search-cover" alt="Album">
                </div>
                <div class="search-meta">
                  <div class="search-artist">${this.escapeHtml(item.artist || item.rawTitle)}</div>
                  <div class="search-title">
                    <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal('${item.id}')" title="Нажмите, чтобы открыть треклист и слушать">
                      ${this.escapeHtml(item.title || '')}<span class="album-tracks-slash" id="titleTracksSlash-${item.id}" title="Песен в альбоме">${trackCount ? ` / ${trackCount}` : ''}</span>
                    </a>
                  </div>
                  <div class="search-tags">
                    ${inLib ? `<span class="in-library-badge">✓ В таблице: ${this.escapeHtml(tableName)}</span> •` : ''}
                    ${isNowPlaying ? `<span class="now-playing-album-indicator">🔊 Сейчас играет</span> •` : ''}
                    <span id="searchYear-${item.id}">${earliestYear ? `Год: ${this.escapeHtml(earliestYear)} •` : ''}</span>
                    <span id="modalAlbumVersCount-${item.id}" class="versions-badge ${isZero ? 'versions-badge-zero' : ''}" style="color:var(--accent-theme); font-weight:600;">${versionsText}</span>
                  </div>
                </div>
              </div>
              <div class="search-result-right" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <button type="button" class="btn-search-versions-toggle" onclick="event.stopPropagation(); App.toggleSearchVersionsDrawer('${item.id}', '${item.masterId || ''}')" title="Посмотреть список вариантов прессов прямо здесь">
                  💽 Издания ▾
                </button>
                <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal('${item.id}')" title="Посмотреть список песен и прослушать">
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

        this.renderSearchStands(results);
        if (this.searchViewMode === 'stands') {
          const standsContainer = document.getElementById('discogsSearchStandsContainer');
          if (standsContainer) standsContainer.style.display = 'grid';
          if (resultsContainer) resultsContainer.style.display = 'none';
        }

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
        results.forEach(item => this.searchItemsMap.set(String(item.id), item));
        resultsContainer.innerHTML = artistBannerHtml + results.map(item => {
          const coverImg = item.thumb || item.coverImage;
          const libInfo = this.isAlbumInLibrary(item);
          const inLib = libInfo.inLibrary;
          const tableName = libInfo.table ? libInfo.table.name : 'релизов';
          const isNowPlaying = this.isAudioPlayingForAlbum(item);

          const isChecked = this.selectedSearchAlbumIds.has(String(item.id));
          const earliestYear = this.getAlbumEarliestYear(item);
          const trackCount = this.getAlbumTrackCount(item);
          return `
            <div class="search-result-item ${inLib ? 'search-item-in-library' : ''} ${isNowPlaying ? 'search-item-now-playing' : ''}" 
                 id="search-item-${item.id}"
                 data-artist="${this.escapeHtml(item.artist || item.rawTitle || '')}"
                 data-album="${this.escapeHtml(item.title || '')}"
                 data-item-id="${this.escapeHtml(item.id)}"
                 onmouseenter="App.prefetchAlbumTracklist('${item.id}')">
              <div class="search-result-left">
                <label class="search-item-checkbox-wrap" onclick="event.stopPropagation()" title="${inLib ? 'Уже в коллекции' : 'Выбрать для мультидобавления'}">
                  <input type="checkbox" class="search-item-checkbox" data-id="${item.id}" ${inLib ? 'disabled' : ''} ${isChecked ? 'checked' : ''} onchange="App.onSearchItemCheckboxChange('${item.id}', this.checked)">
                </label>
                <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal('${item.id}')" style="width:48px; height:48px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                  <img src="${coverImg || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' fill=\'%23222\'><rect width=\'48\' height=\'48\'/></svg>'}" class="search-cover" alt="Vinyl">
                </div>
                <div class="search-meta">
                  <div class="search-artist">${this.escapeHtml(item.artist || item.rawTitle)}</div>
                  <div class="search-title">
                    <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal('${item.id}')" title="Нажмите, чтобы открыть треклист и слушать">
                      ${this.escapeHtml(item.title || '')}<span class="album-tracks-slash" id="titleTracksSlash-${item.id}" title="Песен в альбоме">${trackCount ? ` / ${trackCount}` : ''}</span>
                    </a>
                  </div>
                  <div class="search-tags">
                    ${inLib ? `<span class="in-library-badge">✓ В таблице: ${this.escapeHtml(tableName)}</span> •` : ''}
                    ${isNowPlaying ? `<span class="now-playing-album-indicator">🔊 Сейчас играет</span> •` : ''}
                    <span id="searchYear-${item.id}">${earliestYear ? `Год: ${this.escapeHtml(earliestYear)} •` : ''}</span>
                    ${item.country ? `<span>${this.escapeHtml(item.country)}</span> •` : ''}
                    <span>${this.escapeHtml(item.format || 'Vinyl')}</span>
                    ${item.label ? `• <span>${this.escapeHtml(item.label)}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="search-result-right" style="display:flex; align-items:center; gap:8px;">
                <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal('${item.id}')" title="Посмотреть список песен и прослушать">
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

        this.renderSearchStands(results);
        if (this.searchViewMode === 'stands') {
          const standsContainer = document.getElementById('discogsSearchStandsContainer');
          if (standsContainer) standsContainer.style.display = 'grid';
          if (resultsContainer) resultsContainer.style.display = 'none';
        }

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
                  if (stats.median && p < stats.median) {
                    const discount = Math.round(((stats.median - p) / stats.median) * 100);
                    pricePreviewEl.innerHTML = `<span class="prominent-deal-banner" title="Цена ${curSym}${p.toFixed(2)} на ${discount}% ниже рынка"><span class="deal-fire">🔥 ВЫГОДА</span> <span class="deal-save">-${discount}%</span> от ${curSym}${p.toFixed(2)}</span>`;
                  } else {
                    pricePreviewEl.innerHTML = `<span style="color:#38bdf8; font-weight:700;">от ${curSym}${p.toFixed(2)}${stats.median ? ` <span style="color:#94a3b8; font-weight:500;">(рынок ${curSym}${stats.median.toFixed(2)})</span>` : ''}</span>`;
                  }
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

    this.selectedSearchAlbumIds.clear();
    this.updateSearchMultiSelectBar();

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

      results.forEach(item => this.searchItemsMap.set(String(item.id), item));
      const cardsHtml = results.map(item => {
        const coverImg = item.thumb || item.coverImage;
        const libInfo = this.isAlbumInLibrary(item);
        const inLib = libInfo.inLibrary;
        const tableName = libInfo.table ? libInfo.table.name : 'альбомов';
        const isNowPlaying = this.isAudioPlayingForAlbum(item);
        const hasCount = typeof item.versionsCount === 'number';
        const isZero = hasCount && item.versionsCount === 0;
        const versionsText = hasCount
          ? (isZero ? '🚫 Нет виниловых изданий' : `💽 ${this.formatVinylVersions(item.versionsCount)}`)
          : '⏳ Загрузка изданий...';

        const isChecked = this.selectedSearchAlbumIds.has(String(item.id));
        const earliestYear = this.getAlbumEarliestYear(item);
        const trackCount = this.getAlbumTrackCount(item);
        return `
          <div class="search-result-item ${inLib ? 'search-item-in-library' : ''} ${isNowPlaying ? 'search-item-now-playing' : ''} ${isZero ? 'search-item-no-sale' : ''}" 
               id="search-item-${item.id}"
               data-artist="${this.escapeHtml(item.artist || item.rawTitle || '')}"
               data-album="${this.escapeHtml(item.title || '')}"
               data-item-id="${this.escapeHtml(item.id)}"
               onmouseenter="App.prefetchAlbumTracklist('${item.id}')">
            <div class="search-result-left">
              <label class="search-item-checkbox-wrap" onclick="event.stopPropagation()" title="${inLib ? 'Уже в коллекции' : 'Выбрать для мультидобавления'}">
                <input type="checkbox" class="search-item-checkbox" data-id="${item.id}" ${inLib ? 'disabled' : ''} ${isChecked ? 'checked' : ''} onchange="App.onSearchItemCheckboxChange('${item.id}', this.checked)">
              </label>
              <div class="cover-thumb-wrapper" onclick="App.openAlbumTracklistModal('${item.id}')" style="width:48px; height:48px; cursor:pointer; flex-shrink:0;" title="Нажмите, чтобы открыть треклист и слушать">
                <img src="${coverImg || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\' fill=\'%23222\'><rect width=\'48\' height=\'48\'/></svg>'}" class="search-cover" alt="Album">
              </div>
              <div class="search-meta">
                <div class="search-artist">${this.escapeHtml(item.artist || item.rawTitle)}</div>
                <div class="search-title">
                  <a href="javascript:void(0)" class="search-clickable-album" onclick="App.openAlbumTracklistModal('${item.id}')" title="Нажмите, чтобы открыть треклист и слушать">
                    ${this.escapeHtml(item.title || '')}<span class="album-tracks-slash" id="titleTracksSlash-${item.id}" title="Песен в альбоме">${trackCount ? ` / ${trackCount}` : ''}</span>
                  </a>
                </div>
                <div class="search-tags">
                  ${inLib ? `<span class="in-library-badge">✓ В таблице: ${this.escapeHtml(tableName)}</span> •` : ''}
                  ${isNowPlaying ? `<span class="now-playing-album-indicator">🔊 Сейчас играет</span> •` : ''}
                  <span id="searchYear-${item.id}">${earliestYear ? `Год: ${this.escapeHtml(earliestYear)} •` : ''}</span>
                  <span id="modalAlbumVersCount-${item.id}" class="versions-badge ${isZero ? 'versions-badge-zero' : ''}" style="color:var(--accent-theme); font-weight:600;">${versionsText}</span>
                </div>
              </div>
            </div>
            <div class="search-result-right" style="display:flex; align-items:center; gap:8px;">
              <button type="button" class="search-tracklist-btn" onclick="App.openAlbumTracklistModal('${item.id}')" title="Посмотреть список песен и прослушать">
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

  // ----------------------------------------------------
  // SEARCH RESULTS MULTI-SELECTION (МУЛЬТИВЫДЕЛЕНИЕ)
  // ----------------------------------------------------
  onSearchItemCheckboxChange(itemId, isChecked) {
    const sId = String(itemId);
    if (isChecked) {
      this.selectedSearchAlbumIds.add(sId);
    } else {
      this.selectedSearchAlbumIds.delete(sId);
    }
    this.updateSearchMultiSelectBar();
  },

  updateSearchMultiSelectBar() {
    const bar = document.getElementById('searchMultiSelectBar');
    const countEl = document.getElementById('searchSelectedCount');
    const addCountEl = document.getElementById('searchSelectedAddCount');
    const count = this.selectedSearchAlbumIds.size;
    if (bar) {
      bar.style.display = count > 0 ? 'flex' : 'none';
    }
    if (countEl) countEl.textContent = count;
    if (addCountEl) addCountEl.textContent = count;
  },

  selectAllSearchResults(selectAll) {
    const checkboxes = document.querySelectorAll('.search-item-checkbox:not(:disabled)');
    if (selectAll) {
      checkboxes.forEach(cb => {
        cb.checked = true;
        const id = cb.dataset.id;
        if (id) this.selectedSearchAlbumIds.add(String(id));
      });
    } else {
      checkboxes.forEach(cb => {
        cb.checked = false;
      });
      this.selectedSearchAlbumIds.clear();
    }
    this.updateSearchMultiSelectBar();
  },

  async addSelectedSearchResults() {
    if (this.selectedSearchAlbumIds.size === 0) {
      this.showToastNotification('⚠️ Не выбрано ни одного альбома');
      return;
    }

    const itemsToAdd = (this.lastSearchResults || []).filter(it => 
      this.selectedSearchAlbumIds.has(String(it.id)) && !this.isAlbumInLibrary(it).inLibrary
    );

    if (itemsToAdd.length === 0) {
      this.showToastNotification('Все выбранные альбомы уже есть в вашей коллекции');
      this.selectedSearchAlbumIds.clear();
      this.updateSearchMultiSelectBar();
      return;
    }

    const mode = this.appMode === 'spotify' ? 'spotify' : (this.appMode === 'albums' ? 'albums' : 'releases');
    const label = `${itemsToAdd.length} ${this.formatRecordsWord(itemsToAdd.length)}`;

    this.promptDestinationTable(label, mode, async (targetTableId) => {
      let addedCount = 0;
      const targetTable = (this.getActiveModeTables(mode) || []).find(t => t.id === targetTableId);
      const tableName = targetTable ? targetTable.name : 'коллекцию';

      for (const item of itemsToAdd) {
        if (mode === 'albums') {
          const versionsCount = (typeof item.versionsCount === 'number') ? item.versionsCount : (item.masterId ? 1 : 1);
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
          this.addItemToActiveTable(newAlbum, targetTableId, 'albums');
          addedCount++;

          const card = document.getElementById(`search-item-${item.id}`);
          if (card) {
            card.classList.add('search-item-in-library');
            card.style.opacity = '0.58';
            card.style.filter = 'grayscale(100%)';
            const btn = document.getElementById(`modalBtnAddAlbum-${item.id}`) || card.querySelector('.btn-primary');
            if (btn) {
              btn.textContent = '✓ В коллекции';
              btn.classList.remove('btn-primary');
              btn.classList.add('btn-secondary', 'sp-btn-added');
              btn.disabled = true;
            }
            const cb = card.querySelector('.search-item-checkbox');
            if (cb) {
              cb.checked = false;
              cb.disabled = true;
            }
            let badge = card.querySelector('.in-library-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'in-library-badge';
              badge.textContent = `✓ В таблице: ${tableName}`;
              const badgesRow = card.querySelector('.search-tags, .sp-album-badges');
              if (badgesRow) badgesRow.prepend(badge);
            }
          }
        } else if (mode === 'releases') {
          const newRecord = {
            id: `discogs-${item.id}`,
            discogsId: item.id,
            title: item.title || item.rawTitle,
            artist: item.artist || item.rawTitle,
            year: item.year || '',
            format: item.format || 'Vinyl',
            country: item.country || '',
            label: item.label || '',
            catno: item.catno || '',
            thumb: item.thumb || item.coverImage,
            coverImage: item.coverImage || item.thumb,
            uri: item.uri,
            status: 'buy',
            notes: '',
            createdAt: new Date().toISOString()
          };
          this.addItemToActiveTable(newRecord, targetTableId, 'releases');
          addedCount++;

          const card = document.getElementById(`search-item-${item.id}`);
          if (card) {
            card.classList.add('search-item-in-library');
            card.style.opacity = '0.58';
            card.style.filter = 'grayscale(100%)';
            const btn = document.getElementById(`modalBtnAddRelease-${item.id}`) || card.querySelector('.btn-primary');
            if (btn) {
              btn.textContent = '✓ В вишлисте';
              btn.classList.remove('btn-primary');
              btn.classList.add('btn-secondary', 'sp-btn-added');
              btn.disabled = true;
            }
            const cb = card.querySelector('.search-item-checkbox');
            if (cb) {
              cb.checked = false;
              cb.disabled = true;
            }
            let badge = card.querySelector('.in-library-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'in-library-badge';
              badge.textContent = `✓ В таблице: ${tableName}`;
              const badgesRow = card.querySelector('.search-tags');
              if (badgesRow) badgesRow.prepend(badge);
            }
          }
        } else if (mode === 'spotify') {
          const rawId = item.id || item.spotifyId || Date.now();
          const cleanId = String(rawId).startsWith('sp-') ? rawId : `sp-${rawId}`;
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
            externalUrl: item.spotifyUrl || item.externalUrl || '',
            status: 'buy',
            rating: 0,
            isHighValue: false,
            notes: '',
            createdAt: new Date().toISOString()
          };
          this.addItemToActiveTable(newTrack, targetTableId, 'spotify');
          addedCount++;

          const card = document.getElementById(`sp-track-${item.id}`);
          if (card) {
            card.classList.add('search-item-in-library');
            const btn = document.getElementById(`modalBtnAddTrack-${item.id}`) || card.querySelector('.sp-btn-add');
            if (btn) {
              btn.textContent = '✓ В коллекции';
              btn.classList.remove('sp-btn-add');
              btn.classList.add('sp-btn-added');
              btn.disabled = true;
            }
            const cb = card.querySelector('.search-item-checkbox');
            if (cb) {
              cb.checked = false;
              cb.disabled = true;
            }
          }
        }
      }

      this.saveModeTables(mode);
      this.renderTables();

      this.selectedSearchAlbumIds.clear();
      this.updateSearchMultiSelectBar();

      this.showToastNotification(`✓ Добавлено альбомов: ${addedCount} в «${tableName}»`);
    });
  },

  async addAlbumFromModal(masterId) {
    const item = (this.lastSearchResults || []).find(r => r.id === masterId);
    if (!item) return;

    let versionsCount = item.versionsCount;
    let firstPressYear = item.firstPressYear || null;
    if (versionsCount === null || versionsCount === undefined || !firstPressYear) {
      if (item.masterId || item.id) {
        const mId = item.masterId || item.id;
        const versData = await DiscogsClient.getMasterVersions(mId, 1, 1).catch(() => null);
        if (versData) {
          if (versData.pagination) versionsCount = versData.pagination.items;
          if (versData.firstPressYear) firstPressYear = versData.firstPressYear;
        }
      }
      if (versionsCount === null || versionsCount === undefined) versionsCount = 1;
    }

    const resolvedYear = String(firstPressYear || item.firstPressYear || item.year || '');

    const newAlbum = {
      id: `master-${item.id}`,
      masterId: item.id,
      artist: item.artist || item.rawTitle,
      title: item.title || item.rawTitle,
      year: resolvedYear,
      coverImage: item.coverImage || item.thumb,
      thumb: item.thumb,
      uri: item.uri,
      versionsCount: versionsCount,
      genre: item.genre || '',
      style: item.style || '',
      status: 'buy',
      notes: '',
      tracklist: item.tracklist || [],
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

      // Keep search modal OPEN and mark item as added, staying in-place without scrolling or jumping!
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
        const cb = card.querySelector('.search-item-checkbox');
        if (cb) {
          cb.checked = false;
          cb.disabled = true;
        }
        let badge = card.querySelector('.in-library-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'in-library-badge';
          badge.textContent = `✓ В таблице: ${tableName}`;
          const badgesRow = card.querySelector('.search-tags, .sp-album-badges');
          if (badgesRow) badgesRow.prepend(badge);
        }
      }

      this.highlightRecord(newAlbum.id, false);
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
      externalUrl: item.spotifyUrl || item.externalUrl || '',
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

      // Keep search modal OPEN and mark item as added, staying in-place without scrolling or jumping!
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
        const cb = card.querySelector('.search-item-checkbox');
        if (cb) {
          cb.checked = false;
          cb.disabled = true;
        }
        let badge = card.querySelector('.in-library-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'in-library-badge';
          badge.textContent = `✓ В таблице: ${tableName}`;
          const badgesRow = card.querySelector('.sp-album-badges, .sp-track-badges');
          if (badgesRow) badgesRow.prepend(badge);
        }
      }

      const companionBox = document.getElementById('companionResult');
      if (companionBox) companionBox.style.display = 'none';

      this.highlightRecord(newTrack.id, false);
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

  initAudioSystem() {
    if (this._audioSystemInitialized) return;
    this._audioSystemInitialized = true;

    // Persistent HTML5 audio element attached to document
    let audioEl = document.getElementById('globalAppAudioPlayer');
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = 'globalAppAudioPlayer';
      audioEl.preload = 'auto';
      audioEl.crossOrigin = 'anonymous';
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
    this.audioElement = audioEl;

    // Restore volume
    try {
      const savedVol = localStorage.getItem('app_audio_volume');
      this.audioVolume = savedVol !== null ? parseFloat(savedVol) : 0.8;
      if (isNaN(this.audioVolume)) this.audioVolume = 0.8;
    } catch (e) {
      this.audioVolume = 0.8;
    }

    const volumeSlider = document.getElementById('playerVolume');
    if (volumeSlider) volumeSlider.value = this.audioVolume;
    if (audioEl) audioEl.volume = this.audioVolume;
  },

  unlockAudio() {
    try {
      if (!this.audioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    } catch (e) {}
  },

  playAudio(url, title = '', artist = '', coverUrl = '', btnElementOrId = null, album = '', source = '') {
    this.unlockAudio();

    if (!url) {
      if (title || artist) {
        this.showToastNotification(`🔍 Ищем аудио-превью для «${artist ? artist + ' — ' : ''}${title}»...`);
        this.fetchAndPlayPreview(title, artist, coverUrl, btnElementOrId, album);
        return;
      }
      this.showToastNotification('⚠️ Не указан аудио-файл для воспроизведения');
      return;
    }

    if (this.currentAudioBtnId && this.currentAudioBtnId !== btnElementOrId) {
      const prevBtn = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
      if (prevBtn) {
        prevBtn.classList.remove('playing');
        prevBtn.textContent = '▶';
      }
    }

    const isSameTrack = this.playingAudio && (
      this.playingAudio.src === url ||
      (this.playingAudio.src && url && (this.playingAudio.src.endsWith(url) || this.playingAudio.src.includes(encodeURIComponent(url)))) ||
      (this.currentAudioTrackTitle && title && this.currentAudioTrackTitle === title && (!artist || this.currentAudioArtist === artist))
    );
    if (isSameTrack) {
      this.toggleAudioPlayPause();
      return;
    }

    this.pauseAudio();

    this.currentAudioTrackTitle = title;
    this.currentAudioArtist = artist;
    this.currentAudioAlbumTitle = album;
    this.currentAudioCoverUrl = coverUrl;
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

    if (this.experiments.turntableAsmr) {
      if (playerEl) playerEl.style.display = 'none';
      this.openTurntableWidget({
        title: title || 'Аудио-трек',
        artist: artist || '',
        coverUrl: coverUrl || ''
      }, true);
    } else {
      if (playerEl) playerEl.style.display = 'block';
    }

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

    if (!this.audioElement) {
      this.initAudioSystem();
    }
    const audio = this.audioElement;
    audio.crossOrigin = 'anonymous';
    if (audio.src !== url) {
      audio.src = url;
      audio.load();
    }
    audio.volume = this.audioVolume !== undefined ? this.audioVolume : 0.8;
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
      this.updateTurntableProgress(cur, dur);
    };

    audio.onplay = () => {
      if (playPauseIcon) playPauseIcon.textContent = '⏸';
      const b = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
      if (b) {
        b.classList.add('playing');
        b.textContent = '⏸';
      }
      this.updateSearchPlayingHighlights();
      this.onTurntableAudioPlay();
    };

    audio.onpause = () => {
      if (playPauseIcon) playPauseIcon.textContent = '▶';
      const b = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
      if (b) {
        b.classList.remove('playing');
        b.textContent = '▶';
      }
      this.updateSearchPlayingHighlights();
      this.onTurntableAudioPause();
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
      this.onTurntableAudioEnded();
    };

    audio.onerror = (e) => {
      console.warn('Audio playback error:', e);
      if (!audio.src.includes('/api/audio-proxy') && audio.src.startsWith('http')) {
        const proxyUrl = `/api/audio-proxy?url=${encodeURIComponent(url)}`;
        console.log('Attempting playback through local audio proxy:', proxyUrl);
        audio.src = proxyUrl;
        audio.load();
        audio.play().then(() => {
          this.updateSearchPlayingHighlights();
          this.onTurntableAudioPlay();
        }).catch(err => {
          this.handlePlaybackFailure(btn, playPauseIcon, 'Аудио недоступно');
        });
        return;
      }
      this.handlePlaybackFailure(btn, playPauseIcon, 'Сбой воспроизведения аудио');
    };

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.then(() => {
        this.updateSearchPlayingHighlights();
        this.onTurntableAudioPlay();
      }).catch(e => {
        console.warn('Direct audio play() error:', e);
        if (!url.includes('/api/audio-proxy') && url.startsWith('http')) {
          const proxyUrl = `/api/audio-proxy?url=${encodeURIComponent(url)}`;
          audio.src = proxyUrl;
          audio.load();
          audio.play().then(() => {
            this.updateSearchPlayingHighlights();
            this.onTurntableAudioPlay();
          }).catch(proxyErr => {
            console.warn('Proxy audio play() error:', proxyErr);
            this.handlePlaybackFailure(btn, playPauseIcon, 'Браузер заблокировал воспроизведение. Нажмите ▶ еще раз');
          });
          return;
        }
        this.handlePlaybackFailure(btn, playPauseIcon, 'Нажмите ▶ для воспроизведения');
      });
    }
  },

  handlePlaybackFailure(btn, playPauseIcon, msg) {
    if (playPauseIcon) playPauseIcon.textContent = '▶';
    if (btn) {
      btn.classList.remove('playing');
      btn.textContent = '▶';
    }
    this.setCoverPulsing(false);
    this.stopVinylCrackle();
    if (msg) this.showToastNotification(msg);
    this.updateSearchPlayingHighlights();
  },

  async fetchAndPlayPreview(title, artist, coverUrl = '', btnElementOrId = null, album = '') {
    this.unlockAudio();
    const btn = typeof btnElementOrId === 'string' ? document.getElementById(btnElementOrId) : btnElementOrId;
    if (btn) {
      btn.textContent = '⏳';
      btn.classList.add('playing');
    }
    try {
      const res = await fetch(`/api/track/preview?track=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.found && data.previewUrl) {
          const finalCover = this.getSafeCoverUrl(coverUrl || data.coverImage, artist, album || data.album);
          this.playAudio(data.previewUrl, title, artist, finalCover, btnElementOrId, album || data.album, data.source);
          return;
        }
      }
    } catch (e) {
      console.warn('Preview search failed:', e);
    }
    if (btn) {
      btn.classList.remove('playing');
      btn.textContent = '✕';
      setTimeout(() => { if (btn) btn.textContent = '▶'; }, 2000);
    }
    this.showToastNotification(`Аудио-превью для «${artist ? artist + ' — ' : ''}${title}» не найдено`);
  },

  pauseAudio() {
    if (this.playingAudio && !this.playingAudio.paused) {
      this.playingAudio.pause();
    }
    if (this.audioElement && !this.audioElement.paused) {
      this.audioElement.pause();
    }
    this.stopVinylCrackle();
    this.onTurntableAudioPause();

    const b = typeof this.currentAudioBtnId === 'string' ? document.getElementById(this.currentAudioBtnId) : this.currentAudioBtnId;
    if (b) {
      b.classList.remove('playing');
      b.textContent = '▶';
    }
    const playPauseIcon = document.getElementById('playerPlayPauseIcon');
    if (playPauseIcon) playPauseIcon.textContent = '▶';
    const ttPlayIcon = document.getElementById('ttPlayIcon');
    if (ttPlayIcon) ttPlayIcon.textContent = '▶';

    this.setCoverPulsing(false);
    this.updateSearchPlayingHighlights();
    this.updateFloatingPlayerButtonUI();
  },

  stopAudio() {
    this.pauseAudio();

    // 1. Force stop, reset and clear all audio objects
    if (this.playingAudio) {
      try {
        this.playingAudio.pause();
        this.playingAudio.currentTime = 0;
        this.playingAudio.src = '';
      } catch (e) {}
      this.playingAudio = null;
    }
    if (this.audioElement) {
      try {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;
        this.audioElement.src = '';
      } catch (e) {}
    }

    // 2. Clear all audio/video elements across document
    try {
      document.querySelectorAll('audio, video').forEach(el => {
        try {
          el.pause();
          el.currentTime = 0;
          el.src = '';
        } catch (e) {}
      });
    } catch (e) {}

    // 3. Stop ASMR noise & suspend audio context completely
    this.stopVinylCrackle();
    if (this.audioCtx) {
      try { this.audioCtx.suspend().catch(() => {}); } catch (e) {}
    }

    // 4. Reset scrubbers & time labels in both players
    const curTime = document.getElementById('playerCurrentTime');
    if (curTime) curTime.textContent = '0:00';
    const scrubber = document.getElementById('playerScrubber');
    if (scrubber) scrubber.value = 0;

    const ttCurTime = document.getElementById('ttTimeCurrent');
    if (ttCurTime) ttCurTime.textContent = '0:00';
    const ttFill = document.getElementById('ttScrubberFill');
    if (ttFill) ttFill.style.width = '0%';

    // 5. Reset tonearm back to rest cradle and stop platter
    if (this.turntableState) {
      this.turntableState.isPlaying = false;
      this.applyTonearmAngle(this.turntableState.restAngle || -16, true);
      const tonearm = document.getElementById('ttTonearm');
      if (tonearm) {
        tonearm.classList.remove('arm-lifted');
        tonearm.classList.remove('is-dragging');
      }
      const platter = document.getElementById('ttPlatter');
      if (platter) platter.classList.remove('is-spinning');
      const ttPlayIcon = document.getElementById('ttPlayIcon');
      if (ttPlayIcon) ttPlayIcon.textContent = '▶';
    }

    const playPauseIcon = document.getElementById('playerPlayPauseIcon');
    if (playPauseIcon) playPauseIcon.textContent = '▶';

    document.querySelectorAll('.preview-audio-btn, .tracklist-play-btn, .sp-track-play-btn, .record-play-btn').forEach(b => {
      b.classList.remove('playing');
      if (b.textContent === '⏸' || b.textContent === '⏳') b.textContent = '▶';
    });

    this.currentAudioTrackTitle = null;
    this.currentAudioArtist = null;
    this.currentAudioAlbumTitle = null;
    this.currentAudioCoverUrl = null;
    this.currentAudioBtnId = null;

    this.setCoverPulsing(false);
    this.updateSearchPlayingHighlights();
    this.updateFloatingPlayerButtonUI();
  },

  stopAndCloseTurntableWidget() {
    this.stopAudio();
    this.closeTurntableWidget();
  },

  stopAndCloseAudioPlayer() {
    this.stopAudio();
    const playerEl = document.getElementById('bottomAudioPlayer');
    if (playerEl) playerEl.style.display = 'none';
    this.currentAudioTrackTitle = null;
    this.currentAudioArtist = null;
    this.currentAudioAlbumTitle = null;
    this.currentAudioBtnId = null;
    this.updateSearchPlayingHighlights();
    this.updateFloatingPlayerButtonUI();
  },

  toggleAudioPlayPause() {
    this.unlockAudio();
    if (!this.playingAudio || !this.playingAudio.src) {
      this.playTurntableDefaultTrack();
      return;
    }
    if (this.playingAudio.paused) {
      this.playingAudio.play().then(() => {
        this.onTurntableAudioPlay();
        this.updateFloatingPlayerButtonUI();
      }).catch((e) => {
        console.warn('Resume error:', e);
        this.showToastNotification('Нажмите ▶ для воспроизведения');
      });
    } else {
      this.pauseAudio();
    }
  },

  seekAudioRelative(seconds) {
    if (!this.playingAudio) return;
    const dur = this.playingAudio.duration || 30;
    const newTime = Math.max(0, Math.min(dur, (this.playingAudio.currentTime || 0) + seconds));
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
    const v = Math.max(0, Math.min(1, parseFloat(val)));
    this.audioVolume = isNaN(v) ? 0.8 : v;
    try {
      localStorage.setItem('app_audio_volume', String(this.audioVolume));
    } catch (e) {}
    if (this.playingAudio) {
      this.playingAudio.volume = this.audioVolume;
    }
    const volInput = document.getElementById('playerVolume');
    if (volInput) volInput.value = this.audioVolume;
  },

  togglePlayerWidget() {
    if (this.experiments.turntableAsmr) {
      const widget = document.getElementById('vinylTurntableWidget');
      const isVisible = widget && widget.style.display !== 'none';
      if (isVisible) {
        this.closeTurntableWidget();
      } else {
        const track = (this.turntableState && this.turntableState.currentTrack) ? this.turntableState.currentTrack : {
          title: this.currentAudioTrackTitle || 'Виниловый проигрыватель',
          artist: this.currentAudioArtist || '',
          coverUrl: this.currentAudioCoverUrl || ''
        };
        const isPlaying = !!(this.playingAudio && !this.playingAudio.paused);
        this.openTurntableWidget(track, isPlaying);
      }
    } else {
      const bottomPlayer = document.getElementById('bottomAudioPlayer');
      if (bottomPlayer) {
        const isVisible = bottomPlayer.style.display !== 'none';
        bottomPlayer.style.display = isVisible ? 'none' : 'block';
      }
    }
    this.updateFloatingPlayerButtonUI();
  },

  updateFloatingPlayerButtonUI() {
    const btn = document.getElementById('floatingPlayerBtn');
    const badge = document.getElementById('floatingPlayerBadge');
    if (!btn) return;

    const isAudioPlaying = !!(this.playingAudio && !this.playingAudio.paused && !this.playingAudio.ended);

    if (isAudioPlaying) {
      btn.classList.add('is-playing');
      if (badge) badge.textContent = '⏸';
      const label = this.currentAudioTrackTitle
        ? `${this.currentAudioArtist ? this.currentAudioArtist + ' — ' : ''}${this.currentAudioTrackTitle}`
        : 'Воспроизведение';
      btn.title = `🎵 Сейчас играет: ${label}\nНажмите, чтобы открыть проигрыватель`;
    } else {
      btn.classList.remove('is-playing');
      if (badge) badge.textContent = '▶';
      btn.title = '💿 Проигрыватель винила (Нажмите, чтобы открыть)';
    }
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

  prefetchAlbumTracklist(itemOrId) {
    let item = itemOrId;
    if (typeof itemOrId === 'string' || typeof itemOrId === 'number') {
      const sId = String(itemOrId);
      item = (this.searchItemsMap && (this.searchItemsMap.get(sId) || this.searchItemsMap.get(sId.replace('sp-', '')))) || null;
    }
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

            // Dynamically update title tracks slash and earliest year in search cards immediately
            const slashEl = document.getElementById(`titleTracksSlash-${item.id}`);
            if (slashEl) {
              slashEl.textContent = ` / ${data.tracklist.length}`;
              slashEl.style.display = 'inline';
            }
            if (data.year && !item.year) {
              const yearEl = document.getElementById(`searchYear-${item.id}`);
              if (yearEl && !yearEl.textContent.trim()) {
                yearEl.textContent = `Год: ${data.year} •`;
                yearEl.style.display = 'inline';
              }
            }
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
        const searchedQuery = [item.artist, item.album || item.title].filter(Boolean).join(' - ');
        listEl.innerHTML = `
          <div style="text-align:center; padding:28px 16px; color:var(--text-muted);">
            <div style="font-size:28px; margin-bottom:8px;">🎵</div>
            <div style="font-size:14px; color:var(--text-primary); font-weight:600; margin-bottom:6px;">
              Треклист автоматически не определился
            </div>
            <div style="font-size:12px; color:var(--text-secondary); max-width:380px; margin:0 auto 14px auto;">
              Вы можете запустить ручной поиск по исполнителю и названию альбома или ввести альтернативное название издания:
            </div>
            <button type="button" class="btn btn-sm btn-primary" onclick="App.toggleTracklistManualSearch(true)" style="padding:6px 14px; font-size:12px;">
              ⚙️ Найти вручную «${this.escapeHtml(searchedQuery || 'альбом')}»
            </button>
          </div>
        `;
      }
      return;
    }

    const targetArtist = item.artist || data.artist || '';
    const targetTitle = item.album || item.title || data.title || 'Треклист альбома';

    // Year: item's exact pressing year or first press year has absolute priority over generic/Spotify data.year
    let targetYear = item.year || item.released || item.firstPressYear || '';
    if (!targetYear && item.masterId) {
      targetYear = this.getAlbumEarliestYear(item);
    }
    if (!targetYear) {
      targetYear = data.year || '';
    }

    // Cover: item's exact cover from search card / library item has absolute priority over generic/Spotify data.cover
    const rawCover = item.coverImage || item.thumb || data.cover || '';
    const coverArtist = targetArtist;
    const coverAlbum = targetTitle;
    const coverUrl = this.getSafeCoverUrl(rawCover, coverArtist, coverAlbum);

    if (modalCover && coverUrl) {
      modalCover.src = coverUrl;
      modalCover.style.display = 'block';
      modalCover.onerror = () => {
        modalCover.onerror = null;
        modalCover.src = `/api/cover-image?artist=${encodeURIComponent(coverArtist)}&album=${encodeURIComponent(coverAlbum)}`;
      };
    }
    if (largeCover && coverUrl) {
      largeCover.src = coverUrl;
      largeCover.style.display = 'block';
      largeCover.onerror = () => {
        largeCover.onerror = null;
        largeCover.src = `/api/cover-image?artist=${encodeURIComponent(coverArtist)}&album=${encodeURIComponent(coverAlbum)}`;
      };
    }
    if (modalTitle && targetTitle) {
      modalTitle.textContent = targetTitle;
    }
    if (modalSub && (targetArtist || targetYear)) {
      modalSub.textContent = `${targetArtist}${targetYear ? ` · ${targetYear}` : ''}`;
    }
    if (metaArtist) metaArtist.textContent = targetArtist;
    if (metaAlbum) metaAlbum.textContent = targetTitle;
    if (metaBadges) {
      metaBadges.innerHTML = `
        ${targetYear ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">📅 ${this.escapeHtml(targetYear)}</span>` : ''}
        <span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">🎵 Треков: ${data.tracklist.length}</span>
        ${item.format ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">💽 ${this.escapeHtml(item.format)}</span>` : ''}
        ${item.country ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">🌍 ${this.escapeHtml(item.country)}</span>` : ''}
      `;
    }

    const artistName = data.artist || item.artist || '';

    const isFallback = Boolean(data.source && data.source !== 'Discogs');
    const sourceLabel = data.source || (data.discogsNotFound ? 'Spotify' : 'Discogs');
    const fallbackBanner = isFallback ? `
      <div class="spotify-fallback-notice" style="background:rgba(56, 189, 248, 0.12); border:1px solid rgba(56, 189, 248, 0.35); border-radius:6px; padding:8px 12px; margin-bottom:12px; font-size:11.5px; color:#bae6fd; display:flex; align-items:center; gap:8px;">
        <span style="font-size:14px;">ℹ️</span>
        <span>${this.escapeHtml(data.message || `Оригинальный треклист альбома успешно загружен из базы ${sourceLabel}`)}</span>
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
              <button type="button" class="sp-btn sp-btn-add tracklist-add-track-btn" onclick="App.addTrackByIndex(${idx})" title="Добавить песню в треки">
                + Добавить в треки
              </button>
            </div>
          </div>
        `;
      }).join('');
      listEl.style.display = 'block';
    }

    // Re-apply any existing active filter
    const filterInput = document.getElementById('tracklistFilterInput');
    if (filterInput && filterInput.value) {
      this.filterAlbumTracklist(filterInput.value);
    }
  },

  filterAlbumTracklist(query) {
    const q = (query || '').toLowerCase().trim();
    const rows = document.querySelectorAll('#tracklistModalList .tracklist-item-row');
    const clearBtn = document.getElementById('tracklistFilterClearBtn');
    if (clearBtn) {
      clearBtn.style.display = q ? 'inline-block' : 'none';
    }
    let visibleCount = 0;
    rows.forEach(row => {
      if (!q) {
        row.style.display = 'flex';
        visibleCount++;
        return;
      }
      const titleEl = row.querySelector('.tracklist-title-text');
      const artistEl = row.querySelector('.album-track-artist');
      const posEl = row.querySelector('.tracklist-pos-badge');
      const text = `${titleEl ? titleEl.textContent : ''} ${artistEl ? artistEl.textContent : ''} ${posEl ? posEl.textContent : ''}`.toLowerCase();
      const match = text.includes(q);
      row.style.display = match ? 'flex' : 'none';
      if (match) visibleCount++;
    });

    let noResultsEl = document.getElementById('tracklistFilterNoResults');
    if (visibleCount === 0 && q) {
      if (!noResultsEl) {
        noResultsEl = document.createElement('div');
        noResultsEl.id = 'tracklistFilterNoResults';
        noResultsEl.style.cssText = 'text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px;';
        noResultsEl.innerHTML = `Песня не найдена по запросу «<b>${this.escapeHtml(q)}</b>».<br><a href="javascript:void(0)" onclick="App.toggleTracklistManualSearch(true)" style="color:var(--accent-theme); font-weight:600; text-decoration:underline; display:inline-block; margin-top:8px;">Попробовать найти вручную другую версию альбома ⚙️</a>`;
        const listEl = document.getElementById('tracklistModalList');
        if (listEl) listEl.appendChild(noResultsEl);
      } else {
        noResultsEl.style.display = 'block';
        noResultsEl.innerHTML = `Песня не найдена по запросу «<b>${this.escapeHtml(q)}</b>».<br><a href="javascript:void(0)" onclick="App.toggleTracklistManualSearch(true)" style="color:var(--accent-theme); font-weight:600; text-decoration:underline; display:inline-block; margin-top:8px;">Попробовать найти вручную другую версию альбома ⚙️</a>`;
      }
    } else if (noResultsEl) {
      noResultsEl.style.display = 'none';
    }
  },

  clearTracklistFilter() {
    const input = document.getElementById('tracklistFilterInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('tracklistFilterClearBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    const noResultsEl = document.getElementById('tracklistFilterNoResults');
    if (noResultsEl) noResultsEl.style.display = 'none';
    const rows = document.querySelectorAll('#tracklistModalList .tracklist-item-row');
    rows.forEach(row => row.style.display = 'flex');
  },

  toggleTracklistManualSearch(forceOpen = false) {
    const panel = document.getElementById('tracklistManualSearchPanel');
    if (!panel) return;
    if (forceOpen) {
      panel.style.display = 'flex';
    } else {
      panel.style.display = panel.style.display === 'none' || !panel.style.display ? 'flex' : 'none';
    }
    if (panel.style.display === 'flex') {
      const input = document.getElementById('tracklistCustomQueryInput');
      if (input) {
        input.focus();
        input.select();
      }
    }
  },

  async searchCustomTracklist() {
    const input = document.getElementById('tracklistCustomQueryInput');
    if (!input) return;
    const query = (input.value || '').trim();
    if (!query) {
      this.showToastNotification('Введите название альбома или исполнителя');
      return;
    }

    const loadingEl = document.getElementById('tracklistModalLoading');
    const listEl = document.getElementById('tracklistModalList');
    if (loadingEl) {
      loadingEl.style.display = 'block';
      loadingEl.textContent = `⏳ Поиск треков для «${query}» во всех базах...`;
    }
    if (listEl) listEl.style.display = 'none';

    let artist = '';
    let album = query;
    if (query.includes(' - ')) {
      const parts = query.split(' - ');
      artist = parts[0].trim();
      album = parts.slice(1).join(' - ').trim();
    } else if (this.currentModalAlbumItem && this.currentModalAlbumItem.artist) {
      artist = this.currentModalAlbumItem.artist;
    }

    try {
      const url = `/api/discogs/tracklist?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      const data = res.ok ? await res.json() : null;

      if (data && data.tracklist && data.tracklist.length > 0) {
        this.saveTracklistToCache(query.toLowerCase(), data);
        if (artist && album) {
          this.saveTracklistToCache(`${artist.toLowerCase()}:::${album.toLowerCase()}`, data);
        }
        this.renderTracklistData(data, this.currentModalAlbumItem || { artist, album });
        this.showToastNotification(`✅ Найдено треков: ${data.tracklist.length} (${data.source || 'База'})`);
      } else {
        if (loadingEl) loadingEl.style.display = 'none';
        if (listEl) {
          listEl.style.display = 'block';
          listEl.innerHTML = `
            <div style="text-align:center; padding:28px 16px; color:var(--text-muted);">
              <div style="font-size:28px; margin-bottom:8px;">🔍</div>
              <div style="font-size:14px; color:var(--text-primary); font-weight:600; margin-bottom:6px;">
                Треклист по запросу «${this.escapeHtml(query)}» не найден
              </div>
              <div style="font-size:12px; color:var(--text-secondary); max-width:380px; margin:0 auto 14px auto;">
                Попробуйте указать только имя исполнителя и главное название альбома без переизданий или скобок (напр. «Queen - News of the World»).
              </div>
            </div>
          `;
        }
      }
    } catch (err) {
      if (loadingEl) loadingEl.style.display = 'none';
      if (listEl) {
        listEl.style.display = 'block';
        listEl.innerHTML = `<div style="text-align:center; padding:24px; color:#f87171;">Ошибка поиска треклиста: ${this.escapeHtml(err.message)}</div>`;
      }
    }
  },

  async openAlbumTracklistModal(itemId, fallbackObj = null) {
    let item = (fallbackObj && typeof fallbackObj === 'object') ? fallbackObj : null;
    if (!item && this.searchItemsMap) {
      item = this.searchItemsMap.get(String(itemId)) || null;
      if (!item && String(itemId).startsWith('sp-')) {
        item = this.searchItemsMap.get(String(itemId).replace('sp-', '')) || null;
      }
    }
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
    if (!item) {
      item = { id: itemId, artist: '', title: String(itemId) };
    }

    // Split "Artist - Album" if artist is empty but title or album has " - "
    if (!item.artist && (item.title || item.album)) {
      const raw = item.title || item.album || '';
      if (raw.includes(' - ')) {
        const parts = raw.split(' - ');
        item.artist = parts[0].trim();
        item.album = parts.slice(1).join(' - ').trim();
      }
    }

    this.currentModalAlbumItem = item;

    const modal = document.getElementById('albumTracklistModal');
    if (!modal) return;

    // Reset filter and manual search bar
    this.clearTracklistFilter();
    const manualPanel = document.getElementById('tracklistManualSearchPanel');
    if (manualPanel) manualPanel.style.display = 'none';

    const customQueryInput = document.getElementById('tracklistCustomQueryInput');
    if (customQueryInput) {
      const defaultQuery = [item.artist, item.album || item.title].filter(Boolean).join(' - ');
      customQueryInput.value = defaultQuery;
      if (!customQueryInput._hasEnterListener) {
        customQueryInput._hasEnterListener = true;
        customQueryInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.searchCustomTracklist();
          }
        });
      }
    }

    const modalCover = document.getElementById('tracklistModalCover');
    const largeCover = document.getElementById('tracklistModalLargeCover');
    const metaArtist = document.getElementById('tracklistMetaArtist');
    const metaAlbum = document.getElementById('tracklistMetaAlbum');
    const metaBadges = document.getElementById('tracklistMetaBadges');
    const modalTitle = document.getElementById('tracklistModalTitle');
    const modalSub = document.getElementById('tracklistModalSub');
    const loadingEl = document.getElementById('tracklistModalLoading');
    const listEl = document.getElementById('tracklistModalList');

    const displayTitle = item.album || item.title || 'Треклист альбома';
    const safeCover = this.getSafeCoverUrl(item.coverImage || item.thumb || '', item.artist, displayTitle);
    if (modalCover) {
      modalCover.src = safeCover || '';
      modalCover.style.display = safeCover ? 'block' : 'none';
      modalCover.onerror = () => {
        modalCover.onerror = null;
        modalCover.src = `/api/cover-image?artist=${encodeURIComponent(item.artist || '')}&album=${encodeURIComponent(displayTitle)}`;
      };
    }
    if (largeCover) {
      largeCover.src = safeCover || '';
      largeCover.style.display = safeCover ? 'block' : 'none';
      largeCover.onerror = () => {
        largeCover.onerror = null;
        largeCover.src = `/api/cover-image?artist=${encodeURIComponent(item.artist || '')}&album=${encodeURIComponent(displayTitle)}`;
      };
    }
    const displayYear = item.year || item.released || item.firstPressYear || (item.masterId ? this.getAlbumEarliestYear(item) : '');
    const displaySub = `${item.artist || 'Неизвестный исполнитель'}${displayYear ? ` · ${displayYear}` : (item.album && item.title !== item.album ? ` · ${item.title}` : '')}`;
    if (modalTitle) modalTitle.textContent = displayTitle;
    if (modalSub) modalSub.textContent = displaySub;

    if (metaArtist) metaArtist.textContent = item.artist || 'Неизвестный исполнитель';
    if (metaAlbum) metaAlbum.textContent = displayTitle;
    if (metaBadges) {
      metaBadges.innerHTML = `
        ${displayYear ? `<span class="badge" style="background:rgba(255,255,255,0.08); font-size:11px;">📅 ${this.escapeHtml(displayYear)}</span>` : ''}
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

      const qArtist = item.artist || '';
      const qAlbum = item.album || item.title || '';
      const qFull = [qArtist, qAlbum].filter(Boolean).join(' - ');

      // Concurrent fetch: 1. Discogs tracklist (server falls back to Spotify/Deezer/iTunes automatically)
      if (queryId || (qArtist && qAlbum) || qFull) {
        reqs.push(
          fetch(`/api/discogs/tracklist?id=${encodeURIComponent(queryId || '')}&type=${queryType}&artist=${encodeURIComponent(qArtist)}&album=${encodeURIComponent(qAlbum)}&q=${encodeURIComponent(qFull)}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        );
      }

      // Concurrent fetch: 2. Spotify album tracks directly
      if (rawSpId || (qArtist && qAlbum)) {
        reqs.push(
          fetch(`/api/spotify/album/tracks?id=${encodeURIComponent(rawSpId || '')}&artist=${encodeURIComponent(qArtist)}&album=${encodeURIComponent(qAlbum)}`)
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
    this.unlockAudio();
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
      this.closeTurntableWidget();
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
            track.previewUrl = audioUrl;
            track.source = previewSource;
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
        }
        // Keep row in place without scrolling
      }

      this.highlightRecord(newTrack.id, false);
      this.showToastNotification(`✓ Песня «${newTrack.title}» добавлена в «${tableName}»`);
    });
  },

  closeAlbumTracklistModal() {
    this.clearTrackVideo();
    this.setCoverPulsing(false);
    this.clearTracklistFilter();
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
        const cb = card.querySelector('.search-item-checkbox');
        if (cb) {
          cb.checked = false;
          cb.disabled = true;
        }
        let badge = card.querySelector('.in-library-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'in-library-badge';
          badge.textContent = `✓ В таблице: ${tableName}`;
          const badgesRow = card.querySelector('.search-tags');
          if (badgesRow) badgesRow.prepend(badge);
        }
      }

      this.highlightRecord(newRecord.id, false);
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

    const dcSt = document.getElementById('settingsDiscogsStatus');
    if (dcSt) {
      if (user && user.username) {
        dcSt.innerHTML = `<span class="dot" style="background:#22c55e;"></span> @${this.escapeHtml(user.username)} (${user.num_collection || 0} в коллекции)`;
      } else if (DiscogsClient && DiscogsClient.token) {
        dcSt.innerHTML = `<span class="dot" style="background:#22c55e;"></span> Подключен (API Token)`;
      } else {
        dcSt.innerHTML = `<span class="dot"></span> Не подключен`;
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

    const spSt = document.getElementById('settingsSpotifyStatus');
    if (spSt) {
      if (user && (user.id || user.display_name)) {
        const name = user.display_name || user.id;
        spSt.innerHTML = `<span class="dot" style="background:#22c55e;"></span> Авторизован (@${this.escapeHtml(name)})`;
      } else if (SpotifyClient.isAuthenticated()) {
        spSt.innerHTML = `<span class="dot" style="background:#22c55e;"></span> Подключен`;
      } else {
        spSt.innerHTML = `<span class="dot"></span> Не авторизован`;
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

  openGlobalSettingsModal() {
    this.renderCloudStatus({
      isFirebaseActive: Boolean(window.firebaseSync && firebaseSync.db),
      collectionName: (window.firebaseSync && firebaseSync.collectionName) || 'vinyl_records'
    });
    this.updateDiscogsUIStatus();
    this.updateSpotifyUIStatus();
    const modal = document.getElementById('globalSettingsModal');
    if (modal) modal.classList.add('open');
  },

  closeGlobalSettingsModal() {
    const modal = document.getElementById('globalSettingsModal');
    if (modal) modal.classList.remove('open');
  },

  renderCloudStatus(info) {
    const badge = document.getElementById('cloudHeaderBadge');
    if (badge) {
      if (info.isFirebaseActive) {
        badge.innerHTML = `<span class="dot online"></span> Firebase Cloud`;
        badge.classList.add('active');
      } else {
        badge.innerHTML = `<span class="dot warn"></span> Локально (Offline)`;
        badge.classList.remove('active');
      }
    }
    const stEl = document.getElementById('settingsFirebaseStatus');
    if (stEl) {
      if (info.isFirebaseActive) {
        stEl.innerHTML = `<span class="dot" style="background:#22c55e;"></span> Подключено (Коллекция: ${this.escapeHtml(info.collectionName || 'vinyl_records')})`;
      } else {
        stEl.innerHTML = `<span class="dot warn"></span> Локально (Offline)`;
      }
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

  // ----------------------------------------------------
  // EXPERIMENTAL FEATURES & GOLDEN VINYL LAB
  // ----------------------------------------------------
  openExperimentalModal() {
    const modal = document.getElementById('experimentalModal');
    if (!modal) return;
    const keys = ['compactTable', 'smartRecs', 'turntableAsmr'];
    keys.forEach(k => {
      const toggleId = 'expToggle' + k.charAt(0).toUpperCase() + k.slice(1);
      const input = document.getElementById(toggleId);
      if (input) input.checked = Boolean(this.experiments[k]);
    });
    this.updateMasterToggleBtnState();
    modal.classList.add('open');
    modal.classList.add('active');
  },

  closeExperimentalModal() {
    const modal = document.getElementById('experimentalModal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.remove('active');
    }
  },

  setExperimentState(key, val) {
    this.experiments[key] = Boolean(val);
    try {
      localStorage.setItem('vh_experiments', JSON.stringify(this.experiments));
    } catch (e) {}
    this.updateMasterToggleBtnState();
    this.applyExperimentEffects();
  },

  toggleAllExperimentsMaster() {
    const anyActive = Object.values(this.experiments).some(Boolean);
    const targetState = !anyActive;
    Object.keys(this.experiments).forEach(k => {
      this.experiments[k] = targetState;
      const toggleId = 'expToggle' + k.charAt(0).toUpperCase() + k.slice(1);
      const input = document.getElementById(toggleId);
      if (input) input.checked = targetState;
    });
    try {
      localStorage.setItem('vh_experiments', JSON.stringify(this.experiments));
    } catch (e) {}
    this.updateMasterToggleBtnState();
    this.applyExperimentEffects();
  },

  updateMasterToggleBtnState() {
    const btn = document.getElementById('btnToggleAllExp');
    if (!btn) return;
    const allActive = Object.values(this.experiments).every(Boolean);
    btn.textContent = allActive ? 'Отключить все' : 'Включить все';
  },

  applyExperimentEffects() {
    // 1. Compact table mode (clean, no left dock)
    document.body.classList.toggle('compact-table-mode', Boolean(this.experiments.compactTable));

    // 2. Smart Recommendations
    const recsBar = document.getElementById('smartRecommendationsBar');
    if (recsBar) {
      recsBar.style.display = this.experiments.smartRecs ? 'block' : 'none';
      if (this.experiments.smartRecs) {
        this.renderSmartRecommendations();
      } else {
        recsBar.innerHTML = '';
      }
    }

    // 3. Hi-Fi Turntable ASMR / 3D Smart Vinyl Player
    document.body.classList.toggle('turntable-asmr-active', Boolean(this.experiments.turntableAsmr));
    const bottomPlayerEl = document.getElementById('bottomAudioPlayer');
    const ttWidget = document.getElementById('vinylTurntableWidget');
    if (!this.experiments.turntableAsmr) {
      if (ttWidget) ttWidget.style.display = 'none';
      this.turntableState.isOpen = false;
      this.stopVinylCrackle();
      if (this.playingAudio && !this.playingAudio.paused) {
        if (bottomPlayerEl) bottomPlayerEl.style.display = 'block';
      }
    }

    // Native total collection sale valuation
    this.updateValuationStats();

    this.renderTable();
  },

  onTableRowClick(event, itemId) {
    // Audio is strictly played ONLY when the user explicitly clicks a dedicated play button (▶).
    // Clicking rows in the table does NOT start audio playback.
    return;
  },

  // ----------------------------------------------------
  // SMART RECOMMENDATIONS & "FEELING LUCKY" (Experiment 3)
  // ----------------------------------------------------
  iconicVinylGems: [
    { artist: 'Pink Floyd', title: 'The Dark Side of the Moon', year: '1973', tag: 'Культовый шедевр', cover: '/api/cover-image?artist=Pink+Floyd&album=The+Dark+Side+of+the+Moon' },
    { artist: 'Miles Davis', title: 'Kind of Blue', year: '1959', tag: 'Легендарный джаз', cover: '/api/cover-image?artist=Miles+Davis&album=Kind+of+Blue' },
    { artist: 'Daft Punk', title: 'Random Access Memories', year: '2013', tag: 'Эталон электроники', cover: '/api/cover-image?artist=Daft+Punk&album=Random+Access+Memories' },
    { artist: 'Fleetwood Mac', title: 'Rumours', year: '1977', tag: 'Золотая классика', cover: '/api/cover-image?artist=Fleetwood+Mac&album=Rumours' },
    { artist: 'The Beatles', title: 'Abbey Road', year: '1969', tag: 'Пластинка эпохи', cover: '/api/cover-image?artist=The+Beatles&album=Abbey+Road' },
    { artist: 'Radiohead', title: 'OK Computer', year: '1997', tag: 'Арт-рок икона', cover: '/api/cover-image?artist=Radiohead&album=OK+Computer' },
    { artist: 'Michael Jackson', title: 'Thriller', year: '1982', tag: 'Самый продаваемый', cover: '/api/cover-image?artist=Michael+Jackson&album=Thriller' },
    { artist: 'John Coltrane', title: 'Blue Train', year: '1958', tag: 'Хард-боп раритет', cover: '/api/cover-image?artist=John+Coltrane&album=Blue+Train' },
    { artist: 'David Bowie', title: 'The Rise and Fall of Ziggy Stardust', year: '1972', tag: 'Глэм-рок винил', cover: '/api/cover-image?artist=David+Bowie&album=The+Rise+and+Fall+of+Ziggy+Stardust' },
    { artist: 'Nirvana', title: 'Nevermind', year: '1991', tag: 'Гранж революция', cover: '/api/cover-image?artist=Nirvana&album=Nevermind' },
    { artist: 'Led Zeppelin', title: 'Led Zeppelin IV', year: '1971', tag: 'Хард-рок классика', cover: '/api/cover-image?artist=Led+Zeppelin&album=Led+Zeppelin+IV' },
    { artist: 'Steely Dan', title: 'Aja', year: '1977', tag: 'Аудиофильский тест', cover: '/api/cover-image?artist=Steely+Dan&album=Aja' }
  ],

  renderSmartRecommendations() {
    const container = document.getElementById('recsCardsDeck');
    if (!container) return;

    const allItems = [...this.records, ...this.albums, ...this.spotifyTracks];
    const artistCounts = {};
    allItems.forEach(it => {
      const a = (it.artist || '').trim();
      if (a) artistCounts[a] = (artistCounts[a] || 0) + 1;
    });

    const sortedArtists = Object.keys(artistCounts).sort((a, b) => artistCounts[b] - artistCounts[a]);
    const topArtist = sortedArtists[0] || null;

    const recs = [];
    if (topArtist) {
      // Find representative album cover for top artist
      const artistItem = allItems.find(it => (it.artist || '').trim().toLowerCase() === topArtist.toLowerCase() && (it.coverImage || it.thumb));
      const artistCover = artistItem ? (artistItem.coverImage || artistItem.thumb) : '';
      recs.push({
        artist: topArtist,
        title: `Дискография ${topArtist}`,
        tag: `🔥 Топ артист (${artistCounts[topArtist]} шт.)`,
        isArtistQuery: true,
        cover: artistCover || `/api/cover-image?artist=${encodeURIComponent(topArtist)}`
      });
    }

    this.iconicVinylGems.slice(0, 7).forEach(gem => {
      recs.push(gem);
    });

    container.innerHTML = recs.map(r => {
      const coverUrl = r.cover || `/api/cover-image?artist=${encodeURIComponent(r.artist)}&album=${encodeURIComponent(r.isArtistQuery ? '' : r.title)}`;
      const safeArtist = this.escapeHtml(r.artist);
      const safeTitle = this.escapeHtml(r.title);
      const queryTitle = r.isArtistQuery ? '' : safeTitle;
      return `
        <div class="rec-album-card">
          <img src="${coverUrl}" class="rec-card-cover" alt="${safeTitle}" loading="lazy" onerror="if (!this.dataset.err) { this.dataset.err='1'; this.src='/api/cover-image?artist='+encodeURIComponent('${safeArtist}')+'&album='+encodeURIComponent('${queryTitle}'); }" onclick="App.searchRecommendedVinyl('${safeArtist}', '${queryTitle}')">
          <span class="rec-card-badge">${this.escapeHtml(r.tag)}</span>
          <div class="rec-card-title" title="${safeTitle}">${safeTitle}</div>
          <div class="rec-card-artist" title="${safeArtist}">${safeArtist}${r.year ? ` · ${r.year}` : ''}</div>
          <div class="rec-card-actions">
            <button type="button" class="btn btn-sm btn-primary" style="font-size:11px; padding:4px 8px; width:100%; border-radius:6px; font-weight:700;" onclick="App.searchRecommendedVinyl('${safeArtist}', '${queryTitle}')">
              💽 Найти винил
            </button>
          </div>
        </div>
      `;
    }).join('');
  },

  searchRecommendedVinyl(artist, title = '') {
    this.openDiscogsSearchModal();
    this.setSearchProvider('discogs', false);
    const q = title ? `${artist} ${title}` : artist;
    const input = document.getElementById('discogsSearchInput');
    if (input) {
      input.value = q;
      this.performDiscogsSearch();
    }
  },

  rollLuckyVinyl() {
    const randomIndex = Math.floor(Math.random() * this.iconicVinylGems.length);
    const gem = this.iconicVinylGems[randomIndex];
    this.searchRecommendedVinyl(gem.artist, gem.title);
  },

  // ----------------------------------------------------
  // HI-FI VINYL TURNTABLE WIDGET & ASMR CRACKLE (Experiment 5)
  // ----------------------------------------------------
  turntableState: {
    isOpen: false,
    isPacked: true,
    isPlaying: false,
    crackleEnabled: true,
    currentTrack: null,
    isLifted: false,
    wasPlayingBeforeLift: false,
    isDragging: false,
    currentAngle: -16,
    restAngle: -16,
    leadInAngle: 14,
    leadOutAngle: 38
  },

  openTurntableWidget(trackInfo = null, isPlayingImmediately = false) {
    if (!this.experiments.turntableAsmr) {
      const bottomPlayer = document.getElementById('bottomAudioPlayer');
      if (bottomPlayer && (this.playingAudio || trackInfo)) {
        bottomPlayer.style.display = 'block';
      }
      return;
    }
    const widget = document.getElementById('vinylTurntableWidget');
    if (!widget) return;
    widget.style.display = 'flex';
    this.turntableState.isOpen = true;

    const playerEl = document.getElementById('bottomAudioPlayer');
    if (playerEl) {
      playerEl.style.display = 'none';
    }

    if (trackInfo) {
      this.loadTurntableTrack(trackInfo, isPlayingImmediately);
    }
  },

  closeTurntableWidget() {
    this.stopAudio();
    const widget = document.getElementById('vinylTurntableWidget');
    if (widget) {
      widget.style.display = 'none';
    }
    this.turntableState.isOpen = false;
    this.stopVinylCrackle();
    this.updateFloatingPlayerButtonUI();
  },

  applyTonearmAngle(angle, withTransition = true) {
    this.turntableState.currentAngle = angle;
    const tonearm = document.getElementById('ttTonearm');
    if (!tonearm) return;
    if (!withTransition) {
      tonearm.style.transition = 'none';
    } else {
      tonearm.style.transition = 'transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
    }
    const liftedScale = this.turntableState.isLifted ? ' scale(1.05)' : '';
    tonearm.style.transform = `rotate(${angle}deg)${liftedScale}`;
  },

  playNeedleDropEffect() {
    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      const now = this.audioCtx.currentTime;

      // 1. Stylus impact low thump (exponential pitch envelope 110Hz -> 36Hz)
      const osc = this.audioCtx.createOscillator();
      const oscGain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, now);
      osc.frequency.exponentialRampToValueAtTime(36, now + 0.045);
      oscGain.gain.setValueAtTime(0.38, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(oscGain);
      oscGain.connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.055);

      // 2. Vinyl micro-friction click (filtered noise burst)
      const bufferSize = Math.floor(this.audioCtx.sampleRate * 0.035);
      const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      }
      const noise = this.audioCtx.createBufferSource();
      noise.buffer = buffer;
      const filter = this.audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1500, now);
      filter.Q.setValueAtTime(1.2, now);
      const noiseGain = this.audioCtx.createGain();
      noiseGain.gain.setValueAtTime(0.22, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      noise.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(this.audioCtx.destination);
      noise.start(now);
    } catch (e) {
      console.warn('Needle sound effect error:', e);
    }
  },

  loadTurntableTrack(item, isPlayingImmediately = false) {
    if (!item) return;
    this.turntableState.currentTrack = item;

    const titleEl = document.getElementById('ttTrackTitle');
    const artistEl = document.getElementById('ttArtistName');
    const jacketCover = document.getElementById('ttJacketCover');
    const labelImg = document.getElementById('ttLabelImg');
    const disc = document.getElementById('ttVinylDisc');
    const stage = document.getElementById('ttStage');
    const btnPack = document.getElementById('ttBtnPack');
    const tonearm = document.getElementById('ttTonearm');
    const platter = document.getElementById('ttPlatter');

    const title = item.title || item.album || 'Без названия';
    const artist = item.artist || 'Неизвестный исполнитель';
    const rawCover = item.coverUrl || item.coverImage || item.thumb || '';
    const cover = this.getSafeCoverUrl(rawCover, artist, title);

    if (titleEl) titleEl.textContent = title;
    if (artistEl) artistEl.textContent = artist;
    if (jacketCover) {
      jacketCover.src = cover || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\' fill=\'%231a2233\'><rect width=\'120\' height=\'120\'/></svg>';
      jacketCover.onerror = () => {
        jacketCover.onerror = null;
        jacketCover.src = `/api/cover-image?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(title)}`;
      };
    }
    if (labelImg) {
      labelImg.src = cover || '';
      labelImg.onerror = () => {
        labelImg.onerror = null;
        labelImg.src = `/api/cover-image?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(title)}`;
      };
    }

    // Physical vinyl tint based on format or color
    if (disc) {
      const fmt = `${item.format || ''} ${item.color || ''} ${item.vinylColor || ''} ${item.notes || ''}`.toLowerCase();
      if (fmt.includes('gold') || fmt.includes('золот')) {
        disc.style.background = 'radial-gradient(circle, #fbbf24 15%, #d97706 65%, #78350f 100%)';
      } else if (fmt.includes('red') || fmt.includes('красн')) {
        disc.style.background = 'radial-gradient(circle, #ef4444 15%, #b91c1c 65%, #450a0a 100%)';
      } else if (fmt.includes('blue') || fmt.includes('син') || fmt.includes('голуб')) {
        disc.style.background = 'radial-gradient(circle, #38bdf8 15%, #1d4ed8 65%, #0f172a 100%)';
      } else if (fmt.includes('white') || fmt.includes('бел')) {
        disc.style.background = 'radial-gradient(circle, #f8fafc 15%, #cbd5e1 65%, #64748b 100%)';
      } else if (fmt.includes('green') || fmt.includes('зелен')) {
        disc.style.background = 'radial-gradient(circle, #22c55e 15%, #15803d 65%, #052e16 100%)';
      } else {
        disc.style.background = 'radial-gradient(circle, #1c1917 18%, #0f0f11 65%, #050507 100%)';
      }
    }

    if (stage) {
      if (isPlayingImmediately) {
        // Immediate play mode: vinyl smoothly extracted onto platter, platter spinning, needle on groove!
        stage.classList.remove('state-packed');
        stage.classList.add('state-extracted');
        this.turntableState.isPacked = false;
        if (btnPack) {
          btnPack.textContent = '💿';
          btnPack.title = 'Запаковать пластинку в конверт';
        }
        if (platter) platter.classList.add('is-spinning');
        this.applyTonearmAngle(this.turntableState.leadInAngle, true);
        this.playNeedleDropEffect();
        if (this.turntableState.crackleEnabled) {
          this.startVinylCrackle();
        }
        this.threeTurntable.targetDiscProgress = 1;
      } else {
        // Passive load: ensure record is extracted if not packed
        if (!this.turntableState.isPacked) {
          stage.classList.remove('state-packed');
          stage.classList.add('state-extracted');
          if (btnPack) btnPack.textContent = '💿';
          this.threeTurntable.targetDiscProgress = 1;
        } else {
          this.threeTurntable.targetDiscProgress = 0;
        }
      }
    }

    if (cover) {
      this.updateThreeTurntableCover(cover);
    }
  },

  initTurntableDragging() {
    const tonearm = document.getElementById('ttTonearm');
    const deck = document.getElementById('ttDeck');
    if (!tonearm || !deck) return;

    let isPointerDown = false;
    let startPivotX = 0;
    let startPivotY = 0;

    const onPointerDown = (e) => {
      if (this.turntableState.isPacked) {
        this.showToastNotification('Сначала достаньте пластинку из конверта');
        return;
      }
      e.preventDefault();
      isPointerDown = true;
      this.turntableState.isDragging = true;
      tonearm.classList.add('is-dragging');

      const pivotEl = tonearm.querySelector('.tt-arm-pivot') || tonearm;
      const r = pivotEl.getBoundingClientRect();
      startPivotX = r.left + r.width / 2;
      startPivotY = r.top + r.height / 2;

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!isPointerDown) return;
      e.preventDefault();

      const dx = e.clientX - startPivotX;
      const dy = e.clientY - startPivotY;

      // Clockwise angle from downward vector: positive swings into platter center
      const angle = Math.atan2(-dx, dy) * (180 / Math.PI);
      const clampedAngle = Math.max(-20, Math.min(42, angle));

      this.applyTonearmAngle(clampedAngle, false);

      // Scrubber visual feedback during live dragging
      if (clampedAngle >= this.turntableState.leadInAngle && clampedAngle <= this.turntableState.leadOutAngle) {
        const pct = (clampedAngle - this.turntableState.leadInAngle) / (this.turntableState.leadOutAngle - this.turntableState.leadInAngle);
        const fill = document.getElementById('ttScrubberFill');
        const curTime = document.getElementById('ttTimeCurrent');
        const dur = (this.playingAudio && this.playingAudio.duration) || 30;
        if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct * 100))}%`;
        if (curTime) curTime.textContent = this.formatAudioTime(pct * dur);
      }
    };

    const onPointerUp = () => {
      if (!isPointerDown) return;
      isPointerDown = false;
      this.turntableState.isDragging = false;
      tonearm.classList.remove('is-dragging');

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      const curAngle = this.turntableState.currentAngle;

      if (curAngle < 6) {
        // Returned to rest cradle
        this.applyTonearmAngle(this.turntableState.restAngle, true);
        if (this.playingAudio && !this.playingAudio.paused) {
          this.playingAudio.pause();
        }
        const platter = document.getElementById('ttPlatter');
        if (platter) platter.classList.remove('is-spinning');
        this.stopVinylCrackle();
        this.showToastNotification('🛑 Тонарм на стойке (воспроизведение остановлено)');
      } else {
        // Dropped onto vinyl grooves
        const finalAngle = Math.max(this.turntableState.leadInAngle, Math.min(this.turntableState.leadOutAngle, curAngle));
        this.applyTonearmAngle(finalAngle, true);
        this.playNeedleDropEffect();

        const pct = (finalAngle - this.turntableState.leadInAngle) / (this.turntableState.leadOutAngle - this.turntableState.leadInAngle);
        if (this.playingAudio && this.playingAudio.src) {
          const dur = this.playingAudio.duration && !isNaN(this.playingAudio.duration) ? this.playingAudio.duration : 30;
          this.playingAudio.currentTime = pct * dur;
          if (this.playingAudio.paused && !this.turntableState.isLifted) {
            this.playingAudio.play().catch(() => {});
          }
          const platter = document.getElementById('ttPlatter');
          if (platter) platter.classList.add('is-spinning');
          if (this.turntableState.crackleEnabled) {
            this.startVinylCrackle();
          }
        } else {
          this.playTurntableDefaultTrack(pct);
        }
        this.showToastNotification(`🎯 Игла на дорожке (${Math.round(pct * 100)}%)`);
      }
    };

    tonearm.addEventListener('pointerdown', onPointerDown);
  },

  initTurntableWidgetDragging() {
    const widget = document.getElementById('vinylTurntableWidget');
    const header = document.getElementById('ttHeader') || (widget && widget.querySelector('.tt-header'));
    if (!widget || !header) return;

    // Restore saved coordinates if valid
    const restorePosition = () => {
      try {
        const saved = localStorage.getItem('turntable_widget_pos');
        if (saved) {
          const pos = JSON.parse(saved);
          if (typeof pos.left === 'number' && typeof pos.top === 'number') {
            const pad = 10;
            const maxLeft = Math.max(pad, window.innerWidth - (widget.offsetWidth || 360) - pad);
            const maxTop = Math.max(pad, window.innerHeight - (widget.offsetHeight || 380) - pad);
            const left = Math.max(pad, Math.min(maxLeft, pos.left));
            const top = Math.max(pad, Math.min(maxTop, pos.top));
            widget.style.left = `${left}px`;
            widget.style.top = `${top}px`;
            widget.style.right = 'auto';
            widget.style.bottom = 'auto';
          }
        }
      } catch (e) {}
    };

    restorePosition();

    // Adjust position on viewport resize so widget never stays outside screen
    window.addEventListener('resize', () => {
      if (widget.style.left && widget.style.left !== 'auto') {
        const pad = 10;
        const curLeft = parseInt(widget.style.left, 10) || 0;
        const curTop = parseInt(widget.style.top, 10) || 0;
        const maxLeft = Math.max(pad, window.innerWidth - (widget.offsetWidth || 360) - pad);
        const maxTop = Math.max(pad, window.innerHeight - (widget.offsetHeight || 380) - pad);
        widget.style.left = `${Math.max(pad, Math.min(maxLeft, curLeft))}px`;
        widget.style.top = `${Math.max(pad, Math.min(maxTop, curTop))}px`;
      }
    });

    let isPointerDown = false;
    let shiftX = 0;
    let shiftY = 0;

    const onPointerDown = (e) => {
      // Ignore clicks on header buttons or links (close, pack, etc.)
      if (e.target.closest('button, input, a, .tt-btn-icon')) {
        return;
      }
      e.preventDefault();
      isPointerDown = true;
      widget.classList.add('is-dragging');

      const rect = widget.getBoundingClientRect();
      shiftX = e.clientX - rect.left;
      shiftY = e.clientY - rect.top;

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!isPointerDown) return;
      e.preventDefault();

      const pad = 8;
      const widgetWidth = widget.offsetWidth || 360;
      const widgetHeight = widget.offsetHeight || 380;
      const maxLeft = Math.max(pad, window.innerWidth - widgetWidth - pad);
      const maxTop = Math.max(pad, window.innerHeight - widgetHeight - pad);

      let newLeft = e.clientX - shiftX;
      let newTop = e.clientY - shiftY;

      newLeft = Math.max(pad, Math.min(maxLeft, newLeft));
      newTop = Math.max(pad, Math.min(maxTop, newTop));

      widget.style.left = `${newLeft}px`;
      widget.style.top = `${newTop}px`;
      widget.style.right = 'auto';
      widget.style.bottom = 'auto';
    };

    const onPointerUp = () => {
      if (!isPointerDown) return;
      isPointerDown = false;
      widget.classList.remove('is-dragging');

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      // Save position to localStorage
      try {
        const left = parseInt(widget.style.left, 10);
        const top = parseInt(widget.style.top, 10);
        if (!isNaN(left) && !isNaN(top)) {
          localStorage.setItem('turntable_widget_pos', JSON.stringify({ left, top }));
        }
      } catch (e) {}
    };

    header.addEventListener('pointerdown', onPointerDown);
  },

  onTurntableDiscClick(event) {
    this.unlockAudio();
    if (this.turntableState.isPacked) {
      this.showToastNotification('Сначала достаньте пластинку из конверта');
      return;
    }
    const disc = document.getElementById('ttVinylDisc');
    if (!disc) return;
    const rect = disc.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const radius = rect.width / 2;
    const labelRadius = 23;

    if (dist < labelRadius || dist > radius + 8) return;

    // Outer edge (pct = 0) -> inner edge (pct = 1)
    const pct = Math.max(0, Math.min(1, (radius - dist) / (radius - labelRadius)));
    const targetAngle = this.turntableState.leadInAngle + pct * (this.turntableState.leadOutAngle - this.turntableState.leadInAngle);

    this.applyTonearmAngle(targetAngle, true);
    this.playNeedleDropEffect();

    if (this.playingAudio && this.playingAudio.src) {
      const dur = this.playingAudio.duration && !isNaN(this.playingAudio.duration) ? this.playingAudio.duration : 30;
      this.playingAudio.currentTime = pct * dur;
      if (this.playingAudio.paused && !this.turntableState.isLifted) {
        this.playingAudio.play().catch(() => {});
      }
      const platter = document.getElementById('ttPlatter');
      if (platter) platter.classList.add('is-spinning');
      if (this.turntableState.crackleEnabled) {
        this.startVinylCrackle();
      }
    } else {
      this.playTurntableDefaultTrack(pct);
    }
    this.showToastNotification(`🎯 Игла перемещена на дорожку (${Math.round(pct * 100)}%)`);
  },

  toggleTurntablePack() {
    this.unlockAudio();
    const stage = document.getElementById('ttStage');
    const btnPack = document.getElementById('ttBtnPack');
    const platter = document.getElementById('ttPlatter');
    const tonearm = document.getElementById('ttTonearm');
    if (!stage) return;

    if (!this.turntableState.isPacked) {
      // Physical packaging sequence:
      // 1. Lift tonearm first if it's currently on the record
      if (tonearm) tonearm.classList.add('arm-lifted');
      if (this.playingAudio && !this.playingAudio.paused) {
        this.playingAudio.pause();
      }
      this.stopVinylCrackle();
      if (platter) platter.classList.remove('is-spinning');

      // 2. Return tonearm safely to rest cradle
      this.applyTonearmAngle(this.turntableState.restAngle, true);

      // 3. Lower tonearm into cradle and slide disc into jacket sleeve
      this.threeTurntable.targetDiscProgress = 0;
      setTimeout(() => {
        if (tonearm) tonearm.classList.remove('arm-lifted');
        if (stage) {
          stage.classList.remove('state-extracted');
          stage.classList.add('state-packed');
        }
        this.turntableState.isPacked = true;
        if (btnPack) {
          btnPack.textContent = '📦';
          btnPack.title = 'Достать пластинку из конверта';
        }
        this.showToastNotification('📦 Игла снята на стойку, пластинка бережно запакована в конверт');
      }, 350);

    } else {
      // Unpack sequence:
      // 1. Slide disc out onto platter
      stage.classList.remove('state-packed');
      stage.classList.add('state-extracted');
      this.turntableState.isPacked = false;
      this.threeTurntable.targetDiscProgress = 1;
      if (btnPack) {
        btnPack.textContent = '💿';
        btnPack.title = 'Запаковать пластинку в конверт';
      }

      // 2. Spin platter, lift needle, swing to lead-in groove, and drop
      setTimeout(() => {
        if (platter) platter.classList.add('is-spinning');
        if (tonearm) tonearm.classList.add('arm-lifted');
        this.applyTonearmAngle(this.turntableState.leadInAngle, true);

        setTimeout(() => {
          if (tonearm) tonearm.classList.remove('arm-lifted');
          this.playNeedleDropEffect();
          if (this.playingAudio && this.playingAudio.src) {
            this.playingAudio.play().catch(() => {});
            if (this.turntableState.crackleEnabled) {
              this.startVinylCrackle();
            }
          } else {
            this.playTurntableDefaultTrack(0);
          }
          this.showToastNotification('💿 Пластинка извлечена и установлена на стол, игла на дорожке');
        }, 400);
      }, 500);
    }
  },

  toggleTurntableCueLift() {
    if (this.turntableState.isPacked) {
      this.showToastNotification('Сначала достаньте пластинку из конверта');
      return;
    }
    const tonearm = document.getElementById('ttTonearm');
    const btnLift = document.getElementById('ttBtnLift');
    this.turntableState.isLifted = !this.turntableState.isLifted;

    if (btnLift) btnLift.classList.toggle('active', this.turntableState.isLifted);
    if (tonearm) tonearm.classList.toggle('arm-lifted', this.turntableState.isLifted);
    this.applyTonearmAngle(this.turntableState.currentAngle, true);

    if (this.turntableState.isLifted) {
      if (this.playingAudio && !this.playingAudio.paused) {
        this.turntableState.wasPlayingBeforeLift = true;
        this.playingAudio.pause();
      }
      this.stopVinylCrackle();
      this.showToastNotification('🎚️ Микролифт: игла поднята над пластинкой');
    } else {
      this.playNeedleDropEffect();
      if (this.turntableState.wasPlayingBeforeLift && this.playingAudio) {
        this.playingAudio.play().catch(() => {});
        this.turntableState.wasPlayingBeforeLift = false;
      }
      this.showToastNotification('🎚️ Микролифт: игла плавно опущена на дорожку');
    }
  },

  async turntableNextTrack() {
    await this.navigateTurntableTrack(1);
  },

  async turntablePrevTrack() {
    await this.navigateTurntableTrack(-1);
  },

  async navigateTurntableTrack(direction = 1) {
    if (this.turntableState.isPacked) {
      this.showToastNotification('Сначала достаньте пластинку из конверта');
      return;
    }

    const tonearm = document.getElementById('ttTonearm');
    if (tonearm) tonearm.classList.add('arm-lifted');
    this.applyTonearmAngle(this.turntableState.leadInAngle, true);

    // If modal tracklist is loaded
    if (this.currentTracklistData && Array.isArray(this.currentTracklistData.tracklist) && this.currentTracklistData.tracklist.length > 0) {
      const list = this.currentTracklistData.tracklist;
      const curIdx = this.currentTracklistIndex >= 0 ? this.currentTracklistIndex : 0;
      const nextIdx = (curIdx + direction + list.length) % list.length;
      setTimeout(async () => {
        if (tonearm) tonearm.classList.remove('arm-lifted');
        this.playNeedleDropEffect();
        await this.playTrackByIndex(nextIdx);
      }, 350);
      return;
    }

    // Otherwise navigate across albums/releases
    const collection = (this.appMode === 'albums' ? this.albums : this.records) || [];
    if (collection.length > 0) {
      const curId = this.turntableState.currentTrack ? this.turntableState.currentTrack.id : null;
      let curIdx = collection.findIndex(it => String(it.id) === String(curId));
      if (curIdx === -1) curIdx = 0;
      const nextIdx = (curIdx + direction + collection.length) % collection.length;
      const nextItem = collection[nextIdx];

      setTimeout(async () => {
        if (tonearm) tonearm.classList.remove('arm-lifted');
        this.playNeedleDropEffect();
        await this.openAlbumTracklistModal(nextItem.id, nextItem);
        if (this.currentTracklistData && this.currentTracklistData.tracklist && this.currentTracklistData.tracklist.length > 0) {
          await this.playTrackByIndex(0);
        }
      }, 350);
      return;
    }

    setTimeout(() => {
      if (tonearm) tonearm.classList.remove('arm-lifted');
      this.playNeedleDropEffect();
    }, 350);
  },

  toggleTurntablePlayPause() {
    this.unlockAudio();

    if (this.turntableState.isPacked) {
      this.toggleTurntablePack();
      return;
    }

    if (this.playingAudio && !this.playingAudio.paused) {
      this.pauseAudio();
      return;
    }

    if (this.playingAudio && this.playingAudio.paused && this.playingAudio.src) {
      this.playingAudio.play().then(() => {
        this.onTurntableAudioPlay();
        this.updateFloatingPlayerButtonUI();
      }).catch(e => {
        console.warn('Play error:', e);
      });
      return;
    }

    this.playTurntableDefaultTrack();
  },

  async playTurntableDefaultTrack(seekPct = 0) {
    this.unlockAudio();

    // 1. If currently have currentTrack in turntableState
    const ct = this.turntableState.currentTrack;
    if (ct) {
      if (ct.previewUrl) {
        this.playAudio(ct.previewUrl, ct.title, ct.artist, ct.coverUrl);
        if (seekPct > 0) this.seekTurntableToPercent(seekPct);
        return;
      }
      if (ct.title || ct.artist) {
        await this.fetchAndPlayPreview(ct.title, ct.artist, ct.coverUrl);
        if (seekPct > 0) this.seekTurntableToPercent(seekPct);
        return;
      }
    }

    // 2. If tracklist modal has tracks
    if (this.currentTracklistData && Array.isArray(this.currentTracklistData.tracklist) && this.currentTracklistData.tracklist.length > 0) {
      await this.playTrackByIndex(0);
      if (seekPct > 0) this.seekTurntableToPercent(seekPct);
      return;
    }

    // 3. Fallback to first item from library (albums or records)
    const list = (this.appMode === 'albums' ? this.albums : this.records) || [];
    if (list.length > 0) {
      const first = list[0];
      await this.openAlbumTracklistModal(first.id, first);
      if (this.currentTracklistData && this.currentTracklistData.tracklist && this.currentTracklistData.tracklist.length > 0) {
        await this.playTrackByIndex(0);
        if (seekPct > 0) this.seekTurntableToPercent(seekPct);
      }
      return;
    }

    this.showToastNotification('Выберите пластинку или песню для воспроизведения');
  },

  seekTurntableToPercent(pct) {
    setTimeout(() => {
      if (this.playingAudio) {
        const dur = this.playingAudio.duration || 30;
        this.playingAudio.currentTime = Math.max(0, Math.min(dur, pct * dur));
      }
    }, 150);
  },

  skipTurntableAudio(deltaSeconds) {
    if (this.playingAudio) {
      const cur = this.playingAudio.currentTime || 0;
      const dur = this.playingAudio.duration || 30;
      const target = Math.max(0, Math.min(dur, cur + deltaSeconds));
      this.playingAudio.currentTime = target;
    }
  },

  seekTurntableFromEvent(e) {
    const track = document.getElementById('ttScrubberTrack');
    if (!track || !this.playingAudio) return;
    const rect = track.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    const dur = this.playingAudio.duration && !isNaN(this.playingAudio.duration) ? this.playingAudio.duration : 30;
    this.playingAudio.currentTime = pct * dur;
    this.playNeedleDropEffect();
  },

  toggleVinylCrackle() {
    this.turntableState.crackleEnabled = !this.turntableState.crackleEnabled;
    const btn = document.getElementById('ttBtnAsmr');
    if (btn) {
      btn.classList.toggle('active', this.turntableState.crackleEnabled);
    }
    if (this.turntableState.crackleEnabled) {
      if (this.playingAudio && !this.playingAudio.paused) {
        this.startVinylCrackle();
      }
      this.showToastNotification('🔊 Аналоговый треск винила включен');
    } else {
      this.stopVinylCrackle();
      this.showToastNotification('🔇 Треск винила отключен');
    }
  },

  startVinylCrackle() {
    if (!this.experiments.turntableAsmr) return;
    if (!this.turntableState.isOpen) return;
    if (this.turntableState.isPacked) return;
    if (!this.turntableState.crackleEnabled) return;
    if (!this.playingAudio || this.playingAudio.paused) return;

    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      if (this.vinylCracklingNode) return;

      const bufferSize = 4096;
      // Real-time procedural non-repetitive vinyl pops and surface hiss generator
      const proc = this.audioCtx.createScriptProcessor ? this.audioCtx.createScriptProcessor(bufferSize, 0, 1) : null;

      if (proc) {
        let rotationPhase = 0;
        proc.onaudioprocess = (e) => {
          const out = e.outputBuffer.getChannelData(0);
          for (let i = 0; i < bufferSize; i++) {
            // Subtle 33 1/3 RPM rumble (0.55 Hz rotation modulation)
            rotationPhase += (2 * Math.PI * 0.55) / 44100;
            const rumble = Math.sin(rotationPhase) * 0.003;

            // Surface friction hiss
            const hiss = (Math.random() * 2 - 1) * 0.006;

            // Random non-repetitive dust pops (Poisson distribution with organic amplitudes)
            let pop = 0;
            if (Math.random() < 0.00045) {
              const sign = Math.random() < 0.5 ? 1 : -1;
              const amp = 0.06 + Math.random() * 0.26;
              pop = sign * amp;
            }

            out[i] = rumble + hiss + pop;
          }
        };

        const filter = this.audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 2400;
        filter.Q.value = 0.8;

        const gain = this.audioCtx.createGain();
        gain.gain.value = 0.32;

        proc.connect(filter);
        filter.connect(gain);
        gain.connect(this.audioCtx.destination);

        this.vinylCracklingNode = { proc, filter, gain };
      } else {
        const sampleRate = this.audioCtx.sampleRate || 44100;
        const buffer = this.audioCtx.createBuffer(1, sampleRate * 4, sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          const pop = Math.random() < 0.0007 ? (Math.random() * 2 - 1) * 0.35 : 0;
          data[i] = (Math.random() * 2 - 1) * 0.012 + pop;
        }
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        const gain = this.audioCtx.createGain();
        gain.gain.value = 0.25;
        noise.connect(gain);
        gain.connect(this.audioCtx.destination);
        noise.start();
        this.vinylCracklingNode = { noise, gain };
      }
    } catch (e) {}
  },

  stopVinylCrackle() {
    if (this.vinylCracklingNode) {
      try {
        if (this.vinylCracklingNode.proc) {
          this.vinylCracklingNode.proc.disconnect();
        }
        if (this.vinylCracklingNode.noise) {
          this.vinylCracklingNode.noise.stop();
          this.vinylCracklingNode.noise.disconnect();
        }
        if (this.vinylCracklingNode.filter) this.vinylCracklingNode.filter.disconnect();
        if (this.vinylCracklingNode.gain) this.vinylCracklingNode.gain.disconnect();
      } catch (e) {}
      this.vinylCracklingNode = null;
    }
  },

  onTurntableAudioPlay() {
    this.updateFloatingPlayerButtonUI();
    const playPauseIcon = document.getElementById('playerPlayPauseIcon');
    if (playPauseIcon) playPauseIcon.textContent = '⏸';
    const ttPlayIcon = document.getElementById('ttPlayIcon');
    if (ttPlayIcon) ttPlayIcon.textContent = '⏸';

    if (!this.turntableState.isOpen) return;
    const platter = document.getElementById('ttPlatter');
    const led = document.getElementById('ttLedIndicator');
    const stage = document.getElementById('ttStage');

    if (stage) {
      stage.classList.remove('state-packed');
      stage.classList.add('state-extracted');
      this.turntableState.isPacked = false;
      const btnPack = document.getElementById('ttBtnPack');
      if (btnPack) {
        btnPack.textContent = '💿';
        btnPack.title = 'Запаковать пластинку в конверт';
      }
    }

    if (platter) platter.classList.add('is-spinning');
    if (this.turntableState.currentAngle < 5) {
      this.applyTonearmAngle(this.turntableState.leadInAngle, true);
      this.playNeedleDropEffect();
    }

    if (led) led.classList.add('active');
    if (!this.turntableState.isPacked && !this.turntableState.isLifted && this.experiments.turntableAsmr && this.turntableState.crackleEnabled) {
      this.startVinylCrackle();
    }
  },

  onTurntableAudioPause() {
    this.updateFloatingPlayerButtonUI();
    const playPauseIcon = document.getElementById('playerPlayPauseIcon');
    if (playPauseIcon) playPauseIcon.textContent = '▶';
    const ttPlayIcon = document.getElementById('ttPlayIcon');
    if (ttPlayIcon) ttPlayIcon.textContent = '▶';

    const platter = document.getElementById('ttPlatter');
    const led = document.getElementById('ttLedIndicator');

    if (platter) platter.classList.remove('is-spinning');
    if (led) led.classList.remove('active');
    this.stopVinylCrackle();
  },

  onTurntableAudioEnded() {
    this.onTurntableAudioPause();
    const fill = document.getElementById('ttScrubberFill');
    const curTime = document.getElementById('ttTimeCurrent');
    if (fill) fill.style.width = '0%';
    if (curTime) curTime.textContent = '0:00';

    const tonearm = document.getElementById('ttTonearm');
    if (tonearm && !this.turntableState.isPacked) {
      this.applyTonearmAngle(this.turntableState.leadOutAngle, true);
      setTimeout(() => {
        if (tonearm) tonearm.classList.add('arm-lifted');
        setTimeout(() => {
          this.applyTonearmAngle(this.turntableState.restAngle, true);
          setTimeout(() => {
            if (tonearm) tonearm.classList.remove('arm-lifted');
          }, 350);
        }, 300);
      }, 500);
    }
  },

  updateTurntableProgress(currentTime, duration) {
    const fill = document.getElementById('ttScrubberFill');
    const curTime = document.getElementById('ttTimeCurrent');
    const durTime = document.getElementById('ttTimeDuration');
    const tonearm = document.getElementById('ttTonearm');
    const cur = currentTime || 0;
    const dur = duration && !isNaN(duration) ? duration : 30;

    if (curTime) curTime.textContent = this.formatAudioTime(cur);
    if (durTime) durTime.textContent = this.formatAudioTime(dur);
    if (fill && dur > 0) {
      fill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
    }

    // Physical needle movement across vinyl grooves if playing & not dragging & not packed & not lifted
    if (!this.turntableState.isDragging && !this.turntableState.isPacked && !this.turntableState.isLifted && tonearm) {
      if (this.playingAudio && !this.playingAudio.paused) {
        const progress = Math.min(1, Math.max(0, cur / dur));
        const leadIn = this.turntableState.leadInAngle; // 14 deg
        const leadOut = this.turntableState.leadOutAngle; // 38 deg
        const targetAngle = leadIn + progress * (leadOut - leadIn);
        this.applyTonearmAngle(targetAngle, true);
      }
    }
  },

  updateValuationStats() {
    const badge = document.getElementById('statHeaderPriceRange');
    if (!badge) return;
    let sumMin = 0;
    let sumMed = 0;
    let sumMax = 0;
    let count = 0;
    this.records.forEach(r => {
      const med = Number(r.priceMedian || r.priceLowest || r.priceMin || 25);
      const min = Number(r.priceMin || (med * 0.7));
      const max = Number(r.priceMax || (med * 1.45));
      if (med > 0) {
        sumMed += med;
        sumMin += min;
        sumMax += max;
        count++;
      }
    });
    if (count > 0) {
      badge.innerHTML = `💰 Оценка продажи: от $${Math.round(sumMin)} до $${Math.round(sumMax)} <span style="opacity:0.85; font-size:11px;">(медиана $${Math.round(sumMed)})</span>`;
      badge.title = `Если продать всю коллекцию (${count} пластинок): выручка от $${Math.round(sumMin)} до $${Math.round(sumMax)}, медиана $${Math.round(sumMed)}`;
    }
  },

  // ----------------------------------------------------
  // 3D REALISTIC WEBGL TURNTABLE (THREE.JS)
  // ----------------------------------------------------
  initThreeTurntable() {
    if (this.threeTurntable.isInitialized) {
      if (this.threeTurntable.renderer && this.threeTurntable.camera) {
        this.onResizeThreeTurntable();
      }
      return;
    }
    if (typeof THREE === 'undefined') {
      console.warn('Three.js library not loaded; using 2D turntable fallback.');
      return;
    }

    const canvas = document.getElementById('tt3DCanvas');
    const stage = document.getElementById('ttStage');
    if (!canvas || !stage) return;

    const width = stage.clientWidth || 440;
    const height = stage.clientHeight || 230;

    // Scene
    const scene = new THREE.Scene();
    this.threeTurntable.scene = scene;

    // Perspective Camera overlooking the turntable and sleeve
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(0, 3.8, 5.3);
    camera.lookAt(0, -0.1, 0);
    this.threeTurntable.camera = camera;

    // WebGL Renderer
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.threeTurntable.renderer = renderer;

    // Realistic Multi-source Lighting
    const ambLight = new THREE.AmbientLight(0xfff6ec, 0.85);
    scene.add(ambLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.25);
    dirLight.position.set(-3, 6, 4);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const rimLight = new THREE.PointLight(0x38bdf8, 0.9, 8);
    rimLight.position.set(2.5, 2.5, -1);
    scene.add(rimLight);

    const warmAccentLight = new THREE.PointLight(0xf59e0b, 0.65, 6);
    warmAccentLight.position.set(-1.8, 1.8, 2);
    scene.add(warmAccentLight);

    // 1. Turntable Plinth / Body
    const plinthGeo = new THREE.BoxGeometry(3.6, 0.36, 3.2);
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0x111622,
      roughness: 0.35,
      metalness: 0.7
    });
    const plinthMesh = new THREE.Mesh(plinthGeo, plinthMat);
    plinthMesh.position.set(0.9, -0.18, 0);
    plinthMesh.receiveShadow = true;
    scene.add(plinthMesh);

    // Subtle edge trim / bevel
    const trimGeo = new THREE.BoxGeometry(3.64, 0.04, 3.24);
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      metalness: 0.9,
      roughness: 0.2
    });
    const trimMesh = new THREE.Mesh(trimGeo, trimMat);
    trimMesh.position.set(0.9, 0.01, 0);
    scene.add(trimMesh);

    // 2. Platter Assembly (Silver rim with strobe dots + rubber mat)
    const platterGroup = new THREE.Group();
    platterGroup.position.set(0.4, 0.06, 0);

    const rimGeo = new THREE.CylinderGeometry(1.36, 1.36, 0.12, 48);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xd4d4d8,
      metalness: 0.92,
      roughness: 0.25
    });
    const rimMesh = new THREE.Mesh(rimGeo, rimMat);
    rimMesh.castShadow = true;
    platterGroup.add(rimMesh);

    const matGeo = new THREE.CylinderGeometry(1.3, 1.3, 0.03, 48);
    const matMaterial = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.85,
      metalness: 0.1
    });
    const matMesh = new THREE.Mesh(matGeo, matMaterial);
    matMesh.position.y = 0.07;
    platterGroup.add(matMesh);

    const spindleGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.25, 24);
    const spindleMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      metalness: 0.98,
      roughness: 0.1
    });
    const spindleMesh = new THREE.Mesh(spindleGeo, spindleMat);
    spindleMesh.position.y = 0.14;
    platterGroup.add(spindleMesh);

    scene.add(platterGroup);
    this.threeTurntable.platterMesh = platterGroup;

    // 3. Album Jacket / Sleeve (Конверт на левой стороне)
    const jacketGroup = new THREE.Group();
    jacketGroup.position.set(-1.85, 0.2, 0.1);
    jacketGroup.rotation.y = 0.22;
    jacketGroup.rotation.x = -0.12;

    const jacketGeo = new THREE.BoxGeometry(2.2, 2.2, 0.08);
    const jacketCanvas = document.createElement('canvas');
    jacketCanvas.width = 512;
    jacketCanvas.height = 512;
    const jCtx = jacketCanvas.getContext('2d');
    jCtx.fillStyle = '#1e293b';
    jCtx.fillRect(0, 0, 512, 512);
    jCtx.fillStyle = '#38bdf8';
    jCtx.font = 'bold 36px sans-serif';
    jCtx.textAlign = 'center';
    jCtx.fillText('VINYL SLEEVE', 256, 240);
    jCtx.font = '24px sans-serif';
    jCtx.fillStyle = '#94a3b8';
    jCtx.fillText('Click to unpack', 256, 290);
    const jacketTex = new THREE.CanvasTexture(jacketCanvas);

    const jacketMat = new THREE.MeshStandardMaterial({
      map: jacketTex,
      roughness: 0.35,
      metalness: 0.15
    });
    const jacketMesh = new THREE.Mesh(jacketGeo, jacketMat);
    jacketMesh.castShadow = true;
    jacketGroup.add(jacketMesh);

    scene.add(jacketGroup);
    this.threeTurntable.jacketMesh = jacketGroup;
    this.threeTurntable.jacketMaterial = jacketMat;

    // 4. Physical Vinyl Disc
    const vinylGroup = new THREE.Group();
    const discGeo = new THREE.CylinderGeometry(1.28, 1.28, 0.03, 64);
    const discMat = new THREE.MeshStandardMaterial({
      color: 0x09090b,
      roughness: 0.26,
      metalness: 0.65
    });
    const discMesh = new THREE.Mesh(discGeo, discMat);
    discMesh.castShadow = true;
    vinylGroup.add(discMesh);

    // Procedural Grooves Ring Texture
    const groovesCanvas = document.createElement('canvas');
    groovesCanvas.width = 512;
    groovesCanvas.height = 512;
    const gCtx = groovesCanvas.getContext('2d');
    gCtx.fillStyle = '#09090b';
    gCtx.fillRect(0, 0, 512, 512);
    for (let r = 85; r < 246; r += 2.5) {
      gCtx.strokeStyle = Math.random() < 0.25 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)';
      gCtx.lineWidth = 1;
      gCtx.beginPath();
      gCtx.arc(256, 256, r, 0, Math.PI * 2);
      gCtx.stroke();
    }
    const groovesTex = new THREE.CanvasTexture(groovesCanvas);
    const groovesPlaneGeo = new THREE.PlaneGeometry(2.52, 2.52);
    const groovesMat = new THREE.MeshStandardMaterial({
      map: groovesTex,
      transparent: true,
      roughness: 0.2,
      metalness: 0.7
    });
    const groovesPlane = new THREE.Mesh(groovesPlaneGeo, groovesMat);
    groovesPlane.rotation.x = -Math.PI / 2;
    groovesPlane.position.y = 0.016;
    vinylGroup.add(groovesPlane);

    // Center Sticker / Label
    const labelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.034, 32);
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256;
    labelCanvas.height = 256;
    const lCtx = labelCanvas.getContext('2d');
    lCtx.fillStyle = '#d97706';
    lCtx.beginPath();
    lCtx.arc(128, 128, 120, 0, Math.PI * 2);
    lCtx.fill();
    lCtx.fillStyle = '#000';
    lCtx.beginPath();
    lCtx.arc(128, 128, 16, 0, Math.PI * 2);
    lCtx.fill();
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    const labelMat = new THREE.MeshStandardMaterial({
      map: labelTex,
      roughness: 0.4,
      metalness: 0.1
    });
    const labelMesh = new THREE.Mesh(labelGeo, labelMat);
    vinylGroup.add(labelMesh);

    scene.add(vinylGroup);
    this.threeTurntable.vinylMesh = vinylGroup;
    this.threeTurntable.labelMaterial = labelMat;

    // 5. Tonearm Assembly
    const tonearmGroup = new THREE.Group();
    tonearmGroup.position.set(2.2, 0.18, -1.05);

    const baseGeo = new THREE.CylinderGeometry(0.18, 0.22, 0.35, 24);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x27272a, metalness: 0.9, roughness: 0.2 });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    tonearmGroup.add(baseMesh);

    const armPivot = new THREE.Group();
    armPivot.position.set(0, 0.2, 0);

    const weightGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.22, 24);
    const weightMat = new THREE.MeshStandardMaterial({ color: 0x52525b, metalness: 0.95, roughness: 0.15 });
    const weightMesh = new THREE.Mesh(weightGeo, weightMat);
    weightMesh.rotation.z = Math.PI / 2;
    weightMesh.position.set(0.24, 0, -0.22);
    armPivot.add(weightMesh);

    const wandGeo = new THREE.CylinderGeometry(0.025, 0.025, 2.0, 16);
    const wandMat = new THREE.MeshStandardMaterial({ color: 0xe4e4e7, metalness: 0.98, roughness: 0.1 });
    const wandMesh = new THREE.Mesh(wandGeo, wandMat);
    wandMesh.rotation.x = Math.PI / 2;
    wandMesh.position.set(-0.06, 0.02, 0.9);
    armPivot.add(wandMesh);

    const headGeo = new THREE.BoxGeometry(0.1, 0.08, 0.24);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.3, metalness: 0.5 });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.set(-0.16, -0.01, 1.95);
    headMesh.rotation.y = 0.28;
    armPivot.add(headMesh);

    tonearmGroup.add(armPivot);
    scene.add(tonearmGroup);
    this.threeTurntable.tonearmPivot = armPivot;

    // Raycaster for mouse interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      const intersects = raycaster.intersectObjects([
        jacketMesh, discMesh, groovesPlane, rimMesh, matMesh, headMesh
      ], true);

      if (intersects.length > 0) {
        const hit = intersects[0].object;
        if (hit === jacketMesh || hit.parent === jacketGroup) {
          this.toggleTurntablePack();
        } else if (hit === discMesh || hit === groovesPlane || hit.parent === vinylGroup) {
          if (this.threeTurntable.discProgress < 0.5) {
            this.toggleTurntablePack();
          } else {
            this.toggleTurntablePlayPause();
          }
        } else if (hit === rimMesh || hit === matMesh || hit === headMesh) {
          this.toggleTurntablePlayPause();
        }
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects([jacketMesh, discMesh, groovesPlane, rimMesh], true);
      canvas.style.cursor = intersects.length > 0 ? 'pointer' : 'default';
    });

    window.addEventListener('resize', () => {
      this.onResizeThreeTurntable();
    });

    this.threeTurntable.isInitialized = true;
    this.threeTurntable.discProgress = this.turntableState.isPacked ? 0 : 1;
    this.threeTurntable.targetDiscProgress = this.turntableState.isPacked ? 0 : 1;

    // If there is an active track cover, load it
    if (this.turntableState.currentTrack) {
      const c = this.turntableState.currentTrack.coverUrl || this.turntableState.currentTrack.coverImage || this.turntableState.currentTrack.thumb;
      if (c) this.updateThreeTurntableCover(c);
    }

    this.animateThreeTurntable();
  },

  animateThreeTurntable() {
    if (!this.threeTurntable.isInitialized) return;

    this.threeTurntable.animFrameId = requestAnimationFrame(() => this.animateThreeTurntable());

    const tt = this.threeTurntable;
    const isPlaying = this.playingAudio && !this.playingAudio.paused;

    // Smooth interpolation for discProgress (0 = in sleeve, 1 = on platter)
    const target = tt.targetDiscProgress;
    const diff = target - tt.discProgress;
    if (Math.abs(diff) > 0.002) {
      tt.discProgress += diff * 0.08;
    } else {
      tt.discProgress = target;
    }

    const p = tt.discProgress;

    if (p <= 0.01) {
      // Packed inside jacket
      tt.vinylMesh.position.set(-1.85, 0.2, 0.1);
      tt.vinylMesh.rotation.set(-0.12, 0.22, 0);
      tt.vinylMesh.scale.set(0.85, 0.85, 0.85);
      tt.vinylMesh.visible = false;
    } else {
      tt.vinylMesh.visible = true;
      if (p < 0.4) {
        // Sliding out of jacket opening
        const t = p / 0.4;
        const x = -1.85 + t * 0.9;
        const y = 0.2 + t * 0.25;
        const z = 0.1 + t * 0.15;
        tt.vinylMesh.position.set(x, y, z);
        tt.vinylMesh.rotation.set(-0.12 * (1 - t), 0.22 * (1 - t), 0);
        tt.vinylMesh.scale.set(0.85 + t * 0.15, 0.85 + t * 0.15, 0.85 + t * 0.15);
      } else if (p < 0.85) {
        // Floating across to platter center along arc
        const t = (p - 0.4) / 0.45;
        const arcY = Math.sin(t * Math.PI) * 0.45;
        const x = -0.95 + t * 1.35;
        const y = 0.45 + arcY;
        const z = 0.25 * (1 - t);
        tt.vinylMesh.position.set(x, y, z);
        tt.vinylMesh.rotation.set(0, 0, 0);
        tt.vinylMesh.scale.set(1, 1, 1);
      } else {
        // Lowering onto platter spindle
        const t = (p - 0.85) / 0.15;
        const y = 0.45 - t * 0.30;
        tt.vinylMesh.position.set(0.4, y, 0);
        tt.vinylMesh.rotation.set(0, tt.vinylMesh.rotation.y, 0);
        tt.vinylMesh.scale.set(1, 1, 1);
      }
    }

    // Spin platter and vinyl disc when playing and seated
    if (isPlaying && p > 0.9) {
      const spinSpeed = 0.058; // 33 1/3 RPM
      if (tt.platterMesh) tt.platterMesh.rotation.y -= spinSpeed;
      if (tt.vinylMesh) tt.vinylMesh.rotation.y -= spinSpeed;
    }

    // Tonearm tracking
    if (tt.tonearmPivot) {
      let targetArmAngle = 0.05;
      let targetLift = 0;

      if (p < 0.9 || this.turntableState.isPacked) {
        targetArmAngle = 0.05;
        targetLift = 0;
      } else {
        const audio = this.playingAudio;
        const cur = (audio && audio.currentTime) || 0;
        const dur = (audio && audio.duration && !isNaN(audio.duration)) ? audio.duration : 30;
        const progress = Math.min(1, Math.max(0, cur / dur));

        const leadIn = 0.42;
        const leadOut = 0.82;
        targetArmAngle = leadIn + progress * (leadOut - leadIn);

        if (this.turntableState.isLifted) {
          targetLift = -0.22;
        }
      }

      tt.tonearmPivot.rotation.y += (targetArmAngle - tt.tonearmPivot.rotation.y) * 0.12;
      tt.tonearmPivot.rotation.z += (targetLift - tt.tonearmPivot.rotation.z) * 0.18;
    }

    // Render 3D Scene
    tt.renderer.render(tt.scene, tt.camera);
  },

  onResizeThreeTurntable() {
    const tt = this.threeTurntable;
    if (!tt.isInitialized || !tt.renderer || !tt.camera) return;
    const stage = document.getElementById('ttStage');
    if (!stage) return;
    const width = stage.clientWidth || 440;
    const height = stage.clientHeight || 230;
    tt.camera.aspect = width / height;
    tt.camera.updateProjectionMatrix();
    tt.renderer.setSize(width, height);
  },

  updateThreeTurntableCover(coverUrl) {
    if (!this.threeTurntable.isInitialized || !coverUrl) return;
    const proxied = `/api/image-proxy?url=${encodeURIComponent(coverUrl)}`;
    const loader = new THREE.TextureLoader();
    loader.load(proxied, (texture) => {
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      if (this.threeTurntable.jacketMaterial) {
        this.threeTurntable.jacketMaterial.map = texture;
        this.threeTurntable.jacketMaterial.needsUpdate = true;
      }
      if (this.threeTurntable.labelMaterial) {
        this.threeTurntable.labelMaterial.map = texture;
        this.threeTurntable.labelMaterial.needsUpdate = true;
      }
    }, undefined, (err) => {
      console.warn('Three.js cover texture load error:', err);
    });
  },

  // ----------------------------------------------------
  // 3D ACRYLIC STANDS SHOWCASE IN SEARCH & GATEFOLD INNERSLEEVE
  // ----------------------------------------------------
  setSearchViewMode(mode) {
    this.searchViewMode = mode;
    const btnStands = document.getElementById('btnSearchStandsView');
    const btnList = document.getElementById('btnSearchListView');
    const standsContainer = document.getElementById('discogsSearchStandsContainer');
    const listContainer = document.getElementById('discogsSearchResults');

    if (mode === 'stands') {
      if (btnStands) btnStands.classList.add('active');
      if (btnList) btnList.classList.remove('active');
      if (standsContainer) standsContainer.style.display = 'grid';
      if (listContainer) listContainer.style.display = 'none';
      if (this.lastSearchResults && this.lastSearchResults.length > 0) {
        this.renderSearchStands(this.lastSearchResults);
      }
    } else {
      if (btnStands) btnStands.classList.remove('active');
      if (btnList) btnList.classList.add('active');
      if (standsContainer) standsContainer.style.display = 'none';
      if (listContainer) listContainer.style.display = 'flex';
    }
  },

  renderSearchStands(results) {
    const container = document.getElementById('discogsSearchStandsContainer');
    if (!container || !Array.isArray(results)) return;

    // Ensure all items are mapped in searchItemsMap
    results.forEach(item => this.searchItemsMap.set(String(item.id), item));

    if (results.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 48px 20px; color: var(--text-muted);">
          Ничего не найдено. Попробуйте другой поисковый запрос.
        </div>
      `;
      return;
    }

    container.innerHTML = results.map(item => {
      const coverImg = item.thumb || item.coverImage || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'180\' height=\'180\' fill=\'%231a2233\'><rect width=\'180\' height=\'180\'/></svg>';
      const earliestYear = this.getAlbumEarliestYear(item);
      const isAlbum = !!item.masterId;
      const subtitle = isAlbum
        ? (item.versionsCount ? `${item.versionsCount} виниловых изданий` : 'Альбом')
        : (item.country ? `${item.country} · ${item.format || 'Vinyl'}` : (item.format || 'Vinyl'));

      return `
        <div class="acrylic-stand-card" id="stand-card-${item.id}">
          <div class="stand-gatefold-stage" onclick="App.openAlbumTracklistModal('${item.id}')" title="Нажмите, чтобы открыть треклист альбома и слушать">
            <div class="stand-album-jacket" id="stand-jacket-${item.id}">
              <img src="${this.escapeHtml(coverImg)}" class="stand-jacket-cover" alt="Cover" loading="lazy">
              <div class="stand-jacket-sheen"></div>
              <div class="stand-gatefold-spine"></div>
              <div class="stand-jacket-play-overlay">🎵 ▶</div>
            </div>
          </div>
          <div class="stand-acrylic-base">
            <div class="stand-reflection"></div>
            <div class="stand-details">
              <div class="stand-artist" title="${this.escapeHtml(item.artist || item.rawTitle || '')}">${this.escapeHtml(item.artist || item.rawTitle || '')}</div>
              <div class="stand-title" onclick="App.openAlbumTracklistModal('${item.id}')" style="cursor:pointer;" title="Нажмите, чтобы открыть треклист">${this.escapeHtml(item.title || '')}</div>
              <div class="stand-meta">${earliestYear ? `Год: ${earliestYear} · ` : ''}${this.escapeHtml(subtitle)}</div>
            </div>
            <div class="stand-controls">
              <button type="button" class="btn-stand-tracklist" onclick="event.stopPropagation(); App.openAlbumTracklistModal('${item.id}')" title="Посмотреть список песен и прослушать">
                🎵 Треклист ▶
              </button>
              <button type="button" class="btn-stand-golden-pill" onclick="event.stopPropagation(); App.addRecordOrAlbum('${item.id}')" title="Добавить в коллекцию">
                <span class="golden-plus">＋</span> В коллекцию
              </button>
              <div class="stand-star-rating">
                ${this.renderStandStarRating(item)}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  },

  renderStandStarRating(item) {
    const r = parseFloat(item.rating) || 0;
    let html = `<div class="stand-stars-row" onclick="event.stopPropagation()">`;
    for (let i = 1; i <= 5; i++) {
      const active = r >= i ? 'filled' : '';
      html += `
        <button type="button" class="stand-star-btn ${active}" onclick="App.setStandRating('${item.id}', ${i})" title="Оценка ${i} из 5">
          ★
        </button>
      `;
    }
    html += `</div>`;
    return html;
  },

  async setStandRating(id, stars) {
    const item = this.searchItemsMap.get(String(id)) || (this.lastSearchResults || []).find(r => String(r.id) === String(id));
    if (!item) return;
    item.rating = item.rating === stars ? 0 : stars;
    const card = document.getElementById(`stand-card-${id}`);
    if (card) {
      const container = card.querySelector('.stand-star-rating');
      if (container) container.innerHTML = this.renderStandStarRating(item);
    }
    await this.setRating(id, stars);
  },

  async addRecordOrAlbum(id) {
    const item = this.searchItemsMap.get(String(id)) || (this.lastSearchResults || []).find(r => String(r.id) === String(id));
    if (!item) return;
    if (this.appMode === 'albums' || item.masterId) {
      await this.addAlbumFromModal(item.id);
    } else {
      await this.addRecordFromDiscogs(item.id);
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

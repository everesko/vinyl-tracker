/**
 * Firebase Firestore & Cloud Database Sync Manager
 * 
 * Synchronizes all Vinyl Tracker collections with Google Cloud Firebase Firestore:
 * 1. Albums catalog (with all custom tables like Zakhar, Danylo, etc.)
 * 2. Vinyl Releases (physical records, collection, wishlist)
 * 3. Spotify Tracks (all tracklists and saved songs)
 * 
 * Ensures 24/7 cloud persistence on Vercel and any other hosting.
 */

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDhqDAWjOrKprfvUm9bs0FFi9LyjgpIkig",
  authDomain: "schallplatten-ecf93.firebaseapp.com",
  projectId: "schallplatten-ecf93",
  storageBucket: "schallplatten-ecf93.firebasestorage.app",
  messagingSenderId: "648720201521",
  appId: "1:648720201521:web:f71d7613e4ec809c27a210",
  measurementId: "G-W7WKFQC3KL"
};

const FirebaseSync = {
  db: null,
  app: null,
  analytics: null,
  unsubscribes: [],
  isInitialized: false,
  isFirebaseActive: false,
  statusCallback: null,
  onModeUpdatedCallback: null,
  _isInternalWrite: false,

  getConfig() {
    try {
      const cfg = localStorage.getItem('vinyl_firebase_config');
      if (cfg) {
        const parsed = JSON.parse(cfg);
        if (parsed && parsed.apiKey && parsed.projectId) return parsed;
      }
    } catch (e) {}
    return DEFAULT_FIREBASE_CONFIG;
  },

  setConfig(config) {
    if (config && config.apiKey && config.projectId) {
      localStorage.setItem('vinyl_firebase_config', JSON.stringify(config));
    } else {
      localStorage.removeItem('vinyl_firebase_config');
    }
  },

  onStatusChange(cb) {
    this.statusCallback = cb;
  },

  notifyStatus(status, details = '') {
    if (this.statusCallback) {
      this.statusCallback({ status, details, isFirebaseActive: this.isFirebaseActive });
    }
  },

  /**
   * Load local fallback for a specific mode
   */
  async loadLocalModeTables(mode) {
    try {
      const raw = localStorage.getItem(`vinyl_${mode}_tables`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}

    // Fallback: fetch from server JSON if running locally
    try {
      const typeParam = mode === 'releases' ? 'release' : (mode === 'albums' ? 'album' : 'spotify');
      const res = await fetch(`/api/storage/records?type=${typeParam}`);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.tables) && data.tables.length > 0) {
          return data.tables;
        }
      }
    } catch (e) {}

    return [];
  },

  /**
   * Sync an entire mode's tables to Google Cloud Firestore
   */
  async syncModeTables(mode, tables, updatedAt = Date.now()) {
    if (!mode || !Array.isArray(tables)) return false;

    this.notifyStatus('syncing', `Идет синхронизация (${mode})...`);

    // LocalStorage immediate backup
    try {
      localStorage.setItem(`vinyl_${mode}_tables`, JSON.stringify(tables));
      localStorage.setItem(`vinyl_${mode}_updated_at`, String(updatedAt));
    } catch (e) {}

    if (this.isFirebaseActive && this.db) {
      try {
        const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js');
        const docRef = doc(this.db, 'vinyl_tracker', mode);

        this._isInternalWrite = true;
        await setDoc(docRef, {
          tables: tables,
          updatedAt: Number(updatedAt) || Date.now(),
          lastSyncedAt: new Date().toISOString()
        }, { merge: true });

        setTimeout(() => { this._isInternalWrite = false; }, 300);
        this.notifyStatus('synced', `Облако синхронизировано (${mode})`);
        return true;
      } catch (err) {
        this._isInternalWrite = false;
        console.warn(`Firestore save error for ${mode}:`, err);
        this.notifyStatus('error', `Ошибка синхронизации: ${err.message}`);
      }
    }
    return false;
  },

  /**
   * Initialize Firebase SDK and real-time listeners
   */
  async init(options = {}) {
    const config = this.getConfig();

    if (!config || !config.apiKey || !config.projectId) {
      this.isFirebaseActive = false;
      this.notifyStatus('local', 'Работает в локальном режиме');
      return;
    }

    try {
      this.notifyStatus('connecting', 'Подключение к Google Firebase Firestore...');

      // Dynamic imports from Firebase Web CDN
      const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js');
      const { 
        getFirestore, 
        doc, 
        onSnapshot, 
        setDoc,
        getDoc,
        enableIndexedDbPersistence 
      } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js');

      const existingApps = getApps();
      this.app = existingApps.length > 0 ? existingApps[0] : initializeApp(config);
      this.db = getFirestore(this.app);
      this.isFirebaseActive = true;
      this.isInitialized = true;

      // Optional analytics
      try {
        const { getAnalytics, isSupported } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-analytics.js');
        if (await isSupported()) {
          this.analytics = getAnalytics(this.app);
        }
      } catch (e) {}

      this.notifyStatus('connected', `Firebase подключен: ${config.projectId}`);

      // Unsubscribe any previous listeners
      this.unsubscribes.forEach(unsub => { try { unsub(); } catch (e) {} });
      this.unsubscribes = [];

      const onModeUpdated = options.onModeUpdated || null;
      const modes = ['albums', 'releases', 'spotify'];

      for (const mode of modes) {
        const docRef = doc(this.db, 'vinyl_tracker', mode);

        // Realtime listener for each mode
        const unsub = onSnapshot(docRef, async (docSnap) => {
          if (this._isInternalWrite) return; // Prevent re-trigger on own write

          if (docSnap.exists()) {
            const data = docSnap.data();
            if (data && Array.isArray(data.tables) && data.tables.length > 0) {
              const cloudUpdated = Number(data.updatedAt) || 0;
              const localUpdated = Number(localStorage.getItem(`vinyl_${mode}_updated_at`)) || 0;

              // Only accept cloud if newer or equal, or if local is empty
              const localTablesRaw = localStorage.getItem(`vinyl_${mode}_tables`);
              const localIsEmpty = !localTablesRaw || localTablesRaw === '[]';

              if (cloudUpdated >= localUpdated || localIsEmpty) {
                localStorage.setItem(`vinyl_${mode}_tables`, JSON.stringify(data.tables));
                if (cloudUpdated) {
                  localStorage.setItem(`vinyl_${mode}_updated_at`, String(cloudUpdated));
                }
                if (onModeUpdated) {
                  onModeUpdated(mode, data.tables, cloudUpdated);
                }
              }
            }
          } else {
            // First time setup: document does not exist in Firestore yet!
            // Automatically push existing local collection to Firestore!
            const localTables = await this.loadLocalModeTables(mode);
            if (localTables && Array.isArray(localTables) && localTables.length > 0) {
              console.log(`[FirebaseSync] Uploading initial ${mode} collection to Cloud Firestore...`);
              await this.syncModeTables(mode, localTables, Date.now());
            }
          }
        }, (error) => {
          console.warn(`[FirebaseSync] Snapshot error on ${mode}:`, error);
          this.notifyStatus('error', `Ошибка Firestore (${mode}): ${error.message}`);
        });

        this.unsubscribes.push(unsub);
      }

    } catch (err) {
      console.warn('Failed to initialize Firebase Firestore:', err);
      this.isFirebaseActive = false;
      this.notifyStatus('error', `Ошибка Firebase: ${err.message}`);
    }
  },

  /**
   * Backward-compatibility helper for legacy releases
   */
  async loadLocalRecords() {
    const tables = await this.loadLocalModeTables('releases');
    if (tables && tables[0] && Array.isArray(tables[0].items)) {
      return tables[0].items;
    }
    return [];
  },

  saveLocalRecords(records) {
    if (!Array.isArray(records)) return;
    const tables = [{ id: 'tbl_releases_default', name: 'Основная коллекция', items: records }];
    this.syncModeTables('releases', tables);
  },

  async saveRecord(record) {
    if (!record || !record.id) return false;
    // Handled by App.saveModeTables
    return true;
  },

  async deleteRecord(recordId) {
    if (!recordId) return false;
    // Handled by App.saveModeTables
    return true;
  }
};

window.FirebaseSync = FirebaseSync;

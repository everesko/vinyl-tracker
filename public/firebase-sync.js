/**
 * Firebase Firestore & Hybrid Storage Sync Manager
 * 
 * Synchronizes vinyl records between:
 * 1. Cloud Firestore (when configured)
 * 2. Browser LocalStorage (for instant offline startup)
 * 3. Server-side local JSON backup (/api/storage/records)
 */

const FirebaseSync = {
  db: null,
  app: null,
  unsubscribe: null,
  isInitialized: false,
  isFirebaseActive: false,
  statusCallback: null,

  getConfig() {
    try {
      const cfg = localStorage.getItem('vinyl_firebase_config');
      return cfg ? JSON.parse(cfg) : null;
    } catch (e) {
      return null;
    }
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
   * Load local records from localStorage or server fallback
   */
  async loadLocalRecords() {
    try {
      const local = localStorage.getItem('vinyl_records_local');
      if (local) {
        return JSON.parse(local);
      }
    } catch (e) {}

    // Fallback: fetch from server JSON backup
    try {
      const res = await fetch('/api/storage/records');
      if (res.ok) {
        const data = await res.json();
        if ((Array.isArray(data) && data.length > 0) || (data && Array.isArray(data.tables))) {
          localStorage.setItem('vinyl_records_local', JSON.stringify(data));
          return data;
        }
      }
    } catch (e) {}

    return [];
  },

  /**
   * Save local records to localStorage and server backup
   */
  saveLocalRecords(records) {
    try {
      localStorage.setItem('vinyl_records_local', JSON.stringify(records));
      // Save to server backup quietly
      fetch('/api/storage/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(records)
      }).catch(() => {});
    } catch (e) {
      console.warn('Failed to save locally:', e);
    }
  },

  /**
   * Initialize Firebase SDK if config is present
   */
  async init(onRecordsUpdated) {
    const config = this.getConfig();

    if (!config || !config.apiKey || !config.projectId) {
      this.isFirebaseActive = false;
      this.notifyStatus('local', 'Работает в локальном режиме (без Firebase)');
      const records = await this.loadLocalRecords();
      if (onRecordsUpdated) onRecordsUpdated(records);
      return;
    }

    try {
      this.notifyStatus('connecting', 'Подключение к Firebase Firestore...');

      // Dynamic import of Firebase SDK modules from CDN
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js');
      const { 
        getFirestore, 
        collection, 
        onSnapshot, 
        doc, 
        setDoc, 
        deleteDoc, 
        getDocs,
        enableIndexedDbPersistence 
      } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js');

      this.app = initializeApp(config);
      this.db = getFirestore(this.app);
      this.isFirebaseActive = true;
      this.notifyStatus('connected', `Firebase подключен: ${config.projectId}`);

      const recordsCol = collection(this.db, 'vinyl_records');

      // Realtime listener
      this.unsubscribe = onSnapshot(recordsCol, (snapshot) => {
        const records = [];
        snapshot.forEach((docSnap) => {
          records.push({ id: docSnap.id, ...docSnap.data() });
        });

        // Save local copy
        this.saveLocalRecords(records);

        if (onRecordsUpdated) {
          onRecordsUpdated(records);
        }
      }, (error) => {
        console.error('Firestore snapshot error:', error);
        this.notifyStatus('error', `Ошибка Firestore: ${error.message}`);
      });

    } catch (err) {
      console.warn('Failed to initialize Firebase:', err);
      this.isFirebaseActive = false;
      this.notifyStatus('error', `Ошибка подключения Firebase: ${err.message}. Используется локальная база.`);
      const records = await this.loadLocalRecords();
      if (onRecordsUpdated) onRecordsUpdated(records);
    }
  },

  /**
   * Save or update record (works with Firebase or Local fallback)
   */
  async saveRecord(record) {
    if (this.isFirebaseActive && this.db) {
      try {
        const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js');
        const docRef = doc(this.db, 'vinyl_records', String(record.id));
        await setDoc(docRef, record, { merge: true });
        return true;
      } catch (e) {
        console.error('Firebase save error:', e);
      }
    }

    // Local fallback
    const records = await this.loadLocalRecords();
    const idx = records.findIndex(r => String(r.id) === String(record.id));
    if (idx >= 0) {
      records[idx] = { ...records[idx], ...record };
    } else {
      records.unshift(record);
    }
    this.saveLocalRecords(records);
    return true;
  },

  /**
   * Delete record
   */
  async deleteRecord(recordId) {
    if (this.isFirebaseActive && this.db) {
      try {
        const { doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js');
        await deleteDoc(doc(this.db, 'vinyl_records', String(recordId)));
        return true;
      } catch (e) {
        console.error('Firebase delete error:', e);
      }
    }

    // Local fallback
    let records = await this.loadLocalRecords();
    records = records.filter(r => String(r.id) !== String(recordId));
    this.saveLocalRecords(records);
    return true;
  }
};

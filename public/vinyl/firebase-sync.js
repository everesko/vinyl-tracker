/* Former Firestore saves now use the signed-in ECHO profile.
 * The original Firebase project is available as explicit read-only import.
 */
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDhqDAWjOrKprfvUm9bs0FFi9LyjgpIkig',
  authDomain: 'schallplatten-ecf93.firebaseapp.com', projectId: 'schallplatten-ecf93',
  storageBucket: 'schallplatten-ecf93.firebasestorage.app', messagingSenderId: '648720201521',
  appId: '1:648720201521:web:f71d7613e4ec809c27a210', measurementId: 'G-W7WKFQC3KL'
};
const FirebaseSync = {
  db: null, app: null, isFirebaseActive: false, isInitialized: false, statusCallback: null,
  getConfig() { try { return JSON.parse(VinylStorage.getItem('vinyl_firebase_config')) || DEFAULT_FIREBASE_CONFIG; } catch (_) { return DEFAULT_FIREBASE_CONFIG; } },
  setConfig(config) { if (config?.apiKey && config?.projectId) VinylStorage.setItem('vinyl_firebase_config', JSON.stringify(config)); else VinylStorage.removeItem('vinyl_firebase_config'); },
  onStatusChange(callback) { this.statusCallback = callback; },
  notifyStatus(status, details = '') { this.statusCallback?.({ status, details, isFirebaseActive: false }); },
  async init() { this.isInitialized = true; this.notifyStatus('local', EchoVinyl.tr('cloud')); },
  async loadLocalModeTables(mode) {
    const type = mode === 'releases' ? 'release' : mode === 'albums' ? 'album' : 'spotify';
    try { const data = await EchoVinyl.json('storage/records?type=' + type); return data.tables || []; }
    catch (_) { try { return JSON.parse(VinylStorage.getItem(`vinyl_${mode}_tables`)) || []; } catch (_) { return []; } }
  },
  async syncModeTables(mode, tables, updatedAt = Date.now(), userAction = false) {
    if (!Array.isArray(tables)) return false;
    const type = mode === 'releases' ? 'release' : mode === 'albums' ? 'album' : 'spotify';
    VinylStorage.setItem(`vinyl_${mode}_tables`, JSON.stringify(tables));
    VinylStorage.setItem(`vinyl_${mode}_updated_at`, String(updatedAt));
    this.notifyStatus('syncing', EchoVinyl.tr('connecting'));
    try {
      const result = await EchoVinyl.json('storage/records?type=' + type, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tables, updatedAt, userAction }) });
      if (result.protected) { EchoVinyl.notify('conflict', true); this.notifyStatus('error', EchoVinyl.tr('conflict')); return false; }
      this.notifyStatus('synced', EchoVinyl.tr('saved')); return true;
    } catch (_) { this.notifyStatus('error', EchoVinyl.tr('error')); return false; }
  },
  async loadLocalRecords() { const tables = await this.loadLocalModeTables('releases'); return tables[0]?.items || []; },
  saveLocalRecords(records) { if (Array.isArray(records)) return this.syncModeTables('releases', [{ id:'tbl_releases_default', name:'Основная коллекция', items:records }]); },
  async saveRecord(record) { return !!record?.id; }, async deleteRecord(recordId) { return !!recordId; }
};
window.FirebaseSync = FirebaseSync;

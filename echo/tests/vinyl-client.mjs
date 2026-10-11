import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

function client({ quota = false } = {}) {
  const saved = new Map(), writes = [], messages = [], container = { innerHTML: '' };
  let owner = 'alice';
  const context = vm.createContext({ URL, URLSearchParams, Request, Response, Headers, AbortSignal, DOMException, Map, Set, Intl, console,
    location: { origin: 'https://echo.test', href: 'https://echo.test/vinyl/index.html', search: '', pathname: '/vinyl/index.html' },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem(key, value) { if (quota) throw new DOMException('Full', 'QuotaExceededError'); saved.set(key, value); }, removeItem: key => saved.delete(key) },
    document: { body: { className: '', querySelectorAll() { return []; } }, documentElement: {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById(id) { return id === 'tablesContainer' ? container : null; }, createTreeWalker() { return { nextNode() { return null; } }; } },
    parent: { postMessage: message => messages.push(message) }, NodeFilter: { SHOW_TEXT: 4 }, setTimeout() { return 0; }, clearTimeout() {}, requestAnimationFrame() {},
    addEventListener() {}, fetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/status')) return Response.json({ userId: owner });
      if (path.endsWith('/connection')) return Response.json({ connected: false });
      if (path.endsWith('/credentials')) return Response.json({ configured: false });
      if (path.endsWith('/storage/records')) {
        if (init.method === 'POST') { const payload = JSON.parse(init.body); writes.push(payload); return Response.json({ version: writes.length, updatedAt: Date.now() }); }
        return Response.json({ tables: [], version: 0 });
      }
      return Response.json({});
    },
  });
  vm.runInContext('window = globalThis; DiscogsClient = {setToken(){},setUser(){},getToken(){return null}}; SpotifyClient = {setToken(){},setUser(){},getToken(){return null},handleHashCallback(){return null}};', context);
  for (const file of ['echo-bridge.js', 'firebase-sync.js', 'app.js']) vm.runInContext(readFileSync(new URL('../public/vinyl/' + file, import.meta.url), 'utf8'), context);
  vm.runInContext('window.App = App;', context);
  return { context, app: context.App, writes, messages, container, setOwner(value) { owner = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('browser storage quota cannot suppress cloud saves or mix account caches', async () => {
  const h = client({ quota: true }); await h.context.EchoVinyl.bootstrap();
  h.app.tables.albums = [{ id: 'albums', name: 'Mine', items: [{ id: 'a', title: 'Discovery', artist: 'Daft Punk' }] }];
  h.app.saveModeTables('albums'); await settle();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].tables[0].items[0].title, 'Discovery');
  assert.equal(h.writes[0].originalTables, undefined, 'Cloud write never duplicates the entire collection in its payload');
  assert.ok(h.context.VinylStorage.getItem('vinyl_albums_tables').includes('Discovery'));
  h.setOwner('bob'); await h.context.EchoVinyl.bootstrap(); assert.equal(h.context.VinylStorage.getItem('vinyl_albums_tables'), null);
  h.setOwner('alice'); await h.context.EchoVinyl.bootstrap(); assert.ok(h.context.VinylStorage.getItem('vinyl_albums_tables').includes('Discovery'));
});

test('confirmed final-record deletion is distinguished from an automatic empty save in every mode', async () => {
  for (const mode of ['albums', 'releases', 'spotify']) {
    const h = client(); await h.context.EchoVinyl.bootstrap();
    h.app.tables[mode] = [{ id: 'table', name: 'Mine', items: [{ id: 'last', title: 'One' }] }];
    assert.equal(h.app.deleteItemFromMode('last', mode), true); await settle();
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0].userAction, true); assert.equal(h.writes[0].tables[0].items.length, 0);
    h.app.saveModeTables(mode); await settle(); assert.equal(h.writes.at(-1).userAction, false);
  }
});

test('ready is sent only after collection initialization and can be acknowledged again after a locale change', () => {
  const h = client(); h.app.renderTables = () => {}; h.context.EchoVinyl.setLocale('en'); assert.equal(h.messages.length, 0);
  h.context.EchoVinyl.markReady(); assert.equal(h.messages.length, 1);
  h.context.EchoVinyl.setLocale('uk'); assert.equal(h.messages.length, 2); assert.ok(h.messages.every(message => message.type === 'echo-vinyl-ready'));
});

test('large collection display renders one page, searches all records and keeps collapsed tables out of the DOM', () => {
  const h = client(), records = Array.from({ length: 1500 }, (_, index) => ({ id: String(index), title: `Album ${index}`, artist: 'Artist', status: 'buy' }));
  h.app.tables.releases = [{ id: 'large', name: 'Large', items: records }];
  h.app.sortCol = 'title'; h.app.sortAsc = true;
  h.app.renderTableRow = item => `<tr data-id="${item.id}"><td>${item.title}</td></tr>`;
  h.app.updateSelectionToolbar = () => {}; h.app.updateActiveFiltersBadge = () => {};
  h.app.renderTables(); assert.equal((h.container.innerHTML.match(/data-id=/g) || []).length, 100); assert.match(h.container.innerHTML, /1500/);
  h.app.tablePages.set('releases:large', 14); h.app.renderTables(); assert.equal((h.container.innerHTML.match(/data-id=/g) || []).length, 100);
  const before = h.container.innerHTML; h.app.setTablePage('large', 0); assert.notEqual(h.container.innerHTML, before);
  h.app.render = () => h.app.renderTables(); h.app.highlightRecord('999'); assert.match(h.container.innerHTML, /data-id="999"/, 'Pinned record navigation finds its page');
  h.app.tableSearchQuery = 'album 1499'; h.app.renderTables(); assert.match(h.container.innerHTML, /data-id="1499"/); assert.equal(h.app.tablePages.get('releases:large'), 0);
  h.app.tables.releases[0].isCollapsed = true; h.app.renderTables(); assert.equal((h.container.innerHTML.match(/data-id=/g) || []).length, 0);
  assert.equal(h.app.tables.releases[0].items.length, 1500, 'Pagination never truncates collection data');
});

test('collection modes load concurrently after authenticated identity is established', async () => {
  const h = client(), started = [], finish = [];
  for (const key of ['bindEvents','initAudioSystem','updateDiscogsUIStatus','updateSpotifyUIStatus','applyExperimentEffects','updateActiveFiltersBadge','renderCloudStatus','render','updateModeToggleBadges','initTurntableDragging','initTurntableWidgetDragging','updateFloatingPlayerButtonUI','prefetchCollectionTracklists']) h.app[key] = () => {};
  for (const method of ['loadAllReleases','loadAlbums','loadSpotifyTracks']) h.app[method] = () => { assert.equal(h.context.EchoVinyl.owner, 'alice'); started.push(method); return new Promise(resolve => finish.push(resolve)); };
  const initialization = h.app.init(); await settle(); assert.equal(started.length, 3); assert.equal(h.messages.length, 0);
  finish.forEach(resolve => resolve()); await initialization; assert.equal(h.messages.length, 1);
});

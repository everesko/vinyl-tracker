/* Same-origin bridge. The host session is authoritative; the query owner is never trusted. */
(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  let originalStorage;
  try { originalStorage = window.localStorage; } catch (_) { originalStorage = null; }
  const temporaryStorage = new Map();
  let owner = 'guest';
  let prefix = 'echo:vinyl:guest:';
  let locale = ['uk', 'en', 'ru'].includes(new URLSearchParams(location.search).get('locale')) ? new URLSearchParams(location.search).get('locale') : 'uk';
  const versions = new Map(), queues = new Map(), pending = new Map(), blocked = new Set();
  const storage = {
    getItem(key) { const fullKey = prefix + key; if (temporaryStorage.has(fullKey)) return temporaryStorage.get(fullKey); try { return originalStorage?.getItem(fullKey) ?? null; } catch (_) { return null; } },
    setItem(key, value) { const fullKey = prefix + key; try { if (!originalStorage) throw Error(); originalStorage.setItem(fullKey, value); temporaryStorage.delete(fullKey); } catch (_) { temporaryStorage.set(fullKey, String(value)); } },
    removeItem(key) { const fullKey = prefix + key; temporaryStorage.delete(fullKey); try { originalStorage?.removeItem(fullKey); } catch (_) {} },
    keys() { let saved = []; try { saved = Object.keys(originalStorage || {}); } catch (_) {} return [...new Set([...saved, ...temporaryStorage.keys()])].filter(k => k.startsWith(prefix)); },
    key(index) { return this.keys()[index]?.slice(prefix.length) || null; },
    get length() { return this.keys().length; },
    clear() { for (const key of this.keys()) this.removeItem(key.slice(prefix.length)); },
  };
  window.VinylStorage = storage;
  const texts = {
    uk: { conflict: 'Колекцію змінено в іншому вікні. Ваші незбережені зміни збережено окремо. Оновіть дані перед редагуванням.', saved: 'Колекцію збережено', error: 'Не вдалося зберегти зміни. Локальну копію збережено; повторіть синхронізацію.', signin: 'Увійдіть у профіль ECHO, щоб зберігати колекцію.', import: 'Імпортувати стару колекцію', reload: 'Оновити дані', backup: 'Завантажити копію змін', importQuestion: 'Імпортувати таблиці старого трекера? Поточна колекція буде доповнена, наявні записи збережуться.', empty: 'У цьому браузері не знайдено старих таблиць. Можна імпортувати Excel або стару базу Firebase через налаштування.', firebaseQuestion: 'Імпортувати таблиці старої бази Firebase? Дані старої бази не будуть змінені.', imported: 'Колекцію імпортовано', connecting: 'Відкриваємо вашу колекцію…', cloud: 'Профіль ECHO' },
    en: { conflict: 'This collection changed in another window. Your unsaved changes have a separate backup. Refresh before editing.', saved: 'Collection saved', error: 'Could not save changes. A local copy is safe; retry synchronization.', signin: 'Sign in to your ECHO profile to save your collection.', import: 'Import old collection', reload: 'Refresh collection', backup: 'Download unsaved changes', importQuestion: 'Import tables from your old tracker? Your current collection will be extended; existing records will be kept.', empty: 'No old tables found in this browser. Import Excel or use the Firebase settings to import your old cloud database.', firebaseQuestion: 'Import tables from your old Firebase database? The old database will not be changed.', imported: 'Collection imported', connecting: 'Opening your collection…', cloud: 'ECHO profile' },
    ru: { conflict: 'Коллекция изменена в другом окне. Несохранённые изменения сохранены отдельно. Обновите данные перед редактированием.', saved: 'Коллекция сохранена', error: 'Не удалось сохранить изменения. Локальная копия сохранена; повторите синхронизацию.', signin: 'Войдите в профиль ECHO, чтобы сохранять коллекцию.', import: 'Импортировать старую коллекцию', reload: 'Обновить данные', backup: 'Скачать копию изменений', importQuestion: 'Импортировать таблицы старого трекера? Текущая коллекция будет дополнена, существующие записи сохранятся.', empty: 'В этом браузере не найдены старые таблицы. Можно импортировать Excel или старую базу Firebase через настройки.', firebaseQuestion: 'Импортировать таблицы старой базы Firebase? Данные старой базы не будут изменены.', imported: 'Коллекция импортирована', connecting: 'Открываем вашу коллекцию…', cloud: 'Профиль ECHO' },
  };
  const tr = key => texts[locale][key] || key;
  function notify(key, error = false) {
    const node = document.getElementById('echoVinylStatus');
    if (node) { node.textContent = tr(key); node.classList.toggle('error', error); node.hidden = false; }
    const pill = document.getElementById('syncPillText');
    if (pill) pill.textContent = error ? tr('error') : tr('cloud');
  }
  function scopedUrl(input) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/vinyl/')) url.pathname = '/api/vinyl/legacy/' + url.pathname.slice(5);
    // Old fallback must use the server's saved credential, never a browser secret.
    if (url.origin === 'https://api.discogs.com') {
      const match = url.pathname.match(/^\/masters\/(\d+)\/versions$/);
      if (match) return location.origin + '/api/vinyl/legacy/discogs/master/' + match[1] + '/versions' + url.search;
      throw new Error('Use the ECHO Discogs connection.');
    }
    return url.href;
  }
  async function storageRequest(url, init) {
    const type = new URL(url).searchParams.get('type') || 'release';
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') {
      const response = await nativeFetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' });
      if (response.ok && !(pending.get(type) > 0)) { const data = await response.clone().json(); versions.set(type, data.version ?? 0); }
      return response;
    }
    const body = JSON.parse(init.body || '{}');
    if (blocked.has(type)) return new Response(JSON.stringify({ error: tr('conflict') }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    const previous = queues.get(type) || Promise.resolve();
    pending.set(type, (pending.get(type) || 0) + 1);
    const run = previous.catch(() => {}).then(async () => {
      if (blocked.has(type)) return new Response(JSON.stringify({ error: tr('conflict') }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      if (!versions.has(type)) {
        const read = await nativeFetch(url, { credentials:'same-origin', cache:'no-store' });
        if (!read.ok) { notify(read.status === 401 ? 'signin' : 'error', true); return read; }
        const data = await read.json(); versions.set(type, data.version ?? 0);
      }
      let response;
      try { response = await nativeFetch(url, { ...init, credentials: 'same-origin', body: JSON.stringify({ ...body, version: versions.get(type) }) }); }
      catch(error) { storage.setItem('echo_unsaved_' + type, JSON.stringify(body)); blocked.add(type); notify('error', true); throw error; }
      if (response.ok) { const data = await response.clone().json().catch(() => ({})); versions.set(type, data.version ?? versions.get(type) + 1); if (!data.protected) notify('saved'); }
      else {
        storage.setItem('echo_unsaved_' + type, JSON.stringify(body));
        if (response.status === 409) { blocked.add(type); notify('conflict', true); } else notify(response.status === 401 ? 'signin' : 'error', true);
      }
      return response;
    }).finally(() => pending.set(type, Math.max(0,(pending.get(type) || 1)-1)));
    queues.set(type, run);
    return run;
  }
  window.fetch = async (input, options = {}) => {
    const url = scopedUrl(input);
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    headers.delete('x-discogs-token'); headers.delete('x-spotify-token'); headers.delete('Authorization'); headers.delete('User-Agent');
    const init = { ...options, headers };
    if (new URL(url).origin === location.origin) init.credentials = 'same-origin';
    if (new URL(url).pathname === '/api/vinyl/legacy/storage/records') return storageRequest(url, init);
    return nativeFetch(url, init);
  };

  async function json(path, options) {
    const response = await fetch('/api/vinyl/legacy/' + path, { ...options, signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `${response.status}`);
    return data;
  }
  let ready = false;
  function sendReady() { if (ready && parent !== window) parent.postMessage({ type: 'echo-vinyl-ready' }, location.origin); }
  async function bootstrap() {
    try {
      const status = await json('status');
      if (typeof status.userId !== 'string' || !status.userId) throw new Error(tr('signin'));
      owner = status.userId; prefix = 'echo:vinyl:' + encodeURIComponent(owner) + ':';
      const [discogs, spotify] = await Promise.allSettled([json('discogs/connection'), json('spotify/connection')]);
      if (discogs.status === 'fulfilled' && discogs.value.connected) { DiscogsClient.setToken('server-connected'); DiscogsClient.setUser(discogs.value.user || { username: discogs.value.username }); }
      if (spotify.status === 'fulfilled' && spotify.value.connected) { SpotifyClient.setToken('server-connected'); SpotifyClient.setUser(spotify.value.user); }
    } catch (_) { notify('signin', true); }
  }
  async function refresh(force = false) {
    if (!window.App) return;
    if (!force && document.querySelector('.modal-backdrop.open,.modal-backdrop.active')) { window.EchoVinyl.pendingRefresh = true; return; }
    await Promise.allSettled([...queues.values()]);
    if (!force && blocked.size) return;
    if (force) blocked.clear();
    await Promise.all([App.loadAllReleases(), App.loadAlbums(), App.loadSpotifyTracks()]);
    App.syncLegacyArrays(); App.render(); App.updateModeToggleBadges();
  }
  async function importTables(tablesByMode) {
    await Promise.allSettled([...queues.values()]);
    if (blocked.size) throw new Error(tr('conflict'));
    for (const mode of ['albums', 'releases', 'spotify']) {
      const incoming = tablesByMode[mode];
      if (!Array.isArray(incoming) || !incoming.length) continue;
      const type = mode === 'releases' ? 'release' : mode === 'albums' ? 'album' : 'spotify';
      const remote = await json('storage/records?type=' + type);
      const merged = App.mergeTableLists(remote.tables || [], incoming, mode, mode === 'albums' ? 'Каталог альбомов' : mode === 'releases' ? 'Основная коллекция' : 'Мой треклист');
      await json('storage/records?type=' + type, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tables: merged, updatedAt: Date.now() }) });
    }
    await refresh(true); notify('imported');
  }
  async function importLegacy() {
    if (!confirm(tr('importQuestion'))) return;
    const input = {};
    for (const mode of ['albums', 'releases', 'spotify']) { try { const raw = originalStorage?.getItem(`vinyl_${mode}_tables`); if (raw) input[mode] = JSON.parse(raw); } catch (_) {} }
    if (!Object.values(input).some(tables => Array.isArray(tables) && tables.length)) { alert(tr('empty')); return; }
    await importTables(input);
    // Secret migration is optional, after the collection succeeds; failed secrets remain in the original browser store.
    try {
      const discogsToken = originalStorage?.getItem('vinyl_discogs_token');
      if (discogsToken) { try { await DiscogsClient.checkIdentity(discogsToken); originalStorage.removeItem('vinyl_discogs_token'); } catch (_) {} }
      const clientId = originalStorage?.getItem('spotify_client_id'), secret = originalStorage?.getItem('spotify_client_secret');
      if (clientId && secret && secret !== '••••••••') { try { await SpotifyClient.saveCredentials(clientId, secret); originalStorage.removeItem('spotify_client_secret'); } catch (_) {} }
    } catch (_) {}
  }
  async function importFirebase(config) {
    if (!confirm(tr('firebaseQuestion'))) return;
    const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js');
    const { getFirestore, doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js');
    const name = 'echo-legacy-import-' + config.projectId;
    const app = getApps().find(a => a.name === name) || initializeApp(config, name);
    const database = getFirestore(app), input = {};
    for (const mode of ['albums', 'releases', 'spotify']) { const snap = await getDoc(doc(database, 'vinyl_tracker', mode)); if (snap.exists()) input[mode] = snap.data().tables; }
    await importTables(input);
  }
  function backup() {
    const output = { tables: {}, unsaved: {} };
    for (const mode of ['albums', 'releases', 'spotify']) output.tables[mode] = App.tables[mode];
    for (const type of ['album', 'release', 'spotify']) { const raw = storage.getItem('echo_unsaved_' + type); if (raw) output.unsaved[type] = JSON.parse(raw); }
    const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'echo-vinyl-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Exact UI phrases only: record titles, artists and user table names are never translated.
  const dictionary = {
    ...(window.EchoVinylTranslations || {}),
    'Винилы (с ценами)': ['Вінілові видання', 'Vinyl pressings'], 'По альбомам': ['Альбоми', 'Albums'], 'Песни (Spotify)': ['Пісні · Spotify', 'Songs · Spotify'],
    'Настройки': ['Налаштування', 'Settings'], 'Экспорт': ['Експорт', 'Export'], 'Загрузить': ['Імпорт', 'Import'], 'ВСЕГО В СПИСКЕ': ['У КОЛЕКЦІЇ', 'IN COLLECTION'],
    'В НАЛИЧИИ': ['У НАЯВНОСТІ', 'OWNED'], 'К ПОКУПКЕ': ['ДО ПОКУПКИ', 'TO BUY'], 'ОБЩАЯ СТОИМОСТЬ': ['ЗАГАЛЬНА ВАРТІСТЬ', 'TOTAL VALUE'], 'Папка:': ['Таблиця:', 'Table:'],
    'Купить': ['Купити', 'Buy'], 'Взять': ['Взяти', 'Take'], 'Заменить': ['Замінити', 'Replace'], 'В наличии': ['У наявності', 'Owned'], 'Все': ['Усі', 'All'],
    'Добавить': ['Додати', 'Add'], 'Добавить вручную': ['Додати вручну', 'Add manually'], 'Новая таблица': ['Нова таблиця', 'New table'], 'Поиск на Discogs': ['Пошук у Discogs', 'Search Discogs'],
    'Фильтры': ['Фільтри', 'Filters'], 'Свернуть': ['Згорнути', 'Collapse'], 'Развернуть': ['Розгорнути', 'Expand'], 'Поиск виниловых пластинок на Discogs': ['Пошук вінілових платівок у Discogs', 'Search vinyl on Discogs'],
    'Искать': ['Знайти', 'Search'], 'Закрыть': ['Закрити', 'Close'], 'Отмена': ['Скасувати', 'Cancel'], 'Сохранить': ['Зберегти', 'Save'], 'Удалить': ['Видалити', 'Delete'], 'Редактировать': ['Редагувати', 'Edit'],
    'Исполнитель': ['Виконавець', 'Artist'], 'Альбом': ['Альбом', 'Album'], 'Название': ['Назва', 'Title'], 'Год': ['Рік', 'Year'], 'Страна': ['Країна', 'Country'], 'Цена': ['Ціна', 'Price'], 'Статус': ['Статус', 'Status'],
    'Заметки': ['Нотатки', 'Notes'], 'Обложка': ['Обкладинка', 'Cover'], 'Рейтинг': ['Оцінка', 'Rating'], 'Действия': ['Дії', 'Actions'], 'Оценка': ['Оцінка', 'Rating'], 'Издания': ['Видання', 'Pressings'],
    'Выбрать все': ['Вибрати всі', 'Select all'], 'Снять': ['Скасувати вибір', 'Deselect'], 'Список': ['Список', 'List'], 'Объединить поиски': ['Об’єднати пошуки', 'Combine searches'],
    'Статус позиции': ['Статус запису', 'Item status'], 'Оценка и ценность': ['Оцінка та цінність', 'Rating and value'], 'Только ценные': ['Лише цінні', 'High value only'],
    'Сбросить фильтры': ['Скинути фільтри', 'Reset filters'], 'Применить': ['Застосувати', 'Apply'], 'Подключить': ['Підключити', 'Connect'], 'Выйти': ['Вийти', 'Disconnect'], 'Не подключен': ['Не підключено', 'Not connected'],
    'Войти через Discogs': ['Увійти через Discogs', 'Connect Discogs'], 'Настройки аккаунтов': ['Налаштування облікових записів', 'Account settings'], 'Настройки аккаунтов и сервисов': ['Облікові записи та сервіси', 'Accounts and services'],
    'Облачная база Firebase': ['Імпорт старої бази Firebase', 'Import old Firebase database'], 'Настройки облачной базы Firebase Firestore': ['Імпорт колекції з Firebase', 'Import collection from Firebase'],
    'Синхронизировать сейчас': ['Зберегти зараз', 'Save now'], 'Сохранить и подключить': ['Імпортувати', 'Import collection'],
    'Закреплённые': ['Закріплені', 'Pinned'], 'Закрепленные': ['Закріплені', 'Pinned'], 'Ваши избранные пластинки': ['Ваші улюблені платівки', 'Your favorite records'],
    'Поиск в таблице...': ['Пошук у таблиці…', 'Search table…'], 'Поиск по коллекции...': ['Пошук у колекції…', 'Search collection…'], 'Название или исполнитель...': ['Назва або виконавець…', 'Title or artist…'],
  };
  const originals = new WeakMap();
  let translating = false;
  function translateTree(root = document.body) {
    if (!root || translating) return;
    translating = true;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (['SCRIPT', 'STYLE', 'TEXTAREA'].includes(node.parentElement?.tagName) || node.parentElement?.closest('.table-name,.user-table-title,.artist-name,.album-title,.record-artist,.record-title,.artist-album-col,.spotify-track-album')) continue;
      const record = originals.get(node);
      const original = record && node.nodeValue === record.translated ? record.value : node.nodeValue;
      const trimmed = original?.trim();
      const key = Object.keys(dictionary).find(key => { const at=trimmed?.indexOf(key); return at>=0 && /^[^\p{L}\p{N}]*$/u.test(trimmed.slice(0,at)) && /^[\s(\d)·:…]*$/.test(trimmed.slice(at+key.length)); });
      const phrase = dictionary[key];
      if (!phrase) continue;
      const translated = locale === 'ru' ? original : original.replace(key, phrase[locale === 'en' ? 1 : 0]);
      originals.set(node, { value: original, translated });
      if (node.nodeValue !== translated) node.nodeValue = translated;
    }
    for (const element of root.querySelectorAll('[title],[placeholder]')) {
      for (const attr of ['title', 'placeholder']) {
        const value = element.getAttribute(attr); if (!value) continue;
        const key = 'data-echo-original-' + attr;
        const original = element.getAttribute(key) || value;
        const phrase = dictionary[original.trim()]; if (!phrase) continue;
        element.setAttribute(key, original); element.setAttribute(attr, locale === 'ru' ? original : phrase[locale === 'en' ? 1 : 0]);
      }
    }
    translating = false;
  }
  function setLocale(value) { const changed = ['uk', 'en', 'ru'].includes(value) && locale !== value; if (['uk', 'en', 'ru'].includes(value)) locale = value; document.documentElement.lang = locale; if (changed && ready) window.App?.renderTables(); translateTree(); document.querySelectorAll('[data-echo-copy]').forEach(node => node.textContent = tr(node.dataset.echoCopy)); sendReady(); }
  window.EchoVinyl = { bootstrap, refresh, importLegacy, importTables, importFirebase, backup, json, notify, tr, setLocale, markReady() { ready = true; sendReady(); }, pendingRefresh: false, get owner() { return owner; }, get locale() { return locale; } };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent) return;
    if (event.data?.type === 'echo-vinyl-status') sendReady();
    if (event.data?.type === 'echo-vinyl-locale') setLocale(event.data.locale);
    if (event.data?.type === 'echo-vinyl-refresh') { setLocale(event.data.locale); refresh().catch(() => notify('error', true)); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    setLocale(locale);
    let queued = false;
    const observer = new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; translateTree(); if (window.EchoVinyl.pendingRefresh && !document.querySelector('.modal-backdrop.open,.modal-backdrop.active')) { window.EchoVinyl.pendingRefresh = false; refresh(); } }); } });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
})();

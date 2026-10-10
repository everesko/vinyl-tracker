/* Preserve the tracker methods while keeping credentials in the server vault. */
(() => {
  'use strict';
  let discogsConnected = false, spotifyConnected = false, spotifyHasSecret = false;
  const tokenMarker = 'server-connected';
  DiscogsClient.getToken = () => discogsConnected ? tokenMarker : '';
  DiscogsClient.setToken = token => { discogsConnected = !!token; VinylStorage.removeItem('vinyl_discogs_token'); };
  DiscogsClient.getHeaders = () => ({ 'Content-Type': 'application/json' });
  DiscogsClient.setUser = user => {
    if (user) { const safe = { ...user }; delete safe.tokenSecret; delete safe.token; VinylStorage.setItem('vinyl_discogs_user', JSON.stringify(safe)); }
    else VinylStorage.removeItem('vinyl_discogs_user');
  };
  DiscogsClient.checkIdentity = async token => {
    let data;
    if (token && token !== tokenMarker) data = await EchoVinyl.json('discogs/connection', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token}) });
    else data = await EchoVinyl.json('discogs/connection');
    if (!data.connected) throw new Error('Discogs: підключіть обліковий запис у налаштуваннях.');
    DiscogsClient.setToken(tokenMarker); DiscogsClient.setUser(data.user || {username:data.username});
    return { valid:true, ...(data.user || {username:data.username}) };
  };
  SpotifyClient.getToken = () => spotifyConnected ? tokenMarker : '';
  SpotifyClient.setToken = token => { spotifyConnected = !!token; VinylStorage.removeItem('spotify_user_token'); };
  SpotifyClient.getClientSecret = () => spotifyHasSecret ? '••••••••' : '';
  SpotifyClient.setClientSecret = secret => { spotifyHasSecret = !!secret; VinylStorage.removeItem('spotify_client_secret'); };
  SpotifyClient.saveCredentials = async (clientId, clientSecret) => {
    if (clientSecret === '••••••••') return { success:true };
    const result = await EchoVinyl.json('spotify/credentials', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({clientId,clientSecret})});
    SpotifyClient.setClientId(clientId); SpotifyClient.setClientSecret('••••••••'); return { ...result, success:true };
  };
  SpotifyClient.checkIdentity = async token => {
    if (token && token !== tokenMarker) await EchoVinyl.json('spotify/connection', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token})});
    const result = await EchoVinyl.json('spotify/me');
    SpotifyClient.setToken(tokenMarker); SpotifyClient.setUser(result); return result;
  };
  SpotifyClient.handleHashCallback = () => null;
  App.handleOAuthCallback = () => {};
  const originalDiscogsSettings = App.openDiscogsSettingsModal.bind(App);
  App.openDiscogsSettingsModal = function() {
    originalDiscogsSettings(); const field = document.getElementById('discogsTokenInput');
    if (field) { field.value=''; field.placeholder = discogsConnected ? '•••••••• · збережено у профілі' : 'Discogs Personal Access Token'; }
  };
  App.verifyAndSaveDiscogsToken = async function() {
    const input = document.getElementById('discogsTokenInput'), token = input?.value.trim();
    if (!token) return;
    const status = document.getElementById('discogsTokenStatus');
    try { const user=await DiscogsClient.checkIdentity(token); if (input) input.value=''; if(status) status.textContent='✓ @'+user.username; this.updateDiscogsUIStatus(); }
    catch(err) { if(status) status.textContent=err.message; }
  };
  App.verifyAndSaveSpotifyToken = async function() {
    const input = document.getElementById('spotifyTokenInput'), token=input?.value.trim(); if(!token) return;
    const status=document.getElementById('spotifyTokenStatus');
    try { const user=await SpotifyClient.checkIdentity(token); if(input) input.value=''; if(status) status.textContent='✓ '+(user.display_name || user.id); this.updateSpotifyUIStatus(); }
    catch(err) { if(status) status.textContent=err.message; }
  };
  App.logoutDiscogs = async function() {
    try { await EchoVinyl.json('discogs/connection',{method:'DELETE'}); DiscogsClient.setToken(''); DiscogsClient.setUser(null); this.updateDiscogsUIStatus(); }
    catch(err) { alert(err.message); }
  };
  App.logoutSpotify = async function() {
    try { await EchoVinyl.json('spotify/connection',{method:'DELETE'}); SpotifyClient.setToken(''); SpotifyClient.setUser(null); this.updateSpotifyUIStatus(); }
    catch(err) { alert(err.message); }
  };
  let oauthWindow=null;
  App.loginWithDiscogsOAuth = async function() {
    oauthWindow=window.open('about:blank','echo-vinyl-discogs','popup,width=650,height=740');
    try {
      const consumerKey=document.getElementById('discogsConsumerKey')?.value.trim(), consumerSecret=document.getElementById('discogsConsumerSecret')?.value.trim();
      if (consumerKey && consumerSecret) await EchoVinyl.json('discogs/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({consumerKey,consumerSecret})});
      if(oauthWindow) oauthWindow.location='/api/vinyl/legacy/discogs/auth/login'; else throw new Error('Дозвольте спливаюче вікно для входу.');
    } catch(err) { oauthWindow?.close(); alert(err.message); }
  };
  App.loginWithSpotifyOAuth = async function() {
    oauthWindow=window.open('about:blank','echo-vinyl-spotify','popup,width=650,height=740');
    try {
      const id=document.getElementById('spotifyClientIdInput')?.value.trim(), secret=document.getElementById('spotifyClientSecretInput')?.value.trim();
      if (id && secret && secret!=='••••••••') await SpotifyClient.saveCredentials(id,secret);
      if(oauthWindow) oauthWindow.location='/api/vinyl/legacy/spotify/auth/login'; else throw new Error('Дозвольте спливаюче вікно для входу.');
    } catch(err) { oauthWindow?.close(); alert(err.message); }
  };
  window.addEventListener('message',async event => {
    if(event.origin!==location.origin || event.source!==oauthWindow) return;
    if(event.data?.type==='echo-vinyl-discogs-connected') { await DiscogsClient.checkIdentity(tokenMarker); App.updateDiscogsUIStatus(); oauthWindow?.close(); }
    if(event.data?.type==='echo-vinyl-spotify-connected') { await SpotifyClient.checkIdentity(tokenMarker); App.updateSpotifyUIStatus(); oauthWindow?.close(); }
  });
  App.saveFirebaseConfig = async function() {
    try { const config=JSON.parse(document.getElementById('firebaseConfigJson')?.value || '{}'); if(!config.projectId || !config.apiKey) throw new Error('Firebase: вкажіть конфігурацію старої бази.'); FirebaseSync.setConfig(config); await EchoVinyl.importFirebase(config); document.getElementById('firebaseSettingsModal')?.classList.remove('open'); }
    catch(err) { alert(err.message); }
  };
  App.forceCloudSync = async function() { for(const mode of ['albums','releases','spotify']) if(!(await FirebaseSync.syncModeTables(mode,this.tables[mode] || []))) return; EchoVinyl.notify('saved'); };
  const plural=(n,one,few,many)=>n%100>=11&&n%100<=19?many:n%10===1?one:n%10>=2&&n%10<=4?few:many;
  const originalWord=App.formatRecordsWord.bind(App);
  App.formatRecordsWord=function(n) {
    if(EchoVinyl.locale==='ru') return originalWord(n);
    if(EchoVinyl.locale==='en') return this.appMode==='spotify'?(n===1?'song':'songs'):this.appMode==='albums'?(n===1?'album':'albums'):(n===1?'record':'records');
    return this.appMode==='spotify'?plural(n,'пісня','пісні','пісень'):this.appMode==='albums'?plural(n,'альбом','альбоми','альбомів'):plural(n,'платівка','платівки','платівок');
  };
  const originalVersions=App.formatVinylVersions.bind(App);
  App.formatVinylVersions=function(count) {
    if(count===null || count===undefined || !Number.isFinite(Number(count))) return '—';
    const n=Number(count);
    if(EchoVinyl.locale==='ru') return originalVersions(n);
    return EchoVinyl.locale==='en'?`${n} vinyl ${n===1?'pressing':'pressings'}`:`${n} ${plural(n,'вінілове видання','вінілові видання','вінілових видань')}`;
  };
  const originalCloudStatus=App.renderCloudStatus.bind(App);
  App.renderCloudStatus=function(info) {
    originalCloudStatus(info);
    const error=info?.status==='error';
    const pill=document.getElementById('syncPillText'); if(pill) pill.textContent=EchoVinyl.tr(error?'error':'cloud');
    const modal=document.getElementById('modalFirebaseStatusText'); if(modal) modal.textContent=EchoVinyl.tr(error?'error':'cloud');
    const service=document.getElementById('settingsFirebaseStatus'); if(service) service.textContent=EchoVinyl.tr('cloud');
  };
})();

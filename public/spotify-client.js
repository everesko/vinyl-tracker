/**
 * SpotifyClient — Client-side Spotify API Integration
 * Handles track searching, user authentication, and playlist export
 */

const SpotifyClient = {
  TOKEN_KEY: 'spotify_user_token',
  USER_KEY: 'spotify_user_data',
  CLIENT_ID_KEY: 'spotify_client_id',
  CLIENT_SECRET_KEY: 'spotify_client_secret',

  getClientId() {
    return localStorage.getItem(this.CLIENT_ID_KEY) || '';
  },

  setClientId(id) {
    if (id) {
      localStorage.setItem(this.CLIENT_ID_KEY, id.trim());
    } else {
      localStorage.removeItem(this.CLIENT_ID_KEY);
    }
  },

  getClientSecret() {
    return localStorage.getItem(this.CLIENT_SECRET_KEY) || '';
  },

  setClientSecret(secret) {
    if (secret) {
      localStorage.setItem(this.CLIENT_SECRET_KEY, secret.trim());
    } else {
      localStorage.removeItem(this.CLIENT_SECRET_KEY);
    }
  },

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY) || '';
  },

  setToken(token) {
    if (token) {
      localStorage.setItem(this.TOKEN_KEY, token.trim());
    } else {
      localStorage.removeItem(this.TOKEN_KEY);
    }
  },

  getUser() {
    try {
      const raw = localStorage.getItem(this.USER_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}

    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    if (clientId && clientSecret) {
      return {
        id: clientId.substring(0, 8),
        display_name: `Ключ API (${clientId.substring(0, 6)}...)`,
        isApiKey: true
      };
    }
    return null;
  },

  setUser(user) {
    if (user) {
      localStorage.setItem(this.USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(this.USER_KEY);
    }
  },

  isAuthenticated() {
    const token = this.getToken();
    const hasKeys = Boolean(this.getClientId() && this.getClientSecret());
    return Boolean((token && token.length > 5) || hasKeys);
  },

  /**
   * Search songs/tracks via server proxy
   */
  async searchTracks(query, limit = 20) {
    const token = this.getToken();
    const headers = {};
    if (token) {
      headers['x-spotify-token'] = token;
    }

    const res = await fetch(`/api/spotify/search?type=track&q=${encodeURIComponent(query)}&limit=${limit}`, {
      headers
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Ошибка поиска Spotify (${res.status})`);
    }

    return await res.json();
  },

  /**
   * Search albums via server proxy
   */
  async searchAlbums(query, limit = 20) {
    const token = this.getToken();
    const headers = {};
    if (token) {
      headers['x-spotify-token'] = token;
    }

    const res = await fetch(`/api/spotify/search?type=album&q=${encodeURIComponent(query)}&limit=${limit}`, {
      headers
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Ошибка поиска альбомов Spotify (${res.status})`);
    }

    return await res.json();
  },

  /**
   * Check user identity via /api/spotify/me
   */
  async checkIdentity(token) {
    const t = token || this.getToken();
    if (!t) throw new Error('Токен Spotify не указан');

    const res = await fetch('/api/spotify/me', {
      headers: {
        'x-spotify-token': t
      }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Не удалось проверить аккаунт Spotify (${res.status})`);
    }

    const user = await res.json();
    return user;
  },

  /**
   * Create a playlist and add track URIs to user's Spotify account
   */
  async createPlaylistAndAddTracks(playlistName, trackUris, isPublic = true) {
    const token = this.getToken();
    if (!token) {
      throw new Error('Для переноса треков в Spotify необходимо войти в аккаунт.');
    }

    const res = await fetch('/api/spotify/user/playlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-spotify-token': token
      },
      body: JSON.stringify({
        name: playlistName || 'Vinyl Hunter Tracks',
        trackUris: trackUris,
        isPublic: isPublic !== false
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Ошибка создания плейлиста в Spotify');
    }

    return data;
  },

  /**
   * Saves and verifies Spotify Developer Credentials (Client ID & Secret) on server and locally
   */
  async saveCredentials(clientId, clientSecret) {
    this.setClientId(clientId);
    this.setClientSecret(clientSecret);

    const res = await fetch('/api/spotify/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Ошибка сохранения ключей (${res.status})`);
    }
    return data;
  },

  /**
   * Parses OAuth callback token if present in URL hash (#access_token=...) or query param
   */
  handleHashCallback() {
    let token = null;
    if (window.location.hash && window.location.hash.includes('access_token')) {
      const params = new URLSearchParams(window.location.hash.substring(1));
      token = params.get('access_token');
    }
    if (!token && window.location.search && window.location.search.includes('spotify_token')) {
      const params = new URLSearchParams(window.location.search);
      token = params.get('spotify_token');
    }
    if (token) {
      this.setToken(token);
      window.history.replaceState({}, document.title, window.location.pathname);
      return token;
    }
    return null;
  }
};

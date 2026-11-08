const CLIENT_ID = '51b16d2b9dbf4a6b9f1bbf5e313a826e';
// Адрес сайта без параметров. Должен совпадать с Redirect URI в Spotify Dashboard.
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = 'user-library-read playlist-modify-private user-modify-playback-state user-read-playback-state';

const $ = id => document.getElementById(id);
const setStatus = t => { $('status').textContent = t; };

function randomString(len) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, b => ('0' + b.toString(16)).slice(-2)).join('').slice(0, len);
}
function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function challengeFrom(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

async function login() {
  const verifier = randomString(64);
  localStorage.setItem('pkce_verifier', verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: await challengeFrom(verifier),
    scope: SCOPES
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
}

function saveTokens(d) {
  localStorage.setItem('access_token', d.access_token);
  if (d.refresh_token) localStorage.setItem('refresh_token', d.refresh_token);
  localStorage.setItem('expires_at', String(Date.now() + d.expires_in * 1000));
}

async function exchangeCode(code) {
  const verifier = localStorage.getItem('pkce_verifier');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || 'ошибка токена');
  saveTokens(d);
  localStorage.removeItem('pkce_verifier');
}

async function refreshToken() {
  const rt = localStorage.getItem('refresh_token');
  if (!rt) return false;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: rt })
  });
  if (!r.ok) return false;
  saveTokens(await r.json());
  return true;
}

async function getToken() {
  const expires = Number(localStorage.getItem('expires_at') || 0);
  if (Date.now() > expires - 60000) {
    if (!(await refreshToken())) return null;
  }
  return localStorage.getItem('access_token');
}

async function api(path, opts = {}) {
  const t = await getToken();
  if (!t) throw new Error('нужно войти заново');
  const r = await fetch('https://api.spotify.com/v1' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }
  });
  if (r.status === 204) return null;
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + r.status));
  return data;
}

async function loadLibrary() {
  const tracks = [];
  let url = '/me/tracks?limit=50';
  while (url) {
    const d = await api(url);
    for (const it of d.items) {
      if (it.track && it.track.uri) {
        tracks.push({ uri: it.track.uri, artist: (it.track.artists[0] || {}).id || '' });
      }
    }
    url = d.next ? d.next.replace('https://api.spotify.com/v1', '') : null;
    setStatus('Загружено треков: ' + tracks.length);
  }
  return tracks;
}

// Фишер–Йейтс + исправление подряд идущих треков одного исполнителя
function shuffleTracks(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  for (let i = 1; i < a.length; i++) {
    if (a[i].artist && a[i].artist === a[i - 1].artist) {
      for (let j = i + 1; j < a.length; j++) {
        if (a[j].artist !== a[i - 1].artist) {
          [a[i], a[j]] = [a[j], a[i]];
          break;
        }
      }
    }
  }
  return a;
}

async function makeAndPlay() {
  $('go').disabled = true;
  try {
    setStatus('Загружаю библиотеку...');
    const tracks = shuffleTracks(await loadLibrary());
    if (!tracks.length) throw new Error('в библиотеке нет треков');

    setStatus('Создаю плейлист...');
    const pl = await api('/me/playlists', {
      method: 'POST',
      body: JSON.stringify({
        name: 'MyShuffle ' + new Date().toLocaleDateString('ru-RU'),
        public: false,
        description: 'Перемешано приложением'
      })
    });

    for (let i = 0; i < tracks.length; i += 100) {
      const end = Math.min(i + 100, tracks.length);
      setStatus(`Добавляю треки ${i + 1}–${end}...`);
      await api(`/playlists/${pl.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ uris: tracks.slice(i, end).map(t => t.uri) })
      });
    }

    setStatus('Запускаю...');
    await playPlaylist(pl.uri);
  } catch (e) {
    setStatus('Ошибка: ' + e.message);
  } finally {
    $('go').disabled = false;
  }
}

async function playPlaylist(uri) {
  try {
    await api('/me/player/play', {
      method: 'PUT',
      body: JSON.stringify({ context_uri: uri })
    });
    // выключаем встроенный shuffle Spotify, чтобы наш порядок не сбился
    await api('/me/player/shuffle?state=false', { method: 'PUT' }).catch(() => {});
    setStatus('Играет. Каждый трек пойдёт один раз.');
  } catch (e) {
    // Нет активного устройства: открываем плейлист через ссылку Spotify
    location.href = uri;
    setStatus('Открываю Spotify. Если музыка не началась, нажмите play.');
  }
}

async function init() {
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    history.replaceState({}, '', location.pathname);
    setStatus('Вхожу...');
    try {
      await exchangeCode(code);
    } catch (e) {
      setStatus('Ошибка входа: ' + e.message);
    }
  }
  const logged = !!(await getToken());
  $('login').onclick = login;
  $('go').onclick = makeAndPlay;
  $('go').disabled = !logged;
  if (logged) setStatus('Готово. Нажмите кнопку.');
}

init();

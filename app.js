const CLIENT_ID = '51b16d2b9dbf4a6b9f1bbf5e313a826e';
// Адрес сайта без параметров. Должен совпадать с Redirect URI в Spotify Dashboard.
const REDIRECT_URI = location.origin + location.pathname;
const SCOPES = [
  'user-library-read', 'user-follow-read', 'user-top-read',
  'playlist-read-private', 'playlist-modify-private',
  'user-modify-playback-state', 'user-read-playback-state', 'user-read-recently-played'
];

// ---------- Настройки ----------
const PLAYLIST_NAME = 'MyShuffle';  // единственный плейлист, который создаёт сайт
const CHUNK = 9900;                 // сколько песен кладётся в плейлист (лимит Spotify — 10 000)
const MIN_LIKES = 3;                // исполнитель считается любимым, если в «Понравившихся» от него столько треков
const UPDATE_EVERY_HOURS = 12;      // как часто проверять новинки исполнителей
const PAUSE_MS = 600;               // пауза между запросами, чтобы Spotify не ограничивал
const PARALLEL = 1;                 // релизы скачиваются по одному, чтобы не упираться в лимит Spotify
let pace = PAUSE_MS;                // текущая пауза: растёт, когда Spotify ограничивает, и плавно уменьшается
const MAX_CHAIN = 40;               // самая длинная цепочка песен с переходами

const $ = id => document.getElementById(id);
const setStatus = t => { $('status').textContent = t; };
const setSync = t => { $('sync').textContent = t; };
const setLinkStatus = t => { $('link-status').textContent = t; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextPath = url => url ? url.replace('https://api.spotify.com/v1', '') : null;
const trackUri = id => 'spotify:track:' + id;

// ---------- Хранилище (IndexedDB: база треков может быть большой) ----------

const DB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('myshuffle', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function get(key, def) {
    const db = await open();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result === undefined ? def : q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function set(key, val) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  return { get, set };
})();

// ---------- Вход (PKCE) ----------

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
    scope: SCOPES.join(' ')
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
}

function saveTokens(d) {
  localStorage.setItem('access_token', d.access_token);
  if (d.refresh_token) localStorage.setItem('refresh_token', d.refresh_token);
  if (d.scope) localStorage.setItem('granted_scope', d.scope);
  localStorage.setItem('expires_at', String(Date.now() + d.expires_in * 1000));
}

function hasScopes() {
  const granted = (localStorage.getItem('granted_scope') || '').split(' ');
  return SCOPES.every(s => granted.includes(s));
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

let refreshing = null;
async function refreshToken() {
  // одно обновление токена за раз, даже если запросов несколько
  if (refreshing) return refreshing;
  refreshing = (async () => {
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
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

async function getToken() {
  const expires = Number(localStorage.getItem('expires_at') || 0);
  if (Date.now() > expires - 60000) {
    if (!(await refreshToken())) return null;
  }
  return localStorage.getItem('access_token');
}

// ---------- Запросы к Spotify с паузами при ограничениях ----------

async function api(path, opts = {}, attempt = 0) {
  const t = await getToken();
  if (!t) throw new Error('нужно войти заново');
  const r = await fetch('https://api.spotify.com/v1' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }
  });
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

  if (r.status === 401 && attempt === 0) {
    localStorage.setItem('expires_at', '0');
    return api(path, opts, attempt + 1);
  }
  if (r.status === 429) {
    const reason = data && data.error && data.error.reason;
    const wait = Number(r.headers.get('Retry-After')) || 5 * (attempt + 1);
    if (reason === 'QUOTA_EXCEEDED' || wait > 900 || attempt >= 40) {
      throw new Error('Spotify временно ограничил запросы (примерно на ' + Math.max(1, Math.round(wait / 60)) + ' мин.).');
    }
    pace = Math.min(pace * 2, 10000);
    if (wait >= 10) setSync('Spotify просит подождать ' + wait + ' сек. Продолжу сам...');
    await sleep(wait * 1000 + 300);
    return api(path, opts, attempt + 1);
  }
  if (r.status >= 500 && attempt < 3) {
    await sleep(2000 * (attempt + 1));
    return api(path, opts, attempt + 1);
  }
  if (!r.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + r.status));
  pace = Math.max(PAUSE_MS, pace * 0.98);
  return data;
}

// ---------- Ключ песни: одна и та же песня на сингле и альбоме считается одной ----------

function normName(n) {
  return (n || '').toLowerCase()
    .replace(/[\(\[](feat|ft|with|prod)\.?[^\)\]]*[\)\]]/g, '')
    .replace(/[\(\[][^\)\]]*(remaster|version|edit|mono|stereo|explicit|clean)[^\)\]]*[\)\]]/g, '')
    .replace(/ - .*(remaster|version|edit|mono|stereo).*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
// «Intro», «Interlude» и т. п. есть на многих альбомах: для них ключ учитывает альбом
const GENERIC = /^(intro|outro|interlude|skit|prelude|reprise|untitled)$/;
function songKey(aid, name, albumId) {
  const n = normName(name);
  return hash(aid + '|' + (albumId && GENERIC.test(n) ? albumId + '|' : '') + n);
}
// Ключ трека: по собираемому исполнителю, если он указан в треке, иначе по первому исполнителю
function trackKey(t, aid, albumId) {
  const credited = aid && (t.artists || []).some(a => a.id === aid);
  const first = (t.artists && t.artists[0]) || {};
  return songKey(credited ? aid : (first.id || ''), t.name, albumId);
}
const isPlayable = t => t && t.id && !t.is_local && t.is_playable !== false;

// ---------- «Понравившиеся» ----------

// строка: [id трека, id исполнителя, ключ песни, имя исполнителя]
function likedRow(tr) {
  if (!isPlayable(tr) || tr.type !== 'track') return null;
  const a = (tr.artists && tr.artists[0]) || {};
  return [tr.id, a.id || '', trackKey(tr, null, tr.album && tr.album.id), a.name || ''];
}

async function loadLikedFull() {
  const list = [];
  let path = '/me/tracks?limit=50&market=from_token';
  while (path) {
    const d = await api(path);
    for (const it of d.items) { const row = likedRow(it.track); if (row) list.push(row); }
    path = nextPath(d.next);
    setSync('Читаю «Понравившиеся»: ' + list.length);
  }
  await DB.set('liked', list);
  return list;
}

// Быстрая проверка: только новые лайки сверху списка
async function refreshLikedQuick() {
  const cached = await DB.get('liked', null);
  if (!cached) return loadLikedFull();
  const known = new Set(cached.map(r => r[0]));
  const fresh = [];
  let path = '/me/tracks?limit=50&market=from_token';
  while (path) {
    const d = await api(path);
    let hitKnown = false;
    for (const it of d.items) {
      const id = it.track && it.track.id;
      if (id && known.has(id)) { hitKnown = true; break; }
      const row = likedRow(it.track);
      if (row) fresh.push(row);
    }
    path = hitKnown ? null : nextPath(d.next);
  }
  if (!fresh.length) return cached;
  const list = fresh.concat(cached);
  await DB.set('liked', list);
  return list;
}

// ---------- Переходы: песни, которые должны идти подряд ----------

// Связи хранятся по ключу песни: ключ A -> [ключ B, id A, id B, 'auto' | 'user']
let linksP = null;
function getLinks() {
  if (!linksP) {
    linksP = (async () => ({
      links: await DB.get('links', {}),
      blocked: new Set(await DB.get('links_blocked', [])) // связи, которые вы разорвали вручную
    }))();
  }
  return linksP;
}
async function saveLinks() {
  const { links, blocked } = await getLinks();
  await DB.set('links', links);
  await DB.set('links_blocked', [...blocked]);
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
function partInfo(name) {
  const m = normName(name).match(/^(.*?)[\s,:(\[\-–—]*\b(?:pt\.?|part)\s*(\d+|vi|iv|v|i{1,3})\b/);
  if (!m) return null;
  return { stem: m[1].trim(), n: /^\d+$/.test(m[2]) ? Number(m[2]) : ROMAN[m[2]] };
}
// «Pt. 1» → «Pt. 2», а Intro / Interlude / Skit переходят в следующую песню альбома
function flowsInto(a, b) {
  const pa = partInfo(a.name), pb = partInfo(b.name);
  if (pa && pb && pa.stem === pb.stem && pb.n === pa.n + 1) return true;
  return /\b(intro|interlude|prelude|skit)\b/i.test(a.name);
}
const byAlbumOrder = (a, b) => ((a.disc_number || 1) - (b.disc_number || 1)) || (a.track_number - b.track_number);

function autoLinks(albumTracks, aid, albumId, links, blocked) {
  const t = albumTracks.filter(isPlayable).sort(byAlbumOrder);
  for (let j = 0; j + 1 < t.length; j++) {
    const a = t[j], b = t[j + 1];
    if ((a.disc_number || 1) !== (b.disc_number || 1) || b.track_number !== a.track_number + 1) continue;
    if (!flowsInto(a, b)) continue;
    const ka = trackKey(a, aid, albumId);
    if (links[ka] || blocked.has(ka)) continue;
    links[ka] = [trackKey(b, aid, albumId), a.id, b.id, 'auto'];
  }
}

function linkGraph(pool, links) {
  const next = new Map(), prev = new Map();
  for (const ka of Object.keys(links)) {
    const [kb, ida, idb] = links[ka];
    const a = pool.keyToId.get(ka) || ida;
    const b = pool.keyToId.get(kb) || idb;
    if (!a || !b || a === b || next.has(a) || prev.has(b)) continue;
    next.set(a, b);
    prev.set(b, a);
  }
  return { next, prev };
}

// Вся цепочка, в которую входит песня, от первой к последней
function chainOf(id, g) {
  let head = id;
  const seen = new Set([id]);
  while (g.prev.has(head) && !seen.has(g.prev.get(head)) && seen.size < MAX_CHAIN) {
    head = g.prev.get(head);
    seen.add(head);
  }
  const chain = [head];
  const inChain = new Set(chain);
  while (g.next.has(chain[chain.length - 1]) && chain.length < MAX_CHAIN) {
    const n = g.next.get(chain[chain.length - 1]);
    if (inChain.has(n)) break;
    chain.push(n);
    inChain.add(n);
  }
  return chain;
}

// ---------- Кнопки переходов для песни, которая сейчас играет ----------

async function nowPlaying() {
  const st = await api('/me/player?market=from_token');
  const t = st && st.item;
  if (!t || t.type !== 'track' || !t.album) throw new Error('сейчас в Spotify ничего не играет');
  return t;
}

async function albumTracksOf(albumId) {
  const out = [];
  let path = `/albums/${albumId}/tracks?limit=50&market=from_token`;
  while (path) {
    const d = await api(path);
    out.push(...(d.items || []).filter(Boolean));
    path = nextPath(d.next);
  }
  return out.sort(byAlbumOrder);
}

const LINK_BUTTONS = ['link-next', 'link-prev', 'link-album', 'link-cut'];
const q = t => `«${t.name}»`;

async function linkAction(kind) {
  LINK_BUTTONS.forEach(b => { $(b).disabled = true; });
  try {
    setLinkStatus('Смотрю, что играет...');
    const t = await nowPlaying();
    const albumId = t.album.id;
    const { links, blocked } = await getLinks();
    const key = x => trackKey(x, null, albumId);

    if (kind === 'cut') {
      const k = key(t);
      let n = 0;
      for (const ka of Object.keys(links)) {
        const [kb, ida, idb] = links[ka];
        if (ka === k || kb === k || ida === t.id || idb === t.id) {
          delete links[ka];
          blocked.add(ka);
          n++;
        }
      }
      await saveLinks();
      setLinkStatus(n ? `Связи песни ${q(t)} убраны.` : `У песни ${q(t)} не было связей.`);
      return;
    }

    const list = await albumTracksOf(albumId);
    let i = list.findIndex(x => x.id === t.id);
    if (i < 0) i = list.findIndex(x => (x.disc_number || 1) === (t.disc_number || 1) && x.track_number === t.track_number);
    if (i < 0) throw new Error('не нашёл песню в её альбоме');
    const add = (a, b) => {
      const ka = key(a);
      links[ka] = [key(b), a.id, b.id, 'user'];
      blocked.delete(ka);
    };

    if (kind === 'next') {
      const b = list[i + 1];
      if (!b) throw new Error('это последняя песня альбома');
      add(list[i], b);
      await saveLinks();
      // сразу ставим следующую песню в очередь, чтобы переход прозвучал прямо сейчас
      await api('/me/player/queue?uri=' + encodeURIComponent(trackUri(b.id)), { method: 'POST' }).catch(() => {});
      setLinkStatus(`Готово: ${q(list[i])} → ${q(b)}. ${q(b)} заиграет следующей.`);
    } else if (kind === 'prev') {
      const a = list[i - 1];
      if (!a) throw new Error('это первая песня альбома');
      add(a, list[i]);
      await saveLinks();
      setLinkStatus(`Готово: ${q(a)} → ${q(list[i])}.`);
    } else if (kind === 'album') {
      for (let j = 0; j + 1 < list.length; j++) add(list[j], list[j + 1]);
      await saveLinks();
      setLinkStatus(`Альбом «${t.album.name}» теперь звучит целиком и по порядку.`);
    }
  } catch (e) {
    setLinkStatus('Не получилось: ' + e.message);
  } finally {
    LINK_BUTTONS.forEach(b => { $(b).disabled = false; });
    showStats().catch(() => {});
  }
}

// ---------- Любимые исполнители и все их песни ----------

async function getArtists(liked) {
  const score = new Map();
  const names = new Map();
  const chosen = new Set();
  const bump = (id, name, s) => {
    if (!id) return;
    score.set(id, (score.get(id) || 0) + s);
    if (name) names.set(id, name);
  };
  for (const [, aid, , aname] of liked) bump(aid, aname, 1);
  for (const [id, n] of score) if (n >= MIN_LIKES) chosen.add(id);

  try {
    let path = '/me/following?type=artist&limit=50';
    while (path) {
      const d = await api(path);
      for (const a of d.artists.items) { bump(a.id, a.name, 5); chosen.add(a.id); }
      path = nextPath(d.artists.next);
    }
  } catch (e) { console.warn('following', e); }

  for (const range of ['medium_term', 'long_term']) {
    try {
      const d = await api('/me/top/artists?limit=50&time_range=' + range);
      for (const a of d.items) { bump(a.id, a.name, 5); chosen.add(a.id); }
    } catch (e) { console.warn('top', e); }
  }
  // самые любимые исполнители собираются первыми
  return [...chosen]
    .sort((x, y) => score.get(y) - score.get(x))
    .map(id => [id, names.get(id) || '']);
}

// Альбомы и синглы исполнителя (Spotify разрешает не больше 10 за запрос).
// Они идут от новых к старым, поэтому при проверке новинок можно остановиться
// на первой странице без новых релизов.
async function artistReleases(aid, known, full) {
  const out = { album: [], single: [] };
  for (const group of ['album', 'single']) {
    let path = `/artists/${aid}/albums?include_groups=${group}&market=from_token&limit=10`;
    while (path) {
      const d = await api(path);
      const fresh = (d.items || []).filter(al => al && !known.has(al.id));
      out[group].push(...fresh);
      path = (!full && fresh.length === 0) ? null : nextPath(d.next);
      await sleep(pace);
    }
  }
  return out;
}

// Выполнить fn для каждого элемента, не больше n одновременно
async function runPool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// Все песни одного исполнителя: rows пополняется строками [id трека, ключ песни]
async function syncArtist(aid, rows, known, full, ctx = {}) {
  const keys = new Set(rows.map(r => r[1]));
  let added = 0;
  const releases = await artistReleases(aid, known, full);
  // сначала альбомы, потом синглы: так сингл, уже вошедший в альбом, можно не скачивать
  for (const group of ['album', 'single']) {
    await runPool(releases[group], PARALLEL, async al => {
      if (al.total_tracks === 1 && keys.has(songKey(aid, al.name, al.id))) {
        known.add(al.id);
        return;
      }
      const tracks = [];
      let path = `/albums/${al.id}/tracks?limit=50&market=from_token`;
      while (path) {
        const d = await api(path);
        tracks.push(...(d.items || []).filter(Boolean));
        path = nextPath(d.next);
        await sleep(pace);
      }
      for (const t of tracks) {
        if (!isPlayable(t)) continue;
        if (!(t.artists || []).some(a => a.id === aid)) continue;
        const k = trackKey(t, aid, al.id);
        if (keys.has(k)) continue;
        keys.add(k);
        rows.push([t.id, k]);
        added++;
      }
      if (ctx.links) autoLinks(tracks, aid, al.id, ctx.links, ctx.blocked);
      known.add(al.id);
      if (ctx.onRelease) await ctx.onRelease();
    });
  }
  return added;
}

let syncing = false;
async function updateCatalog() {
  if (syncing) return;
  syncing = true;
  $('sync-btn').disabled = true;
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* не поддерживается */ }
  try {
    const liked = await loadLikedFull();
    const artists = await getArtists(liked);
    await DB.set('cat_artists', artists.map(a => a[0]));

    const cat = await DB.get('cat', {});                 // id исполнителя -> [[id трека, ключ], ...]
    const known = new Set(await DB.get('cat_albums', [])); // уже разобранные релизы
    const done = new Set(await DB.get('cat_done', []));    // исполнители, собранные полностью
    const { links, blocked } = await getLinks();
    let added = 0, dirty = 0;
    const persist = async () => {
      await DB.set('cat', cat);
      await DB.set('cat_albums', [...known]);
      await DB.set('cat_done', [...done]);
      await saveLinks();
    };
    try {
      for (let i = 0; i < artists.length; i++) {
        const [aid, aname] = artists[i];
        const full = !done.has(aid);
        setSync(`${full ? 'Собираю песни' : 'Ищу новинки'}: ${aname} (${i + 1}/${artists.length}). Новых треков: ${added}`);
        const rows = cat[aid] || (cat[aid] = []);
        added += await syncArtist(aid, rows, known, full, {
          links, blocked,
          onRelease: async () => { if (++dirty >= 10) { dirty = 0; await persist(); } }
        });
        done.add(aid);
      }
      localStorage.setItem('cat_updated', String(Date.now()));
    } finally {
      await persist();
    }
    const total = Object.values(cat).reduce((s, r) => s + r.length, 0);
    setSync(`Исполнителей: ${artists.length}. Их песен в базе: ${total}. Новых за это обновление: ${added}.`);
  } catch (e) {
    setSync('Обновление прервано: ' + e.message + ' Продолжу сам через 5 минут, держите сайт открытым.');
    setTimeout(() => { if (!syncing) updateCatalog(); }, 5 * 60 * 1000);
  } finally {
    syncing = false;
    $('sync-btn').disabled = false;
    if (wakeLock) wakeLock.release().catch(() => {});
    showStats().catch(() => {});
  }
}

// Один раз пересобрать альбомы, чтобы найти в них переходы (база песен сохраняется)
async function migrate() {
  const v = await DB.get('schema', 1);
  if (v < 2) {
    await DB.set('cat_albums', []);
    await DB.set('cat_done', []);
    localStorage.removeItem('cat_updated');
    await DB.set('schema', 2);
  }
}

// ---------- Перемешивание без повторов ----------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Не ставим подряд два трека (или две связки) одного исполнителя
function spreadArtists(list, artistOf) {
  const a = [...list];
  for (let i = 1; i < a.length; i++) {
    const prev = artistOf(a[i - 1]);
    if (prev && artistOf(a[i]) === prev) {
      for (let j = i + 1; j < a.length; j++) {
        if (artistOf(a[j]) !== prev) { [a[i], a[j]] = [a[j], a[i]]; break; }
      }
    }
  }
  return a;
}

// Общий набор: «Понравившиеся» + все песни ваших исполнителей, без дублей
async function buildPool() {
  const pool = new Map(); // id трека -> id исполнителя
  const keyToId = new Map();
  for (const [id, aid, k] of await DB.get('liked', [])) {
    if (pool.has(id)) continue;
    pool.set(id, aid);
    if (!keyToId.has(k)) keyToId.set(k, id);
  }
  const cat = await DB.get('cat', {});
  const current = await DB.get('cat_artists', null);
  const allowed = current ? new Set(current) : null;
  for (const aid of Object.keys(cat)) {
    if (allowed && !allowed.has(aid)) continue;
    for (const [id, k] of cat[aid]) {
      if (pool.has(id) || keyToId.has(k)) continue;
      pool.set(id, aid);
      keyToId.set(k, id);
    }
  }
  pool.keyToId = keyToId;
  return pool;
}

// Какие треки из прошлой порции вы так и не услышали. Их вернём в начало очереди.
async function unplayedFromLastChunk(plUri) {
  const last = await DB.get('last_chunk', []);
  if (!last.length) return [];
  const index = new Map(last.map((id, i) => [id, i]));
  let pos = -1, seen = false;
  try {
    const st = await api('/me/player');
    if (st && st.context && st.context.uri === plUri && st.item && index.has(st.item.id)) {
      pos = Math.max(pos, index.get(st.item.id) - 1); // текущая песня ещё не дослушана
      seen = true;
    }
  } catch (e) { console.warn('player', e); }
  try {
    const rp = await api('/me/player/recently-played?limit=50');
    for (const it of (rp && rp.items) || []) {
      if (it.context && it.context.uri === plUri && it.track && index.has(it.track.id)) {
        pos = Math.max(pos, index.get(it.track.id));
        seen = true;
      }
    }
  } catch (e) { console.warn('recent', e); }
  // если данных о прослушивании нет, считаем порцию прослушанной: лучше пропустить, чем повторить
  return seen ? last.slice(pos + 1) : [];
}

// «Колода»: каждый трек звучит один раз, пока не прозвучит весь набор.
// Новые треки подмешиваются в ещё не сыгранную часть.
// Песни с переходами идут связкой, целиком и по порядку.
async function nextChunk(pool, unplayed) {
  const { links } = await getLinks();
  const g = linkGraph(pool, links);
  const lastSet = new Set(await DB.get('last_chunk', []));
  let deck = (await DB.get('deck', [])).filter(id => pool.has(id));
  const played = new Set(await DB.get('played', []));
  const inDeck = new Set(deck);
  const back = unplayed.filter(id => pool.has(id) && !inDeck.has(id));
  back.forEach(id => { played.delete(id); inDeck.add(id); });

  const fresh = [...pool.keys()].filter(id => !inDeck.has(id) && !played.has(id));
  if (fresh.length) deck = shuffle(deck.concat(fresh));
  deck = back.concat(deck);

  if (!deck.length) {
    const left = new Set(deck);
    deck = deck.concat(shuffle([...pool.keys()].filter(id => !left.has(id))));
    played.clear();
  }

  const units = [];
  const taken = new Set();
  let count = 0, used = 0;
  while (used < deck.length && count < CHUNK) {
    const id = deck[used++];
    if (taken.has(id)) continue;
    let unit = [id];
    if (g.next.has(id) || g.prev.has(id)) {
      const chain = chainOf(id, g);
      // остановились посреди связки в прошлый раз: уже прослушанное начало не повторяем
      let s = 0;
      while (s < chain.length - 1 && chain[s] !== id && played.has(chain[s]) && lastSet.has(chain[s])) s++;
      unit = chain.slice(s);
    }
    unit.forEach(x => taken.add(x));
    units.push(unit);
    count += unit.length;
  }
  const rest = deck.slice(used).filter(id => !taken.has(id));
  const artistOf = u => pool.get(u[0]) || pool.get(u[u.length - 1]);
  const chunk = spreadArtists(units, artistOf).flat();

  chunk.forEach(id => played.add(id));
  await DB.set('deck', rest);
  await DB.set('played', [...played]);
  await DB.set('last_chunk', chunk);
  return chunk;
}

// ---------- Один постоянный плейлист ----------

async function ensurePlaylist() {
  const savedId = localStorage.getItem('playlist_id');
  let byName = null;
  let path = '/me/playlists?limit=50';
  while (path) {
    const d = await api(path);
    for (const p of d.items) {
      if (!p) continue;
      if (p.id === savedId) return p;
      if (!byName && p.name === PLAYLIST_NAME) byName = p;
    }
    path = nextPath(d.next);
  }
  const p = byName || await api('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({
      name: PLAYLIST_NAME,
      public: false,
      description: 'Любимые треки и песни ваших исполнителей. Обновляется сайтом MyShuffle.'
    })
  });
  localStorage.setItem('playlist_id', p.id);
  return p;
}

async function fillPlaylist(pl, ids) {
  const uris = ids.map(trackUri);
  // PUT заменяет содержимое плейлиста, POST дописывает остальное
  await api(`/playlists/${pl.id}/items`, { method: 'PUT', body: JSON.stringify({ uris: uris.slice(0, 100) }) });
  for (let i = 100; i < uris.length; i += 100) {
    await api(`/playlists/${pl.id}/items`, { method: 'POST', body: JSON.stringify({ uris: uris.slice(i, i + 100) }) });
  }
}

async function makeAndPlay() {
  $('go').disabled = true;
  try {
    setStatus('Проверяю новые лайки...');
    await refreshLikedQuick();
    const pool = await buildPool();
    if (!pool.size) throw new Error('нет треков');

    setStatus('Готовлю плейлист MyShuffle...');
    const pl = await ensurePlaylist();
    const unplayed = await unplayedFromLastChunk(pl.uri);
    const chunk = await nextChunk(pool, unplayed);
    await fillPlaylist(pl, chunk);

    await playPlaylist(pl.uri);
    await showStats(pool);
  } catch (e) {
    setStatus('Ошибка: ' + e.message);
  } finally {
    $('go').disabled = false;
  }
}

// ---------- Запуск музыки на телефоне ----------

const onPhone = /Android|iPhone|iPad|Mobile|HarmonyOS|HuaweiBrowser/i.test(navigator.userAgent || '');

// С телефона музыка запускается только на телефоне, даже если активен ноутбук
async function pickDevice() {
  const d = await api('/me/player/devices');
  const list = (d && d.devices) || [];
  if (onPhone) {
    return list.find(x => x.type === 'Smartphone' && x.is_active) || list.find(x => x.type === 'Smartphone') || null;
  }
  return list.find(x => x.is_active) || list.find(x => x.type === 'Computer') || list[0] || null;
}

async function startPlayback(uri) {
  const dev = await pickDevice().catch(() => null);
  if (!dev) return false;
  const qs = 'device_id=' + encodeURIComponent(dev.id);
  const off = () => Promise.all([
    api('/me/player/shuffle?state=false&' + qs, { method: 'PUT' }).catch(() => {}),
    api('/me/player/repeat?state=off&' + qs, { method: 'PUT' }).catch(() => {})
  ]);
  await off();
  await api('/me/player/play?' + qs, {
    method: 'PUT',
    body: JSON.stringify({ context_uri: uri, offset: { position: 0 } })
  });
  await off(); // ещё раз: встроенный shuffle Spotify не должен сбить наш порядок
  return true;
}

async function playPlaylist(uri) {
  setStatus('Запускаю...');
  try {
    if (await startPlayback(uri)) { setStatus('Играет.'); return; }
  } catch (e) { console.warn('play', e); }
  // Spotify закрыт: открываем его и пробуем запустить ещё несколько раз
  setStatus('Открываю Spotify...');
  location.href = uri;
  for (let i = 0; i < 5; i++) {
    await sleep(3000);
    try {
      if (await startPlayback(uri)) { setStatus('Играет.'); return; }
    } catch (e) { console.warn('retry play', e); }
  }
  setStatus('Spotify открыт. Если музыка не началась, нажмите play и выключите shuffle.');
}

// ---------- Экран ----------

async function showStats(pool) {
  pool = pool || await buildPool();
  const left = (await DB.get('deck', [])).filter(id => pool.has(id)).length;
  const { links } = await getLinks();
  const n = Object.keys(links).length;
  $('stats').textContent = `Всего песен: ${pool.size}. Ещё не звучали в этом круге: ${left}. Переходов: ${n}.`;
}

async function init() {
  $('login').onclick = login;
  $('go').onclick = makeAndPlay;
  $('sync-btn').onclick = updateCatalog;
  $('link-next').onclick = () => linkAction('next');
  $('link-prev').onclick = () => linkAction('prev');
  $('link-album').onclick = () => linkAction('album');
  $('link-cut').onclick = () => linkAction('cut');

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
  const ready = logged && hasScopes();
  $('go').disabled = !ready;
  $('sync-btn').disabled = !ready;
  LINK_BUTTONS.forEach(b => { $(b).disabled = !ready; });
  $('login').style.display = ready ? 'none' : '';
  if (logged && !ready) {
    setStatus('Появились новые функции. Нажмите «Войти в Spotify» ещё раз.');
    return;
  }
  if (!ready) return;

  await migrate();
  setStatus('Готово. Нажмите «Перемешать и играть».');
  showStats().catch(() => {});
  const lastUpdate = Number(localStorage.getItem('cat_updated') || 0);
  if (Date.now() - lastUpdate > UPDATE_EVERY_HOURS * 3600 * 1000) {
    if (!(await DB.get('cat_done', [])).length) {
      setStatus('Собираю песни ваших исполнителей и ищу переходы. Держите сайт открытым, слушать можно уже сейчас.');
    }
    updateCatalog();
  }
}

init();

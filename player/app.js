const API = 'https://mymusic.muhammadalirahimov182.workers.dev'; // адрес Cloudflare Worker
const CACHE = 'mymusic-audio-v1';
const PREFETCH = 3; // сколько следующих песен скачивать заранее

const $ = id => document.getElementById(id);
const audio = $('audio');
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
let tracks = [];          // все песни
let byId = new Map();
let cached = new Set();   // id песен, сохранённых на устройстве
let current = null;       // id текущей песни
let hist = ls.get('hist', []); // для кнопки «назад»
let blobUrl = null;

// ---------- Сеть ----------
const key = () => ls.get('key', '');
async function apiGet(path) {
  const r = await fetch(API + path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key()));
  if (r.status === 401) throw new Error('auth');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const fileUrl = id => `${API}/api/file/${id}?key=${encodeURIComponent(key())}`;
const cacheKey = id => `https://mymusic.local/${id}`; // ключ в кэше не зависит от пароля

// ---------- Офлайн-кэш ----------
async function loadCachedSet() {
  try {
    const c = await caches.open(CACHE);
    cached = new Set((await c.keys()).map(r => r.url.split('/').pop()));
  } catch (e) { cached = new Set(); }
}
async function getAudioBlob(id) {
  const c = await caches.open(CACHE);
  let r = await c.match(cacheKey(id));
  if (!r) {
    const net = await fetch(fileUrl(id));
    if (!net.ok) throw new Error('не удалось скачать песню');
    const blob = await net.blob();
    await c.put(cacheKey(id), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } })).catch(() => {});
    cached.add(id);
    markCached(id);
    return blob;
  }
  return r.blob();
}
let prefetching = false;
async function prefetchNext() {
  if (prefetching || !navigator.onLine) return;
  prefetching = true;
  try {
    for (const id of ls.get('deck', []).slice(0, PREFETCH)) {
      if (!cached.has(id) && byId.has(id)) await getAudioBlob(id).catch(() => {});
    }
  } finally { prefetching = false; }
}

// ---------- Перемешивание без повторов ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// колода: песни, которые ещё не звучали в этом круге; новые песни подмешиваются в неё
function syncDeck() {
  let deck = ls.get('deck', []).filter(id => byId.has(id));
  const played = new Set(ls.get('played', []).filter(id => byId.has(id)));
  const inDeck = new Set(deck);
  const fresh = tracks.map(t => t.id).filter(id => !inDeck.has(id) && !played.has(id) && id !== current);
  if (fresh.length) deck = shuffle(deck.concat(fresh));
  ls.set('deck', deck);
  ls.set('played', [...played]);
}
function takeNext() {
  let deck = ls.get('deck', []).filter(id => byId.has(id));
  if (!deck.length) { // круг закончился — новый круг
    deck = shuffle(tracks.map(t => t.id).filter(id => id !== current));
    ls.set('played', []);
  }
  const id = deck.shift();
  ls.set('deck', deck);
  const played = ls.get('played', []);
  played.push(id);
  ls.set('played', played);
  return id;
}

// ---------- Плеер ----------
async function playId(id, remember = true) {
  if (!id || !byId.has(id)) return;
  if (remember && current) { hist.push(current); hist = hist.slice(-100); ls.set('hist', hist); }
  current = id;
  ls.set('current', id);
  const t = byId.get(id);
  $('title').textContent = t.title;
  $('artist').textContent = t.artist || '';
  document.title = t.title + ' — MyMusic';
  highlight();
  try {
    const blob = await getAudioBlob(id);
    if (current !== id) return;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);
    audio.src = blobUrl;
    await audio.play();
  } catch (e) {
    $('info').textContent = navigator.onLine ? 'Не получилось включить песню, пробую следующую.' : 'Нет интернета, а эта песня ещё не скачана. Включаю скачанную.';
    return next(true);
  }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: 'MyMusic' });
  }
  prefetchNext();
}
async function next(skipUncachedOffline = false) {
  if (!tracks.length) return;
  let id = takeNext();
  if (!navigator.onLine || skipUncachedOffline) {
    // без интернета выбираем ближайшую скачанную песню
    let guard = tracks.length;
    while (!cached.has(id) && guard-- > 0) id = takeNext();
    if (!cached.has(id)) { $('info').textContent = 'Нет скачанных песен для офлайна.'; return; }
  }
  playId(id);
}
function prev() {
  if (audio.currentTime > 5 || !hist.length) { audio.currentTime = 0; return; }
  const id = hist.pop();
  ls.set('hist', hist);
  // вернуть текущую песню в начало колоды, чтобы она не потерялась
  if (current) ls.set('deck', [current].concat(ls.get('deck', [])));
  playId(id, false);
}

audio.addEventListener('ended', () => next());
audio.addEventListener('play', () => { $('play').textContent = '⏸'; });
audio.addEventListener('pause', () => { $('play').textContent = '▶'; });
audio.addEventListener('timeupdate', () => {
  if (audio.duration) $('bar').value = Math.round(audio.currentTime / audio.duration * 1000);
});
$('bar').addEventListener('input', () => { if (audio.duration) audio.currentTime = $('bar').value / 1000 * audio.duration; });
$('play').onclick = () => {
  if (!audio.src) return current ? playId(current, false) : next();
  audio.paused ? audio.play() : audio.pause();
};
$('next').onclick = () => next();
$('prev').onclick = prev;
$('reshuffle').onclick = () => { ls.set('deck', shuffle(tracks.map(t => t.id))); ls.set('played', []); next(); };
$('refresh').onclick = () => loadTracks();
$('search').oninput = render;

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

// скачать всё на устройство
$('dl').onclick = async () => {
  const todo = tracks.filter(t => !cached.has(t.id));
  let n = 0;
  for (const t of todo) {
    $('info').textContent = `Скачиваю на устройство: ${++n} из ${todo.length}...`;
    try { await getAudioBlob(t.id); } catch (e) { if (!navigator.onLine) break; }
  }
  updateInfo();
};

// загрузить песни с устройства
$('up').onclick = () => $('upfile').click();
$('upfile').onchange = async () => {
  const files = [...$('upfile').files];
  $('upfile').value = '';
  let ok = 0, skip = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size > 20 * 1024 * 1024) { skip.push(f.name + ' (больше 20 МБ)'); continue; }
    $('info').textContent = `Загружаю ${i + 1} из ${files.length}: ${f.name}`;
    try {
      const fd = new FormData();
      fd.append('file', f, f.name);
      const r = await fetch(`${API}/api/upload?key=${encodeURIComponent(key())}`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      ok++;
    } catch (e) { skip.push(f.name + ' (' + e.message + ')'); }
  }
  await loadTracks();
  $('info').textContent = `Загружено: ${ok}.` + (skip.length ? ' Не загружены: ' + skip.join('; ') : '');
};

// ---------- Список ----------
function markCached(id) { const el = document.querySelector(`li[data-id="${id}"] .d`); if (el) el.textContent = '●'; updateInfo(); }
function highlight() { document.querySelectorAll('li.cur').forEach(e => e.classList.remove('cur')); const el = document.querySelector(`li[data-id="${current}"]`); if (el) el.classList.add('cur'); }
function updateInfo() { $('info').textContent = `Песен: ${tracks.length}. На устройстве: ${[...cached].filter(id => byId.has(id)).length}. Новые песни отправляйте боту в Telegram.`; }
function render() {
  const q = $('search').value.trim().toLowerCase();
  const list = tracks.filter(t => !q || (t.title + ' ' + t.artist).toLowerCase().includes(q))
    .sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title));
  $('list').innerHTML = '';
  for (const t of list) {
    const li = document.createElement('li');
    li.dataset.id = t.id;
    li.innerHTML = '<span class="d"></span><span class="t"></span>';
    li.querySelector('.d').textContent = cached.has(t.id) ? '●' : '';
    li.querySelector('.t').textContent = t.title;
    if (t.artist) { const a = document.createElement('div'); a.className = 'a'; a.textContent = t.artist; li.querySelector('.t').appendChild(a); }
    li.onclick = () => playId(t.id);
    $('list').appendChild(li);
  }
  highlight();
}
async function loadTracks() {
  try {
    tracks = await apiGet('/api/tracks');
    ls.set('tracks', tracks); // для офлайна
  } catch (e) {
    if (e.message === 'auth') return showLogin('Неверный пароль');
    tracks = ls.get('tracks', []);
  }
  byId = new Map(tracks.map(t => [t.id, t]));
  await loadCachedSet();
  syncDeck();
  render();
  updateInfo();
}

// ---------- Вход ----------
function showLogin(err) {
  $('app').style.display = 'none';
  $('login').style.display = 'block';
  $('login-err').textContent = err || '';
}
$('pwd-ok').onclick = async () => {
  ls.set('key', $('pwd').value);
  $('login').style.display = 'none';
  $('app').style.display = 'block';
  await loadTracks();
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!key()) showLogin();
else {
  $('app').style.display = 'block';
  current = ls.get('current', null);
  loadTracks().then(() => {
    if (current && byId.has(current)) { $('title').textContent = byId.get(current).title; $('artist').textContent = byId.get(current).artist || ''; }
  });
}

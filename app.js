'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => 'i' + Math.random().toString(36).slice(2, 10);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

const ROOM = new URLSearchParams(location.search).get('room'); // スマホで開いたときのルームコード
const IS_PHONE = !!ROOM;
const IS_PREVIEW = IS_PHONE && new URLSearchParams(location.search).has('local') && window.parent !== window; // GM画面に埋め込んだスマホ画面のプレビュー
const IS_PLAYER = location.hash === '#player' || IS_PHONE; // 見るだけの画面（別ウィンドウ・スマホ）
const APP_VER = 50; // 画面を作り替えたら上げる。古いままのプレイヤー画面を自動で読み直させるため
const CELL = 50; // 前景1マスの論理サイズ(px)
const CHAT_TABS = [['main', 'メイン'], ['info', '情報'], ['chat', '雑談'], ['secret', '秘話']];
const LEFT_TABS = [['chars', 'コマ'], ['scenes', 'シーン'], ['board', '盤面'], ['bgm', 'BGM']];
const DICE = ['1d100', '1d3', '1d4', '1d6', '1d8', '1d10', '1d20', '2d6', '3d6'];

const defaultState = () => ({
  room: '新しいルーム',
  chars: [],
  markers: [],
  fg: { img: null, cols: 20, rows: 12, grid: true },
  bg: { img: null },
  bgm: { id: null, volume: 0.5, loop: true, playing: false },
  scenes: [],
  sceneId: null,
  chat: [],
  memo: { pub: '', gm: '' },
  assets: [],
  turn: { id: null, round: 1 },
  view: { chat: true, init: true, memo: false, ptab: 'main', snap: true, msgwin: true, diceSe: true, zoom: 1, panX: 0, panY: 0 }, // zoom 1 = 全体表示、pan はマス単位
});

let state = defaultState();
const ui = { ltab: 'chars', tab: 'main', dice: [], pick: null };
const blobs = new Map(); // assetId -> Blob
const urls = new Map();  // assetId -> objectURL
let scale = 1;
let lay = { l: 24, aw: 1, ah: 1, W: 1, H: 1, bw: 1 }; // 直近の盤面レイアウト
const ZOOM_MIN = 0.25, ZOOM_MAX = 4;

/* ---------- 保存（IndexedDB） ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('coc-session-board', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('assets'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      if (!this.db) return res(undefined);
      const t = this.db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error);
    });
  },
  async get(store, key) { const r = await this.tx(store, 'readonly', o => o.get(key)); return r && r.result; },
  put(store, key, val) { return this.tx(store, 'readwrite', o => { o.put(val, key); }); },
  del(store, key) { return this.tx(store, 'readwrite', o => { o.delete(key); }); },
  clear(store) { return this.tx(store, 'readwrite', o => { o.clear(); }); },
  async all(store) {
    const r = await this.tx(store, 'readonly', o => [o.getAllKeys(), o.getAll()]);
    return r ? r[0].result.map((k, i) => [k, r[1].result[i]]) : [];
  },
};

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    DB.put('kv', 'state', state)
      .then(() => { $('#saveStatus').textContent = DB.db ? '自動保存済み' : '保存できません（このブラウザでは一時利用のみ）'; })
      .catch(() => { $('#saveStatus').textContent = '保存に失敗しました'; });
  }, 300);
}

/* ---------- 画像・音源 ---------- */
const needed = new Set();
function assetUrl(id) {
  if (!id) return '';
  if (!urls.has(id)) {
    if (blobs.has(id)) urls.set(id, URL.createObjectURL(blobs.get(id)));
    else if (IS_PLAYER && !needed.has(id)) { needed.add(id); toGM({ type: 'need', id }); }
  }
  return urls.get(id) || '';
}
const asset = id => state.assets.find(a => a.id === id);
const images = () => state.assets.filter(a => a.kind === 'image');
const audios = () => state.assets.filter(a => a.kind === 'audio');

function addAsset(file, kind) {
  const id = uid();
  blobs.set(id, file);
  state.assets.push({ id, name: (file.name || (kind === 'image' ? '画像' : '音源')).replace(/\.[^.]+$/, ''), kind });
  DB.put('assets', id, file).catch(() => toast('保存に失敗しました（容量不足の可能性があります）'));
  return id;
}
function removeAsset(id) {
  state.assets = state.assets.filter(a => a.id !== id);
  blobs.delete(id);
  if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
  DB.del('assets', id);
  const strip = o => { if (o.fg.img === id) o.fg.img = null; if (o.bg.img === id) o.bg.img = null; if (o.bgm.id === id) o.bgm.id = null; o.markers.forEach(m => { if (m.img === id) m.img = null; }); };
  strip(state); state.scenes.forEach(strip);
  state.chars.forEach(c => { if (c.img === id) c.img = null; });
  applyBgm();
}
function addFiles(files) {
  const added = { image: [], audio: [] };
  for (const f of files) {
    const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audio' : null;
    if (kind) added[kind].push(addAsset(f, kind));
  }
  return added;
}
const imageSize = id => new Promise(res => {
  const im = new Image();
  im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
  im.onerror = () => res({ w: 1, h: 1 });
  im.src = assetUrl(id);
});

/* ---------- プレイヤー画面との同期 ---------- */
let playerWin = null;
const ORIGIN = location.protocol === 'file:' ? '*' : location.origin;
const HOST = IS_PHONE ? null : window.opener || (window.parent !== window ? window.parent : null); // GM画面（別ウィンドウ、または埋め込み元）
const playerUrl = () => location.href.split(/[?#]/)[0] + '?v=' + APP_VER + '#player';
const reloaded = new WeakSet();
const phones = new Map(); // GM側：つながっているスマホ（接続 → { name }）
let gmConn = null;        // スマホ側：GM画面との接続

function toWindow(msg) { if (playerWin && !playerWin.closed) playerWin.postMessage({ coc: 1, ...msg }, ORIGIN); }
function toPhones(msg) { phones.forEach((_, conn) => { if (conn.open) conn.send({ coc: 1, ...msg }); }); }
function toPlayer(msg) { toWindow(msg); toPhones(msg); }
function toGM(msg) {
  const m = { coc: 1, ver: APP_VER, bw: lay.bw, ...msg };
  if (IS_PHONE) { if (gmConn && gmConn.open) gmConn.send(m); } else if (HOST) HOST.postMessage(m, ORIGIN);
}

// プレイヤー画面へ渡すのは公開情報だけ
function publicState() {
  const s = state;
  const chars = s.chars.filter(c => !c.hidden).map(c => ({
    id: c.id, name: c.name, img: c.img, init: c.init, size: c.size, x: c.x, y: c.y, onBoard: c.onBoard,
    status: c.secretStatus ? null : c.status,
  }));
  return {
    room: s.room,
    chars,
    markers: s.markers.filter(m => !m.hidden),
    fg: s.fg, bg: s.bg,
    chat: s.view.chat ? s.chat.filter(m => m.tab !== 'secret' && !m.gm).slice(-200) : [],
    memo: { pub: s.view.memo ? s.memo.pub : '' },
    turn: { id: chars.some(c => c.id === s.turn.id) ? s.turn.id : null, round: s.turn.round },
    view: s.view,
    msgwin: s.view.msgwin ? latestMsg() : null,
  };
}
function syncPlayer() { toWindow({ type: 'state', state: publicState() }); syncPhones(); }

// スマホへは回線を考えて少し間引いて送る。秘話は、そのスマホが名乗っているコマ宛てのものだけ
let phoneTimer = 0;
function syncPhones() {
  if (!phones.size || phoneTimer) return;
  phoneTimer = setTimeout(() => {
    phoneTimer = 0;
    const pub = publicState();
    phones.forEach((info, conn) => {
      if (!conn.open) return;
      const whispers = info.name ? state.chat.filter(m => m.tab === 'secret' && (m.to === info.name || m.from === info.name)).slice(-100) : [];
      const me = info.name && state.chars.find(c => c.name === info.name); // 探索者シートは本人のスマホにだけ送る
      conn.send(clone({ coc: 1, type: 'state', state: { ...pub, whispers, sheet: (me && me.sheet) || null } }));
    });
  }, 200);
}

// プレイヤー側（別ウィンドウ・スマホ共通）：GM画面から届いた内容を反映する
function onPlayerMsg(d) {
  if (d.type === 'state') { state = d.state; renderBoard(); renderPlayer(); }
  if (d.type === 'dice' && d.anim) playDice(d.anim);
  if (d.type === 'toast') toast(String(d.text || ''));
  if (d.type === 'asset') { urls.set(d.id, URL.createObjectURL(d.blob || new Blob([d.buf], { type: d.mime }))); renderBoard(); renderPlayer(); }
  if (d.type === 'reload') { // GM画面のほうが新しい版
    try { if (sessionStorage.getItem('coc-sb-reloaded') === String(d.ver)) return; sessionStorage.setItem('coc-sb-reloaded', String(d.ver)); } catch { return; }
    location.reload();
  }
}

window.addEventListener('message', e => {
  const d = e.data;
  if (!d || d.coc !== 1) return;
  if (ORIGIN !== '*' && e.origin !== location.origin) return;
  if (IS_PHONE) { if (IS_PREVIEW && e.source === window.parent) onPlayerMsg(d); return; }
  if (preview.conn && e.source === preview.win) return onPhoneData(preview.conn, d);
  if (IS_PLAYER) {
    if (e.source === HOST) onPlayerMsg(d);
  } else {
    if (d.ver !== APP_VER) { // 古い版のまま開きっぱなしのプレイヤー画面
      if (reloaded.has(e.source)) return;
      reloaded.add(e.source);
      try { e.source.location.replace(playerUrl()); } catch { toast('プレイヤー画面が古いままです。閉じて開き直してください'); }
      return;
    }
    if (d.type === 'hello' || (d.type === 'ping' && e.source !== playerWin)) { playerWin = e.source; syncPlayer(); }
    if (e.source === playerWin && d.bw > 1 && d.bw !== playerBw) { playerBw = d.bw; renderBoard(); }
    if (d.type === 'need' && e.source === playerWin && blobs.has(d.id)) toWindow({ type: 'asset', id: d.id, blob: blobs.get(d.id) });
  }
});

/* ---------- スマホとの接続（WebRTC。PeerJS の公開サーバーで相手を見つけ、以降は直接やりとりする） ---------- */
const LIBS = {
  peer: { src: 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js', sri: 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR' },
  qr: { src: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js', sri: 'sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1' },
};
// 使うときだけ読み込む（スマホ機能を使わなければ、オフラインでもこれまでどおり動く）
const loadLib = key => LIBS[key].p || (LIBS[key].p = new Promise((res, rej) => {
  const s = Object.assign(document.createElement('script'), { src: LIBS[key].src, integrity: LIBS[key].sri, crossOrigin: 'anonymous' });
  s.onload = res;
  s.onerror = () => { LIBS[key].p = null; s.remove(); rej(new Error('load')); };
  document.head.append(s);
}));
const peerId = code => 'coc-session-board-' + code;
const phoneUrl = () => location.href.split(/[?#]/)[0] + '?room=' + state.roomCode;
const host = { peer: null, status: '', retry: 0 };

// スマホ画面のプレビュー：GM画面の中にスマホ画面を埋め込み、ネットを使わずに本物のスマホと同じ内容を送る
const preview = { conn: null, win: null, info: null };
function openPhonePreview() {
  closePhonePreview();
  const box = $('#phonePreview'), frame = $('iframe', box);
  box.hidden = false;
  frame.src = location.href.split(/[?#]/)[0] + '?room=preview&local=1&v=' + APP_VER;
  preview.win = frame.contentWindow;
  preview.conn = { open: true, send: m => preview.win.postMessage(m, ORIGIN) };
  preview.info = { name: '', preview: true };
  phones.set(preview.conn, preview.info);
}
function closePhonePreview() {
  if (preview.conn) phones.delete(preview.conn);
  preview.conn = preview.win = preview.info = null;
  const box = $('#phonePreview');
  box.hidden = true;
  $('iframe', box).src = 'about:blank';
}

function startPhoneHost() {
  if (host.peer || !state.view.phone) return;
  if (!state.roomCode) { state.roomCode = Array.from({ length: 8 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join(''); save(); }
  host.status = '準備中…';
  renderPhoneStatus();
  loadLib('peer').then(() => {
    if (host.peer || !state.view.phone) return;
    const peer = host.peer = new Peer(peerId(state.roomCode));
    peer.on('open', () => { host.status = ''; renderPhoneStatus(); });
    peer.on('connection', conn => {
      phones.set(conn, { name: '' });
      const drop = () => { phones.delete(conn); renderPhoneStatus(); };
      conn.on('open', renderPhoneStatus);
      conn.on('close', drop);
      conn.on('error', drop);
      conn.on('data', d => onPhoneData(conn, d));
    });
    peer.on('disconnected', () => { host.status = '再接続中…'; renderPhoneStatus(); setTimeout(() => { if (host.peer === peer && !peer.destroyed) peer.reconnect(); }, 2000); });
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') return;
      // 再読み込み直後は前の接続が残っていて同じルームコードを使えないことがあるので、少し待ってやり直す
      host.status = err.type === 'unavailable-id' ? '準備中…（前の接続が切れるのを待っています）' : '接続サーバーにつながりません。ネット接続を確認してください';
      renderPhoneStatus();
      if (host.peer === peer && (err.type === 'unavailable-id' || peer.destroyed)) { stopPhoneHost(true); host.retry = setTimeout(startPhoneHost, 4000); }
    });
  }, () => { host.status = '必要な部品を読み込めません。ネット接続を確認してください'; renderPhoneStatus(); });
}
function stopPhoneHost(keepStatus) {
  clearTimeout(host.retry);
  if (host.peer) { const p = host.peer; host.peer = null; p.destroy(); }
  phones.clear();
  if (preview.conn) phones.set(preview.conn, preview.info); // プレビューはつないだままにする
  if (!keepStatus) host.status = '';
  renderPhoneStatus();
}
function onPhoneData(conn, d) {
  const info = phones.get(conn);
  if (!info || !d || d.coc !== 1) return;
  if (d.ver !== APP_VER) return conn.send({ coc: 1, type: 'reload', ver: APP_VER });
  if (d.type === 'hello') { info.name = String(d.name || '').slice(0, 80); renderPhoneStatus(); syncPhones(); }
  if (d.type === 'need') sendPhoneImage(conn, d.id);
  if (d.type === 'roll') { // スマホからのダイスは全員に見える形（メインタブ）で振る
    const expr = String(d.expr || '').trim().slice(0, 100), now = Date.now();
    if (!expr || now - (info.lastRoll || 0) < 1500) return;
    info.lastRoll = now;
    phoneRoll(conn, info, expr);
  }
  if (d.type === 'chat') { // スマホからの書き込みは雑談タブにだけ入る
    const text = String(d.text || '').trim().slice(0, 500), now = Date.now();
    const secret = d.tab === 'secret'; // 秘話はGM宛て。コマを選んでいないスマホからは受け付けない
    if (!text || now - (info.last || 0) < 700 || (secret && !info.name)) return;
    info.last = now;
    pushMsg(secret ? 'secret' : 'chat', info.name || 'プレイヤー', text, secret ? { to: 'GM' } : {});
    if (secret && ui.tab !== 'secret') toast(`${info.name} から秘話が届きました`);
    commit();
  }
}
async function phoneRoll(conn, info, expr) {
  const r = await rollAny(expr);
  if (!r) { if (conn.open) conn.send({ coc: 1, type: 'toast', text: 'ダイス式を読み取れませんでした（例: 2d6+3）' }); return; }
  const from = info.name || 'プレイヤー', text = `${from}：${r.text}`;
  playDice({ ...r, text });
  toPlayer({ type: 'dice', anim: { text, cls: r.cls, rands: r.rands } });
  await new Promise(res => setTimeout(res, DICE_MS + 300)); // 転がる演出が終わってから発言にする
  pushMsg('main', from, text);
  commit();
}
// スマホには画像だけを、通信量を抑えるため縮小して送る（音源は送らない）
const phoneImages = new Map();
function phoneImage(id) {
  if (!phoneImages.has(id)) phoneImages.set(id, (async () => {
    const src = blobs.get(id);
    try {
      const bmp = await createImageBitmap(src), k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
      const cv = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      const out = await new Promise(res => cv.toBlob(res, 'image/webp', 0.82));
      return out && out.size < src.size ? out : src;
    } catch { return src; }
  })());
  return phoneImages.get(id);
}
async function sendPhoneImage(conn, id) {
  const a = asset(id);
  if (!a || a.kind !== 'image' || !blobs.has(id)) return;
  const blob = await phoneImage(id), buf = await blob.arrayBuffer();
  if (conn.open) conn.send({ coc: 1, type: 'asset', id, mime: blob.type, buf });
}
function renderPhoneStatus() {
  const n = [...phones].filter(([c, i]) => c.open && !i.preview).length, btn = $('#phoneBtn');
  if (btn) { btn.textContent = state.view.phone ? `スマホ ${n}台` : 'スマホ'; btn.classList.toggle('on', !!state.view.phone); }
  if ($('#dlg').open && $('#dlg')._build === phoneDlgHTML) refreshDlg();
}
function phoneDlgHTML() {
  const on = !!state.view.phone, local = location.protocol === 'file:' || /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const list = [...phones].filter(([c, i]) => c.open && !i.preview).map(([, i]) => i.name || '（コマ未選択）');
  return `${dlgHead('スマホでの表示')}
    <div class="dlg-body">
      <div class="hint">プレイヤーが自分のスマホで、マップ・コマのステータス・チャット・自分宛ての秘話を見られます（見るだけで、操作はできません）。GM画面とスマホの両方にネット接続が必要です。</div>
      <div class="row"><button class="btn" data-act="phonePreview">スマホ画面をプレビュー</button><span class="hint">公開やネット接続なしで、スマホでの見え方をこの画面の中で確認できます</span></div>
      ${chk('view.phone', 'スマホからの接続を受け付ける', on)}
      ${!on ? '' : `
        ${local ? '<div class="warn">このGM画面はパソコンの中のファイル（またはlocalhost）で開いているため、スマホからは開けません。GitHub Pages などに公開したURLでGM画面を開き直してください。</div>' : ''}
        <div class="phone-join">
          <div class="qr">${ui.qr && ui.qr.url === phoneUrl() ? ui.qr.img : ''}</div>
          <div class="col">
            <div>スマホのカメラでQRコードを読み取るか、下のURLを開いてもらってください。</div>
            <input type="text" readonly value="${esc(phoneUrl())}" onfocus="this.select()" aria-label="スマホ用URL">
            <div class="row"><button class="btn" data-act="copyPhoneUrl">URLをコピー</button><button class="btn" data-act="newRoomCode" title="URLを作り直します。今のURLとQRコードは使えなくなります">URLを作り直す</button></div>
          </div>
        </div>
        <div class="turnbar">${host.status ? esc(host.status) : list.length ? `接続中：${list.map(esc).join('、')}` : '接続待ち（まだ誰もつながっていません）'}</div>
        <div class="hint">秘話は、スマホ側で選んだコマ宛てのものがそのスマホに表示されます。URLを知っている人は誰でも見られるので、URLは参加者にだけ伝えてください。</div>`}
      <div class="row"><span class="spacer"></span><button class="btn primary" data-act="closeDlg">閉じる</button></div>
    </div>`;
}
function openPhoneDlg() {
  openDlg(phoneDlgHTML);
  if (!state.view.phone || !state.roomCode) return;
  const url = phoneUrl();
  if (ui.qr && ui.qr.url === url) return;
  loadLib('qr').then(() => {
    const q = qrcode(0, 'M');
    q.addData(url); q.make();
    ui.qr = { url, img: q.createImgTag(5, 10) };
    renderPhoneStatus();
  }, () => {});
}

/* ---------- 描画の予約 ---------- */
let pend = 0;
function commit(panels = true) {
  if (!pend) requestAnimationFrame(flush);
  pend = Math.max(pend, panels ? 2 : 1);
}
function flush() {
  const p = pend; pend = 0;
  renderBoard();
  if (p === 2) { renderLeft(); renderChat(); }
  syncPlayer();
  save();
}

/* ---------- 盤面 ---------- */
const hue = id => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 45% 40%)`; };
const initial = name => esc([...(name || '?')][0] || '?');
const order = () => state.chars.map((c, i) => [c, i]).sort((a, b) => num(b[0].init) - num(a[0].init) || a[1] - b[1]).map(x => x[0]);

function keyed(box, items, cls, update) {
  const old = new Map([...box.children].map(el => [el.dataset.id, el]));
  items.forEach((it, i) => {
    let el = old.get(it.id);
    if (!el) { el = document.createElement('div'); el.className = cls; el.dataset.id = it.id; }
    old.delete(it.id);
    update(el, it);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
  old.forEach(el => el.remove());
}
function setHTML(el, html) { if (el._h !== html) { el._h = html; el.innerHTML = html; } }

const ALIGNS = [['left', '左'], ['center', '中央'], ['right', '右']];
const NOTE_COLORS = ['#f6e27a', '#ffb3c7', '#a8e0a0', '#9fd3f5', '#f7b267', '#d6b8f5', '#ffffff', '#3a3a3a'];
const fontSizeOf = m => clamp(num(m.fontSize, 0), 0, 200) >= 6 ? clamp(num(m.fontSize), 6, 200) : !m.img && m.font === 'plain' ? 14 : 16; // 盤面1マス = 50
// テキストの背景は半透明（文字は透けさせない）
const sheer = hex => { const h = /^#?([0-9a-f]{6})$/i.exec(hex || ''), n = h ? parseInt(h[1], 16) : 0xf6e27a; return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, .55)`; };
const VALIGNS = [['top', '上'], ['middle', '中央'], ['bottom', '下']];
// m.note のない古いテキストマーカーは中央寄せだったので、その見た目を保つ
const valignOf = m => VALIGNS.some(a => a[0] === m.valign) ? m.valign : m.note ? 'top' : 'middle';
const alignOf = m => ALIGNS.some(a => a[0] === m.align) ? m.align : m.note ? 'left' : 'center';
// 背景色の明るさに合わせて読みやすい文字色を選ぶ
const inkOn = hex => {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!h) return '#2b2610';
  const n = parseInt(h[1], 16);
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 140 ? '#2b2610' : '#f4f4f4';
};

function statusHTML(c) {
  return (c.status || []).filter(s => s.label).map(s =>
    `<span><i>${esc(s.label)}</i>${esc(s.value)}${s.max !== '' && s.max != null ? '/' + esc(s.max) : ''}</span>`).join('');
}

function renderBoard() {
  const s = state, board = $('#board'), stage = $('#stage');
  const cols = clamp(Math.round(num(s.fg.cols, 1)), 1, 100), rows = clamp(Math.round(num(s.fg.rows, 1)), 1, 100);
  const W = cols * CELL, H = rows * CELL;

  const bgUrl = assetUrl(s.bg.img), bg = $('#bgLayer');
  if (bg._u !== bgUrl) { bg._u = bgUrl; bg.style.backgroundImage = bgUrl ? `url("${bgUrl}")` : ''; }

  // 前景を画面に収める（プレイヤー画面ではオーバーレイの分だけ空ける）
  let l = IS_PHONE ? 8 : 24, r = l;
  if (IS_PLAYER && !IS_PHONE) {
    if ((s.view.init && s.chars.length) || (s.view.memo && s.memo.pub)) l += 240;
    if (s.view.chat) r += 350;
  }
  const bw = board.clientWidth, bh = board.clientHeight;
  const vw = IS_PHONE ? ph.view : s.view; // スマホは自分の指で拡大・移動する（GM画面の表示範囲には連動しない）
  const zoom = clamp(num(vw.zoom, 1), ZOOM_MIN, ZOOM_MAX);
  scale = Math.max(0.05, Math.min((bw - l - r) / W, (bh - 60) / H)) * zoom;
  lay = { l, aw: bw - l - r, ah: bh - 60, W, H, bw };
  stage.style.width = W + 'px';
  stage.style.height = H + 'px';
  stage.style.transform = `translate(${l + (lay.aw - W * scale) / 2 + num(vw.panX) * CELL * scale}px, ${24 + (lay.ah - H * scale) / 2 + num(vw.panY) * CELL * scale}px) scale(${scale})`;
  renderMsgWin();
  const zp = $('#zoomPct');
  if (document.activeElement !== zp) zp.value = Math.round(zoom * 100);
  stage.style.setProperty('--gl', Math.max(1, 1 / scale) + 'px');

  const fgUrl = assetUrl(s.fg.img), fg = $('#fgLayer');
  setHTML(fg, fgUrl ? `<img src="${fgUrl}" draggable="false" alt="">` : '');
  fg.className = 'fg' + (s.fg.grid ? ' grid' : '') + (fgUrl ? '' : ' empty');
  fg.style.setProperty('--gc', s.fg.gridColor === 'black' ? 'rgba(0, 0, 0, .55)' : 'rgba(255, 255, 255, .28)');

  keyed($('#markerLayer'), s.markers, 'marker', (el, m) => {
    el.style.left = m.x * CELL + 'px'; el.style.top = m.y * CELL + 'px';
    el.style.width = m.w * CELL + 'px'; el.style.height = m.h * CELL + 'px';
    el.classList.toggle('secret', !!m.hidden);
    el.classList.toggle('locked', !!m.locked);
    const u = assetUrl(m.img);
    const al = alignOf(m), fs = `font-size:${fontSizeOf(m)}px;`;
    setHTML(el, (!u ? `<div class="note${m.font === 'plain' ? '' : ' outline'}" style="background:${sheer(m.color)};${m.font === 'plain' ? `color:${inkOn(m.color)};` : ''}${fs}text-align:${al};justify-content:${{ top: 'flex-start', middle: 'center', bottom: 'flex-end' }[valignOf(m)]}">${esc(m.text)}</div>`
      : (u ? `<img src="${u}" draggable="false" alt="">` : `<div class="mbox" style="background:${esc(m.color)}"></div>`)
      + (m.text ? `<div class="mtext" style="${fs}text-align:${al};justify-items:${{ left: 'start', center: 'center', right: 'end' }[al]}">${esc(m.text)}</div>` : ''))
      + (!IS_PLAYER && !m.locked ? '<div class="rz"></div>' : ''));
  });

  keyed($('#pieceLayer'), s.chars.filter(c => c.onBoard), 'piece', (el, c) => {
    const size = Math.max(0.25, num(c.size, 1));
    el.style.left = c.x * CELL + 'px'; el.style.top = c.y * CELL + 'px'; el.style.width = size * CELL + 'px';
    el.classList.toggle('secret', !!c.hidden);
    el.classList.toggle('turn', s.turn.id === c.id);
    const u = assetUrl(c.img), st = statusHTML(c);
    setHTML(el, (u ? `<img class="pimg" src="${u}" draggable="false" alt="">` : `<div class="pimg ph" style="background:${hue(c.id)}">${initial(c.name)}</div>`)
      + `<div class="plabel"><div class="pname">${esc(c.name)}</div>${st ? `<div class="pstat">${st}</div>` : ''}</div>`);
  });
}

// 倍率を変える。(cx, cy) は盤面内の固定したい点（省略時は中央）
function setZoom(z, cx, cy) {
  const v = state.view, old = scale, board = $('#board');
  z = clamp(z, ZOOM_MIN, ZOOM_MAX);
  const ns = old / clamp(num(v.zoom, 1), ZOOM_MIN, ZOOM_MAX) * z;
  if (cx == null) { cx = board.clientWidth / 2; cy = board.clientHeight / 2; }
  const ox = lay.l + (lay.aw - lay.W * old) / 2 + num(v.panX) * CELL * old, oy = 24 + (lay.ah - lay.H * old) / 2 + num(v.panY) * CELL * old;
  const wx = (cx - ox) / old, wy = (cy - oy) / old;
  v.panX = (cx - wx * ns - lay.l - (lay.aw - lay.W * ns) / 2) / (CELL * ns);
  v.panY = (cy - wy * ns - 24 - (lay.ah - lay.H * ns) / 2) / (CELL * ns);
  v.zoom = z;
  commit(false);
}

/* ---------- メッセージウィンドウ ---------- */
// メインタブの最新の発言を、盤面の下にノベルゲーム風に流す
const mw = { id: null, chars: [], n: 0, timer: 0, closed: null };
const MW_FONT = 24; // 文字サイズ100%のときの、プレイヤー画面での大きさ(px)
let playerBw = 0;  // プレイヤー画面の横幅（プレイヤー画面から届く）
const MW_SPEEDS = [[90, 'ゆっくり'], [40, 'ふつう'], [15, 'はやい'], [0, '一瞬']]; // 1文字あたりのミリ秒
const mwSpeedOf = () => { const v = num(state.view.mwSpeed, 40); return MW_SPEEDS.some(s => s[0] === v) ? v : 40; };
function latestMsg() {
  for (let i = state.chat.length - 1; i >= 0; i--) {
    const m = state.chat[i];
    if (m.tab !== 'main' || m.gm) continue;
    const c = state.chars.find(x => x.name === m.from && !x.hidden);
    return { id: m.id, from: m.from, text: m.text, t: m.t, img: c ? c.img : null };
  }
  return null;
}
function renderMsgWin() {
  const el = $('#msgWin'), m = IS_PLAYER ? state.msgwin : state.view.msgwin ? latestMsg() : null;
  if (IS_PLAYER && mw.sentBw !== lay.bw) { mw.sentBw = lay.bw; toGM({ type: 'lay' }); } // 横幅が変わったらGM画面へ知らせる
  el.hidden = !m || mw.closed === m.id;
  $('#mwOpen').hidden = !m || mw.closed !== m.id; // × で閉じたあと、開き直すためのボタン
  if (!m) { mw.id = null; mw.closed = null; clearInterval(mw.timer); return; } // オフにしたら × で閉じた状態も解除する
  // 幅は使える横幅に対する割合、高さは文章の行数で持つ（GM画面とプレイヤー画面で文字の大きさが違うため）
  const w = num(state.view.mwW, 0) ? clamp(num(state.view.mwW), 0.2, 1) * lay.aw : lay.aw * 0.9;
  // 文字も画像も使える横幅に比例させ、GM画面とプレイヤー画面で同じ見え方（同じ位置で改行）にする
  // 100% = フルHD（横1920）のプレイヤー画面で 24px。どの画面も横幅に比例させるので、プレイヤー画面のウィンドウの大きさを変えても
  // GM画面の文字は変わらず、プレイヤー画面はウィンドウに合わせて全体が同じ見え方のまま縮む
  // GM画面の基準 1282 = フルHDのプレイヤー画面で行動順とチャットを両方出したときに盤面へ使える横幅
  const ratio = IS_PHONE ? clamp(lay.aw / 640, 0.55, 1) : IS_PLAYER ? clamp((lay.bw - 638) / 1282, 0.4, 2.5) : lay.aw / 1282;
  el.style.fontSize = Math.max(8, MW_FONT * ratio * clamp(num(state.view.mwFont, 1), 0.5, 2)) + 'px';
  el.style.left = lay.l + (lay.aw - w) / 2 + 'px';
  el.style.width = w + 'px';
  const u = assetUrl(m.img), img = $('.mw-img', el);
  img.hidden = !u;
  if (img._u !== u) { img._u = u; img.style.backgroundImage = u ? `url("${u}")` : ''; }
  $('.mw-name', el).textContent = m.from;
  const text = $('.mw-text', el);
  text.style.height = clamp(num(state.view.mwLines, 3), 1, 15) * 1.6 + 'em';
  const show = () => { text.textContent = mw.chars.slice(0, mw.n).join(''); text.scrollTop = text.scrollHeight; };
  if (mw.id !== m.id) {
    mw.id = m.id; mw.chars = [...m.text];
    clearInterval(mw.timer);
    // 届いたばかりの発言だけ文字送りする（読み込み直後に昔の発言が流れ直さないように）
    mw.n = Date.now() - m.t < 5000 ? 0 : mw.chars.length;
    const ms = mwSpeedOf();
    if (!ms) mw.n = mw.chars.length;
    if (mw.n < mw.chars.length) mw.timer = setInterval(() => { mw.n++; show(); if (mw.n >= mw.chars.length) clearInterval(mw.timer); }, ms);
  }
  show();
}
function bindMsgWin() {
  const el = $('#msgWin');
  const reopen = $('#mwOpen');
  reopen.addEventListener('pointerdown', e => e.stopPropagation());
  reopen.addEventListener('dblclick', e => e.stopPropagation());
  reopen.addEventListener('click', () => { mw.closed = null; renderMsgWin(); });
  el.addEventListener('dblclick', e => e.stopPropagation());
  el.addEventListener('pointerdown', e => e.stopPropagation());
  el.addEventListener('wheel', e => e.stopPropagation());
  if (!IS_PLAYER) {
    // 左上のつまみをドラッグして大きさを変える（ダブルクリックで元の大きさ）
    const rz = $('.mw-rz', el), text = $('.mw-text', el);
    rz.addEventListener('pointerdown', e => {
      e.preventDefault();
      rz.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, w = el.offsetWidth, h = text.offsetHeight, fs = parseFloat(getComputedStyle(text).fontSize);
      const move = ev => {
        state.view.mwW = clamp((w - 2 * (ev.clientX - sx)) / lay.aw, 0.2, 1);
        state.view.mwLines = clamp((h - (ev.clientY - sy)) / (fs * 1.6), 1, 15);
        commit(false);
      };
      const up = () => { rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); rz.removeEventListener('pointercancel', up); };
      rz.addEventListener('pointermove', move);
      rz.addEventListener('pointerup', up);
      rz.addEventListener('pointercancel', up);
    });
    rz.addEventListener('dblclick', () => { delete state.view.mwW; delete state.view.mwLines; commit(false); });
  }
  el.addEventListener('click', e => {
    if (e.target.closest('.mw-rz')) return;
    if (e.target.closest('.mw-x')) { mw.closed = mw.id; renderMsgWin(); return; }
    mw.n = mw.chars.length; clearInterval(mw.timer); // クリックで全文を表示
    $('.mw-text', el).textContent = mw.chars.join('');
  });
}

function bindBoard() {
  const stage = $('#stage'), board = $('#board');
  board.addEventListener('wheel', e => {
    if (e.target.closest('.zoombar')) return;
    e.preventDefault();
    const r = board.getBoundingClientRect();
    setZoom(num(state.view.zoom, 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // 空いた所をドラッグして盤面を動かす
  board.addEventListener('pointerdown', e => {
    // 左ドラッグ：マップや固定マーカーの上から／中ボタンドラッグ：コマの上からでも
    if (e.target.closest('.zoombar')) return;
    if (e.button !== 1 && (e.button !== 0 || e.target.closest('.piece,.marker:not(.locked)'))) return;
    e.preventDefault();
    const v = state.view, sx = e.clientX, sy = e.clientY, o = { x: num(v.panX), y: num(v.panY) };
    board.setPointerCapture(e.pointerId);
    board.classList.add('panning');
    const move = ev => { v.panX = o.x + (ev.clientX - sx) / scale / CELL; v.panY = o.y + (ev.clientY - sy) / scale / CELL; commit(false); };
    const up = () => { board.classList.remove('panning'); board.removeEventListener('pointermove', move); board.removeEventListener('pointerup', up); board.removeEventListener('pointercancel', up); };
    board.addEventListener('pointermove', move);
    board.addEventListener('pointerup', up);
    board.addEventListener('pointercancel', up);
  });
  $('#zoomPct').addEventListener('change', e => setZoom(num(e.target.value, 100) / 100));
  const find = el => {
    const isChar = el.classList.contains('piece');
    return [isChar, (isChar ? state.chars : state.markers).find(o => o.id === el.dataset.id)];
  };
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const el = e.target.closest('.piece,.marker');
    if (!el) return;
    const [isChar, obj] = find(el);
    if (!obj || (!isChar && obj.locked)) return;
    const resize = e.target.classList.contains('rz');
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, o = { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
    let moved = false;
    const move = ev => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
      if (!moved) return;
      const dx = (ev.clientX - sx) / scale / CELL, dy = (ev.clientY - sy) / scale / CELL;
      if (resize) { obj.w = Math.max(0.5, o.w + dx); obj.h = Math.max(0.5, o.h + dy); }
      else { obj.x = o.x + dx; obj.y = o.y + dy; }
      commit(false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!moved) return;
      if (state.view.snap) {
        const q = isChar ? Math.round : v => Math.round(v * 2) / 2;
        if (resize) { obj.w = Math.max(0.5, q(obj.w)); obj.h = Math.max(0.5, q(obj.h)); }
        else { obj.x = q(obj.x); obj.y = q(obj.y); }
      }
      commit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  stage.addEventListener('dblclick', e => {
    const el = e.target.closest('.piece,.marker');
    if (!el) return;
    const [isChar, obj] = find(el);
    if (obj) (isChar ? editChar : editMarker)(obj.id);
  });

  // 画像・音源のドロップ／貼り付け
  board.addEventListener('dragover', e => e.preventDefault());
  board.addEventListener('drop', e => { e.preventDefault(); takeFiles(e.dataTransfer.files); });
  document.addEventListener('paste', e => {
    if (e.target.closest('input,textarea')) return;
    if (e.clipboardData.files.length) return takeFiles(e.clipboardData.files);
    const text = e.clipboardData.getData('text/plain').trim();
    if (text && !$('dialog[open]')) { addNote(text); toast('テキストとして貼り付けました'); }
  });
}

function takeFiles(files) {
  const a = addFiles(files);
  if (!a.image.length && !a.audio.length) return toast('画像か音源のファイルを取り込めます');
  if (a.audio.length) { ui.ltab = 'bgm'; toast(`音源を${a.audio.length}件取り込みました`); }
  if (a.image.length === 1) askImageUse(a.image[0]);
  else if (a.image.length) toast(`画像を${a.image.length}件取り込みました`);
  commit();
}
function askImageUse(id) {
  openDlg(() => `
    <div class="dlg-head">取り込んだ画像の使い道<span class="spacer"></span><button class="btn sm" data-act="closeDlg">×</button></div>
    <div class="dlg-body">
      <div class="imgrow"><span class="thumb big" style="background-image:url('${assetUrl(id)}')"></span>
        <div class="hint">あとから「画像を選ぶ」でも使えます。</div></div>
      <div class="row wrap">
        <button class="btn primary" data-act="useImage" data-as="fg" data-id="${id}">前景（マップ）にする</button>
        <button class="btn" data-act="useImage" data-as="bg" data-id="${id}">背景にする</button>
        <button class="btn" data-act="useImage" data-as="marker" data-id="${id}">マーカーとして置く</button>
        <button class="btn" data-act="useImage" data-as="char" data-id="${id}">コマを作る</button>
      </div>
    </div>`);
}

// マス（グリッド）の大きさを変える。マップの縦横比は保ち、コマとマーカーはマップ上の同じ場所に留める
const GRID_MIN = 4, GRID_MAX = 60;
function setGridCols(nc) {
  const fg = state.fg, oc = clamp(Math.round(num(fg.cols, 20)), 1, 100), or = clamp(Math.round(num(fg.rows, 12)), 1, 100);
  nc = clamp(Math.round(nc), GRID_MIN, GRID_MAX);
  if (!fg.ratio) fg.ratio = or / oc;
  const nr = clamp(Math.round(nc * fg.ratio), 1, 100), kx = nc / oc, ky = nr / or;
  fg.cols = nc; fg.rows = nr;
  for (const c of state.chars) { c.x *= kx; c.y *= ky; }
  for (const m of state.markers) { m.x *= kx; m.w *= kx; m.y *= ky; m.h *= ky; }
}
async function setFg(id) {
  state.fg.img = id;
  if (id) {
    const { w, h } = await imageSize(id);
    state.fg.ratio = h / w;
    state.fg.rows = clamp(Math.round(num(state.fg.cols, 20) * h / w), 1, 100);
  }
  commit();
}
async function addMarker(id) {
  const m = { id: uid(), name: id ? asset(id).name : 'テキスト', img: id, x: 1, y: 1, w: 3, h: 3, text: id ? '' : 'テキスト', color: '#c93c37', hidden: false, locked: false };
  if (id) { const { w, h } = await imageSize(id); m.h = Math.max(0.5, Math.round(m.w * h / w * 2) / 2); }
  state.markers.push(m);
  commit();
  return m;
}
// テキスト（文章を書いた半透明のマーカー）。いま見えている範囲の中央あたりに置く
function addNote(text = '') {
  const b = $('#board').getBoundingClientRect(), st = $('#stage').getBoundingClientRect();
  const n = state.markers.filter(m => !m.img).length % 6;
  const lines = text.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil([...l].length / 12)), 0);
  const w = 4, h = clamp(Math.ceil((lines * 21 + 20) / CELL * 2) / 2, 2, 12);
  const m = {
    id: uid(), name: 'テキスト', note: true, img: null, text, color: '#f6e27a', hidden: false, locked: false, w, h,
    x: Math.round(((b.left + b.width / 2 - st.left) / scale / CELL - w / 2 + n * 0.5) * 2) / 2,
    y: Math.round(((b.top + b.height / 2 - st.top) / scale / CELL - h / 2 + n * 0.5) * 2) / 2,
  };
  state.markers.push(m);
  commit();
  return m;
}
function newChar(over = {}) {
  const n = state.chars.length, cols = Math.max(1, Math.round(num(state.fg.cols, 20)));
  return {
    id: uid(), name: `探索者${n + 1}`, img: null, init: 10, size: 1, x: n % cols, y: Math.floor(n / cols), onBoard: true,
    hidden: false, secretStatus: false, memo: '',
    status: [{ label: 'HP', value: 10, max: 10 }, { label: 'MP', value: 10, max: 10 }, { label: 'SAN', value: 50, max: 99 }],
    ...over,
  };
}

/* ---------- 左パネル ---------- */
const thumb = (id, name, cls = '') => {
  const u = assetUrl(id);
  return `<span class="thumb ${cls}"${u ? ` style="background-image:url('${u}')"` : ''}>${u ? '' : initial(name)}</span>`;
};
const chk = (bind, label, v) => `<label class="chk"><input type="checkbox" data-bind="${bind}"${v ? ' checked' : ''}> ${label}</label>`;

const LEFT = {
  chars() {
    const s = state;
    return `
      <div class="row"><button class="btn primary" data-act="addChar">＋ コマを追加</button>
        <button class="btn" data-act="pasteChar" title="探索者メーカーで作った探索者（JSON）や「ココフォリア駒」の出力を貼り付けて追加します">駒データを貼り付け</button></div>
      <div class="turnbar"><span>ラウンド <b>${s.turn.round}</b></span><span class="spacer"></span>
        <button class="btn sm primary" data-act="nextTurn">次の手番 ▶</button><button class="btn sm" data-act="resetTurn">リセット</button></div>
      <ul class="clist">${order().map(c => `
        <li class="citem${s.turn.id === c.id ? ' turn' : ''}${c.hidden ? ' secret' : ''}">
          <span data-act="editChar" data-id="${c.id}">${thumb(c.img, c.name)}</span>
          <div class="cmain">
            <div class="cname" data-act="editChar" data-id="${c.id}">${esc(c.name)}${c.hidden ? '<span class="tag secret">秘匿</span>' : c.secretStatus ? '<span class="tag secret">ステータス非公開</span>' : ''}</div>
            <div class="cstats">${c.status.map((st, i) => `<label>${esc(st.label)}
              <input type="number" data-bind="chars.${c.id}.status.${i}.value" data-prev="${esc(st.value)}" value="${esc(st.value)}"></label>`).join('')}</div>
          </div>
          <div class="cside">
            <label title="イニシアティブ（行動順）。大きい順に並びます">順<input type="number" data-bind="chars.${c.id}.init" value="${esc(c.init)}"></label>
            <button class="btn sm${c.hidden ? '' : ' on'}" data-act="toggle" data-path="chars.${c.id}.hidden" title="プレイヤー画面に見せるかどうか">${c.hidden ? '秘匿' : '公開'}</button>
            ${c.sheet ? `<button class="btn sm on" data-act="viewSheet" data-id="${c.id}" title="探索者シート（能力値・技能）を見る">シート</button>`
              : `<button class="btn sm" data-act="attachSheet" data-id="${c.id}" title="探索者シートは未登録です。押すと探索者メーカーのデータを取り込めます">シート＋</button>`}
          </div>
        </li>`).join('') || '<li class="empty">コマがありません</li>'}</ul>`;
  },
  scenes() {
    return `
      <button class="btn primary wide" data-act="saveScene">＋ 現在の状態をシーンとして保存</button>
      <div class="hint">前景・背景・BGM・マーカーをまとめて保存し、ワンクリックで切り替えます。</div>
      <ul class="slist">${state.scenes.map(sc => `
        <li class="sitem${state.sceneId === sc.id ? ' on' : ''}">
          <span data-act="applyScene" data-id="${sc.id}" title="このシーンに切り替え">${thumb(sc.fg.img || sc.bg.img, sc.name, 'wide')}</span>
          <div class="col">
            <input type="text" data-bind="scenes.${sc.id}.name" value="${esc(sc.name)}" aria-label="シーン名">
            <div class="row"><button class="btn sm primary" data-act="applyScene" data-id="${sc.id}">切り替え</button>
              <button class="btn sm" data-act="overwriteScene" data-id="${sc.id}" title="現在の盤面でこのシーンを上書きします">上書き</button>
              <button class="btn sm danger" data-act="delScene" data-id="${sc.id}">削除</button></div>
          </div>
        </li>`).join('') || '<li class="empty">シーンがありません</li>'}</ul>`;
  },
  board() {
    const s = state;
    return `
      <h4>前景（マップ・格子状のパネル）</h4>
      <div class="imgrow"><span data-act="pickFg">${thumb(s.fg.img, '前', 'wide')}</span>
        <button class="btn" data-act="pickFg">画像を選ぶ</button><button class="btn" data-act="clearFg">外す</button></div>
      <div class="field"><span>マス数</span>横 <input type="number" min="1" max="100" data-bind="fg.cols" value="${esc(s.fg.cols)}"> × 縦 <input type="number" min="1" max="100" data-bind="fg.rows" value="${esc(s.fg.rows)}"></div>
      <div class="field"><span style="width:auto">マスの大きさ</span><span class="hint">小</span><input type="range" id="gridSize" min="${GRID_MIN}" max="${GRID_MAX}" step="1" value="${GRID_MIN + GRID_MAX - clamp(Math.round(num(s.fg.cols, 20)), GRID_MIN, GRID_MAX)}" aria-label="マスの大きさ"><span class="hint">大</span></div>
      <div class="row wrap">${chk('fg.grid', 'グリッド線を表示', s.fg.grid)}${chk('view.snap', 'マスに吸着', s.view.snap)}</div>
      <div class="field"><span>線の色</span>${[['white', '白'], ['black', '黒']].map(([k, t]) => `<button class="btn sm${(s.fg.gridColor === 'black' ? 'black' : 'white') === k ? ' on' : ''}" data-act="set" data-path="fg.gridColor" data-val="${k}">${t}</button>`).join('')}</div>
      <h4>背景（画面全体）</h4>
      <div class="imgrow"><span data-act="pickBg">${thumb(s.bg.img, '背', 'wide')}</span>
        <button class="btn" data-act="pickBg">画像を選ぶ</button><button class="btn" data-act="clearBg">外す</button></div>
      <h4>マーカーパネル</h4>
      <div class="row"><button class="btn" data-act="addMarkerImg">＋ 画像</button><button class="btn" data-act="addNote" title="文章を書いたマーカーを貼ります。コピーした文章を盤面で Ctrl+V しても貼れます">＋ テキスト</button></div>
      <ul class="mlist">${s.markers.map(m => `
        <li class="mitem${m.hidden ? ' secret' : ''}">
          <span data-act="editMarker" data-id="${m.id}">${thumb(m.img, m.text || m.name)}</span>
          <div class="col"><input type="text" data-bind="markers.${m.id}.name" value="${esc(m.name)}" aria-label="マーカー名">
            <div class="row">
              <button class="btn sm${m.hidden ? '' : ' on'}" data-act="toggle" data-path="markers.${m.id}.hidden">${m.hidden ? '秘匿' : '公開'}</button>
              <button class="btn sm${m.locked ? ' on' : ''}" data-act="toggle" data-path="markers.${m.id}.locked" title="固定すると盤面でドラッグできなくなります">固定</button>
              <button class="btn sm" data-act="editMarker" data-id="${m.id}">編集</button>
              <button class="btn sm danger" data-act="delMarker" data-id="${m.id}">削除</button></div></div>
        </li>`).join('') || '<li class="empty">マーカーがありません</li>'}</ul>
      <h4>プレイヤー画面に表示するもの</h4>
      ${chk('view.init', '行動順とステータス', s.view.init)}
      ${chk('view.chat', 'チャット（メイン・情報・雑談）', s.view.chat)}
      ${chk('view.msgwin', 'メッセージウィンドウ（メインの最新の発言）', s.view.msgwin)}
      ${chk('view.memo', '公開メモ', s.view.memo)}
      <div class="hint">秘匿にしたコマ・マーカー、秘話、GMメモはプレイヤー画面には送られません。</div>
      <h4>メッセージウィンドウ</h4>
      <div class="field"><span>文字サイズ</span><input type="range" min="0.5" max="2" step="0.05" data-bind="view.mwFont" value="${clamp(num(s.view.mwFont, 1), 0.5, 2)}"><span>${Math.round(clamp(num(s.view.mwFont, 1), 0.5, 2) * 100)}%</span>
        <button class="btn sm" data-act="set" data-path="view.mwFont" data-val="1" title="文字サイズを100%に戻す">戻す</button></div>
      <div class="field"><span>文字送り</span>${MW_SPEEDS.map(([k, t]) => `<button class="btn sm${mwSpeedOf() === k ? ' on' : ''}" data-act="set" data-path="view.mwSpeed" data-val="${k}">${t}</button>`).join('')}</div>
      <div class="hint">大きさは、GM画面のウィンドウ左上の緑のつまみをドラッグして変えられます。</div>`;
  },
  bgm() {
    const b = state.bgm, cur = b.playing && asset(b.id);
    return `
      <button class="btn primary wide" data-act="uploadAudio">＋ 音源を取り込む</button>
      <div class="turnbar">${cur ? `再生中：<b>${esc(cur.name)}</b>` : '停止中'}</div>
      <div class="field"><span>音量</span><input type="range" min="0" max="1" step="0.01" data-bind="bgm.volume" value="${esc(b.volume)}"></div>
      ${chk('bgm.loop', 'ループ再生', b.loop)}
      ${chk('view.diceSe', 'ダイスを振る音を鳴らす', state.view.diceSe !== false)}
      <ul class="alist">${audios().map(a => {
        const on = b.playing && b.id === a.id;
        return `<li class="aitem${on ? ' on' : ''}">
          <button class="btn sm${on ? ' on' : ''}" data-act="playBgm" data-id="${a.id}">${on ? '■ 停止' : '▶ 再生'}</button>
          <input type="text" data-bind="assets.${a.id}.name" value="${esc(a.name)}" aria-label="音源名">
          <button class="btn sm danger" data-act="delAsset" data-id="${a.id}">削除</button></li>`;
      }).join('') || '<li class="empty">音源がありません</li>'}</ul>
      <div class="hint">BGMはこのGM画面のパソコンから鳴ります。再生中の曲・音量・ループはシーンに保存されます。</div>`;
  },
};

function renderLeft() {
  $('#leftTabs').innerHTML = LEFT_TABS.map(([k, t]) => `<button class="${ui.ltab === k ? 'on' : ''}" data-act="ltab" data-tab="${k}">${t}</button>`).join('');
  const body = $('#leftBody'), top = body.scrollTop;
  const a = document.activeElement, key = a && body.contains(a) ? a.dataset.bind : null;
  body.innerHTML = LEFT[ui.ltab]();
  body.scrollTop = top;
  if (key) { const el = $(`[data-bind="${key}"]`, body); if (el) el.focus(); }
  if (document.activeElement !== $('#roomName')) $('#roomName').value = state.room;
  document.title = state.room + ' - セッションボード';
}

/* ---------- チャット・メモ ---------- */
const hhmm = t => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
function msgHTML(m, gm) {
  return `<div class="msg${m.sys ? ' sys' : ''}"><div class="mh"><b>${esc(m.from)}</b>${m.to ? `<span class="to">→ ${esc(m.to)}</span>` : ''}${gm && m.gm ? '<span class="tag secret">GMのみ</span>' : ''}
    <time>${hhmm(m.t)}</time>${gm ? `<button data-act="delMsg" data-id="${m.id}" title="この発言を削除">×</button>` : ''}</div><div class="mt">${esc(m.text)}</div></div>`;
}
function pushMsg(tab, from, text, extra = {}) {
  state.chat.push({ id: uid(), tab, from, text, t: Date.now(), ...extra });
  if (state.chat.length > 1000) state.chat.splice(0, state.chat.length - 1000);
}
const sysMsg = (text, gm = false) => pushMsg('info', 'システム', text, { sys: true, gm });

function renderChat() {
  // 雑談と秘話は、見ていない間に新しい発言が入ったらタブに赤い印を付ける（スマホからの書き込みに気づけるように）
  if (!ui.seen) ui.seen = Object.fromEntries(['chat', 'secret'].map(k => [k, Math.max(0, ...state.chat.filter(m => m.tab === k).map(m => m.t))]));
  const unread = {};
  for (const k of ['chat', 'secret']) {
    const latest = Math.max(0, ...state.chat.filter(m => m.tab === k).map(m => m.t));
    if (ui.tab === k) ui.seen[k] = latest;
    unread[k] = latest > ui.seen[k];
  }
  $('#chatTabs').innerHTML = [...CHAT_TABS, ['memo', 'メモ']].map(([k, t]) => `<button class="${ui.tab === k ? 'on' : ''}" data-act="ctab" data-tab="${k}">${t}${unread[k] ? '<i class="dot"></i>' : ''}</button>`).join('');
  const memo = ui.tab === 'memo', log = $('#chatLog');
  log.hidden = memo; $('#chatForm').hidden = memo; $('#memoPane').hidden = !memo;
  for (const [id, k] of [['#memoPub', 'pub'], ['#memoGm', 'gm']]) if (document.activeElement !== $(id)) $(id).value = state.memo[k];
  const opts = (el, items) => { const v = el.value; el.innerHTML = items.map(([val, t]) => `<option value="${esc(val)}">${esc(t)}</option>`).join(''); if (items.some(i => i[0] === v)) el.value = v; };
  const names = state.chars.map(c => [c.name, c.name]);
  opts($('#chatFrom'), [['GM', 'GM'], ...names]);
  opts($('#chatTo'), names.length ? [...names, ['GM', 'GM']] : [['GM', 'GM']]);
  opts($('#diceWho'), [['GM', 'GM'], ...names]);
  $('#chatToWrap').hidden = ui.tab !== 'secret';
  if (memo) return;
  const list = state.chat.filter(m => m.tab === ui.tab);
  const sig = ui.tab + list.length + (list.length ? list[list.length - 1].id : '');
  const html = list.map(m => msgHTML(m, true)).join('') || `<div class="empty">${ui.tab === 'secret' ? '特定の相手にだけ伝える内容を記録します。プレイヤー画面には表示されません。' : 'まだ発言がありません'}</div>`;
  if (log._h !== html) { log._h = html; log.innerHTML = html; }
  if (log._sig !== sig) { log._sig = sig; log.scrollTop = log.scrollHeight; }
}

async function sendChat() {
  const box = $('#chatText');
  let text = box.value.trim();
  if (!text) return;
  const tab = ui.tab, from = $('#chatFrom').value || 'GM', extra = tab === 'secret' ? { to: $('#chatTo').value } : {};
  box.value = '';
  const r = await rollAny(text);
  if (r) text = `${from}：${r.text}`;
  // ダイスの結果（その場で振ったもの・ダイス欄から貼ったもの）は、転がる演出が終わってから発言にする
  const anim = r ? { ...r, text } : ui.dice.find(d => d.text === text);
  if (anim && tab !== 'secret') {
    playDice(anim);
    toPlayer({ type: 'dice', anim: { text: anim.text, cls: anim.cls, rands: anim.rands } });
    await new Promise(res => setTimeout(res, DICE_MS + 300));
  }
  pushMsg(tab, from, text, extra);
  commit();
}

/* ---------- ダイス ---------- */
// 例: 2d6+3 / 1d100<=65 目星 / CCB<=65。1D100<=目標値 は第6版の慣例（1-5 決定的成功・96-100 致命的失敗・1/5 スペシャル）で判定
function roll(src) {
  if (/[＞→]/.test(src)) return null; // 貼り付けた結果を振り直さない
  const m = String(src).normalize('NFKC').trim().match(/^(ccb?|(?:[+-]?(?:\d*d\d+|\d+))+)\s*(?:(<=|>=|<|>)\s*(\d+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  let ex = m[1].toLowerCase();
  if (ex[0] === 'c') ex = '1d100';
  if (!ex.includes('d')) return null;
  let total = 0;
  const det = [], rands = [];
  for (const p of ex.match(/[+-]?(?:\d*d\d+|\d+)/g)) {
    const neg = p[0] === '-', body = p.replace(/^[+-]/, '');
    let v, txt;
    if (body.includes('d')) {
      const n = +body.split('d')[0] || 1, f = +body.split('d')[1];
      if (n > 100 || f < 1 || f > 10000) return null;
      const rs = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * f));
      rs.forEach(x => rands.push({ sides: f, value: x }));
      v = rs.reduce((a, b) => a + b, 0);
      txt = n > 1 ? `${v}[${rs.join(',')}]` : String(v);
    } else { v = +body; txt = body; }
    total += neg ? -v : v;
    det.push((neg ? '-' : det.length ? '+' : '') + txt);
  }
  const op = m[2], tg = +m[3];
  const out = [ex.toUpperCase() + (op ? op + tg : '') + (m[4] ? ' ' + m[4] : '')];
  if (det.join('') !== String(total)) out.push(det.join(''));
  out.push(String(total));
  let cls = '';
  if (op) {
    const ok = op === '<=' ? total <= tg : op === '>=' ? total >= tg : op === '<' ? total < tg : total > tg;
    let res = ok ? '成功' : '失敗';
    cls = ok ? 'ok' : 'ng';
    if (ex === '1d100' && op === '<=') {
      if (ok && total <= 5) { res = '決定的成功'; cls = 'crit'; }
      else if (ok && total <= Math.floor(tg / 5)) { res = 'スペシャル'; cls = 'crit'; }
      else if (!ok && total >= 96) { res = '致命的失敗'; cls = 'fumble'; }
    }
    out.push(res);
  }
  return { text: out.join(' ＞ '), cls, rands };
}
/* ダイスが転がる演出。盤面の中央に出て、止まると結果を表示する */
const DICE_MS = 1000;
const fx = { timer: 0, shuffle: 0 };
function playDice(a) {
  const el = $('#diceFx'), rs = (a.rands || []).slice(0, 12);
  clearTimeout(fx.timer); cancelAnimationFrame(fx.raf);
  if (!rs.length) return;
  // D100 は十の位と一の位の2個のD10で見せる
  const dice = rs.flatMap(r => r.sides === 100
    ? [{ sides: 10, tens: true, value: Math.floor(r.value % 100 / 10) || 10 }, { sides: 10, ones: true, value: r.value % 10 || 10 }]
    : [{ sides: r.sides, value: r.value }]).map(makeDie);
  el.style.left = lay.l + 'px';
  el.style.width = lay.aw + 'px';
  el.style.fontSize = (IS_PHONE ? 13 : IS_PLAYER ? 22 : 14) + 'px';
  el.innerHTML = '<canvas></canvas><div class="fx-text"></div>';
  el.className = 'dicefx show';
  diceSound();

  const n = dice.length, s = Math.min(IS_PHONE ? 30 : IS_PLAYER ? 52 : 34, lay.aw * 0.9 / (n * 2.5)); // s = ダイスの半径(px)
  const w = lay.aw, h = s * 6.4, ground = s * 5, dpr = window.devicePixelRatio || 1;
  const cv = $('canvas', el), ctx = cv.getContext('2d');
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 左から転がり込み、弾みながら回転して、出目の面をこちらに向けて止まる
  const draw = ms => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    dice.forEach((d, i) => {
      const delay = i * 70;
      if (ms < delay) return;
      const p = still ? 1 : clamp((ms - delay) / (DICE_MS - delay), 0, 1), e = 1 - Math.pow(1 - p, 3);
      const hop = bounce(p), x = w / 2 + (i - (n - 1) / 2) * s * 2.5 - (1 - e) * (w * 0.55 + s * 3), y = ground - s - hop * s * 2.6;
      drawDie(ctx, d, mat3.mul(d.rest, mat3.rot(d.axis, d.spin * (1 - e))), x, y, s, dpr);
    });
  };
  const loop = () => { const ms = performance.now() - t0; draw(ms); if (ms < DICE_MS) fx.raf = requestAnimationFrame(loop); };
  const t0 = performance.now();
  loop();
  fx.timer = setTimeout(() => {
    cancelAnimationFrame(fx.raf);
    draw(DICE_MS);
    const t = $('.fx-text', el);
    t.textContent = a.text;
    t.className = 'fx-text show ' + (a.cls || '');
    fx.timer = setTimeout(() => { el.className = 'dicefx'; }, 2800);
  }, DICE_MS);
}

/* ---------- 3Dダイス（多面体を自前で計算して canvas に描く） ---------- */
const vec = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const mat3 = { // 3×3行列（行優先の9要素）
  mul: (a, b) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c])),
  vec: (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]],
  rot: ([x, y, z], t) => { // 軸まわりの回転
    const c = Math.cos(t), s = Math.sin(t), k = 1 - c;
    return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
  },
};
// 弾む高さ（0〜1）。落ちてきて3回はずむ
function bounce(p) {
  if (p < 0.28) return 1 - Math.pow(p / 0.28, 2);
  for (const [a, b, peak] of [[0.28, 0.62, 0.42], [0.62, 0.86, 0.15], [0.86, 1, 0.04]]) if (p < b) { const q = (p - a) / (b - a); return peak * 4 * q * (1 - q); }
  return 0;
}
// 各面の向き（法線）から多面体を作る。面はすべて中心から等距離にある
const PHI = (1 + Math.sqrt(5)) / 2;
const signs = (x, y, z) => { // 0 でない成分の符号をすべて組み合わせる
  let out = [[x, y, z]];
  [0, 1, 2].forEach(i => { if (out[0][i]) out = out.flatMap(v => [v, v.map((c, j) => j === i ? -c : c)]); });
  return out;
};
const DICE_NORMALS = {
  4: () => [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
  6: () => [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, -1, 0], [-1, 0, 0], [0, 0, -1]], // 向かい合う面の合計が7
  8: () => signs(1, 1, 1),
  10: () => [0, 1, 2, 3, 4].flatMap(i => [[i * 72, 1], [i * 72 + 36, -1]]).map(([deg, up]) => { const r = deg * Math.PI / 180; return [Math.cos(r) * 0.74, Math.sin(r) * 0.74, 0.67 * up]; }),
  12: () => [...signs(0, 1, PHI), ...signs(1, PHI, 0), ...signs(PHI, 0, 1)],
  20: () => [...signs(1, 1, 1), ...signs(0, 1 / PHI, PHI), ...signs(1 / PHI, PHI, 0), ...signs(PHI, 0, 1 / PHI)],
};
const shapes = {};
function diceShape(kind) {
  if (shapes[kind]) return shapes[kind];
  const ns = DICE_NORMALS[kind]().map(vec.norm), verts = [];
  // 3つの面が交わる点のうち、どの面の外にも出ていないものが頂点
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) for (let k = j + 1; k < ns.length; k++) {
    const det = vec.dot(ns[i], vec.cross(ns[j], ns[k]));
    if (Math.abs(det) < 1e-6) continue;
    const p = vec.mul(vec.add(vec.add(vec.cross(ns[j], ns[k]), vec.cross(ns[k], ns[i])), vec.cross(ns[i], ns[j])), 1 / det);
    if (ns.every(m => vec.dot(m, p) <= 1 + 1e-6) && !verts.some(q => vec.len(vec.sub(p, q)) < 1e-4)) verts.push(p);
  }
  const scale = 1 / Math.max(...verts.map(vec.len));
  const faces = ns.map(nrm => {
    let pts = verts.filter(p => Math.abs(vec.dot(nrm, p) - 1) < 1e-5).map(p => vec.mul(p, scale));
    const c = vec.mul(pts.reduce(vec.add), 1 / pts.length);
    const a = vec.norm(vec.sub(pts[0], c)), b = vec.cross(nrm, a);
    const ang = p => Math.atan2(vec.dot(vec.sub(p, c), b), vec.dot(vec.sub(p, c), a));
    pts = pts.sort((p, q) => ang(p) - ang(q));
    // 数字の「上」の向き：正方形は辺の中点へ、それ以外は中心からいちばん遠い頂点へ
    const dist = pts.map(p => vec.len(vec.sub(p, c))), far = dist.indexOf(Math.max(...dist));
    const square = pts.length === 4 && Math.max(...dist) - Math.min(...dist) < 1e-3;
    const up = vec.norm(vec.sub(square ? vec.mul(vec.add(pts[0], pts[1]), 0.5) : pts[far], c));
    const inr = Math.min(...pts.map((p, i) => { const q = pts[(i + 1) % pts.length], d = vec.norm(vec.sub(q, p)); return vec.len(vec.cross(vec.sub(c, p), d)); }));
    const vid = pts.map(p => verts.findIndex(q => vec.len(vec.sub(vec.mul(q, scale), p)) < 1e-4)); // 各頂点の通し番号
    return { n: nrm, pts, c, up, right: vec.cross(up, nrm), inr, vid };
  });
  return (shapes[kind] = { faces, verts: verts.map(p => vec.mul(p, scale)) });
}
// 6面ダイスの目の位置（面の中の座標）
const PIP_POS = { 1: [[0, 0]], 2: [[-1, 1], [1, -1]], 3: [[-1, 1], [0, 0], [1, -1]], 4: [[-1, 1], [1, 1], [-1, -1], [1, -1]], 5: [[-1, 1], [1, 1], [0, 0], [-1, -1], [1, -1]], 6: [[-1, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [1, -1]] };
function makeDie(d, i) {
  const kind = [4, 6, 8, 10, 12, 20].find(k => k >= d.sides) || 20, shape = diceShape(kind), F = shape.faces.length;
  const die = {
    shape, pips: d.sides === 6, d4: d.sides === 4,
    // D100 は十の位が青、一の位が赤
    tint: d.tens ? [38, 98, 205] : d.ones ? [208, 44, 44] : [253, 253, 251],
    ink: d.tens || d.ones ? [255, 255, 255] : [26, 28, 33],
    axis: vec.norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]),
    spin: (5 + Math.random() * 2) * Math.PI * (i % 2 ? -1 : 1),
  };
  // 止まったときの向き：src の (right, up, n) を dst の (right, up, n) に重ねる回転
  const frame = (sUp, sN, tUp, tN) => {
    const sR = vec.cross(sUp, sN), tR = vec.cross(tUp, tN);
    return [0, 1, 2].flatMap(r => [0, 1, 2].map(c => tR[r] * sR[c] + tUp[r] * sUp[c] + tN[r] * sN[c]));
  };
  const perp = (v, n) => vec.norm(vec.sub(v, vec.mul(n, vec.dot(v, n)))); // n に垂直な成分
  const turn = (v, n, rad) => vec.add(vec.mul(v, Math.cos(rad)), vec.mul(vec.cross(n, v), Math.sin(rad))); // n まわりに回す
  if (die.d4) {
    // 4面ダイスは実物と同じく、てっぺんの頂点が出目。各面の3つの角に数字を書き、面が2つ見える向きで止める
    const vs = shape.verts, apex = vec.norm(vs[d.value - 1]), other = vs[d.value % 4];
    const tN = vec.norm([0.04, 0.9, 0.43]);
    die.rest = frame(perp(other, apex), apex, turn(perp([0, 0, 1], tN), tN, (22 + Math.random() * 14) * Math.PI / 180), tN);
    return die;
  }
  const top = (d.value - 1 + F * 1000) % F; // こちらを向いて止まる面
  die.labels = shape.faces.map((_, j) => kind === 10 && d.sides === 10 ? (d.tens ? (j + 1) % 10 + '0' : String((j + 1) % 10))
    : d.sides === F ? String(j + 1) : j === top ? String(d.value) : String(1 + Math.floor(Math.random() * d.sides)));
  // 出目の面を、少し上と左に傾けてこちらへ向ける（ほかの面も見えて立体に見える）
  const f = shape.faces[top], tN = vec.norm([-0.3, 0.45, 0.84]);
  die.rest = frame(f.up, f.n, turn(perp([0, 1, 0], tN), tN, (Math.random() - 0.5) * 0.5), tN);
  return die;
}
function drawDie(ctx, die, R, x, y, s, dpr) {
  const light = vec.norm([-0.5, 0.75, 0.55]), half = vec.norm(vec.add(light, [0, 0, 1])); // half = 光と視線の中間（つやの向き）
  const rgb = (c, k) => `rgb(${c.map(v => Math.round(clamp(v * k, 0, 255))).join(',')})`;
  const path = pts => { ctx.beginPath(); pts.forEach((q, k) => ctx[k ? 'lineTo' : 'moveTo'](x + q[0] * s, y - q[1] * s)); ctx.closePath(); };
  // 角を丸くするため、ひとまわり小さい多面体を太い丸い線でふちどって元の大きさにする
  const CORE = 0.94, ROUND = (1 - CORE) * 2;
  const faces = die.shape.faces.map((f, j) => ({ f, j, nrm: mat3.vec(R, f.n) })).filter(o => o.nrm[2] > 0.01) // 裏側の面は描かない
    .map(o => ({ ...o, sh: 0.66 + 0.36 * Math.max(0, vec.dot(o.nrm, light)), pts: o.f.pts.map(p => vec.mul(mat3.vec(R, p), CORE)), c: vec.mul(mat3.vec(R, o.f.c), CORE) }))
    .sort((a, b) => a.sh - b.sh); // 明るい面を後から描いて、丸めた角を明るい側の色にする
  const dark = die.ink[0] < 128;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round';
  // 1) 丸めた角と面取り
  for (const o of faces) {
    path(o.pts);
    ctx.fillStyle = ctx.strokeStyle = rgb(die.tint, o.sh * 0.88);
    ctx.lineWidth = s * ROUND;
    ctx.fill(); ctx.stroke();
  }
  for (const o of faces) {
    const { f, j, nrm, sh, c } = o;
    // 2) 面の本体：角を大きく丸めて描く。光の側が明るくなるグラデーション
    const inset = o.pts.map(p => vec.add(c, vec.mul(vec.sub(p, c), 0.91)));
    const cx = x + c[0] * s, cy = y - c[1] * s, r = s * f.inr * 2.4;
    const g = ctx.createRadialGradient(cx + light[0] * r * 0.45, cy - light[1] * r * 0.45, 0, cx, cy, r);
    g.addColorStop(0, rgb(die.tint, sh * 1.06));
    g.addColorStop(1, rgb(die.tint, sh * 0.93));
    path(inset);
    ctx.fillStyle = ctx.strokeStyle = g;
    ctx.lineWidth = s * 0.07;
    ctx.fill(); ctx.stroke();
    // 3) つや：光を正面に反射する面ほど白く光る
    const spec = Math.pow(Math.max(0, vec.dot(nrm, half)), 30);
    if (spec > 0.02) {
      const hl = ctx.createRadialGradient(cx + light[0] * r * 0.3, cy - light[1] * r * 0.3, 0, cx, cy, r);
      hl.addColorStop(0, `rgba(255, 255, 255, ${(dark ? 0.7 : 0.3) * spec})`);
      hl.addColorStop(1, 'rgba(255, 255, 255, 0)');
      path(inset);
      ctx.fillStyle = ctx.strokeStyle = hl;
      ctx.fill(); ctx.stroke();
    }
    // 4) 彫り込んだ目・数字（面の向きに合わせて変形する）
    // 面に貼りつく座標系にする。at = 面の中の位置, up = 文字の上の向き, k = 拡大率
    const stick = (at, up, k) => {
      const p = vec.mul(mat3.vec(R, at), CORE), u = mat3.vec(R, vec.cross(up, f.n)), v = mat3.vec(R, up);
      ctx.setTransform(dpr * k * u[0], -dpr * k * u[1], -dpr * k * v[0], dpr * k * v[1], dpr * (x + p[0] * s), dpr * (y - p[1] * s));
    };
    const text = (str, at, up, size) => {
      stick(at, up, s * CORE * f.inr * size / 100);
      ctx.font = '700 100px "Segoe UI", "Helvetica Neue", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = dark ? `rgba(255, 255, 255, ${0.6 * sh})` : `rgba(0, 0, 0, ${0.35 * sh})`; // 彫りの縁
      ctx.fillText(str, 2.5, 9.5);
      ctx.fillStyle = dark ? rgb(die.ink, 0.45 + sh * 0.6) : rgb(die.ink, 0.55 + sh * 0.45);
      ctx.fillText(str, 0, 6);
    };
    if (die.pips) {
      stick(f.c, f.up, s * CORE);
      const ink = j === 0 ? [196, 42, 38] : die.ink, pr = j === 0 ? 0.165 : 0.098;
      for (const [px, py] of PIP_POS[j + 1]) {
        const ox = px * 0.3, oy = py * 0.3;
        ctx.beginPath(); ctx.arc(ox + pr * 0.1, oy + pr * 0.14, pr * 1.04, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.55 * sh})`; ctx.fill(); // くぼみの下縁に当たる光
        const pg = ctx.createRadialGradient(ox + pr * 0.25, oy + pr * 0.3, 0, ox, oy, pr);
        pg.addColorStop(0, rgb(ink, 0.55 + sh * 0.75));
        pg.addColorStop(1, rgb(ink, 0.3 + sh * 0.45)); // くぼみの上縁は影で暗い
        ctx.beginPath(); ctx.arc(ox, oy, pr, 0, Math.PI * 2);
        ctx.fillStyle = pg; ctx.fill();
      }
    } else if (die.d4) {
      f.pts.forEach((p, k) => { const dir = vec.sub(p, f.c); text(String(f.vid[k] + 1), vec.add(f.c, vec.mul(dir, 0.5)), vec.norm(dir), 0.95); });
    } else {
      text(die.labels[j], f.c, f.up, die.labels[j].length > 1 ? 1.1 : 1.3);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
// ダイスが転がる音（音源ファイルなしで合成する）。鳴らすのはGM画面のパソコンだけ
let actx = null;
function diceSound() {
  if (IS_PLAYER || state.view.diceSe === false) return;
  try {
    actx = actx || new AudioContext();
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime, hits = [0, 0.09, 0.2, 0.3, 0.42, 0.52, 0.63, 0.72, 0.8, 0.86];
    hits.forEach((t, i) => {
      const buf = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.05), actx.sampleRate), d = buf.getChannelData(0);
      for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / d.length, 3);
      const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
      src.buffer = buf;
      f.type = 'bandpass'; f.frequency.value = 1800 + Math.random() * 1800; f.Q.value = 1.2;
      g.gain.value = 0.5 * (1 - i / hits.length * 0.6);
      src.connect(f).connect(g).connect(actx.destination);
      src.start(t0 + t);
    });
  } catch { /* 音が出せない環境では無音 */ }
}

/* BCDice（公開APIサーバー）。つながらないときは上の内蔵ダイス roll() に切り替える */
const BCDICE = {
  servers: ['https://bcdice.onlinesession.app', 'https://bcdice.trpg.net', 'https://bcdice.kazagakure.net'],
  system: 'Cthulhu', // クトゥルフ神話TRPG（第6版）
  downUntil: 0,      // 失敗したらしばらく問い合わせない
};
// ふつうの会話を外部サーバーへ送らないよう、ダイスコマンドらしい文だけを対象にする
const looksLikeDice = t => { const tok = t.split(/\s/)[0]; return /^[\x21-\x7e]+$/.test(tok) && (/[\d\[]/.test(tok) || /^s?ccb?$/i.test(tok)); };
function setEngine(online) {
  const el = $('#diceEngine');
  el.textContent = online ? 'BCDice' : '内蔵ダイス';
  el.className = 'tag' + (online ? ' on' : ' secret');
  el.title = online ? 'BCDice（クトゥルフ神話TRPG）で振っています' : 'BCDiceのサーバーにつながらないため、内蔵のダイスで振っています（1分後に再接続を試します）';
}
async function rollAny(src) {
  if (/[＞→]/.test(src)) return null; // 貼り付けた結果を振り直さない
  const t = String(src).normalize('NFKC').trim();
  if (!looksLikeDice(t)) return null;
  if (navigator.onLine !== false && Date.now() >= BCDICE.downUntil) {
    const cmd = t.replace(/^(s?)1d100<=/i, '$1CCB<='); // 1D100<=目標値 は決定的成功・致命的失敗も判定する
    for (const base of BCDICE.servers) {
      try {
        const c = new AbortController(), tm = setTimeout(() => c.abort(), 4000);
        const res = await fetch(`${base}/v2/game_system/${BCDICE.system}/roll?command=${encodeURIComponent(cmd)}`, { signal: c.signal });
        clearTimeout(tm);
        if (res.status === 400) { setEngine(true); return null; } // ダイスコマンドではなかった
        if (!res.ok) continue;
        const d = await res.json();
        setEngine(true);
        if (!d.ok) return null;
        // 「(1D100<=65) ＞ 72 ＞ 失敗」→「1D100<=65 目星 ＞ 72 ＞ 失敗」
        const memo = t.split(/\s+/).slice(1).join(' '), m = /^\(([^)＞]*)\)( ＞ [\s\S]*)$/.exec(d.text);
        return {
          text: m ? m[1] + (memo ? ' ' + memo : '') + m[2] : d.text,
          cls: d.critical ? 'crit' : d.fumble ? 'fumble' : d.success ? 'ok' : d.failure ? 'ng' : '',
          rands: (d.rands || []).map(x => ({ sides: x.sides, value: x.value })),
        };
      } catch { /* 次のサーバーへ */ }
    }
    BCDICE.downUntil = Date.now() + 60000;
  }
  setEngine(false);
  return roll(src);
}
async function doRoll(expr) {
  const who = $('#diceWho').value || 'GM';
  const r = await rollAny(expr);
  if (!r) return toast('ダイス式を読み取れませんでした（例: 2d6+3）');
  r.text = `${who}：${r.text}`; // 例: 探索者1：1D100 ＞ 24
  playDice(r); // ダイス欄で振った分はGM画面だけ。チャットに送るとプレイヤー画面でも転がる
  ui.dice.unshift(r);
  ui.dice.length = Math.min(ui.dice.length, 20);
  renderDice();
}
function renderDice() {
  $('#diceLog').innerHTML = ui.dice.map((r, i) => `<div class="dres ${r.cls}"><span class="dtxt">${esc(r.text)}</span>
    <button class="btn sm" data-act="copyDice" data-i="${i}">コピー</button><button class="btn sm" data-act="pasteDice" data-i="${i}" title="チャットの入力欄に貼り付けます">チャットへ</button></div>`).join('')
    || '<div class="hint">ボタンを押すとここに結果が出ます（押しただけではプレイヤー画面に出ません）</div>';
}
function copyText(text) {
  const fallback = () => {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject();
  };
  return (navigator.clipboard ? navigator.clipboard.writeText(text).catch(fallback) : fallback())
    .then(() => toast('コピーしました'), () => toast('コピーできませんでした'));
}

/* ---------- ダイアログ ---------- */
function openDlg(build, cls = '') {
  const d = $('#dlg');
  d._build = build;
  d.className = cls;
  d.innerHTML = build();
  if (!d.open) d.showModal();
}
function refreshDlg() {
  const d = $('#dlg');
  if (!d.open || !d._build) return;
  const html = d._build();
  if (html) d.innerHTML = html; else d.close();
}
const dlgHead = t => `<div class="dlg-head">${t}<span class="spacer"></span><button class="btn sm" data-act="closeDlg">×</button></div>`;

function editChar(id) {
  openDlg(() => {
    const c = state.chars.find(x => x.id === id);
    if (!c) return '';
    const p = `chars.${id}`;
    return `${dlgHead('コマの編集')}
    <div class="dlg-body">
      <div class="imgrow"><span data-act="pickCharImg" data-id="${id}">${thumb(c.img, c.name, 'big')}</span>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px">
          <label class="f">名前<input type="text" data-bind="${p}.name" value="${esc(c.name)}"></label>
          <div class="row"><button class="btn" data-act="pickCharImg" data-id="${id}">画像を選ぶ</button></div>
        </div></div>
      <div class="cols">
        <label class="f">イニシアティブ（行動順。ふつうはDEX）<input type="number" data-bind="${p}.init" value="${esc(c.init)}"></label>
        <label class="f">コマの大きさ（マス）<input type="number" min="0.5" step="0.5" data-bind="${p}.size" value="${esc(c.size)}"></label>
      </div>
      <h4>ステータス</h4>
      ${c.status.map((st, i) => `<div class="strow">
        <input type="text" data-bind="${p}.status.${i}.label" value="${esc(st.label)}" placeholder="名前" aria-label="ステータス名">
        <input type="number" data-bind="${p}.status.${i}.value" data-prev="${esc(st.value)}" value="${esc(st.value)}" aria-label="現在値"><span>/</span>
        <input type="number" data-bind="${p}.status.${i}.max" value="${esc(st.max)}" placeholder="最大" aria-label="最大値">
        <button class="btn sm danger" data-act="delStatus" data-id="${id}" data-i="${i}">×</button></div>`).join('')}
      <div><button class="btn sm" data-act="addStatus" data-id="${id}">＋ ステータスを追加</button></div>
      <h4>探索者シート</h4>
      <div class="row wrap">${c.sheet
        ? `<button class="btn" data-act="viewSheet" data-id="${id}">シートを見る</button><button class="btn" data-act="attachSheet" data-id="${id}">入れ替える</button><button class="btn danger" data-act="removeSheet" data-id="${id}">外す</button>`
        : `<button class="btn" data-act="attachSheet" data-id="${id}">探索者メーカーのデータを取り込む</button>`}</div>
      <div class="hint">取り込んだシートは、スマホの「あなた」でこのコマを選んだプレイヤーの「シート」タブに表示されます。</div>
      <h4>公開設定</h4>
      ${chk(`${p}.onBoard`, '盤面にコマを置く', c.onBoard)}
      ${chk(`${p}.hidden`, '秘匿（プレイヤー画面にコマも名前も出さない）', c.hidden)}
      ${chk(`${p}.secretStatus`, 'ステータスだけ非公開にする', c.secretStatus)}
      <label class="f">GMメモ（秘匿）<textarea data-bind="${p}.memo">${esc(c.memo)}</textarea></label>
      <div class="row"><button class="btn" data-act="dupChar" data-id="${id}">複製</button><button class="btn danger" data-act="delChar" data-id="${id}">削除</button>
        <span class="spacer"></span><button class="btn primary" data-act="closeDlg">閉じる</button></div>
    </div>`;
  });
}

function editMarker(id) {
  openDlg(() => {
    const m = state.markers.find(x => x.id === id);
    if (!m) return '';
    const p = `markers.${id}`;
    return `${dlgHead('マーカーの編集')}
    <div class="dlg-body">
      <div class="imgrow"><span data-act="pickMarkerImg" data-id="${id}">${thumb(m.img, m.text || m.name, 'big')}</span>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px">
          <label class="f">名前<input type="text" data-bind="${p}.name" value="${esc(m.name)}"></label>
          <div class="row"><button class="btn" data-act="pickMarkerImg" data-id="${id}">画像を選ぶ</button></div>
        </div></div>
      <div class="cols">
        <label class="f">横（マス）<input type="number" min="0.5" step="0.5" data-bind="${p}.w" value="${esc(m.w)}"></label>
        <label class="f">縦（マス）<input type="number" min="0.5" step="0.5" data-bind="${p}.h" value="${esc(m.h)}"></label>
      </div>
      <label class="f">${!m.img ? '文章' : 'テキスト（画像の上に重ねて表示）'}<textarea data-bind="${p}.text" rows="${!m.img ? 8 : 3}"${!m.img ? ' autofocus' : ''}>${esc(m.text)}</textarea></label>
      <div class="field"><span>文字サイズ</span><input type="number" min="6" max="200" step="1" data-bind="${p}.fontSize" value="${fontSizeOf(m)}" aria-label="文字サイズ">
        ${[12, 16, 24, 36, 48].map(v => `<button class="btn sm${fontSizeOf(m) === v ? ' on' : ''}" data-act="setMarker" data-id="${id}" data-key="fontSize" data-val="${v}">${v}</button>`).join('')}</div>
      <div class="field"><span>文字揃え</span>${ALIGNS.map(([k, t]) => `<button class="btn sm${alignOf(m) === k ? ' on' : ''}" data-act="setMarker" data-id="${id}" data-key="align" data-val="${k}">${t}</button>`).join('')}</div>
      ${!m.img ? `<div class="field"><span>上下位置</span>${VALIGNS.map(([k, t]) => `<button class="btn sm${valignOf(m) === k ? ' on' : ''}" data-act="setMarker" data-id="${id}" data-key="valign" data-val="${k}">${t}</button>`).join('')}</div>
      <div class="field"><span>文字</span>${[['outline', '太字・ふちどり'], ['plain', 'ふつう']].map(([k, t]) => `<button class="btn sm${(m.font === 'plain' ? 'plain' : 'outline') === k ? ' on' : ''}" data-act="setMarker" data-id="${id}" data-key="font" data-val="${k}">${t}</button>`).join('')}</div>
      <div class="field"><span>背景色</span>
        ${NOTE_COLORS.map(c => `<button class="swatch${m.color === c ? ' on' : ''}" style="background:${c}" data-act="setMarker" data-id="${id}" data-key="color" data-val="${c}" title="${c}" aria-label="背景色 ${c}"></button>`).join('')}
        <input type="color" data-bind="${p}.color" value="${esc(m.color)}" title="好きな色を選ぶ"></div>` : ''}
      ${chk(`${p}.hidden`, '秘匿（プレイヤー画面に出さない）', m.hidden)}
      ${chk(`${p}.locked`, '固定（ドラッグで動かないようにする）', m.locked)}
      <div class="row"><button class="btn" data-act="markerZ" data-id="${id}" data-d="1">前面へ</button><button class="btn" data-act="markerZ" data-id="${id}" data-d="-1">背面へ</button>
        <button class="btn danger" data-act="delMarker" data-id="${id}">削除</button>
        <span class="spacer"></span><button class="btn primary" data-act="closeDlg">閉じる</button></div>
    </div>`;
  });
}

function pickImage(cb) {
  ui.pick = cb;
  renderPicker();
  if (!$('#picker').open) $('#picker').showModal();
}
function renderPicker() {
  $('#picker').innerHTML = `
    <div class="dlg-head">画像を選ぶ<span class="spacer"></span><button class="btn sm" data-act="closePicker">×</button></div>
    <div class="dlg-body">
      <div class="row"><button class="btn primary" data-act="uploadImg">＋ 画像を取り込む</button><button class="btn" data-act="pickThis" data-id="">画像なしにする</button></div>
      <div class="agrid">${images().map(a => `<figure data-act="pickThis" data-id="${a.id}"><img src="${assetUrl(a.id)}" alt="" loading="lazy">
        <figcaption>${esc(a.name)}</figcaption><button class="btn sm danger" data-act="delAsset" data-id="${a.id}" title="この画像をルームから削除">×</button></figure>`).join('')}</div>
      ${images().length ? '' : '<div class="empty">まだ画像がありません。「画像を取り込む」から追加してください。</div>'}
    </div>`;
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- BGM ---------- */
const audio = new Audio();
let audioId = null;
function applyBgm() {
  const b = state.bgm;
  audio.loop = !!b.loop;
  audio.volume = clamp(num(b.volume, 0.5), 0, 1);
  if (!b.id || !b.playing || !blobs.has(b.id)) { b.playing = false; audio.pause(); return; }
  if (audioId !== b.id) { audio.src = assetUrl(b.id); audioId = b.id; }
  if (audio.paused) audio.play().catch(() => { b.playing = false; toast('BGMを再生できませんでした。再生ボタンを押してください'); commit(); });
}
audio.addEventListener('ended', () => { state.bgm.playing = false; commit(); });

/* ---------- シーン ---------- */
const snapshot = () => clone({
  fg: state.fg, bg: state.bg, markers: state.markers,
  bgm: { id: state.bgm.playing ? state.bgm.id : null, volume: state.bgm.volume, loop: state.bgm.loop },
});
function applyScene(sc) {
  const s = clone(sc);
  state.fg = s.fg; state.bg = s.bg; state.markers = s.markers;
  const same = state.bgm.playing && state.bgm.id === s.bgm.id;
  state.bgm = { ...s.bgm, playing: !!s.bgm.id };
  state.sceneId = sc.id;
  if (!same) { audio.pause(); audio.currentTime = 0; }
  applyBgm();
  sysMsg(`シーン「${sc.name}」に切り替えました`);
}

/* ---------- 書き出し・読み込み ---------- */
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
function dataURLToBlob(u) {
  const [head, body] = u.split(',');
  const bin = atob(body), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: head.match(/data:([^;]*)/)[1] });
}
async function exportRoom() {
  const assets = {};
  for (const a of state.assets) if (blobs.has(a.id)) assets[a.id] = await blobToDataURL(blobs.get(a.id));
  const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'coc-session-board', v: 1, state, assets })], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: `${state.room || 'room'}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importRoom(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.app !== 'coc-session-board' || !data.state) return toast('このツールで書き出したファイルではありません');
  if (!confirm('現在のルームを、読み込むファイルの内容で置き換えます。よろしいですか？')) return;
  await clearAssets();
  for (const [id, u] of Object.entries(data.assets || {})) { const b = dataURLToBlob(u); blobs.set(id, b); DB.put('assets', id, b); }
  stopPhoneHost();
  loadState(data.state);
  startPhoneHost();
  commit();
  toast('ルームを読み込みました');
}
async function clearAssets() {
  audio.pause(); audioId = null;
  urls.forEach(u => URL.revokeObjectURL(u));
  urls.clear(); blobs.clear();
  await DB.clear('assets');
}
function loadState(s) {
  const d = defaultState();
  state = { ...d, ...s };
  for (const k of ['fg', 'bg', 'bgm', 'memo', 'turn', 'view']) state[k] = { ...d[k], ...(s[k] || {}) };
  state.bgm.playing = false; // ブラウザは操作なしの自動再生を許さないため
}

// 探索者メーカー／ココフォリアの駒データ（クリップボード形式）
function importCcfolia(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  d = d && d.kind === 'character' ? d.data : d;
  if (!d || typeof d.name !== 'string') return null;
  const st = Array.isArray(d.status) ? d.status.filter(s => s && s.label).map(s => ({ label: String(s.label), value: num(s.value), max: s.max == null ? '' : num(s.max) })) : [];
  return newChar({
    name: d.name, init: num(d.initiative, 10), secretStatus: !!d.secret,
    memo: [d.memo, d.commands].filter(Boolean).join('\n\n'),
    ...(st.length ? { status: st } : {}),
  });
}

/* ---------- 探索者シート（探索者メーカーのデータ） ---------- */
// 探索者メーカーの「JSONをコピー／保存」のデータから、⑥完成のシートに出ている内容を計算する。
// 計算方法は探索者メーカー（app.js）と同じ。職業・技能の定義は maker-data.js（探索者メーカーの data.js）を使う
function makerSheet(ms) {
  if (!ms || typeof ms !== 'object' || !ms.stats || !ms.profile || typeof ERAS === 'undefined' || !ERAS[ms.era]) return null;
  if (!STATS.every(s => Number.isFinite(ms.stats[s.k]))) return null; // 能力値が未決定
  const st = k => ms.stats[k] ?? 0;
  const MAP = Object.fromEntries(SKILLS.map(d => [d.k, d])), ORDER = Object.fromEntries(SKILLS.map((d, i) => [d.k, i]));
  const eraOk = def => !!def && (!def.eras || def.eras.includes(ms.era));
  const specDefaults = def => def.def[ms.era] || def.def.all || [''];
  const keyToRowId = k => MAP[k].spec ? `${k}:${specDefaults(MAP[k])[0]}` : k;
  const entryKey = e => typeof e === 'string' ? e : e.k;
  const occ = ms.occ && ms.occ !== 'custom' ? OCCUPATIONS.find(o => o.id === ms.occ) || null : null;

  const rows = [], seen = new Set();
  const add = (k, preset, extra) => {
    const id = preset === null ? k : `${k}:${preset}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ id, k, def: MAP[k], preset: extra ? '' : preset });
  };
  for (const d of SKILLS) {
    if (!eraOk(d)) continue;
    if (d.spec) specDefaults(d).forEach(p => add(d.k, p)); else add(d.k, null);
  }
  if (occ) occ.skills.forEach(e => { if (typeof e === 'object' && eraOk(MAP[e.k])) add(e.k, e.s); });
  (ms.extraRows || []).forEach(x => { if (eraOk(MAP[x.k])) add(x.k, x.p, true); });
  rows.sort((a, b) => ORDER[a.k] - ORDER[b.k]);
  const has = id => rows.some(r => r.id === id);

  const base = r => typeof r.def.base === 'function' ? r.def.base(ms.stats) : r.def.base;
  const total = r => { const a = (ms.alloc || {})[r.id] || {}; return base(r) + (a.o || 0) + (a.i || 0); };
  const name = r => { const sp = r.def.spec ? (ms.specs || {})[r.id] ?? r.preset : ''; return sp ? `${r.def.n}（${sp}）` : r.def.n; };
  // 職業技能
  const ids = [], choices = ms.choices || {};
  if (ms.occ === 'custom') (ms.customOcc || []).forEach(id => { if (has(id)) ids.push(id); });
  else if (occ) {
    occ.skills.forEach(e => { if (eraOk(MAP[entryKey(e)])) ids.push(typeof e === 'string' ? keyToRowId(e) : `${e.k}:${e.s}`); });
    (occ.choose || []).forEach((c, ci) => (choices['c' + ci] || []).filter(k => c.of.includes(k) && eraOk(MAP[k])).slice(0, c.n).forEach(k => ids.push(keyToRowId(k))));
    (choices.any || []).slice(0, occ.any || 0).forEach(id => { if (id && has(id)) ids.push(id); });
  }
  const occSet = new Set(ids), mythosRow = rows.find(r => r.id === 'mythos'), sum = st('STR') + st('SIZ');
  const db = sum <= 12 ? '-1D6' : sum <= 16 ? '-1D4' : sum <= 24 ? '0' : sum <= 32 ? '+1D4' : sum <= 40 ? '+1D6' : sum <= 56 ? '+2D6' : sum <= 72 ? '+3D6' : `+${3 + Math.ceil((sum - 72) / 16)}D6`;
  const hp = Math.ceil((st('CON') + st('SIZ')) / 2), san = st('POW') * 5, maxSan = 99 - (mythosRow ? total(mythosRow) : 0), p = ms.profile;
  const str = v => String(v ?? '');
  return {
    name: str(p.name), kana: str(p.kana), player: str(p.player), age: str(p.age), sex: str(p.sex), birthplace: str(p.birthplace), school: str(p.school),
    occ: ms.occ === 'custom' ? (ms.custom && ms.custom.name) || 'オリジナル職業' : occ ? occ.name : '',
    occDesc: ms.occ === 'custom' ? (ms.custom && ms.custom.desc) || '' : occ ? occ.desc || '' : '',
    era: ERAS[ms.era].label,
    stats: STATS.map(s => [s.k, st(s.k)]),
    derived: [['SAN', san], ['最大SAN', maxSan], ['幸運', st('POW') * 5], ['アイデア', st('INT') * 5], ['知識', Math.min(99, st('EDU') * 5)], ['HP', hp], ['MP', st('POW')], ['DB', db]],
    skills: rows.map(r => ({ n: name(r), b: base(r), t: total(r), o: occSet.has(r.id), g: r.def.g })),
    bg: BACKGROUND_FIELDS.filter(b => str((ms.bg || {})[b.k]).trim()).map(b => [b.n, str(ms.bg[b.k])]),
    dex: st('DEX'), hp, mp: st('POW'), san, maxSan,
  };
}
// 貼り付けられた文字列が探索者メーカーのJSONならシートにする
function parseMakerJson(text) {
  try { return makerSheet(JSON.parse(text)); } catch { return null; }
}
// 探索者メーカーの「⑥ 完成」と同じ並び・同じ見た目のシート
function sheetHTML(sh, showAll, rollable) {
  // rollable（スマホの自分のシート）のときは、技能や派生値を押すとその値で振れる
  const tap = (label, v) => rollable && Number.isFinite(+v) && +v > 0 ? ` data-roll="CCB<=${+v} ${esc(label)}" role="button" tabindex="0"` : '';
  const skills = sh.skills.filter(s => showAll || s.t !== s.b || s.o);
  // 技能をカテゴリ（戦闘・探索・行動・交渉・知識）ごとにまとめる。カテゴリを持たない古いシートは技能名から引く
  const defs = typeof SKILLS === 'undefined' ? [] : SKILLS;
  const groupOf = s => s.g || (defs.find(d => s.n === d.n || s.n.startsWith(d.n + '（')) || {}).g || 'その他';
  const groups = [...(typeof SKILL_GROUPS === 'undefined' ? [] : SKILL_GROUPS), 'その他'].map(g => [g, skills.filter(s => groupOf(s) === g)]).filter(x => x[1].length);
  return `<div class="sheet">
    <div class="sh-title">
      <div>
        <div class="kana">${esc(sh.kana)}</div>
        <div class="name">${esc(sh.name) || '名もなき探索者'}</div>
        <div class="occ">${esc(sh.occ) || '職業未定'}</div>
      </div>
      <div class="era">クトゥルフ神話TRPG 第6版<br>${esc(sh.era)}${sh.player ? `<br>PL：${esc(sh.player)}` : ''}</div>
    </div>
    <div class="sh-profile">
      <div><span>年齢</span>${esc(sh.age)}</div>
      <div><span>性別</span>${esc(sh.sex)}</div>
      <div><span>出身地</span>${esc(sh.birthplace)}</div>
      <div><span>学校・学位</span>${esc(sh.school)}</div>
    </div>
    ${sh.occDesc ? `<p class="sh-occdesc" style="margin-top:10px">${esc(sh.occDesc)}</p>` : ''}

    <h2>能力値</h2>
    <div class="sh-stats">${sh.stats.map(([k, v]) => `<div class="sh-stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <div class="sh-derived">${sh.derived.map(([k, v]) => `<div${['幸運', 'アイデア', '知識'].includes(k) ? tap(k, v) : ''}><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>

    <h2>技能</h2>
    ${rollable ? '<p class="sh-legend" style="margin:0 0 8px">技能や「幸運・アイデア・知識」を押すと、その値でダイスを振れます。</p>' : ''}
    <label class="chk sheet-toggle"><input type="checkbox" data-sheet-all${showAll ? ' checked' : ''}> 初期値のままの技能も表示する</label>
    ${groups.map(([g, list]) => `<h3 class="sh-group">${esc(g)}技能</h3>
    <div class="sh-skills">${list.map(s => `<div class="sh-skill ${s.o ? 'occ' : ''}"${tap(s.n, s.t)}><span class="n">${esc(s.n)}</span><span class="v"><span class="b">${esc(s.b)}→</span>${esc(s.t)}</span></div>`).join('')}</div>`).join('')}
    <p class="sh-legend">◆＝職業技能　（初期値→現在値）</p>

    ${sh.bg.length ? `<h2>バックグラウンド</h2>
    <div class="sh-bg">${sh.bg.map(([n, t]) => `<div><h4>${esc(n)}</h4><p>${esc(t)}</p></div>`).join('')}</div>` : ''}
  </div>`;
}
function viewSheet(id) {
  openDlg(() => {
    const c = state.chars.find(x => x.id === id);
    return c && c.sheet ? `${dlgHead(`${esc(c.name)} の探索者シート`)}<div class="dlg-body">${sheetHTML(c.sheet, ui.sheetAll)}</div>` : '';
  }, 'wide');
}
// 探索者メーカーのデータを貼り付ける画面。id があればそのコマにシートを付け、なければ新しいコマを作る
function pasteDataDlg(id) {
  ui.sheetFor = id || null;
  openDlg(() => `${dlgHead(id ? '探索者メーカーのデータを取り込む' : '駒データを貼り付け')}
    <div class="dlg-body">
      <div class="hint">探索者メーカーの「⑥ 完成」で <b>JSONをコピー</b> したデータを貼り付けるか、<b>JSONを保存</b> したファイルを選んでください。能力値・技能などのシートごと取り込みます。${id ? '' : '<br>「ココフォリア駒」の出力も貼り付けられます（名前・イニシアティブ・ステータスだけを取り込みます）。'}</div>
      <textarea id="ccText" rows="8" placeholder='ここに貼り付け'></textarea>
      <div class="row"><button class="btn" data-act="pickSheetFile">ファイルから読み込む</button><span class="spacer"></span><button class="btn primary" data-act="importCc">${id ? '取り込む' : '追加する'}</button></div>
    </div>`);
}


function walk(path) {
  const seg = path.split('.');
  let o = state;
  for (let i = 0; i < seg.length - 1 && o != null; i++) o = Array.isArray(o) ? (/^\d+$/.test(seg[i]) ? o[+seg[i]] : o.find(x => x.id === seg[i])) : o[seg[i]];
  return o == null ? null : [o, seg[seg.length - 1]];
}
const byId = (list, el) => list.find(x => x.id === el.dataset.id);

const A = {
  ltab(el) { ui.ltab = el.dataset.tab; commit(); },
  ctab(el) { ui.tab = el.dataset.tab; if (ui.tab !== 'secret' && ui.tab !== 'memo') state.view.ptab = ui.tab; commit(); },
  set(el) { const w = walk(el.dataset.path); if (w) { w[0][w[1]] = el.dataset.val; commit(); } },
  toggle(el) { const w = walk(el.dataset.path); if (w) { w[0][w[1]] = !w[0][w[1]]; commit(); } },
  closeDlg() { $('#dlg').close(); },
  closePicker() { $('#picker').close(); },

  openPlayer() {
    playerWin = window.open(playerUrl(), 'coc-session-player', 'width=1280,height=720');
    if (!playerWin) toast('ポップアップがブロックされました。このページのポップアップを許可してください');
  },
  exportRoom() { exportRoom(); },
  importRoom() { $('#fileImport').click(); },
  async resetRoom() {
    if (!confirm('ルームの内容（コマ・シーン・チャット・画像・音源）をすべて消します。よろしいですか？')) return;
    await clearAssets();
    stopPhoneHost();
    state = defaultState();
    commit();
  },

  // スマホ
  phoneDlg() { openPhoneDlg(); },
  copyPhoneUrl() { copyText(phoneUrl()); },
  phonePreview() { $('#dlg').close(); openPhonePreview(); },
  closePhonePreview() { closePhonePreview(); },
  newRoomCode() {
    if (!confirm('スマホ用のURLを作り直します。今のURLとQRコードは使えなくなり、つながっているスマホは切断されます。よろしいですか？')) return;
    stopPhoneHost(); state.roomCode = ''; startPhoneHost(); openPhoneDlg();
  },

  // コマ
  addChar() { const c = newChar(); state.chars.push(c); commit(); editChar(c.id); },
  editChar(el) { editChar(el.dataset.id); },
  dupChar(el) {
    const c = byId(state.chars, el); if (!c) return;
    const d = { ...clone(c), id: uid(), name: c.name + ' (2)', x: c.x + 1 };
    state.chars.push(d); commit(); editChar(d.id);
  },
  delChar(el) {
    const c = byId(state.chars, el);
    if (!c || !confirm(`「${c.name}」を削除しますか？`)) return;
    state.chars = state.chars.filter(x => x !== c);
    if (state.turn.id === c.id) state.turn.id = null;
    $('#dlg').close(); commit();
  },
  addStatus(el) { const c = byId(state.chars, el); if (c) { c.status.push({ label: '', value: 0, max: '' }); refreshDlg(); commit(); } },
  delStatus(el) { const c = byId(state.chars, el); if (c) { c.status.splice(+el.dataset.i, 1); refreshDlg(); commit(); } },
  pickCharImg(el) { const c = byId(state.chars, el); if (c) pickImage(id => { c.img = id; }); },
  pasteChar() { pasteDataDlg(null); },
  attachSheet(el) { pasteDataDlg(el.dataset.id); },
  pickSheetFile() { $('#fileSheet').click(); },
  viewSheet(el) { viewSheet(el.dataset.id); },
  removeSheet(el) { const c = byId(state.chars, el); if (c && confirm(`「${c.name}」の探索者シートを外しますか？`)) { delete c.sheet; refreshDlg(); commit(); } },
  importCc() {
    const text = $('#ccText').value, sh = parseMakerJson(text), id = ui.sheetFor;
    if (id) { // 既存のコマにシートを付ける
      const c = state.chars.find(x => x.id === id);
      if (!c) return;
      if (!sh) return toast('探索者メーカーのデータとして読み取れませんでした（⑥完成の「JSONをコピー」を貼り付けてください）');
      c.sheet = sh; commit(); editChar(id);
      return toast('探索者シートを取り込みました');
    }
    const c = sh ? newChar({
      name: sh.name || '探索者', init: sh.dex, sheet: sh,
      status: [{ label: 'HP', value: sh.hp, max: sh.hp }, { label: 'MP', value: sh.mp, max: sh.mp }, { label: 'SAN', value: sh.san, max: sh.maxSan }],
    }) : importCcfolia(text);
    if (!c) return toast('駒データとして読み取れませんでした');
    state.chars.push(c); commit(); editChar(c.id);
  },
  nextTurn() {
    const o = order();
    if (!o.length) return;
    let i = o.findIndex(c => c.id === state.turn.id) + 1;
    if (i >= o.length) { i = 0; if (state.turn.id) state.turn.round++; }
    state.turn.id = o[i].id;
    sysMsg(`ラウンド${state.turn.round}：${o[i].name} の手番`, o[i].hidden);
    commit();
  },
  resetTurn() { state.turn = { id: null, round: 1 }; commit(); },

  // シーン
  saveScene() { const sc = { id: uid(), name: `シーン${state.scenes.length + 1}`, ...snapshot() }; state.scenes.push(sc); state.sceneId = sc.id; commit(); },
  applyScene(el) { const sc = byId(state.scenes, el); if (sc) { applyScene(sc); commit(); } },
  overwriteScene(el) {
    const sc = byId(state.scenes, el);
    if (!sc || !confirm(`シーン「${sc.name}」を現在の盤面で上書きしますか？`)) return;
    Object.assign(sc, snapshot()); state.sceneId = sc.id; commit(); toast('シーンを上書きしました');
  },
  delScene(el) {
    const sc = byId(state.scenes, el);
    if (!sc || !confirm(`シーン「${sc.name}」を削除しますか？`)) return;
    state.scenes = state.scenes.filter(x => x !== sc); commit();
  },

  // 盤面
  pickFg() { pickImage(id => setFg(id)); },
  clearFg() { state.fg.img = null; commit(); },
  pickBg() { pickImage(id => { state.bg.img = id; }); },
  clearBg() { state.bg.img = null; commit(); },
  addMarkerImg() { pickImage(id => { if (id) addMarker(id); }); },
  addNote() { editMarker(addNote('').id); },
  setMarker(el) { const m = byId(state.markers, el); if (m) { m[el.dataset.key] = el.dataset.val; refreshDlg(); commit(); } },
  editMarker(el) { editMarker(el.dataset.id); },
  pickMarkerImg(el) { const m = byId(state.markers, el); if (m) pickImage(id => { m.img = id; }); },
  delMarker(el) { state.markers = state.markers.filter(m => m.id !== el.dataset.id); refreshDlg(); commit(); },
  markerZ(el) {
    const i = state.markers.findIndex(m => m.id === el.dataset.id), j = i + +el.dataset.d;
    if (i < 0 || j < 0 || j >= state.markers.length) return;
    state.markers.splice(j, 0, state.markers.splice(i, 1)[0]); commit();
  },
  async useImage(el) {
    const id = el.dataset.id, as = el.dataset.as;
    $('#dlg').close();
    if (as === 'fg') await setFg(id);
    if (as === 'bg') state.bg.img = id;
    if (as === 'marker') await addMarker(id);
    if (as === 'char') { const c = newChar({ img: id, name: asset(id).name }); state.chars.push(c); editChar(c.id); }
    commit();
  },

  // 画像・音源
  uploadImg() { $('#fileImg').click(); },
  uploadAudio() { $('#fileAudio').click(); },
  pickThis(el) {
    const cb = ui.pick; ui.pick = null;
    $('#picker').close();
    if (cb) cb(el.dataset.id || null);
    refreshDlg(); commit();
  },
  delAsset(el) {
    const a = asset(el.dataset.id);
    if (!a || !confirm(`「${a.name}」をルームから削除しますか？（使用中の場所からも外れます）`)) return;
    removeAsset(a.id);
    if ($('#picker').open) renderPicker();
    refreshDlg(); commit();
  },
  playBgm(el) {
    const b = state.bgm, id = el.dataset.id;
    if (b.playing && b.id === id) b.playing = false;
    else { b.id = id; b.playing = true; }
    audio.pause(); audio.currentTime = 0;
    applyBgm(); commit();
  },

  zoomStep(el) { setZoom(Math.round(num(state.view.zoom, 1) * 100 + 10 * +el.dataset.d) / 100); },
  // 盤面のコマをマップの左上から一覧の順に並べ直す
  resetPieces() {
    const list = state.chars.filter(c => c.onBoard);
    if (!list.length) return toast('盤面にコマがありません');
    if (!confirm('盤面のコマをすべて、マップの左上から順に並べ直します。よろしいですか？')) return;
    const cols = clamp(Math.round(num(state.fg.cols, 1)), 1, 100);
    let x = 0, y = 0, rowH = 1;
    for (const c of list) {
      const sz = Math.max(1, Math.ceil(num(c.size, 1)));
      if (x > 0 && x + sz > cols) { x = 0; y += rowH; rowH = 1; }
      c.x = x; c.y = y;
      x += sz; rowH = Math.max(rowH, sz);
    }
    commit();
    toast('コマを並べ直しました');
  },
  zoomReset() { Object.assign(state.view, { zoom: 1, panX: 0, panY: 0 }); commit(false); },

  // チャット・ダイス
  delMsg(el) { state.chat = state.chat.filter(m => m.id !== el.dataset.id); commit(); },
  roll(el) {
    const t = num($('#diceTarget').value, 0);
    doRoll(el.dataset.expr === '1d100' && t > 0 ? `1d100<=${t}` : el.dataset.expr);
  },
  copyDice(el) { copyText(ui.dice[+el.dataset.i].text); },
  pasteDice(el) {
    if (ui.tab === 'memo') { ui.tab = state.view.ptab; renderChat(); }
    const box = $('#chatText');
    box.value = (box.value ? box.value + '\n' : '') + ui.dice[+el.dataset.i].text;
    box.focus();
  },
};

function bindEvents() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (el && A[el.dataset.act]) A[el.dataset.act](el, e);
  });
  for (const d of $$('dialog')) d.addEventListener('click', e => { if (e.target === d) d.close(); });
  $('#dlg').addEventListener('close', () => commit());
  // スマホ画面のプレビューは見出しをドラッグして動かせる
  $('#ppHead').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const box = $('#phonePreview'), head = e.currentTarget, r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = ev => {
      box.style.left = clamp(ev.clientX - dx, 0, innerWidth - 60) + 'px';
      box.style.top = clamp(ev.clientY - dy, 0, innerHeight - 40) + 'px';
      box.style.right = box.style.bottom = 'auto';
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });

  const readVal = el => el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? (el.value === '' ? '' : num(el.value)) : el.value;
  document.addEventListener('input', e => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    const w = walk(el.dataset.bind);
    if (!w) return;
    w[0][w[1]] = readVal(el);
    if (/^fg\.(cols|rows)$/.test(el.dataset.bind)) delete state.fg.ratio; // マス数を手で変えたら、その縦横比を基準にする
    if (el.dataset.bind.startsWith('bgm.')) applyBgm();
    if (el.dataset.bind === 'view.phone') { if (state.view.phone) { startPhoneHost(); openPhoneDlg(); } else stopPhoneHost(); }
    commit(el.type === 'checkbox');
  });
  // 「マスの大きさ」スライダー（右ほど大きい = マス数が少ない）
  $('#leftBody').addEventListener('input', e => { if (e.target.id === 'gridSize') { setGridCols(GRID_MIN + GRID_MAX - num(e.target.value)); commit(false); } });
  $('#leftBody').addEventListener('change', e => { if (e.target.id === 'gridSize') commit(); });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    const m = /^chars\.(\w+)\.status\.(\d+)\.value$/.exec(el.dataset.bind);
    if (m && el.dataset.prev !== String(el.value)) {
      const c = state.chars.find(x => x.id === m[1]), st = c && c.status[+m[2]];
      if (st && st.label) sysMsg(`${c.name}：${st.label} ${el.dataset.prev} → ${st.value}`, c.hidden || c.secretStatus);
      el.dataset.prev = String(el.value);
    }
    commit();
  });

  $('#fileImg').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; if ($('#picker').open) renderPicker(); commit(); });
  $('#fileAudio').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; commit(); });
  $('#fileSheet').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f && $('#ccText')) $('#ccText').value = await f.text(); });
  document.addEventListener('change', e => { if (e.target.matches('[data-sheet-all]')) { ui.sheetAll = e.target.checked; refreshDlg(); } });
  $('#fileImport').addEventListener('change', e => { if (e.target.files[0]) importRoom(e.target.files[0]); e.target.value = ''; });

  $('#chatForm').addEventListener('submit', e => { e.preventDefault(); sendChat(); });
  $('#chatText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); } });
  $('#diceForm').addEventListener('submit', e => { e.preventDefault(); if ($('#diceExpr').value.trim()) doRoll($('#diceExpr').value); });
  $('#diceBtns').innerHTML = DICE.map(d => `<button class="btn sm" data-act="roll" data-expr="${d}">${d.toUpperCase()}</button>`).join('');
}

/* ---------- プレイヤー画面 ---------- */
function initListHTML() {
  const s = state;
  return `<ul class="pinit">${order().map(c => {
    const st = (c.status || []).filter(x => x.label).map(x => `${esc(x.label)} ${esc(x.value)}${x.max !== '' && x.max != null ? '/' + esc(x.max) : ''}`).join('　');
    return `<li class="${s.turn.id === c.id ? 'turn' : ''}">${thumb(c.img, c.name)}<div style="min-width:0"><div class="n">${esc(c.name)}</div>${st ? `<div class="s">${st}</div>` : ''}</div><span class="i">${esc(c.init)}</span></li>`;
  }).join('')}</ul>`;
}
function renderPlayer() {
  if (IS_PHONE) return renderPhone();
  const s = state;
  document.title = s.room + '（プレイヤー画面）';
  $('#pHint').classList.add('off');

  let left = '';
  if (s.view.init && s.chars.length) left += `<div class="pbox"><h5><span>行動順</span><span>ラウンド ${s.turn.round}</span></h5>${initListHTML()}</div>`;
  if (s.view.memo && s.memo.pub) left += `<div class="pbox"><h5>メモ</h5><div class="pmemo">${esc(s.memo.pub)}</div></div>`;
  setHTML($('#pLeft'), left);

  const pc = $('#pChat');
  pc.hidden = !s.view.chat;
  if (!s.view.chat) return;
  const list = s.chat.filter(m => m.tab === s.view.ptab);
  setHTML(pc, `<div class="pbox"><nav class="tabs">${CHAT_TABS.slice(0, 3).map(([k, t]) => `<button class="${s.view.ptab === k ? 'on' : ''}">${t}</button>`).join('')}</nav>
    <div class="chat-log">${list.map(m => msgHTML(m, false)).join('') || '<div class="empty">まだ発言がありません</div>'}</div></div>`);
  const log = $('.chat-log', pc);
  log.scrollTop = log.scrollHeight;
}

function initPlayer() {
  const hint = $('#pHint');
  if (!HOST) { hint.textContent = 'GM画面の「プレイヤー画面を開く」ボタンから開いてください'; return; }
  hint.textContent = 'GM画面に接続しています… このウィンドウを外部モニターへ移し、ダブルクリックか F キーで全画面にできます';
  const full = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
  document.addEventListener('dblclick', full);
  document.addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') full(); });
  toGM({ type: 'hello' });
  setInterval(() => toGM({ type: 'ping' }), 3000); // GM画面が再読み込みされたときの再接続用
}

/* ---------- スマホ画面（プレイヤーが自分のスマホで見る。見るだけ） ---------- */
const ph = { view: { zoom: 1, panX: 0, panY: 0 }, tab: 'map', chat: 'main', name: '', ready: false, seen: { chat: 0, secret: 0 }, status: '接続中…', ok: false, peer: null, retry: 0 };
const PH_TABS = [['map', 'マップ'], ['chars', 'コマ'], ['chat', 'チャット'], ['memo', 'メモ'], ['sheet', 'シート']];
function renderPhone() {
  const s = state, whispers = s.whispers || [];
  document.title = s.room + '（スマホ）';
  const st = $('#phStatus');
  st.textContent = ph.status;
  st.className = 'tag ' + (ph.ok ? 'on' : 'secret');
  $('#phRoom').textContent = ph.ready ? s.room : '';

  // 自分のコマの手番になったら、上の見出しの色と文字を変えて知らせる（画面の配置は動かさない）
  const turnChar = s.chars.find(c => c.id === s.turn.id), myTurn = !!ph.name && !!turnChar && turnChar.name === ph.name;
  const head = $('#phHead');
  head.classList.toggle('myturn', myTurn);
  if (myTurn) $('#phRoom').textContent = 'あなたの手番です';
  if (myTurn && !ph.myTurn) {
    head.classList.remove('flash'); void head.offsetWidth; head.classList.add('flash'); // 変わった瞬間に点滅させる
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch { /* 振動できない機種でも色は変わる */ }
  }
  ph.myTurn = myTurn;
  // 自分のコマ（秘話の宛先）を選ぶ
  const sel = $('#phName'), names = s.chars.map(c => c.name);
  const opts = [['', '選んでください'], ...names.map(n => [n, n])];
  if (ph.name && !names.includes(ph.name)) opts.push([ph.name, ph.name]);
  setHTML(sel, opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''));
  sel.value = ph.name;

  // まだ見ていない発言があるタブに印を付ける
  const count = { chat: s.chat.length ? s.chat[s.chat.length - 1].t : 0, secret: whispers.length ? whispers[whispers.length - 1].t : 0 };
  // 秘話はチャットの中のタブ。見ているほう（秘話か、それ以外）を既読にする
  const inSecret = ph.chat === 'secret';
  if (ph.tab === 'chat') ph.seen[inSecret ? 'secret' : 'chat'] = count[inSecret ? 'secret' : 'chat'];
  const newSecret = count.secret > ph.seen.secret, unread = newSecret || count.chat > ph.seen.chat;
  setHTML($('#phTabs'), PH_TABS.map(([k, t]) => `<button class="${ph.tab === k ? 'on' : ''}" data-ptab="${k}">${t}${k === 'chat' && unread ? '<i class="dot"></i>' : ''}</button>`).join(''));

  const map = ph.tab === 'map', body = $('#phBody');
  // メモ：上が公開メモ、下がこのスマホだけに保存する自分メモ
  const memo = ph.tab === 'memo';
  $('#phMemo').hidden = !memo;
  if (memo) setHTML($('#phMemoPub'), ph.ready && s.memo.pub ? esc(s.memo.pub) : '<span class="empty">公開メモはありません</span>');
  $('.main').hidden = !map;
  body.hidden = map || memo;
  // 書き込めるのは雑談と、GM宛ての秘話（コマを選んでいるとき）
  const talk = ph.tab === 'chat' && ph.chat === 'chat', whisper = ph.tab === 'chat' && inSecret && !!ph.name;
  $('#phForm').hidden = !(ph.ready && (talk || whisper));
  $('#phText').placeholder = whisper ? 'GMへの秘話を書く' : '雑談に書き込む';
  if (map) return;
  let html = '';
  if (!ph.ready) html = `<div class="empty">${esc(ph.status)}</div>`;
  else if (ph.tab === 'chars') {
    html = s.chars.length ? `<div class="ph-sub">ラウンド ${s.turn.round}</div>${initListHTML()}` : '<div class="empty">コマがありません</div>';
  } else if (ph.tab === 'chat') {
    const list = s.chat.filter(m => m.tab === ph.chat);
    html = `<nav class="tabs ph-chat-tabs">${CHAT_TABS.map(([k, t]) => `<button class="${ph.chat === k ? 'on' : ''}" data-pchat="${k}">${t}${k === 'secret' && newSecret ? '<i class="dot"></i>' : ''}</button>`).join('')}</nav>
      <div class="chat-log">${inSecret ? (!ph.name ? '<div class="empty">上の「あなた」で自分のコマを選ぶと、あなた宛ての秘話がここに表示され、GMへ秘話を送れます</div>'
        : whispers.map(m => msgHTML(m, false)).join('') || '<div class="empty">あなた宛ての秘話はまだありません</div>')
        : !s.view.chat ? '<div class="empty">いまはチャットが非表示になっています</div>' : list.map(m => msgHTML(m, false)).join('') || '<div class="empty">まだ発言がありません</div>'}</div>`;
  } else if (ph.tab === 'sheet') {
    html = !ph.name ? '<div class="empty">上の「あなた」で自分のコマを選ぶと、探索者シートがここに表示されます</div>'
      : s.sheet ? sheetHTML(s.sheet, ph.sheetAll, true) : '<div class="empty">このコマには探索者シートが登録されていません</div>';
  } else {
    html = s.memo.pub ? `<div class="pmemo">${esc(s.memo.pub)}</div>` : '<div class="empty">公開メモはありません</div>';
  }
  if (body._h !== html) {
    body._h = html; body.innerHTML = html;
    const log = $('.chat-log', body);
    if (log) log.scrollTop = log.scrollHeight;
  }
}
function initPhone() {
  document.body.classList.add('phone');
  const app = $('.app'), head = $('#phHead'), body = $('#phBody'), tabs = $('#phTabs');
  app.prepend(head);
  app.append(body, $('#phMemo'), $('#phForm'), tabs);
  bindPhoneMemo();
  head.hidden = tabs.hidden = false;
  const sendTalk = () => { const box = $('#phText'), text = box.value.trim(); if (!text) return; toGM({ type: 'chat', tab: ph.chat === 'secret' ? 'secret' : 'chat', text }); box.value = ''; };
  $('#phForm').addEventListener('submit', e => { e.preventDefault(); sendTalk(); });
  $('#phText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); sendTalk(); } });
  document.addEventListener('change', e => { if (e.target.matches('[data-sheet-all]')) { ph.sheetAll = e.target.checked; renderPhone(); } });
  // ダイス：振るとGM画面で判定され、全員の画面で転がる。演出が見えるようにマップへ切り替える
  const dlg = $('#phDice'), btn = $('#phDiceBtn');
  btn.hidden = false;
  $('#phDiceBtns').innerHTML = DICE.map(d => `<button class="btn" type="button" data-pdice="${d}">${d.toUpperCase()}</button>`).join('');
  const rollNow = expr => {
    if (!gmConn || !gmConn.open) return toast('GM画面につながっていません');
    toGM({ type: 'roll', expr });
    if (dlg.open) dlg.close();
    ph.tab = 'map'; renderPhone(); renderBoard();
  };
  btn.addEventListener('click', () => dlg.showModal());
  dlg.addEventListener('close', () => { $('#phTarget').value = ''; $('#phExpr').value = ''; }); // 振ったあと・閉じたあとは入力を残さない
  dlg.addEventListener('click', e => {
    if (e.target === dlg || e.target.closest('[data-pclose]')) return dlg.close();
    const b = e.target.closest('[data-pdice]');
    if (!b) return;
    const t = num($('#phTarget').value, 0);
    rollNow(b.dataset.pdice === '1d100' && t > 0 ? `1d100<=${t}` : b.dataset.pdice);
  });
  $('#phDiceForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#phExpr').value.trim(); if (v) rollNow(v); });
  document.addEventListener('click', e => {
    const r = e.target.closest('[data-roll]');
    if (r && confirm(`「${r.dataset.roll.replace(/^CCB<=(\d+) (.*)$/, '$2（$1）')}」で振りますか？`)) rollNow(r.dataset.roll);
  });
  try { ph.name = localStorage.getItem('coc-sb-name-' + ROOM) || ''; } catch { /* 保存できなくても使える */ }
  $('#phName').addEventListener('change', e => {
    ph.name = e.target.value;
    try { localStorage.setItem('coc-sb-name-' + ROOM, ph.name); } catch { /* 同上 */ }
    toGM({ type: 'hello', name: ph.name });
    renderPhone();
  });
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-ptab]'), c = e.target.closest('[data-pchat]');
    if (t) ph.tab = t.dataset.ptab;
    if (c) ph.chat = c.dataset.pchat;
    if (t || c) { renderPhone(); renderBoard(); }
  });
  bindPhoneBoard();
  renderPhone();
  connectPhone();
}
// 指1本でマップを動かし、2本でつまんで拡大縮小する。ダブルタップで全体表示に戻す
function bindPhoneBoard() {
  const board = $('#board'), pts = new Map();
  let base = null;
  const mid = () => { const a = [...pts.values()], r = board.getBoundingClientRect(); return { x: a.reduce((n, p) => n + p.x, 0) / a.length - r.left, y: a.reduce((n, p) => n + p.y, 0) / a.length - r.top, d: a.length > 1 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0 }; };
  const grab = () => { base = pts.size ? { ...mid(), v: { ...ph.view }, s: scale } : null; };
  board.addEventListener('pointerdown', e => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { board.setPointerCapture(e.pointerId); } catch { /* つかめなくても動かせる */ } grab(); });
  board.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !base) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = mid(), z = clamp(base.v.zoom * (base.d && m.d ? m.d / base.d : 1), 1, ZOOM_MAX), s1 = base.s / base.v.zoom * z;
    // つかんだ場所（マップ上の点）が指の下に留まるように動かす
    const ox = lay.l + (lay.aw - lay.W * base.s) / 2 + base.v.panX * CELL * base.s, oy = 24 + (lay.ah - lay.H * base.s) / 2 + base.v.panY * CELL * base.s;
    const wx = (base.x - ox) / base.s, wy = (base.y - oy) / base.s;
    ph.view = { zoom: z, panX: (m.x - wx * s1 - lay.l - (lay.aw - lay.W * s1) / 2) / (CELL * s1), panY: (m.y - wy * s1 - 24 - (lay.ah - lay.H * s1) / 2) / (CELL * s1) };
    renderBoard();
  });
  const end = e => { pts.delete(e.pointerId); grab(); };
  board.addEventListener('pointerup', end);
  board.addEventListener('pointercancel', end);
  board.addEventListener('dblclick', () => { ph.view = { zoom: 1, panX: 0, panY: 0 }; renderBoard(); });
}
// 自分メモ：このスマホの中にだけ保存する（GM画面にも他の人にも送らない）。表計算のシートのようにページを増やせる
function bindPhoneMemo() {
  const KEY = 'coc-sb-memos-' + ROOM, box = $('#phMemoMine'), tabs = $('#phMemoPages');
  const memo = { pages: [{ name: 'メモ1', text: '' }], cur: 0, seq: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null'), old = localStorage.getItem('coc-sb-memo-' + ROOM); // old = ページ分けする前の形式
    if (saved && Array.isArray(saved.pages) && saved.pages.length) Object.assign(memo, saved);
    else if (old) memo.pages[0].text = old;
  } catch { /* 保存できなくても書ける */ }
  memo.cur = clamp(memo.cur | 0, 0, memo.pages.length - 1);
  const store = () => { try { localStorage.setItem(KEY, JSON.stringify(memo)); } catch { /* 同上 */ } };
  // 名前を付けていないページ（メモ1、メモ2…）は、追加や削除のたびに1から順に番号を振り直す
  const renumber = () => { let n = 0; for (const p of memo.pages) if (/^メモ\d+$/.test(p.name)) p.name = `メモ${++n}`; };
  const show = () => {
    renumber();
    tabs.innerHTML = memo.pages.map((p, i) => `<button type="button" class="${i === memo.cur ? 'on' : ''}" data-mpage="${i}">${esc(p.name)}</button>`).join('')
      + '<button type="button" data-madd title="ページを追加" aria-label="ページを追加">＋</button>';
    box.value = memo.pages[memo.cur].text;
    $('#phMemoDel').disabled = memo.pages.length < 2;
    const on = $('.on', tabs);
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  box.addEventListener('input', () => { memo.pages[memo.cur].text = box.value; store(); });
  tabs.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('madd' in b.dataset) { memo.pages.push({ name: 'メモ0', text: '' }); memo.cur = memo.pages.length - 1; }
    else if (+b.dataset.mpage === memo.cur) { // 開いているページをもう一度押すと名前を変えられる
      const name = prompt('ページの名前', memo.pages[memo.cur].name);
      if (name == null || !name.trim()) return;
      memo.pages[memo.cur].name = name.trim().slice(0, 20);
    } else memo.cur = +b.dataset.mpage;
    show(); store();
  });
  $('#phMemoClear').addEventListener('click', () => {
    const p = memo.pages[memo.cur];
    if (!p.text || !confirm(`「${p.name}」に書いた内容を消します。よろしいですか？`)) return;
    p.text = ''; show(); store();
  });
  $('#phMemoDel').addEventListener('click', () => {
    const p = memo.pages[memo.cur];
    if (memo.pages.length < 2 || !confirm(`ページ「${p.name}」を削除します。書いた内容も消えます。よろしいですか？`)) return;
    memo.pages.splice(memo.cur, 1);
    memo.cur = Math.min(memo.cur, memo.pages.length - 1);
    show(); store();
  });
  show();
}
function connectPhone() {  clearTimeout(ph.retry);
  if (IS_PREVIEW) { // プレビューはGM画面と直接やりとりする
    gmConn = { open: true, send: m => window.parent.postMessage(m, ORIGIN) };
    Object.assign(ph, { ok: true, ready: true, status: 'プレビュー' });
    toGM({ type: 'hello', name: ph.name });
    return renderPhone();
  }
  const again = msg => { // つながらない・切れたときは数秒おきにやり直す
    ph.ok = false; ph.status = msg; renderPhone();
    if (ph.peer) { const p = ph.peer; ph.peer = null; gmConn = null; p.destroy(); }
    clearTimeout(ph.retry);
    ph.retry = setTimeout(connectPhone, 4000);
  };
  loadLib('peer').then(() => {
    const peer = ph.peer = new Peer();
    peer.on('open', () => {
      const conn = gmConn = peer.connect(peerId(ROOM), { reliable: true });
      conn.on('open', () => { ph.ok = true; ph.status = '接続中'; ph.ready = true; toGM({ type: 'hello', name: ph.name }); renderPhone(); });
      conn.on('data', d => { if (d && d.coc === 1) onPlayerMsg(d); });
      conn.on('close', () => { if (ph.peer === peer) again('GM画面との接続が切れました。つなぎ直しています…'); });
      conn.on('error', () => { if (ph.peer === peer) again('GM画面につながりません。つなぎ直しています…'); });
    });
    peer.on('error', err => {
      if (ph.peer !== peer) return;
      again(err.type === 'peer-unavailable' ? 'GM画面が見つかりません。GMがスマホ接続を有効にしているか確認してください（自動でつなぎ直します）' : '接続できません。ネット接続を確認してください（自動でつなぎ直します）');
    });
    peer.on('disconnected', () => { if (ph.peer === peer && !gmConn?.open) again('接続が切れました。つなぎ直しています…'); });
  }, () => again('必要な部品を読み込めません。ネット接続を確認してください'));
}

/* ---------- 起動 ---------- */
async function init() {
  document.body.classList.toggle('player', IS_PLAYER);
  bindMsgWin();
  new ResizeObserver(() => renderBoard()).observe($('#board'));
  if (IS_PHONE) return initPhone();
  if (IS_PLAYER) return initPlayer();
  try {
    await DB.open();
    const s = await DB.get('kv', 'state');
    for (const [k, v] of await DB.all('assets')) blobs.set(k, v);
    if (s) loadState(s);
  } catch { toast('ブラウザの保存領域を開けませんでした。内容はこのタブを閉じると消えます'); }
  bindEvents();
  bindBoard();
  renderBoard(); renderLeft(); renderChat(); renderDice();
  renderPhoneStatus();
  startPhoneHost();
}
init();

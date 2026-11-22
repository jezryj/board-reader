/* BOARD Reader.
   A quiet e-reader for the iPad that is part of BOARD. Every book has its own notebook in BOARD (inside LIBRARY).
   Press and drag across the words to highlight; the highlight lands in that notebook as a card, in a column for its chapter,
   in page order. Tap the thought button to type a thought of your own, or hold it and talk; thoughts land beside the passage
   they are about, and look different from highlights so your own voice stands out.

   Where books come from: on the Mac, drop a PDF or an ebook onto LIBRARY in BOARD. The Mac turns it into readable text
   (library/<book>.json in the BOARD folder) and this app picks it up through Dropbox. Nothing passes through any other server.
   Offline: books you have opened are kept on the iPad, and what you highlight waits in a queue until the connection is back.

   Opened from the Mac's own BOARD (http://127.0.0.1:4747/reader/) it reads the same files directly, with no sign-in. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ settings
  const APP_KEY = '44iohoedl3b6t4h'; // the same Dropbox app as BOARD for iPhone and BOARD Capture
  const ROOT = '/BOARD';
  const VERSION = 'reader-0.2';
  const REDIRECT_READY = false; // true once this page's address is on the Dropbox app's list of allowed return addresses; until then, sign in with a code
  const COL_W = 320;            // a chapter column on the book's notebook
  const HOLD = 260;             // press this long (ms) without moving and the drag highlights instead of turning the page
  const COLORS = ['yellow', 'green', 'blue', 'pink'];
  const COVERS = ['#2f4858', '#5b3a29', '#3a4d39', '#6b2d2d', '#40395c', '#7a5c2e', '#1f3a4d', '#4b4640'];
  const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // tests can point the app at a pretend Dropbox on this computer
  const mockBase = (() => { const m = /[?&]mock=([^&]+)/.exec(location.search); return m && isLocalHost ? decodeURIComponent(m[1]) : ''; })();
  // served by BOARD on the Mac itself: the BOARD folder is right there, so no Dropbox and no sign-in
  const LOCAL = isLocalHost && !mockBase && /\/reader\//.test(location.pathname);
  // opened inside BOARD on the Mac (the book on the desk): no shelf, and closing the book hands back to BOARD
  const EMBED = window.parent !== window && /(^|[#&])embed=1/.test(location.hash);
  const tellBoard = (what) => { if (EMBED) try { window.parent.postMessage({ reader: what }, location.origin); } catch (e) { /* not inside BOARD */ } };
  if (EMBED) { document.documentElement.classList.add('embed'); addEventListener('DOMContentLoaded', () => { const sp = document.querySelector('#backBtn span'); if (sp) sp.textContent = 'Done'; }); }
  const HOST = LOCAL ? { api: location.origin + '/dbx', content: location.origin + '/dbx', www: '' } : mockBase ? { api: mockBase, content: mockBase, www: mockBase } : { api: 'https://api.dropboxapi.com', content: 'https://content.dropboxapi.com', www: 'https://www.dropbox.com' };
  const REDIRECT = location.origin + location.pathname + (mockBase ? '?mock=' + encodeURIComponent(mockBase) : '');

  // ------------------------------------------------------------------ small helpers
  const $ = (s, r) => (r || document).querySelector(s);
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-5);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* fine */ } } };
  const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const stampText = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]); // two places in a chapter: [paragraph, character]
  const plain = (html) => { const t = document.createElement('div'); t.innerHTML = String(html || '').replace(/<\/(div|p)>/gi, '$& '); return t.textContent.replace(/\s+/g, ' ').trim(); };
  const toastEl = $('#toast'), toastText = $('#toastText'), toastAct = $('#toastAct'); let toastT = 0;
  function toast(msg, action, fn, ms) {
    toastText.textContent = msg; toastEl.hidden = false; clearTimeout(toastT);
    toastAct.hidden = !action; toastAct.textContent = action || ''; toastAct.onclick = action ? () => { toastEl.hidden = true; fn(); } : null;
    toastT = setTimeout(() => { toastEl.hidden = true; }, ms || 2600);
  }

  // ------------------------------------------------------------------ what is kept on this iPad (IndexedDB): books, each book's notes, and what is waiting to go up
  const DB = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('board-reader', 2);
      r.onupgradeneeded = () => { const d = r.result; for (const n of ['books', 'notes', 'queue', 'pages']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (name, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(name, mode); const s = t.objectStore(name); let out; Promise.resolve(fn(s)).then((v) => { out = v; }); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return {
      get: (name, k) => tx(name, 'readonly', (st) => req(st.get(k))).catch(() => undefined),
      put: (name, k, v) => tx(name, 'readwrite', (st) => { st.put(v, k); }),
      del: (name, k) => tx(name, 'readwrite', (st) => { st.delete(k); }),
      all: (name) => tx(name, 'readonly', async (st) => { const vals = await req(st.getAll()); return vals.sort((a, b) => (a.at || 0) - (b.at || 0)); }).catch(() => []),
    };
  })();

  // ------------------------------------------------------------------ signing in to Dropbox (the same sign-in as BOARD for iPhone; no password ever reaches this page)
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const standalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  const signedIn = () => LOCAL || !!store.get('board.auth');
  async function startSignIn(byCode) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    store.set('reader.pkce', { verifier, byCode: !!byCode });
    const q = new URLSearchParams({ client_id: APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline' });
    if (!byCode) q.set('redirect_uri', REDIRECT);
    const url = HOST.www + '/oauth2/authorize?' + q;
    if (byCode) showCodeBox(url); else location.href = url;
  }
  async function finishSignIn(code) {
    const p = store.get('reader.pkce'); if (!p) throw new Error('Start the sign-in again.');
    const body = new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', client_id: APP_KEY, code_verifier: p.verifier });
    if (!p.byCode) body.set('redirect_uri', REDIRECT);
    let r; try { r = await fetch(HOST.api + '/oauth2/token', { method: 'POST', body }); } catch (e) { throw new Error('No connection. Try again when you are online.'); }
    if (!r.ok) throw new Error('Dropbox did not accept that code. Start the sign-in again.');
    const j = await r.json();
    store.set('board.auth', { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 14400) * 1000 - 60000, account: j.account_id || '' });
    store.del('reader.pkce');
  }
  let refreshing = null;
  async function token() {
    if (LOCAL) return 'local';
    const a = store.get('board.auth'); if (!a) throw Object.assign(new Error('signed out'), { signedOut: true });
    if (a.exp > Date.now()) return a.access;
    if (!refreshing) refreshing = (async () => {
      let r; try { r = await fetch(HOST.api + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: APP_KEY }) }); } catch (e) { throw Object.assign(new Error('offline'), { offline: true }); }
      if (r.status === 400 || r.status === 401) { store.del('board.auth'); throw Object.assign(new Error('signed out'), { signedOut: true }); }
      if (!r.ok) throw Object.assign(new Error('offline'), { offline: true });
      const j = await r.json(); a.access = j.access_token; a.exp = Date.now() + (j.expires_in || 14400) * 1000 - 60000; store.set('board.auth', a); return a.access;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  // ------------------------------------------------------------------ talking to Dropbox (or, on the Mac, to BOARD itself, which answers the same two calls)
  const argHeader = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4)); // headers must be plain ASCII
  async function call(url, opts, retried) {
    const t = await token();
    const headers = Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {});
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers })); } catch (e) { throw Object.assign(new Error('offline'), { offline: true }); }
    if (r.status === 401 && !retried && !LOCAL) { const a = store.get('board.auth'); if (a) { a.exp = 0; store.set('board.auth', a); } return call(url, opts, true); }
    if (r.status === 429 || r.status >= 500) { await sleep(1500); if (!retried) return call(url, opts, true); }
    return r;
  }
  async function download(path) {
    const r = await call(HOST.content + '/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': argHeader({ path }) } });
    if (!r.ok) throw Object.assign(new Error('download ' + r.status), { status: r.status, missing: r.status === 409 });
    let meta = {}; try { meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}'); } catch (e) { meta = {}; }
    return { text: await r.text(), rev: meta.rev || '' };
  }
  async function downloadBlob(path) { // a picture: the file itself, not its text
    const r = await call(HOST.content + '/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': argHeader({ path }) } });
    if (!r.ok) throw Object.assign(new Error('download ' + r.status), { status: r.status, missing: r.status === 409 });
    return r.blob();
  }
  async function upload(path, data, rev) {
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
    const r = await call(HOST.content + '/2/files/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': argHeader({ path, mode, autorename: false, mute: true, strict_conflict: !!rev }) }, body: data });
    if (r.status === 409) throw Object.assign(new Error('conflict'), { conflict: true });
    if (!r.ok) throw Object.assign(new Error('upload ' + r.status), { status: r.status });
    return r.json().catch(() => ({}));
  }

  // ------------------------------------------------------------------ state
  const S = { books: store.get('reader.index') || [], queued: 0, state: 'idle', lastError: '', color: store.get('reader.color') || 'yellow',
    size: clamp(store.get('reader.size') || 19, 14, 30), theme: store.get('reader.theme') || 'paper', have: new Set(store.get('reader.have') || []) };
  // the open book: R.book is its text, R.notes its highlights and thoughts
  const R = { book: null, pm: false, pg: [], notes: [], ch: 0, screen: 0, screens: 1, cur: null, side: null, sideCh: -1, sideDir: 0, n: 1, W: 0, M: 0, busy: false, idx: {}, words: new Map(), sel: null, pin: null };

  // ------------------------------------------------------------------ the notes of a book, as the reader holds them
  // One item: { id, kind: 'hl' | 'note' | 'voice', ch, a: [paragraph, character], b (highlights only), color, text, ref, dur, pending }
  function itemOf(c, bookId) {
    if (!c || typeof c !== 'object') return null;
    if (c.hl && c.hl.book === bookId && Array.isArray(c.hl.a) && Array.isArray(c.hl.b)) return { id: c.id, kind: 'hl', ch: c.hl.ch | 0, a: c.hl.a, b: c.hl.b, color: COLORS.includes(c.hl.color) ? c.hl.color : 'yellow', text: plain(c.html) };
    if (c.thought && c.at && c.at.book === bookId && Array.isArray(c.at.a)) return { id: c.id, kind: c.audio ? 'voice' : 'note', ch: c.at.ch | 0, a: c.at.a, ref: c.ref || '', text: c.audio ? ((c.transcript && c.transcript.text) || '') : plain(c.html), dur: c.dur || 0 };
    return null;
  }
  const itemsOfBoard = (b, bookId) => Object.values((b && b.cards) || {}).map((c) => itemOf(c, bookId)).filter(Boolean);
  function withPending(items, ops) { // what the notebook holds, plus what this iPad has not sent yet
    const out = new Map(items.map((i) => [i.id, i]));
    for (const op of ops) {
      if (op.kind === 'add') { const it = itemOf(op.card, op.book); if (it && !out.has(it.id)) out.set(it.id, Object.assign(it, { pending: true })); }
      else if (op.kind === 'del') out.delete(op.cardId);
      else if (op.kind === 'set' && out.has(op.cardId)) { const it = out.get(op.cardId); if (op.patch.hl) it.color = op.patch.hl.color; if (op.patch.html != null) it.text = plain(op.patch.html); }
    }
    return [...out.values()];
  }

  // ------------------------------------------------------------------ putting a card on the book's notebook: its chapter's column, in page order
  const placeOf = (c) => (c.hl && Array.isArray(c.hl.a) ? c.hl.a : c.at && Array.isArray(c.at.a) ? c.at.a : null);
  const maxZ = (b) => Object.values(b.cards).reduce((m, c) => Math.max(m, c.z || 0), 0);
  function ensureColumn(b, book, ch, now) {
    const cards = b.cards;
    const cols = Object.values(cards).filter((c) => c.type === 'column' && c.book === book.id && typeof c.ch === 'number');
    let col = cols.find((c) => c.ch === ch); if (col) return col;
    col = { id: 'c' + rid(), type: 'column', title: ((book.chapters || [])[ch] || {}).t || 'Chapter ' + (ch + 1), ch, book: book.id, x: 0, y: 0, w: COL_W, z: maxZ(b) + 1, m: now, born: now };
    // the chapter columns are joined into one run, in chapter order (BOARD's joined columns: c.join is the column to the left)
    const runs = [], seen = new Set();
    for (const c of cols) {
      if (seen.has(c.id)) continue;
      let head = c; const guard = new Set();
      while (head.join && cols.includes(cards[head.join]) && !guard.has(head.id)) { guard.add(head.id); head = cards[head.join]; }
      const run = []; let cur = head;
      while (cur && !seen.has(cur.id)) { seen.add(cur.id); run.push(cur); cur = cols.find((k) => k.join === cur.id && !seen.has(k.id)); }
      if (run.length) runs.push(run);
    }
    runs.sort((x, y) => y.length - x.length);
    const run = runs[0];
    if (!run) { // the first column: beside the book itself, tops level, so the notebook reads book first, then the notes
      const file = Object.values(cards).find((c) => c.url === book.file && !c.col);
      if (file) { col.x = (file.x || 0) + (file.w || 260) + 24; col.y = file.y || 0; }
    }
    if (run) {
      const head = run[0]; let after = null;
      for (const k of run) if (k.ch < ch) after = k;
      if (after) { const i = run.indexOf(after), next = run[i + 1]; col.join = after.id; if (next) { next.join = col.id; next.m = now; } run.splice(i + 1, 0, col); }
      else { col.x = head.x; col.y = head.y; if (head.join) col.join = head.join; head.join = col.id; head.m = now; run.unshift(col); }
      const w = head.w || COL_W; let x = run[0].x; const y = run[0].y;
      for (const k of run) { if (k.x !== x || k.y !== y || k.w !== w) { k.x = x; k.y = y; k.w = w; if (k !== col) k.m = now; } x += w; }
    }
    cards[col.id] = col;
    return col;
  }
  function placeInColumn(b, col, c, now) {
    const cards = b.cards;
    const kids = Object.values(cards).filter((k) => k.col === col.id).sort((x, y) => (x.ord || 0) - (y.ord || 0));
    let i = kids.length;
    if (c.ref && cards[c.ref] && cards[c.ref].col === col.id) { i = kids.indexOf(cards[c.ref]) + 1; while (i < kids.length && kids[i].ref === c.ref) i++; } // a thought about a highlight sits right under it
    else {
      const key = placeOf(c);
      for (let k = 0; k < kids.length; k++) { const p = placeOf(kids[k]); if (p && key && cmp(p, key) > 0) { i = k; break; } }
      while (i > 0 && i < kids.length && kids[i].ref && kids[i].ref === kids[i - 1].id) i++; // never between a highlight and its thought
    }
    kids.splice(i, 0, c);
    kids.forEach((k, n) => { k.ord = n; });
    Object.assign(c, { col: col.id, x: 0, y: 0, z: maxZ(b) + 1, m: now, born: c.born || now });
    cards[c.id] = c;
  }
  function applyOps(b, book, ops, now) {
    now = now || Date.now();
    if (!b.cards || typeof b.cards !== 'object') b.cards = {};
    for (const op of ops) {
      if (op.kind === 'add') {
        if (b.cards[op.card.id]) continue; // a second try must not add the same card twice
        const c = JSON.parse(JSON.stringify(op.card)), at = c.hl || c.at;
        placeInColumn(b, ensureColumn(b, book, at.ch | 0, now), c, now);
      } else if (op.kind === 'del') { delete b.cards[op.cardId]; }
      else if (op.kind === 'set') { const c = b.cards[op.cardId]; if (c) { for (const [k, v] of Object.entries(op.patch)) c[k] = k === 'hl' ? Object.assign({}, c.hl, v) : v; c.m = now; } }
    }
    return b;
  }

  // ------------------------------------------------------------------ the queue: highlights and thoughts on their way to BOARD
  // One entry: { id, at, book, kind: 'add' | 'del' | 'set', card | cardId (+ patch), file: { name, blob }, up }
  async function enqueue(op) {
    op.id = 'q' + rid(); op.at = Date.now();
    await DB.put('queue', op.id, op); S.queued++; paintStatus();
    setTimeout(flush, 400); // a moment's grace, so a colour picked straight after highlighting rides along
    return op.id;
  }
  let flushing = null;
  function flush() { if (!flushing) flushing = doFlush().finally(() => { flushing = null; }); return flushing; }
  async function doFlush() {
    if (!signedIn()) return;
    const all = await DB.all('queue'); S.queued = all.length; if (!all.length) { paintStatus(); return; }
    S.state = 'sending'; paintStatus();
    try {
      const byBook = new Map(); for (const op of all) { if (!byBook.has(op.book)) byBook.set(op.book, []); byBook.get(op.book).push(op); }
      for (const [bookId, ops] of byBook) {
        for (const op of ops) {
          if (!op.file || op.up) continue;
          try { await upload(ROOT + '/assets/' + op.file.name, op.file.blob, null); } catch (e) { if (!e.conflict) throw e; } // already there from an earlier try
          op.up = true; await DB.put('queue', op.id, op);
        }
        const book = (await DB.get('books', bookId)) || { id: bookId, chapters: [] };
        const path = ROOT + '/boards/' + (book.board || 'bk-' + bookId) + '.json';
        let done = null;
        for (let attempt = 0; attempt < 5 && !done; attempt++) {
          const { text, rev } = await download(path);
          const b = JSON.parse(text); if (!b || typeof b.cards !== 'object') throw new Error('This book’s notebook is not readable');
          applyOps(b, book, ops);
          try { await upload(path, new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' }), rev); done = b; }
          catch (e) { if (!e.conflict) throw e; } // the Mac saved it in the meantime: read it again and retry
        }
        if (!done) throw new Error('The notebook kept changing');
        tellBoard('saved');
        for (const op of ops) { await DB.del('queue', op.id); S.queued--; }
        const rest = (await DB.all('queue')).filter((o) => o.book === bookId);
        await keepNotes(bookId, withPending(itemsOfBoard(done, bookId), rest));
        paintStatus();
      }
      S.state = 'sent'; S.lastError = '';
    } catch (e) {
      if (e.signedOut) { S.state = 'waiting'; showSignIn(); }
      else { S.state = e.offline ? 'waiting' : 'error'; S.lastError = e.offline ? '' : e.missing ? 'This book’s notebook is missing in BOARD' : String(e.message || e); if (!e.offline) console.warn(e); }
    }
    S.queued = (await DB.all('queue')).length;
    if (S.queued && S.state === 'sent') S.state = 'waiting';
    paintStatus();
    if (S.queued && S.state !== 'error') setTimeout(flush, S.lastError || !navigator.onLine ? 15000 : 500); // something was added while this was sending
  }
  function paintStatus() {
    const dot = $('#dot'), t = $('#statusText');
    if (S.state === 'sending') { dot.dataset.s = 'sending'; t.textContent = 'Sending'; }
    else if (S.queued > 0) { dot.dataset.s = S.state === 'error' ? 'error' : 'waiting'; t.textContent = S.queued + ' waiting'; }
    else if (S.state === 'sent') { dot.dataset.s = 'sent'; t.textContent = 'Sent to BOARD'; }
    else { dot.dataset.s = 'idle'; t.textContent = 'Up to date'; }
  }
  window.addEventListener('online', () => { flush(); loadShelf(); });
  async function keepNotes(bookId, items) {
    await DB.put('notes', bookId, items);
    if (R.book && R.book.id === bookId) { R.notes = items; R.idx = {}; if (!R.sel) repaint(); }
  }
  // read the notebook again: a highlight removed or moved in BOARD goes from the page here too
  async function syncNotes(bookId) {
    const book = await DB.get('books', bookId); if (!book) return;
    try {
      const { text } = await download(ROOT + '/boards/' + (book.board || 'bk-' + bookId) + '.json');
      const rest = (await DB.all('queue')).filter((o) => o.book === bookId);
      await keepNotes(bookId, withPending(itemsOfBoard(JSON.parse(text), bookId), rest));
    } catch (e) { if (e.signedOut) showSignIn(); }
  }

  // ------------------------------------------------------------------ the shelf
  const hash = (s) => { let n = 0; for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0; return n; };
  function paintShelf() {
    const box = $('#books'); box.textContent = '';
    $('#empty').hidden = S.books.length > 0;
    const books = S.books.slice().sort((a, b) => ((store.get('reader.pos.' + b.id) || {}).when || b.added || 0) - ((store.get('reader.pos.' + a.id) || {}).when || a.added || 0)); // the one you were last reading comes first
    for (const bk of books) {
      const el = h('button', 'bk' + (S.have.has(bk.id) ? '' : ' wait')); el.type = 'button'; el.dataset.id = bk.id;
      const cover = h('div', 'cover'); cover.style.background = COVERS[hash(bk.id) % COVERS.length];
      cover.append(h('div', 'ct', bk.title || 'Untitled'), h('div', 'ca', bk.author || ''), h('div', 'ck', (bk.kind || '').toUpperCase()));
      const pos = store.get('reader.pos.' + bk.id), meta = h('div', 'meta'), bar = h('div', 'bar'), fill = h('i');
      fill.style.width = Math.round(((pos && pos.pct) || 0) * 100) + '%'; bar.append(fill);
      meta.append(bar, h('span', '', pos && pos.pct ? Math.round(pos.pct * 100) + '%' : S.have.has(bk.id) ? 'New' : 'Coming'));
      el.append(cover, meta);
      el.addEventListener('click', () => openBook(bk.id));
      box.append(el);
    }
  }
  let loadingShelf = null;
  function loadShelf() { if (!loadingShelf) loadingShelf = doLoadShelf().finally(() => { loadingShelf = null; }); return loadingShelf; }
  async function doLoadShelf() {
    if (!signedIn()) return;
    try {
      let idx = { books: [] };
      try { idx = JSON.parse((await download(ROOT + '/library/index.json')).text); } catch (e) { if (!e.missing) throw e; } // no library yet: an empty shelf
      S.books = Array.isArray(idx.books) ? idx.books : []; store.set('reader.index', S.books); paintShelf();
      for (const bk of S.books) { // bring each book's text onto the iPad, so it opens offline
        const mine = await DB.get('books', bk.id);
        if (mine && mine.made === bk.made) { S.have.add(bk.id); continue; }
        try {
          const book = JSON.parse((await download(ROOT + '/library/' + bk.id + '.json')).text);
          if (book.view === 'pages') await DB.put('books', bk.id + '/pages', { made: book.made, pages: JSON.parse((await download(ROOT + '/library/' + bk.id + '/pages.json')).text).pages }); // where the words sit on each page
          await DB.put('books', bk.id, book); S.have.add(bk.id);
        } catch (e) { if (e.offline || e.signedOut) throw e; }
        store.set('reader.have', [...S.have]); paintShelf();
      }
      store.set('reader.have', [...S.have]); paintShelf();
    } catch (e) { if (e.signedOut) showSignIn(); }
  }

  // ------------------------------------------------------------------ the page: one chapter at a time, set in columns the size of the screen
  const bookEl = $('#book'), page = $('#page'), shadeEl = $('#turnshade');
  const probe = h('div'); probe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom) 0'; document.body.append(probe);
  function measure() {
    const W = window.innerWidth, H = window.innerHeight;
    R.n = W >= 900 && W > H * 1.15 ? 2 : 1;                       // on its side, the iPad shows two pages like an open book
    R.M = R.n === 2 ? Math.round(clamp(W * 0.045, 40, 72)) : Math.round(clamp(W * 0.075, 26, 96));
    R.W = W;
    const ps = getComputedStyle(probe), sat = parseFloat(ps.paddingTop) || 0, sab = parseFloat(ps.paddingBottom) || 0; // the notch and the home bar
    page.style.left = '0'; page.style.right = '0'; page.style.top = (Math.max(sat, 10) + (R.pm ? 6 : 40)) + 'px'; page.style.bottom = (sab + (R.pm ? 34 : 44)) + 'px';
    bookEl.classList.toggle('two', R.n === 2);
    // the thought button lives in the right-hand margin, clear of the words; on a narrow screen it drops into the foot of the page
    const tbtn = $('#thoughtBtn'), inMargin = R.pm ? PM.sideRoom() >= 52 : R.M >= 46;
    if (R.pm && inMargin) R.M = PM.sideRoom();
    tbtn.classList.toggle('low', !inMargin); tbtn.style.right = inMargin ? Math.round((R.M - 40) / 2) + 'px' : ''; tbtn.style.top = inMargin ? Math.round(H * 0.6) + 'px' : '';
    document.documentElement.style.setProperty('--size', S.size + 'px');
    for (const f of [$('#flowA'), $('#flowB')]) { f.style.left = R.M + 'px'; f.style.width = (W - 2 * R.M) + 'px'; f.style.columnCount = R.n; f.style.columnGap = (2 * R.M) + 'px'; }
  }
  const colW = () => R.W / R.n - 2 * R.M;
  function screensOf(flow) { const cols = Math.max(1, Math.round((flow.scrollWidth + 2 * R.M) / (colW() + 2 * R.M))); return Math.ceil(cols / R.n); }
  const setX = (flow, x) => { flow.style.transform = 'translate3d(' + x + 'px,0,0)'; };

  // highlights and thoughts by paragraph, for one chapter
  function indexOf(ch) {
    if (R.idx[ch]) return R.idx[ch];
    const m = new Map(), put = (bi, v) => { if (!m.has(bi)) m.set(bi, []); m.get(bi).push(v); };
    const byId = new Map(R.notes.map((n) => [n.id, n]));
    for (const n of R.notes) {
      if (n.ch !== ch) continue;
      if (n.kind === 'hl') { for (let bi = n.a[0]; bi <= n.b[0]; bi++) put(bi, n); }
      else { const ref = n.ref && byId.get(n.ref); put(ref && ref.ch === ch ? ref.b[0] : n.a[0], n); }
    }
    return (R.idx[ch] = m);
  }
  function blockHTML(ch, bi) {
    const b = R.book.chapters[ch].blocks[bi], text = b.t, len = text.length;
    const spans = [], marks = [], cuts = new Set([0, len]);
    const add = (s, e, cls, id) => { s = clamp(s, 0, len); e = clamp(e, 0, len); if (e > s) { spans.push({ s, e, cls, id }); cuts.add(s); cuts.add(e); } };
    for (const [s, e] of b.i || []) add(s, e, 'i');
    for (const [s, e] of b.b || []) add(s, e, 'b');
    const byId = new Map(R.notes.map((n) => [n.id, n]));
    for (const n of indexOf(ch).get(bi) || []) {
      if (n.kind === 'hl') add(n.a[0] < bi ? 0 : n.a[1], n.b[0] > bi ? len : n.b[1], 'hl c-' + n.color, n.id);
      else {
        // the mark goes after a word, never before one: at the start of a line it would be left behind on the line (or page) before
        const ref = n.ref && byId.get(n.ref); let o = clamp(ref ? ref.b[1] : n.a[1], 0, len);
        if (!ref) { const e = text.slice(o).search(/\s/); o = e < 0 ? len : o + e; }
        marks.push({ o, id: n.id, voice: n.kind === 'voice' }); cuts.add(o);
      }
    }
    if (R.sel && ch === R.ch && bi >= R.sel.a[0] && bi <= R.sel.b[0]) add(R.sel.a[0] < bi ? 0 : R.sel.a[1], R.sel.b[0] > bi ? len : R.sel.b[1], 'sel');
    const pts = [...cuts].sort((x, y) => x - y); let out = '';
    const mark = (o) => marks.filter((m) => m.o === o).map((m) => '<span class="tm' + (m.voice ? ' voice' : '') + '" data-t="' + esc(m.id) + '"></span>').join('');
    for (let k = 0; k < pts.length - 1; k++) {
      const s = pts[k], e = pts[k + 1], on = spans.filter((p) => p.s <= s && p.e >= e), hl = on.filter((p) => p.id).pop();
      out += mark(s) + '<span data-o="' + s + '"' + (on.length ? ' class="' + [...new Set(on.map((p) => p.cls))].join(' ') + '"' : '') + (hl ? ' data-id="' + esc(hl.id) + '"' : '') + '>' + esc(text.slice(s, e)) + '</span>';
    }
    return out + mark(len);
  }
  function renderChapter(flow, ch) {
    const c = R.book.chapters[ch]; let html = '';
    const script = c.blocks.some((b) => b.in), plainSet = !script && R.book.kind === 'pdf' && R.book.ocr;
    flow.className = 'flow' + (script ? ' script' : plainSet ? ' plain' : '');
    c.blocks.forEach((b, bi) => { html += '<p data-b="' + bi + '"' + (b.k === 'h' ? ' class="h"' : '') + (b.in ? ' style="margin-left:' + Math.round(b.in * 62) + '%"' : '') + '>' + blockHTML(ch, bi) + '</p>'; });
    flow.innerHTML = html; flow._ch = ch; flow._screens = screensOf(flow);
  }
  // paint the paragraphs again where highlights or thoughts changed (the words do not move, so the pages stay put)
  function repaint(from, to) {
    if (R.pm) { PM.repaint(); return; }
    if (!R.book || !R.cur) return;
    for (const p of R.cur.children) { const bi = +p.dataset.b; if (from != null && (bi < from || bi > to)) continue; const html = blockHTML(R.ch, bi); if (p._html !== html) { p.innerHTML = html; p._html = html; } }
  }
  // which screen of the chapter holds this place
  function screenOfPlace(flow, bi, o) {
    const p = flow.children[bi]; if (!p) return 0;
    let x = null;
    const span = [...p.querySelectorAll('span[data-o]')].reverse().find((s) => +s.dataset.o <= (o || 0));
    if (span && span.firstChild) { const r = document.createRange(); const off = clamp((o || 0) - +span.dataset.o, 0, span.firstChild.length); r.setStart(span.firstChild, off); r.setEnd(span.firstChild, Math.min(span.firstChild.length, off + 1)); const rc = r.getClientRects()[0]; if (rc) x = rc.left; }
    if (x == null) { const rc = p.getClientRects()[0]; if (!rc) return 0; x = rc.left; }
    const fx = flow.getBoundingClientRect().left;
    return clamp(Math.floor((x - fx + R.M) / R.W), 0, flow._screens - 1);
  }
  // the first word showing on the screen: where you are
  function whereNow() {
    if (R.pm) return [PM.first(R.screen), 0];
    for (const p of R.cur.children) {
      let showing = false;
      for (const r of p.getClientRects()) if (r.width > 0 && r.left >= -2 && r.left < R.W) { showing = true; break; }
      if (!showing) continue;
      for (const w of wordsOf(+p.dataset.b)) if (w.first && w.r.left >= -2 && w.r.left < R.W) return [+p.dataset.b, w.s]; // the tail of a word that began on the page before does not count
    }
    return [0, 0];
  }
  // every word of a paragraph with its place on the screen (worked out when needed, forgotten when the page moves)
  function wordsOf(bi) {
    if (R.words.has(bi)) return R.words.get(bi);
    const out = [], p = R.cur.children[bi], range = document.createRange();
    if (p) for (const span of p.querySelectorAll('span[data-o]')) {
      const tn = span.firstChild; if (!tn || tn.nodeType !== 3) continue; const base = +span.dataset.o, re = /[^\s—]+/g; let m;
      while ((m = re.exec(tn.data))) { range.setStart(tn, m.index); range.setEnd(tn, m.index + m[0].length); let first = true; for (const r of range.getClientRects()) if (r.width > 0) { out.push({ s: base + m.index, e: base + m.index + m[0].length, r, first }); first = false; } } // a word broken over two lines has two pieces
    }
    R.words.set(bi, out);
    return out;
  }
  function wordAt(x, y) {
    if (R.pm) return PM.wordAt(x, y);
    let best = null, bd = Infinity;
    const el = document.elementFromPoint(x, y), hit = el && el.closest && el.closest('p[data-b]');
    const ps = hit && R.cur.contains(hit) ? [hit] : [...R.cur.children].filter((p) => [...p.getClientRects()].some((r) => r.right > 0 && r.left < R.W));
    for (const p of ps) for (const w of wordsOf(+p.dataset.b)) {
      const r = w.r; if (r.right < 0 || r.left > R.W) continue;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0, d = dx + dy * 3; // being on the right line matters more than being on the right word
      if (d < bd) { bd = d; best = { bi: +p.dataset.b, s: w.s, e: w.e, r }; }
    }
    return bd < 90 ? best : null;
  }

  function settle() { // after any move: where are we, what does the footer say
    R.words.clear();
    const c = R.book.chapters[R.ch], at = whereNow(), blk = c.blocks[at[0]] || {};
    const pct = clamp((R.before[R.ch] + (R.inCh[R.ch][at[0]] || 0) + at[1]) / Math.max(R.total, 1), 0, 1);
    const last = R.ch === R.book.chapters.length - 1 && R.screen === R.screens - 1;
    store.set('reader.pos.' + R.book.id, { ch: R.ch, bi: at[0], o: at[1], pct: last ? 1 : pct, when: Date.now() });
    $('#footCh').textContent = c.t || ''; $('#barTitle').textContent = R.book.title + (c.t ? '  ·  ' + c.t : '');
    $('#footPg').textContent = (blk.p ? 'p. ' + blk.p : (R.screen + 1) + ' of ' + R.screens) + '  ·  ' + Math.round((last ? 1 : pct) * 100) + '%';
    $('#progressFill').style.width = ((last ? 1 : pct) * 100) + '%';
    readyNeighbour();
  }
  // show a chapter at a place: { bi, o }, 'end', or the start
  function show(ch, place) {
    ch = clamp(ch, 0, R.book.chapters.length - 1);
    R.sel = null; R.words.clear(); hidePop();
    if (R.pm) { PM.show(ch, place); return; }
    R.cur.classList.remove('slide'); R.side.classList.remove('slide'); R.side.hidden = true; R.sideCh = -1; R.side.textContent = ''; R.cur.hidden = false;
    renderChapter(R.cur, ch); R.ch = ch; R.screens = R.cur._screens;
    R.screen = place === 'end' ? R.screens - 1 : place && place.bi != null ? (setX(R.cur, 0), screenOfPlace(R.cur, place.bi, place.o)) : 0;
    setX(R.cur, -R.screen * R.W); shadeEl.style.opacity = 0;
    settle();
  }
  // at the first or last screen of a chapter, set the neighbouring chapter up out of sight, so the turn across is seamless
  function readyNeighbour(dir) {
    const want = dir || (R.screen === R.screens - 1 ? 1 : R.screen === 0 ? -1 : 0), ch = R.ch + want;
    if (!want || ch < 0 || ch >= R.book.chapters.length) return false;
    if (R.sideCh !== ch) { renderChapter(R.side, ch); R.sideCh = ch; }
    R.sideDir = want; R.side._at = want > 0 ? 0 : R.side._screens - 1;
    R.side.hidden = true; setX(R.side, -R.side._at * R.W + want * R.W);
    return true;
  }
  const canTurn = (dir) => (R.screen + dir >= 0 && R.screen + dir < R.screens) || (R.ch + dir >= 0 && R.ch + dir < R.book.chapters.length);
  // move the page(s) with the finger: dx is how far it has been dragged
  function dragTo(dx) {
    if (R.pm) { PM.dragTo(dx); return; }
    const dir = dx < 0 ? 1 : -1, inside = R.screen + dir >= 0 && R.screen + dir < R.screens;
    if (inside) R.side.hidden = true;
    if (!inside && !(readyNeighbour(dir))) dx *= 0.28; // the end of the book: it gives a little, and no more
    else if (!inside) { R.side.hidden = false; setX(R.side, -R.side._at * R.W + dir * R.W + dx); }
    setX(R.cur, -R.screen * R.W + dx);
    shadeEl.style.opacity = clamp(Math.abs(dx) / 80, 0, 1); shadeEl.style.transform = 'translate3d(' + ((dx < 0 ? R.W + dx : dx) - 46) + 'px,0,0)';
  }
  // finish a turn (dir 1 forward, -1 back, 0 fall back to where it was). dragged: the finger has already moved the page part of the way
  function turn(dir, dragged) {
    if (R.busy || !R.book) return; hidePop();
    if (R.pm) { PM.turn(dir, dragged); return; }
    if (dir && !canTurn(dir)) dir = 0;
    if (!dir && !dragged) return;
    const inside = dir && R.screen + dir >= 0 && R.screen + dir < R.screens, cross = dir && !inside && readyNeighbour(dir);
    R.busy = true;
    if (dir && !dragged) { shadeEl.style.opacity = 0.9; shadeEl.style.transform = 'translate3d(' + ((dir > 0 ? R.W : 0) - 46) + 'px,0,0)'; if (cross) { R.side.hidden = false; setX(R.side, -R.side._at * R.W + dir * R.W); } }
    void R.cur.offsetWidth; // start the slide from where things are now
    for (const el of [R.cur, R.side, shadeEl]) el.classList.add('slide');
    if (cross) { R.side.hidden = false; setX(R.side, -R.side._at * R.W); setX(R.cur, -R.screen * R.W - dir * R.W); }
    else { if (inside) R.screen += dir; setX(R.cur, -R.screen * R.W); if (R.sideDir && !R.side.hidden) setX(R.side, -R.side._at * R.W + R.sideDir * R.W); }
    shadeEl.style.opacity = 0; if (dir) shadeEl.style.transform = 'translate3d(' + ((dir > 0 ? 0 : R.W) - 46) + 'px,0,0)';
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      for (const el of [R.cur, R.side, shadeEl]) el.classList.remove('slide');
      if (cross) { const old = R.cur; R.cur = R.side; R.side = old; R.ch += dir; R.screens = R.cur._screens; R.screen = R.cur._at; R.sideCh = old._ch; old.hidden = true; R.sel = null; }
      else R.side.hidden = true;
      R.busy = false; settle();
    };
    R.cur.addEventListener('transitionend', (e) => { if (e.target === R.cur || e.target === R.side) finish(); }, { once: true }); setTimeout(finish, 420);
  }

  // ------------------------------------------------------------------ real pages: a PDF is read as the pages it was printed on
  // Each page is a picture (library/<book>/p0001.jpg, drawn on the Mac). The words of the page and where each one sits come
  // with the book (pages.json), so a finger on the picture can be matched to the words under it, and a highlight is painted
  // over the real page like a highlighter on paper. A place in such a book is [page number, which word on that page].
  const pv = $('#pv');
  const view = () => (R.pm ? pv : R.cur);
  const PM = {
    slots: [], urls: new Map(), loading: new Map(), wc: new Map(),
    reset() { for (const u of PM.urls.values()) URL.revokeObjectURL(u); PM.urls.clear(); PM.loading.clear(); PM.wc.clear(); PM.slots = []; },
    total: () => R.book.pageCount || R.pg.length || 1,
    screens: () => Math.ceil(PM.total() / R.n),
    first: (screen) => screen * R.n + 1,
    chOf(n) { const cs = R.book.chapters; for (let i = 0; i < cs.length; i++) if (n >= cs[i].from && n <= cs[i].to) return i; return cs.length - 1; },
    size(n) { // as big as the screen allows, in the page's own shape
      const ar = (R.pg[n - 1] || {}).ar || 0.7727, H = page.clientHeight || window.innerHeight, W = (R.W - 16) / R.n, hh = Math.min(H, W / ar);
      return { w: Math.floor(hh * ar), h: Math.floor(hh) };
    },
    sideRoom() { const sz = PM.size(PM.first(R.screen || 0)); return Math.floor((R.W - sz.w * R.n) / 2); },
    // the words of a page in reading order: { t, x, y, w, h (fractions of the page), li (its line), end (last on its line) }
    words(n) {
      let ws = PM.wc.get(n); if (ws) return ws; ws = [];
      ((R.pg[n - 1] || {}).lines || []).forEach((l, li) => {
        let parts = Array.isArray(l.ws) && l.ws.length ? l.ws.map((w) => ({ s: w[0], e: w[1], x: w[2], w: w[3] })) : null;
        if (!parts) { parts = []; const re = /\S+/g, len = Math.max(l.t.length, 1); let m; while ((m = re.exec(l.t))) parts.push({ s: m.index, e: m.index + m[0].length, x: l.x + l.w * m.index / len, w: l.w * m[0].length / len }); } // no word places: share the line out by letters
        parts.forEach((p, k) => ws.push({ t: l.t.slice(p.s, p.e), x: p.x, w: p.w, y: l.y, h: l.h, li, end: k === parts.length - 1 }));
      });
      PM.wc.set(n, ws); return ws;
    },
    // a page's picture: from this device if it has been seen before, otherwise fetched and kept
    load(n) {
      const key = R.book.id + '/' + R.book.made + '/' + n;
      if (PM.urls.has(key)) return Promise.resolve(PM.urls.get(key));
      if (PM.loading.has(key)) return PM.loading.get(key);
      const bookId = R.book.id;
      const p = (async () => {
        let blob = await DB.get('pages', key);
        if (!blob) { blob = await downloadBlob(ROOT + '/library/' + bookId + '/p' + String(n).padStart(4, '0') + '.jpg'); DB.put('pages', key, blob).catch(() => { /* no room: it is fetched again next time */ }); }
        const url = URL.createObjectURL(blob); PM.urls.set(key, url);
        if (PM.urls.size > 30) { const [k, u] = PM.urls.entries().next().value; URL.revokeObjectURL(u); PM.urls.delete(k); }
        return url;
      })().finally(() => PM.loading.delete(key));
      PM.loading.set(key, p); return p;
    },
    box(n) {
      const el = h('div', 'pgbox'), sz = PM.size(n), img = new Image();
      el.dataset.n = n; el.style.width = sz.w + 'px'; el.style.height = sz.h + 'px';
      img.alt = ''; img.draggable = false; img.decoding = 'async';
      el.append(img, h('div', 'ov'));
      PM.load(n).then((url) => { img.src = url; }, () => { if (!el.querySelector('.nopic')) el.append(h('div', 'nopic', 'Page ' + n + ' has not arrived yet')); });
      PM.paint(el);
      return el;
    },
    fill(slot, screen) {
      slot._screen = screen; slot.textContent = '';
      if (screen < 0 || screen >= PM.screens()) return;
      for (let k = 0; k < R.n; k++) { const n = PM.first(screen) + k; if (n <= PM.total()) slot.append(PM.box(n)); }
    },
    place(dx) { PM.slots.forEach((sl, i) => { sl.style.transform = 'translate3d(' + ((i - 1) * R.W + (dx || 0)) + 'px,0,0)'; }); },
    show(ch, place) {
      const c = R.book.chapters[ch], n = clamp(place === 'end' ? c.to : place && place.bi != null ? place.bi : c.from, 1, PM.total());
      R.screens = PM.screens(); R.screen = clamp(Math.floor((n - 1) / R.n), 0, R.screens - 1);
      pv.textContent = ''; PM.slots = [0, 1, 2].map(() => { const sl = h('div', 'pscreen'); pv.append(sl); return sl; });
      PM.slots.forEach((sl, i) => PM.fill(sl, R.screen + i - 1)); PM.place(0); shadeEl.style.opacity = 0;
      PM.settle();
    },
    settle() {
      const n = PM.first(R.screen), total = PM.total(), lastOn = Math.min(n + R.n - 1, total), pct = total <= 1 ? 1 : lastOn >= total ? 1 : (n - 1) / total;
      R.ch = PM.chOf(n); const c = R.book.chapters[R.ch];
      store.set('reader.pos.' + R.book.id, { ch: R.ch, bi: n, o: 0, pct, when: Date.now() });
      $('#footCh').textContent = c.t || ''; $('#barTitle').textContent = R.book.title + (c.t ? '  ·  ' + c.t : '');
      $('#footPg').textContent = 'p. ' + n + (lastOn > n ? '–' + lastOn : '') + ' of ' + total + '  ·  ' + Math.round(pct * 100) + '%';
      $('#progressFill').style.width = (pct * 100) + '%';
      for (let k = n + R.n; k < n + R.n * 3 && k <= total; k++) PM.load(k).catch(() => { /* it will be asked for again when its turn comes */ }); // the next pages, ready before they are needed
    },
    dragTo(dx) {
      const dir = dx < 0 ? 1 : -1;
      if (R.screen + dir < 0 || R.screen + dir >= R.screens) dx *= 0.28; // the end of the book: it gives a little, and no more
      PM.place(dx);
    },
    turn(dir, dragged) {
      if (dir && (R.screen + dir < 0 || R.screen + dir >= R.screens)) dir = 0;
      if (!dir && !dragged) return;
      R.busy = true;
      void pv.offsetWidth; // start the slide from where the finger left it
      for (const sl of PM.slots) sl.classList.add('slide');
      PM.place(-dir * R.W);
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        for (const sl of PM.slots) sl.classList.remove('slide');
        if (dir > 0) { const sl = PM.slots.shift(); PM.slots.push(sl); R.screen++; PM.fill(sl, R.screen + 1); }
        else if (dir < 0) { const sl = PM.slots.pop(); PM.slots.unshift(sl); R.screen--; PM.fill(sl, R.screen - 1); }
        PM.place(0); R.sel = null; R.busy = false; PM.settle();
      };
      PM.slots[1].addEventListener('transitionend', finish, { once: true }); setTimeout(finish, 420);
    },
    wordAt(x, y) {
      const boxes = [...(PM.slots[1] ? PM.slots[1].children : [])].filter((b) => b.classList.contains('pgbox')); if (!boxes.length) return null;
      let el = null, bx = Infinity;
      for (const b of boxes) { const r = b.getBoundingClientRect(), d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0; if (d < bx) { bx = d; el = b; } }
      const r = el.getBoundingClientRect(), fx = (x - r.left) / r.width, fy = (y - r.top) / r.height, n = +el.dataset.n, ws = PM.words(n);
      let best = -1, bd = Infinity;
      ws.forEach((w, i) => { const dy = fy < w.y ? w.y - fy : fy > w.y + w.h ? fy - w.y - w.h : 0, dx = fx < w.x ? w.x - fx : fx > w.x + w.w ? fx - w.x - w.w : 0, d = dx + dy * 4; if (d < bd) { bd = d; best = i; } }); // the right line matters more than the right word
      if (best < 0 || bd > 0.14) return null;
      const w = ws[best], left = r.left + w.x * r.width, top = r.top + w.y * r.height, width = w.w * r.width, height = w.h * r.height;
      return { bi: n, s: best, e: best, r: { left, top, width, height, right: left + width, bottom: top + height } };
    },
    // the printed words between two places, as running text (a word broken at the end of a line is mended)
    textOf(sel) {
      const got = [];
      for (let n = sel.a[0]; n <= sel.b[0]; n++) { const ws = PM.words(n), i0 = n === sel.a[0] ? sel.a[1] : 0, i1 = n === sel.b[0] ? sel.b[1] : ws.length - 1; for (let i = i0; i <= i1 && i < ws.length; i++) got.push(ws[i]); }
      let text = '';
      got.forEach((w, i) => { const next = got[i + 1]; text += w.end && next && /[A-Za-z]-$/.test(w.t) && /^[a-z]/.test(next.t) ? w.t.slice(0, -1) : w.t + (next ? ' ' : ''); });
      return text.trim();
    },
    // highlights, the words being picked, and thought marks, painted over one page
    paint(el) {
      const n = +el.dataset.n, ov = el.querySelector('.ov'), ws = PM.words(n); if (!ov) return;
      ov.textContent = '';
      const pc = (v) => (v * 100).toFixed(3) + '%';
      const band = (a, b, cls, id) => { // one bar for each printed line the words run over
        let i = clamp(a, 0, ws.length - 1); b = clamp(b, 0, ws.length - 1);
        while (ws.length && i <= b) {
          let j = i; while (j < b && ws[j + 1].li === ws[i].li) j++;
          const f = ws[i], l = ws[j], pad = f.h * 0.14, d = h('div', cls); if (id) d.dataset.id = id;
          d.style.cssText = 'left:' + pc(f.x - 0.003) + ';top:' + pc(f.y - pad) + ';width:' + pc(l.x + l.w - f.x + 0.006) + ';height:' + pc(f.h + pad * 2);
          ov.append(d); i = j + 1;
        }
      };
      const span = (it) => (it.b[0] < n || it.a[0] > n ? null : [it.a[0] < n ? 0 : it.a[1], it.b[0] > n ? ws.length - 1 : it.b[1]]);
      const byId = new Map(R.notes.map((x) => [x.id, x]));
      for (const it of R.notes) if (it.kind === 'hl') { const r = span(it); if (r) band(r[0], r[1], 'hl c-' + it.color, it.id); }
      if (R.sel) { const r = span(R.sel); if (r) band(r[0], r[1], 'sel'); }
      for (const it of R.notes) {
        if (it.kind === 'hl') continue;
        const ref = it.ref && byId.get(it.ref), at = ref ? ref.b : it.a; if (at[0] !== n) continue;
        // a thought sits in the margin beside its line, like a note pencilled in a real book
        const w = ws[clamp(at[1], 0, ws.length - 1)], d = h('div', 'tm' + (it.kind === 'voice' ? ' voice' : '')); d.dataset.t = it.id;
        const edge = ws.length ? Math.max(0.012, Math.min(...ws.map((x) => x.x)) - 0.04) : 0.05;
        d.style.cssText = w ? 'left:' + pc(edge) + ';top:' + pc(w.y + w.h / 2) : 'left:5%;top:4%';
        ov.append(d);
      }
    },
    repaint() { for (const sl of PM.slots) for (const el of sl.children) if (el.classList.contains('pgbox')) PM.paint(el); },
  };

  // ------------------------------------------------------------------ fingers: a swipe turns the page; press, then drag, highlights
  let g = null, selFrame = 0;
  page.addEventListener('pointerdown', (e) => {
    if (R.busy || !R.book || e.button > 0 || g) return;
    const hadPop = !$('#pop').hidden; hidePop();
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), mode: 'wait', vx: 0, lt: performance.now(), lx: e.clientX, hadPop };
    try { page.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    g.timer = setTimeout(() => { if (g && g.mode === 'wait') beginSelect(); }, HOLD);
  });
  page.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const now = performance.now(); if (now - g.lt > 8) { g.vx = (e.clientX - g.lx) / (now - g.lt); g.lt = now; g.lx = e.clientX; }
    g.x = e.clientX; g.y = e.clientY;
    const dx = g.x - g.x0, dy = g.y - g.y0;
    if (g.mode === 'wait' && Math.hypot(dx, dy) > 9) { clearTimeout(g.timer); g.mode = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'none'; if (g.mode === 'swipe') R.words.clear(); }
    if (g.mode === 'swipe') dragTo(dx);
    else if (g.mode === 'select' && !selFrame) selFrame = requestAnimationFrame(() => { selFrame = 0; if (g && g.mode === 'select') extendSelect(g.x, g.y); });
    e.preventDefault();
  });
  function endGesture(e, cancelled) {
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer); const was = g; g = null;
    try { page.releasePointerCapture(e.pointerId); } catch (err) { /* fine */ }
    const dx = was.x - was.x0, vx = performance.now() - was.lt > 90 ? 0 : was.vx; // a finger that came to rest is not a flick
    if (was.mode === 'swipe') { const far = Math.abs(dx) > R.W * 0.16 || (Math.abs(vx) > 0.45 && Math.abs(dx) > 24 && vx * dx > 0); turn(!cancelled && far ? (dx < 0 ? 1 : -1) : 0, true); }
    else if (was.mode === 'select') { if (cancelled) { const s = R.sel; R.sel = null; if (s) repaint(s.a[0], s.b[0]); } else commitSelect(was.last); }
    else if (was.mode === 'wait' && !cancelled) tap(was.x, was.y, was.hadPop);
  }
  page.addEventListener('pointerup', (e) => endGesture(e, false));
  page.addEventListener('pointercancel', (e) => endGesture(e, true));
  page.addEventListener('contextmenu', (e) => e.preventDefault());
  function tap(x, y, hadPop) {
    const el = document.elementFromPoint(x, y);
    const tm = el && el.closest && el.closest('.tm'); if (tm) { openThought(R.notes.find((n) => n.id === tm.dataset.t)); return; }
    const near = nearThought(x, y); if (near) { openThought(near); return; }
    const hl = el && el.closest && el.closest('.hl[data-id]');
    if (hl) { const it = R.notes.find((n) => n.id === hl.dataset.id); if (it) { showPop(it, hl.getBoundingClientRect()); return; } }
    if (hadPop) return; // the tap only put the little bar away
    if (x > R.W * 0.72) turn(1); else if (x < R.W * 0.28) turn(-1); else bookEl.classList.toggle('quiet');
  }
  function nearThought(x, y) { // a thought's mark is small: a tap close to it counts
    let best = null, bd = 26;
    for (const m of view().querySelectorAll('.tm')) { const r = m.getBoundingClientRect(); const d = R.pm ? Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) : Math.hypot(x - (r.left + 5), y - (r.top - 6)); if (d < bd) { bd = d; best = m; } }
    return best && R.notes.find((n) => n.id === best.dataset.t);
  }
  let wheelT = 0;
  page.addEventListener('wheel', (e) => { e.preventDefault(); const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0; if (Math.abs(d) < 24 || Date.now() - wheelT < 520) return; wheelT = Date.now(); turn(d > 0 ? 1 : -1); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (bookEl.hidden || !$('#sheet').hidden || !$('#side').hidden || !$('#gate').hidden) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); turn(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); turn(-1); }
    else if (e.key === 'Escape') { if (!$('#pop').hidden) hidePop(); else closeBook(); }
  });

  // ------------------------------------------------------------------ highlighting
  function beginSelect() {
    const w = wordAt(g.x, g.y); if (!w) { g.mode = 'none'; return; }
    g.mode = 'select'; g.anchor = w; g.last = w;
    R.sel = { a: [w.bi, w.s], b: [w.bi, w.e] }; repaint(w.bi, w.bi);
  }
  function extendSelect(x, y) {
    const w = wordAt(x, y); if (!w || !R.sel) return;
    const an = g.anchor, was = R.sel;
    R.sel = cmp([w.bi, w.s], [an.bi, an.s]) >= 0 ? { a: [an.bi, an.s], b: [w.bi, w.e] } : { a: [w.bi, w.s], b: [an.bi, an.e] };
    g.last = w;
    repaint(Math.min(was.a[0], R.sel.a[0]), Math.max(was.b[0], R.sel.b[0]));
  }
  function commitSelect(last) {
    const sel = R.sel; R.sel = null; if (!sel) return;
    const c = R.book.chapters[R.ch], parts = [];
    if (R.pm) parts.push(PM.textOf(sel));
    else for (let bi = sel.a[0]; bi <= sel.b[0]; bi++) { const t = c.blocks[bi].t; parts.push(t.slice(bi === sel.a[0] ? sel.a[1] : 0, bi === sel.b[0] ? sel.b[1] : t.length).trim()); }
    const text = parts.filter(Boolean);
    if (!text.length) { repaint(sel.a[0], sel.b[0]); return; }
    const id = 'c' + rid(), ch = R.pm ? PM.chOf(sel.a[0]) : R.ch, hl = { book: R.book.id, ch, a: sel.a, b: sel.b, color: S.color };
    if (R.pm) hl.p = sel.a[0]; else if (c.blocks[sel.a[0]].p) hl.p = c.blocks[sel.a[0]].p;
    const card = { id, type: 'note', html: text.map((t) => '<div>' + esc(t) + '</div>').join(''), w: COL_W - 16, hl };
    const item = { id, kind: 'hl', ch, a: sel.a, b: sel.b, color: S.color, text: text.join(' '), pending: true };
    R.notes.push(item); R.idx = {}; repaint(sel.a[0], sel.b[0]); DB.put('notes', R.book.id, R.notes);
    enqueue({ book: R.book.id, kind: 'add', card });
    showPop(item, last && last.r);
  }

  // the little bar by a highlight: its colour, a thought about it, or take it off
  const pop = $('#pop');
  for (const col of COLORS) { const b = h('button'); b.type = 'button'; b.dataset.c = col; b.setAttribute('aria-label', col); const i = h('i'); i.style.background = 'var(--dot-' + col + ')'; b.append(i); $('#popColors').append(b); }
  function showPop(item, rect) {
    R.pin = item.id; pop.hidden = false;
    for (const b of $('#popColors').children) b.classList.toggle('on', b.dataset.c === item.color);
    // sit just above the highlight (below it when there is no room), never on top of its words
    let top = Infinity, bottom = -Infinity, cx = rect ? rect.left + rect.width / 2 : null;
    for (const s of view().querySelectorAll('.hl')) { if (s.dataset.id !== item.id) continue; for (const r of s.getClientRects()) { if (r.right < 0 || r.left > R.W) continue; top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); if (cx == null || !rect) cx = r.left + r.width / 2; } }
    if (top === Infinity) { top = bottom = window.innerHeight / 2; cx = R.W / 2; }
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = clamp(cx - pw / 2, 10, window.innerWidth - pw - 10) + 'px';
    pop.style.top = (top - ph - 12 < 8 ? Math.min(bottom + 12, window.innerHeight - ph - 8) : top - ph - 12) + 'px';
  }
  function hidePop() { if (pop.hidden) return; pop.hidden = true; R.pin = null; }
  $('#popColors').addEventListener('click', (e) => {
    const b = e.target.closest('button'), it = R.notes.find((n) => n.id === R.pin); if (!b || !it) return;
    S.color = b.dataset.c; store.set('reader.color', S.color);
    if (it.color !== S.color) { it.color = S.color; R.idx = {}; repaint(it.a[0], it.b[0]); DB.put('notes', R.book.id, R.notes); enqueue({ book: R.book.id, kind: 'set', cardId: it.id, patch: { hl: { color: S.color } } }); }
    showPop(it);
  });
  $('#popThought').addEventListener('click', () => openThought(null));
  $('#popRemove').addEventListener('click', () => { const it = R.notes.find((n) => n.id === R.pin); hidePop(); if (it) removeItem(it); });
  function removeItem(it) {
    R.notes = R.notes.filter((n) => n !== it && n.id !== it.id); R.idx = {}; repaint(); DB.put('notes', R.book.id, R.notes);
    enqueue({ book: R.book.id, kind: 'del', cardId: it.id });
  }

  // ------------------------------------------------------------------ thoughts: your own words beside the book's
  const thoughtPlace = (pin) => (pin ? { ch: pin.ch, a: pin.b.slice(), ref: pin.id } : { ch: R.ch, a: whereNow() });
  function addItem(item, card, file) {
    R.notes.push(item); R.idx = {}; repaint(); DB.put('notes', R.book.id, R.notes);
    const op = { book: R.book.id, kind: 'add', card }; if (file) op.file = file;
    enqueue(op);
  }
  function addThought(text, where) {
    const id = 'c' + rid();
    const card = { id, type: 'note', html: text.split(/\n+/).map((t) => '<div>' + esc(t) + '</div>').join(''), w: COL_W - 16, thought: true, at: { book: R.book.id, ch: where.ch, a: where.a } };
    if (where.ref) card.ref = where.ref;
    const item = { id, kind: 'note', ch: where.ch, a: where.a, ref: where.ref || '', text, pending: true };
    addItem(item, card);
    toast('Thought saved', 'Undo', () => removeItem(item), 4000);
  }
  function openThought(item) { // an existing thought to look at, or nothing for a new one
    const pin = !item && R.pin ? R.notes.find((n) => n.id === R.pin) : item && item.ref ? R.notes.find((n) => n.id === item.ref) : null;
    const where = item ? null : thoughtPlace(pin);
    hidePop();
    openSheet((body) => {
      body.append(h('div', 'stitle', item ? (item.kind === 'voice' ? 'Your spoken thought' : 'Your thought') : 'A thought'));
      if (pin) body.append(h('div', 'quote', pin.text));
      if (item && item.kind === 'voice') {
        body.append(h('div', 'snote', item.text || 'A voice note, ' + mmss(item.dur || 0) + ' long. Its words show here once the Mac has listened to it.'));
        body.append(btn('Remove', 'danger', () => { closeSheet(); removeItem(item); }), btn('Close', 'quiet', closeSheet));
        return;
      }
      const ta = h('textarea'); ta.id = 'thoughtText'; ta.placeholder = 'Type it here'; ta.value = item ? item.text : '';
      const save = () => {
        const v = ta.value.trim(); closeSheet();
        if (!item) { if (v) addThought(v, where); return; }
        if (!v) { removeItem(item); return; }
        if (v !== item.text) { item.text = v; DB.put('notes', R.book.id, R.notes); enqueue({ book: R.book.id, kind: 'set', cardId: item.id, patch: { html: v.split(/\n+/).map((t) => '<div>' + esc(t) + '</div>').join('') } }); }
      };
      body.append(ta, btn('Save', 'primary', save));
      if (item) body.append(btn('Remove', 'danger', () => { closeSheet(); removeItem(item); }));
      body.append(btn('Cancel', 'quiet', closeSheet));
      setTimeout(() => ta.focus(), 260);
    });
  }
  // the button: a tap types, a hold talks
  const tb = $('#thoughtBtn'), recPill = $('#recPill'); let hold = null;
  const rec = { wanted: false, stream: null, mr: null, chunks: [], t0: 0, tick: 0, where: null, type: '' };
  tb.addEventListener('pointerdown', (e) => {
    if (hold || !R.book) return; e.preventDefault();
    try { tb.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    tb.classList.add('down');
    hold = { rec: false, t: setTimeout(() => { if (hold) { hold.rec = true; startRec(); } }, 320) };
  });
  const tbUp = (cancelled) => { if (!hold) return; clearTimeout(hold.t); const was = hold; hold = null; tb.classList.remove('down'); if (was.rec) stopRec(cancelled); else if (!cancelled) openThought(null); };
  tb.addEventListener('pointerup', () => tbUp(false));
  tb.addEventListener('pointercancel', () => tbUp(true));
  tb.addEventListener('contextmenu', (e) => e.preventDefault());
  async function startRec() {
    rec.wanted = true; rec.where = thoughtPlace(R.pin ? R.notes.find((n) => n.id === R.pin) : null); hidePop();
    recPill.hidden = false; $('#recText').textContent = 'One moment'; $('#recTime').textContent = '';
    try {
      if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('none');
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { rec.wanted = false; recPill.hidden = true; toast(e && e.name === 'NotAllowedError' ? 'The reader needs the microphone for a spoken thought. Allow it, then hold again.' : 'No microphone here. Tap the button to type instead.', null, null, 3600); return; }
    if (!rec.wanted) { stopStream(); recPill.hidden = true; toast('The microphone is on. Hold the button and talk.'); return; } // let go while the iPad was asking for permission
    rec.type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    rec.mr = new MediaRecorder(rec.stream, rec.type ? { mimeType: rec.type } : undefined); rec.chunks = [];
    rec.mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.mr.start(); rec.t0 = performance.now();
    tb.classList.add('rec'); $('#recText').textContent = 'Listening';
    rec.tick = setInterval(() => { $('#recTime').textContent = mmss((performance.now() - rec.t0) / 1000); }, 250);
  }
  function stopStream() { if (rec.stream) for (const t of rec.stream.getTracks()) t.stop(); rec.stream = null; }
  function stopRec(cancelled) {
    rec.wanted = false;
    const mr = rec.mr; if (!mr) return; rec.mr = null;
    clearInterval(rec.tick); tb.classList.remove('rec'); recPill.hidden = true;
    const secs = (performance.now() - rec.t0) / 1000, where = rec.where, type = mr.mimeType || rec.type || 'audio/mp4';
    mr.onstop = () => {
      stopStream();
      if (cancelled) return;
      if (secs < 0.7) { toast('Hold the button while you talk. Tap it to type.'); return; }
      const blob = new Blob(rec.chunks, { type }), name = 'v' + rid() + (/webm/.test(type) ? '.weba' : '.m4a'), id = 'c' + rid(), d = new Date();
      const card = { id, type: 'link', file: true, audio: true, url: 'assets/' + name, title: 'Thought · ' + stampText(d), site: 'Voice note · ' + mmss(Math.round(secs)), dur: Math.round(secs), w: 260, thought: true, at: { book: R.book.id, ch: where.ch, a: where.a } };
      if (where.ref) card.ref = where.ref;
      const item = { id, kind: 'voice', ch: where.ch, a: where.a, ref: where.ref || '', text: '', dur: Math.round(secs), pending: true };
      addItem(item, card, { name, blob });
      toast('Spoken thought saved', 'Undo', () => removeItem(item), 4000);
    };
    try { mr.stop(); } catch (e) { stopStream(); }
  }

  // ------------------------------------------------------------------ panels
  const sheet = $('#sheet'), sheetBody = $('#sheetBody'), shade = $('#shade'), side = $('#side');
  function openSheet(build) { sheetBody.textContent = ''; build(sheetBody); sheet.hidden = false; shade.hidden = false; requestAnimationFrame(() => sheet.classList.add('up')); }
  function closeSheet() { sheet.classList.remove('up'); if (side.hidden) shade.hidden = true; setTimeout(() => { sheet.hidden = true; sheetBody.textContent = ''; }, 220); }
  function closeSide() { side.classList.remove('in'); shade.hidden = true; setTimeout(() => { side.hidden = true; }, 260); }
  shade.addEventListener('click', () => { if (!sheet.hidden) closeSheet(); if (!side.hidden) closeSide(); });
  const btn = (label, cls, fn) => { const b = h('button', 'sbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
  // Aa: the size of the type, and the paper
  function relayout() { const pos = store.get('reader.pos.' + R.book.id); measure(); show(R.ch, pos && pos.ch === R.ch ? { bi: pos.bi, o: pos.o } : null); }
  function setTheme(t) { S.theme = t; store.set('reader.theme', t); document.body.dataset.theme = t; const m = $('meta[name=theme-color]'); if (m) m.content = t === 'night' ? '#141414' : t === 'sepia' ? '#f0e4cb' : '#f5f5f3'; }
  $('#typeBtn').addEventListener('click', () => openSheet((body) => {
    body.append(h('div', 'stitle', 'The page'));
    const r1 = h('div', 'row'), sizes = h('div', 'sizes'), val = h('span', '', S.size + ' pt');
    const step = (d) => { S.size = clamp(S.size + d, 14, 30); store.set('reader.size', S.size); val.textContent = S.size + ' pt'; relayout(); };
    const sm = h('button', 'sm', 'A'), lg = h('button', 'lg', 'A'); sm.type = lg.type = 'button'; sm.setAttribute('aria-label', 'Smaller type'); lg.setAttribute('aria-label', 'Larger type');
    sm.addEventListener('click', () => step(-1)); lg.addEventListener('click', () => step(1));
    sizes.append(sm, val, lg); r1.append(h('div', 'lab', 'Type'), sizes); if (R.pm) r1.hidden = true; // real pages have their own type
    const r2 = h('div', 'row'), papers = h('div', 'papers');
    for (const [k, name, bg, ink] of [['paper', 'Paper', '#f5f5f3', '#18181a'], ['sepia', 'Sepia', '#f0e4cb', '#3b2f20'], ['night', 'Night', '#141414', '#cfc9bd']]) {
      const b = h('button', S.theme === k ? 'on' : '', name); b.type = 'button'; b.style.background = bg; b.style.color = ink;
      b.addEventListener('click', () => { setTheme(k); for (const x of papers.children) x.classList.toggle('on', x === b); });
      papers.append(b);
    }
    r2.append(h('div', 'lab', 'Paper'), papers);
    body.append(r1, r2, btn('Done', 'quiet', closeSheet));
  }));
  // contents, and everything you have marked
  function openSide(tab) {
    side.hidden = false; shade.hidden = false; requestAnimationFrame(() => side.classList.add('in'));
    for (const b of $('#sideTabs').children) b.classList.toggle('on', b.dataset.t === tab);
    const body = $('#sideBody'); body.textContent = '';
    const go = (ch, place) => { closeSide(); show(ch, place); };
    if (tab === 'contents') {
      R.book.chapters.forEach((c, i) => {
        const n = R.notes.filter((x) => x.ch === i).length, row = h('button', 'toc' + (i === R.ch ? ' on' : '')); row.type = 'button';
        row.append(h('span', 'n', String(i + 1)), h('span', 't', c.t || 'Chapter ' + (i + 1)), h('span', 'c', n ? String(n) : ''));
        row.addEventListener('click', () => go(i, null)); body.append(row);
      });
      const on = body.querySelector('.on'); if (on) setTimeout(() => on.scrollIntoView({ block: 'center' }), 0);
    } else {
      const byId = new Map(R.notes.map((n) => [n.id, n]));
      const key = (n) => { const ref = n.ref && byId.get(n.ref); return ref ? [ref.a[0], ref.a[1], 1] : [n.a[0], n.a[1], n.kind === 'hl' ? 0 : 0.5]; };
      const sorted = R.notes.slice().sort((x, y) => (x.ch - y.ch) || (key(x)[0] - key(y)[0]) || (key(x)[1] - key(y)[1]) || (key(x)[2] - key(y)[2]));
      if (!sorted.length) body.append(h('div', 'nempty', 'Nothing marked yet. Press on a word and drag to highlight. Tap the button in the corner to add a thought, or hold it and talk.'));
      let last = -1;
      for (const n of sorted) {
        if (n.ch !== last) { last = n.ch; body.append(h('div', 'nhead', (R.book.chapters[n.ch] || {}).t || 'Chapter ' + (n.ch + 1))); }
        const row = h('button', 'nitem ' + (n.kind === 'hl' ? 'c-' + n.color : 'thought')); row.type = 'button';
        row.append(document.createTextNode(n.kind === 'voice' ? (n.text || 'Voice note · ' + mmss(n.dur || 0)) : n.text));
        if (n.pending) row.append(h('span', 'wait', 'waiting'));
        row.addEventListener('click', () => go(n.ch, { bi: n.a[0], o: n.a[1] })); body.append(row);
      }
    }
  }
  $('#listBtn').addEventListener('click', () => openSide('contents'));
  $('#sideTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openSide(b.dataset.t); });
  $('#sideClose').addEventListener('click', closeSide);

  // ------------------------------------------------------------------ opening and closing a book
  async function openBook(id, place) {
    let book = await DB.get('books', id);
    if (!book) {
      try { book = JSON.parse((await download(ROOT + '/library/' + id + '.json')).text); await DB.put('books', id, book); S.have.add(id); store.set('reader.have', [...S.have]); }
      catch (e) { toast(e.offline ? 'This book has not reached the iPad yet. It needs a connection once.' : 'This book could not be opened.', null, null, 3600); return; }
    }
    if (!book.chapters || !book.chapters.length) { toast('This book has no text to read.'); return; }
    let pg = [];
    if (book.view === 'pages') { // a book read as its real pages: where the words sit on each one
      let kept = await DB.get('books', id + '/pages');
      if (!kept || kept.made !== book.made) {
        try { kept = { made: book.made, pages: JSON.parse((await download(ROOT + '/library/' + id + '/pages.json')).text).pages }; await DB.put('books', id + '/pages', kept); }
        catch (e) { toast(e.offline ? 'This book has not reached the iPad yet. It needs a connection once.' : 'This book could not be opened.', null, null, 3600); return; }
      }
      pg = kept.pages || [];
    }
    R.book = book; R.pm = book.view === 'pages'; R.pg = pg; PM.reset(); R.idx = {}; R.sel = null;
    bookEl.classList.toggle('pm', R.pm); pv.hidden = !R.pm; $('#flowA').hidden = $('#flowB').hidden = R.pm;
    R.notes = (await DB.get('notes', id)) || withPending([], (await DB.all('queue')).filter((o) => o.book === id));
    R.before = []; R.inCh = []; R.total = 0;
    if (!R.pm) for (const c of book.chapters) { R.before.push(R.total); let run = 0; const arr = []; for (const b of c.blocks) { arr.push(run); run += b.t.length; } R.inCh.push(arr); R.total += run; }
    $('#shelf').hidden = true; bookEl.hidden = false; bookEl.classList.add('quiet');
    R.cur = $('#flowA'); R.side = $('#flowB'); R.busy = false; measure();
    const pos = place || store.get('reader.pos.' + id);
    show(pos ? pos.ch | 0 : 0, pos && pos.bi != null ? { bi: pos.bi, o: pos.o | 0 } : null);
    try { history.replaceState(null, '', location.pathname + location.search + '#b=' + encodeURIComponent(id)); } catch (e) { /* fine */ }
    syncNotes(id);
  }
  function closeBook() {
    if (EMBED) { flush().finally(() => tellBoard('close')); return; }
    if (!R.book) return; hidePop(); if (rec.mr) stopRec(true);
    R.book = null; R.pm = false; bookEl.hidden = true; $('#shelf').hidden = false; $('#flowA').textContent = ''; $('#flowB').textContent = ''; pv.textContent = ''; PM.reset();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* fine */ }
    paintShelf(); loadShelf();
  }
  $('#backBtn').addEventListener('click', closeBook);
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (R.book && !R.busy) relayout(); }, 160); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (rec.mr) stopRec(false); flush(); } else { flush(); if (R.book) syncNotes(R.book.id); else loadShelf(); } });

  // ------------------------------------------------------------------ the shelf's menu, and signing in
  async function menu() {
    const waiting = await DB.all('queue');
    openSheet((body) => {
      body.append(h('div', 'stitle', 'BOARD Reader'));
      body.append(h('div', 'snote', LOCAL ? 'Reading straight from the BOARD folder on this Mac.' : store.get('board.auth') ? 'Signed in to Dropbox. Highlights and thoughts land in each book’s notebook, inside LIBRARY.' : 'Not signed in.'));
      body.append(h('div', 'snote', 'To add a book: on the Mac, drop a PDF or an ebook onto LIBRARY in BOARD.'));
      if (waiting.length) { body.append(h('div', 'snote', (waiting.length === 1 ? '1 thing is' : waiting.length + ' things are') + ' waiting to go up' + (S.lastError ? ' (' + S.lastError + ')' : '') + '.')); body.append(btn('Send now', 'primary', () => { closeSheet(); flush(); })); }
      if (!LOCAL && store.get('board.auth')) body.append(btn('Sign out of Dropbox', 'danger', () => { store.del('board.auth'); location.reload(); }));
      body.append(h('div', 'snote small', VERSION), btn('Close', 'quiet', closeSheet));
    });
  }
  $('#shelfMenu').addEventListener('click', menu);
  $('#statusBtn').addEventListener('click', menu);
  const gate = $('#gate');
  function showSignIn() {
    if (LOCAL) return;
    gate.hidden = false; gate.textContent = '';
    gate.append(h('div', 'gtitle', 'BOARD Reader'), h('div', 'gnote', 'Your books, and a notebook in BOARD for each one. Sign in to the Dropbox that holds your BOARD folder.'));
    if (REDIRECT_READY) gate.append(btn('Sign in with Dropbox', 'primary', () => startSignIn(false)), btn('Sign in with a code instead', 'quiet', () => startSignIn(true)));
    else gate.append(btn('Sign in with Dropbox', 'primary', () => startSignIn(true)));
    if (!standalone()) gate.append(h('div', 'gnote small', 'Tip: use Share, then Add to Home Screen, to keep the Reader as its own app. Sign in after you open it from there.'));
  }
  function showCodeBox(url) {
    gate.hidden = false; gate.textContent = '';
    gate.append(h('div', 'gtitle', 'Sign in'), h('div', 'gnote', 'Tap Open Dropbox, then Allow. Dropbox shows a code: copy it, come back here and paste it below.'));
    const a = h('a', 'sbtn primary', 'Open Dropbox'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; gate.append(a);
    const inp = h('input', 'urlin'); inp.placeholder = 'Paste the code'; inp.autocapitalize = 'off'; inp.autocomplete = 'off';
    const ok = btn('Continue', 'primary', async () => { try { await finishSignIn(inp.value); gate.hidden = true; boot(); } catch (e) { toast(e.message); } });
    gate.append(inp, ok, btn('Start again', 'quiet', () => startSignIn(true)));
  }

  // ------------------------------------------------------------------ start
  async function boot() {
    const q = new URLSearchParams(location.search);
    if (q.get('code')) { try { await finishSignIn(q.get('code')); } catch (e) { toast(e.message); } history.replaceState(null, '', REDIRECT); }
    if (q.get('error')) history.replaceState(null, '', location.pathname);
    setTheme(S.theme); measure(); paintShelf();
    S.queued = (await DB.all('queue')).length; paintStatus();
    if (!signedIn()) { showSignIn(); return; }
    gate.hidden = true;
    const hp = new URLSearchParams(location.hash.slice(1)), want = hp.get('b'); // a card in BOARD can open the book at its own place
    const place = want && hp.get('c') != null ? { ch: +hp.get('c') || 0, bi: +hp.get('i') || 0, o: +hp.get('o') || 0 } : null;
    if (want && (await DB.get('books', want))) openBook(want, place);
    if (EMBED && R.book) { loadShelf().then(() => { /* fresh copy of this book is on the device for next time */ }); flush(); return; }
    await loadShelf();
    if (want && !R.book) openBook(want, place);
    flush();
  }
  window.BOARDREADER = { EMBED, S, R, PM, DB, flush, loadShelf, openBook, closeBook, show, turn, applyOps, ensureColumn, withPending, itemsOfBoard, syncNotes, wordAt, whereNow, addThought, version: VERSION, local: LOCAL };
  if ('serviceWorker' in navigator && !mockBase && !LOCAL && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { /* works without it, just not offline */ });
  boot();
})();

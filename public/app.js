(() => {
  'use strict';

  /* ------------------------------ utilities ------------------------------ */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const view = $('#view');
  const state = { token: localStorage.getItem('token'), me: null, ws: null, wsRetry: 0, unread: 0, online: new Set(), view: '' };
  const chat = { current: null, convos: [], typingTimer: null, lastTypingSent: 0, searching: false };
  let renderId = 0;
  let observer = null;

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  async function api(path, opts = {}) {
    const headers = {};
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    let body = opts.body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token && !path.startsWith('/login') && !path.startsWith('/register')) {
      logoutLocal();
      throw new Error(data.error || 'Please log in again');
    }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // XHR so we can show upload progress for big videos
  function upload(path, form, onProgress, method = 'POST') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, '/api' + path);
      xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        xhr.status >= 200 && xhr.status < 300 ? resolve(data) : reject(new Error(data.error || 'Upload failed'));
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(form);
    });
  }

  function timeStr(at) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  function avatar(u, size = 40) {
    if (u && u.avatar) return `<img class="avatar" src="${esc(u.avatar)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`;
    const letter = u && u.username ? u.username[0] : '?';
    return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .42)}px">${esc(letter)}</span>`;
  }

  function mediaTag(item, attrs = '') {
    return item.type === 'video'
      ? `<video src="${esc(item.url)}#t=0.1" muted loop playsinline preload="metadata" ${attrs}></video>`
      : `<img src="${esc(item.url)}" alt="" loading="lazy" ${attrs}>`;
  }

  /* -------------------------------- theme -------------------------------- */
  const SUN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  function themeIcons() { $$('[data-theme-toggle]').forEach(b => { b.innerHTML = document.documentElement.getAttribute('data-theme') === 'dark' ? SUN : MOON; }); }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch {}
    themeIcons();
  }
  $('#themeBtn').setAttribute('data-theme-toggle', '');
  $('#themeBtn').addEventListener('click', toggleTheme);

  /* -------------------------------- modals ------------------------------- */
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  function openModal(html, wide = false) {
    $('#modalRoot').innerHTML = `<div class="backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    const backdrop = $('#modalRoot .backdrop');
    let downOnBackdrop = false;
    backdrop.addEventListener('mousedown', e => { downOnBackdrop = e.target === backdrop; });
    backdrop.addEventListener('click', e => { if (e.target === backdrop && downOnBackdrop) closeModal(); });
    return $('#modalRoot .modal');
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  /* ---------------------------------- auth -------------------------------- */
  function renderAuth(mode = 'login') {
    $('#nav').classList.add('hidden');
    closeModal();
    const reg = mode === 'register';
    view.innerHTML = `
      <button class="icon-btn auth-theme" data-theme-toggle aria-label="Toggle theme"></button>
      <form class="auth" id="authForm">
        <svg viewBox="0 0 32 32" width="48" height="48"><circle cx="16" cy="16" r="16" fill="#e60023"/><circle cx="16" cy="13" r="5" fill="#fff"/><path d="M16 18v8" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>
        <h1>${reg ? 'Join Pinboard' : 'Welcome back'}</h1>
        <p>${reg ? 'Find new ideas to try' : 'Log in to see your pins'}</p>
        <label class="field"><span>Username</span><input name="username" required autocomplete="username" maxlength="20"></label>
        <label class="field"><span>Password</span><input name="password" type="password" required minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
        <div class="error" id="authError"></div>
        <button class="btn primary" type="submit">${reg ? 'Sign up' : 'Log in'}</button>
        <div class="switch">${reg ? 'Already a member? <a id="swap">Log in</a>' : 'New here? <a id="swap">Sign up</a>'}</div>
      </form>`;
    themeIcons();
    $('[data-theme-toggle]', view).addEventListener('click', toggleTheme);
    $('#swap').addEventListener('click', () => renderAuth(reg ? 'login' : 'register'));
    $('#authForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      try {
        const r = await api(reg ? '/register' : '/login', { method: 'POST', body: { username: f.get('username').trim(), password: f.get('password') } });
        state.token = r.token;
        localStorage.setItem('token', r.token);
        state.me = r.user;
        startApp();
      } catch (err) { $('#authError').textContent = err.message; btn.disabled = false; }
    });
  }

  function logoutLocal() {
    state.token = null; state.me = null; state.unread = 0;
    localStorage.removeItem('token');
    if (state.ws) { const w = state.ws; state.ws = null; w.close(); }
    renderAuth();
  }

  /* ----------------------------------- nav -------------------------------- */
  function renderNav() {
    $('#nav').classList.remove('hidden');
    $('#meLink').href = '#/u/' + encodeURIComponent(state.me.username);
    $('#meLink').innerHTML = avatar(state.me, 36);
    updateBadge();
    themeIcons();
  }
  function updateBadge() {
    const b = $('#chatBadge');
    b.textContent = state.unread > 99 ? '99+' : state.unread;
    b.classList.toggle('hidden', !state.unread);
  }
  async function refreshUnread() {
    try { state.unread = (await api('/unread')).count; updateBadge(); } catch {}
  }
  function setActiveNav(name) {
    $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  }

  $('#searchForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/';
  });
  $('#logoutBtn').addEventListener('click', async () => { try { await api('/logout', { method: 'POST' }); } catch {} logoutLocal(); });
  $('#createBtn').addEventListener('click', openCreatePin);

  /* --------------------------------- pin grid ----------------------------- */
  function pinCard(p, opts = {}) {
    const mine = state.me && p.user && p.user.id === state.me.id;
    const unsave = opts.boardId && opts.boardOwner;
    return `
    <article class="pin-card" data-id="${esc(p.id)}">
      <div class="pin-media">
        ${mediaTag(p)}
        ${p.type === 'video' ? '<span class="vid-badge">▶ Video</span>' : ''}
        <div class="overlay">
          <div class="top">${unsave ? '<button class="btn small" data-act="unsave">Remove</button>' : '<button class="btn primary small" data-act="save">Save</button>'}</div>
          <div class="bottom"><button class="btn small" data-act="like">${p.liked ? '♥' : '♡'} ${p.likes}</button>${mine ? '<span></span>' : ''}</div>
        </div>
      </div>
      <div class="pin-meta">
        <div class="pin-title">${esc(p.title)}</div>
        <a class="pin-by" href="#/u/${encodeURIComponent(p.user.username)}">${avatar(p.user, 22)}<span>${esc(p.user.username)}</span></a>
      </div>
    </article>`;
  }

  function hookVideos(root) {
    $$('.pin-media video', root).forEach(v => {
      if (v._hooked) return;
      v._hooked = true;
      const m = v.closest('.pin-media');
      m.addEventListener('mouseenter', () => v.play().catch(() => {}));
      m.addEventListener('mouseleave', () => { v.pause(); });
    });
  }

  function pinGrid(host, fetchPage, opts = {}) {
    host.innerHTML = '<div class="masonry"></div><div class="sentinel"></div>';
    const grid = host.firstChild, sentinel = host.lastChild;
    let offset = 0, total = Infinity, loading = false;
    const rid = renderId;
    grid.addEventListener('click', e => onGridClick(e, opts));
    async function more() {
      if (loading || offset >= total || rid !== renderId) return;
      loading = true;
      try {
        const r = await fetchPage(offset);
        if (rid !== renderId) return;
        total = r.total;
        r.pins.forEach(p => grid.insertAdjacentHTML('beforeend', pinCard(p, opts)));
        offset += r.pins.length;
        hookVideos(grid);
        if (!offset) host.innerHTML = opts.empty || '<div class="empty"><h2>Nothing here yet</h2></div>';
      } catch (e) { toast(e.message); total = 0; }
      loading = false;
      if (offset < total && sentinel.isConnected && sentinel.getBoundingClientRect().top < innerHeight + 400) more();
    }
    observer = new IntersectionObserver(es => { if (es[0].isIntersecting) more(); }, { rootMargin: '600px' });
    observer.observe(sentinel);
    more();
  }

  async function onGridClick(e, opts) {
    const card = e.target.closest('.pin-card');
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.closest('[data-act]');
    if (e.target.closest('a')) return;
    if (!act) return openPin(id);
    e.stopPropagation();
    if (act.dataset.act === 'save') openSave(id);
    else if (act.dataset.act === 'like') {
      try {
        const p = await api(`/pins/${id}/like`, { method: 'POST' });
        act.textContent = `${p.liked ? '♥' : '♡'} ${p.likes}`;
      } catch (err) { toast(err.message); }
    } else if (act.dataset.act === 'unsave') {
      try { await api(`/boards/${opts.boardId}/pins/${id}`, { method: 'DELETE' }); card.remove(); toast('Removed from board'); } catch (err) { toast(err.message); }
    }
  }

  /* ---------------------------------- pages -------------------------------- */
  async function renderHome(rid) {
    view.innerHTML = '<div class="page" id="host"></div>';
    pinGrid($('#host'), off => api(`/pins?limit=40&offset=${off}`), {
      empty: '<div class="empty"><h2>Your feed is empty</h2><p>Be the first — press <b>Create</b> to upload a pin.</p></div>'
    });
  }
  async function renderFollowing(rid) {
    view.innerHTML = '<div class="page" id="host"></div>';
    pinGrid($('#host'), off => api(`/pins?following=1&limit=40&offset=${off}`), {
      empty: '<div class="empty"><h2>Nothing from people you follow</h2><p>Follow some creators and their pins show up here.</p></div>'
    });
  }
  async function renderSearch(rid, q) {
    $('#searchInput').value = q;
    const people = await api('/users?q=' + encodeURIComponent(q));
    if (rid !== renderId) return;
    view.innerHTML = `<div class="page">
      ${people.length ? `<h3>People</h3><div class="user-list" style="max-height:none;margin-bottom:16px">${people.slice(0, 5).map(userRow).join('')}</div>` : ''}
      <h3>Pins for “${esc(q)}”</h3><div id="host"></div></div>`;
    pinGrid($('#host'), off => api(`/pins?q=${encodeURIComponent(q)}&limit=40&offset=${off}`), {
      empty: `<div class="empty"><h2>No pins found</h2><p>Try a different search.</p></div>`
    });
  }

  function followBtn(u, cls = '') {
    if (!state.me || u.id === state.me.id || u.isMe) return '';
    return `<button class="btn small ${u.following || u.isFollowing ? '' : 'primary'} ${cls}" data-follow="${esc(u.username)}" data-following="${u.following || u.isFollowing ? 1 : 0}">${u.following || u.isFollowing ? 'Following' : 'Follow'}</button>`;
  }
  function userRow(u) {
    return `<div class="user-row"><a href="#/u/${encodeURIComponent(u.username)}">${avatar(u, 40)}<span><b>${esc(u.username)}</b></span></a>${followBtn(u)}</div>`;
  }

  async function renderProfile(rid, username) {
    const u = await api('/users/' + encodeURIComponent(username));
    if (rid !== renderId) return;
    view.innerHTML = `<div class="page">
      <div class="profile-head">
        ${avatar(u, 120)}
        <h1>${esc(u.username)}</h1>
        <div class="bio">${esc(u.bio)}</div>
        <div class="profile-stats">
          <button data-conn="followers"><span id="followersCount">${u.followers}</span> followers</button>
          <button data-conn="following">${u.following} following</button>
          <span>${u.pinCount} pins</span>
        </div>
        <div class="profile-actions">
          ${u.isMe
            ? '<button class="btn" id="editProfile">Edit profile</button><button class="btn" id="newBoard">Create board</button><button class="btn" id="logoutInline">Log out</button>'
            : `${followBtn(u)}<a class="btn" href="#/chat/${encodeURIComponent(u.username)}">Message</a>`}
        </div>
      </div>
      <div class="tabs"><button class="tab active" data-tab="pins">Created</button><button class="tab" data-tab="boards">Boards (${u.boards.length})</button></div>
      <div id="tabHost"></div></div>`;
    const host = $('#tabHost');
    function showTab(t) {
      $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
      if (observer) observer.disconnect();
      if (t === 'pins') {
        pinGrid(host, off => api(`/pins?user=${encodeURIComponent(u.username)}&limit=40&offset=${off}`), {
          empty: `<div class="empty"><h2>No pins yet</h2>${u.isMe ? '<p>Press <b>Create</b> to add your first pin.</p>' : ''}</div>`
        });
      } else {
        host.innerHTML = u.boards.length
          ? `<div class="boards-grid">${u.boards.map(boardCard).join('')}</div>`
          : `<div class="empty"><h2>No boards yet</h2>${u.isMe ? '<p>Create one to organize your pins.</p>' : ''}</div>`;
      }
    }
    $$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    showTab('pins');
    $$('[data-conn]').forEach(b => b.addEventListener('click', () => openConnections(u.username, b.dataset.conn)));
    if (u.isMe) {
      $('#editProfile').addEventListener('click', () => openEditProfile(u));
      $('#newBoard').addEventListener('click', () => openNewBoard(() => route()));
      $('#logoutInline').addEventListener('click', async () => { try { await api('/logout', { method: 'POST' }); } catch {} logoutLocal(); });
    }
  }

  function boardCard(b) {
    const c = b.covers;
    const cells = [0, 1, 2].map(i => c[i] ? `<div>${mediaTag(c[i])}</div>` : '<div></div>').join('');
    return `<a class="board-card" href="#/board/${esc(b.id)}"><div class="board-cover">${cells}</div><b>${esc(b.name)}</b><small>${b.count} pin${b.count === 1 ? '' : 's'}</small></a>`;
  }

  async function renderBoard(rid, id) {
    const b = await api('/boards/' + id);
    if (rid !== renderId) return;
    const mine = b.owner.id === state.me.id;
    view.innerHTML = `<div class="page">
      <div class="profile-head">
        <h1>${esc(b.name)}</h1>
        <div class="bio">${esc(b.description)}</div>
        <a class="pin-by" style="justify-content:center" href="#/u/${encodeURIComponent(b.owner.username)}">${avatar(b.owner, 28)}<span>${esc(b.owner.username)}</span> · ${b.count} pins</a>
        ${mine ? '<div class="profile-actions"><button class="btn danger" id="delBoard">Delete board</button></div>' : ''}
      </div><div id="host"></div></div>`;
    const host = $('#host');
    if (!b.pins.length) host.innerHTML = '<div class="empty"><h2>This board is empty</h2><p>Save pins to it from your feed.</p></div>';
    else {
      host.innerHTML = '<div class="masonry"></div>';
      const grid = host.firstChild;
      const opts = { boardId: b.id, boardOwner: mine };
      grid.innerHTML = b.pins.map(p => pinCard(p, opts)).join('');
      grid.addEventListener('click', e => onGridClick(e, opts));
      hookVideos(grid);
    }
    if (mine) $('#delBoard').addEventListener('click', async () => {
      if (!confirm('Delete this board? The pins themselves are kept.')) return;
      try { await api('/boards/' + b.id, { method: 'DELETE' }); location.hash = '#/u/' + encodeURIComponent(state.me.username); } catch (e) { toast(e.message); }
    });
  }

  /* ------------------------------- pin detail ------------------------------ */
  async function openPin(id) {
    let p;
    try { p = await api('/pins/' + id); } catch (e) { return toast(e.message); }
    const mine = p.user.id === state.me.id;
    const link = p.link ? (/^https?:\/\//i.test(p.link) ? p.link : 'https://' + p.link) : '';
    const m = openModal(`
      <div class="detail-media">${p.type === 'video' ? `<video src="${esc(p.url)}" controls autoplay loop playsinline></video>` : `<img src="${esc(p.url)}" alt="">`}</div>
      <div class="detail-info">
        <div class="row between">
          <div class="row"><button class="btn" id="likeBtn">${p.liked ? '♥' : '♡'} ${p.likes}</button></div>
          <div class="row">${mine ? '<button class="btn danger" id="delPin">Delete</button>' : ''}<button class="btn primary" id="savePin">Save</button><button class="close-x" id="closeX" aria-label="Close">✕</button></div>
        </div>
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:underline;overflow-wrap:anywhere">${esc(p.link)}</a>` : ''}
        <h1>${esc(p.title)}</h1>
        ${p.description ? `<p>${esc(p.description)}</p>` : ''}
        <div class="user-line">
          <a href="#/u/${encodeURIComponent(p.user.username)}" id="pinUser">${avatar(p.user, 44)}</a>
          <div class="grow"><b>${esc(p.user.username)}</b><small style="color:var(--muted)">${p.saves} save${p.saves === 1 ? '' : 's'}</small></div>
          ${followBtn({ ...p.user, following: false, id: p.user.id }, 'js-detail-follow')}
        </div>
        <div><b>${p.comments} comment${p.comments === 1 ? '' : 's'}</b></div>
        <div class="comments" id="comments">${p.commentList.map(commentHtml).join('')}</div>
        <form class="comment-form" id="commentForm"><input name="text" placeholder="Add a comment" maxlength="300" autocomplete="off" required><button class="btn primary" type="submit">Post</button></form>
      </div>`, true);
    // fix the follow button state (pin payload doesn't include it)
    const fb = $('.js-detail-follow', m);
    if (fb) {
      try {
        const prof = await api('/users/' + encodeURIComponent(p.user.username));
        fb.dataset.following = prof.isFollowing ? 1 : 0;
        fb.textContent = prof.isFollowing ? 'Following' : 'Follow';
        fb.classList.toggle('primary', !prof.isFollowing);
      } catch {}
    }
    $('#closeX', m).addEventListener('click', closeModal);
    $('#pinUser', m).addEventListener('click', closeModal);
    $('#savePin', m).addEventListener('click', () => openSave(p.id));
    $('#likeBtn', m).addEventListener('click', async e => {
      try { const r = await api(`/pins/${p.id}/like`, { method: 'POST' }); e.target.textContent = `${r.liked ? '♥' : '♡'} ${r.likes}`; } catch (err) { toast(err.message); }
    });
    if (mine) $('#delPin', m).addEventListener('click', async () => {
      if (!confirm('Delete this pin permanently?')) return;
      try { await api('/pins/' + p.id, { method: 'DELETE' }); closeModal(); toast('Pin deleted'); route(); } catch (err) { toast(err.message); }
    });
    $('#commentForm', m).addEventListener('submit', async e => {
      e.preventDefault();
      const input = e.target.elements.text;
      try {
        const c = await api(`/pins/${p.id}/comments`, { method: 'POST', body: { text: input.value } });
        $('#comments', m).insertAdjacentHTML('beforeend', commentHtml(c));
        input.value = '';
      } catch (err) { toast(err.message); }
    });
  }
  function commentHtml(c) {
    return `<div class="comment">${avatar(c.user, 28)}<div><b>${esc(c.user.username)}</b>${esc(c.text)}</div></div>`;
  }

  /* ----------------------------- save to board ----------------------------- */
  async function openSave(pinId) {
    let boards;
    try { boards = await api('/boards'); } catch (e) { return toast(e.message); }
    const m = openModal(`
      <div class="modal-head"><span></span><h2 style="margin:0">Save to board</h2><button class="close-x" id="cx">✕</button></div>
      <div class="board-pick" id="pick">
        ${boards.map(b => `<button data-id="${esc(b.id)}">${b.covers[0] ? mediaTag(b.covers[0], 'class="thumb"') : '<span class="thumb"></span>'}<span><b>${esc(b.name)}</b><br><small style="color:var(--muted)">${b.count} pins</small></span></button>`).join('') || '<div style="color:var(--muted);text-align:center;padding:12px">You have no boards yet — create one below.</div>'}
      </div>
      <form id="quickBoard" class="row"><input style="flex:1;padding:12px 14px;border-radius:14px;border:2px solid var(--border);background:var(--bg)" name="name" placeholder="New board name" maxlength="60" required><button class="btn primary" type="submit">Create &amp; save</button></form>`);
    $('#cx', m).addEventListener('click', closeModal);
    $$('#pick button', m).forEach(btn => btn.addEventListener('click', async () => {
      try { await api(`/pins/${pinId}/save`, { method: 'POST', body: { boardId: btn.dataset.id } }); closeModal(); toast('Saved to ' + btn.querySelector('b').textContent); } catch (e) { toast(e.message); }
    }));
    $('#quickBoard', m).addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const b = await api('/boards', { method: 'POST', body: { name: e.target.elements.name.value } });
        await api(`/pins/${pinId}/save`, { method: 'POST', body: { boardId: b.id } });
        closeModal(); toast('Saved to ' + b.name);
      } catch (err) { toast(err.message); }
    });
  }

  function openNewBoard(done) {
    const m = openModal(`
      <h2>Create board</h2>
      <form id="boardForm">
        <label class="field"><span>Name</span><input name="name" maxlength="60" required placeholder="Like “Recipes” or “Travel”"></label>
        <label class="field"><span>Description (optional)</span><textarea name="description" maxlength="300"></textarea></label>
        <div class="error" id="bErr"></div>
        <div class="row end"><button class="btn" type="button" id="cancel">Cancel</button><button class="btn primary" type="submit">Create</button></div>
      </form>`);
    $('#cancel', m).addEventListener('click', closeModal);
    $('#boardForm', m).addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target.elements;
      try { await api('/boards', { method: 'POST', body: { name: f.name.value, description: f.description.value } }); closeModal(); toast('Board created'); done && done(); } catch (err) { $('#bErr', m).textContent = err.message; }
    });
  }

  /* ------------------------------- create pin ------------------------------ */
  async function openCreatePin() {
    let boards = [];
    try { boards = await api('/boards'); } catch (e) { return toast(e.message); }
    const m = openModal(`
      <h2>Create Pin</h2>
      <form id="pinForm">
        <div class="dropzone" id="drop"><div><b>Click to upload</b> or drag and drop<br><small>Images or videos up to 200 MB</small></div></div>
        <input type="file" id="file" accept="image/*,video/*" class="hidden">
        <label class="field"><span>Title</span><input name="title" maxlength="100" required placeholder="Add a title"></label>
        <label class="field"><span>Description</span><textarea name="description" maxlength="500" placeholder="Tell everyone what your Pin is about"></textarea></label>
        <label class="field"><span>Link (optional)</span><input name="link" maxlength="300" placeholder="https://"></label>
        <label class="field"><span>Board</span>
          <select name="board"><option value="">No board</option>${boards.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}<option value="__new">+ Create new board…</option></select>
        </label>
        <label class="field hidden" id="newBoardField"><span>New board name</span><input name="newBoard" maxlength="60"></label>
        <div class="progress hidden" id="prog"><div></div></div>
        <div class="error" id="pErr"></div>
        <div class="row end"><button class="btn" type="button" id="cancel">Cancel</button><button class="btn primary" type="submit" id="publish">Publish</button></div>
      </form>`);
    const drop = $('#drop', m), fileInput = $('#file', m);
    let file = null, previewUrl = null;
    function setFile(f) {
      if (!f) return;
      if (!/^(image|video)\//.test(f.type)) { $('#pErr', m).textContent = 'Please choose an image or video file'; return; }
      $('#pErr', m).textContent = '';
      file = f;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(f);
      drop.innerHTML = f.type.startsWith('video/') ? `<video src="${previewUrl}" controls muted></video>` : `<img src="${previewUrl}" alt="">`;
      const t = m.elements ? null : $('input[name=title]', m);
      if (t && !t.value) t.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 100);
    }
    drop.addEventListener('click', e => { if (!e.target.closest('video')) fileInput.click(); });
    fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', e => setFile(e.dataTransfer.files[0]));
    $('select[name=board]', m).addEventListener('change', e => $('#newBoardField', m).classList.toggle('hidden', e.target.value !== '__new'));
    $('#cancel', m).addEventListener('click', closeModal);

    $('#pinForm', m).addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('#pErr', m), btn = $('#publish', m);
      if (!file) { err.textContent = 'Please choose an image or video first'; return; }
      const f = e.target.elements;
      btn.disabled = true; err.textContent = '';
      try {
        let boardId = f.board.value;
        if (boardId === '__new') {
          const name = f.newBoard.value.trim();
          if (!name) throw new Error('Please name your new board');
          boardId = (await api('/boards', { method: 'POST', body: { name } })).id;
        }
        const fd = new FormData();
        fd.append('title', f.title.value);
        fd.append('description', f.description.value);
        fd.append('link', f.link.value);
        if (boardId) fd.append('boardId', boardId);
        fd.append('file', file);
        const prog = $('#prog', m);
        prog.classList.remove('hidden');
        await upload('/pins', fd, r => { prog.firstChild.style.width = Math.round(r * 100) + '%'; });
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        closeModal();
        toast('Pin published!');
        const target = '#/u/' + encodeURIComponent(state.me.username);
        if (location.hash === target) route(); else location.hash = target;
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

  /* ------------------------- profile editing & lists ----------------------- */
  function openEditProfile(u) {
    const m = openModal(`
      <h2>Edit profile</h2>
      <form id="editForm">
        <div class="row" style="margin-bottom:14px"><span id="avPrev">${avatar(u, 64)}</span><button type="button" class="btn" id="chooseAv">Change photo</button><input type="file" id="avFile" accept="image/*" class="hidden"></div>
        <label class="field"><span>About you</span><textarea name="bio" maxlength="200">${esc(u.bio)}</textarea></label>
        <div class="error" id="eErr"></div>
        <div class="row end"><button class="btn" type="button" id="cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div>
      </form>`);
    let av = null;
    $('#chooseAv', m).addEventListener('click', () => $('#avFile', m).click());
    $('#avFile', m).addEventListener('change', e => {
      av = e.target.files[0];
      if (av) $('#avPrev', m).innerHTML = `<img class="avatar" src="${URL.createObjectURL(av)}" style="width:64px;height:64px">`;
    });
    $('#cancel', m).addEventListener('click', closeModal);
    $('#editForm', m).addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('bio', e.target.elements.bio.value);
      if (av) fd.append('avatar', av);
      try {
        state.me = await api('/me', { method: 'PUT', body: fd });
        closeModal(); renderNav(); route(); toast('Profile updated');
      } catch (err) { $('#eErr', m).textContent = err.message; }
    });
  }

  async function openConnections(username, kind) {
    let list;
    try { list = await api(`/users/${encodeURIComponent(username)}/connections?kind=${kind}`); } catch (e) { return toast(e.message); }
    const m = openModal(`
      <div class="modal-head"><span></span><h2 style="margin:0">${kind === 'followers' ? 'Followers' : 'Following'}</h2><button class="close-x" id="cx">✕</button></div>
      <div class="user-list">${list.length ? list.map(userRow).join('') : '<div class="empty" style="padding:30px">No one here yet</div>'}</div>`);
    $('#cx', m).addEventListener('click', closeModal);
    $$('.user-row a', m).forEach(a => a.addEventListener('click', closeModal));
  }

  // follow / unfollow (delegated so it works everywhere)
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-follow]');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const name = btn.dataset.follow, was = btn.dataset.following === '1';
    btn.disabled = true;
    try {
      const r = await api(`/users/${encodeURIComponent(name)}/follow`, { method: was ? 'DELETE' : 'POST' });
      $$(`[data-follow="${CSS.escape(name)}"]`).forEach(b => {
        b.dataset.following = r.isFollowing ? 1 : 0;
        b.textContent = r.isFollowing ? 'Following' : 'Follow';
        b.classList.toggle('primary', !r.isFollowing);
      });
      const fc = $('#followersCount');
      if (fc && location.hash.toLowerCase() === '#/u/' + encodeURIComponent(name).toLowerCase()) fc.textContent = r.followers;
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  });

  /* ----------------------------------- chat -------------------------------- */
  function setOnline(name, on) { on ? state.online.add(name) : state.online.delete(name); }

  function connectWS() {
    if (!state.token || state.ws) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${state.token}`);
    state.ws = ws;
    ws.onopen = () => { state.wsRetry = 0; };
    ws.onmessage = ev => { let d; try { d = JSON.parse(ev.data); } catch { return; } onSocket(d); };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.ws = null;
      if (state.token) setTimeout(connectWS, Math.min(1000 * 2 ** state.wsRetry++, 15000));
    };
  }

  function onSocket(d) {
    const inChat = state.view === 'chat';
    if (d.type === 'message') {
      if (inChat && chat.current === d.from) {
        appendMsg({ mine: false, text: d.text, at: d.at });
        $('#typing') && ($('#typing').textContent = '');
        api('/messages/' + encodeURIComponent(d.from)).catch(() => {}); // marks as read
      } else {
        state.unread++; updateBadge();
        toast(`💬 ${d.from}: ${d.text.length > 40 ? d.text.slice(0, 40) + '…' : d.text}`);
      }
      if (inChat) refreshConvos();
    } else if (d.type === 'sent') {
      if (inChat && chat.current === d.to) appendMsg({ mine: true, text: d.text, at: d.at });
      if (inChat) refreshConvos();
    } else if (d.type === 'typing') {
      if (inChat && chat.current === d.from && $('#typing')) {
        $('#typing').textContent = d.from + ' is typing…';
        clearTimeout(chat.typingTimer);
        chat.typingTimer = setTimeout(() => { const t = $('#typing'); if (t) t.textContent = ''; }, 2000);
      }
    } else if (d.type === 'presence') {
      setOnline(d.username, d.online);
      if (inChat) { renderConvoList(); updateHeadStatus(); }
    }
  }

  async function refreshConvos() {
    try {
      chat.convos = await api('/conversations');
      chat.convos.forEach(c => setOnline(c.user.username, c.online));
      if (state.view === 'chat') renderConvoList();
    } catch {}
  }

  function appendMsg(m) {
    const box = $('#msgs');
    if (!box) return;
    const empty = $('.chat-empty', box);
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'msg' + (m.mine ? ' mine' : '');
    div.innerHTML = `${esc(m.text)}<time>${timeStr(m.at)}</time>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function convoHtml(user, sub, unread, active) {
    return `<div class="convo ${active ? 'active' : ''}" data-user="${esc(user.username)}">
      <span class="avatar-wrap">${avatar(user, 46)}${state.online.has(user.username) ? '<span class="dot"></span>' : ''}</span>
      <span class="txt"><b>${esc(user.username)}</b><small>${esc(sub)}</small></span>
      ${unread ? `<span class="badge">${unread}</span>` : ''}</div>`;
  }

  function renderConvoList(results) {
    const list = $('#chatList');
    if (!list) return;
    if (results) {
      list.innerHTML = results.length ? results.map(u => convoHtml(u, u.bio || 'Start a conversation', 0, false)).join('') : '<div class="chat-empty">No users found</div>';
    } else if (chat.searching) {
      return;
    } else {
      list.innerHTML = chat.convos.length
        ? chat.convos.map(c => convoHtml(c.user, c.lastMessage, c.unread && chat.current !== c.user.username ? c.unread : 0, chat.current === c.user.username)).join('')
        : '<div class="chat-empty">No conversations yet.<br>Search for someone above to say hi.</div>';
    }
  }

  function updateHeadStatus() {
    const s = $('#headStatus');
    if (s && chat.current) s.textContent = state.online.has(chat.current) ? '● Online' : 'Offline';
  }

  async function renderChat(rid, username) {
    const [convos, thread] = await Promise.all([
      api('/conversations'),
      username ? api('/messages/' + encodeURIComponent(username)) : null
    ]);
    if (rid !== renderId) return;
    chat.convos = convos;
    chat.current = thread ? thread.user.username : null;
    chat.searching = false;
    convos.forEach(c => setOnline(c.user.username, c.online));
    if (thread) setOnline(thread.user.username, thread.online);

    view.innerHTML = `<div class="chat ${thread ? 'in-thread' : ''}">
      <aside class="chat-side">
        <h2>Messages</h2>
        <div class="search-users"><input id="userSearch" placeholder="Find people to message" autocomplete="off"></div>
        <div class="chat-list" id="chatList"></div>
      </aside>
      <section class="chat-main">
        ${thread ? `
          <div class="chat-head">
            <a class="icon-btn back-btn" href="#/chat" aria-label="Back">←</a>
            <a href="#/u/${encodeURIComponent(thread.user.username)}">${avatar(thread.user, 40)}</a>
            <div><b>${esc(thread.user.username)}</b><small id="headStatus"></small></div>
          </div>
          <div class="msgs" id="msgs"></div>
          <div class="typing" id="typing"></div>
          <form class="chat-form" id="chatForm"><input name="text" placeholder="Message ${esc(thread.user.username)}" autocomplete="off" maxlength="1000" required><button class="btn primary" type="submit">Send</button></form>`
        : '<div class="chat-empty"><h2>Your messages</h2><p>Pick a conversation or search for someone to chat with.</p></div>'}
      </section></div>`;
    renderConvoList();
    updateHeadStatus();

    $('#chatList').addEventListener('click', e => {
      const c = e.target.closest('.convo');
      if (c) location.hash = '#/chat/' + encodeURIComponent(c.dataset.user);
    });
    let t;
    $('#userSearch').addEventListener('input', e => {
      clearTimeout(t);
      const q = e.target.value.trim();
      if (!q) { chat.searching = false; renderConvoList(); return; }
      chat.searching = true;
      t = setTimeout(async () => {
        try { const r = await api('/users?q=' + encodeURIComponent(q)); if (chat.searching) renderConvoList(r); } catch {}
      }, 200);
    });

    if (thread) {
      const msgs = $('#msgs');
      if (!thread.messages.length) msgs.innerHTML = `<div class="chat-empty">Say hi to ${esc(thread.user.username)} 👋</div>`;
      thread.messages.forEach(appendMsg);
      msgs.scrollTop = msgs.scrollHeight;
      const form = $('#chatForm');
      const input = form.elements.text;
      input.focus();
      input.addEventListener('input', () => {
        const n = Date.now();
        if (state.ws && state.ws.readyState === 1 && n - chat.lastTypingSent > 1500) {
          chat.lastTypingSent = n;
          state.ws.send(JSON.stringify({ type: 'typing', to: chat.current }));
        }
      });
      form.addEventListener('submit', e => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        if (!state.ws || state.ws.readyState !== 1) { toast('Reconnecting… try again in a moment'); connectWS(); return; }
        state.ws.send(JSON.stringify({ type: 'message', to: chat.current, text }));
        input.value = '';
      });
      refreshUnread();
    }
  }

  /* ---------------------------------- router ------------------------------- */
  async function route() {
    if (!state.me) return renderAuth();
    closeModal();
    if (observer) { observer.disconnect(); observer = null; }
    const rid = ++renderId;
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const [a, b] = parts;
    state.view = a === 'chat' ? 'chat' : (a || 'home');
    if (a !== 'chat') chat.current = null;
    if (a !== 'search') $('#searchInput').value = '';
    setActiveNav(!a ? 'home' : a);
    view.innerHTML = '<div class="loader">Loading…</div>';
    try {
      if (!a) await renderHome(rid);
      else if (a === 'following') await renderFollowing(rid);
      else if (a === 'search') await renderSearch(rid, b || '');
      else if (a === 'u' && b) await renderProfile(rid, b);
      else if (a === 'board' && b) await renderBoard(rid, b);
      else if (a === 'chat') await renderChat(rid, b);
      else await renderHome(rid);
    } catch (e) {
      if (!state.me || rid !== renderId) return;
      view.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn primary" href="#/">Go home</a></div>`;
    }
  }
  window.addEventListener('hashchange', route);

  function startApp() {
    renderNav();
    connectWS();
    refreshUnread();
    if (/^#\/?$/.test(location.hash) || !location.hash) { if (location.hash !== '#/') history.replaceState(null, '', '#/'); }
    route();
  }

  async function boot() {
    themeIcons();
    if (!state.token) return renderAuth();
    try {
      state.me = await api('/me');
      startApp();
    } catch { if (!state.me) renderAuth(); }
  }
  boot();
})();

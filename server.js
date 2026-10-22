const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------------------- tiny JSON database ---------------------------- */
let db = { users: [], pins: [], boards: [], follows: [], likes: [], comments: [], messages: [], sessions: {} };
if (fs.existsSync(DB_FILE)) {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) { console.error('Could not read db.json, starting fresh'); }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }, 150);
}
const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

/* --------------------------------- helpers --------------------------------- */
const userById = id => db.users.find(u => u.id === id);
const userByName = n => db.users.find(u => u.username.toLowerCase() === String(n).toLowerCase());
const pubUser = u => u && ({ id: u.id, username: u.username, bio: u.bio || '', avatar: u.avatar || null });

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

function pinOut(p, me) {
  return {
    id: p.id, title: p.title, description: p.description, link: p.link, type: p.type, url: p.url,
    createdAt: p.createdAt, user: pubUser(userById(p.userId)),
    likes: db.likes.filter(l => l.pinId === p.id).length,
    liked: db.likes.some(l => l.pinId === p.id && l.userId === me),
    comments: db.comments.filter(c => c.pinId === p.id).length,
    saves: db.boards.filter(b => b.pinIds.includes(p.id)).length
  };
}
function boardOut(b, me, withPins) {
  const pins = b.pinIds.map(id => db.pins.find(p => p.id === id)).filter(Boolean);
  const out = {
    id: b.id, name: b.name, description: b.description, owner: pubUser(userById(b.userId)),
    count: pins.length, covers: pins.slice(-3).reverse().map(p => ({ type: p.type, url: p.url }))
  };
  if (withPins) out.pins = pins.slice().reverse().map(p => pinOut(p, me));
  return out;
}

/* ---------------------------------- uploads --------------------------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
      cb(null, uid() + uid() + ext);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image and video files are allowed'));
  }
});
const removeFile = url => { if (url && url.startsWith('/uploads/')) fs.unlink(path.join(UPLOAD_DIR, path.basename(url)), () => {}); };

/* ----------------------------------- app ----------------------------------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

const api = express.Router();

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const userId = token && db.sessions[token];
  if (!userId || !userById(userId)) return res.status(401).json({ error: 'Please log in' });
  req.user = userById(userId);
  req.token = token;
  next();
}

/* --- auth --- */
api.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[a-z0-9_]{3,20}$/i.test(username || '')) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (userByName(username)) return res.status(409).json({ error: 'That username is taken' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: uid(), username, salt, hash: hashPw(password, salt), bio: '', avatar: null, createdAt: now() };
  db.users.push(user);
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = user.id;
  save();
  res.json({ token, user: pubUser(user) });
});

api.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = userByName(username || '');
  if (!user || !crypto.timingSafeEqual(Buffer.from(hashPw(password || '', user.salt)), Buffer.from(user.hash)))
    return res.status(401).json({ error: 'Wrong username or password' });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = user.id;
  save();
  res.json({ token, user: pubUser(user) });
});

api.post('/logout', auth, (req, res) => { delete db.sessions[req.token]; save(); res.json({ ok: true }); });
api.get('/me', auth, (req, res) => res.json(pubUser(req.user)));

api.put('/me', auth, upload.single('avatar'), (req, res) => {
  if (typeof req.body.bio === 'string') req.user.bio = req.body.bio.slice(0, 200);
  if (req.file) {
    if (!req.file.mimetype.startsWith('image/')) { removeFile('/uploads/' + req.file.filename); return res.status(400).json({ error: 'Avatar must be an image' }); }
    removeFile(req.user.avatar);
    req.user.avatar = '/uploads/' + req.file.filename;
  }
  save();
  res.json(pubUser(req.user));
});

/* --- pins --- */
api.get('/pins', auth, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  const limit = Math.min(parseInt(req.query.limit) || 40, 100);
  const offset = parseInt(req.query.offset) || 0;
  let list = db.pins.slice().reverse();
  if (req.query.user) { const u = userByName(req.query.user); list = list.filter(p => u && p.userId === u.id); }
  if (req.query.following === '1') {
    const ids = db.follows.filter(f => f.from === req.user.id).map(f => f.to);
    list = list.filter(p => ids.includes(p.userId));
  }
  if (q) list = list.filter(p => (p.title + ' ' + p.description).toLowerCase().includes(q));
  res.json({ pins: list.slice(offset, offset + limit).map(p => pinOut(p, req.user.id)), total: list.length });
});

api.post('/pins', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image or video' });
  const title = String(req.body.title || '').trim().slice(0, 100);
  if (!title) { removeFile('/uploads/' + req.file.filename); return res.status(400).json({ error: 'Please add a title' }); }
  const pin = {
    id: uid(), userId: req.user.id, title,
    description: String(req.body.description || '').slice(0, 500),
    link: String(req.body.link || '').slice(0, 300),
    type: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
    url: '/uploads/' + req.file.filename, createdAt: now()
  };
  db.pins.push(pin);
  const board = db.boards.find(b => b.id === req.body.boardId && b.userId === req.user.id);
  if (board) board.pinIds.push(pin.id);
  save();
  res.json(pinOut(pin, req.user.id));
});

api.get('/pins/:id', auth, (req, res) => {
  const p = db.pins.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Pin not found' });
  const comments = db.comments.filter(c => c.pinId === p.id).map(c => ({ ...c, user: pubUser(userById(c.userId)) }));
  res.json({ ...pinOut(p, req.user.id), commentList: comments });
});

api.delete('/pins/:id', auth, (req, res) => {
  const p = db.pins.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Pin not found' });
  if (p.userId !== req.user.id) return res.status(403).json({ error: 'Not your pin' });
  db.pins = db.pins.filter(x => x !== p);
  db.boards.forEach(b => { b.pinIds = b.pinIds.filter(i => i !== p.id); });
  db.likes = db.likes.filter(l => l.pinId !== p.id);
  db.comments = db.comments.filter(c => c.pinId !== p.id);
  removeFile(p.url);
  save();
  res.json({ ok: true });
});

api.post('/pins/:id/like', auth, (req, res) => {
  const p = db.pins.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Pin not found' });
  const i = db.likes.findIndex(l => l.pinId === p.id && l.userId === req.user.id);
  if (i >= 0) db.likes.splice(i, 1); else db.likes.push({ pinId: p.id, userId: req.user.id });
  save();
  res.json(pinOut(p, req.user.id));
});

api.post('/pins/:id/save', auth, (req, res) => {
  const p = db.pins.find(x => x.id === req.params.id);
  const b = db.boards.find(x => x.id === req.body.boardId && x.userId === req.user.id);
  if (!p || !b) return res.status(404).json({ error: 'Pin or board not found' });
  if (!b.pinIds.includes(p.id)) b.pinIds.push(p.id);
  save();
  res.json({ ok: true, board: boardOut(b, req.user.id) });
});

api.delete('/boards/:id/pins/:pinId', auth, (req, res) => {
  const b = db.boards.find(x => x.id === req.params.id && x.userId === req.user.id);
  if (!b) return res.status(404).json({ error: 'Board not found' });
  b.pinIds = b.pinIds.filter(i => i !== req.params.pinId);
  save();
  res.json({ ok: true });
});

api.post('/pins/:id/comments', auth, (req, res) => {
  const p = db.pins.find(x => x.id === req.params.id);
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!p || !text) return res.status(400).json({ error: 'Comment cannot be empty' });
  const c = { id: uid(), pinId: p.id, userId: req.user.id, text, at: now() };
  db.comments.push(c);
  save();
  res.json({ ...c, user: pubUser(req.user) });
});

/* --- boards --- */
api.get('/boards', auth, (req, res) => {
  res.json(db.boards.filter(b => b.userId === req.user.id).map(b => boardOut(b, req.user.id)));
});
api.post('/boards', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Board needs a name' });
  const b = { id: uid(), userId: req.user.id, name, description: String(req.body.description || '').slice(0, 300), pinIds: [], createdAt: now() };
  db.boards.push(b);
  save();
  res.json(boardOut(b, req.user.id));
});
api.get('/boards/:id', auth, (req, res) => {
  const b = db.boards.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Board not found' });
  res.json(boardOut(b, req.user.id, true));
});
api.delete('/boards/:id', auth, (req, res) => {
  const b = db.boards.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Board not found' });
  if (b.userId !== req.user.id) return res.status(403).json({ error: 'Not your board' });
  db.boards = db.boards.filter(x => x !== b);
  save();
  res.json({ ok: true });
});

/* --- users, profiles, follows --- */
api.get('/users', auth, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  const list = db.users.filter(u => u.id !== req.user.id && (!q || u.username.toLowerCase().includes(q))).slice(0, 30);
  res.json(list.map(u => ({ ...pubUser(u), following: db.follows.some(f => f.from === req.user.id && f.to === u.id) })));
});

api.get('/users/:username', auth, (req, res) => {
  const u = userByName(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({
    ...pubUser(u),
    followers: db.follows.filter(f => f.to === u.id).length,
    following: db.follows.filter(f => f.from === u.id).length,
    pinCount: db.pins.filter(p => p.userId === u.id).length,
    isFollowing: db.follows.some(f => f.from === req.user.id && f.to === u.id),
    isMe: u.id === req.user.id,
    boards: db.boards.filter(b => b.userId === u.id).map(b => boardOut(b, req.user.id))
  });
});

api.get('/users/:username/connections', auth, (req, res) => {
  const u = userByName(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const kind = req.query.kind === 'following' ? 'following' : 'followers';
  const ids = kind === 'followers' ? db.follows.filter(f => f.to === u.id).map(f => f.from) : db.follows.filter(f => f.from === u.id).map(f => f.to);
  res.json(ids.map(userById).filter(Boolean).map(x => ({ ...pubUser(x), following: db.follows.some(f => f.from === req.user.id && f.to === x.id), isMe: x.id === req.user.id })));
});

api.post('/users/:username/follow', auth, (req, res) => {
  const u = userByName(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't follow yourself" });
  if (!db.follows.some(f => f.from === req.user.id && f.to === u.id)) db.follows.push({ from: req.user.id, to: u.id });
  save();
  res.json({ isFollowing: true, followers: db.follows.filter(f => f.to === u.id).length });
});
api.delete('/users/:username/follow', auth, (req, res) => {
  const u = userByName(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.follows = db.follows.filter(f => !(f.from === req.user.id && f.to === u.id));
  save();
  res.json({ isFollowing: false, followers: db.follows.filter(f => f.to === u.id).length });
});

/* --- chat (history over REST, live delivery over WebSocket) --- */
api.get('/conversations', auth, (req, res) => {
  const me = req.user.id;
  const map = new Map();
  for (const m of db.messages) {
    if (m.from !== me && m.to !== me) continue;
    const other = m.from === me ? m.to : m.from;
    const c = map.get(other) || { last: null, unread: 0 };
    c.last = m;
    if (m.to === me && !m.read) c.unread++;
    map.set(other, c);
  }
  const list = [...map.entries()].map(([id, c]) => ({
    user: pubUser(userById(id)), lastMessage: c.last.text, at: c.last.at, unread: c.unread, online: isOnline(id)
  })).filter(c => c.user).sort((a, b) => b.at - a.at);
  res.json(list);
});

api.get('/messages/:username', auth, (req, res) => {
  const other = userByName(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });
  const me = req.user.id;
  let changed = false;
  const msgs = db.messages.filter(m => (m.from === me && m.to === other.id) || (m.from === other.id && m.to === me));
  msgs.forEach(m => { if (m.to === me && !m.read) { m.read = true; changed = true; } });
  if (changed) save();
  res.json({ user: pubUser(other), online: isOnline(other.id), messages: msgs.slice(-200).map(m => ({ id: m.id, mine: m.from === me, text: m.text, at: m.at })) });
});

api.get('/unread', auth, (req, res) => {
  res.json({ count: db.messages.filter(m => m.to === req.user.id && !m.read).length });
});

api.use((req, res) => res.status(404).json({ error: 'Not found' }));
api.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Something went wrong' }));
app.use('/api', api);

/* ------------------------------- WebSocket chat ------------------------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const sockets = new Map(); // userId -> Set<ws>
const isOnline = id => sockets.has(id) && sockets.get(id).size > 0;
function sendTo(userId, payload) {
  const set = sockets.get(userId);
  if (set) set.forEach(ws => ws.readyState === 1 && ws.send(JSON.stringify(payload)));
}
function broadcastPresence(userId, online) {
  const u = userById(userId);
  if (!u) return;
  const peers = new Set();
  db.messages.forEach(m => { if (m.from === userId) peers.add(m.to); if (m.to === userId) peers.add(m.from); });
  db.follows.forEach(f => { if (f.from === userId) peers.add(f.to); if (f.to === userId) peers.add(f.from); });
  peers.forEach(p => sendTo(p, { type: 'presence', username: u.username, online }));
}

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const userId = db.sessions[token];
  if (!userId) { ws.close(4001, 'unauthorized'); return; }
  const wasOnline = isOnline(userId);
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(ws);
  if (!wasOnline) broadcastPresence(userId, true);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let data; try { data = JSON.parse(raw); } catch { return; }
    const me = userById(userId);
    const to = userByName(data.to || '');
    if (!me || !to || to.id === me.id) return;
    if (data.type === 'message') {
      const text = String(data.text || '').trim().slice(0, 1000);
      if (!text) return;
      const m = { id: uid(), from: me.id, to: to.id, text, at: now(), read: false };
      db.messages.push(m);
      save();
      sendTo(to.id, { type: 'message', from: me.username, id: m.id, text, at: m.at });
      sendTo(me.id, { type: 'sent', to: to.username, id: m.id, text, at: m.at, tempId: data.tempId });
    } else if (data.type === 'typing') {
      sendTo(to.id, { type: 'typing', from: me.username });
    }
  });

  ws.on('close', () => {
    const set = sockets.get(userId);
    if (set) { set.delete(ws); if (!set.size) { sockets.delete(userId); broadcastPresence(userId, false); } }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`Pinboard running on http://localhost:${PORT}`));

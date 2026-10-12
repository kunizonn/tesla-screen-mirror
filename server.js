'use strict';

// Tesla Screen Mirror サーバー
// - 静的ファイル配信(視聴ページ / 送信ページ)
// - WebSocket: 接続コードによるルーム管理、JPEGフレーム中継、時刻同期

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const CODE_LENGTH = Math.min(Math.max(Number(process.env.CODE_LENGTH) || 4, 4), 8);
// 既定では送信側はこのPC(localhost)からの接続のみ許可する
const ALLOW_REMOTE_SENDER = process.env.ALLOW_REMOTE_SENDER === '1';
const MAX_VIEWERS_PER_ROOM = 3;
const ROOM_GRACE_MS = 10 * 60 * 1000; // 送信側が切断してからルームを保持する時間
const FAIL_WINDOW_MS = 5 * 60 * 1000; // 接続コード誤りの集計期間
const FAIL_LIMIT = 10; // 集計期間内に許す誤り回数(IPごと)
const VIEWER_BUFFER_LIMIT = 512 * 1024; // 視聴側の送信待ちがこれを超えたらフレームを捨てる
const FRAME_HEADER_BYTES = 16;

const PUBLIC_DIR = path.join(__dirname, 'public');
// 同じWi-Fi・テザリング内から直接開くためのアドレス(http://192.168.x.x:3000/ など)
function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) urls.push(`http://${a.address}:${port}/`);
    }
  }
  return urls;
}

const ROUTES = { '/': 'viewer.html', '/view': 'viewer.html', '/send': 'sender.html' };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let publicUrl = null;

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, number[]>} */
const failures = new Map();

function log(...args) {
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  console.log(`[${t}]`, ...args);
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// cloudflared経由の接続はlocalhostから来るので、そのときだけCF-Connecting-IPを信用する
function clientInfo(req) {
  const remote = req.socket.remoteAddress || '';
  const cfIp = req.headers['cf-connecting-ip'];
  if (isLoopback(remote) && cfIp) return { ip: String(cfIp), local: false };
  return { ip: remote, local: isLoopback(remote) };
}

// ---------- HTTP ----------

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ publicUrl, lanUrls: lanUrls(PORT), codeLength: CODE_LENGTH, port: PORT }));
    return;
  }
  const rel = ROUTES[url.pathname] || url.pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(buf);
  });
}

// ---------- ルーム ----------

class Room {
  constructor(code, token) {
    this.code = code;
    this.token = token;
    this.sender = null;
    this.viewers = new Set();
    this.lastFrame = null;
    this.expireTimer = null;
    this.mode = 'ws'; // 'ws' = WebSocket中継, 'webrtc' = P2P
  }

  setSender(ws) {
    if (this.sender && this.sender !== ws) this.sender.close(4000, 'replaced');
    this.sender = ws;
    clearTimeout(this.expireTimer);
    this.expireTimer = null;
    this.broadcast({ type: 'sender', online: true });
    this.broadcast({ type: 'mode', mode: this.mode });
    this.notifyViewerCount();
  }

  removeSender(ws) {
    if (this.sender !== ws) return;
    this.sender = null;
    this.lastFrame = null;
    this.broadcast({ type: 'sender', online: false });
    this.expireTimer = setTimeout(() => this.destroy('expired'), ROOM_GRACE_MS);
  }

  addViewer(ws) {
    this.viewers.add(ws);
    this.notifyViewerCount();
  }

  removeViewer(ws) {
    if (this.viewers.delete(ws)) this.notifyViewerCount();
  }

  // 送信側には、視聴者のIDと「JPEGフレームが必要な視聴者の数」を伝える
  notifyViewerCount() {
    const ids = [...this.viewers].map((v) => v.id);
    const relayCount = [...this.viewers].filter((v) => v.wantsFrames).length;
    send(this.sender, { type: 'viewers', count: ids.length, ids, relayCount });
  }

  setMode(mode) {
    if (mode !== 'ws' && mode !== 'webrtc') return;
    this.mode = mode;
    this.broadcast({ type: 'mode', mode });
  }

  viewerById(id) {
    for (const v of this.viewers) if (v.id === id) return v;
    return null;
  }

  broadcast(msg) {
    for (const v of this.viewers) send(v, msg);
  }

  relayFrame(buf) {
    this.lastFrame = buf;
    for (const v of this.viewers) {
      if (v.readyState !== v.OPEN || !v.wantsFrames) continue;
      // 回線が詰まっている視聴者にはフレームを捨てて遅延の蓄積を防ぐ
      if (v.bufferedAmount > VIEWER_BUFFER_LIMIT) continue;
      v.send(buf, { binary: true });
    }
  }

  destroy(reason) {
    clearTimeout(this.expireTimer);
    for (const v of this.viewers) {
      send(v, { type: 'error', error: 'room_closed' });
      v.close(4001, reason);
    }
    rooms.delete(this.code);
    log(`ルーム ${this.code} を削除しました (${reason})`);
  }
}

function newCode() {
  const max = 10 ** CODE_LENGTH;
  for (let i = 0; i < 1000; i++) {
    const code = String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
    if (!rooms.has(code)) return code;
  }
  throw new Error('空き接続コードがありません');
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- 接続コード総当たり対策 ----------

function recentFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list;
}

function rateLimitRetryAfter(ip) {
  const list = recentFailures(ip);
  if (list.length < FAIL_LIMIT) return 0;
  return Math.ceil((list[0] + FAIL_WINDOW_MS - Date.now()) / 1000);
}

function recordFailure(ip) {
  const list = recentFailures(ip);
  list.push(Date.now());
  failures.set(ip, list);
}

// ---------- WebSocket ----------

function handleHello(ws, msg) {
  if (ws.role) return;

  if (msg.role === 'sender') {
    if (!ws.local && !ALLOW_REMOTE_SENDER) {
      send(ws, { type: 'error', error: 'sender_forbidden' });
      ws.close(4003, 'sender_forbidden');
      return;
    }
    let room = typeof msg.code === 'string' ? rooms.get(msg.code) : undefined;
    if (room && room.token !== msg.token) room = undefined;
    if (!room) {
      // サーバー再起動後は、以前のコードが空いていれば引き継ぐ(視聴側がそのまま再接続できる)
      const reuse =
        typeof msg.code === 'string' &&
        msg.code.length === CODE_LENGTH &&
        /^\d+$/.test(msg.code) &&
        typeof msg.token === 'string' &&
        !rooms.has(msg.code);
      const code = reuse ? msg.code : newCode();
      const token = reuse ? msg.token : crypto.randomBytes(16).toString('hex');
      room = new Room(code, token);
      rooms.set(code, room);
      log(`送信側が接続しました。接続コード: ${code}`);
    } else {
      log(`送信側が再接続しました。接続コード: ${room.code}`);
    }
    ws.role = 'sender';
    ws.room = room;
    room.setSender(ws);
    send(ws, { type: 'room', code: room.code, token: room.token, publicUrl });
    return;
  }

  if (msg.role === 'viewer') {
    const retryAfter = rateLimitRetryAfter(ws.ip);
    if (retryAfter > 0) {
      send(ws, { type: 'error', error: 'rate_limited', retryAfter });
      ws.close(4029, 'rate_limited');
      return;
    }
    const room = typeof msg.code === 'string' ? rooms.get(msg.code) : undefined;
    if (!room) {
      recordFailure(ws.ip);
      log(`接続コード誤り (${ws.ip})`);
      send(ws, { type: 'error', error: 'bad_code' });
      ws.close(4004, 'bad_code');
      return;
    }
    if (room.viewers.size >= MAX_VIEWERS_PER_ROOM) {
      send(ws, { type: 'error', error: 'room_full' });
      ws.close(4005, 'room_full');
      return;
    }
    failures.delete(ws.ip);
    ws.role = 'viewer';
    ws.room = room;
    ws.id = crypto.randomBytes(6).toString('hex');
    ws.wantsFrames = true;
    room.addViewer(ws);
    log(`視聴側が接続しました。コード: ${room.code} 視聴者数: ${room.viewers.size}`);
    send(ws, { type: 'joined', senderOnline: !!room.sender, mode: room.mode });
    if (room.lastFrame && room.mode === 'ws') ws.send(room.lastFrame, { binary: true });
  }
}

function handleMessage(ws, data, isBinary) {
  if (isBinary) {
    if (ws.role === 'sender' && data.length > FRAME_HEADER_BYTES) ws.room.relayFrame(data);
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'hello':
      handleHello(ws, msg);
      break;
    case 'ping':
      send(ws, { type: 'pong', t: msg.t, s: Date.now() });
      break;
    case 'ack':
      // 視聴側の描画完了を送信側に伝える(送信側の流量制御に使う)
      if (ws.role === 'viewer') send(ws.room.sender, { type: 'ack', id: msg.id });
      break;
    case 'mode':
      if (ws.role === 'sender') ws.room.setMode(msg.mode);
      break;
    case 'frames':
      // WebRTCで表示できている視聴者はJPEGフレームを受け取らない
      if (ws.role === 'viewer') {
        ws.wantsFrames = !!msg.on;
        ws.room.notifyViewerCount();
      }
      break;
    case 'signal':
      // WebRTCのシグナリング(SDP・ICE候補)を中継する
      if (ws.role === 'sender' && typeof msg.to === 'string') {
        send(ws.room.viewerById(msg.to), { type: 'signal', data: msg.data });
      } else if (ws.role === 'viewer') {
        send(ws.room.sender, { type: 'signal', from: ws.id, data: msg.data });
      }
      break;
    case 'stats':
      if (ws.role === 'viewer') send(ws.room.sender, { type: 'viewer-stats', latency: msg.latency, fps: msg.fps });
      break;
  }
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    Object.assign(ws, clientInfo(req));
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data, isBinary) => handleMessage(ws, data, isBinary));
    ws.on('close', () => {
      if (!ws.room) return;
      if (ws.role === 'sender') {
        ws.room.removeSender(ws);
        log(`送信側が切断しました。コード: ${ws.room.code}`);
      } else {
        ws.room.removeViewer(ws);
        log(`視聴側が切断しました。コード: ${ws.room.code}`);
      }
    });
    ws.on('error', () => {});
  });

  // 応答のない接続を検出して閉じる
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

function start(port = PORT) {
  const server = http.createServer(serveStatic);
  attachWebSocket(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

function setPublicUrl(url) {
  publicUrl = url;
  for (const room of rooms.values()) send(room.sender, { type: 'public-url', publicUrl });
}

module.exports = { start, setPublicUrl, lanUrls, PORT };

if (require.main === module) {
  start()
    .then(() => {
      log(`サーバーを起動しました: http://localhost:${PORT}`);
      log(`送信ページ(このPCで開く): http://localhost:${PORT}/send`);
      log('Teslaから外部ネットワーク経由で開くには npm run tunnel を使ってください。');
    })
    .catch((err) => {
      console.error(err.code === 'EADDRINUSE' ? `ポート ${PORT} は使用中です。PORT=3001 npm start などで変更してください。` : err);
      process.exit(1);
    });
}

'use strict';

// 送信ページ・視聴ページ共通: 自動再接続するWebSocketと、サーバー時刻との同期

const FRAME_HEADER_BYTES = 16;
const FRAME_MAGIC = 0x46; // 'F'

class MirrorSocket {
  /**
   * @param {object} opts
   * @param {() => object} opts.hello 接続のたびに送る hello メッセージを返す
   * @param {(msg: object) => void} opts.onMessage
   * @param {(buf: ArrayBuffer) => void} [opts.onBinary]
   * @param {(state: 'connecting'|'open'|'closed') => void} [opts.onState]
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.retry = 0;
    this.retryTimer = null;
    this.stopped = true;
    this.clock = new ClockSync();
    this.pingTimer = null;
  }

  start() {
    this.stopped = false;
    this.retry = 0;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  /** 次回の再接続までの待ち時間を指定する(ms)。0なら通常のバックオフ */
  reconnectLater(ms) {
    this.forcedDelay = ms;
  }

  get open() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  get bufferedAmount() {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.opts.onState?.('connecting');

    ws.onopen = () => {
      this.retry = 0;
      this.forcedDelay = 0;
      this.sendJson(this.opts.hello());
      this.clock.reset();
      this.ping();
      clearInterval(this.pingTimer);
      // 時刻同期を兼ねたキープアライブ(トンネルのアイドル切断対策)
      this.pingTimer = setInterval(() => this.ping(), 2000);
      this.opts.onState?.('open');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        this.opts.onBinary?.(ev.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        this.clock.add(msg.t, msg.s, performance.now());
        return;
      }
      this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      this.opts.onState?.('closed');
      if (this.stopped) return;
      const delay = this.forcedDelay || Math.min(500 * 2 ** this.retry, 5000);
      this.retry++;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  ping() {
    this.sendJson({ type: 'ping', t: performance.now() });
  }

  sendJson(msg) {
    if (this.open) this.ws.send(JSON.stringify(msg));
  }

  sendBinary(data) {
    if (this.open) this.ws.send(data);
  }
}

// サーバー時刻のオフセットを推定する(往復時間が最小のサンプルを採用)
class ClockSync {
  constructor() {
    this.samples = [];
    this.offset = null; // serverTime - performance.now()
  }

  reset() {
    this.samples = [];
  }

  add(t0, serverTime, t1) {
    const rtt = t1 - t0;
    this.samples.push({ rtt, offset: serverTime - (t0 + t1) / 2 });
    if (this.samples.length > 10) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = best.rtt;
  }

  get ready() {
    return this.offset !== null;
  }

  now() {
    return performance.now() + (this.offset ?? 0);
  }
}

// フレーム形式: [magic u8][version u8][reserved u16][frameId u32][captureTime f64 (サーバー時刻ms)][JPEG...]
function buildFrameHeader(id, captureTime) {
  const header = new ArrayBuffer(FRAME_HEADER_BYTES);
  const dv = new DataView(header);
  dv.setUint8(0, FRAME_MAGIC);
  dv.setUint8(1, 1);
  dv.setUint32(4, id >>> 0);
  dv.setFloat64(8, captureTime);
  return header;
}

function parseFrame(buf) {
  if (buf.byteLength <= FRAME_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== FRAME_MAGIC) return null;
  return {
    id: dv.getUint32(4),
    captureTime: dv.getFloat64(8),
    jpeg: new Uint8Array(buf, FRAME_HEADER_BYTES),
  };
}

// 直近1秒あたりの回数を数える
class RateMeter {
  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
    this.events = [];
  }

  tick(value = 1) {
    const now = performance.now();
    this.events.push([now, value]);
    this.trim(now);
  }

  trim(now) {
    while (this.events.length && now - this.events[0][0] > this.windowMs) this.events.shift();
  }

  get count() {
    this.trim(performance.now());
    return this.events.length;
  }

  get sum() {
    this.trim(performance.now());
    return this.events.reduce((a, [, v]) => a + v, 0);
  }
}

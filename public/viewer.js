'use strict';

// 視聴ページ: 接続コードで入室し、映像を全画面で表示する。
// WebSocket中継モードはJPEGをcanvasに描き、WebRTCモードはvideo要素で再生する(つながらなければ中継に切り替える)

const $ = (id) => document.getElementById(id);

const BAD_CODE_RETRIES = 5; // 再接続時(サーバー再起動など)にコード不一致を許す回数
const STALL_MS = 3000; // この時間フレームが届かなければ案内を出す
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const OFFER_WAIT_MS = 6000; // WebRTCモードでこの時間オファーが来なければ中継で表示する
const RTC_CONNECT_MS = 10000; // この時間でWebRTCがつながらなければ中継で表示する

let codeLength = 4;
let code = '';
let joined = false; // 一度でも入室できたか(再接続時の判定に使う)
let badCodeRetries = 0;
let senderOnline = false;
let lastFrameAt = 0;
let decoding = false;
let pending = null;
let showStats = true;
let latencyMs = null;
let wakeLock = null;
let mode = 'ws';
let pc = null;
let rtcConnected = false;
let wantFrames = true;
let offerTimer = null;
let connectTimer = null;
let rtcRetries = 0;
let latencyIsEstimate = false;
let lastCaptureTimeAt = 0;

const canvas = $('screen');
const video = $('video');
const ctx = canvas.getContext('2d', { alpha: false });
const fpsMeter = new RateMeter();

// ---------- 接続コード入力 ----------

function renderDigits() {
  const box = $('digits');
  box.innerHTML = '';
  for (let i = 0; i < codeLength; i++) {
    const d = document.createElement('div');
    d.className = 'digit' + (i === code.length ? ' current' : '');
    d.textContent = code[i] || '';
    box.appendChild(d);
  }
  document.querySelector('[data-k=ok]').disabled = code.length !== codeLength;
}

$('keypad').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.k;
  if (!k) return;
  $('entryMsg').textContent = '';
  if (k === 'del') code = code.slice(0, -1);
  else if (k === 'ok') return connect();
  else if (code.length < codeLength) code += k;
  renderDigits();
  if (code.length === codeLength && k !== 'del') connect();
});

function showEntry(message = '') {
  socket.stop();
  closeRtc();
  clearTimeout(offerTimer);
  releaseWakeLock();
  joined = false;
  code = '';
  renderDigits();
  $('entryMsg').textContent = message;
  $('viewer').hidden = true;
  $('entry').hidden = false;
}

function connect() {
  if (code.length !== codeLength) return;
  joined = false;
  badCodeRetries = 0;
  lastFrameAt = 0;
  $('entry').hidden = true;
  $('viewer').hidden = false;
  $('menu').hidden = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setBanner('接続中…');
  socket.start();
}

// ---------- サーバー接続 ----------

const socket = new MirrorSocket({
  hello: () => ({ type: 'hello', role: 'viewer', code }),
  onState: (state) => {
    if (state === 'closed' && joined) setBanner('接続が切れました。再接続中…');
  },
  onMessage: (msg) => {
    switch (msg.type) {
      case 'joined':
        joined = true;
        badCodeRetries = 0;
        senderOnline = msg.senderOnline;
        wantFrames = true; // サーバー側の初期値に合わせる
        rtcRetries = 0;
        closeRtc();
        setMode(msg.mode || 'ws');
        requestWakeLock();
        updateBanner();
        break;
      case 'mode':
        setMode(msg.mode);
        break;
      case 'signal':
        handleSignal(msg.data);
        break;
      case 'sender':
        senderOnline = msg.online;
        updateBanner();
        break;
      case 'error':
        handleError(msg);
        break;
    }
  },
  onBinary: (buf) => {
    const frame = parseFrame(buf);
    if (!frame) return;
    if (rtcConnected) {
      socket.sendJson({ type: 'ack', id: frame.id });
      return;
    }
    // デコードが追いつかない場合は古いフレームを捨て、常に最新だけを描く
    if (decoding) {
      if (pending) socket.sendJson({ type: 'ack', id: pending.id });
      pending = frame;
      return;
    }
    drawFrame(frame);
  },
});

function handleError(msg) {
  switch (msg.error) {
    case 'bad_code':
      if (joined && badCodeRetries < BAD_CODE_RETRIES) {
        // サーバー再起動直後は送信側の再接続を待つ
        badCodeRetries++;
        socket.reconnectLater(3000);
        setBanner('サーバー再起動を検出。送信側を待っています…');
      } else {
        showEntry(joined ? '送信側が見つかりません。コードを入力し直してください。' : '接続コードが違います。');
      }
      break;
    case 'rate_limited':
      showEntry(`入力の誤りが多すぎます。${Math.ceil(msg.retryAfter / 60)}分ほど待ってから再度お試しください。`);
      break;
    case 'room_full':
      showEntry('視聴できる台数の上限に達しています。');
      break;
    case 'room_closed':
      showEntry('送信側が終了しました。');
      break;
  }
}

// ---------- 描画 ----------

async function drawFrame(frame) {
  decoding = true;
  try {
    const bitmap = await createImageBitmap(new Blob([frame.jpeg], { type: 'image/jpeg' }));
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    lastFrameAt = performance.now();
    fpsMeter.tick();
    if (socket.clock.ready) {
      const l = Math.max(0, socket.clock.now() - frame.captureTime);
      latencyMs = latencyMs == null ? l : latencyMs * 0.8 + l * 0.2;
    }
    updateBanner();
  } catch (err) {
    console.warn('フレームの描画に失敗しました', err);
  } finally {
    socket.sendJson({ type: 'ack', id: frame.id });
    decoding = false;
  }
  if (pending) {
    const next = pending;
    pending = null;
    drawFrame(next);
  }
}

// ---------- WebRTC ----------

function setMode(m) {
  mode = m === 'webrtc' && typeof RTCPeerConnection === 'function' ? 'webrtc' : 'ws';
  clearTimeout(offerTimer);
  if (mode === 'ws') {
    closeRtc();
    useFrames(true);
    return;
  }
  if (rtcConnected) return;
  // 送信側からのオファーを待つ。来なければ中継のJPEGで表示しておく
  useFrames(false);
  offerTimer = setTimeout(() => useFrames(true), OFFER_WAIT_MS);
}

function useFrames(on) {
  if (wantFrames === on) return;
  wantFrames = on;
  socket.sendJson({ type: 'frames', on });
}

function showVideo(on) {
  video.hidden = !on;
  canvas.hidden = on;
}

function closeRtc() {
  clearTimeout(connectTimer);
  if (pc) {
    pc.onconnectionstatechange = pc.ontrack = pc.onicecandidate = null;
    pc.close();
  }
  pc = null;
  rtcConnected = false;
  video.srcObject = null;
  showVideo(false);
}

async function handleSignal(data) {
  if (!data) return;
  if (data.sdp?.type === 'offer') {
    clearTimeout(offerTimer);
    closeRtc();
    pc = new RTCPeerConnection(RTC_CONFIG);
    const thisPc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.sendJson({ type: 'signal', data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0] || new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc !== thisPc) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        clearTimeout(connectTimer);
        rtcConnected = true;
        rtcRetries = 0;
        lastFrameAt = performance.now();
        latencyMs = null;
        showVideo(true);
        useFrames(false);
      } else if (st === 'failed' || st === 'closed') {
        rtcFallback();
      }
    };
    // 一定時間つながらなければ、中継のJPEGで表示しておく(後からつながれば切り替わる)
    connectTimer = setTimeout(() => {
      if (!rtcConnected) useFrames(true);
    }, RTC_CONNECT_MS);
    try {
      await pc.setRemoteDescription(data.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      socket.sendJson({ type: 'signal', data: { sdp: pc.localDescription } });
    } catch (err) {
      console.warn('WebRTCの接続に失敗しました', err);
      rtcFallback();
    }
  } else if (data.candidate && pc) {
    pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

// WebRTCが切れたら中継に切り替え、少し待ってからやり直しを頼む
function rtcFallback() {
  closeRtc();
  useFrames(true);
  if (mode === 'webrtc' && rtcRetries < 3) {
    rtcRetries++;
    setTimeout(() => {
      if (mode === 'webrtc' && !pc && socket.open) socket.sendJson({ type: 'signal', data: { request: 'offer' } });
    }, 3000 * rtcRetries);
  }
}

// 届いた映像フレームごとに呼ばれる。送信側の撮影時刻が分かれば遅延を計算する
function onVideoFrame(now, meta) {
  lastFrameAt = performance.now();
  fpsMeter.tick();
  if (meta && meta.captureTime && meta.expectedDisplayTime) {
    const l = meta.expectedDisplayTime - meta.captureTime;
    if (l > 0 && l < 10000) {
      latencyMs = latencyMs == null || latencyIsEstimate ? l : latencyMs * 0.8 + l * 0.2;
      latencyIsEstimate = false;
      lastCaptureTimeAt = lastFrameAt;
    }
  }
  video.requestVideoFrameCallback(onVideoFrame);
}
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(onVideoFrame);

// 撮影時刻が取れないブラウザ向け: 受信バッファ・デコード時間・往復時間から遅延を見積もる
let prevRtc = null;
async function estimateRtcLatency() {
  if (!pc || !rtcConnected) return;
  const report = await pc.getStats();
  let inb = null;
  let rtt = null;
  report.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
    if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
  });
  if (!inb) return;
  const cur = { jb: inb.jitterBufferDelay || 0, n: inb.jitterBufferEmittedCount || 0, dec: inb.totalDecodeTime || 0, f: inb.framesDecoded || 0 };
  if (prevRtc && cur.n > prevRtc.n && performance.now() - lastCaptureTimeAt > 2000) {
    const jb = (cur.jb - prevRtc.jb) / (cur.n - prevRtc.n);
    const dec = cur.f > prevRtc.f ? (cur.dec - prevRtc.dec) / (cur.f - prevRtc.f) : 0;
    latencyMs = (jb + dec + (rtt || 0) / 2) * 1000 + 20; // 20ms: 送信側のキャプチャ・エンコード分の目安
    latencyIsEstimate = true;
  }
  prevRtc = cur;
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    // フレームごとの通知がない場合はfpsもstatsから取る
    lastFrameAt = performance.now();
  }
}

function setBanner(text) {
  $('banner').hidden = !text;
  $('banner').textContent = text || '';
}

function updateBanner() {
  if (!joined) return;
  if (!socket.open) setBanner('接続が切れました。再接続中…');
  else if (!senderOnline) setBanner('送信側(PC)の接続を待っています…');
  else if (rtcConnected) setBanner(''); // WebRTCは画面に変化がないとフレームが来ないので、止まっている表示は出さない
  else if (!lastFrameAt) setBanner('映像を待っています…\nPCで画面共有を開始してください');
  else if (performance.now() - lastFrameAt > STALL_MS) setBanner('映像が止まっています…');
  else setBanner('');
}

setInterval(async () => {
  if ($('viewer').hidden) return;
  if (rtcConnected) await estimateRtcLatency().catch(() => {});
  const fps = fpsMeter.count;
  if (!rtcConnected && performance.now() - lastFrameAt > STALL_MS) latencyMs = null;
  const latency = latencyMs == null ? '--' : (latencyIsEstimate && rtcConnected ? '~' : '') + Math.round(latencyMs);
  $('stats').textContent = `${latency} ms · ${fps} fps · ${rtcConnected ? 'WebRTC' : '中継'}`;
  updateBanner();
  if (joined) socket.sendJson({ type: 'stats', latency: latencyMs == null ? null : Math.round(latencyMs), fps });
}, 1000);

// ---------- タッチ操作 ----------

let menuTimer = null;
$('viewer').addEventListener('click', (e) => {
  if (e.target.closest('#menu')) return;
  toggleMenu(!!$('menu').hidden);
});

function toggleMenu(show) {
  $('menu').hidden = !show;
  clearTimeout(menuTimer);
  if (show) menuTimer = setTimeout(() => toggleMenu(false), 6000);
}

$('btnFullscreen').onclick = () => {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (req) {
    Promise.resolve(req.call(el)).catch(() => {});
  }
  toggleMenu(false);
};

$('btnStats').onclick = () => {
  showStats = !showStats;
  $('stats').hidden = !showStats;
  $('btnStats').textContent = showStats ? '統計 非表示' : '統計 表示';
  toggleMenu(true);
};

$('btnLeave').onclick = () => showEntry();

// ---------- 画面の自動消灯防止(対応ブラウザのみ) ----------

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && joined) requestWakeLock();
});

// ---------- 起動 ----------

(async () => {
  try {
    const info = await fetch('/api/info').then((r) => r.json());
    codeLength = info.codeLength || 4;
  } catch {}
  const fromUrl = new URLSearchParams(location.search).get('code');
  if (fromUrl && /^\d+$/.test(fromUrl) && fromUrl.length === codeLength) {
    code = fromUrl;
    history.replaceState(null, '', location.pathname);
    connect();
    return;
  }
  renderDigits();
})();

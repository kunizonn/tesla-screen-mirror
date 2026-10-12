'use strict';

// 送信ページ: getDisplayMedia でキャプチャした画面を送る。
// WebSocket中継モードはJPEGにしてサーバー経由で、WebRTCモードは動画としてP2Pで送る

const $ = (id) => document.getElementById(id);

const DEFAULTS = { resolution: '1280x720', fps: 20, quality: 0.6, mode: 'ws' };
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
// 視聴側の描画完了を待たずに送ってよいフレーム数(約0.4秒分)。
// 往復の遅いトンネル経由でもfpsを保ちつつ、回線が詰まったときの遅延の蓄積を抑える
const maxInFlight = () => Math.max(2, Math.ceil(settings.fps * 0.4));
const ACK_TIMEOUT_MS = 1000; // ackが来なくてもこの時間が経てば送信を再開する
const MAX_BUFFERED = 512 * 1024; // ブラウザ側の送信待ちがこれを超えたら送らない
const IDLE_RESEND_MS = 1000; // 画面に変化がなくてもこの間隔で1枚送る

const settings = loadSettings();
const room = JSON.parse(sessionStorage.getItem('mirror-room') || 'null') || {};

let stream = null;
let frameSource = null;
let viewers = 0; // 視聴者の総数
let viewerIds = [];
let relayViewers = 0; // JPEGフレームを受け取る視聴者の数
let lanIps = [];
/** @type {Map<string, RTCPeerConnection>} 視聴者ID → WebRTC接続 */
const peers = new Map();
let frameId = 0;
let lastAckId = 0;
let lastAckTime = 0;
let lastSentTime = 0;
let encoding = false;
let forceNext = true;

const canvas = $('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const fpsMeter = new RateMeter();
const byteMeter = new RateMeter();

// ---------- 設定 ----------

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('mirror-settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem('mirror-settings', JSON.stringify(settings));
  } catch {}
}

function bindSettings() {
  $('resolution').value = settings.resolution;
  $('fps').value = settings.fps;
  $('quality').value = settings.quality;
  $('mode').value = settings.mode;
  const render = () => {
    const rtc = settings.mode === 'webrtc';
    $('resolutionOut').textContent = '';
    $('fpsOut').textContent = `${settings.fps} fps`;
    $('qualityLabel').textContent = rtc ? '画質(ビットレート)' : 'JPEG画質';
    $('qualityOut').textContent = rtc
      ? (rtcBitrate() / 1e6).toFixed(1) + ' Mbps'
      : Math.round(settings.quality * 100) + '%';
  };
  $('resolution').onchange = (e) => {
    settings.resolution = e.target.value;
    saveSettings();
    forceNext = true;
    applyRtcEncodings();
  };
  $('fps').oninput = (e) => {
    settings.fps = Number(e.target.value);
    saveSettings();
    render();
    ticker.postMessage(stream ? 1000 / settings.fps : 0);
    applyRtcEncodings();
  };
  $('quality').oninput = (e) => {
    settings.quality = Number(e.target.value);
    saveSettings();
    render();
    forceNext = true;
    applyRtcEncodings();
  };
  $('mode').onchange = (e) => {
    settings.mode = e.target.value;
    saveSettings();
    render();
    socket.sendJson({ type: 'mode', mode: settings.mode });
    syncPeers();
  };
  render();
}

// ---------- サーバー接続 ----------

const socket = new MirrorSocket({
  hello: () => ({ type: 'hello', role: 'sender', code: room.code, token: room.token }),
  onState: (state) => {
    if (state === 'open') setStatus('warn', 'サーバー接続済み');
    else if (state === 'closed') setStatus('err', 'サーバーとの接続が切れました。再接続中…');
    updateStatus();
  },
  onMessage: (msg) => {
    switch (msg.type) {
      case 'room':
        room.code = msg.code;
        room.token = msg.token;
        sessionStorage.setItem('mirror-room', JSON.stringify(room));
        $('code').textContent = msg.code;
        showPublicUrl(msg.publicUrl);
        socket.sendJson({ type: 'mode', mode: settings.mode });
        updateStatus();
        break;
      case 'public-url':
        showPublicUrl(msg.publicUrl);
        break;
      case 'viewers':
        if (msg.relayCount > relayViewers) forceNext = true;
        viewers = msg.count;
        viewerIds = msg.ids || [];
        relayViewers = msg.relayCount ?? msg.count;
        lastAckId = frameId; // 視聴者が変わったら流量制御をリセット
        $('sViewers').textContent = viewers;
        if (!viewers) $('sLatency').textContent = '-';
        syncPeers();
        updateStatus();
        break;
      case 'signal':
        handleSignal(msg.from, msg.data);
        break;
      case 'ack':
        if (msg.id > lastAckId) lastAckId = msg.id;
        lastAckTime = performance.now();
        break;
      case 'viewer-stats':
        $('sLatency').textContent = msg.latency != null ? `${msg.latency} ms` : '-';
        break;
      case 'error':
        if (msg.error === 'sender_forbidden') {
          socket.stop();
          showError('送信ページはサーバーを起動したPCで http://localhost:' + location.port + '/send を開いてください。\n(別のPCから送信するには ALLOW_REMOTE_SENDER=1 で起動します)');
          setStatus('err', '送信できません');
        }
        break;
    }
  },
});

function showPublicUrl(url) {
  // YouTube のリダイレクト経由で開くと、Teslaのブラウザが全画面表示になる(オーナーの間で知られている方法・動作保証なし)
  const full = url ? 'https://www.youtube.com/redirect?q=' + url : '';
  $('fullUrl').textContent = full;
  $('fullUrlLabel').hidden = $('fullUrlRow').hidden = !full;
  if (url) {
    $('publicUrl').textContent = url;
    $('urlHint').textContent =
      'Teslaのブラウザでこのアドレスを開き、接続コードを入力してください。画面の半分にしか表示されない場合は「全画面で開く」のアドレスを試してください。';
  } else {
    $('publicUrl').textContent = '(公開URLなし)';
    $('urlHint').textContent = '外部から接続するには npm run tunnel で起動してください。同じWi-Fi内なら http://<このPCのIPアドレス>:' + (location.port || 80) + '/ でも開けます。';
  }
}

function setStatus(level, text) {
  $('dot').className = 'dot ' + level;
  $('statusText').textContent = text;
}

function updateStatus() {
  if (!socket.open) return;
  if (!stream) setStatus('warn', '待機中(画面共有を開始してください)');
  else if (!viewers) setStatus('warn', '共有中・Teslaからの接続待ち');
  else setStatus('ok', `共有中・${viewers}台が視聴中`);
}

function showError(text) {
  $('error').textContent = text;
}

// ---------- キャプチャ ----------

// 非表示タブでも間引かれないよう、Worker のタイマーでフレーム送出の拍を刻む
const ticker = new Worker(
  URL.createObjectURL(
    new Blob(['let t;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}'], {
      type: 'text/javascript',
    })
  )
);
ticker.onmessage = () => tick();

async function startCapture() {
  showError('');
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showError('このブラウザは画面キャプチャに対応していません。PCの Chrome / Edge で開いてください。\n(http://localhost か HTTPS で開く必要があります)');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') showError('画面キャプチャを開始できませんでした: ' + err.message);
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', stopCapture);
  try {
    track.contentHint = 'detail';
  } catch {}

  $('preview').srcObject = stream;
  $('preview').play().catch(() => {});
  frameSource = createFrameSource(track, $('preview'));
  forceNext = true;
  lastAckId = frameId;
  ticker.postMessage(1000 / settings.fps);
  syncPeers();
  $('toggle').textContent = '画面共有を停止';
  $('toggle').classList.add('stop');
  updateStatus();
}

function stopCapture() {
  ticker.postMessage(0);
  frameSource?.close();
  frameSource = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  syncPeers();
  $('preview').srcObject = null;
  $('toggle').textContent = '画面共有を開始';
  $('toggle').classList.remove('stop');
  $('sRes').textContent = '-';
  updateStatus();
}

// フレームの取り出し方。Chrome/Edge は MediaStreamTrackProcessor で最新フレームを保持し、
// 画面に変化がないときはエンコードを省く。それ以外のブラウザは video 要素から描く。
function createFrameSource(track, video) {
  if (typeof MediaStreamTrackProcessor === 'function') {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const src = {
      latest: null,
      seq: 0,
      usedSeq: -1,
      closed: false,
      get size() {
        return this.latest ? [this.latest.displayWidth, this.latest.displayHeight] : [0, 0];
      },
      get changed() {
        return this.seq !== this.usedSeq;
      },
      draw(c, w, h) {
        c.drawImage(this.latest, 0, 0, w, h);
        this.usedSeq = this.seq;
      },
      close() {
        this.closed = true;
        reader.cancel().catch(() => {});
        this.latest?.close();
        this.latest = null;
      },
    };
    (async () => {
      while (!src.closed) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        if (src.closed) {
          value.close();
          break;
        }
        src.latest?.close();
        src.latest = value;
        src.seq++;
      }
    })();
    return src;
  }
  return {
    get size() {
      return [video.videoWidth, video.videoHeight];
    },
    changed: true,
    draw(c, w, h) {
      c.drawImage(video, 0, 0, w, h);
    },
    close() {},
  };
}

function tick() {
  if (!frameSource || encoding || !socket.open || !relayViewers) return;
  const now = performance.now();
  const inFlight = frameId - lastAckId;
  if (inFlight >= maxInFlight()) {
    if (now - lastAckTime < ACK_TIMEOUT_MS) return;
    lastAckId = frameId; // ackが届かなかったフレームは失われたものとみなす
  }
  if (socket.bufferedAmount > MAX_BUFFERED) return;
  if (!forceNext && !frameSource.changed && now - lastSentTime < IDLE_RESEND_MS) return;
  encodeAndSend();
}

async function encodeAndSend() {
  const [sw, sh] = frameSource.size;
  if (!sw || !sh) return;
  const [maxW, maxH] = settings.resolution.split('x').map(Number);
  const scale = Math.min(1, maxW / sw, maxH / sh);
  const w = Math.max(2, Math.round((sw * scale) / 2) * 2);
  const h = Math.max(2, Math.round((sh * scale) / 2) * 2);

  encoding = true;
  try {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      $('sRes').textContent = `${w}×${h}`;
    }
    const captureTime = socket.clock.now();
    frameSource.draw(ctx, w, h);
    forceNext = false;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', settings.quality));
    if (!blob || !socket.open) return;
    const id = ++frameId;
    if (frameId - lastAckId === 1) lastAckTime = performance.now();
    socket.sendBinary(new Blob([buildFrameHeader(id, captureTime), blob]));
    lastSentTime = performance.now();
    fpsMeter.tick();
    byteMeter.tick(blob.size);
  } catch (err) {
    console.warn('フレームのエンコードに失敗しました', err);
  } finally {
    encoding = false;
  }
}

// ---------- WebRTC ----------

// 画質スライダー(0.3〜0.95)をビットレートに対応させる: 約1.4〜8Mbps
function rtcBitrate() {
  return Math.round((0.2 + settings.quality * 8.2) * 1e6);
}

function rtcEncoding() {
  const s = stream?.getVideoTracks()[0]?.getSettings() || {};
  const [maxW, maxH] = settings.resolution.split('x').map(Number);
  const scale = s.width && s.height ? Math.max(1, s.width / maxW, s.height / maxH) : 1;
  return { maxBitrate: rtcBitrate(), maxFramerate: settings.fps, scaleResolutionDownBy: scale };
}

// 視聴者の一覧と送信方式に合わせて、WebRTC接続を作る・閉じる
function syncPeers() {
  const want = settings.mode === 'webrtc' && stream ? new Set(viewerIds) : new Set();
  for (const [id, pc] of peers) {
    if (!want.has(id)) {
      pc.close();
      peers.delete(id);
    }
  }
  for (const id of want) if (!peers.has(id)) createPeer(id);
  updateRtcStatus();
}

async function createPeer(id) {
  if (typeof RTCPeerConnection !== 'function') return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.get(id)?.close();
  peers.set(id, pc);
  const track = stream.getVideoTracks()[0];
  const tx = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [rtcEncoding()] });
  preferH264(tx);
  pc.onicecandidate = (e) => {
    if (e.candidate) for (const c of expandCandidate(e.candidate)) signal(id, { candidate: c });
  };
  pc.onconnectionstatechange = () => {
    updateRtcStatus();
    if (pc.connectionState === 'connected') applyRtcEncodings();
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    signal(id, { sdp: pc.localDescription });
  } catch (err) {
    console.warn('WebRTCの開始に失敗しました', err);
  }
}

// Macなどでハードウェアエンコードが効きやすい H.264 を優先する(使えなければVP8などになる)
function preferH264(tx) {
  try {
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs;
    if (!codecs || !tx.setCodecPreferences) return;
    const h264 = codecs.filter((c) => c.mimeType === 'video/H264');
    tx.setCodecPreferences([...h264, ...codecs.filter((c) => c.mimeType !== 'video/H264')]);
  } catch {}
}

// Chromeはプライバシー保護のため自分のIPを "xxxx.local" に隠す。
// 同じテザリング内で確実につながるよう、サーバーが知っているこのPCのLAN内IPに置き換えた候補も送る
function expandCandidate(c) {
  const json = c.toJSON();
  const parts = json.candidate.split(' ');
  if (!parts[4] || !parts[4].endsWith('.local')) return [json];
  return [json, ...lanIps.map((ip) => ({ ...json, candidate: parts.map((p, i) => (i === 4 ? ip : p)).join(' ') }))];
}

function signal(to, data) {
  socket.sendJson({ type: 'signal', to, data });
}

async function handleSignal(from, data) {
  if (!data) return;
  if (data.request === 'offer') {
    // 視聴側がやり直しを求めてきた
    if (settings.mode === 'webrtc' && stream && viewerIds.includes(from)) createPeer(from);
    return;
  }
  const pc = peers.get(from);
  if (!pc) return;
  try {
    if (data.sdp) await pc.setRemoteDescription(data.sdp);
    else if (data.candidate) await pc.addIceCandidate(data.candidate);
  } catch (err) {
    console.warn('シグナリングの処理に失敗しました', err);
  }
}

// 共有中の設定変更を反映する
function applyRtcEncodings() {
  for (const pc of peers.values()) {
    const sender = pc.getSenders()[0];
    if (!sender) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    Object.assign(params.encodings[0], rtcEncoding());
    // 画面の文字を読みやすく保つため、回線が細いときは解像度ではなくfpsを落とす
    params.degradationPreference = 'maintain-resolution';
    sender.setParameters(params).catch(() => {});
  }
}

function updateRtcStatus() {
  if (settings.mode !== 'webrtc') {
    $('sRtc').textContent = '-';
    return;
  }
  const connected = [...peers.values()].filter((pc) => pc.connectionState === 'connected').length;
  $('sRtc').textContent = peers.size ? `${connected} / ${peers.size}台` : '-';
}

// WebRTCの送信状況(最初に接続した視聴者の分)
let lastRtcStats = null;
async function readRtcStats() {
  const pc = [...peers.values()].find((p) => p.connectionState === 'connected');
  if (!pc) {
    lastRtcStats = null;
    return null;
  }
  const report = await pc.getStats();
  let out = null;
  report.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
  });
  if (!out) return null;
  const prev = lastRtcStats;
  lastRtcStats = { bytes: out.bytesSent, t: out.timestamp };
  const codec = out.codecId && report.get(out.codecId)?.mimeType?.replace('video/', '');
  return {
    fps: Math.round(out.framesPerSecond || 0),
    bitrate: prev ? ((out.bytesSent - prev.bytes) * 8) / ((out.timestamp - prev.t) / 1000) : 0,
    res: out.frameWidth ? `${out.frameWidth}×${out.frameHeight}` : '-',
    codec: codec || '',
  };
}

// ---------- 画面表示 ----------

setInterval(async () => {
  if (settings.mode === 'webrtc' && peers.size && !relayViewers) {
    const st = await readRtcStats().catch(() => null);
    $('sFps').textContent = st ? st.fps : 0;
    $('sRate').textContent = st ? (st.bitrate / 1e6).toFixed(1) + ' Mbps' : '-';
    $('sSizeLabel').textContent = '方式';
    $('sSize').textContent = st?.codec || '-';
    $('sRes').textContent = st?.res || '-';
    updateRtcStatus();
    return;
  }
  const frames = fpsMeter.count;
  const bytes = byteMeter.sum;
  $('sSizeLabel').textContent = '1フレーム';
  $('sFps').textContent = frames;
  $('sRate').textContent = ((bytes * 8) / 1e6).toFixed(1) + ' Mbps';
  $('sSize').textContent = frames ? Math.round(bytes / frames / 1024) + ' KB' : '-';
}, 1000);

$('toggle').onclick = () => (stream ? stopCapture() : startCapture());

bindSettings();
socket.start();
fetch('/api/info')
  .then((r) => r.json())
  .then((info) => {
    if ($('publicUrl').textContent === '取得中…') showPublicUrl(info.publicUrl);
    lanIps = (info.lanUrls || []).map((u) => new URL(u).hostname);
    if (info.lanUrls?.length) {
      $('lanUrl').textContent = info.lanUrls.join('  /  ');
      $('lanUrlLabel').hidden = $('lanUrlRow').hidden = false;
    }
  })
  .catch(() => {});

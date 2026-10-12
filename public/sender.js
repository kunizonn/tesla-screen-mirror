'use strict';

// 送信ページ: getDisplayMedia でキャプチャした画面を JPEG にしてサーバーへ送る

const $ = (id) => document.getElementById(id);

const DEFAULTS = { resolution: '1280x720', fps: 20, quality: 0.6 };
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
let viewers = 0;
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
  const render = () => {
    $('resolutionOut').textContent = '';
    $('fpsOut').textContent = `${settings.fps} fps`;
    $('qualityOut').textContent = Math.round(settings.quality * 100) + '%';
  };
  $('resolution').onchange = (e) => {
    settings.resolution = e.target.value;
    saveSettings();
    forceNext = true;
  };
  $('fps').oninput = (e) => {
    settings.fps = Number(e.target.value);
    saveSettings();
    render();
    ticker.postMessage(stream ? 1000 / settings.fps : 0);
  };
  $('quality').oninput = (e) => {
    settings.quality = Number(e.target.value);
    saveSettings();
    render();
    forceNext = true;
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
        updateStatus();
        break;
      case 'public-url':
        showPublicUrl(msg.publicUrl);
        break;
      case 'viewers':
        if (msg.count > viewers) forceNext = true;
        viewers = msg.count;
        lastAckId = frameId; // 視聴者が変わったら流量制御をリセット
        $('sViewers').textContent = viewers;
        if (!viewers) $('sLatency').textContent = '-';
        updateStatus();
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
  if (url) {
    $('publicUrl').textContent = url;
    $('urlHint').textContent = 'Teslaのブラウザでこのアドレスを開き、接続コードを入力してください。';
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
  if (!frameSource || encoding || !socket.open || !viewers) return;
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

// ---------- 画面表示 ----------

setInterval(() => {
  const frames = fpsMeter.count;
  const bytes = byteMeter.sum;
  $('sFps').textContent = frames;
  $('sRate').textContent = ((bytes * 8) / 1e6).toFixed(1) + ' Mbps';
  $('sSize').textContent = frames ? Math.round(bytes / frames / 1024) + ' KB' : '-';
}, 500);

$('toggle').onclick = () => (stream ? stopCapture() : startCapture());

bindSettings();
socket.start();
fetch('/api/info')
  .then((r) => r.json())
  .then((info) => {
    if ($('publicUrl').textContent === '取得中…') showPublicUrl(info.publicUrl);
  })
  .catch(() => {});

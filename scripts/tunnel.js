'use strict';

// サーバーを起動し、cloudflared の quick tunnel で HTTPS の公開URLを発行して表示する。
// cloudflared が見つからなければ、公式のリリースからこのフォルダの .bin/ に自動でダウンロードする。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { start, setPublicUrl, PORT } = require('../server');

const URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/; // api.trycloudflare.com などは除外
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const BIN_DIR = path.join(__dirname, '..', '.bin');
const LOCAL_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

// OS・CPUに合った配布ファイル名
function releaseAsset() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch];
  if (process.platform === 'win32') return `cloudflared-windows-${arch === '386' ? '386' : 'amd64'}.exe`;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  if (process.platform === 'linux' && arch) return `cloudflared-linux-${arch}`;
  return null;
}

function works(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  let lastShown = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - lastShown > 500) {
      lastShown = Date.now();
      const mb = (got / 1e6).toFixed(1);
      process.stdout.write(`\r  ダウンロード中… ${mb} MB${total ? ` / ${(total / 1e6).toFixed(1)} MB` : ''}   `);
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  process.stdout.write(`\r  ダウンロード完了 (${(got / 1e6).toFixed(1)} MB)              \n`);
}

async function installCloudflared() {
  const asset = releaseAsset();
  if (!asset) throw new Error(`この環境 (${process.platform}/${process.arch}) 用の自動ダウンロードには対応していません`);
  console.log('cloudflared が見つからないので、自動でダウンロードします(初回のみ・数十MB)。');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = path.join(BIN_DIR, asset + '.download');
  try {
    await download(RELEASE_BASE + asset, tmp);
    if (asset.endsWith('.tgz')) {
      const r = spawnSync('tar', ['-xzf', tmp, '-C', BIN_DIR], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('展開に失敗しました');
      fs.unlinkSync(tmp);
    } else {
      fs.renameSync(tmp, LOCAL_BIN);
    }
    fs.chmodSync(LOCAL_BIN, 0o755);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (!works(LOCAL_BIN)) throw new Error('ダウンロードした cloudflared を起動できませんでした');
}

// 使う cloudflared を決める: 環境変数 → .bin/ → PATH → 自動ダウンロード
async function resolveCloudflared() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  if (fs.existsSync(LOCAL_BIN) && works(LOCAL_BIN)) return LOCAL_BIN;
  if (works('cloudflared')) return 'cloudflared';
  try {
    await installCloudflared();
    return LOCAL_BIN;
  } catch (err) {
    console.error(`\ncloudflared の自動ダウンロードに失敗しました: ${err.message}`);
    printInstallGuide();
    process.exit(1);
  }
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

function printInstallGuide() {
  const guides = {
    win32: [
      'Windows:',
      '  winget install --id Cloudflare.cloudflared',
      '  (インストール後、ターミナルを開き直してください)',
    ],
    darwin: ['macOS (Homebrew):', '  brew install cloudflared'],
    linux: [
      'Linux (Debian/Ubuntu, x86_64):',
      '  curl -LO https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb',
      '  sudo dpkg -i cloudflared-linux-amd64.deb',
    ],
  };
  const lines = guides[process.platform] || [];
  console.error(
    [
      '',
      '手動でインストールしてから、もう一度起動してください。',
      '',
      ...lines,
      '',
      'その他の環境: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
      'PATH にない場所に置いた場合は CLOUDFLARED=<実行ファイルのパス> で指定できます。',
      '',
    ].join('\n')
  );
}

function printBanner(url) {
  const lines = [
    '  Tesla のブラウザで開くURL:',
    `    ${url}`,
    '',
    '  このPCで開く送信ページ:',
    `    http://localhost:${PORT}/send`,
    '',
    '  接続コードは送信ページに表示されます。',
  ];
  const width = Math.max(...lines.map((l) => [...l].reduce((w, c) => w + (c.charCodeAt(0) > 0xff ? 2 : 1), 0))) + 2;
  const bar = '='.repeat(width);
  console.log(`\n${bar}\n${lines.join('\n')}\n${bar}\n`);
}

async function main() {
  const cloudflared = await resolveCloudflared();
  try {
    await start(PORT);
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `ポート ${PORT} は使用中です。すでに起動していないか確認してください。` : err);
    process.exit(1);
  }
  console.log(`サーバーを起動しました: http://localhost:${PORT}`);
  console.log('cloudflared で公開URLを発行しています…(10秒ほどかかります)');

  const cf = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let found = false;
  let recent = [];
  const onData = (chunk) => {
    const text = chunk.toString();
    recent = recent.concat(text.split('\n')).slice(-20);
    if (process.env.DEBUG_TUNNEL) process.stderr.write(text);
    const m = !found && text.match(URL_RE);
    if (m) {
      found = true;
      setPublicUrl(m[0]);
      printBanner(m[0]);
      openBrowser(`http://localhost:${PORT}/send`);
    }
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);

  cf.on('error', (err) => {
    if (err.code === 'ENOENT') printInstallGuide();
    else console.error('cloudflared を起動できませんでした:', err.message);
    process.exit(1);
  });
  cf.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`cloudflared が終了しました (code ${code})。`);
    if (!found) console.error(recent.filter(Boolean).join('\n'));
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = () => {
    shuttingDown = true;
    cf.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();

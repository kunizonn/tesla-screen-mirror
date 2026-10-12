'use strict';

// サーバーを起動し、cloudflared の quick tunnel で HTTPS の公開URLを発行して表示する

const { spawn } = require('child_process');
const { start, setPublicUrl, PORT } = require('../server');

const CLOUDFLARED = process.env.CLOUDFLARED || 'cloudflared';
const URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/; // api.trycloudflare.com などは除外

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
      'cloudflared が見つかりませんでした。インストールしてから再度 npm run tunnel を実行してください。',
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
  try {
    await start(PORT);
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `ポート ${PORT} は使用中です。PORT=3001 npm run tunnel などで変更してください。` : err);
    process.exit(1);
  }
  console.log(`サーバーを起動しました: http://localhost:${PORT}`);
  console.log('cloudflared で公開URLを発行しています…(10秒ほどかかります)');

  const cf = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], {
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

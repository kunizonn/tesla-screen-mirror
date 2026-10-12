#!/bin/bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Node.js が見つかりません。Homebrew でインストールします..."
    brew install node || exit 1
  else
    echo "Node.js が見つかりません。"
    echo "ブラウザで Node.js のページを開きます。「LTS」と書かれた方をダウンロードしてインストールしてから、"
    echo "このファイルをもう一度ダブルクリックしてください。"
    open "https://nodejs.org/ja"
    read -r -p "Enter キーで閉じます"
    exit 1
  fi
fi

if [ ! -d node_modules ]; then
  echo "初回の準備をしています..."
  npm install --no-audit --no-fund || { echo "準備に失敗しました。インターネット接続を確認してください。"; read -r; exit 1; }
fi

echo
echo "終了するときは、このウィンドウで Control + C を押すか、ウィンドウを閉じてください。"
echo
node scripts/tunnel.js

@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Tesla Screen Mirror

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。自動でインストールします...
  echo 途中で「このアプリがデバイスに変更を加えることを許可しますか?」と出たら「はい」を押してください。
  echo.
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo 自動インストールに失敗しました。ブラウザで Node.js のページを開きます。
    echo 「LTS」と書かれた方をダウンロードしてインストールしてから、このファイルをもう一度ダブルクリックしてください。
    start "" https://nodejs.org/ja
    pause
    exit /b 1
  )
  echo.
  echo Node.js のインストールが終わりました。
  echo このウィンドウを閉じて、start-windows.bat をもう一度ダブルクリックしてください。
  pause
  exit /b 0
)

if not exist node_modules (
  echo 初回の準備をしています...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo 準備に失敗しました。インターネット接続を確認してください。
    pause
    exit /b 1
  )
)

echo.
echo 終了するときは、このウィンドウを閉じてください。
echo.
node scripts\tunnel.js
pause

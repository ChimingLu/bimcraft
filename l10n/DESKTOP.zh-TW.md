# 把繁中版 BimCraft 裝成桌面程式（Windows／macOS）

BimCraft 的「瀏覽器版」是一個純靜態檔案的資料夾。用 Edge 或 Chrome 把它「安裝為應用程式」後，就會有自己的視窗、
工作列／Dock 圖示和開始功能表捷徑；按過一次「儲存供離線使用」之後，不用網路、也不用再開伺服器就能開啟。
檔案都在你的電腦上開啟，不會上傳。

> 官方的桌面安裝版是 [CadCraft Studio](https://github.com/getcadcraft/studio)。等繁中譯文被上游接受後，
> 官方 Studio 會直接內建繁中，到時改用 Studio 即可。

## 需要

Node.js 20.19 以上、PHP 8.1 以上、Git，以及 Microsoft Edge 或 Google Chrome。
macOS 沒有內建 PHP：`brew install php`（Windows：`winget install PHP.PHP.8.4`）。

## 1. 產生繁中的瀏覽器版

```sh
git clone https://github.com/ChimingLu/bimcraft.git
cd bimcraft
npm run fetch-vendor

# Windows PowerShell
$env:CC_LANG="zh-TW"; node devshell/edition.mjs
# macOS／Linux
CC_LANG=zh-TW node devshell/edition.mjs
```

完成後會得到 `dist/bimcraft-browser-edition-vdev/`（約 400 個檔案）。`CC_LANG=zh-TW` 讓頁面直接以繁中產生
（瀏覽器版是預先產生好的頁面，不加這個就會是英文）。

可以把這個資料夾搬到固定的位置，例如 `C:\BimCraft` 或 `~/BimCraft`。

## 2. 第一次開啟

瀏覽器版不能直接雙擊 `index.html` 開啟，要經過一個本機伺服器。先進入產生的資料夾，再啟動伺服器
（終端機視窗要保持開著）：

```sh
cd dist/bimcraft-browser-edition-vdev
php -S localhost:8000
```

然後用 Edge 或 Chrome 開啟 http://localhost:8000/ 。之後每次都用這個位址，設定和離線副本是跟著位址走的。

## 3. 儲存供離線使用

在 App 頂端列按「儲存供離線使用」，等它顯示「可離線使用」。

## 4. 安裝為應用程式

- **Edge**：右上角 `…` → 應用程式 → 將此網站安裝為應用程式。
- **Chrome**：右上角 `⋮` → 投放、儲存及分享 → 將網頁安裝為應用程式（較舊版本是
  更多工具 → 建立捷徑，並勾選「以視窗形式開啟」）。

安裝後可以把它釘選到工作列或 Dock。之後直接從桌面圖示開啟即可，第 2 步的伺服器不用再開。

## 更新

上游有新版、合併並補完翻譯後，重做第 1 步，把新資料夾放回同一個位置；用同樣的位址
（http://localhost:8000/）開一次，按頂端列的「可離線使用」→「重新儲存（取得最新版本）」更新離線副本。設定會保留。

## 注意

- 這是自己使用的做法。若要把打包好的程式**散布給別人**，依 `TRADEMARKS.md` 必須改用自己的產品名稱並拿掉 CadCraft 標誌。
- 想要像一般軟體那樣有 .exe／.dmg 安裝檔，可以改用官方 CadCraft Studio，或另外用 Electron 打包（需要自己維護）。

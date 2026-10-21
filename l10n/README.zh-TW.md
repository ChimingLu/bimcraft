# 繁體中文（台灣）在地化與上游同步

本分支把 BimCraft 的介面翻成繁體中文（台灣），而且**完全沿用上游內建的語言機制**，沒有改動任何程式碼。
因此日後上游（[getcadcraft/bimcraft](https://github.com/getcadcraft/bimcraft)）更新時，合併幾乎不會衝突，
只需要補翻新增或改動的字串。

## 檔案在哪裡

| 檔案 | 用途 |
| --- | --- |
| `app/lang/zh-TW.json` | 應用程式字串（與 `app/lang/en.json` 同鍵、同 `{填入值}`） |
| `devshell/site/assets/lang/shell/zh-TW.json` | 外框（登入頁、選單、錯誤頁等）字串 |
| `l10n/zh-TW.mjs` | 同步工具：檢查、產生待譯清單、套用譯文 |
| `l10n/zh-TW/baseline.json` | 每個譯文當初所翻譯的英文原文，用來偵測「英文已改、譯文過時」 |
| `.github/workflows/l10n-zh-TW.yml` | 每次 PR／推送時自動檢查譯檔有沒有壞掉 |

以上全是**新檔案**，上游從不碰它們，所以 `git merge` 不會在這些檔案上產生衝突。

語言會自動依瀏覽器的 `Accept-Language` 選用（`zh-TW`、`zh-Hant`、`zh` 都會對到繁中），也可以在語言選單選
「繁體中文（台灣）」，或在網址加 `?lang=zh-TW`。加 `?lang=en-XA` 可以找出沒有走語言檔、寫死在程式裡的文字。

## 第一次設定上游

```sh
git remote add upstream https://github.com/getcadcraft/bimcraft.git
git fetch upstream --tags
```

## 每次上游更新後的流程

```sh
git checkout main
git fetch upstream --tags
git merge upstream/main            # 或合併某個版本：git merge bimcraft-v0.7.0

node l10n/zh-TW.mjs check          # 看有哪些要處理
node l10n/zh-TW.mjs todo           # 產生 l10n/zh-TW/todo.json
# 編輯 todo.json：把每一筆的 "zh" 填好（可以交給 Claude 處理）
node l10n/zh-TW.mjs apply          # 寫回語言檔、更新 baseline、刪除 todo.json
node l10n/zh-TW.mjs check --strict # 應顯示 Up to date.
npm test
git add -A && git commit -m "zh-TW: 跟上上游 <版本>"
```

`check` 會列出：

- **new in English, not translated**：上游新增的字串。
- **English changed since translated**：英文原文改過了，譯文可能過時（`todo.json` 會附上舊英文 `was` 方便比對）。
- **removed upstream**：上游刪掉的鍵，`apply` 時會自動移除。
- **BROKEN**：譯文用了英文沒有的 `{填入值}`，或複數格式錯誤。這會讓 CI 失敗。

沒翻到的字串不會讓畫面壞掉，程式會退回顯示英文（順序：`zh-TW` → `zh` → `en`），所以可以先合併、再慢慢補譯。

## 翻譯規則

- `{n}`、`{name}` 這類填入值要原樣保留；文字裡真的要顯示大括號時寫 `{{`、`}}`。
- 英文是複數物件（`{"one": …, "other": …}`）時，中文只需要 `"other"`；若英文有 `"=0"` 這種精確數量的寫法，也一併翻譯。
- 英文是空字串的鍵，譯文也保持空字串。
- 用語以台灣慣用為準，例如：元件、選取、樓層、格線、族群、圖紙、視圖、明細表、剖面、圖層、圖塊、元件庫、
  碰撞、彩現、漫遊、復原／重做、載重組合、剛接、鉸接。產品名稱、檔案格式（IFC、DWG…）與 MEP 縮寫保留英文。
- 鍵在 `en.json` 的 `@context` 有說明時，`todo.json` 會帶上 `context`，翻譯前請先看。

## 尚未翻譯：說明文件

說明主題（`app/help/*.md`，約 97 篇）目前還是英文。要翻譯時，每篇另存為 `app/help/zh-TW/<主題>.md`，並依
`CONTRIBUTING.md` 在檔頭寫 `from: <8 位十六進位>`，標明所翻譯的英文版本（help 建置時會印出這個值）。
同樣是新檔案，不會和上游衝突；英文改版時，help 建置會依 `from:` 指出哪些譯文過時。

## 散布前注意（商標）

依 `TRADEMARKS.md`：Apache-2.0 授權涵蓋程式碼，不涵蓋名稱。若要**自行散布修改過的版本**，必須換成自己的產品名稱
並拿掉 CadCraft 標誌（名稱也會出現在語言檔裡）。若只是自用，或把譯文以 PR 回饋給上游，就不需要改名。

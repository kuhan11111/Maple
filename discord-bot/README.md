# Artale 小幫手(Discord 機器人)

**完全免費**的 Artale Discord 機器人:查怪物 / 道具掉落、放音樂、玩小遊戲。不需要任何付費服務,跑在你自己的電腦上就行。(AI 問答是「選用」的付費功能,不開也完整可用。)

| 功能 | 指令 | 說明 |
|---|---|---|
| 🔎 查掉落 | `/drop 名稱` | 輸入怪物 → 掉什麼、出沒哪裡;輸入道具 → 哪些怪掉、機率。輸入時會跳出選項,打錯一個字也找得到。也可以直接 **@機器人 名稱** |
| 🗺️ 查地圖 | `/map 地圖` | 這張地圖有哪些怪物(依等級排序) |
| 📚 找攻略 | `/guide 主題` | 給你各攻略網站(巴哈、Dcard、PTT…)的站內搜尋連結 |
| 🎵 放音樂 | `/music play 歌名` | 播放音樂資料夾裡的歌;另有 `radio`(網路電台)、`queue`、`skip`、`pause`、`resume`、`stop`、`loop`、`volume`、`list` |
| 🎲 小遊戲 | `/roll` `/pick` `/scroll` | 擲骰、幫你做決定、**衝捲模擬**(選成功率和格數) |
| | `/rps` `/guess` `/quiz` | **猜拳**(按鈕)、**猜數字**(全頻道一起猜)、**猜怪物**(看掉落物猜是哪隻,題目來自你的資料庫) |
| | `/rank` | 排行榜(猜拳 / 猜數字 / 猜怪物的得分) |
| ❓ | `/help` | 看有哪些功能 |
| 🤖 選用 | `/ask`、AI 版 `/guide` | 要 Anthropic API 金鑰(付費),見最後一節 |

> **這個機器人本身沒有內建任何 Artale 的資料。** 查掉落需要你先匯入資料庫(見「匯入資料」);沒匯入之前 `/drop` 會告訴你資料庫是空的。小遊戲、音樂、搜尋連結不需要資料。

## 開始用

### 1. 準備

1. **Node.js 20 以上**。
2. **Discord 機器人**:到 [Discord Developer Portal](https://discord.com/developers/applications) → New Application →
   - **Bot** → Reset Token,複製 token(這是密碼,別貼到任何地方)。**不需要**開任何 Privileged Intent。
   - **OAuth2 → URL Generator**:Scopes 勾 `bot` 和 `applications.commands`;Bot Permissions 勾 `View Channels`、`Send Messages`、`Read Message History`,要放音樂再加 `Connect`、`Speak`。用產生的連結邀請機器人進你的伺服器。
   - **General Information** 複製 Application ID。
3. **ffmpeg**(放音樂用):`npm install` 會自動附帶一份(`ffmpeg-static`)。如果那份沒裝成功,請自己裝 ffmpeg 並確認終端機打 `ffmpeg -version` 有東西。

### 2. 安裝與啟動

```bash
cd discord-bot
npm install
cp .env.example .env      # 填入 DISCORD_TOKEN 和 DISCORD_APP_ID(其他都可以不填)
npm run register          # 註冊斜線指令(只要做一次;改了設定或更新程式後再做一次)
npm start
```

測試時在 `.env` 填 `DISCORD_GUILD_ID`(你的伺服器 ID),指令會立刻出現;沒填則是全域註冊,最久約一小時生效。機器人要一直開著才會回話(家裡常開的電腦、樹莓派或 VPS 都可以)。

## 匯入資料(查掉落用)

機器人讀 `data/db.json`,用 `npm run import` 從表格產生它。資料來源由你決定:自己整理的試算表,或是別人公開、**允許你使用**的資料。抓別人網站的資料前,請先確認它的使用條款,或問一下維護者。

準備三張表(都可以只做其中幾張,`drops` 這一張就夠開始):

| 表 | 欄位 |
|---|---|
| `monsters` | 怪物、等級、HP、經驗、出沒地圖(多個用 `;` 隔開)、別名、備註 |
| `items` | 道具、類型、別名、備註 |
| `drops` | 怪物、道具、機率(`0.5%`、`1/200` 或 `很稀有` 這類文字都可以)、備註 |

欄位名稱中英文都行(`name`/`level`/`hp`/`exp`/`maps`/`monster`/`item`/`rate`…,見 `src/lookup/import.js`),多餘的欄位會被忽略。`data/templates/` 有三個範例檔(裡面只是格式示範,請刪掉範例列)。從 Google 試算表用「下載 → CSV(或 TSV)」匯出,放進 `data/raw/`:

```bash
npm run import -- --dir data/raw --source "資料來源說明"
# 或指定檔案:--monsters m.csv --items i.csv --drops d.csv
```

匯入完成會顯示筆數和警告(例如某列缺名稱)。**機器人不用重開**,發現 `db.json` 改了會自動重讀。`drops` 提到、但 `monsters` / `items` 裡沒有的名字,會自動建立一筆空白資料。

## 放音樂

- 把歌放進 `music/` 資料夾(可以有子資料夾),`/music play` 輸入時會自動出現選項。**使用者只能播資料夾裡的歌和你設定的電台**,不能自己貼檔案或網址。
- 電台:在 `.env` 設 `RADIO_STREAMS=名稱=串流網址,名稱=串流網址`。我沒有附任何電台網址(沒辦法確認哪些能用、能不能這樣用),請自己找可以公開播放的串流。
- 要先進語音頻道再下指令。機器人閒置 5 分鐘會自己離開。
- **不支援 YouTube / Spotify 連結**,這是刻意的:這類做法違反它們的服務條款,Discord 上很多知名音樂機器人就是因此被關掉,而且這類套件常常壞掉。
- **版權**:請只放你有權播放的音樂(自己的、無版權的、或授權的)。楓之谷原聲帶是 Nexon 的著作,公開伺服器播放請自行評估風險。
- 音樂用 `opusscript`(純 JavaScript,免編譯)。同時多個伺服器放歌想更省資源,可以自行安裝更快的 `@discordjs/opus`。

## 小遊戲

- `/scroll`:選 10 / 30 / 60 / 70 / 100% 卷軸、1~15 格,一次衝完,看成功幾張。
- `/rps`:按鈕猜拳,只有發起的人能按,贏了 +1 分。
- `/guess`:機器人想一個 1~100 的數字,全頻道的人用 `/guess 數字` 一起猜,會提示範圍;越快猜中分越高(7 次內 3 分)。30 分鐘沒人猜會作廢。
- `/quiz`:顯示一隻怪物的 3 個掉落物,按按鈕選是哪隻怪,60 秒內第一個答對的人 +1 分,每人限答一次。需要資料庫裡至少 4 隻怪物、其中有掉落資料。
- `/rank`:各伺服器自己的排行榜,存在 `data/scores.json`。

## 部署(Docker,選用)

```bash
docker build -t artale-bot .
docker run -d --restart unless-stopped --env-file .env -v "$PWD/data:/app/data" -v "$PWD/music:/app/music" artale-bot
```

## 安全性

- 機器人的回覆**不會 @ 任何人**:`@everyone`、`@here`、使用者 / 身分組提及都會被破壞掉,client 也設了不解析提及;歌名裡的 Markdown 也會被跳脫。
- 沒有任何指令能讓使用者存取機器人電腦上的檔案或任意網址(音樂只能選你放進去的檔案和你設定的電台)。
- 錯誤訊息是白話文,不會洩漏 token 或內部細節。token 只放 `.env`(已被 `.gitignore` 排除)。

## 選用:AI 問答(要付費)

在 `.env` 填 `ANTHROPIC_API_KEY`(到 [console.anthropic.com](https://console.anthropic.com) 申請,並在 Console 啟用 web search)再重新 `npm run register`,就會多出 `/ask`,而且 `/guide` 和 @機器人 會改成由 AI 查網站後回答、附來源連結。**每次提問都會花錢**(Claude 的 tokens 加上網頁搜尋費),預設有每人 10 分鐘 5 次、一天 40 次的限額和每次的搜尋上限(見 `.env.example`)。`npm run check -- "問題"` 可以不經 Discord 先試試並看用量。這一塊我只用模擬的回應測過,沒有用真的金鑰實測。

## 已知限制

- **沒有用真的 Discord 連線測過。** 這個環境連不到 discord.com,所以:登入、斜線指令註冊、按鈕與自動完成的實際行為、**加入語音頻道並出聲**都沒有實測。我測了的是:所有指令的邏輯(用模擬的 Discord 物件)、音訊管線(真的 ffmpeg 把音檔和 HTTP 串流轉成 Opus 封包,含中途停止不會崩潰)、資料匯入與搜尋、設定與啟動流程(用假 token 啟動到登入那步)。第一次跑請先在自己的測試伺服器試一輪。
- Docker 映像沒有實際建置測試過。
- 資料庫的內容完全取決於你匯入什麼;社群整理的資料本身可能有錯漏。
- `/quiz` 的題目只有「掉落物 → 怪物」一種。

## 開發

```bash
npm test      # 78 項測試(不需要 Discord 或網路;音訊管線測試會用到 ffmpeg,找不到會跳過)
```

結構:`src/lookup/`(CSV 解析、匯入、搜尋、資料卡)、`src/games/`(規則 + 指令)、`src/music/`(音樂庫、佇列、語音)、`src/routes.js`(每個指令做什麼)、`src/wiring.js`(Discord 事件)、`src/bot.js`(入口)。AI 選用功能在 `src/agent.js`、`src/handlers.js`、`src/prompt.js`。

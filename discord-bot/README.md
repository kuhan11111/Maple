# Artale 小幫手(Discord 機器人)

在 Discord 裡問楓之谷 **Artale** 的問題(掉落物、怪物出沒、攻略、任務、練功…),機器人會去你指定的 Artale 網站查資料,用繁體中文回答並附上來源連結。

## 怎麼運作

機器人用 Claude 當大腦,搭配 Anthropic API 內建的**網頁搜尋**和**網頁讀取**工具,而且**只准查你設定的那幾個網站**。搜尋和讀取都在 Anthropic 的伺服器上完成,所以機器人本身不用寫爬蟲,網站改版也不會壞掉。

```
Discord 使用者 ──/ask /drop /guide 或 @機器人──► 機器人(限流、檢查)
                                                    │
                                    Claude + web_search / web_fetch(限定網站)
                                                    │
                                   答案 + 來源連結 ◄─┘
```

| 指令 | 用途 |
|---|---|
| `/ask 問題` | 問任何 Artale 問題 |
| `/drop 名稱` | 查怪物或道具的掉落 / 出沒(優先查資料庫站) |
| `/guide 主題` | 找某個主題的攻略 |
| `/sources` | 看機器人會查哪些網站 |
| `@機器人 問題` | 在頻道直接 @ 它也行,連續追問(例如「那它在哪裡掉?」)會記得前 3 輪、10 分鐘內有效 |

預設查詢的網站(可改):
- `artalemaplestory.com` — 社群維護的 Artale 資料庫(怪物數值、出沒地點、雙向掉落查詢,用台版譯名)。資料是玩家手動整理的,可能有錯漏。
- `forum.gamer.com.tw`(巴哈姆特)、`dcard.tw`、`ptt.cc`、`uptogo.com.tw` — 攻略與心得文章。

## 開始用

### 1. 準備三樣東西

1. **Discord 機器人**:到 [Discord Developer Portal](https://discord.com/developers/applications) → New Application →
   - 左邊 **Bot** → Reset Token,複製 token(這是密碼,別貼到任何地方)。
   - **不需要**開任何 Privileged Intent。
   - 左邊 **OAuth2 → URL Generator**:Scopes 勾 `bot` 和 `applications.commands`;Bot Permissions 勾 `View Channels`、`Send Messages`、`Read Message History`。用產生的連結把機器人邀請進你的伺服器。
   - **General Information** 複製 Application ID。
2. **Anthropic API 金鑰**:[console.anthropic.com](https://console.anthropic.com) 建立 API Key,並確認組織已**啟用 web search**(Console 設定,需要管理員權限)。
3. **Node.js 20 以上**。

### 2. 設定與啟動

```bash
cd discord-bot
npm install
cp .env.example .env      # 填入 DISCORD_TOKEN、DISCORD_APP_ID、ANTHROPIC_API_KEY
npm run check             # 不經過 Discord,先確認金鑰、網頁搜尋、查得到什麼
npm run register          # 註冊斜線指令(只需要做一次,改了 src/commands.js 才要再做)
npm start
```

測試時在 `.env` 填 `DISCORD_GUILD_ID`(你的伺服器 ID),指令會立刻出現;沒填則是全域註冊,最久約一小時生效。

`npm run check -- "肥肥頭掉什麼?"` 會印出答案、來源和用量。**如果「搜尋 0 次」,代表網頁搜尋沒開**,答案只是模型的記憶,請先去 Console 開啟。

### 3. 放在哪裡跑

機器人要一直開著才會回話。可以放在家裡常開的電腦、便宜的 VPS,或用 Docker:

```bash
docker build -t artale-bot .
docker run -d --restart unless-stopped --env-file .env artale-bot
```

## 費用與保護

每次查詢 = 一次(或幾次)Claude 呼叫 + 網頁搜尋 / 讀取,搜尋另外計費(以 Anthropic 價目表為準)。預設的保護:

- 每位使用者 10 分鐘 5 次、一天 40 次(`RATE_LIMIT_PER_10_MIN`、`RATE_LIMIT_PER_DAY`)。
- 每次最多搜尋 3 次、讀取 3 個網頁、回答 1500 tokens(`MAX_SEARCHES`、`MAX_FETCHES`、`MAX_OUTPUT_TOKENS`)。
- 同時最多處理 3 個查詢,其餘排隊(`MAX_CONCURRENT`)。
- 可用 `ALLOWED_CHANNEL_IDS` 限定只能在某些頻道用。
- 想再省:`ANTHROPIC_MODEL=claude-haiku-5-5`。

日誌(標準輸出,JSON)只記用量、耗時、錯誤,**不記問題內容**。

## 安全性

- 機器人的回覆**不會 @ 任何人**:`@everyone`、`@here`、使用者 / 身分組提及都會被破壞掉,client 也設了不解析提及。
- 網頁內容被當成資料,提示詞明確要求忽略網頁裡的指令;而且機器人**沒有任何能改東西的工具**(只有限定網站的搜尋與讀取),最壞情況只是答錯。
- 錯誤訊息對使用者是白話文,不會洩漏金鑰或內部細節。
- token 和 API 金鑰只放 `.env`(已被 `.gitignore` 排除)。

## 已知限制

- **網頁讀取只看得到文字,不執行 JavaScript。** 如果資料庫站是靠前端動態載入資料,機器人讀到的頁面可能是空的,只能靠搜尋結果的摘要回答。遇到這種情況,更好的做法是直接接資料庫的原始資料(例如它說明的 Google 試算表,或網站自己的 JSON 介面),做成機器人的專用查詢工具,答案會更準、更便宜。
- **我在開發這個機器人時,環境連不到 artalemaplestory.com 等網站,所以沒有用真實網站驗證過**「查得到什麼、查得準不準」。核心邏輯(查詢流程、來源整理、限流、分段、接線)用模擬的 Claude 回應和 Discord 物件測過;真實的搜尋結果請用 `npm run check` 在你的機器上確認。
- 社群資料庫的掉落資料本身可能有錯,機器人會在適當時提醒,重要的決定請再核對。
- 這個機器人只查你設定的網站;沒收錄在那些網站的資料它會直說查不到,不會亂編。

## 開發

```bash
npm test      # 32 項測試:設定、格式、限流、記憶、查詢流程(含 pause_turn 續跑)、錯誤處理、Discord 接線
```

結構:`src/agent.js`(呼叫 Claude、整理答案與來源)、`src/handlers.js`(檢查 → 查詢 → 排版)、`src/wiring.js`(Discord 事件)、`src/prompt.js`(系統提示與問題模板)、`src/limits.js`、`src/memory.js`、`src/format.js`、`src/commands.js`、`src/config.js`。

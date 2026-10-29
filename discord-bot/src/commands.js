// Slash command definitions (plain JSON; option type 3 = string, 4 = integer, 6 = user, 7 = channel,
// 1 = subcommand). Names are Chinese on purpose: Discord allows them, and /掉落物 藍寶 is what people
// will type. AI commands only exist when an API key is configured.

const str = (name, description, extra = {}) => ({ type: 3, name, description, required: true, ...extra });
const int = (name, description, extra = {}) => ({ type: 4, name, description, required: true, ...extra });
const opt = { required: false };
const sub = (name, description, options) => ({ type: 1, name, description, ...(options ? { options } : {}) });
const MANAGE_GUILD = '32'; // default_member_permissions bit; the handlers check again

const INFO = [
  { name: '說明', description: '看機器人有哪些功能' },
  { name: '掉落物', description: '查怪物掉什麼,或道具是哪些怪物掉的', options: [str('名稱', '怪物或道具名稱(輸入時會出現選項)', { autocomplete: true, max_length: 100 })] },
  { name: '地圖', description: '查某張地圖有哪些怪物', options: [str('名稱', '地圖名稱', { autocomplete: true, max_length: 100 })] },
  { name: '攻略', description: '找攻略(給各攻略網站的搜尋連結;有設定 AI 時會直接整理)', options: [str('主題', '主題,例如:組隊任務、轉職、賺楓幣', { max_length: 100 })] },
  {
    name: '更新情報',
    description: '看 Artale 最新的更新與情報',
    options: [int('數量', '要看幾則(1~15,預設 8)', { ...opt, min_value: 1, max_value: 15 }), str('來源', '只看某個來源', { ...opt, autocomplete: true, max_length: 30 })],
  },
  {
    name: '回報',
    description: '回報掉落資料(新地圖、資料庫還沒有的掉落),會標示為玩家回報',
    options: [
      str('怪物', '怪物名稱', { autocomplete: true, max_length: 30 }),
      str('道具', '掉落的道具名稱', { autocomplete: true, max_length: 30 }),
      str('機率', '例如 0.5%、1/200、很稀有(不知道可不填)', { ...opt, max_length: 20 }),
      str('地圖', '在哪張地圖', { ...opt, autocomplete: true, max_length: 30 }),
      str('來源', '消息來源(連結或說明)', { ...opt, max_length: 200 }),
    ],
  },
  { name: '回報刪除', description: '刪除一筆回報(自己的,管理員可刪全部)', options: [int('編號', '回報編號', { min_value: 1 })] },
  {
    name: '情報來源',
    description: '(管理員)設定 /更新情報 的資料來源',
    default_member_permissions: MANAGE_GUILD,
    dm_permission: false,
    options: [
      sub('列表', '看目前的來源'),
      sub('新增', '新增或更新一個來源(RSS 或論壇看板網址)', [
        str('名稱', '給它取個名字,例如:巴哈', { max_length: 30 }),
        str('網址', 'RSS 或看板的網址', { max_length: 500 }),
        str('類型', '預設自動判斷', { ...opt, choices: [{ name: '自動判斷', value: 'auto' }, { name: 'RSS / Atom', value: 'rss' }, { name: '論壇看板網頁', value: 'html' }] }),
        str('關鍵字', '只收標題含這些字的(用逗號隔開,例如 Artale,阿泰爾)', { ...opt, max_length: 100 }),
        str('連結篩選', '進階:網頁類型只收符合這個正規表示式的連結', { ...opt, max_length: 200 }),
      ]),
      sub('移除', '移除一個來源', [str('名稱', '來源名稱', { autocomplete: true, max_length: 30 })]),
      sub('測試', '試抓一個來源,看抓到什麼', [str('名稱', '來源名稱', { autocomplete: true, max_length: 30 })]),
      sub('立即更新', '現在就抓一次所有來源'),
      sub('頻道加入', '把某個頻道的貼文當成情報(例如追蹤其他社群公告的頻道)', [{ type: 7, name: '頻道', description: '文字或公告頻道', required: true, channel_types: [0, 5] }]),
      sub('頻道移除', '不再把某個頻道當成情報', [{ type: 7, name: '頻道', description: '頻道', required: true, channel_types: [0, 5] }]),
    ],
  },
];

const RPG = [
  { name: '打怪', description: '去打怪賺經驗、楓幣和道具', options: [str('地圖', '指定地圖(不填就依你的等級遇到怪物)', { ...opt, autocomplete: true, max_length: 100 })] },
  { name: '角色', description: '看你(或別人)的角色', options: [{ type: 6, name: '玩家', description: '要看誰(不填 = 你自己)', required: false }] },
  { name: '背包', description: '看你的背包' },
  { name: '賣出', description: '賣掉背包裡的道具', options: [str('道具', '道具名稱,或輸入「全部」', { autocomplete: true, max_length: 100 }), int('數量', '賣幾個(不填 = 全部賣)', { ...opt, min_value: 1 })] },
  { name: '簽到', description: '每日簽到領楓幣(連續簽到更多)' },
  {
    name: '賭博',
    description: '用虛擬楓幣賭一把(沒有任何現實價值)',
    options: [
      sub('骰子', '兩顆骰子猜大小(7 點莊家通吃)', [int('金額', '押多少楓幣', { min_value: 10, max_value: 50000 }), str('押注', '大(8~12)或小(2~6)', { choices: [{ name: '大', value: '大' }, { name: '小', value: '小' }] })]),
      sub('拉霸', '拉霸機', [int('金額', '押多少楓幣', { min_value: 10, max_value: 50000 })]),
    ],
  },
  { name: '排行榜', description: '看這個伺服器的等級排行榜' },
];

const GAMES = [
  { name: '擲骰', description: '擲骰子', options: [str('骰子', '例如 2d6+3、d20(預設 1d100)', { ...opt, max_length: 20 })] },
  { name: '抽籤', description: '幫你做決定:從選項裡抽一個', options: [str('選項', '用逗號隔開,例如:吃麵, 吃飯, 吃漢堡', { max_length: 400 })] },
  { name: '衝捲', description: '衝捲模擬:看看手氣', options: [int('成功率', '卷軸成功率', { ...opt, choices: [10, 30, 60, 70, 100].map((n) => ({ name: `${n}%`, value: n })) }), int('格數', '衝幾格(1~15,預設 7)', { ...opt, min_value: 1, max_value: 15 })] },
  { name: '猜拳', description: '跟我猜拳,贏了有楓幣' },
  { name: '猜數字', description: '猜數字(1~100),全頻道一起猜', options: [int('數字', '你猜的數字;不填 = 開新局或看進度', { ...opt, min_value: 1, max_value: 100 })] },
  { name: '猜怪物', description: '看掉落物猜是哪隻怪(需要先匯入資料庫)' },
];

const AI = [
  { name: '問答', description: '用 AI 回答 Artale 問題(會查網站)', options: [str('問題', '你的問題,例如:弓箭手二轉哪裡練?', { max_length: 300 })] },
  { name: 'ai來源', description: '看 AI 會去哪些網站查資料' },
];

export function buildCommands({ ai = false } = {}) {
  return [...INFO, ...RPG, ...GAMES, ...(ai ? AI : [])];
}

/** Which option holds the question for each AI-capable command, and the kind it asks as. */
export const AI_OPTION = { 問答: { option: '問題', kind: 'ask' }, 攻略: { option: '主題', kind: 'guide' } };

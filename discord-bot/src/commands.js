// Slash command definitions (plain JSON; option type 3 = string, 4 = integer, 1 = subcommand).
// What gets registered depends on the configuration: AI commands only with an API key, music only
// when enabled.

const str = (name, description, extra = {}) => ({ type: 3, name, description, required: true, ...extra });

const LOOKUP = [
  { name: 'drop', description: '查怪物的掉落物,或道具是哪些怪物掉的', options: [str('name', '怪物或道具名稱(輸入時會出現選項)', { autocomplete: true, max_length: 100 })] },
  { name: 'map', description: '查某張地圖有哪些怪物', options: [str('name', '地圖名稱', { autocomplete: true, max_length: 100 })] },
];

const GAMES = [
  { name: 'roll', description: '擲骰子', options: [str('dice', '例如 2d6+3、d20(預設 1d100)', { required: false, max_length: 20 })] },
  { name: 'pick', description: '幫你做決定:從選項裡抽一個', options: [str('options', '用逗號隔開,例如:吃麵, 吃飯, 吃漢堡', { max_length: 400 })] },
  {
    name: 'scroll',
    description: '衝捲模擬:看看手氣',
    options: [
      { type: 4, name: 'rate', description: '卷軸成功率', required: false, choices: [10, 30, 60, 70, 100].map((n) => ({ name: `${n}%`, value: n })) },
      { type: 4, name: 'slots', description: '衝幾格(1~15,預設 7)', required: false, min_value: 1, max_value: 15 },
    ],
  },
  { name: 'rps', description: '跟我猜拳' },
  { name: 'guess', description: '猜數字(1~100),全頻道一起猜', options: [{ type: 4, name: 'number', description: '你猜的數字;不填 = 開新局或看進度', required: false, min_value: 1, max_value: 100 }] },
  { name: 'quiz', description: '猜怪物:看掉落物猜是哪隻怪(需要先匯入資料庫)' },
  { name: 'rank', description: '看遊戲排行榜' },
];

const sub = (name, description, options) => ({ type: 1, name, description, ...(options ? { options } : {}) });
const MUSIC = {
  name: 'music',
  description: '放音樂',
  dm_permission: false,
  options: [
    sub('play', '播放音樂庫裡的歌', [str('song', '歌名(輸入時會出現選項)', { autocomplete: true, max_length: 100 })]),
    sub('radio', '播放電台', [str('station', '電台名稱', { autocomplete: true, max_length: 100 })]),
    sub('list', '看音樂庫有哪些歌', [{ type: 4, name: 'page', description: '第幾頁', required: false, min_value: 1 }]),
    sub('queue', '看播放佇列'),
    sub('now', '現在播什麼'),
    sub('skip', '跳過這首'),
    sub('pause', '暫停'),
    sub('resume', '繼續'),
    sub('stop', '停止並離開頻道'),
    sub('loop', '循環模式', [str('mode', '模式', { choices: [{ name: '關閉', value: 'off' }, { name: '單曲循環', value: 'one' }, { name: '整個佇列循環', value: 'all' }] })]),
    sub('volume', '調音量', [{ type: 4, name: 'level', description: '1~100', required: true, min_value: 1, max_value: 100 }]),
  ],
};

const AI = [
  { name: 'ask', description: '用 AI 回答 Artale 問題(攻略、任務、練功…,會查網站)', options: [str('question', '你的問題,例如:弓箭手二轉哪裡練?', { max_length: 300 })] },
  { name: 'sources', description: '看 AI 會去哪些網站查資料' },
];

const GUIDE = { name: 'guide', description: '找攻略(給各攻略網站的搜尋連結;有設定 AI 時會直接整理)', options: [str('topic', '主題,例如:組隊任務、轉職、賺楓幣', { max_length: 100 })] };

const HELP = { name: 'help', description: '看機器人有哪些功能' };

export function buildCommands({ ai = false, musicEnabled = true } = {}) {
  return [HELP, ...LOOKUP, GUIDE, ...GAMES, ...(musicEnabled ? [MUSIC] : []), ...(ai ? AI : [])];
}

/** Which option holds the question for each AI command. */
export const TEXT_OPTION = { ask: 'question', guide: 'topic' };

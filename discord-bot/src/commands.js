// Slash command definitions (plain JSON, option type 3 = string).

const question = (description) => [{ type: 3, name: 'question', description, required: true, max_length: 300 }];

export const COMMANDS = [
  { name: 'ask', description: '問 Artale 的任何問題(攻略、任務、練功、職業…)', options: question('你的問題,例如:弓箭手二轉哪裡練?') },
  { name: 'drop', description: '查怪物或道具的掉落 / 出沒資料', options: [{ type: 3, name: 'name', description: '怪物或道具名稱,例如:肥肥頭、楓葉', required: true, max_length: 100 }] },
  { name: 'guide', description: '找某個主題的攻略', options: [{ type: 3, name: 'topic', description: '主題,例如:組隊任務、轉職、賺楓幣', required: true, max_length: 100 }] },
  { name: 'sources', description: '看機器人會去哪些網站查資料' },
];

/** Which option holds the text for each command. */
export const TEXT_OPTION = { ask: 'question', drop: 'name', guide: 'topic' };

'use strict';
/* =========================================================================
 * nlu-human-feel-seeds.js — 活人感语料种子建档（2026-08-09）
 * 输入: data/nlu/corpus-clean.jsonl（270 条去噪去重语料）
 * 输出: data/nlu/human-feel-seeds.jsonl（34 条人工优选的活人感种子）
 * 结构: {text, role, ch, day, dupCount, band, context, note}
 *   band: ready（直接可用）/ contextual（语境绑定）/ meta（待人工分类）
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const rows = fs.readFileSync(path.join(root, 'data/nlu/corpus-clean.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// 人工优选的 34 条（band + 语境 + 备注）
const PICK = [
  // --- 直接可用（8）---
  { text: '白天好', band: 'ready', context: '白天任意', note: '高频通用问候' },
  { text: '哈哈哈', band: 'ready', context: '任意', note: '万能回应（配情绪语境）' },
  { text: '哈哈哈哈哈', band: 'ready', context: '任意', note: '万能回应' },
  { text: '哈哈，大家很会耍嘛', band: 'ready', context: '讨论后', note: '带评价的活跃感' },
  { text: '哎呦我去', band: 'ready', context: '惊讶/局势变化', note: '情绪反应' },
  { text: '厉害了', band: 'ready', context: '夸赞', note: '情绪反应' },
  { text: '这么强', band: 'ready', context: '夸赞', note: '情绪反应' },
  { text: '那不寄了吗', band: 'ready', context: '局势不利', note: '狼人杀黑话自嘲' },
  // --- 语境绑定（6）---
  { text: '我们终于又见面了', band: 'contextual', context: 'wolf频道首夜', note: '狼队内开场——活人感强' },
  { text: 'darling hold my hand', band: 'contextual', context: 'wolf频道', note: '玩梗英文混搭' },
  { text: '白天也能聊', band: 'contextual', context: 'lover频道', note: '恋人频道特性' },
  { text: '我死了但我还能说话', band: 'contextual', context: '死后白天', note: '遗言/观战活跃' },
  { text: '今晚刀谁', band: 'contextual', context: 'wolf频道夜里', note: '狼队行动表态' },
  { text: '冰糖，你可还有何话要说', band: 'contextual', context: '点名互动', note: '点名形态——未来槽位化' },
  // --- meta 待人工分类（20）---
  { text: '这是谁', band: 'meta', context: '任意', note: '疑问——待分类' },
  { text: '这怎么改名', band: 'meta', context: '任意', note: '操作性疑问——暴露真人' },
  { text: '啥时候开啊', band: 'meta', context: '大厅', note: '组局催促' },
  { text: '这个符号怎么发的？', band: 'meta', context: '任意', note: '操作性疑问' },
  { text: '哪个符号', band: 'meta', context: '任意', note: '操作性疑问' },
  { text: '没有自动下拉了？', band: 'meta', context: '任意', note: 'UI反馈' },
  { text: '我现在得手动', band: 'meta', context: '任意', note: 'UI反馈' },
  { text: '可能我不小心删了吧', band: 'meta', context: '任意', note: 'UI反馈' },
  { text: '我死但我还能说话', band: 'meta', context: '死后', note: '与上下文重复——待分类' },
  { text: '简简单单耍个六人局', band: 'meta', context: '大厅', note: '组局话题' },
  { text: '摇不到人如何破局', band: 'meta', context: '大厅', note: '组局话题' },
  { text: '马上开', band: 'meta', context: '大厅', note: '组局催促' },
  { text: '何意义', band: 'meta', context: '任意', note: '疑问——待分类' },
  { text: '何意味', band: 'meta', context: '任意', note: '疑问——待分类' },
  { text: '不知道', band: 'meta', context: '任意', note: '万能回应（低频）' },
  { text: '这活人感做的还行吧', band: 'meta', context: '评价bot', note: '玩家评价bot——用会被识破' },
  { text: '我这人机做的不赖', band: 'meta', context: '评价bot', note: '玩家评价bot——用会被识破' },
  { text: '震撼亚洲', band: 'meta', context: '任意', note: '梗——待分类' },
  { text: '满屏幕飞', band: 'meta', context: '任意', note: '观察反馈——待分类' },
  { text: '强强？！', band: 'meta', context: '夸赞', note: '叠词玩梗——待分类' }
];

// 与 corpus-clean 匹配（取 role/ch/day 上下文）
const out = PICK.map(p => {
  const hit = rows.find(r => r.text === p.text);
  return {
    text: p.text,
    role: hit ? hit.role : null,
    ch: hit ? hit.ch : 'all',
    day: hit ? hit.day : null,
    dupCount: hit ? hit.dupCount : 1,
    band: p.band,
    context: p.context,
    note: p.note
  };
});
const f = path.join(root, 'data/nlu/human-feel-seeds.jsonl');
fs.writeFileSync(f, out.map(x => JSON.stringify(x)).join('\n') + '\n');
console.log('活人感种子建档:', out.length, '条 →', f);
const byBand = {};
for (const x of out) byBand[x.band] = (byBand[x.band] || 0) + 1;
console.log('分档:', JSON.stringify(byBand));
// 未匹配检查
const unmatched = PICK.filter(p => !rows.find(r => r.text === p.text));
console.log('未匹配语料:', unmatched.length ? unmatched.map(u => u.text).join(' | ') : '无（全部匹配）');

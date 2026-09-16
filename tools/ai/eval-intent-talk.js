'use strict';
/* V5 A4 线上线下评估：
 *  1) 真实聊天语料上的意图覆盖率 / 有标注准确率（human-chat + NLU 标注语料）
 *  2) 意图回复模板冒烟（genPhrase 可解析、无占位符）
 *  3) 可选 lab A/B：V5_INTENT_TALK=0/1 各跑 N 局，比较稳定性指标（错误/超时/时长/发言量/胜率）
 * 用法：node tools/ai/eval-intent-talk.js [--ab-games=300] [--json=data/eval-intent-talk.json] [--strict]
 * 说明：线上真实玩家 A/B 仍需在发布后按 V5_INTENT_TALK 开关灰度；本工具提供可复现的量化基线。 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..', '..');
const { classify } = require(path.join(root, 'server/ai/nlu-intent.js'));
const { ruleIntent } = require(path.join(root, 'server/ai/intent-features.js'));
require(path.join(root, 'server/ai/bot-brain/index.js')); // 注册 ctx
const { genPhrase } = require(path.join(root, 'server/ai/bot-brain/talk.js'));

const args = {};
for (const a of process.argv.slice(2)) { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; else if (a.startsWith('--')) args[a.slice(2)] = true; }
const DEFAULT_CORPORA = [
  'data/chat-logs/human-chat.jsonl',
  'data/nlu/corpus-clean.annotated.jsonl',
  'data/nlu/corpus-clean.balanced.jsonl',
  'data/nlu/corpus-v5-5000.jsonl',
];
const corpora = (args.corpus ? String(args.corpus).split(',') : DEFAULT_CORPORA)
  .map(p => path.resolve(root, p)).filter(p => fs.existsSync(p));
const abGames = parseInt(args['ab-games'] || '0', 10) || 0;
const strict = !!args.strict;

function predict(text) {
  const c = classify(text);
  return c ? { intent: c, via: 'model' } : (ruleIntent(text) ? { intent: ruleIntent(text), via: 'rule' } : { intent: null, via: null });
}

function evalCorpus(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const rows = [];
  for (const l of lines) { try { rows.push(JSON.parse(l)); } catch (e) { /* skip */ } }
  const n = rows.length;
  const intentCount = {};
  const unknown = {};
  const unknownTop = () => Object.entries(unknown).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([text, c]) => ({ text, count: c }));
  let covered = 0, unknownCount = 0, viaRule = 0, labeled = 0, correct = 0;
  const perClass = {};
  for (const r of rows) {
    const text = r.text || r.msg || '';
    if (!text) continue;
    const p = predict(text);
    if (p.intent) { covered++; intentCount[p.intent] = (intentCount[p.intent] || 0) + 1; }
    else { unknownCount++; unknown[text] = (unknown[text] || 0) + 1; }
    if (p.via === 'rule') viaRule++;
    const label = r.intent || r.label || null;
    if (label && typeof label === 'string') {
      labeled++;
      perClass[label] = perClass[label] || { support: 0, pred: 0, hit: 0 };
      perClass[label].support++;
      if (p.intent === label) { correct++; perClass[label].hit++; }
      if (p.intent) perClass[p.intent] = perClass[p.intent] || { support: 0, pred: 0, hit: 0 };
      if (p.intent) perClass[p.intent].pred++;
    }
  }
  const per = {};
  for (const [k, v] of Object.entries(perClass)) {
    per[k] = { support: v.support, recall: v.support ? +(v.hit / v.support).toFixed(4) : 0, pred: v.pred, precision: v.pred ? +(v.hit / v.pred).toFixed(4) : 0 };
  }
  return {
    corpus: path.relative(root, file), lines: n, texts: covered + unknownCount,
    coverage: +(covered / Math.max(1, covered + unknownCount)).toFixed(4),
    ruleFallbackRate: +(viaRule / Math.max(1, covered + unknownCount)).toFixed(4),
    intents: intentCount,
    labeled: labeled || 0,
    accuracy: labeled ? +(correct / labeled).toFixed(4) : null,
    perClass: per,
    unknownTop: unknownTop(),
  };
}

const REPLY_INTENTS = ['defend_self', 'debate_seer', 'pressure']; // genPhrase 支持的“输出意图”
const TRIGGER_INTENTS = ['attack', 'check', 'claim_seer', 'vote']; // A4 回应钩子消费的“输入意图”
function replySmoke() {
  const out = {};
  for (const it of REPLY_INTENTS) {
    const text = genPhrase(it, { name: '阿青' });
    out[it] = text ? { ok: !/\{[a-zA-Z]+\}/.test(text) && text.length > 0 && text.length <= 120, len: text.length } : { ok: false, len: 0, missing: true };
  }
  return out;
}
function triggerSmoke() {
  const out = {};
  for (const it of TRIGGER_INTENTS) {
    const hits = [
      { text: '我怀疑阿青是狼', intent: 'attack' },
      { text: '查杀阿青', intent: 'check' },
      { text: '我是预言家，昨晚查了阿青：金水', intent: 'claim_seer' },
      { text: '投阿青', intent: 'vote' },
    ].filter(t => t.intent === it);
    out[it] = hits.length ? predict(hits[0].text).intent === it : false;
  }
  return out;
}

function runArm(tag, games) {
  const outFile = path.join('data', `talk-ab-${tag}.jsonl`);
  const r = spawnSync(process.execPath, ['test/lab/lab.js', 'sample', `--games=${games}`, '--parallel=6', `--out=${outFile}`], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, V5_INTENT_TALK: tag === 'on' ? '1' : '0', V5_SAMPLES: '0' },
  });
  if (r.status !== 0) return { tag, error: (r.stderr || r.stdout || '').split('\n').slice(-3).join(' | ') || `exit ${r.status}` };
  const abs = path.resolve(root, outFile);
  const rows = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  let errors = 0, timeouts = 0, speech = 0, durs = 0, winner = {};
  for (const o of rows) {
    if (o.result && o.result.error) errors++;
    if (o.result && o.result.timeout) timeouts++;
    if (o.result) winner[o.result.winner] = (winner[o.result.winner] || 0) + 1;
    durs += (o.durMs || 0);
    speech += (o.events || []).filter(e => e.t === 'speech').length;
  }
  const n = rows.length || 1;
  return { tag, games: rows.length, errors, timeouts, avgDurMs: Math.round(durs / n), avgSpeech: +(speech / n).toFixed(2), winner };
}

const report = {
  generatedAt: new Date().toISOString(),
  note: '分类器为闭集 argmax（无拒识），coverage 恒为 100%；准确率语料与训练同域，仅作回归基线，留出指标见 tools/nlu/eval-intent-macro-auc.js（5 折 macro AUC）。',
  corpora: corpora.map(evalCorpus), replySmoke: replySmoke(), triggerSmoke: triggerSmoke(),
};

if (abGames > 0) {
  const off = runArm('off', abGames);
  const on = runArm('on', abGames);
  const delta = (off.avgSpeech && on.avgSpeech) ? +((on.avgSpeech - off.avgSpeech) / off.avgSpeech).toFixed(4) : null;
  report.ab = {
    games: abGames, off, on, speechDelta: delta,
    regressions: [
      on.errors > off.errors ? `errors ${off.errors} -> ${on.errors}` : null,
      on.timeouts > off.timeouts ? `timeouts ${off.timeouts} -> ${on.timeouts}` : null,
      (delta != null && Math.abs(delta) > 0.2) ? `avgSpeech ${off.avgSpeech} -> ${on.avgSpeech}` : null,
    ].filter(Boolean),
  };
}

// 控制台摘要
console.log('=== V5 A4 intent-talk 评估 ===');
for (const c of report.corpora) {
  console.log(`\n[corpus] ${c.corpus}  文本=${c.texts}  覆盖=${(c.coverage * 100).toFixed(1)}%  规则兜底=${(c.ruleFallbackRate * 100).toFixed(1)}%` + (c.accuracy != null ? `  标注准确率=${(c.accuracy * 100).toFixed(1)}% (n=${c.labeled})` : '  (无标签)'));
  console.log('  意图分布: ' + Object.entries(c.intents).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
  if (c.unknownTop.length) console.log('  未识别Top: ' + c.unknownTop.slice(0, 5).map(u => `${JSON.stringify(u.text)}x${u.count}`).join(' '));
}
console.log('\n[replySmoke] ' + Object.entries(report.replySmoke).map(([k, v]) => `${k}:${v.ok ? 'ok' : (v.missing ? 'missing' : 'bad')}`).join(' '));
console.log('[triggerSmoke] ' + Object.entries(report.triggerSmoke).map(([k, v]) => `${k}:${v ? 'ok' : 'bad'}`).join(' '));
if (report.ab) {
  console.log(`\n[lab A/B ${abGames}局] off: 错误=${report.ab.off.errors} 超时=${report.ab.off.timeouts} 时长=${report.ab.off.avgDurMs}ms 发言/局=${report.ab.off.avgSpeech} | on: 错误=${report.ab.on.errors} 超时=${report.ab.on.timeouts} 时长=${report.ab.on.avgDurMs}ms 发言/局=${report.ab.on.avgSpeech}`);
  console.log('  回归项: ' + (report.ab.regressions.length ? report.ab.regressions.join('; ') : '无'));
}

const jsonOut = typeof args.json === 'string' ? args.json : null;
if (jsonOut) { const p = path.resolve(root, jsonOut); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(report, null, 2)); console.log(`\n报告已写入 ${p}`); }
if (strict) {
  const bad = report.corpora.some(c => c.coverage < 0.5) || Object.values(report.replySmoke).some(v => !v.ok) || Object.values(report.triggerSmoke).some(v => !v) || (report.ab && report.ab.regressions.length);
  if (bad) { console.error('\n[strict] 存在不达标项'); process.exit(1); }
}

'use strict';
/* 版本号一键升级（P3）：同步 package.json / index.html 页脚 / sw.js CACHE / README / 更新公告.md。
 * 用法：node tools/bump-version.js <新版本号>
 * 示例：node tools/bump-version.js 1.8.0
 * 执行后建议运行 node test/check-version-sync.js 校验。 */
const fs = require('fs');
const path = require('path');

const proj = path.resolve(__dirname, '..');
const files = {
  pkg: path.join(proj, 'package.json'),
  html: path.join(proj, 'public', 'index.html'),
  sw: path.join(proj, 'public', 'sw.js'),
  readme: path.join(proj, 'README.md'),
  changelog: path.join(proj, '更新公告.md'),
};

const next = process.argv[2];
if (!next) {
  const pkg = JSON.parse(fs.readFileSync(files.pkg, 'utf8'));
  console.error('用法: node tools/bump-version.js <新版本号>');
  console.error('当前版本: ' + pkg.version);
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('版本号格式必须为 x.y.z，收到: ' + next);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(files.pkg, 'utf8'));
const oldVer = pkg.version;
if (oldVer === next) {
  console.log('版本未变化: ' + oldVer);
  process.exit(0);
}

function replaceFile(file, pattern, replacement, label) {
  const src = fs.readFileSync(file, 'utf8');
  if (!pattern.test(src)) {
    console.error('未找到 ' + label + ' 的版本串模式，已中止（避免部分写入）');
    process.exit(1);
  }
  pattern.lastIndex = 0;
  fs.writeFileSync(file, src.replace(pattern, replacement));
  console.log('更新 ' + label + ': ' + oldVer + ' -> ' + next);
}

// package.json：整体 JSON 重写，保留原缩进
pkg.version = next;
fs.writeFileSync(files.pkg, JSON.stringify(pkg, null, 2) + '\n');
console.log('更新 package.json: ' + oldVer + ' -> ' + next);

replaceFile(files.html, /(<span>v)[\d.]+(<\/span>)/, '$1' + next + '$2', 'index.html 页脚');
replaceFile(files.sw, /(CACHE = 'ww-v)[\d.]+(')/, '$1' + next + '$2', 'sw.js CACHE');
replaceFile(files.readme, /(当前版本：\*\*)[\d.]+(\*\*)/, '$1' + next + '$2', 'README.md');
replaceFile(files.changelog, /(当前版本：\*\*)[\d.]+(\*\*)/, '$1' + next + '$2', '更新公告.md');

console.log('\n版本串已同步到 ' + next + '，可运行 node test/check-version-sync.js 校验。');

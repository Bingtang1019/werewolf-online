'use strict';
/* 版本串同步检查（v1.6.2）：package.json / index.html 页脚 / sw.js CACHE / README / 更新公告.md 必须一致。
 * 发版时修改 package.json version 后运行本测试（或纳入全量回归），防止版本串各写各的。 */
const fs = require('fs');
const path = require('path');
const proj = path.resolve(__dirname, '..');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

const pkg = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
const ver = pkg.version;
assert(/^\d+\.\d+\.\d+$/.test(ver), 'package.json 版本格式合法: ' + ver);

const html = fs.readFileSync(path.join(proj, 'public', 'index.html'), 'utf8');
const foot = (html.match(/<span>v([\d.]+)<\/span>/) || [])[1];
assert(foot === ver, 'index.html 页脚版本 v' + foot + ' === package ' + ver);

const sw = fs.readFileSync(path.join(proj, 'public', 'sw.js'), 'utf8');
const cache = (sw.match(/CACHE = 'ww-v?([^']+)'/) || [])[1];
assert(cache === ver, 'sw.js CACHE 版本 ww-' + cache + ' === package ' + ver);

const readme = fs.readFileSync(path.join(proj, 'README.md'), 'utf8');
const rv = (readme.match(/当前版本：\*\*([\d.]+)\*\*/) || [])[1];
assert(rv === ver, 'README 当前版本 ' + rv + ' === package ' + ver);

const changelog = fs.readFileSync(path.join(proj, '更新公告.md'), 'utf8');
const cv = (changelog.match(/当前版本：\*\*([\d.]+)\*\*/) || [])[1];
assert(cv === ver, '更新公告.md 当前版本 ' + cv + ' === package ' + ver);

if (failures) { console.error(`\n共 ${failures} 处版本不一致`); process.exit(1); }
console.log('\n版本串同步检查全部通过 ✔');
process.exit(0);

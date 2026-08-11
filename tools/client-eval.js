
require('./tools/mock-global.js');
const fs = require('fs');
const src = fs.readFileSync('./public/client.js', 'utf8');
try {
  eval(src);
  console.log('✅ client.js 顶层执行完成');
  console.log('btn-music:', document.getElementById('btn-music')._ls && document.getElementById('btn-music')._ls.click ? '✅ 绑定' : '❌');
  console.log('mp-play:', document.getElementById('mp-play')._ls && document.getElementById('mp-play')._ls.click ? '✅ 绑定' : '❌');
  console.log('card-create:', document.getElementById('card-create')._ls && document.getElementById('card-create')._ls.click ? '✅ 绑定' : '❌');
} catch (e) {
  console.log('❌ 崩溃:', e.message);
  console.log((e.stack || '').split('
').slice(0, 3).join('
'));
}

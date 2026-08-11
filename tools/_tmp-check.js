const fs = require('fs');
const src = fs.readFileSync('game.js', 'utf8');
const lines = src.split('\n');
const found = [];
for (let k = 0; k < 435; k++) {
  const mm = lines[k].match(/^(let|const|var)\s+(\w+)/);
  if (mm) found.push(mm[1] + ':' + mm[2]);
}
console.log('全部匹配:', found.join(', '));

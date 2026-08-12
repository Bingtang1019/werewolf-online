// 示例模组·服务端入口（mods/example-mod/entry.js）
// 加载时收到上下文：{ Game, rooms, registerHook }
module.exports = function (ctx) {
  console.log('[mod] 已加载: ' + (ctx.manifest ? ctx.manifest.name : 'example-mod') + ' v' + (ctx.manifest ? ctx.manifest.version : '1.0.0'));
  // 示例钩子：监听房间创建
  if (ctx.registerHook) {
    ctx.registerHook('onRoomCreate', (room) => {
      console.log('[mod] 房间创建: ' + room.id + '（' + room.players.length + ' 人）');
    });
  }
};

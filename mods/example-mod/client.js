// 示例模组·客户端注入（mods/example-mod/client.js）
// 以字符串注入页面（在 mods-zone 之后）——DOMContentLoaded 后执行
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var box = document.createElement('div');
    box.id = 'example-mod-banner';
    box.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:9999;background:rgba(0,0,0,.7);color:#fff;padding:6px 12px;border-radius:8px;font-size:12px;pointer-events:none;';
    box.textContent = '🎮 示例模组已注入';
    document.body.appendChild(box);
    setTimeout(function () { box.style.opacity = '0.3'; }, 5000);
  });
})();

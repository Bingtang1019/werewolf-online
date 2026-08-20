# Mods（模组）部署说明

本目录用于存放社区/个人模组。**服务端启动时自动扫描 `mods/*/mod.json`**，无需改动主代码即可加载自定义模组。

## 目录规范

```
mods/
├── README.md            # 本说明
└── <模组名>/            # 每个模组一个文件夹（小写字母/数字/连字符）
    ├── mod.json         # 模组清单（必填——被服务端扫描）
    ├── entry.js         # 服务端入口（可选——Node 模块，加载时执行）
    ├── client.js        # 客户端注入（可选——JS 代码，以字符串注入页面）
    └── assets/          # 静态资源（可选——通过 /mods/<模组名>/assets/ 访问）
```

## mod.json 格式

```json
{
  "name": "示例模组",
  "version": "1.0.0",
  "description": "模组功能描述",
  "entry": "entry.js",
  "client": "client.js",
  "enabled": true
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 模组显示名 |
| `version` | ✅ | 模组版本 |
| `description` | 可选 | 功能描述 |
| `entry` | 可选 | 服务端入口文件（相对于模组目录）；加载时收到 `{ Game, rooms, registerHook }` 上下文 |
| `client` | 可选 | 客户端注入 JS（以字符串注入 index.html 的 `mods-zone` 容器之后） |
| `enabled` | 可选 | 默认 `true`——`false` 时跳过加载 |

## 服务端入口（entry.js）

```js
// 收到上下文：{ Game, rooms, registerHook }
module.exports = function (ctx) {
  // ctx.Game       —— 游戏引擎（server/game/index.js 的导出）
  // ctx.rooms      —— 房间 Map（共享引用）
  // ctx.registerHook —— 注册钩子（如 'onAction'、'onState'）
  console.log('[mod] 示例模组已加载');
};
```

## 静态资源

`assets/` 下的文件通过 `GET /mods/<模组名>/assets/<文件>` 访问（自动映射，无需配置）。客户端注入（client.js）中可用相对路径引用：`/mods/<模组名>/assets/xxx.png`。

## 快速开始（示例）

1. 复制 `mods/example-mod/` 为你的模组目录
2. 修改 `mod.json`（name/version/description）
3. 在 `entry.js` 中写服务端逻辑（可选）
4. 在 `client.js` 中写客户端注入（可选）
5. 重启服务器 → 控制台输出 `[mod] 已加载: <name> v<version>` 即成功

## 注意

- 模组有完全的系统访问权（服务端 entry 在 Node 进程内执行）——**只安装可信模组**
- 模组异常不会导致服务器崩溃：加载失败会打印错误并跳过（`enabled:false` 可禁用）
- 官方代码更新不会覆盖 `mods/` 目录（gitignore 建议保留本地模组）

## 安全与信任模型（P3）

**模组不是沙箱。** 本项目的 mod 机制定位是“给可信开发者/自部署者扩展”，不提供权限隔离：

- **服务端入口（entry.js）**：在 Node 进程内以完整权限执行，可读写文件、访问网络、读取全部房间状态、调用 `Game` 与 `rooms`。恶意模组等同于服务器被入侵。
- **客户端注入（client.js）**：以字符串注入每个玩家浏览器页面，拥有页面同源权限（可读取页面 DOM、本地存储、向服务器发起请求）。恶意客户端模组可窃取同一页面下的玩家数据。
- **静态资源（assets/）**：仅静态文件，但仍应视为模组内容的一部分。

**部署建议**

1. 生产公网环境默认用 `MODS=0` 启动，完全关闭 mod 加载与注入端点；确认不需要任何模组时不要开启。
2. 确需使用模组时，只安装**来源可信、代码可审查**的模组；安装前阅读 `entry.js` 与 `client.js` 全文。
3. 单个模组可用 `mod.json` 的 `"enabled": false` 禁用；要彻底禁用全部模组，设置环境变量 `MODS=0` 后重启。
4. 不要从不可信的第三方渠道复制模组目录直接放入 `mods/`。
5. 如模组需要更高隔离，请部署在独立进程/容器中，通过 HTTP 接口与主服务通信（本项目未内置此能力）。

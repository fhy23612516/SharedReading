# 一起阅读

这是当前的网页端 MVP。

它现在已经是“前端服务 + 后端服务”分离运行的结构：

1. 前端服务：[frontend.server.js](</E:/Program Files/VibeCoding/SharedReading/frontend.server.js>)
2. 后端服务：[server.js](</E:/Program Files/VibeCoding/SharedReading/server.js>)
3. 前端页面：[index.html](</E:/Program Files/VibeCoding/SharedReading/index.html>)、[app.js](</E:/Program Files/VibeCoding/SharedReading/app.js>)、[styles.css](</E:/Program Files/VibeCoding/SharedReading/styles.css>)

## 当前能力

当前版本支持：

1. 创建房间、加入房间
2. 房间码分享和邀请链接分享
3. 双人阅读同一篇内容
4. 实时同步双方阅读进度
5. 房间内聊天、快捷消息、动态汇总
6. 断线重连、恢复原身份、回到上次房间
7. 房主关闭房间
8. 阅读完成页和最近记录

## 端口说明

1. 前端：`3211`
2. 后端：`3210`

本机访问前端：

```text
http://127.0.0.1:3211
```

本机访问后端：

```text
http://127.0.0.1:3210
```

## 启动方式

### 正式模式

启动后端：

```powershell
npm start
```

启动前端：

```powershell
npm run start:frontend
```

### 后端热更新开发模式

后端开发时可以直接用：

```powershell
npm run dev
```

这个模式会在 `server.js` 变化后自动重启后端。

也可以直接双击：

1. [start-dev.bat](</E:/Program Files/VibeCoding/SharedReading/start-dev.bat>)

注意：

1. `dev` 只负责后端热更新。
2. 它不负责自动启动前端。
3. 正式公网运行不要用这个模式。
4. `start-all` 是稳定公网运行脚本，不会自动热更新后端。

## 一键启动 / 一键停止

项目根目录下有这些脚本：

1. [start-all.ps1](</E:/Program Files/VibeCoding/SharedReading/start-all.ps1>)
2. [stop-all.ps1](</E:/Program Files/VibeCoding/SharedReading/stop-all.ps1>)
3. [start-all.bat](</E:/Program Files/VibeCoding/SharedReading/start-all.bat>)
4. [stop-all.bat](</E:/Program Files/VibeCoding/SharedReading/stop-all.bat>)

如果你想双击，优先用：

1. [start-all.bat](</E:/Program Files/VibeCoding/SharedReading/start-all.bat>)
2. [stop-all.bat](</E:/Program Files/VibeCoding/SharedReading/stop-all.bat>)

`start-all` 现在会做这些事：

1. 启动后端 `3210`
2. 启动前端 `3211`
3. 启动 `ngrok`
4. `ngrok` 转发前端 `3211`
5. 记录前端、后端、ngrok 的 PID 到 `.runtime/processes.json`

`stop-all` 会停止：

1. 后端
2. 前端
3. ngrok

## 测试

当前有一个基础 API 冒烟测试：

```powershell
npm.cmd test
```

它会使用临时数据文件启动后端，验证创建身份、创建房间、加入房间、进度上报、消息幂等、关闭房间和最近记录。

如果你的 PowerShell 允许执行 `npm.ps1`，也可以直接运行 `npm test`。

## ngrok 说明

当前公网访问时，`ngrok` 转发的是前端：

1. `sharedreading` -> `http://127.0.0.1:3211`

这意味着：

1. 公网用户先访问前端页面
2. 前端再通过代理访问本地后端 `3210`

## 前后端结构说明

当前这套已经属于“运行分离”的结构：

1. 前端单独起服务
2. 后端单独起服务
3. 前端通过 `/api/...` 和 SSE 调后端
4. 默认由前端服务做代理，开发时不需要手改接口地址

如果后面要继续往正式部署演进，可以再走两步：

1. 前端改成纯静态托管
2. 把 `app-config.js` 里的 `API_BASE_URL` 指到独立后端域名

### 简化结构图

```text
前端页面
index.html / app.js / styles.css
        │
        │  /api/... + SSE
        ▼
后端服务
server.js
        │
        ▼
数据文件
data/store.json / data/stories.js
```

### 关键时序

创建房间：

```text
前端点击创建
  -> POST /api/rooms
  -> 后端创建房间并保存
  -> 返回房间数据
  -> 前端跳转到等待页/房间页
```

聊天：

```text
前端发送消息
  -> POST /api/rooms/:id/messages
  -> 后端保存消息
  -> SSE 推送给双方
  -> 前端更新聊天区
```

进度同步：

```text
前端滚动阅读
  -> POST /api/rooms/:id/progress
  -> 后端保存进度
  -> SSE 推送给对方
  -> 前端更新进度条
```

## 独立部署示例

如果后面要把前端和后端真正分开部署，可以按下面这种方式：

### 方案示例

1. 前端域名：`https://read.example.com`
2. 后端域名：`https://api-read.example.com`

### 后端部署

后端只跑 [server.js](</E:/Program Files/VibeCoding/SharedReading/server.js>)，例如：

```powershell
$env:PORT="3210"
$env:HOST="0.0.0.0"
$env:CORS_ORIGIN="https://read.example.com"
node server.js
```

后端需要保证：

1. `https://api-read.example.com/api/bootstrap` 可访问
2. SSE 可访问
3. `CORS_ORIGIN` 指向前端域名

### 前端部署

前端可以有两种方式。

#### 方式 A：继续使用当前前端服务

直接跑 [frontend.server.js](</E:/Program Files/VibeCoding/SharedReading/frontend.server.js>)：

```powershell
$env:FRONTEND_PORT="3211"
$env:FRONTEND_HOST="0.0.0.0"
$env:BACKEND_ORIGIN="https://api-read.example.com"
$env:FRONTEND_API_BASE_URL=""
node frontend.server.js
```

这种方式下：

1. 浏览器访问前端域名
2. 前端服务继续把 `/api/...` 代理到后端域名
3. 浏览器里不需要直接暴露 `API_BASE_URL`

#### 方式 B：前端做纯静态部署

如果前端是静态托管，就需要单独提供 `app-config.js`，内容类似：

```js
window.__APP_CONFIG__ = {
  API_BASE_URL: "https://api-read.example.com"
};
```

这种方式下：

1. [index.html](</E:/Program Files/VibeCoding/SharedReading/index.html>)、[app.js](</E:/Program Files/VibeCoding/SharedReading/app.js>)、[styles.css](</E:/Program Files/VibeCoding/SharedReading/styles.css>) 放到静态站点
2. `app-config.js` 也一起部署
3. 前端会直接请求独立后端域名

### 反向代理示例思路

如果你用 Nginx 或类似工具，可以这样理解：

1. `read.example.com` 指向前端
2. `api-read.example.com` 指向后端
3. 后端开放 `/api/...`
4. 后端 SSE 路径同样保持 `/api/rooms/:id/events`

### GitHub + 服务器部署

如果你准备把代码推到 GitHub，再从服务器拉取部署，直接看：

1. [部署文档.md](</E:/Program Files/VibeCoding/SharedReading/部署文档.md>)
2. [ecosystem.config.cjs](</E:/Program Files/VibeCoding/SharedReading/ecosystem.config.cjs>)
3. [deploy/nginx.shared-reading.conf](</E:/Program Files/VibeCoding/SharedReading/deploy/nginx.shared-reading.conf>)

推荐正式服务器使用 PM2 + Nginx，不再使用 ngrok。

### 当前项目里相关环境变量

后端：

1. `PORT`
2. `HOST`
3. `CORS_ORIGIN`
4. `STORE_PATH`

前端服务：

1. `FRONTEND_PORT`
2. `FRONTEND_HOST`
3. `BACKEND_ORIGIN`
4. `FRONTEND_API_BASE_URL`

### 推荐做法

如果你现在只是先稳定跑起来，优先用：

1. 服务器跑 `frontend.server.js`
2. 服务器跑 `server.js`
3. 前端通过 `BACKEND_ORIGIN` 代理后端

这样改动最少，也最接近你当前这套项目结构。

## 主要文件

1. [index.html](</E:/Program Files/VibeCoding/SharedReading/index.html>)
2. [app.js](</E:/Program Files/VibeCoding/SharedReading/app.js>)
3. [styles.css](</E:/Program Files/VibeCoding/SharedReading/styles.css>)
4. [frontend.server.js](</E:/Program Files/VibeCoding/SharedReading/frontend.server.js>)
5. [server.js](</E:/Program Files/VibeCoding/SharedReading/server.js>)
6. [package.json](</E:/Program Files/VibeCoding/SharedReading/package.json>)
7. [start-all.ps1](</E:/Program Files/VibeCoding/SharedReading/start-all.ps1>)
8. [stop-all.ps1](</E:/Program Files/VibeCoding/SharedReading/stop-all.ps1>)
9. [start-dev.ps1](</E:/Program Files/VibeCoding/SharedReading/start-dev.ps1>)
10. [data/stories.js](</E:/Program Files/VibeCoding/SharedReading/data/stories.js>)
11. [data/store.json](</E:/Program Files/VibeCoding/SharedReading/data/store.json>)
12. [需求文档.md](</E:/Program Files/VibeCoding/SharedReading/需求文档.md>)
13. [接口文档.md](</E:/Program Files/VibeCoding/SharedReading/接口文档.md>)
14. [tests/api-smoke.test.js](</E:/Program Files/VibeCoding/SharedReading/tests/api-smoke.test.js>)
15. [部署文档.md](</E:/Program Files/VibeCoding/SharedReading/部署文档.md>)
16. [ecosystem.config.cjs](</E:/Program Files/VibeCoding/SharedReading/ecosystem.config.cjs>)
17. [deploy/nginx.shared-reading.conf](</E:/Program Files/VibeCoding/SharedReading/deploy/nginx.shared-reading.conf>)
18. [.env.example](</E:/Program Files/VibeCoding/SharedReading/.env.example>)

## 当前产品规则

和最早的“强同步等待版”相比，当前网页端已经调整为“弱同步一起阅读”：

1. 仍然显示双方阅读进度
2. 阈值现在只作为节奏参考
3. 不再强制锁住快的一方
4. 离开房间页默认只算离线，不是立即销毁房间
5. 用户身份和上次房间保存在本地，可重新进入原房间
6. 首页支持回到上次房间
7. 房主可以彻底关闭房间
8. 弱网下进度和消息会先本地显示，再自动补发
9. 动态汇总支持按消息、进度、成员筛选
10. 离线成员会显示大致离线时长

## 当前待完善项

下一步建议优先继续补这些：

1. 正式小程序端页面和发布配置
2. 正式公网部署和 HTTPS 域名
3. 更强身份安全，例如房间访问 token 或账号登录
4. 更完整的历史记录检索和详情页
5. 多设备、多浏览器、弱网条件下的自动化 UI 回归测试

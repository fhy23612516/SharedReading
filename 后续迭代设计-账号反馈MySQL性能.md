# 后续迭代设计：统一账号、反馈、MySQL 与响应优化

本文档记录下一阶段需求设计，不代表当前代码已经全部实现。当前代码仍是 JSON 文件存储 + 轻量身份；下一阶段按本文档逐步改造。

## 1. 目标

下一阶段要解决四件事：

1. Web 和小程序使用同一套自有注册登录系统。
2. 增加用户反馈功能。
3. 使用 MySQL 替代 `data/store.json`。
4. 提升接口响应时间和弱网体验。

核心原则：

1. Web 和小程序共用同一套后端账号体系。
2. 不强制使用微信/QQ 登录。
3. 后端接口路径尽量保持兼容，减少前端和小程序重复改造。
4. 先完成数据库和账号基础，再做反馈和性能优化。

## 2. 推荐实施顺序

### 第一步：MySQL 存储层

先把 JSON 文件存储替换成 MySQL，保持现有业务接口行为尽量不变。

原因：

1. 注册登录依赖用户表。
2. 反馈功能依赖持久化表。
3. 响应优化需要索引和查询拆分。

### 第二步：统一注册登录

在 MySQL 基础上增加账号系统，Web 和小程序共用。

### 第三步：反馈功能

在登录用户基础上记录反馈人、反馈内容和处理状态。

### 第四步：响应时间优化

基于 MySQL 索引、轻量接口、Nginx 直连 `/api`、分页和缓存做优化。

## 3. 统一账号系统

### 3.1 登录方式

第一版采用自有账号，不依赖微信/QQ。

支持：

1. 账号 + 密码。
2. 昵称。
3. Web 和小程序使用同一套账号。

账号字段建议命名为 `account`，可以先作为用户名使用，后续兼容手机号或邮箱。

### 3.2 注册接口

```text
POST /api/auth/register
```

请求：

```json
{
  "account": "fhy123",
  "password": "12345678",
  "nickname": "小明"
}
```

返回：

```json
{
  "token": "session-token",
  "user": {
    "id": "user_xxx",
    "account": "fhy123",
    "nickname": "小明"
  }
}
```

### 3.3 登录接口

```text
POST /api/auth/login
```

请求：

```json
{
  "account": "fhy123",
  "password": "12345678"
}
```

返回：

```json
{
  "token": "session-token",
  "user": {
    "id": "user_xxx",
    "account": "fhy123",
    "nickname": "小明"
  }
}
```

### 3.4 当前用户接口

```text
GET /api/auth/me
```

请求头：

```http
Authorization: Bearer session-token
```

返回：

```json
{
  "user": {
    "id": "user_xxx",
    "account": "fhy123",
    "nickname": "小明"
  }
}
```

### 3.5 退出登录接口

```text
POST /api/auth/logout
```

请求头：

```http
Authorization: Bearer session-token
```

处理方式：

1. 删除或失效当前 token。
2. 前端和小程序清理本地 token。

### 3.6 密码安全

密码不能明文入库。

建议：

1. 使用 `bcrypt` 或 `argon2` 哈希密码。
2. 数据库存储 `password_hash`。
3. 登录时只比较哈希。
4. token 使用高强度随机值。
5. token 设置过期时间，例如 30 天。

### 3.7 Web 和小程序统一方式

Web：

```text
localStorage 保存 token
请求时带 Authorization
```

小程序：

```text
wx.setStorageSync 保存 token
wx.request 请求时带 Authorization
```

统一请求头：

```http
Authorization: Bearer <token>
```

### 3.8 与当前轻量身份的迁移

当前代码使用：

```json
{
  "userId": "user_xxx",
  "name": "昵称"
}
```

下一阶段改为：

1. 登录后从 token 识别用户。
2. 创建房间、加入房间、发消息、上报进度不再信任前端传入的 `userId`。
3. 为兼容旧网页端，可以短期保留 `userId` 字段，但后端优先使用 token 用户。

## 4. 反馈功能

### 4.1 功能范围

第一版反馈功能只做提交和查看自己的反馈。

支持：

1. 问题反馈。
2. 功能建议。
3. 其他反馈。
4. 可选联系方式。
5. 反馈状态。

### 4.2 提交反馈接口

```text
POST /api/feedback
```

请求头：

```http
Authorization: Bearer session-token
```

请求：

```json
{
  "type": "bug",
  "content": "手机端聊天区显示异常",
  "contact": "可选联系方式"
}
```

返回：

```json
{
  "feedback": {
    "id": "feedback_xxx",
    "type": "bug",
    "content": "手机端聊天区显示异常",
    "status": "open",
    "createdAt": "2026-04-29T00:00:00.000Z"
  }
}
```

### 4.3 查看自己的反馈

```text
GET /api/feedback/mine
```

返回：

```json
{
  "items": [
    {
      "id": "feedback_xxx",
      "type": "bug",
      "content": "手机端聊天区显示异常",
      "status": "open",
      "createdAt": "2026-04-29T00:00:00.000Z"
    }
  ]
}
```

### 4.4 后续管理能力

后续可以增加后台接口：

```text
GET /api/admin/feedback
POST /api/admin/feedback/:id/status
```

第一版不做后台管理端，只保留数据。

## 5. MySQL 数据模型

### 5.1 表清单

建议拆分为：

1. `users`
2. `auth_sessions`
3. `stories`
4. `rooms`
5. `room_members`
6. `reading_progress`
7. `chat_messages`
8. `room_events`
9. `reading_records`
10. `feedback`

### 5.2 users

```sql
CREATE TABLE users (
  id VARCHAR(40) PRIMARY KEY,
  account VARCHAR(80) NOT NULL UNIQUE,
  nickname VARCHAR(40) NOT NULL,
  avatar VARCHAR(16),
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  last_active_at DATETIME
);
```

### 5.3 auth_sessions

```sql
CREATE TABLE auth_sessions (
  token_hash VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  INDEX idx_auth_sessions_user_id (user_id),
  INDEX idx_auth_sessions_expires_at (expires_at)
);
```

说明：

1. 数据库建议存 `token_hash`，不要直接存明文 token。
2. 客户端持有明文 token。

### 5.4 stories

```sql
CREATE TABLE stories (
  id VARCHAR(40) PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  author VARCHAR(80),
  cover VARCHAR(16),
  summary TEXT,
  body_json JSON NOT NULL,
  word_count INT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);
```

早期也可以继续保留 `data/stories.js` 作为内置内容，数据库只存房间和用户。

### 5.5 rooms

```sql
CREATE TABLE rooms (
  id VARCHAR(40) PRIMARY KEY,
  code VARCHAR(12) NOT NULL UNIQUE,
  story_id VARCHAR(40) NOT NULL,
  story_title VARCHAR(120) NOT NULL,
  owner_id VARCHAR(40) NOT NULL,
  threshold INT NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  INDEX idx_rooms_code (code),
  INDEX idx_rooms_owner_id (owner_id),
  INDEX idx_rooms_status (status)
);
```

### 5.6 room_members

```sql
CREATE TABLE room_members (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  room_id VARCHAR(40) NOT NULL,
  user_id VARCHAR(40) NOT NULL,
  nickname VARCHAR(40) NOT NULL,
  avatar VARCHAR(16),
  joined_at DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL,
  online TINYINT(1) NOT NULL DEFAULT 1,
  left_at DATETIME NULL,
  UNIQUE KEY uniq_room_user (room_id, user_id),
  INDEX idx_room_members_room_id (room_id),
  INDEX idx_room_members_user_id (user_id)
);
```

### 5.7 reading_progress

```sql
CREATE TABLE reading_progress (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  room_id VARCHAR(40) NOT NULL,
  user_id VARCHAR(40) NOT NULL,
  progress DECIMAL(5,1) NOT NULL DEFAULT 0,
  max_progress DECIMAL(5,1) NOT NULL DEFAULT 0,
  done TINYINT(1) NOT NULL DEFAULT 0,
  wait_count INT NOT NULL DEFAULT 0,
  unlocked_count INT NOT NULL DEFAULT 0,
  last_updated_at DATETIME NOT NULL,
  UNIQUE KEY uniq_progress_room_user (room_id, user_id),
  INDEX idx_reading_progress_room_id (room_id)
);
```

### 5.8 chat_messages

```sql
CREATE TABLE chat_messages (
  id VARCHAR(40) PRIMARY KEY,
  client_id VARCHAR(100),
  room_id VARCHAR(40) NOT NULL,
  user_id VARCHAR(40) NOT NULL,
  user_name VARCHAR(40) NOT NULL,
  content VARCHAR(500) NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uniq_message_client (room_id, user_id, client_id),
  INDEX idx_chat_messages_room_created (room_id, created_at)
);
```

`client_id` 用于弱网重试去重。

### 5.9 room_events

```sql
CREATE TABLE room_events (
  id VARCHAR(40) PRIMARY KEY,
  room_id VARCHAR(40) NOT NULL,
  type VARCHAR(40) NOT NULL,
  user_id VARCHAR(40),
  info VARCHAR(500),
  created_at DATETIME NOT NULL,
  INDEX idx_room_events_room_created (room_id, created_at),
  INDEX idx_room_events_type (type)
);
```

### 5.10 reading_records

```sql
CREATE TABLE reading_records (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  room_id VARCHAR(40) NOT NULL UNIQUE,
  room_code VARCHAR(12) NOT NULL,
  title VARCHAR(120) NOT NULL,
  ended_at DATETIME NOT NULL,
  duration_minutes INT NOT NULL,
  total_messages INT NOT NULL,
  wait_summary VARCHAR(500),
  created_at DATETIME NOT NULL,
  INDEX idx_reading_records_created (created_at)
);
```

### 5.11 feedback

```sql
CREATE TABLE feedback (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  type VARCHAR(30) NOT NULL,
  content TEXT NOT NULL,
  contact VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_feedback_user_created (user_id, created_at),
  INDEX idx_feedback_status (status)
);
```

## 6. MySQL 部署建议

2 核 2G 可以先跑 MySQL，但只建议用于 MVP 和小规模用户。

建议：

1. MySQL 和 Node 同机部署。
2. 控制 MySQL 内存配置。
3. 定期备份数据库。
4. 用户增长后迁移到阿里云 RDS MySQL。

### 6.1 环境变量

后端新增：

```text
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=shared_reading
DB_PASSWORD=your_password
DB_NAME=shared_reading
AUTH_TOKEN_TTL_DAYS=30
```

### 6.2 Node 依赖

建议使用：

```text
mysql2
bcryptjs 或 bcrypt
```

如果要自己写 SQL：

```bash
npm install mysql2 bcryptjs
```

后续如果代码规模变大，可以考虑 ORM 或迁移工具。

## 7. 响应时间优化方案

### 7.1 Nginx 优化

当前链路：

```text
Nginx -> frontend.server.js -> server.js
```

后续建议：

```text
Nginx /api -> server.js
Nginx /    -> frontend.server.js
```

这样小程序请求 `/api` 时少一层 Node 代理。

Nginx 示例：

```nginx
location /api/ {
  proxy_pass http://127.0.0.1:3210;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
}

location / {
  proxy_pass http://127.0.0.1:3211;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### 7.2 接口优化

1. 进度接口只返回进度补丁，不返回全量房间。
2. 消息接口只返回新消息，不返回全量聊天列表。
3. 房间详情接口按需返回最近消息和最近事件。
4. 聊天消息分页。
5. 动态事件分页。

### 7.3 数据库优化

必须加索引：

1. `rooms.code`
2. `room_members.room_id`
3. `reading_progress.room_id, user_id`
4. `chat_messages.room_id, created_at`
5. `room_events.room_id, created_at`
6. `feedback.user_id, created_at`

### 7.4 前端和小程序体验优化

1. 本地先更新 UI，再后台同步。
2. 请求超时后写入本地 outbox。
3. 消息使用 `clientId` 去重。
4. 小程序端弱网时提示“已暂存，稍后自动发送”。
5. 高频进度上报做节流和最后值合并。

## 8. 兼容当前接口的改造策略

第一阶段尽量不改前端调用方式：

1. 继续支持 `POST /api/session`，但内部映射到登录用户。
2. 继续支持房间码加入。
3. 继续支持 `clientId`。
4. 新增 auth 接口，不立即删除旧接口。

第二阶段再统一为：

1. 所有写接口必须带 `Authorization`。
2. 不再接受前端传入的 `userId` 作为可信身份。
3. 历史数据从 JSON 迁移到 MySQL。

## 9. 验收标准

### 9.1 注册登录

1. Web 可以注册账号。
2. Web 可以登录账号。
3. 小程序可以使用同一账号登录。
4. 登录后刷新页面仍能恢复身份。
5. 退出登录后 token 失效。

### 9.2 MySQL

1. 创建房间写入 MySQL。
2. 加入房间写入 MySQL。
3. 进度、聊天、事件写入 MySQL。
4. 关闭房间后生成记录。
5. 重启服务后数据不丢失。

### 9.3 反馈

1. 登录用户可以提交反馈。
2. 反馈内容写入 MySQL。
3. 用户可以查看自己的反馈列表。

### 9.4 响应时间

1. 本机 API 平均响应应低于 100ms。
2. 公网普通接口目标响应低于 300ms。
3. 进度和消息弱网时先本地显示，不阻塞操作。
4. SSE 或轮询不影响普通接口响应。

## 10. 暂不做

1. 微信登录。
2. QQ 登录。
3. 支付。
4. 后台管理系统完整 UI。
5. 多服务器部署。
6. Redis 缓存。

以上内容可以在用户量增长后再做。

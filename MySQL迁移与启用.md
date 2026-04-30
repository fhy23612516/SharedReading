# MySQL 迁移与启用说明

当前代码已经支持两种存储模式：

1. `STORAGE_DRIVER=json`：默认模式，继续使用 `data/store.json` 或 `STORE_PATH` 指向的 JSON 文件。
2. `STORAGE_DRIVER=mysql`：使用 MySQL 表存储用户、登录会话、房间、进度、消息、事件、记录和反馈。
3. 导入书籍功能会写入 `books` 表。
4. 大书分章导入会写入 `book_chapters` 表。
5. 书架、浏览记录、章节评论和段落评论会分别写入 `bookshelf_items`、`reading_history`、`story_comments` 表。
6. 密码找回使用 `users.password_recovery_hash` 保存恢复码哈希，不保存恢复码明文。

建议先在测试环境验证 MySQL，再切正式服务。

## 1. 安装 MySQL

Ubuntu 示例：

```bash
sudo apt update
sudo apt install -y mysql-server
sudo systemctl enable mysql
sudo systemctl start mysql
```

检查：

```bash
sudo systemctl status mysql --no-pager
```

## 2. 创建数据库和用户

进入 MySQL：

```bash
sudo mysql
```

执行：

```sql
CREATE DATABASE IF NOT EXISTS shared_reading
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'shared_reading'@'localhost'
  IDENTIFIED BY '请换成强密码';
CREATE USER IF NOT EXISTS 'shared_reading'@'127.0.0.1'
  IDENTIFIED BY '请换成强密码';

GRANT ALL PRIVILEGES ON shared_reading.* TO 'shared_reading'@'localhost';
GRANT ALL PRIVILEGES ON shared_reading.* TO 'shared_reading'@'127.0.0.1';
FLUSH PRIVILEGES;
EXIT;
```

## 3. 初始化表结构

在项目目录执行：

```bash
cd /opt/shared-reading
sudo mysql < schema/mysql.sql
```

这个脚本会创建数据库并初始化表结构。应用运行时仍使用上一步创建的 `shared_reading` 用户连接数据库。

如果你之前已经初始化过旧表结构，也可以重新执行这一句。脚本使用 `CREATE TABLE IF NOT EXISTS`，会补建新增的 `books`、`book_chapters`、`bookshelf_items`、`reading_history`、`story_comments` 表，并会给旧的 `users` 和 `books` 表补上新增字段，不会删除现有数据。

检查核心表：

```bash
sudo mysql -e "USE shared_reading; SHOW TABLES;"
```

## 4. 安装 Node 依赖

因为 MySQL 模式需要 `mysql2`：

```bash
cd /opt/shared-reading
npm install
```

## 5. 修改 PM2 配置

编辑：

```bash
nano ecosystem.config.cjs
```

把后端环境变量改成：

```js
STORAGE_DRIVER: "mysql",
DB_HOST: "127.0.0.1",
DB_PORT: "3306",
DB_USER: "shared_reading",
DB_PASSWORD: "请换成强密码",
DB_NAME: "shared_reading"
```

保存后重启：

```bash
pm2 restart shared-reading-api --update-env
pm2 restart shared-reading-web --update-env
pm2 save
```

## 6. 验证 MySQL 模式

查看后端日志：

```bash
pm2 logs shared-reading-api
```

启动时应看到：

```text
Storage: mysql
```

测试接口：

```bash
curl http://127.0.0.1:3210/api/bootstrap
curl http://127.0.0.1/api/bootstrap
```

## 7. 注意事项

1. 当前 MySQL 模式保持单进程 MVP 设计，PM2 不要把 `shared-reading-api` 开成多实例 cluster。
2. JSON 旧数据不会自动迁入 MySQL。如需迁移历史数据，需要额外写迁移脚本。
3. 如果 MySQL 模式启动失败，先把 `STORAGE_DRIVER` 改回 `json`，恢复服务后再排查日志。
4. 2 核 2G 可以跑 MySQL MVP，但建议定期备份。
5. 后续用户增长后建议迁移到阿里云 RDS MySQL。
6. 本次新增的书架、浏览记录和评论数据是账号数据，生产环境建议尽早启用 MySQL，避免长期依赖本机 JSON 文件。
7. 旧账号没有恢复码，需要登录后在账号页手动生成一次；新注册账号会自动获得恢复码。

## 8. 旧账号忘记密码

如果旧账号忘记密码且没有恢复码，可以在服务器本地用管理脚本重置。必须先停止后端 API，避免运行中的内存状态覆盖脚本写入的数据。

```bash
cd /opt/shared-reading
pm2 stop shared-reading-api
node tools/reset-password.js "账号"
pm2 start ecosystem.config.cjs --only shared-reading-api --update-env
pm2 save
```

脚本会提示输入新密码，并输出新的恢复码。恢复码只显示一次，需要立即保存。

如果确认终端历史安全，也可以直接传新密码：

```bash
node tools/reset-password.js "账号" "新密码"
```

## 9. 备份建议

导出：

```bash
mysqldump -u shared_reading -p shared_reading > shared_reading_backup.sql
```

恢复：

```bash
mysql -u shared_reading -p shared_reading < shared_reading_backup.sql
```

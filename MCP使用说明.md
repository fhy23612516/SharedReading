# MCP 使用说明

本项目内置了一个轻量 MCP 服务，方便后续修改时快速调用项目状态、文档、部署步骤、搜索和版本记录工具。

MCP 服务文件：

```text
tools/shared-reading-mcp.js
```

启动命令：

```bash
npm run mcp
```

或直接：

```bash
node tools/shared-reading-mcp.js
```

## 1. 适合做什么

这个 MCP 主要服务后续开发和部署维护：

1. 快速读取 `README.md`、`接口文档.md`、`部署文档.md`、`MySQL迁移与启用.md`、`需求文档.md`、`版本记录.md`。
2. 查询当前 Git 状态、package scripts、正式域名和关键文档。
3. 输出服务器更新命令。
4. 在项目内搜索关键词。
5. 运行 `node --check` 和 `npm test`。
6. 给 `版本记录.md` 顶部追加一条大更新记录。

## 2. 暴露的 Resources

1. `shared-reading://readme`
2. `shared-reading://versions`
3. `shared-reading://api`
4. `shared-reading://deploy`
5. `shared-reading://mysql`
6. `shared-reading://requirements`

## 3. 暴露的 Tools

### `project_status`

读取项目状态、Git 分支、最近提交、工作区状态、npm scripts 和关键文档列表。

### `deployment_steps`

输出当前服务器更新流程，包括：

1. `git pull`
2. `npm install`
3. `sudo mysql < schema/mysql.sql`
4. `pm2 restart ecosystem.config.cjs --update-env`
5. Nginx 模板复制和重载
6. HTTPS 证书命令

### `search_project`

在项目内搜索关键词，默认排除：

1. `node_modules/`
2. `.git/`
3. `.runtime/`
4. `data/store.json`

参数示例：

```json
{
  "query": "/api/books/import",
  "maxResults": 30
}
```

### `run_checks`

运行：

```bash
node --check server.js
node --check app.js
node --check tests/api-smoke.test.js
node --check ecosystem.config.cjs
npm test
```

### `append_version_record`

向 `版本记录.md` 顶部追加大更新记录。

参数示例：

```json
{
  "version": "v0.5.0",
  "title": "后台管理和反馈处理",
  "added": ["新增反馈后台列表", "支持修改反馈状态"],
  "files": ["server.js", "app.js", "版本记录.md"],
  "deploy": ["git pull 后重启 PM2"],
  "notes": ["后台权限仍需继续加强"]
}
```

## 4. 客户端配置示例

不同 MCP 客户端配置格式略有差异，核心都是注册一个 stdio server。

示例：

```json
{
  "mcpServers": {
    "shared-reading": {
      "command": "node",
      "args": [
        "E:/Program Files/VibeCoding/SharedReading/tools/shared-reading-mcp.js"
      ],
      "cwd": "E:/Program Files/VibeCoding/SharedReading"
    }
  }
}
```

如果客户端支持直接用 npm script，也可以配置：

```json
{
  "mcpServers": {
    "shared-reading": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "E:/Program Files/VibeCoding/SharedReading"
    }
  }
}
```

## 5. 注意事项

1. MCP 协议数据走 stdout，脚本不要向 stdout 打日志。
2. 运行日志和错误会写到 stderr。
3. `append_version_record` 会实际修改 `版本记录.md`。
4. `run_checks` 会执行测试，但不会自动提交代码。
5. 这个 MCP 不会自动部署服务器，只输出命令或运行本地检查。

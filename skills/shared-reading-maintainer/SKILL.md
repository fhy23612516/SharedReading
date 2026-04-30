---
name: shared-reading-maintainer
description: Maintain the SharedReading project. Use this skill whenever Codex changes SharedReading features, fixes bugs, updates deployment/configuration, changes APIs, storage/schema, UI behavior, scripts, tests, or project documentation; it requires updating version documentation and relevant docs before committing.
---

# Shared Reading Maintainer

## Core Rule

Every functional update, bug fix, deployment/config change, API change, schema/storage change, UI/UX change, script change, or test change must be recorded in project documentation before the final commit.

Do not rely on conversation memory. Rebuild context from repository files, especially `版本记录.md`, `需求文档.md`, `接口文档.md`, `部署文档.md`, `MySQL迁移与启用.md`, and `服务器配置记录与小程序迁移.md`.

## Version Workflow

1. Read the top entry in `版本记录.md`.
2. Choose the next version.
3. Add a new top entry in `版本记录.md`.
4. Mention the version number in the final response.

Version selection:

- Patch fix: increment patch, for example `v0.5.3` -> `v0.5.4`.
- Feature update: increment minor, for example `v0.5.x` -> `v0.6.0`.
- Major architecture or breaking change: increment major and mark the breaking change.

Each `版本记录.md` entry must include:

- Version and date.
- Theme.
- New abilities or fixes.
- Key files changed.
- Deployment commands.
- Remaining risks or unfinished items.

## Documentation Checklist

Update only the docs relevant to the actual change:

- `版本记录.md`: always update for every project update.
- `需求文档.md`: update for product behavior, scope, rules, or roadmap changes.
- `接口文档.md`: update for API request/response/error/auth changes.
- `schema/mysql.sql` and `MySQL迁移与启用.md`: update for MySQL table/storage changes.
- `部署文档.md` and `服务器配置记录与小程序迁移.md`: update for ports, PM2, Nginx, env vars, domain, HTTPS, deployment commands, or server migration steps.
- `README.md`: update for user-facing capability, quick start, scripts, or important usage changes.
- `MCP使用说明.md`: update only when MCP tools/configuration change.

## Implementation Checklist

Before editing:

1. Inspect current git status.
2. Read relevant source and docs instead of assuming prior conversation context is complete.
3. Preserve user changes and never revert unrelated work.

Before finalizing:

1. Run focused syntax checks for touched JavaScript files, for example `node --check app.js` or `node --check server.js`.
2. Run `npm.cmd test` on Windows when backend/API behavior, data, or tests changed.
3. Run `git diff --check`.
4. Commit with a concise message after docs and tests are complete, unless the user explicitly asks not to commit.

## Deployment Notes

For frontend-only static/UI changes:

```bash
cd /opt/shared-reading
git pull
pm2 restart shared-reading-web
```

For backend/API/schema/config changes:

```bash
cd /opt/shared-reading
git pull
npm install --no-audit --no-fund
sudo mysql < schema/mysql.sql
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

If MySQL schema did not change, state that `sudo mysql < schema/mysql.sql` is not required.

## Current Project Facts

- Local workspace: `E:\Program Files\VibeCoding\SharedReading`
- GitHub repository: `https://github.com/fhy23612516/SharedReading.git`
- Server path: `/opt/shared-reading`
- Domain: `shareread.heiheihei.pw`
- PM2 processes: `shared-reading-api`, `shared-reading-web`
- Backend: `server.js` on `127.0.0.1:3210`
- Frontend: `frontend.server.js` on `127.0.0.1:3211`
- Nginx routes `/api/` to backend and `/` to frontend

## Final Response Requirements

Include:

1. The version number recorded.
2. The commit hash if a commit was made.
3. The tests/checks run.
4. Server update commands if the user needs to deploy the change.

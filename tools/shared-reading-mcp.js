#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PROTOCOL_VERSION = "2024-11-05";

const RESOURCES = {
  "shared-reading://readme": {
    name: "README",
    path: "README.md",
    description: "项目总览、运行方式、当前能力"
  },
  "shared-reading://versions": {
    name: "版本记录",
    path: "版本记录.md",
    description: "每次大更新的变更记录"
  },
  "shared-reading://api": {
    name: "接口文档",
    path: "接口文档.md",
    description: "Web 和小程序共用 API 约束"
  },
  "shared-reading://deploy": {
    name: "部署文档",
    path: "部署文档.md",
    description: "服务器、Nginx、HTTPS、PM2 部署流程"
  },
  "shared-reading://mysql": {
    name: "MySQL 迁移与启用",
    path: "MySQL迁移与启用.md",
    description: "MySQL 安装、建库、启用和备份"
  },
  "shared-reading://requirements": {
    name: "需求文档",
    path: "需求文档.md",
    description: "产品需求和当前验收基线"
  }
};

let inputBuffer = Buffer.alloc(0);

function safePath(relativePath) {
  const fullPath = path.resolve(ROOT, relativePath);
  if (!fullPath.startsWith(ROOT + path.sep) && fullPath !== ROOT) {
    throw new Error("path_outside_project");
  }
  return fullPath;
}

function readText(relativePath) {
  return fs.readFileSync(safePath(relativePath), "utf8");
}

function writeText(relativePath, text) {
  fs.writeFileSync(safePath(relativePath), text, "utf8");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : ""
  };
}

function getGitStatus() {
  const branch = run("git", ["branch", "--show-current"]);
  const status = run("git", ["status", "--short"]);
  const lastCommit = run("git", ["log", "--oneline", "-1"]);
  return [
    `branch: ${branch.stdout.trim() || "unknown"}`,
    `lastCommit: ${lastCommit.stdout.trim() || "unknown"}`,
    "status:",
    status.stdout.trim() || "clean"
  ].join("\n");
}

function getProjectStatus() {
  const packageJson = JSON.parse(readText("package.json"));
  const scripts = Object.entries(packageJson.scripts || {})
    .map(([name, command]) => `- ${name}: ${command}`)
    .join("\n");
  return [
    "# SharedReading 项目状态",
    "",
    getGitStatus(),
    "",
    "## Scripts",
    scripts || "无",
    "",
    "## Key URLs",
    "- Local web: http://127.0.0.1:3211",
    "- Local API: http://127.0.0.1:3210",
    "- Production: https://shareread.heiheihei.pw",
    "",
    "## Key Docs",
    Object.values(RESOURCES).map((resource) => `- ${resource.path}: ${resource.description}`).join("\n")
  ].join("\n");
}

function getDeploymentSteps() {
  return [
    "# 服务器更新步骤",
    "",
    "```bash",
    "cd /opt/shared-reading",
    "git pull",
    "npm install",
    "sudo mysql < schema/mysql.sql",
    "pm2 restart ecosystem.config.cjs --update-env",
    "sudo cp deploy/nginx.shared-reading.conf /etc/nginx/sites-available/shared-reading",
    "sudo nginx -t",
    "sudo systemctl reload nginx",
    "```",
    "",
    "如果还没申请 HTTPS：",
    "",
    "```bash",
    "sudo certbot --nginx -d shareread.heiheihei.pw",
    "```"
  ].join("\n");
}

function appendVersionRecord(args) {
  const version = String(args.version || "").trim();
  const title = String(args.title || "").trim();
  if (!version || !title) {
    throw new Error("version_and_title_required");
  }

  const today = new Date().toISOString().slice(0, 10);
  const added = Array.isArray(args.added) ? args.added : [];
  const files = Array.isArray(args.files) ? args.files : [];
  const deploy = Array.isArray(args.deploy) ? args.deploy : [];
  const notes = Array.isArray(args.notes) ? args.notes : [];

  const section = [
    `## ${version} - ${today}`,
    "",
    `本次主题：${title}`,
    "",
    "新增能力：",
    "",
    ...(added.length ? added.map((item, index) => `${index + 1}. ${item}`) : ["1. 待补充。"]),
    "",
    "关键文件：",
    "",
    ...(files.length ? files.map((item, index) => `${index + 1}. \`${item}\``) : ["1. 待补充。"]),
    "",
    "部署注意：",
    "",
    ...(deploy.length ? deploy.map((item, index) => `${index + 1}. ${item}`) : ["1. 如涉及服务端变更，执行 `git pull && npm install && pm2 restart ecosystem.config.cjs --update-env`。"]),
    "",
    "未完成事项：",
    "",
    ...(notes.length ? notes.map((item, index) => `${index + 1}. ${item}`) : ["1. 待确认。"]),
    "",
    ""
  ].join("\n");

  const current = readText("版本记录.md");
  const marker = "\n## v";
  const index = current.indexOf(marker);
  const next = index >= 0
    ? `${current.slice(0, index + 1)}${section}${current.slice(index + 1)}`
    : `${current.trim()}\n\n${section}`;
  writeText("版本记录.md", next);
  return `已追加版本记录：${version} - ${title}`;
}

function searchProject(args) {
  const query = String(args.query || "").trim();
  const maxResults = Math.max(1, Math.min(100, Number(args.maxResults || 40)));
  if (!query) throw new Error("query_required");
  const result = run("rg", [
    "-n",
    "--glob", "!node_modules/**",
    "--glob", "!.git/**",
    "--glob", "!.runtime/**",
    "--glob", "!data/store.json",
    query,
    "."
  ]);
  if (result.error) return `搜索失败：${result.error}`;
  const lines = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults);
  return lines.length ? lines.join("\n") : "没有匹配结果。";
}

function runChecks() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const checks = [
    run("node", ["--check", "server.js"]),
    run("node", ["--check", "app.js"]),
    run("node", ["--check", "tests/api-smoke.test.js"]),
    run("node", ["--check", "ecosystem.config.cjs"]),
    run(npmCommand, ["test"])
  ];
  return checks.map((item) => [
    `$ ${item.command}`,
    `exit: ${item.status}`,
    item.stdout.trim(),
    item.stderr.trim(),
    item.error
  ].filter(Boolean).join("\n")).join("\n\n");
}

function listResourceDefinitions() {
  return Object.entries(RESOURCES).map(([uri, resource]) => ({
    uri,
    name: resource.name,
    description: resource.description,
    mimeType: "text/markdown"
  }));
}

function listTools() {
  return [
    {
      name: "project_status",
      description: "读取项目状态、Git 状态、脚本和关键文档列表。",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "deployment_steps",
      description: "输出当前项目服务器更新、MySQL 表补建、Nginx reload 和 HTTPS 命令。",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "search_project",
      description: "在项目内搜索关键词，默认排除 node_modules、.git、.runtime 和 data/store.json。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "number" }
        },
        required: ["query"]
      }
    },
    {
      name: "run_checks",
      description: "运行 node --check 和 npm test。",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "append_version_record",
      description: "向版本记录.md 顶部追加一条大更新记录。",
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "string", description: "例如 v0.5.0" },
          title: { type: "string" },
          added: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
          deploy: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } }
        },
        required: ["version", "title"]
      }
    }
  ];
}

function callTool(name, args = {}) {
  if (name === "project_status") return getProjectStatus();
  if (name === "deployment_steps") return getDeploymentSteps();
  if (name === "search_project") return searchProject(args);
  if (name === "run_checks") return runChecks();
  if (name === "append_version_record") return appendVersionRecord(args);
  throw new Error(`unknown_tool:${name}`);
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, error) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: error && error.message ? error.message : String(error)
    }
  });
}

function readMessages() {
  const messages = [];
  while (inputBuffer.length) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = inputBuffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (inputBuffer.length < bodyEnd) break;
      const body = inputBuffer.slice(bodyStart, bodyEnd).toString("utf8");
      inputBuffer = inputBuffer.slice(bodyEnd);
      messages.push(JSON.parse(body));
      continue;
    }

    const lineEnd = inputBuffer.indexOf("\n");
    if (lineEnd < 0) break;
    const line = inputBuffer.slice(0, lineEnd).toString("utf8").trim();
    inputBuffer = inputBuffer.slice(lineEnd + 1);
    if (line) messages.push(JSON.parse(line));
  }
  return messages;
}

function handle(message) {
  if (!message || !message.method) return;
  const { id, method, params = {} } = message;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          resources: {},
          tools: {}
        },
        serverInfo: {
          name: "shared-reading-mcp",
          version: "0.1.0"
        }
      });
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "ping") {
      if (!isNotification) respond(id, {});
      return;
    }
    if (method === "resources/list") {
      respond(id, { resources: listResourceDefinitions() });
      return;
    }
    if (method === "resources/read") {
      const uri = params.uri;
      const resource = RESOURCES[uri];
      if (!resource) throw new Error("unknown_resource");
      respond(id, {
        contents: [{
          uri,
          mimeType: "text/markdown",
          text: readText(resource.path)
        }]
      });
      return;
    }
    if (method === "tools/list") {
      respond(id, { tools: listTools() });
      return;
    }
    if (method === "tools/call") {
      const text = callTool(params.name, params.arguments || {});
      respond(id, {
        content: [{ type: "text", text }]
      });
      return;
    }
    if (!isNotification) throw new Error(`unknown_method:${method}`);
  } catch (error) {
    if (!isNotification) respondError(id, error);
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  try {
    readMessages().forEach(handle);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

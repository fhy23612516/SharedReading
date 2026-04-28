const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const port = 4100 + Math.floor(Math.random() * 800);
const storePath = path.join(os.tmpdir(), `shared-reading-smoke-${process.pid}.json`);

fs.writeFileSync(storePath, JSON.stringify({ users: {}, rooms: {}, records: [] }), "utf8");

process.env.HOST = "127.0.0.1";
process.env.PORT = String(port);
process.env.STORE_PATH = storePath;

const { startServer, stopServer } = require("../server");

function request(route, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : "";
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: route,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(raw)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        const parsed = data ? JSON.parse(data) : {};
        if (res.statusCode >= 400) {
          const error = new Error(parsed.error || `HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.payload = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });

    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return await request("/api/bootstrap");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error("server did not become ready");
}

function listen() {
  return new Promise((resolve) => {
    startServer(resolve);
  });
}

function close() {
  return new Promise((resolve) => {
    stopServer(resolve);
  });
}

async function main() {
  await listen();
  const bootstrap = await waitForServer();
  assert.ok(bootstrap.stories.length >= 1, "bootstrap should return stories");

  const alice = (await request("/api/session", "POST", { name: "Alice" })).user;
  const bob = (await request("/api/session", "POST", { name: "Bob" })).user;

  const created = await request("/api/rooms", "POST", {
    userId: alice.id,
    name: alice.name,
    storyId: bootstrap.stories[0].id,
    threshold: 8
  });
  assert.ok(created.room.code, "created room should have a code");

  const joined = await request("/api/rooms/join", "POST", {
    userId: bob.id,
    name: bob.name,
    code: created.room.code
  });
  assert.equal(joined.room.activeMembers.length, 2, "room should have two members after join");

  await request(`/api/rooms/${created.room.id}/progress`, "POST", {
    userId: alice.id,
    name: alice.name,
    progress: 31.2
  });

  const firstMessage = await request(`/api/rooms/${created.room.id}/messages`, "POST", {
    userId: alice.id,
    name: alice.name,
    clientId: "local-smoke-1",
    content: "hello"
  });
  const duplicateMessage = await request(`/api/rooms/${created.room.id}/messages`, "POST", {
    userId: alice.id,
    name: alice.name,
    clientId: "local-smoke-1",
    content: "hello"
  });
  assert.equal(firstMessage.message.id, duplicateMessage.message.id, "clientId should make message retry idempotent");

  const roomAfterMessage = (await request(`/api/rooms/${created.room.id}`)).room;
  assert.equal(roomAfterMessage.chat.length, 1, "duplicate clientId should not create duplicate chat messages");

  await request(`/api/rooms/${created.room.id}/close`, "POST", {
    userId: alice.id,
    name: alice.name
  });

  const records = (await request("/api/records")).records;
  assert.ok(records.some((item) => item.roomId === created.room.id), "closed active room should create a record");

  console.log("api smoke test passed");
}

(async () => {
  let failed = false;
  try {
    await main();
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await close().catch(() => {});
    fs.rmSync(storePath, { force: true });
  }
  if (failed) process.exit(1);
})();

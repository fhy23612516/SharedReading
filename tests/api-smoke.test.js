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

function request(route, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : "";
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: route,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(raw),
        ...headers
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

  const registered = await request("/api/auth/register", "POST", {
    account: `alice-${process.pid}`,
    password: "12345678",
    nickname: "Alice"
  });
  assert.ok(registered.token, "register should return a token");

  const login = await request("/api/auth/login", "POST", {
    account: `alice-${process.pid}`,
    password: "12345678"
  });
  assert.ok(login.token, "login should return a token");

  const authHeaders = { Authorization: `Bearer ${login.token}` };
  const me = await request("/api/auth/me", "GET", null, authHeaders);
  assert.equal(me.user.account, `alice-${process.pid}`, "me should return logged in user");

  const feedback = await request("/api/feedback", "POST", {
    type: "suggestion",
    content: "please keep the reading flow fast",
    contact: ""
  }, authHeaders);
  assert.ok(feedback.feedback.id, "feedback should be created");

  const feedbackList = await request("/api/feedback/mine", "GET", null, authHeaders);
  assert.equal(feedbackList.items.length, 1, "feedback list should include my feedback");

  const imported = await request("/api/books/import", "POST", {
    title: "Imported Smoke Book",
    author: "Smoke Test",
    tags: "test import",
    text: "第一段用于测试导入书籍功能，内容需要足够长。\n\n第二段用于确认后端可以拆分段落，并在创建房间时使用导入内容。"
  }, authHeaders);
  assert.ok(imported.book.id, "imported book should have an id");

  const bootWithBook = await request("/api/bootstrap", "GET", null, authHeaders);
  assert.ok(bootWithBook.stories.some((story) => story.id === imported.book.id), "bootstrap should include my imported book");

  const importedRoom = await request("/api/rooms", "POST", {
    storyId: imported.book.id,
    threshold: 8
  }, authHeaders);
  assert.equal(importedRoom.room.story.id, imported.book.id, "room can use imported book");

  const search = await request(`/api/search?q=${encodeURIComponent("Imported")}`, "GET", null, authHeaders);
  assert.ok(search.items.some((story) => story.id === imported.book.id), "search should find imported book");

  await request("/api/bookshelf", "POST", { storyId: imported.book.id }, authHeaders);
  const bookshelf = await request("/api/bookshelf", "GET", null, authHeaders);
  assert.ok(bookshelf.items.some((item) => item.story.id === imported.book.id), "bookshelf should include imported book");
  const searchAfterBookshelf = await request(`/api/search?q=${encodeURIComponent("Imported")}`, "GET", null, authHeaders);
  assert.ok(searchAfterBookshelf.items.some((story) => story.id === imported.book.id && story.inBookshelf), "search should mark bookshelf state");
  await request("/api/bookshelf/remove", "POST", { storyId: imported.book.id }, authHeaders);
  const bookshelfAfterRemove = await request("/api/bookshelf", "GET", null, authHeaders);
  assert.ok(!bookshelfAfterRemove.items.some((item) => item.story.id === imported.book.id), "bookshelf remove should work");

  const chapterComment = await request(`/api/stories/${imported.book.id}/comments`, "POST", {
    scope: "chapter",
    content: "chapter level comment"
  }, authHeaders);
  assert.ok(chapterComment.comment.id, "chapter comment should be created");

  const paragraphComment = await request(`/api/stories/${imported.book.id}/comments`, "POST", {
    scope: "paragraph",
    paragraphIndex: 0,
    content: "paragraph level comment"
  }, authHeaders);
  assert.equal(paragraphComment.summary.paragraphs["0"], 1, "paragraph comment summary should update");

  const comments = await request(`/api/stories/${imported.book.id}/comments?scope=paragraph&paragraphIndex=0`);
  assert.equal(comments.items.length, 1, "paragraph comments should be queryable");

  await request(`/api/rooms/${importedRoom.room.id}/progress`, "POST", {
    progress: 18.5
  }, authHeaders);
  const history = await request("/api/reading/history", "GET", null, authHeaders);
  assert.ok(history.items.some((item) => item.story.id === imported.book.id), "history should include imported book after progress");

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

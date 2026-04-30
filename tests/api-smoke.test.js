const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { resetJsonPassword } = require("../tools/reset-password");

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
  const frontendSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.ok(!frontendSource.includes("导入 `.txt`"), "import page should not contain raw backticks inside template literal text");
  assert.ok(frontendSource.includes('id="book-encoding"'), "import page should include encoding selector");
  assert.ok(frontendSource.includes("GBK / GB18030"), "import page should support common Chinese TXT encoding");
  assert.ok(frontendSource.includes("import-preview"), "import page should include local preview panel");
  assert.ok(frontendSource.includes("/api/books/import/start"), "frontend should support chaptered import");
  assert.ok(frontendSource.includes("chapter-select"), "create page should allow chapter selection");
  assert.ok(frontendSource.includes("getReaderViewportProgress"), "frontend should calculate progress from the active scroll source");
  assert.ok(frontendSource.includes('window.addEventListener("scroll", handleProgress'), "mobile page scrolling should report reading progress");
  assert.ok(frontendSource.includes("reader-mobile-tools"), "mobile reader should expose reading tools near the text");
  assert.ok(frontendSource.includes("selectionchange"), "mobile text selection should update highlight controls");
  assert.ok(frontendSource.includes("data-reader-font-family"), "reader preferences should bind desktop and mobile controls");

  const resetStorePath = path.join(os.tmpdir(), `shared-reading-reset-${process.pid}.json`);
  fs.writeFileSync(resetStorePath, JSON.stringify({
    users: {
      "user-reset": {
        id: "user-reset",
        account: "reset-user",
        nickname: "Reset User",
        passwordHash: "old-hash"
      }
    },
    authSessions: {
      "token-reset": {
        tokenHash: "token-reset",
        userId: "user-reset",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: null
      }
    }
  }), "utf8");
  const resetResult = await resetJsonPassword({ STORE_PATH: resetStorePath }, "reset-user", "resetpass123");
  const resetState = JSON.parse(fs.readFileSync(resetStorePath, "utf8"));
  assert.match(resetResult.recoveryCode, /^SR-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/, "reset script should generate a recovery code");
  assert.ok(resetState.users["user-reset"].passwordHash.startsWith("scrypt:"), "reset script should hash new password");
  assert.ok(resetState.users["user-reset"].passwordRecoveryHash, "reset script should store recovery code hash");
  assert.ok(resetState.authSessions["token-reset"].revokedAt, "reset script should revoke old sessions");
  fs.rmSync(resetStorePath, { force: true });

  await listen();
  const bootstrap = await waitForServer();
  assert.ok(bootstrap.stories.length >= 1, "bootstrap should return stories");
  assert.equal(bootstrap.stories[0].text, "", "bootstrap should not include full story text");
  assert.deepEqual(bootstrap.stories[0].body, [], "bootstrap should not include full story body");
  assert.ok(
    bootstrap.stories.some((story) => story.source === "public-domain" && story.sourceUrl && story.licenseNote),
    "bootstrap should include public domain source metadata"
  );

  const registered = await request("/api/auth/register", "POST", {
    account: `alice-${process.pid}`,
    password: "12345678",
    nickname: "Alice"
  });
  assert.ok(registered.token, "register should return a token");
  assert.ok(registered.recoveryCode, "register should return a one-time recovery code");

  const reset = await request("/api/auth/password/reset", "POST", {
    account: `alice-${process.pid}`,
    recoveryCode: registered.recoveryCode,
    password: "resetpass123"
  });
  assert.ok(reset.token, "password reset should return a token");
  assert.ok(reset.recoveryCode, "password reset should rotate and return a new recovery code");
  assert.notEqual(reset.recoveryCode, registered.recoveryCode, "password reset should invalidate the previous recovery code");

  await assert.rejects(
    request("/api/auth/password/reset", "POST", {
      account: `alice-${process.pid}`,
      recoveryCode: registered.recoveryCode,
      password: "anotherpass123"
    }),
    (error) => error.message === "invalid_recovery_code",
    "old recovery code should not be reusable"
  );

  const login = await request("/api/auth/login", "POST", {
    account: `alice-${process.pid}`,
    password: "resetpass123"
  });
  assert.ok(login.token, "login should return a token");

  const authHeaders = { Authorization: `Bearer ${login.token}` };
  const me = await request("/api/auth/me", "GET", null, authHeaders);
  assert.equal(me.user.account, `alice-${process.pid}`, "me should return logged in user");

  const rotatedRecovery = await request("/api/auth/recovery-code", "POST", null, authHeaders);
  assert.ok(rotatedRecovery.recoveryCode, "logged in user should be able to generate a new recovery code");
  assert.notEqual(rotatedRecovery.recoveryCode, reset.recoveryCode, "manual recovery code generation should rotate the code");

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
  assert.equal(imported.book.text, "", "import response should omit full text");

  const bootWithBook = await request("/api/bootstrap", "GET", null, authHeaders);
  assert.ok(bootWithBook.stories.some((story) => story.id === imported.book.id), "bootstrap should include my imported book");
  assert.ok(bootWithBook.stories.every((story) => story.text === "" && Array.isArray(story.body) && story.body.length === 0), "bootstrap story list should stay lightweight");

  const importedRoom = await request("/api/rooms", "POST", {
    storyId: imported.book.id,
    threshold: 8
  }, authHeaders);
  assert.equal(importedRoom.room.story.id, imported.book.id, "room can use imported book");
  assert.ok(importedRoom.room.story.text.length > 0, "room detail should include readable story text");

  const search = await request(`/api/search?q=${encodeURIComponent("Imported")}`, "GET", null, authHeaders);
  assert.ok(search.items.some((story) => story.id === imported.book.id), "search should find imported book");
  assert.ok(search.items.every((story) => story.text === "" && Array.isArray(story.body) && story.body.length === 0), "search results should stay lightweight");

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

  const presence = await request(`/api/rooms/${created.room.id}/presence`, "POST", {
    userId: alice.id,
    name: alice.name
  });
  assert.equal(presence.ok, true, "presence should return a lightweight heartbeat response");
  assert.equal(presence.room, undefined, "presence should not return full room/story content");

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

  const largeImportText = "测".repeat(360_000);
  const largeImport = await request("/api/books/import", "POST", {
    title: "Large Import Smoke Book",
    author: "Smoke Test",
    text: largeImportText
  }, authHeaders);
  assert.ok(largeImport.book.id, "import endpoint should accept a body larger than the default API body limit");

  const chapteredStart = await request("/api/books/import/start", "POST", {
    title: "Chaptered Smoke Book",
    author: "Smoke Test",
    tags: "chaptered import",
    summary: "chaptered import smoke test",
    totalChapters: 2
  }, authHeaders);
  assert.ok(chapteredStart.book.chaptered, "chaptered import should create a chaptered book");

  await request("/api/books/import/chapter", "POST", {
    bookId: chapteredStart.book.id,
    chapterIndex: 0,
    title: "第一章 开始",
    text: "第一章正文用于测试分章导入能力，内容需要足够长，便于后端通过最短正文校验。\n\n这里是第一章第二段。"
  }, authHeaders);
  await request("/api/books/import/chapter", "POST", {
    bookId: chapteredStart.book.id,
    chapterIndex: 1,
    title: "第二章 继续",
    text: "第二章正文用于测试按章节创建共读房间，内容同样需要足够长，确保可以作为阅读正文。\n\n这里是第二章第二段。"
  }, authHeaders);
  const chapteredFinish = await request("/api/books/import/finish", "POST", {
    bookId: chapteredStart.book.id
  }, authHeaders);
  assert.equal(chapteredFinish.book.chapterCount, 2, "chaptered import should keep chapter count");

  const chapters = await request(`/api/books/${chapteredStart.book.id}/chapters`, "GET", null, authHeaders);
  assert.equal(chapters.chapters.length, 2, "chapters endpoint should list uploaded chapters");
  assert.ok(chapters.chapters[1].storyId.includes("::chapter-1"), "chapter should expose a virtual story id");

  const chapterRoom = await request("/api/rooms", "POST", {
    storyId: chapters.chapters[1].storyId,
    threshold: 8
  }, authHeaders);
  assert.equal(chapterRoom.room.story.parentBookId, chapteredStart.book.id, "room can use a chapter story");
  assert.equal(chapterRoom.room.story.chapterIndex, 1, "room should load the selected chapter");

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

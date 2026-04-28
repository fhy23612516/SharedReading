const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { stories } = require("./data/stories");

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT_DIR = __dirname;
const STORE_PATH = process.env.STORE_PATH || path.join(ROOT_DIR, "data", "store.json");

const state = readState();
const storyMap = new Map(stories.map((story) => [story.id, story]));
const roomStreams = new Map();
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
let persistDirty = false;
let persistTimer = null;
let persistInFlight = false;

function readState() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: parsed.users || {},
      rooms: parsed.rooms || {},
      records: parsed.records || []
    };
  } catch (error) {
    return { users: {}, rooms: {}, records: [] };
  }
}

function persistState() {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(flushPersistState, 350);
  persistTimer.unref?.();
}

async function flushPersistState() {
  if (persistInFlight) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty) return;

  persistDirty = false;
  persistInFlight = true;
  const tmpPath = `${STORE_PATH}.tmp`;
  const body = JSON.stringify(state, null, 2);

  try {
    await fs.promises.writeFile(tmpPath, body, "utf8");
    await fs.promises.rename(tmpPath, STORE_PATH);
  } catch (error) {
    persistDirty = true;
    console.error("Failed to persist state:", error.message);
  } finally {
    persistInFlight = false;
    if (persistDirty && !persistTimer) {
      persistTimer = setTimeout(flushPersistState, 1000);
      persistTimer.unref?.();
    }
  }
}

function flushPersistStateSync() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty) return;
  persistDirty = false;
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function now() {
  return new Date().toISOString();
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...getCorsHeaders()
  });
  res.end(JSON.stringify(data));
}

function sendBuffer(res, status, body, contentType) {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendNotFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizeStory(story) {
  return {
    id: story.id,
    title: story.title,
    author: story.author,
    cover: story.cover,
    summary: story.summary,
    body: story.body,
    text: story.text,
    wordCount: story.wordCount
  };
}

function createRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (Object.values(state.rooms).some((room) => room.code === code));
  return code;
}

function ensureUser(input) {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  const providedName = typeof input.name === "string" ? input.name.trim().slice(0, 12) : "";

  if (!userId && !providedName) {
    return { ok: false, error: "name_required" };
  }

  let user = userId ? state.users[userId] : null;
  if (!user) {
    user = {
      id: uid("user"),
      name: providedName || "Reader",
      avatar: (providedName || "R").slice(0, 1),
      createdAt: now(),
      lastActiveAt: now()
    };
    state.users[user.id] = user;
  } else {
    if (providedName) {
      user.name = providedName;
      user.avatar = providedName.slice(0, 1);
    }
    user.lastActiveAt = now();
  }

  persistState();
  return { ok: true, user };
}

function getRoom(roomId) {
  return state.rooms[roomId] || null;
}

function getMember(room, userId) {
  return room.members.find((member) => member.userId === userId) || null;
}

function getActiveMembers(room) {
  return room.members.filter((member) => !member.leftAt);
}

function appendEvent(room, type, userId, info) {
  room.events.push({
    id: uid("event"),
    type,
    userId,
    info,
    at: now()
  });
  if (room.events.length > 200) {
    room.events = room.events.slice(-200);
  }
}

function touchMember(room, userId) {
  const member = getMember(room, userId);
  if (!member || member.leftAt) return;
  member.lastSeenAt = now();
  member.online = true;
}

function computeWaitState(room) {
  const activeMembers = getActiveMembers(room);
  if (activeMembers.length < 2) {
    return { diff: 0, fastUserId: null };
  }
  const [a, b] = activeMembers;
  const progressA = room.progress[a.userId]?.maxProgress || 0;
  const progressB = room.progress[b.userId]?.maxProgress || 0;
  const diff = Math.abs(progressA - progressB);
  const fastUserId = progressA === progressB ? null : progressA > progressB ? a.userId : b.userId;
  return { diff: Number(diff.toFixed(1)), fastUserId };
}

function refreshWaitState(room) {
  getActiveMembers(room).forEach((member) => {
    const entry = room.progress[member.userId];
    if (!entry) return;
    entry.waiting = false;
  });
}

function minutesBetween(start, end) {
  return Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));
}

function saveRecordFromRoom(room) {
  if (state.records.some((record) => record.roomId === room.id)) {
    return;
  }
  const progressEntries = Object.values(room.progress || {});
  const hasMeaningfulActivity = room.chat.length > 0
    || progressEntries.some((entry) => (entry.maxProgress || 0) > 0)
    || room.members.length > 1;
  if (!hasMeaningfulActivity) {
    return;
  }
  const members = room.members.filter((member) => room.progress[member.userId]);
  state.records.unshift({
    roomId: room.id,
    roomCode: room.code,
    title: room.storyTitle,
    at: room.endedAt || room.updatedAt,
    durationMinutes: minutesBetween(room.createdAt, room.endedAt || room.updatedAt),
    totalMessages: room.chat.length,
    waitSummary: members
      .map((member) => `${member.name} waited ${room.progress[member.userId]?.waitCount || 0} times`)
      .join(" / ")
  });
  state.records = state.records.slice(0, 20);
}

function maybeCompleteRoom(room) {
  const activeMembers = getActiveMembers(room);
  if (activeMembers.length !== 2) return;
  const allDone = activeMembers.every((member) => room.progress[member.userId]?.done);
  if (!allDone) return;
  room.status = "completed";
  room.endedAt = now();
  appendEvent(room, "room-completed", activeMembers[0].userId, "room completed");
  saveRecordFromRoom(room);
}

function normalizeRoom(room) {
  const story = storyMap.get(room.storyId);
  return {
    ...room,
    story: sanitizeStory(story),
    activeMembers: getActiveMembers(room),
    waitState: computeWaitState(room)
  };
}

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const clients = roomStreams.get(roomId);
  if (!clients || !clients.size) return;
  const payload = JSON.stringify({ type: "room", room: normalizeRoom(room), at: now() });
  clients.forEach((res) => {
    res.write("event: room\n");
    res.write(`data: ${payload}\n\n`);
  });
}

function broadcastEvent(roomId, eventName, data) {
  const clients = roomStreams.get(roomId);
  if (!clients || !clients.size) return;
  const payload = JSON.stringify({ ...data, at: now() });
  clients.forEach((res) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${payload}\n\n`);
  });
}

function addStream(roomId, res) {
  if (!roomStreams.has(roomId)) {
    roomStreams.set(roomId, new Set());
  }
  roomStreams.get(roomId).add(res);
}

function removeStream(roomId, res) {
  const clients = roomStreams.get(roomId);
  if (!clients) return;
  clients.delete(res);
  if (!clients.size) {
    roomStreams.delete(roomId);
  }
}

function markOfflineMembers() {
  let changed = false;
  Object.values(state.rooms).forEach((room) => {
    room.members.forEach((member) => {
      if (member.leftAt) return;
      const stale = Date.now() - new Date(member.lastSeenAt).getTime() > 15000;
      if (stale && member.online) {
        member.online = false;
        changed = true;
        broadcastEvent(room.id, "presence", {
          type: "presence",
          userId: member.userId,
          online: false,
          member: {
            userId: member.userId,
            name: member.name,
            avatar: member.avatar,
            joinedAt: member.joinedAt,
            lastSeenAt: member.lastSeenAt,
            online: false,
            leftAt: member.leftAt
          },
          waitState: computeWaitState(room)
        });
      }
    });
  });
  if (changed) {
    persistState();
  }
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  try {
    const body = fs.readFileSync(filePath);
    sendBuffer(res, 200, body, contentTypeMap[ext] || "application/octet-stream");
  } catch (error) {
    sendNotFound(res);
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      stories: stories.map(sanitizeStory),
      waitOptions: [5, 8, 12, 15],
      quickMessages: ["我等你", "慢慢读", "这段好看", "哈哈哈", "读到这里告诉我", "我刚看到一个重点"]
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/records") {
    sendJson(res, 200, { records: state.records });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const result = ensureUser(body);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    sendJson(res, 200, { user: result.user });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const result = ensureUser(body);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    const story = storyMap.get(body.storyId);
    const threshold = Number(body.threshold);
    if (!story) {
      sendJson(res, 400, { error: "story_not_found" });
      return true;
    }
    if (![5, 8, 12, 15].includes(threshold)) {
      sendJson(res, 400, { error: "invalid_threshold" });
      return true;
    }
    const user = result.user;
    const createdAt = now();
    const room = {
      id: uid("room"),
      code: createRoomCode(),
      storyId: story.id,
      storyTitle: story.title,
      ownerId: user.id,
      threshold,
      status: "waiting",
      createdAt,
      updatedAt: createdAt,
      endedAt: null,
      members: [
        {
          userId: user.id,
          name: user.name,
          avatar: user.avatar,
          joinedAt: createdAt,
          lastSeenAt: createdAt,
          online: true,
          leftAt: null
        }
      ],
      progress: {
        [user.id]: {
          userId: user.id,
          progress: 0,
          maxProgress: 0,
          waiting: false,
          done: false,
          waitCount: 0,
          unlockedCount: 0,
          lastUpdatedAt: createdAt
        }
      },
      chat: [],
      events: [],
      stats: {
        totalMessages: 0
      }
    };
    appendEvent(room, "room-created", user.id, `${user.name} created room`);
    state.rooms[room.id] = room;
    persistState();
    sendJson(res, 201, { user, room: normalizeRoom(room) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms/join") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const result = ensureUser(body);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    const code = String(body.code || "").trim().toUpperCase();
    const room = Object.values(state.rooms).find((item) => item.code === code);
    if (!room) {
      sendJson(res, 404, { error: "room_not_found" });
      return true;
    }
    if (room.status === "completed" || room.status === "closed") {
      sendJson(res, 409, { error: "room_ended" });
      return true;
    }
    const user = result.user;
    const existingMember = getMember(room, user.id);
    if (!existingMember && getActiveMembers(room).length >= 2) {
      sendJson(res, 409, { error: "room_full" });
      return true;
    }
    if (!existingMember) {
      room.members.push({
        userId: user.id,
        name: user.name,
        avatar: user.avatar,
        joinedAt: now(),
        lastSeenAt: now(),
        online: true,
        leftAt: null
      });
      room.progress[user.id] = {
        userId: user.id,
        progress: 0,
        maxProgress: 0,
        waiting: false,
        done: false,
        waitCount: 0,
        unlockedCount: 0,
        lastUpdatedAt: now()
      };
      appendEvent(room, "user-joined", user.id, `${user.name} joined room`);
    } else {
      existingMember.leftAt = null;
      existingMember.online = true;
      existingMember.lastSeenAt = now();
      existingMember.name = user.name;
      appendEvent(room, "user-returned", user.id, `${user.name} returned`);
    }
    if (getActiveMembers(room).length >= 2) {
      room.status = "reading";
    }
    room.updatedAt = now();
    persistState();
    broadcastRoom(room.id);
    sendJson(res, 200, { user, room: normalizeRoom(room) });
    return true;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(presence|progress|messages|complete|leave|events|close))?$/);
  if (!roomMatch) {
    return false;
  }

  const roomId = roomMatch[1];
  const action = roomMatch[2] || "detail";
  const room = getRoom(roomId);
  if (!room) {
    sendJson(res, 404, { error: "room_not_found" });
    return true;
  }

  if (req.method === "GET" && action === "detail") {
    sendJson(res, 200, { room: normalizeRoom(room) });
    return true;
  }

  if (req.method === "GET" && action === "events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...getCorsHeaders()
    });
    res.write("event: room\n");
    res.write(`data: ${JSON.stringify({ type: "room", room: normalizeRoom(room), at: now() })}\n\n`);
    addStream(roomId, res);
    const ping = setInterval(() => {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, 15000);
    req.on("close", () => {
      clearInterval(ping);
      removeStream(roomId, res);
    });
    return true;
  }

  const body = await parseBody(req).catch((error) => ({ __error: error.message }));
  if (body.__error) {
    sendJson(res, 400, { error: body.__error });
    return true;
  }
  const userResult = ensureUser(body);
  if (!userResult.ok) {
    sendJson(res, 400, { error: userResult.error });
    return true;
  }
  const user = userResult.user;
  const member = getMember(room, user.id);
  if (!member) {
    sendJson(res, 403, { error: "not_room_member" });
    return true;
  }
  touchMember(room, user.id);

  if (req.method === "POST" && action === "presence") {
    member.lastSeenAt = now();
    member.online = true;
    persistState();
    sendJson(res, 200, { room: normalizeRoom(room) });
    return true;
  }

  if (req.method === "POST" && action === "progress") {
    const entry = room.progress[user.id];
    const requested = Number(body.progress);
    if (!Number.isFinite(requested)) {
      sendJson(res, 400, { error: "invalid_progress" });
      return true;
    }
    const next = Math.max(0, Math.min(100, Number(requested.toFixed(1))));
    const previousMax = entry.maxProgress;
    entry.progress = next;
    entry.maxProgress = Math.max(entry.maxProgress, next);
    entry.done = entry.maxProgress >= 100;
    entry.lastUpdatedAt = now();
    if (entry.maxProgress >= previousMax + 2 || (entry.maxProgress === 100 && previousMax < 100)) {
      appendEvent(room, "progress", user.id, `${entry.maxProgress.toFixed(1)}%`);
    }
    refreshWaitState(room);
    maybeCompleteRoom(room);
    room.updatedAt = now();
    const waitState = computeWaitState(room);
    persistState();
    if (room.status === "completed") {
      broadcastRoom(room.id);
      sendJson(res, 200, { room: normalizeRoom(room) });
    } else {
      broadcastEvent(room.id, "progress", {
        type: "progress",
        userId: user.id,
        progress: entry,
        waitState,
        updatedAt: room.updatedAt
      });
      sendJson(res, 200, {
        userId: user.id,
        progress: entry,
        waitState,
        updatedAt: room.updatedAt
      });
    }
    return true;
  }

  if (req.method === "POST" && action === "messages") {
    const content = String(body.content || "").trim();
    if (!content) {
      sendJson(res, 400, { error: "empty_message" });
      return true;
    }
    if (content.length > 200) {
      sendJson(res, 400, { error: "message_too_long" });
      return true;
    }
    const clientId = String(body.clientId || "").trim().slice(0, 80);
    if (clientId) {
      const existing = room.chat.find((item) => item.userId === user.id && item.clientId === clientId);
      if (existing) {
        sendJson(res, 200, {
          message: existing,
          totalMessages: room.stats.totalMessages || room.chat.length,
          updatedAt: room.updatedAt,
          event: null
        });
        return true;
      }
    }
    const message = {
      id: uid("msg"),
      clientId: clientId || undefined,
      userId: user.id,
      userName: user.name,
      content,
      createdAt: now()
    };
    room.chat.push(message);
    room.chat = room.chat.slice(-200);
    appendEvent(room, "message", user.id, content.slice(0, 60));
    room.stats.totalMessages = room.chat.length;
    room.updatedAt = now();
    persistState();
    broadcastEvent(room.id, "message", {
      type: "message",
      message,
      totalMessages: room.stats.totalMessages,
      updatedAt: room.updatedAt,
      event: room.events[room.events.length - 1] || null
    });
    sendJson(res, 201, {
      message,
      totalMessages: room.stats.totalMessages,
      updatedAt: room.updatedAt,
      event: room.events[room.events.length - 1] || null
    });
    return true;
  }

  if (req.method === "POST" && action === "complete") {
    const entry = room.progress[user.id];
    entry.progress = 100;
    entry.maxProgress = 100;
    entry.done = true;
    entry.lastUpdatedAt = now();
    refreshWaitState(room);
    maybeCompleteRoom(room);
    room.updatedAt = now();
    persistState();
    broadcastRoom(room.id);
    sendJson(res, 200, { room: normalizeRoom(room) });
    return true;
  }

if (req.method === "POST" && action === "leave") {
    member.online = false;
    member.lastSeenAt = now();
    appendEvent(room, "user-offline", user.id, `${member.name} went offline`);
    room.updatedAt = now();
    persistState();
    broadcastEvent(room.id, "presence", {
      type: "presence",
      userId: user.id,
      online: false,
      member,
      waitState: computeWaitState(room),
      updatedAt: room.updatedAt,
      event: room.events[room.events.length - 1] || null
    });
    sendJson(res, 200, { room: normalizeRoom(room) });
    return true;
  }

  if (req.method === "POST" && action === "close") {
    if (room.ownerId !== user.id) {
      sendJson(res, 403, { error: "not_room_owner" });
      return true;
    }
    if (room.status === "completed" || room.status === "closed") {
      sendJson(res, 409, { error: "room_ended" });
      return true;
    }
    room.status = "closed";
    room.endedAt = now();
    room.updatedAt = room.endedAt;
    room.members.forEach((item) => {
      item.online = false;
      item.lastSeenAt = room.endedAt;
    });
    appendEvent(room, "room-closed", user.id, `${user.name} closed room`);
    saveRecordFromRoom(room);
    persistState();
    broadcastRoom(room.id);
    sendJson(res, 200, { room: normalizeRoom(room) });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, getCorsHeaders());
        res.end();
        return;
      }
      const handled = await handleApi(req, res, url);
      if (!handled) {
        sendNotFound(res);
      }
      return;
    }
    sendNotFound(res);
  } catch (error) {
    sendJson(res, 500, { error: "server_error", detail: error.message });
  }
});

let offlineTimer = null;

function startServer(callback) {
  if (!offlineTimer) {
    offlineTimer = setInterval(markOfflineMembers, 5000);
    offlineTimer.unref?.();
  }
  return server.listen(PORT, HOST, () => {
    console.log(`SharedReading server running on ${HOST}:${PORT}`);
    console.log(`Local:   http://127.0.0.1:${PORT}`);
    console.log(`Network: http://<your-ip>:${PORT}`);
    callback?.();
  });
}

function stopServer(callback) {
  if (offlineTimer) {
    clearInterval(offlineTimer);
    offlineTimer = null;
  }
  flushPersistStateSync();
  server.close(callback);
}

if (require.main === module) {
  startServer();

  process.on("SIGINT", () => {
    flushPersistStateSync();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    flushPersistStateSync();
    process.exit(0);
  });

  process.on("exit", () => {
    flushPersistStateSync();
  });
}

module.exports = {
  server,
  startServer,
  stopServer
};

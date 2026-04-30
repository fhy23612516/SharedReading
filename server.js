const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { stories } = require("./data/stories");

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT_DIR = __dirname;
const STORE_PATH = process.env.STORE_PATH || path.join(ROOT_DIR, "data", "store.json");
const STORAGE_DRIVER = String(process.env.STORAGE_DRIVER || "json").toLowerCase();
const AUTH_TOKEN_TTL_DAYS = Number(process.env.AUTH_TOKEN_TTL_DAYS || 30);
const DEFAULT_BODY_LIMIT = 1_000_000;
const BOOK_IMPORT_BODY_LIMIT = 2_500_000;
const BOOK_IMPORT_TEXT_LIMIT = 500_000;
const BOOK_IMPORT_MIN_WORDS = 30;
const BOOK_CHAPTER_BODY_LIMIT = 1_500_000;
const BOOK_CHAPTER_TEXT_LIMIT = 120_000;
const BOOK_CHAPTER_MAX_COUNT = 1000;

let state = STORAGE_DRIVER === "mysql" ? emptyState() : readState();
const builtInStoryMap = new Map(stories.map((story) => [story.id, story]));
const roomStreams = new Map();
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
let persistDirty = false;
let persistTimer = null;
let persistInFlight = false;
let mysqlPool = null;
let storageReady = false;

function emptyState() {
  return {
    users: {},
    rooms: {},
    records: [],
    authSessions: {},
    feedback: [],
    books: [],
    bookChapters: [],
    comments: [],
    bookshelf: [],
    readingHistory: []
  };
}

function readState() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: parsed.users || {},
      rooms: parsed.rooms || {},
      records: parsed.records || [],
      authSessions: parsed.authSessions || {},
      feedback: parsed.feedback || [],
      books: Array.isArray(parsed.books) ? parsed.books : [],
      bookChapters: Array.isArray(parsed.bookChapters) ? parsed.bookChapters : [],
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      bookshelf: Array.isArray(parsed.bookshelf) ? parsed.bookshelf : [],
      readingHistory: Array.isArray(parsed.readingHistory) ? parsed.readingHistory : []
    };
  } catch (error) {
    return emptyState();
  }
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toMysqlDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function isMysqlEnabled() {
  return STORAGE_DRIVER === "mysql";
}

function getMysqlConfig() {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "shared_reading",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "shared_reading",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    namedPlaceholders: true,
    timezone: "Z"
  };
}

function requireMysql() {
  try {
    return require("mysql2/promise");
  } catch (error) {
    throw new Error("mysql2 is required when STORAGE_DRIVER=mysql. Run npm install first.");
  }
}

async function getMysqlPool() {
  if (!mysqlPool) {
    const mysql = requireMysql();
    mysqlPool = mysql.createPool(getMysqlConfig());
  }
  return mysqlPool;
}

async function initializeStorage() {
  if (storageReady) return;
  if (isMysqlEnabled()) {
    await ensureMysqlSchema();
    state = await readMysqlState();
  }
  storageReady = true;
}

async function ensureMysqlSchema() {
  const pool = await getMysqlPool();
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(40) PRIMARY KEY,
      account VARCHAR(80) UNIQUE,
      nickname VARCHAR(40) NOT NULL,
      avatar VARCHAR(16),
      password_hash VARCHAR(255),
      password_recovery_hash VARCHAR(128),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      last_active_at DATETIME,
      INDEX idx_users_account (account)
    )`,
    `CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash VARCHAR(128) PRIMARY KEY,
      user_id VARCHAR(40) NOT NULL,
      created_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      INDEX idx_auth_sessions_user_id (user_id),
      INDEX idx_auth_sessions_expires_at (expires_at)
    )`,
    `CREATE TABLE IF NOT EXISTS books (
      id VARCHAR(40) PRIMARY KEY,
      owner_id VARCHAR(40),
      title VARCHAR(120) NOT NULL,
      author VARCHAR(80),
      cover VARCHAR(30),
      summary TEXT,
      body_json JSON NOT NULL,
      text_content MEDIUMTEXT NOT NULL,
      word_count INT NOT NULL,
      tags_json JSON NULL,
      chaptered TINYINT(1) NOT NULL DEFAULT 0,
      chapter_count INT NOT NULL DEFAULT 0,
      import_status VARCHAR(20) NOT NULL DEFAULT 'done',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_books_owner_created (owner_id, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS book_chapters (
      id VARCHAR(40) PRIMARY KEY,
      book_id VARCHAR(40) NOT NULL,
      chapter_index INT NOT NULL,
      title VARCHAR(160) NOT NULL,
      content MEDIUMTEXT NOT NULL,
      body_json JSON NOT NULL,
      word_count INT NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY uniq_book_chapter_index (book_id, chapter_index),
      INDEX idx_book_chapters_book_index (book_id, chapter_index)
    )`,
    `CREATE TABLE IF NOT EXISTS story_comments (
      id VARCHAR(40) PRIMARY KEY,
      story_id VARCHAR(40) NOT NULL,
      scope VARCHAR(20) NOT NULL,
      paragraph_index INT NULL,
      user_id VARCHAR(40) NOT NULL,
      user_name VARCHAR(40) NOT NULL,
      content VARCHAR(500) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_story_comments_story_scope (story_id, scope, paragraph_index, created_at),
      INDEX idx_story_comments_user_created (user_id, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS bookshelf_items (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(40) NOT NULL,
      story_id VARCHAR(40) NOT NULL,
      added_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY uniq_bookshelf_user_story (user_id, story_id),
      INDEX idx_bookshelf_user_updated (user_id, updated_at)
    )`,
    `CREATE TABLE IF NOT EXISTS reading_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(40) NOT NULL,
      story_id VARCHAR(40) NOT NULL,
      room_id VARCHAR(40),
      progress DECIMAL(5,1) NOT NULL DEFAULT 0,
      last_read_at DATETIME NOT NULL,
      UNIQUE KEY uniq_history_user_story (user_id, story_id),
      INDEX idx_history_user_last_read (user_id, last_read_at)
    )`,
    `CREATE TABLE IF NOT EXISTS rooms (
      id VARCHAR(40) PRIMARY KEY,
      code VARCHAR(12) NOT NULL UNIQUE,
      story_id VARCHAR(40) NOT NULL,
      story_title VARCHAR(120) NOT NULL,
      owner_id VARCHAR(40) NOT NULL,
      threshold_value INT NOT NULL,
      status VARCHAR(20) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      ended_at DATETIME NULL,
      INDEX idx_rooms_code (code),
      INDEX idx_rooms_owner_id (owner_id),
      INDEX idx_rooms_status (status)
    )`,
    `CREATE TABLE IF NOT EXISTS room_members (
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
    )`,
    `CREATE TABLE IF NOT EXISTS reading_progress (
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
    )`,
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id VARCHAR(40) PRIMARY KEY,
      client_id VARCHAR(100),
      room_id VARCHAR(40) NOT NULL,
      user_id VARCHAR(40) NOT NULL,
      user_name VARCHAR(40) NOT NULL,
      content VARCHAR(500) NOT NULL,
      created_at DATETIME NOT NULL,
      UNIQUE KEY uniq_message_client (room_id, user_id, client_id),
      INDEX idx_chat_messages_room_created (room_id, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS room_events (
      id VARCHAR(40) PRIMARY KEY,
      room_id VARCHAR(40) NOT NULL,
      type VARCHAR(40) NOT NULL,
      user_id VARCHAR(40),
      info VARCHAR(500),
      created_at DATETIME NOT NULL,
      INDEX idx_room_events_room_created (room_id, created_at),
      INDEX idx_room_events_type (type)
    )`,
    `CREATE TABLE IF NOT EXISTS reading_records (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      room_id VARCHAR(40) NOT NULL UNIQUE,
      room_code VARCHAR(12) NOT NULL,
      title VARCHAR(120) NOT NULL,
      ended_at DATETIME NOT NULL,
      duration_minutes INT NOT NULL,
      total_messages INT NOT NULL,
      wait_summary VARCHAR(500),
      members_json JSON NULL,
      created_at DATETIME NOT NULL,
      INDEX idx_reading_records_created (created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS feedback (
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
    )`
  ];

  for (const statement of statements) {
    await pool.query(statement);
  }
  await ensureMysqlColumn(
    pool,
    "users",
    "password_recovery_hash",
    "ALTER TABLE users ADD COLUMN password_recovery_hash VARCHAR(128) NULL AFTER password_hash"
  );
  await ensureMysqlColumn(
    pool,
    "books",
    "chaptered",
    "ALTER TABLE books ADD COLUMN chaptered TINYINT(1) NOT NULL DEFAULT 0 AFTER tags_json"
  );
  await ensureMysqlColumn(
    pool,
    "books",
    "chapter_count",
    "ALTER TABLE books ADD COLUMN chapter_count INT NOT NULL DEFAULT 0 AFTER chaptered"
  );
  await ensureMysqlColumn(
    pool,
    "books",
    "import_status",
    "ALTER TABLE books ADD COLUMN import_status VARCHAR(20) NOT NULL DEFAULT 'done' AFTER chapter_count"
  );
}

async function ensureMysqlColumn(pool, tableName, columnName, alterSql) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  if (!Number(rows[0]?.count || 0)) {
    await pool.query(alterSql);
  }
}

async function readMysqlState() {
  const pool = await getMysqlPool();
  const [
    [userRows],
    [sessionRows],
    [bookRows],
    [roomRows],
    [memberRows],
    [progressRows],
    [messageRows],
    [eventRows],
    [recordRows],
    [feedbackRows],
    [commentRows],
    [bookshelfRows],
    [historyRows],
    [chapterRows]
  ] = await Promise.all([
    pool.query("SELECT * FROM users"),
    pool.query("SELECT * FROM auth_sessions"),
    pool.query("SELECT * FROM books ORDER BY created_at DESC"),
    pool.query("SELECT * FROM rooms"),
    pool.query("SELECT * FROM room_members ORDER BY joined_at ASC"),
    pool.query("SELECT * FROM reading_progress"),
    pool.query("SELECT * FROM chat_messages ORDER BY created_at ASC"),
    pool.query("SELECT * FROM room_events ORDER BY created_at ASC"),
    pool.query("SELECT * FROM reading_records ORDER BY created_at DESC LIMIT 50"),
    pool.query("SELECT * FROM feedback ORDER BY created_at DESC"),
    pool.query("SELECT * FROM story_comments ORDER BY created_at ASC"),
    pool.query("SELECT * FROM bookshelf_items ORDER BY updated_at DESC"),
    pool.query("SELECT * FROM reading_history ORDER BY last_read_at DESC"),
    pool.query("SELECT * FROM book_chapters ORDER BY book_id ASC, chapter_index ASC")
  ]);

  const next = emptyState();

  userRows.forEach((row) => {
    next.users[row.id] = {
      id: row.id,
      account: row.account || undefined,
      name: row.nickname,
      nickname: row.nickname,
      avatar: row.avatar || (row.nickname || "R").slice(0, 1),
      passwordHash: row.password_hash || undefined,
      passwordRecoveryHash: row.password_recovery_hash || undefined,
      createdAt: toIso(row.created_at) || now(),
      updatedAt: toIso(row.updated_at) || now(),
      lastActiveAt: toIso(row.last_active_at) || toIso(row.updated_at) || now()
    };
  });

  sessionRows.forEach((row) => {
    next.authSessions[row.token_hash] = {
      tokenHash: row.token_hash,
      userId: row.user_id,
      createdAt: toIso(row.created_at) || now(),
      expiresAt: toIso(row.expires_at) || now(),
      revokedAt: toIso(row.revoked_at)
    };
  });

  next.books = bookRows.map((row) => {
    let body = [];
    let tags = [];
    try {
      body = Array.isArray(row.body_json) ? row.body_json : JSON.parse(row.body_json || "[]");
    } catch {
      body = [];
    }
    try {
      tags = Array.isArray(row.tags_json) ? row.tags_json : JSON.parse(row.tags_json || "[]");
    } catch {
      tags = [];
    }
    const text = row.text_content || body.join("\n\n");
    return {
      id: row.id,
      ownerId: row.owner_id || null,
      title: row.title,
      author: row.author || "用户导入",
      cover: row.cover || "导入书籍",
      summary: row.summary || text.slice(0, 80),
      body,
      text,
      wordCount: Number(row.word_count || text.replace(/\s+/g, "").length),
      tags,
      chaptered: Boolean(row.chaptered),
      chapterCount: Number(row.chapter_count || 0),
      importStatus: row.import_status || "done",
      source: "imported",
      createdAt: toIso(row.created_at) || now(),
      updatedAt: toIso(row.updated_at) || now()
    };
  });

  next.bookChapters = chapterRows.map((row) => {
    let body = [];
    try {
      body = Array.isArray(row.body_json) ? row.body_json : JSON.parse(row.body_json || "[]");
    } catch {
      body = [];
    }
    const text = row.content || body.join("\n\n");
    return {
      id: row.id,
      bookId: row.book_id,
      chapterIndex: Number(row.chapter_index),
      title: row.title || `第 ${Number(row.chapter_index) + 1} 章`,
      body,
      text,
      wordCount: Number(row.word_count || text.replace(/\s+/g, "").length),
      createdAt: toIso(row.created_at) || now(),
      updatedAt: toIso(row.updated_at) || now()
    };
  });

  roomRows.forEach((row) => {
    next.rooms[row.id] = {
      id: row.id,
      code: row.code,
      storyId: row.story_id,
      storyTitle: row.story_title,
      ownerId: row.owner_id,
      threshold: Number(row.threshold_value),
      status: row.status,
      createdAt: toIso(row.created_at) || now(),
      updatedAt: toIso(row.updated_at) || now(),
      endedAt: toIso(row.ended_at),
      members: [],
      progress: {},
      chat: [],
      events: [],
      stats: { totalMessages: 0 }
    };
  });

  memberRows.forEach((row) => {
    const room = next.rooms[row.room_id];
    if (!room) return;
    room.members.push({
      userId: row.user_id,
      name: row.nickname,
      avatar: row.avatar || (row.nickname || "R").slice(0, 1),
      joinedAt: toIso(row.joined_at) || now(),
      lastSeenAt: toIso(row.last_seen_at) || now(),
      online: Boolean(row.online),
      leftAt: toIso(row.left_at)
    });
  });

  progressRows.forEach((row) => {
    const room = next.rooms[row.room_id];
    if (!room) return;
    room.progress[row.user_id] = {
      userId: row.user_id,
      progress: Number(row.progress || 0),
      maxProgress: Number(row.max_progress || 0),
      waiting: false,
      done: Boolean(row.done),
      waitCount: Number(row.wait_count || 0),
      unlockedCount: Number(row.unlocked_count || 0),
      lastUpdatedAt: toIso(row.last_updated_at) || now()
    };
  });

  messageRows.forEach((row) => {
    const room = next.rooms[row.room_id];
    if (!room) return;
    room.chat.push({
      id: row.id,
      clientId: row.client_id || undefined,
      userId: row.user_id,
      userName: row.user_name,
      content: row.content,
      createdAt: toIso(row.created_at) || now()
    });
    room.stats.totalMessages = room.chat.length;
  });

  eventRows.forEach((row) => {
    const room = next.rooms[row.room_id];
    if (!room) return;
    room.events.push({
      id: row.id,
      type: row.type,
      userId: row.user_id || null,
      info: row.info || "",
      at: toIso(row.created_at) || now()
    });
  });

  next.records = recordRows.map((row) => ({
    roomId: row.room_id,
    roomCode: row.room_code,
    title: row.title,
    at: toIso(row.ended_at) || now(),
    durationMinutes: Number(row.duration_minutes || 1),
    totalMessages: Number(row.total_messages || 0),
    waitSummary: row.wait_summary || "",
    members: typeof row.members_json === "string" ? JSON.parse(row.members_json || "[]") : row.members_json || []
  }));

  next.feedback = feedbackRows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    type: row.type,
    content: row.content,
    contact: row.contact || "",
    status: row.status,
    createdAt: toIso(row.created_at) || now(),
    updatedAt: toIso(row.updated_at) || now()
  }));

  next.comments = commentRows.map((row) => ({
    id: row.id,
    storyId: row.story_id,
    scope: row.scope,
    paragraphIndex: row.paragraph_index == null ? null : Number(row.paragraph_index),
    userId: row.user_id,
    userName: row.user_name,
    content: row.content,
    createdAt: toIso(row.created_at) || now(),
    updatedAt: toIso(row.updated_at) || now()
  }));

  next.bookshelf = bookshelfRows.map((row) => ({
    userId: row.user_id,
    storyId: row.story_id,
    addedAt: toIso(row.added_at) || now(),
    updatedAt: toIso(row.updated_at) || now()
  }));

  next.readingHistory = historyRows.map((row) => ({
    userId: row.user_id,
    storyId: row.story_id,
    roomId: row.room_id || null,
    progress: Number(row.progress || 0),
    lastReadAt: toIso(row.last_read_at) || now()
  }));

  return next;
}

async function saveMysqlState() {
  const pool = await getMysqlPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("DELETE FROM room_events");
    await connection.query("DELETE FROM chat_messages");
    await connection.query("DELETE FROM reading_progress");
    await connection.query("DELETE FROM room_members");
    await connection.query("DELETE FROM reading_records");
    await connection.query("DELETE FROM feedback");
    await connection.query("DELETE FROM story_comments");
    await connection.query("DELETE FROM bookshelf_items");
    await connection.query("DELETE FROM reading_history");
    await connection.query("DELETE FROM auth_sessions");
    await connection.query("DELETE FROM book_chapters");
    await connection.query("DELETE FROM books");
    await connection.query("DELETE FROM rooms");
    await connection.query("DELETE FROM users");

    for (const user of Object.values(state.users)) {
      await connection.query(
        `INSERT INTO users
          (id, account, nickname, avatar, password_hash, password_recovery_hash, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.account || null,
          user.nickname || user.name || "Reader",
          user.avatar || (user.nickname || user.name || "R").slice(0, 1),
          user.passwordHash || null,
          user.passwordRecoveryHash || null,
          toMysqlDate(user.createdAt) || toMysqlDate(now()),
          toMysqlDate(user.updatedAt || user.lastActiveAt || now()) || toMysqlDate(now()),
          toMysqlDate(user.lastActiveAt) || null
        ]
      );
    }

    for (const session of Object.values(state.authSessions || {})) {
      await connection.query(
        `INSERT INTO auth_sessions
          (token_hash, user_id, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          session.tokenHash,
          session.userId,
          toMysqlDate(session.createdAt) || toMysqlDate(now()),
          toMysqlDate(session.expiresAt) || toMysqlDate(now()),
          toMysqlDate(session.revokedAt)
        ]
      );
    }

    for (const book of state.books || []) {
      const body = Array.isArray(book.body) ? book.body : normalizeBookText(book.text || "").body;
      const text = book.text || body.join("\n\n");
      await connection.query(
        `INSERT INTO books
          (id, owner_id, title, author, cover, summary, body_json, text_content, word_count, tags_json, chaptered, chapter_count, import_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          book.id,
          book.ownerId || null,
          book.title,
          book.author || "用户导入",
          book.cover || "导入书籍",
          book.summary || text.slice(0, 80),
          JSON.stringify(body),
          text,
          Number(book.wordCount || text.replace(/\s+/g, "").length),
          JSON.stringify(book.tags || []),
          book.chaptered ? 1 : 0,
          Number(book.chapterCount || 0),
          book.importStatus || "done",
          toMysqlDate(book.createdAt) || toMysqlDate(now()),
          toMysqlDate(book.updatedAt) || toMysqlDate(now())
        ]
      );
    }

    for (const chapter of state.bookChapters || []) {
      const body = Array.isArray(chapter.body) ? chapter.body : normalizeBookText(chapter.text || "").body;
      const text = chapter.text || body.join("\n\n");
      await connection.query(
        `INSERT INTO book_chapters
          (id, book_id, chapter_index, title, content, body_json, word_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chapter.id,
          chapter.bookId,
          Number(chapter.chapterIndex),
          chapter.title || `第 ${Number(chapter.chapterIndex) + 1} 章`,
          text,
          JSON.stringify(body),
          Number(chapter.wordCount || text.replace(/\s+/g, "").length),
          toMysqlDate(chapter.createdAt) || toMysqlDate(now()),
          toMysqlDate(chapter.updatedAt) || toMysqlDate(now())
        ]
      );
    }

    for (const item of state.comments || []) {
      await connection.query(
        `INSERT INTO story_comments
          (id, story_id, scope, paragraph_index, user_id, user_name, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.storyId,
          item.scope,
          item.paragraphIndex == null ? null : Number(item.paragraphIndex),
          item.userId,
          item.userName,
          item.content,
          toMysqlDate(item.createdAt) || toMysqlDate(now()),
          toMysqlDate(item.updatedAt) || toMysqlDate(now())
        ]
      );
    }

    for (const item of state.bookshelf || []) {
      await connection.query(
        `INSERT INTO bookshelf_items
          (user_id, story_id, added_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        [
          item.userId,
          item.storyId,
          toMysqlDate(item.addedAt) || toMysqlDate(now()),
          toMysqlDate(item.updatedAt) || toMysqlDate(now())
        ]
      );
    }

    for (const item of state.readingHistory || []) {
      await connection.query(
        `INSERT INTO reading_history
          (user_id, story_id, room_id, progress, last_read_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          item.userId,
          item.storyId,
          item.roomId || null,
          Number(item.progress || 0),
          toMysqlDate(item.lastReadAt) || toMysqlDate(now())
        ]
      );
    }

    for (const room of Object.values(state.rooms)) {
      await connection.query(
        `INSERT INTO rooms
          (id, code, story_id, story_title, owner_id, threshold_value, status, created_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          room.id,
          room.code,
          room.storyId,
          room.storyTitle,
          room.ownerId,
          room.threshold,
          room.status,
          toMysqlDate(room.createdAt) || toMysqlDate(now()),
          toMysqlDate(room.updatedAt) || toMysqlDate(now()),
          toMysqlDate(room.endedAt)
        ]
      );

      for (const member of room.members || []) {
        await connection.query(
          `INSERT INTO room_members
            (room_id, user_id, nickname, avatar, joined_at, last_seen_at, online, left_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            room.id,
            member.userId,
            member.name,
            member.avatar || (member.name || "R").slice(0, 1),
            toMysqlDate(member.joinedAt) || toMysqlDate(now()),
            toMysqlDate(member.lastSeenAt) || toMysqlDate(now()),
            member.online ? 1 : 0,
            toMysqlDate(member.leftAt)
          ]
        );
      }

      for (const entry of Object.values(room.progress || {})) {
        await connection.query(
          `INSERT INTO reading_progress
            (room_id, user_id, progress, max_progress, done, wait_count, unlocked_count, last_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            room.id,
            entry.userId,
            Number(entry.progress || 0),
            Number(entry.maxProgress || 0),
            entry.done ? 1 : 0,
            Number(entry.waitCount || 0),
            Number(entry.unlockedCount || 0),
            toMysqlDate(entry.lastUpdatedAt) || toMysqlDate(now())
          ]
        );
      }

      for (const message of room.chat || []) {
        await connection.query(
          `INSERT INTO chat_messages
            (id, client_id, room_id, user_id, user_name, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            message.id,
            message.clientId || null,
            room.id,
            message.userId,
            message.userName,
            message.content,
            toMysqlDate(message.createdAt) || toMysqlDate(now())
          ]
        );
      }

      for (const event of room.events || []) {
        await connection.query(
          `INSERT INTO room_events
            (id, room_id, type, user_id, info, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            event.id,
            room.id,
            event.type,
            event.userId || null,
            event.info || "",
            toMysqlDate(event.at) || toMysqlDate(now())
          ]
        );
      }
    }

    for (const record of state.records || []) {
      await connection.query(
        `INSERT INTO reading_records
          (room_id, room_code, title, ended_at, duration_minutes, total_messages, wait_summary, members_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.roomId,
          record.roomCode,
          record.title,
          toMysqlDate(record.at) || toMysqlDate(now()),
          Number(record.durationMinutes || 1),
          Number(record.totalMessages || 0),
          record.waitSummary || "",
          JSON.stringify(record.members || []),
          toMysqlDate(record.at) || toMysqlDate(now())
        ]
      );
    }

    for (const item of state.feedback || []) {
      await connection.query(
        `INSERT INTO feedback
          (id, user_id, type, content, contact, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.userId,
          item.type,
          item.content,
          item.contact || null,
          item.status || "open",
          toMysqlDate(item.createdAt) || toMysqlDate(now()),
          toMysqlDate(item.updatedAt) || toMysqlDate(now())
        ]
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
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

  try {
    if (isMysqlEnabled()) {
      await saveMysqlState();
    } else {
      const tmpPath = `${STORE_PATH}.tmp`;
      const body = JSON.stringify(state, null, 2);
      await fs.promises.writeFile(tmpPath, body, "utf8");
      await fs.promises.rename(tmpPath, STORE_PATH);
    }
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
  if (isMysqlEnabled()) {
    // MySQL persistence is async-only; pending changes are flushed during normal timers.
    return;
  }
  persistDirty = false;
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function flushPersistStateBeforeClose() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  if (persistDirty) {
    await flushPersistState();
  }

  const deadline = Date.now() + 5000;
  while (persistInFlight && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (persistDirty && !persistInFlight) {
    await flushPersistState();
  }
}

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function now() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateRecoveryCode() {
  const raw = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `SR-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function normalizeRecoveryCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashRecoveryCode(code) {
  return hashToken(normalizeRecoveryCode(code));
}

function verifyRecoveryCode(code, recoveryHash) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized || normalized.length < 10 || !recoveryHash) return false;
  const actual = Buffer.from(hashRecoveryCode(normalized), "hex");
  const expected = Buffer.from(recoveryHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash || !passwordHash.startsWith("scrypt:")) return false;
  const [, salt, expected] = passwordHash.split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function normalizeAccount(account) {
  return String(account || "").trim().toLowerCase();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    account: user.account || null,
    name: user.nickname || user.name,
    nickname: user.nickname || user.name,
    avatar: user.avatar,
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt
  };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const createdAt = now();
  const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_DAYS * 86400000).toISOString();
  state.authSessions[tokenHash] = {
    tokenHash,
    userId,
    createdAt,
    expiresAt,
    revokedAt: null
  };
  persistState();
  return token;
}

function issueRecoveryCode(user) {
  const recoveryCode = generateRecoveryCode();
  user.passwordRecoveryHash = hashRecoveryCode(recoveryCode);
  user.updatedAt = now();
  persistState();
  return recoveryCode;
}

function revokeUserSessions(userId) {
  const revokedAt = now();
  Object.values(state.authSessions || {}).forEach((session) => {
    if (session.userId === userId && !session.revokedAt) {
      session.revokedAt = revokedAt;
    }
  });
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function getAuthenticatedUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const session = state.authSessions[hashToken(token)];
  if (!session || session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const user = state.users[session.userId];
  if (!user) return null;
  user.lastActiveAt = now();
  user.updatedAt = user.updatedAt || user.lastActiveAt;
  return user;
}

function revokeSession(req) {
  const token = getBearerToken(req);
  if (!token) return false;
  const session = state.authSessions[hashToken(token)];
  if (!session) return false;
  session.revokedAt = now();
  persistState();
  return true;
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
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

function parseBody(req, options = {}) {
  const maxLength = Number(options.maxLength || DEFAULT_BODY_LIMIT);
  return new Promise((resolve, reject) => {
    let raw = "";
    let rawBytes = 0;
    req.on("data", (chunk) => {
      rawBytes += chunk.length;
      raw += chunk;
      if (rawBytes > maxLength) {
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

function sanitizeStory(story, options = {}) {
  const includeContent = options.includeContent !== false;
  if (!story) {
    const fallbackBody = ["这个房间关联的阅读内容暂时找不到。"];
    const fallbackText = fallbackBody.join("\n\n");
    return {
      id: "missing-story",
      title: "内容已不可用",
      author: "系统",
      cover: "缺失",
      summary: "这个房间关联的阅读内容暂时找不到。",
      body: includeContent ? fallbackBody : [],
      text: includeContent ? fallbackText : "",
      wordCount: 17,
      source: "missing",
      tags: [],
      chaptered: false,
      chapterCount: 0
    };
  }
  return {
    id: story.id,
    title: story.title,
    author: story.author,
    cover: story.cover,
    summary: story.summary,
    body: includeContent ? story.body : [],
    text: includeContent ? story.text : "",
    wordCount: story.wordCount,
    source: story.source || "builtin",
    tags: story.tags || [],
    sourceUrl: story.sourceUrl || "",
    licenseNote: story.licenseNote || "",
    chaptered: Boolean(story.chaptered),
    chapterCount: Number(story.chapterCount || 0),
    importStatus: story.importStatus || "",
    parentBookId: story.parentBookId || "",
    chapterIndex: Number.isInteger(story.chapterIndex) ? story.chapterIndex : null,
    chapterTitle: story.chapterTitle || ""
  };
}

function sanitizeStoryPreview(story) {
  return sanitizeStory(story, { includeContent: false });
}

function normalizeBookText(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  const body = normalized
    .split(/\n{2,}/)
    .map((part) => part.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const fallbackBody = body.length ? body : normalized.split("\n").map((part) => part.trim()).filter(Boolean);
  const finalBody = fallbackBody.length ? fallbackBody : [normalized];
  return {
    text: finalBody.join("\n\n"),
    body: finalBody,
    wordCount: finalBody.join("").replace(/\s+/g, "").length
  };
}

function getImportedBooks() {
  return Array.isArray(state.books) ? state.books : [];
}

function getImportedChapters() {
  return Array.isArray(state.bookChapters) ? state.bookChapters : [];
}

function getBookChapters(bookId) {
  return getImportedChapters()
    .filter((chapter) => chapter.bookId === bookId)
    .sort((a, b) => Number(a.chapterIndex) - Number(b.chapterIndex));
}

function makeChapterStoryId(bookId, chapterIndex) {
  return `${bookId}::chapter-${Number(chapterIndex)}`;
}

function parseChapterStoryId(storyId) {
  const match = String(storyId || "").match(/^(.+)::chapter-(\d+)$/);
  if (!match) return null;
  return {
    bookId: match[1],
    chapterIndex: Number(match[2])
  };
}

function buildChapterStory(book, chapter) {
  if (!book || !chapter) return null;
  const storedText = typeof chapter.text === "string" ? chapter.text : "";
  const storedBody = Array.isArray(chapter.body) ? chapter.body : [];
  const normalized = storedBody.length && storedText ? null : normalizeBookText(storedText || storedBody.join("\n\n"));
  const title = chapter.title || `第 ${Number(chapter.chapterIndex) + 1} 章`;
  const body = storedBody.length ? storedBody : normalized.body;
  const text = storedText || normalized.text;
  return {
    id: makeChapterStoryId(book.id, chapter.chapterIndex),
    ownerId: book.ownerId,
    title: `${book.title}：${title}`,
    author: book.author,
    cover: title.slice(0, 6) || "章节",
    summary: `${book.title} / ${title}`,
    body,
    text,
    wordCount: Number(chapter.wordCount || normalized?.wordCount || text.replace(/\s+/g, "").length),
    source: "imported",
    tags: book.tags || [],
    chaptered: false,
    chapterCount: Number(book.chapterCount || getBookChapters(book.id).length),
    parentBookId: book.id,
    chapterIndex: Number(chapter.chapterIndex),
    chapterTitle: title,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt
  };
}

function getChapterStoryById(storyId, user = null) {
  const parsed = parseChapterStoryId(storyId);
  if (!parsed) return null;
  const book = getImportedBooks().find((item) => item.id === parsed.bookId && (!user || !item.ownerId || item.ownerId === user.id));
  if (!book) return null;
  const chapter = getBookChapters(book.id).find((item) => Number(item.chapterIndex) === parsed.chapterIndex);
  return buildChapterStory(book, chapter);
}

function getVisibleStories(user = null) {
  const imported = getImportedBooks().filter((book) => !book.ownerId || user?.id === book.ownerId);
  return [...stories, ...imported];
}

function getStoryById(storyId, user = null) {
  if (builtInStoryMap.has(storyId)) return builtInStoryMap.get(storyId);
  const chapterStory = getChapterStoryById(storyId, user);
  if (chapterStory) return chapterStory;
  const book = getImportedBooks().find((item) => item.id === storyId && (!user || !item.ownerId || item.ownerId === user.id));
  if (book?.chaptered) {
    const firstChapter = getBookChapters(book.id)[0];
    return buildChapterStory(book, firstChapter) || book;
  }
  return book;
}

function getStoryForPublicUse(storyId) {
  if (builtInStoryMap.has(storyId)) return builtInStoryMap.get(storyId);
  const chapterStory = getChapterStoryById(storyId);
  if (chapterStory) return chapterStory;
  const book = getImportedBooks().find((item) => item.id === storyId) || null;
  if (book?.chaptered) {
    const firstChapter = getBookChapters(book.id)[0];
    return buildChapterStory(book, firstChapter) || book;
  }
  return book;
}

function getStoryCommentSummary(storyId) {
  const summary = {
    chapter: 0,
    paragraphs: {}
  };
  (state.comments || []).forEach((item) => {
    if (item.storyId !== storyId) return;
    if (item.scope === "chapter") {
      summary.chapter += 1;
      return;
    }
    if (item.scope === "paragraph" && item.paragraphIndex != null) {
      const key = String(item.paragraphIndex);
      summary.paragraphs[key] = (summary.paragraphs[key] || 0) + 1;
    }
  });
  return summary;
}

function searchStories(query, user = null) {
  const keyword = String(query || "").trim().toLowerCase();
  if (!keyword) return [];
  const userId = user?.id || null;
  return getVisibleStories(user)
    .filter((story) => {
      const haystack = [
        story.title,
        story.author,
        story.summary,
        story.cover,
        ...(story.tags || []),
        story.text || ""
      ].join(" ").toLowerCase();
      return haystack.includes(keyword);
    })
    .slice(0, 30)
    .map((story) => {
      const history = userId ? getReadingHistoryItems(userId).find((item) => item.storyId === story.id) || null : null;
      const inBookshelf = userId ? getBookshelfItems(userId).some((item) => item.storyId === story.id) : false;
      return {
        ...sanitizeStoryPreview(story),
        history,
        inBookshelf,
        commentSummary: getStoryCommentSummary(story.id)
      };
    });
}

function getBookshelfItems(userId) {
  return (state.bookshelf || [])
    .filter((item) => item.userId === userId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function getReadingHistoryItems(userId) {
  return (state.readingHistory || [])
    .filter((item) => item.userId === userId)
    .sort((a, b) => new Date(b.lastReadAt).getTime() - new Date(a.lastReadAt).getTime());
}

function decorateStoryItem(storyId, userId) {
  const story = getStoryForPublicUse(storyId);
  if (!story) return null;
  const history = getReadingHistoryItems(userId).find((item) => item.storyId === storyId) || null;
  return {
    story: sanitizeStoryPreview(story),
    history,
    inBookshelf: getBookshelfItems(userId).some((item) => item.storyId === storyId),
    commentSummary: getStoryCommentSummary(storyId)
  };
}

function upsertBookshelf(userId, storyId) {
  const at = now();
  state.bookshelf = state.bookshelf || [];
  const existing = state.bookshelf.find((item) => item.userId === userId && item.storyId === storyId);
  if (existing) {
    existing.updatedAt = at;
    return existing;
  }
  const item = { userId, storyId, addedAt: at, updatedAt: at };
  state.bookshelf.unshift(item);
  return item;
}

function removeBookshelf(userId, storyId) {
  const before = (state.bookshelf || []).length;
  state.bookshelf = (state.bookshelf || []).filter((item) => !(item.userId === userId && item.storyId === storyId));
  return state.bookshelf.length !== before;
}

function upsertReadingHistory(userId, storyId, roomId, progress) {
  if (!userId || !storyId) return null;
  const at = now();
  state.readingHistory = state.readingHistory || [];
  const existing = state.readingHistory.find((item) => item.userId === userId && item.storyId === storyId);
  const nextProgress = Math.max(0, Math.min(100, Number(progress || 0)));
  if (existing) {
    existing.roomId = roomId || existing.roomId || null;
    existing.progress = Math.max(Number(existing.progress || 0), nextProgress);
    existing.lastReadAt = at;
    return existing;
  }
  const item = {
    userId,
    storyId,
    roomId: roomId || null,
    progress: nextProgress,
    lastReadAt: at
  };
  state.readingHistory.unshift(item);
  state.readingHistory = state.readingHistory.slice(0, 500);
  return item;
}

function createRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (Object.values(state.rooms).some((room) => room.code === code));
  return code;
}

function ensureUser(input, req = null) {
  const authUser = req ? getAuthenticatedUser(req) : null;
  if (authUser) {
    return { ok: true, user: authUser };
  }

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
      nickname: providedName || "Reader",
      avatar: (providedName || "R").slice(0, 1),
      createdAt: now(),
      updatedAt: now(),
      lastActiveAt: now()
    };
    state.users[user.id] = user;
  } else {
    if (providedName) {
      user.name = providedName;
      user.nickname = providedName;
      user.avatar = providedName.slice(0, 1);
    }
    user.lastActiveAt = now();
    user.updatedAt = now();
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
  const story = getStoryForPublicUse(room.storyId);
  return {
    ...room,
    story: sanitizeStory(story),
    commentSummary: getStoryCommentSummary(room.storyId),
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
    const user = getAuthenticatedUser(req);
    sendJson(res, 200, {
      stories: getVisibleStories(user).map((story) => ({
        ...sanitizeStoryPreview(story),
        commentSummary: getStoryCommentSummary(story.id)
      })),
      waitOptions: [5, 8, 12, 15],
      quickMessages: ["我等你", "慢慢读", "这段好看", "哈哈哈", "读到这里告诉我", "我刚看到一个重点"]
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const user = getAuthenticatedUser(req);
    const query = url.searchParams.get("q") || "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query_required" });
      return true;
    }
    sendJson(res, 200, { items: searchStories(query, user) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/books/mine") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const books = getImportedBooks().filter((book) => book.ownerId === user.id).map(sanitizeStoryPreview);
    sendJson(res, 200, { books });
    return true;
  }

  const chaptersMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters$/);
  if (chaptersMatch && req.method === "GET") {
    const user = getAuthenticatedUser(req);
    const bookId = decodeURIComponent(chaptersMatch[1]);
    const book = getImportedBooks().find((item) => item.id === bookId && (!item.ownerId || user?.id === item.ownerId));
    if (!book || !book.chaptered) {
      sendJson(res, 404, { error: "book_not_found" });
      return true;
    }
    const chapters = getBookChapters(book.id).map((chapter) => ({
      id: chapter.id,
      bookId: book.id,
      storyId: makeChapterStoryId(book.id, chapter.chapterIndex),
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      wordCount: chapter.wordCount,
      createdAt: chapter.createdAt,
      updatedAt: chapter.updatedAt
    }));
    sendJson(res, 200, { book: sanitizeStoryPreview(book), chapters });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/bookshelf") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const items = getBookshelfItems(user.id)
      .map((item) => {
        const decorated = decorateStoryItem(item.storyId, user.id);
        return decorated ? { ...item, ...decorated } : null;
      })
      .filter(Boolean);
    sendJson(res, 200, { items });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/bookshelf") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const story = getStoryById(body.storyId, user);
    if (!story) {
      sendJson(res, 404, { error: "story_not_found" });
      return true;
    }
    const item = upsertBookshelf(user.id, story.id);
    persistState();
    sendJson(res, 200, { item: { ...item, story: sanitizeStoryPreview(story) } });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/bookshelf/remove") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    removeBookshelf(user.id, String(body.storyId || ""));
    persistState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/reading/history") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const items = getReadingHistoryItems(user.id)
      .map((item) => {
        const decorated = decorateStoryItem(item.storyId, user.id);
        return decorated ? { ...item, ...decorated } : null;
      })
      .filter(Boolean)
      .slice(0, 80);
    sendJson(res, 200, { items });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/reading/history") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const story = getStoryForPublicUse(body.storyId);
    if (!story) {
      sendJson(res, 404, { error: "story_not_found" });
      return true;
    }
    const item = upsertReadingHistory(user.id, story.id, body.roomId, body.progress);
    persistState();
    sendJson(res, 200, { item: { ...item, story: sanitizeStoryPreview(story) } });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/books/import/start") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const title = String(body.title || "").trim().slice(0, 80);
    const author = String(body.author || "用户导入").trim().slice(0, 40) || "用户导入";
    const summaryInput = String(body.summary || "").trim().slice(0, 160);
    const tags = String(body.tags || "")
      .split(/[,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8);
    const totalChapters = Math.max(1, Math.min(BOOK_CHAPTER_MAX_COUNT, Number(body.totalChapters || 1)));
    if (title.length < 1) {
      sendJson(res, 400, { error: "book_title_required" });
      return true;
    }
    const createdAt = now();
    const book = {
      id: uid("book"),
      ownerId: user.id,
      title,
      author,
      cover: "分章导入",
      summary: summaryInput || `分章导入中，共 ${totalChapters} 章。`,
      body: [`${title} 正在分章导入，完成后可选择章节创建共读房间。`],
      text: `${title} 正在分章导入。`,
      wordCount: 0,
      tags,
      source: "imported",
      chaptered: true,
      chapterCount: totalChapters,
      importStatus: "importing",
      createdAt,
      updatedAt: createdAt
    };
    state.books = [book, ...getImportedBooks()].slice(0, 200);
    state.bookChapters = (state.bookChapters || []).filter((chapter) => chapter.bookId !== book.id);
    persistState();
    sendJson(res, 201, { book: sanitizeStoryPreview(book) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/books/import/chapter") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await parseBody(req, { maxLength: BOOK_CHAPTER_BODY_LIMIT }).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const book = getImportedBooks().find((item) => item.id === String(body.bookId || "") && item.ownerId === user.id);
    if (!book || !book.chaptered) {
      sendJson(res, 404, { error: "book_not_found" });
      return true;
    }
    const chapterIndex = Number(body.chapterIndex);
    const chapterTitle = String(body.title || `第 ${chapterIndex + 1} 章`).trim().slice(0, 120);
    const normalized = normalizeBookText(body.text || body.content || "");
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0 || chapterIndex >= BOOK_CHAPTER_MAX_COUNT) {
      sendJson(res, 400, { error: "invalid_chapter_index" });
      return true;
    }
    if (normalized.wordCount < BOOK_IMPORT_MIN_WORDS) {
      sendJson(res, 400, { error: "book_content_too_short" });
      return true;
    }
    if (normalized.text.length > BOOK_CHAPTER_TEXT_LIMIT) {
      sendJson(res, 400, { error: "book_chapter_too_long" });
      return true;
    }
    const existing = getImportedChapters().find((chapter) => chapter.bookId === book.id && Number(chapter.chapterIndex) === chapterIndex);
    const updatedAt = now();
    const chapter = {
      id: existing?.id || uid("chapter"),
      bookId: book.id,
      chapterIndex,
      title: chapterTitle || `第 ${chapterIndex + 1} 章`,
      body: normalized.body,
      text: normalized.text,
      wordCount: normalized.wordCount,
      createdAt: existing?.createdAt || updatedAt,
      updatedAt
    };
    state.bookChapters = [
      ...(state.bookChapters || []).filter((item) => !(item.bookId === book.id && Number(item.chapterIndex) === chapterIndex)),
      chapter
    ].sort((a, b) => a.bookId.localeCompare(b.bookId) || Number(a.chapterIndex) - Number(b.chapterIndex));
    const chapters = getBookChapters(book.id);
    book.wordCount = chapters.reduce((sum, item) => sum + Number(item.wordCount || 0), 0);
    book.chapterCount = Math.max(Number(book.chapterCount || 0), chapters.length);
    book.updatedAt = updatedAt;
    persistState();
    sendJson(res, 201, { chapter: { ...chapter, storyId: makeChapterStoryId(book.id, chapter.chapterIndex) }, book: sanitizeStoryPreview(book) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/books/import/finish") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const book = getImportedBooks().find((item) => item.id === String(body.bookId || "") && item.ownerId === user.id);
    if (!book || !book.chaptered) {
      sendJson(res, 404, { error: "book_not_found" });
      return true;
    }
    const chapters = getBookChapters(book.id);
    if (!chapters.length) {
      sendJson(res, 400, { error: "book_content_too_short" });
      return true;
    }
    book.wordCount = chapters.reduce((sum, chapter) => sum + Number(chapter.wordCount || 0), 0);
    book.chapterCount = chapters.length;
    book.importStatus = "done";
    const firstChapter = chapters[0];
    book.body = [`已分章导入 ${chapters.length} 章。创建房间时请选择具体章节。`];
    book.text = book.body.join("\n\n");
    book.summary = String(body.summary || book.summary || firstChapter.text.slice(0, 90)).trim().slice(0, 160);
    book.updatedAt = now();
    persistState();
    sendJson(res, 200, {
      book: sanitizeStoryPreview(book),
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        storyId: makeChapterStoryId(book.id, chapter.chapterIndex),
        chapterIndex: chapter.chapterIndex,
        title: chapter.title,
        wordCount: chapter.wordCount
      }))
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/books/import") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await parseBody(req, { maxLength: BOOK_IMPORT_BODY_LIMIT }).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const title = String(body.title || "").trim().slice(0, 80);
    const author = String(body.author || "用户导入").trim().slice(0, 40) || "用户导入";
    const summaryInput = String(body.summary || "").trim().slice(0, 160);
    const tags = String(body.tags || "")
      .split(/[,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8);
    const normalized = normalizeBookText(body.text || body.content || "");
    if (title.length < 1) {
      sendJson(res, 400, { error: "book_title_required" });
      return true;
    }
    if (normalized.wordCount < BOOK_IMPORT_MIN_WORDS) {
      sendJson(res, 400, { error: "book_content_too_short" });
      return true;
    }
    if (normalized.text.length > BOOK_IMPORT_TEXT_LIMIT) {
      sendJson(res, 400, { error: "book_content_too_long" });
      return true;
    }
    const createdAt = now();
    const book = {
      id: uid("book"),
      ownerId: user.id,
      title,
      author,
      cover: "导入书籍",
      summary: summaryInput || normalized.text.slice(0, 90),
      body: normalized.body,
      text: normalized.text,
      wordCount: normalized.wordCount,
      tags,
      source: "imported",
      createdAt,
      updatedAt: createdAt
    };
    state.books = [book, ...getImportedBooks()].slice(0, 200);
    persistState();
    sendJson(res, 201, { book: sanitizeStoryPreview(book) });
    return true;
  }

  const commentMatch = url.pathname.match(/^\/api\/stories\/([^/]+)\/comments$/);
  if (commentMatch && req.method === "GET") {
    const storyId = decodeURIComponent(commentMatch[1]);
    if (!getStoryForPublicUse(storyId)) {
      sendJson(res, 404, { error: "story_not_found" });
      return true;
    }
    const scope = String(url.searchParams.get("scope") || "").trim();
    const paragraphIndexRaw = url.searchParams.get("paragraphIndex");
    const paragraphIndex = paragraphIndexRaw == null ? null : Number(paragraphIndexRaw);
    const items = (state.comments || [])
      .filter((item) => item.storyId === storyId)
      .filter((item) => !scope || item.scope === scope)
      .filter((item) => paragraphIndexRaw == null || Number(item.paragraphIndex) === paragraphIndex)
      .slice(-100);
    sendJson(res, 200, { items, summary: getStoryCommentSummary(storyId) });
    return true;
  }

  if (commentMatch && req.method === "POST") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const storyId = decodeURIComponent(commentMatch[1]);
    const story = getStoryForPublicUse(storyId);
    if (!story) {
      sendJson(res, 404, { error: "story_not_found" });
      return true;
    }
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const scope = String(body.scope || "chapter").trim();
    const allowedScopes = new Set(["chapter", "paragraph"]);
    if (!allowedScopes.has(scope)) {
      sendJson(res, 400, { error: "invalid_comment_scope" });
      return true;
    }
    const content = String(body.content || "").trim();
    if (content.length < 1) {
      sendJson(res, 400, { error: "comment_content_required" });
      return true;
    }
    if (content.length > 300) {
      sendJson(res, 400, { error: "comment_too_long" });
      return true;
    }
    const paragraphIndex = scope === "paragraph" ? Number(body.paragraphIndex) : null;
    if (scope === "paragraph" && (!Number.isInteger(paragraphIndex) || paragraphIndex < 0 || paragraphIndex >= story.body.length)) {
      sendJson(res, 400, { error: "invalid_paragraph_index" });
      return true;
    }
    const createdAt = now();
    const comment = {
      id: uid("comment"),
      storyId,
      scope,
      paragraphIndex,
      userId: user.id,
      userName: user.name || user.nickname || "读者",
      content,
      createdAt,
      updatedAt: createdAt
    };
    state.comments = state.comments || [];
    state.comments.push(comment);
    state.comments = state.comments.slice(-2000);
    persistState();
    sendJson(res, 201, { comment, summary: getStoryCommentSummary(storyId) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const account = normalizeAccount(body.account);
    const password = String(body.password || "");
    const nickname = String(body.nickname || body.name || "").trim().slice(0, 12);
    if (!/^[a-z0-9_@.+-]{3,80}$/i.test(account)) {
      sendJson(res, 400, { error: "invalid_account" });
      return true;
    }
    if (password.length < 8) {
      sendJson(res, 400, { error: "weak_password" });
      return true;
    }
    if (!nickname) {
      sendJson(res, 400, { error: "name_required" });
      return true;
    }
    const exists = Object.values(state.users).some((user) => normalizeAccount(user.account) === account);
    if (exists) {
      sendJson(res, 409, { error: "account_exists" });
      return true;
    }
    const createdAt = now();
    const user = {
      id: uid("user"),
      account,
      name: nickname,
      nickname,
      avatar: nickname.slice(0, 1),
      passwordHash: hashPassword(password),
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt
    };
    state.users[user.id] = user;
    const recoveryCode = issueRecoveryCode(user);
    const token = createSession(user.id);
    persistState();
    sendJson(res, 201, { token, user: publicUser(user), recoveryCode });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const account = normalizeAccount(body.account);
    const password = String(body.password || "");
    const user = Object.values(state.users).find((item) => normalizeAccount(item.account) === account);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      sendJson(res, 401, { error: "invalid_credentials" });
      return true;
    }
    user.lastActiveAt = now();
    user.updatedAt = now();
    const token = createSession(user.id);
    persistState();
    sendJson(res, 200, { token, user: publicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/recovery-code") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const recoveryCode = issueRecoveryCode(user);
    sendJson(res, 200, { recoveryCode });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/password/reset") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const account = normalizeAccount(body.account);
    const recoveryCode = String(body.recoveryCode || body.code || "");
    const password = String(body.password || body.newPassword || "");
    if (!/^[a-z0-9_@.+-]{3,80}$/i.test(account)) {
      sendJson(res, 400, { error: "invalid_account" });
      return true;
    }
    if (password.length < 8) {
      sendJson(res, 400, { error: "weak_password" });
      return true;
    }
    const user = Object.values(state.users).find((item) => normalizeAccount(item.account) === account);
    if (!user || !verifyRecoveryCode(recoveryCode, user.passwordRecoveryHash)) {
      sendJson(res, 401, { error: "invalid_recovery_code" });
      return true;
    }
    user.passwordHash = hashPassword(password);
    user.lastActiveAt = now();
    revokeUserSessions(user.id);
    const nextRecoveryCode = generateRecoveryCode();
    user.passwordRecoveryHash = hashRecoveryCode(nextRecoveryCode);
    user.updatedAt = now();
    const token = createSession(user.id);
    persistState();
    sendJson(res, 200, { token, user: publicUser(user), recoveryCode: nextRecoveryCode });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    persistState();
    sendJson(res, 200, { user: publicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    revokeSession(req);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/records") {
    sendJson(res, 200, { records: state.records });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/feedback/mine") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const items = (state.feedback || []).filter((item) => item.userId === user.id);
    sendJson(res, 200, { items });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/feedback") {
    const user = getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const type = String(body.type || "other").trim().slice(0, 30);
    const allowedTypes = new Set(["bug", "suggestion", "other"]);
    const content = String(body.content || "").trim();
    const contact = String(body.contact || "").trim().slice(0, 120);
    if (!allowedTypes.has(type)) {
      sendJson(res, 400, { error: "invalid_feedback_type" });
      return true;
    }
    if (content.length < 2) {
      sendJson(res, 400, { error: "feedback_content_required" });
      return true;
    }
    if (content.length > 2000) {
      sendJson(res, 400, { error: "feedback_too_long" });
      return true;
    }
    const createdAt = now();
    const feedback = {
      id: uid("feedback"),
      userId: user.id,
      type,
      content,
      contact,
      status: "open",
      createdAt,
      updatedAt: createdAt
    };
    state.feedback = state.feedback || [];
    state.feedback.unshift(feedback);
    persistState();
    sendJson(res, 201, { feedback });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const result = ensureUser(body, req);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    sendJson(res, 200, { user: publicUser(result.user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const result = ensureUser(body, req);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    const user = result.user;
    const story = getStoryById(body.storyId, user);
    const threshold = Number(body.threshold);
    if (!story) {
      sendJson(res, 400, { error: "story_not_found" });
      return true;
    }
    if (![5, 8, 12, 15].includes(threshold)) {
      sendJson(res, 400, { error: "invalid_threshold" });
      return true;
    }
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
    sendJson(res, 201, { user: publicUser(user), room: normalizeRoom(room) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms/join") {
    const body = await parseBody(req).catch((error) => ({ __error: error.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const result = ensureUser(body, req);
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
    sendJson(res, 200, { user: publicUser(user), room: normalizeRoom(room) });
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
    const authUser = getAuthenticatedUser(req);
    if (authUser && getMember(room, authUser.id)) {
      const entry = room.progress[authUser.id];
      upsertReadingHistory(authUser.id, room.storyId, room.id, entry?.maxProgress || 0);
      persistState();
    }
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
  const userResult = ensureUser(body, req);
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
    room.updatedAt = now();
    persistState();
    sendJson(res, 200, {
      ok: true,
      member,
      waitState: computeWaitState(room),
      updatedAt: room.updatedAt
    });
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
    upsertReadingHistory(user.id, room.storyId, room.id, entry.maxProgress);
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
  initializeStorage()
    .then(() => {
      if (!offlineTimer) {
        offlineTimer = setInterval(markOfflineMembers, 5000);
        offlineTimer.unref?.();
      }
      server.listen(PORT, HOST, () => {
        console.log(`SharedReading server running on ${HOST}:${PORT}`);
        console.log(`Storage: ${STORAGE_DRIVER}`);
        console.log(`Local:   http://127.0.0.1:${PORT}`);
        console.log(`Network: http://<your-ip>:${PORT}`);
        callback?.();
      });
    })
    .catch((error) => {
      console.error("Failed to initialize storage:", error.message);
      process.exitCode = 1;
      callback?.(error);
    });
  return server;
}

function stopServer(callback) {
  if (offlineTimer) {
    clearInterval(offlineTimer);
    offlineTimer = null;
  }
  if (isMysqlEnabled()) {
    flushPersistStateBeforeClose()
      .catch((error) => {
        console.error("Failed to flush state before close:", error.message);
      })
      .finally(() => server.close(callback));
    return;
  }
  flushPersistStateSync();
  server.close(callback);
}

if (require.main === module) {
  startServer();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 6000);
    forceExit.unref?.();
    stopServer(async () => {
      if (mysqlPool) {
        await mysqlPool.end().catch(() => {});
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.on("exit", () => {
    flushPersistStateSync();
  });
}

module.exports = {
  server,
  startServer,
  stopServer
};

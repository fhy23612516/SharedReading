CREATE DATABASE IF NOT EXISTS shared_reading
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE shared_reading;

CREATE TABLE IF NOT EXISTS users (
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
);

SET @has_password_recovery_hash := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'password_recovery_hash'
);
SET @add_password_recovery_hash := IF(
  @has_password_recovery_hash = 0,
  'ALTER TABLE users ADD COLUMN password_recovery_hash VARCHAR(128) NULL AFTER password_hash',
  'SELECT 1'
);
PREPARE add_password_recovery_hash_stmt FROM @add_password_recovery_hash;
EXECUTE add_password_recovery_hash_stmt;
DEALLOCATE PREPARE add_password_recovery_hash_stmt;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  INDEX idx_auth_sessions_user_id (user_id),
  INDEX idx_auth_sessions_expires_at (expires_at)
);

CREATE TABLE IF NOT EXISTS books (
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
);

SET @has_books_chaptered := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'books'
    AND COLUMN_NAME = 'chaptered'
);
SET @add_books_chaptered := IF(
  @has_books_chaptered = 0,
  'ALTER TABLE books ADD COLUMN chaptered TINYINT(1) NOT NULL DEFAULT 0 AFTER tags_json',
  'SELECT 1'
);
PREPARE add_books_chaptered_stmt FROM @add_books_chaptered;
EXECUTE add_books_chaptered_stmt;
DEALLOCATE PREPARE add_books_chaptered_stmt;

SET @has_books_chapter_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'books'
    AND COLUMN_NAME = 'chapter_count'
);
SET @add_books_chapter_count := IF(
  @has_books_chapter_count = 0,
  'ALTER TABLE books ADD COLUMN chapter_count INT NOT NULL DEFAULT 0 AFTER chaptered',
  'SELECT 1'
);
PREPARE add_books_chapter_count_stmt FROM @add_books_chapter_count;
EXECUTE add_books_chapter_count_stmt;
DEALLOCATE PREPARE add_books_chapter_count_stmt;

SET @has_books_import_status := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'books'
    AND COLUMN_NAME = 'import_status'
);
SET @add_books_import_status := IF(
  @has_books_import_status = 0,
  'ALTER TABLE books ADD COLUMN import_status VARCHAR(20) NOT NULL DEFAULT ''done'' AFTER chapter_count',
  'SELECT 1'
);
PREPARE add_books_import_status_stmt FROM @add_books_import_status;
EXECUTE add_books_import_status_stmt;
DEALLOCATE PREPARE add_books_import_status_stmt;

CREATE TABLE IF NOT EXISTS book_chapters (
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
);

CREATE TABLE IF NOT EXISTS story_comments (
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
);

CREATE TABLE IF NOT EXISTS bookshelf_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  story_id VARCHAR(40) NOT NULL,
  added_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uniq_bookshelf_user_story (user_id, story_id),
  INDEX idx_bookshelf_user_updated (user_id, updated_at)
);

CREATE TABLE IF NOT EXISTS reading_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  story_id VARCHAR(40) NOT NULL,
  room_id VARCHAR(40),
  progress DECIMAL(5,1) NOT NULL DEFAULT 0,
  last_read_at DATETIME NOT NULL,
  UNIQUE KEY uniq_history_user_story (user_id, story_id),
  INDEX idx_history_user_last_read (user_id, last_read_at)
);

CREATE TABLE IF NOT EXISTS rooms (
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
);

CREATE TABLE IF NOT EXISTS room_members (
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

CREATE TABLE IF NOT EXISTS reading_progress (
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

CREATE TABLE IF NOT EXISTS chat_messages (
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

CREATE TABLE IF NOT EXISTS room_events (
  id VARCHAR(40) PRIMARY KEY,
  room_id VARCHAR(40) NOT NULL,
  type VARCHAR(40) NOT NULL,
  user_id VARCHAR(40),
  info VARCHAR(500),
  created_at DATETIME NOT NULL,
  INDEX idx_room_events_room_created (room_id, created_at),
  INDEX idx_room_events_type (type)
);

CREATE TABLE IF NOT EXISTS reading_records (
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
);

CREATE TABLE IF NOT EXISTS feedback (
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

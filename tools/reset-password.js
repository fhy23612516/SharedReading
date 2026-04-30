#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT_DIR = path.join(__dirname, "..");

function usage() {
  console.log("Usage: node tools/reset-password.js <account> [new-password]");
  console.log("");
  console.log("If new-password is omitted, the script prompts for it.");
  console.log("Stop shared-reading-api before running this script, then restart it after reset.");
}

function now() {
  return new Date().toISOString();
}

function toMysqlDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function normalizeAccount(account) {
  return String(account || "").trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
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

function loadEcosystemEnv() {
  try {
    const config = require(path.join(ROOT_DIR, "ecosystem.config.cjs"));
    const apiApp = Array.isArray(config.apps) ? config.apps.find((app) => app.name === "shared-reading-api") : null;
    return apiApp?.env || {};
  } catch {
    return {};
  }
}

function getRuntimeEnv() {
  return {
    ...loadEcosystemEnv(),
    ...process.env
  };
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });
    rl.stdoutMuted = true;
    rl._writeToOutput = function writeToOutput(text) {
      if (!rl.stdoutMuted) {
        rl.output.write(text);
        return;
      }
      if (text.includes(question)) {
        rl.output.write(text);
        return;
      }
      if (text === "\r\n" || text === "\n" || text === "\r") {
        rl.output.write(text);
        return;
      }
      rl.output.write("*");
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function readPasswordFromArgs(args) {
  if (args[1]) return args[1];
  if (!process.stdin.isTTY) {
    throw new Error("new-password is required when stdin is not interactive");
  }
  const password = await promptHidden("New password: ");
  const confirmation = await promptHidden("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("passwords do not match");
  }
  return password;
}

function validateInput(account, password) {
  if (!/^[a-z0-9_@.+-]{3,80}$/i.test(account)) {
    throw new Error("invalid account format");
  }
  if (String(password || "").length < 8) {
    throw new Error("password must be at least 8 characters");
  }
}

function revokeJsonSessions(state, userId) {
  const revokedAt = now();
  Object.values(state.authSessions || {}).forEach((session) => {
    if (session.userId === userId && !session.revokedAt) {
      session.revokedAt = revokedAt;
    }
  });
}

async function resetJsonPassword(env, account, password) {
  const storePath = env.STORE_PATH || path.join(ROOT_DIR, "data", "store.json");
  const raw = fs.existsSync(storePath) ? fs.readFileSync(storePath, "utf8") : "";
  const state = raw ? JSON.parse(raw) : {};
  const users = state.users || {};
  const user = Object.values(users).find((item) => normalizeAccount(item.account) === account);
  if (!user) {
    throw new Error(`account not found: ${account}`);
  }
  const recoveryCode = generateRecoveryCode();
  user.passwordHash = hashPassword(password);
  user.passwordRecoveryHash = hashRecoveryCode(recoveryCode);
  user.updatedAt = now();
  user.lastActiveAt = user.updatedAt;
  revokeJsonSessions(state, user.id);

  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempPath, storePath);
  return { userId: user.id, recoveryCode, storage: "json", storePath };
}

async function ensureMysqlColumn(pool) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'password_recovery_hash'`
  );
  if (!Number(rows[0]?.count || 0)) {
    await pool.query("ALTER TABLE users ADD COLUMN password_recovery_hash VARCHAR(128) NULL AFTER password_hash");
  }
}

async function resetMysqlPassword(env, account, password) {
  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch {
    throw new Error("mysql2 is required. Run npm install first.");
  }

  const pool = mysql.createPool({
    host: env.DB_HOST || "127.0.0.1",
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || "shared_reading",
    password: env.DB_PASSWORD || "",
    database: env.DB_NAME || "shared_reading",
    waitForConnections: true,
    connectionLimit: 1,
    timezone: "Z"
  });

  const connection = await pool.getConnection();
  try {
    await ensureMysqlColumn(connection);
    await connection.beginTransaction();
    const [users] = await connection.query("SELECT id, account FROM users WHERE LOWER(account) = ? LIMIT 1", [account]);
    const user = users[0];
    if (!user) {
      throw new Error(`account not found: ${account}`);
    }
    const recoveryCode = generateRecoveryCode();
    const updatedAt = toMysqlDate(now());
    await connection.query(
      `UPDATE users
          SET password_hash = ?,
              password_recovery_hash = ?,
              updated_at = ?,
              last_active_at = ?
        WHERE id = ?`,
      [hashPassword(password), hashRecoveryCode(recoveryCode), updatedAt, updatedAt, user.id]
    );
    await connection.query(
      "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      [updatedAt, user.id]
    );
    await connection.commit();
    return { userId: user.id, recoveryCode, storage: "mysql" };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help") || args.length < 1) {
    usage();
    process.exit(args.length < 1 ? 1 : 0);
  }

  const env = getRuntimeEnv();
  const account = normalizeAccount(args[0]);
  const password = await readPasswordFromArgs(args);
  validateInput(account, password);

  const storageDriver = String(env.STORAGE_DRIVER || "json").toLowerCase();
  const result = storageDriver === "mysql"
    ? await resetMysqlPassword(env, account, password)
    : await resetJsonPassword(env, account, password);

  console.log("");
  console.log("Password reset complete.");
  console.log(`Storage      : ${result.storage}`);
  console.log(`Account      : ${account}`);
  console.log(`User ID      : ${result.userId}`);
  if (result.storePath) console.log(`Store path   : ${result.storePath}`);
  console.log(`Recovery code: ${result.recoveryCode}`);
  console.log("");
  console.log("Save the recovery code now. It is not stored in plain text.");
  console.log("Restart shared-reading-api before logging in with the new password.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  generateRecoveryCode,
  hashPassword,
  hashRecoveryCode,
  normalizeAccount,
  resetJsonPassword,
  resetMysqlPassword
};

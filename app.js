(function () {
  const STORAGE_KEYS = {
    user: "shared-reading-user-v2",
    roomId: "shared-reading-room-v2",
    outbox: "shared-reading-outbox-v2"
  };

  const state = {
    user: null,
    room: null,
    stories: [],
    waitOptions: [5, 8, 12, 15],
    quickMessages: [],
    records: [],
    routePath: "/",
    eventSource: null,
    heartbeatTimer: null,
    progressFlushTimer: null,
    progressInFlight: false,
    queuedProgressValue: null,
    lastProgressSentAt: 0,
    lastMessageAt: 0,
    lastRoomSnapshot: null,
    liveFeedTimers: [],
    liveBurstMeta: {},
    outbox: [],
    outboxTimer: null,
    outboxInFlight: false,
    networkOnline: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    lastQueueToastAt: 0,
    lastRealtimeToastAt: 0,
    activityFilter: "all",
    relativeTimeTimer: null
  };

  const APP_CONFIG = window.__APP_CONFIG__ || {};
  const API_BASE_URL = String(APP_CONFIG.API_BASE_URL || "").replace(/\/$/, "");

  const app = document.getElementById("app");
  const toastRoot = document.getElementById("toast-root");

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function cloneData(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function formatTime(value) {
    if (!value) return "--:--";
    return new Date(value).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatDateTime(value) {
    if (!value) return "--";
    return new Date(value).toLocaleString("zh-CN");
  }

  function formatRelativeTime(value) {
    if (!value) return "未知时间";
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "未知时间";
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
    if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时前`;
    return `${Math.max(1, Math.floor(diff / 86_400_000))} 天前`;
  }

  function buildInviteLink(code) {
    return `${window.location.origin}${window.location.pathname}#/join?code=${encodeURIComponent(code)}`;
  }

  function minutesBetween(start, end) {
    const diff = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
    return Math.max(1, Math.round(diff / 60000));
  }

  function saveStoredJson(key, value) {
    const raw = JSON.stringify(value);
    localStorage.setItem(key, raw);
    sessionStorage.setItem(key, raw);
  }

  function loadStoredJson(key) {
    try {
      const localValue = localStorage.getItem(key);
      if (localValue) return JSON.parse(localValue);
      const sessionValue = sessionStorage.getItem(key);
      if (sessionValue) return JSON.parse(sessionValue);
      return null;
    } catch {
      return null;
    }
  }

  function saveSessionUser(user) {
    saveStoredJson(STORAGE_KEYS.user, user);
  }

  function loadSessionUser() {
    return loadStoredJson(STORAGE_KEYS.user);
  }

  function saveActiveRoomId(roomId) {
    if (roomId) {
      localStorage.setItem(STORAGE_KEYS.roomId, roomId);
      sessionStorage.setItem(STORAGE_KEYS.roomId, roomId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.roomId);
      sessionStorage.removeItem(STORAGE_KEYS.roomId);
    }
  }

  function loadActiveRoomId() {
    return localStorage.getItem(STORAGE_KEYS.roomId) || sessionStorage.getItem(STORAGE_KEYS.roomId) || "";
  }

  function getQuery() {
    const hash = window.location.hash || "#/";
    const [pathPart, queryPart] = hash.split("?");
    return {
      path: pathPart.replace(/^#/, "") || "/",
      params: new URLSearchParams(queryPart || "")
    };
  }

  function navigate(path, params) {
    const query = params ? `?${new URLSearchParams(params).toString()}` : "";
    window.location.hash = `${path}${query}`;
  }

  function buildApiUrl(path) {
    return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
  }

  function toast(title, body) {
    const node = document.createElement("div");
    node.className = "toast";
    node.innerHTML = `<strong>${escapeHtml(title)}</strong><div>${escapeHtml(body)}</div>`;
    toastRoot.appendChild(node);
    setTimeout(() => node.remove(), 3200);
  }

  async function request(url, options = {}) {
    const { timeoutMs = 12000, headers = {}, signal, ...fetchOptions } = options;
    const controller = timeoutMs && typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers: {
          "Content-Type": "application/json",
          ...headers
        },
        signal: signal || controller?.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || "request_failed");
        error.status = response.status;
        error.payload = data;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("request_timeout");
        timeoutError.status = 0;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function makeOutboxId(type) {
    return `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function loadOutbox() {
    const items = loadStoredJson(STORAGE_KEYS.outbox);
    return Array.isArray(items) ? items.filter((item) => item && item.type && item.roomId) : [];
  }

  function saveOutbox() {
    saveStoredJson(STORAGE_KEYS.outbox, state.outbox.slice(-100));
  }

  function isPermanentQueueError(error) {
    const permanentMessages = new Set([
      "room_not_found",
      "not_room_member",
      "room_ended",
      "invalid_progress",
      "empty_message",
      "message_too_long",
      "missing_user",
      "name_required"
    ]);
    if (permanentMessages.has(error.message)) return true;
    return error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status);
  }

  function notifyQueued() {
    const nowTime = Date.now();
    if (nowTime - state.lastQueueToastAt < 5000) return;
    state.lastQueueToastAt = nowTime;
    toast("已暂存操作", "网络恢复后会自动补发进度和消息。");
  }

  function enqueueOutboxItem(item) {
    const nextItem = {
      id: item.id || makeOutboxId(item.type),
      userId: state.user?.id,
      userName: state.user?.name,
      createdAt: new Date().toISOString(),
      attempts: 0,
      nextRetryAt: Date.now(),
      ...item
    };

    if (nextItem.type === "progress") {
      const existing = state.outbox.find((queued) => (
        queued.type === "progress" &&
        queued.roomId === nextItem.roomId &&
        queued.userId === nextItem.userId
      ));
      if (existing) {
        existing.progress = Math.max(Number(existing.progress || 0), Number(nextItem.progress || 0));
        existing.createdAt = nextItem.createdAt;
        existing.nextRetryAt = Date.now();
        existing.lastError = "";
        saveOutbox();
        scheduleOutboxFlush(0);
        return;
      }
    }

    state.outbox.push(nextItem);
    saveOutbox();
    scheduleOutboxFlush(0);
  }

  async function sendOutboxItem(item) {
    if (item.type === "progress") {
      const data = await request(buildApiUrl(`/api/rooms/${item.roomId}/progress`), {
        method: "POST",
        timeoutMs: 5000,
        body: JSON.stringify({
          userId: item.userId,
          name: item.userName,
          progress: item.progress
        })
      });
      if (state.room?.id === item.roomId && data.progress) {
        applyProgressEvent({
          userId: data.userId || item.userId,
          progress: data.progress,
          waitState: data.waitState,
          updatedAt: data.updatedAt
        });
      }
      if (data.room?.status === "completed") {
        state.room = data.room;
        state.records = (await request(buildApiUrl("/api/records"))).records;
        navigate("/done", { room: item.roomId });
      }
      return;
    }

    if (item.type === "message") {
      const data = await request(buildApiUrl(`/api/rooms/${item.roomId}/messages`), {
        method: "POST",
        timeoutMs: 5000,
        body: JSON.stringify({
          userId: item.userId,
          name: item.userName,
          clientId: item.localId || item.id,
          content: item.content
        })
      });
      if (state.room?.id === item.roomId) {
        if (data.room) {
          const prev = state.room;
          state.room = data.room;
          patchRoomDom(data.room, prev);
        } else {
          applyMessageEvent(data);
        }
      }
    }
  }

  function scheduleOutboxFlush(delay = 0) {
    if (state.outboxTimer) {
      clearTimeout(state.outboxTimer);
      state.outboxTimer = null;
    }
    state.outboxTimer = setTimeout(() => {
      state.outboxTimer = null;
      flushOutbox();
    }, Math.max(0, delay));
  }

  async function flushOutbox() {
    if (state.outboxInFlight || !state.networkOnline || !state.user?.id || !state.outbox.length) return;

    const first = state.outbox[0];
    const waitMs = Math.max(0, Number(first.nextRetryAt || 0) - Date.now());
    if (waitMs > 0) {
      scheduleOutboxFlush(waitMs);
      return;
    }

    state.outboxInFlight = true;
    try {
      while (state.outbox.length && state.networkOnline) {
        const item = state.outbox[0];
        const itemWaitMs = Math.max(0, Number(item.nextRetryAt || 0) - Date.now());
        if (itemWaitMs > 0) {
          scheduleOutboxFlush(itemWaitMs);
          break;
        }

        if (item.userId && item.userId !== state.user.id) {
          state.outbox.shift();
          saveOutbox();
          continue;
        }

        try {
          await sendOutboxItem(item);
          state.outbox.shift();
          saveOutbox();
        } catch (error) {
          if (isPermanentQueueError(error)) {
            state.outbox.shift();
            saveOutbox();
            continue;
          }
          item.attempts = Number(item.attempts || 0) + 1;
          item.lastError = error.message || "request_failed";
          item.nextRetryAt = Date.now() + Math.min(30000, 1000 * (2 ** Math.min(item.attempts, 5)));
          saveOutbox();
          break;
        }
      }
    } finally {
      state.outboxInFlight = false;
      if (state.outbox.length && state.networkOnline) {
        const retryMs = Math.max(1000, Number(state.outbox[0].nextRetryAt || 0) - Date.now());
        scheduleOutboxFlush(retryMs);
      }
    }
  }

  async function bootstrap() {
    const [bootstrapData, recordsData] = await Promise.all([
      request(buildApiUrl("/api/bootstrap")),
      request(buildApiUrl("/api/records"))
    ]);
    state.stories = bootstrapData.stories;
    state.waitOptions = bootstrapData.waitOptions;
    state.quickMessages = bootstrapData.quickMessages;
    state.records = recordsData.records;
    state.user = loadSessionUser();
  }

  async function refreshRecords() {
    state.records = (await request(buildApiUrl("/api/records"))).records;
  }

  function getStory(storyId) {
    return state.stories.find((story) => story.id === storyId);
  }

  async function ensureServerUser(name) {
    const payload = {};
    if (state.user?.id) payload.userId = state.user.id;
    if (name) payload.name = name.trim().slice(0, 12);
    const data = await request(buildApiUrl("/api/session"), {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.user = data.user;
    saveSessionUser(data.user);
    return data.user;
  }

  function getMyProgress(room) {
    return room?.progress?.[state.user?.id] || {
      maxProgress: 0,
      progress: 0,
      done: false,
      waitCount: 0,
      unlockedCount: 0
    };
  }

  function getOtherMember(room) {
    if (!room || !state.user) return null;
    return room.activeMembers.find((member) => member.userId !== state.user.id) || null;
  }

  function getOtherProgress(room) {
    const other = getOtherMember(room);
    return other ? room.progress[other.userId] : null;
  }

  function describeMemberPresence(member) {
    if (!member) return "还在等另一位加入";
    if (member.online) return `${member.name} 在线`;
    return `${member.name} ${formatRelativeTime(member.lastSeenAt)}离线`;
  }

  function getActivityCategory(event) {
    if (event.type === "message") return "message";
    if (event.type === "progress") return "progress";
    return "presence";
  }

  function getActivityFilterOptions() {
    return [
      { value: "all", label: "全部" },
      { value: "message", label: "消息" },
      { value: "progress", label: "进度" },
      { value: "presence", label: "成员" }
    ];
  }

  function renderActivityFilters() {
    return getActivityFilterOptions().map((option) => `
      <button type="button" class="shortcut-chip activity-filter ${state.activityFilter === option.value ? "active" : ""}" data-activity-filter="${option.value}">
        ${option.label}
      </button>
    `).join("");
  }

  function computeChatSummary(room) {
    const messages = room.chat || [];
    const mine = messages.filter((item) => item.userId === state.user.id).length;
    const other = messages.length - mine;
    const recent = messages.length
      ? messages.slice(-3).map((item) => `${item.userName}：${item.content}`).join(" / ")
      : "还没有聊天消息";
    return {
      total: messages.length,
      mine,
      other,
      recent
    };
  }

  function describeEvent(event, room) {
    const member = room.members.find((item) => item.userId === event.userId);
    const name = member?.name || "系统";
    if (event.type === "message") return `${name} 发来一条消息`;
    if (event.type === "progress") return `${name} 更新到 ${event.info || "新的进度"}`;
    if (event.type === "user-joined") return `${name} 进入房间`;
    if (event.type === "user-returned") return `${name} 重新上线`;
    if (event.type === "user-left") return `${name} 离开房间`;
    if (event.type === "user-offline") return `${name} 暂时离线`;
    if (event.type === "room-closed") return `${name} 关闭了房间`;
    if (event.type === "room-completed") return "你们完成了本次共读";
    return `${name} 有新的动态`;
  }

  function renderActivitySummary(room) {
    const filter = state.activityFilter;
    const items = (room.events || [])
      .filter((event) => ["message", "progress", "user-joined", "user-returned", "user-left", "user-offline", "room-closed", "room-completed"].includes(event.type))
      .filter((event) => filter === "all" || getActivityCategory(event) === filter)
      .slice(-6)
      .reverse();

    if (!items.length) {
      return `<div class="empty-text">这里会汇总最近的消息、进度和在线状态变化。</div>`;
    }

    return items.map((event) => `
      <div class="activity-item">
        <div class="activity-dot"></div>
        <div>
          <div class="message-body">${escapeHtml(describeEvent(event, room))}</div>
          <div class="message-meta">${formatTime(event.at)}</div>
        </div>
      </div>
    `).join("");
  }

  function pageChrome(title, body, rightActionHtml = "") {
    return `
      <div class="topbar">
        <div>
          <div class="meta-kicker">一起阅读</div>
          <h1 class="section-title">${escapeHtml(title)}</h1>
        </div>
        <div class="action-row">
          ${rightActionHtml}
          <button class="button ghost" data-nav="/">回首页</button>
        </div>
      </div>
      ${body}
    `;
  }

  function renderRecordCards(records) {
    return records.length
      ? records.map((item) => `
          <div class="record-card">
            <h3>${escapeHtml(item.title)}</h3>
            <div class="record-meta">${formatDateTime(item.at)} · 房间 ${item.roomCode}</div>
            <p>${item.durationMinutes} 分钟 · ${item.totalMessages} 条聊天 · ${escapeHtml(item.waitSummary)}</p>
            <p class="record-meta">${(item.members || []).map((member) => `${member.name} ${Number(member.maxProgress || 0).toFixed(1)}%`).join(" / ")}</p>
          </div>
        `).join("")
      : `<div class="record-card"><p class="empty-text">还没有共读记录。你可以先开一个房间，再用另一台设备加入。</p></div>`;
  }

  function renderHome() {
    const activeRoomId = loadActiveRoomId();
    const user = state.user;
    const storyCards = state.stories.map((story) => `
      <div class="story-card">
        <div class="tag">${story.cover}</div>
        <h3>${escapeHtml(story.title)}</h3>
        <div class="story-meta">${escapeHtml(story.author)} · ${story.wordCount} 字</div>
        <p>${escapeHtml(story.summary)}</p>
      </div>
    `).join("");

    const recordsHtml = renderRecordCards(state.records.slice(0, 4));

    app.innerHTML = `
      <section class="hero-card">
        <div class="hero-kicker">后端联通版</div>
        <h1 class="hero-title">一起阅读</h1>
        <p class="hero-copy">两个人看同一篇内容，实时看到彼此的阅读进度、消息和在线状态。现在不再强制同步，只保留一起读的体验。</p>
        <div class="stats-grid">
          <div class="stat-pill"><span>当前身份<strong>${user ? escapeHtml(user.name) : "未登录"}</strong></span></div>
          <div class="stat-pill"><span>内容数量<strong>${state.stories.length} 篇</strong></span></div>
          <div class="stat-pill"><span>房间恢复<strong>${activeRoomId ? "可回到上次房间" : "暂无"}</strong></span></div>
        </div>
        <div class="button-row">
          <button class="button primary" data-nav="/create">创建房间</button>
          <button class="button secondary" data-nav="/join">加入房间</button>
          ${activeRoomId ? `<button class="button secondary" id="resume-room">回到上次房间</button>` : ""}
          <button class="button ghost" id="rename-user">改个昵称</button>
        </div>
      </section>

      <section class="panel" style="margin-top: 18px;">
        <div class="section-kicker">内置内容</div>
        <h2 class="section-title">先选一篇一起读的</h2>
        <div class="card-grid">${storyCards}</div>
      </section>

      <section class="panel" style="margin-top: 18px;">
        <div class="section-kicker">最近记录</div>
        <h2 class="section-title">已经完成的房间</h2>
        <div class="record-list">${recordsHtml}</div>
        <div class="button-row" style="margin-top: 16px;">
          <button class="button secondary" data-nav="/records">查看全部记录</button>
        </div>
      </section>
    `;

    document.getElementById("rename-user").addEventListener("click", async () => {
      const currentName = state.user?.name || "";
      const nextName = window.prompt("输入你的昵称（12 字以内）", currentName);
      if (!nextName) return;
      const trimmed = nextName.trim().slice(0, 12);
      if (!trimmed) return;
      await ensureServerUser(trimmed);
      render();
    });

    const resumeButton = document.getElementById("resume-room");
    if (resumeButton) {
      resumeButton.addEventListener("click", () => navigate("/room", { room: activeRoomId }));
    }
  }

  function renderRecords() {
    app.innerHTML = pageChrome(
      "历史记录",
      `
        <section class="panel">
          <div class="section-kicker">最近房间</div>
          <h2 class="section-title">共读记录中心</h2>
          <p class="hero-copy">这里汇总已完成或已关闭且有实际活动的房间，方便回看阅读时长、聊天数量和双方最高进度。</p>
          <div class="record-list" style="margin-top: 18px;">${renderRecordCards(state.records)}</div>
        </section>
      `
    );
  }

  function renderCreate() {
    const initialStory = state.stories[0];
    app.innerHTML = pageChrome(
      "创建房间",
      `
        <section class="panel">
          <div class="section-kicker">先选一篇一起读</div>
          <form id="create-form" class="form-stack">
            <div class="field">
              <label>你的昵称</label>
              <input class="text-input" id="user-name" maxlength="12" value="${escapeHtml(state.user?.name || "")}" />
            </div>
            <div class="field">
              <label>阅读内容</label>
              <div class="card-grid" id="story-options">
                ${state.stories.map((story, index) => `
                  <button type="button" class="story-card ${index === 0 ? "selected" : ""}" data-story="${story.id}">
                    <div class="tag">${story.cover}</div>
                    <h3>${escapeHtml(story.title)}</h3>
                    <div class="story-meta">${story.wordCount} 字 · ${escapeHtml(story.author)}</div>
                    <p>${escapeHtml(story.summary)}</p>
                  </button>
                `).join("")}
              </div>
            </div>
            <div class="field">
              <label>进度参考</label>
              <div class="chip-row" id="threshold-options">
                ${state.waitOptions.map((value) => `
                  <button type="button" class="threshold-chip ${value === 8 ? "active" : ""}" data-threshold="${value}">
                    ${value}% 参考线
                  </button>
                `).join("")}
              </div>
              <div class="muted">这里只做阅读节奏参考，不再强制等待或回退页面。</div>
            </div>
            <div class="reader-grid">
              <div class="record-card" style="flex: 1 1 240px;">
                <div class="meta-kicker">内容预览</div>
                <h3 id="selected-title">${escapeHtml(initialStory.title)}</h3>
                <p id="selected-summary">${escapeHtml(initialStory.summary)}</p>
              </div>
              <div class="record-card" style="flex: 1 1 240px;">
                <div class="meta-kicker">房间保留</div>
                <h3>支持断线重连</h3>
                <p>房间创建后会保留，你返回首页或掉线后，用同一个身份还能继续进入。</p>
              </div>
            </div>
            <div class="button-row">
              <button class="button primary" type="submit">创建房间</button>
              <button class="button secondary" type="button" data-nav="/join">我已有房间码</button>
            </div>
          </form>
        </section>
      `
    );

    let storyId = initialStory.id;
    let threshold = 8;

    document.querySelectorAll("[data-story]").forEach((node) => {
      node.addEventListener("click", () => {
        storyId = node.getAttribute("data-story");
        const story = getStory(storyId);
        document.querySelectorAll("[data-story]").forEach((el) => el.classList.remove("selected"));
        node.classList.add("selected");
        document.getElementById("selected-title").textContent = story.title;
        document.getElementById("selected-summary").textContent = story.summary;
      });
    });

    document.querySelectorAll("[data-threshold]").forEach((node) => {
      node.addEventListener("click", () => {
        threshold = Number(node.getAttribute("data-threshold"));
        document.querySelectorAll("[data-threshold]").forEach((el) => el.classList.remove("active"));
        node.classList.add("active");
      });
    });

    document.getElementById("create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = document.getElementById("user-name").value.trim().slice(0, 12);
      const user = await ensureServerUser(name);
      const data = await request(buildApiUrl("/api/rooms"), {
        method: "POST",
        body: JSON.stringify({
          userId: user.id,
          name: user.name,
          storyId,
          threshold
        })
      });
      state.user = data.user;
      saveSessionUser(data.user);
      state.room = data.room;
      saveActiveRoomId(data.room.id);
      navigate("/waiting", { room: data.room.id });
    });
  }

  function renderJoin(prefillCode = "") {
    app.innerHTML = pageChrome(
      "加入房间",
      `
        <section class="panel">
          <div class="section-kicker">输入房间码</div>
          <form id="join-form" class="form-stack">
            <div class="field">
              <label>你的昵称</label>
              <input class="text-input" id="join-user-name" maxlength="12" value="${escapeHtml(state.user?.name || "")}" />
            </div>
            <div class="field">
              <label>房间码</label>
              <input class="text-input" id="room-code-input" maxlength="6" placeholder="例如 AB12CD" value="${escapeHtml(prefillCode)}" />
            </div>
            <div class="button-row">
              <button class="button primary" type="submit">加入房间</button>
              <button class="button secondary" type="button" data-nav="/create">先去创建房间</button>
            </div>
            <div class="empty-text" id="join-error"></div>
          </form>
        </section>
      `
    );

    document.getElementById("join-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = document.getElementById("join-user-name").value.trim().slice(0, 12);
      const code = document.getElementById("room-code-input").value.trim().toUpperCase();
      const errorNode = document.getElementById("join-error");
      errorNode.textContent = "";

      try {
        const user = await ensureServerUser(name);
        const data = await request(buildApiUrl("/api/rooms/join"), {
          method: "POST",
          body: JSON.stringify({
            userId: user.id,
            name: user.name,
            code
          })
        });
        state.user = data.user;
        saveSessionUser(data.user);
        state.room = data.room;
        saveActiveRoomId(data.room.id);
        navigate("/room", { room: data.room.id });
      } catch (error) {
        if (error.message === "room_not_found") {
          errorNode.textContent = "没有找到这个房间码。";
        } else if (error.message === "room_full") {
          errorNode.textContent = "这个房间已经有两位成员了。";
        } else if (error.message === "room_ended") {
          errorNode.textContent = "这个房间已经结束。";
        } else if (error.message === "not_room_member") {
          errorNode.textContent = "这个房间已经保留给原来的成员，当前身份无法直接进入。";
        } else {
          errorNode.textContent = "加入房间失败，请稍后再试。";
        }
      }
    });
  }

  function renderWaiting(room) {
    const story = room.story;
    app.innerHTML = `
      <section class="panel waiting-shell centered-copy">
        <div class="section-kicker">房间已经准备好了</div>
        <h1 class="section-title">把房间码发给 TA</h1>
        <p class="hero-copy" style="margin: 0 auto;">另一位用户访问同一个地址，输入房间码，就能和你一起进入这篇内容。</p>
        <div class="code-box">${room.code}</div>
        <div class="button-row" style="justify-content:center;">
          <button class="button primary" id="copy-room-code">复制房间码</button>
          <button class="button secondary" id="copy-invite-link">复制邀请链接</button>
          <button class="button secondary" data-nav="/join">去加入页试一下</button>
          ${room.ownerId === state.user.id ? `<button class="button ghost" id="close-room-waiting">关闭房间</button>` : ""}
          <button class="button ghost" id="leave-room">返回首页</button>
        </div>
      </section>
      <section class="panel waiting-shell" style="margin-top: 18px;">
        <div class="reader-grid">
          <div class="record-card" style="flex: 1 1 280px;">
            <div class="meta-kicker">当前内容</div>
            <h3>${escapeHtml(story.title)}</h3>
            <p>${escapeHtml(story.summary)}</p>
          </div>
          <div class="record-card" style="flex: 1 1 280px;">
            <div class="meta-kicker">房间说明</div>
            <h3>房间会保留</h3>
            <p>房主回到首页后，仍然可以用当前身份重新进入这个房间。</p>
          </div>
        </div>
        <div class="notice-card" style="margin-top: 18px;">
          <h3>正在等待对方加入…</h3>
          <p>如果你暂时离开，这个房间会继续保留。重新打开后用同一个身份还能回来。</p>
        </div>
      </section>
    `;

    document.getElementById("copy-room-code").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(room.code);
        toast("已复制房间码", `把 ${room.code} 发给 TA 就行。`);
      } catch {
        toast("复制失败", "当前环境不支持自动复制。");
      }
    });

    document.getElementById("copy-invite-link").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(buildInviteLink(room.code));
        toast("已复制邀请链接", "对方打开链接后会直接带上房间码。");
      } catch {
        toast("复制失败", "当前环境不支持自动复制。");
      }
    });

    const closeWaitingButton = document.getElementById("close-room-waiting");
    if (closeWaitingButton) {
      closeWaitingButton.addEventListener("click", async () => {
        const confirmed = window.confirm("关闭后，这个房间将不能继续加入。确定关闭吗？");
        if (!confirmed) return;
        await request(buildApiUrl(`/api/rooms/${room.id}/close`), {
          method: "POST",
          body: JSON.stringify({ userId: state.user.id, name: state.user.name })
        });
        await refreshRecords();
        saveActiveRoomId("");
        state.room = null;
        disconnectRealtime();
        toast("房间已关闭", "这个房间已经结束。");
        navigate("/");
      });
    }

    document.getElementById("leave-room").addEventListener("click", async () => {
      await request(buildApiUrl(`/api/rooms/${room.id}/leave`), {
        method: "POST",
        body: JSON.stringify({ userId: state.user.id, name: state.user.name })
      });
      state.room = null;
      disconnectRealtime();
      navigate("/");
    });
  }

  function renderMessages(room) {
    if (!room.chat.length) {
      return `<div class="empty-text">还没有消息。可以先发一句开始聊天。</div>`;
    }
    return room.chat.map((message) => `
      <div class="message ${message.userId === state.user.id ? "self" : ""}">
        <div class="message-meta">${escapeHtml(message.userName)} · ${formatTime(message.createdAt)}</div>
        <div class="message-body">${escapeHtml(message.content)}</div>
      </div>
    `).join("");
  }

  function roomMarkup(room) {
    const story = room.story;
    const myProgress = getMyProgress(room);
    const otherMember = getOtherMember(room);
    const otherProgress = getOtherProgress(room);
    const difference = room.waitState?.diff || 0;
    const summary = computeChatSummary(room);

    return `
      <div class="reader-layout">
        <aside class="reader-side">
          <section class="sidebar-card">
            <div class="meta-kicker">当前状态</div>
            <div class="reader-grid">
              <div class="status-chip" id="chip-room-code">房间 ${room.code}</div>
              <div class="status-chip ${otherMember?.online ? "online" : ""}" id="chip-online">
                ${escapeHtml(describeMemberPresence(otherMember))}
              </div>
              <div class="status-chip ${myProgress.done ? "done" : ""}" id="chip-status">
                ${myProgress.done ? "我已读完" : "一起阅读中"}
              </div>
            </div>
            <div class="progress-grid" style="margin-top: 14px;">
              <div class="record-card">
                <div class="meta-kicker">我的进度</div>
                <h3 id="my-progress-text">${myProgress.maxProgress.toFixed(1)}%</h3>
                <div class="progress-bar"><div class="progress-fill" id="my-progress-bar" style="width:${myProgress.maxProgress}%;"></div></div>
              </div>
              <div class="record-card">
                <div class="meta-kicker">TA 的进度</div>
                <h3 id="other-progress-text">${otherProgress ? `${otherProgress.maxProgress.toFixed(1)}%` : "--"}</h3>
                <div class="progress-bar"><div class="progress-fill" id="other-progress-bar" style="width:${otherProgress ? otherProgress.maxProgress : 0}%;"></div></div>
              </div>
              <div class="record-card">
                <div class="meta-kicker">当前差距</div>
                <h3 id="diff-text">${difference}%</h3>
                <p class="record-meta">只做节奏参考</p>
              </div>
            </div>
          </section>

          <section class="sidebar-card">
            <div class="meta-kicker">聊天概览</div>
            <p class="record-meta" id="chat-summary-count">共 ${summary.total} 条 · 我发了 ${summary.mine} 条 · TA 发了 ${summary.other} 条</p>
            <p class="record-meta" id="chat-summary-recent">${escapeHtml(summary.recent)}</p>
          </section>

          <section class="sidebar-card">
            <div class="meta-kicker">动态汇总</div>
            <div class="quick-actions activity-filters" id="activity-filters">
              ${renderActivityFilters()}
            </div>
            <div class="activity-list" id="activity-summary">
              ${renderActivitySummary(room)}
            </div>
          </section>

          <section class="sidebar-card">
            <div class="meta-kicker">聊天</div>
            <h3>${otherMember ? `和 ${escapeHtml(otherMember.name)} 聊两句` : "房间聊天"}</h3>
            <div class="messages" id="message-list">
              ${renderMessages(room)}
            </div>
            <div class="quick-actions" style="margin-top: 14px; flex-wrap: wrap;">
              ${state.quickMessages.map((text) => `
                <button type="button" class="shortcut-chip" data-quick="${escapeHtml(text)}">${escapeHtml(text)}</button>
              `).join("")}
            </div>
            <form id="chat-form" class="form-stack" style="margin-top: 14px;">
              <textarea class="textarea-input" id="chat-input" maxlength="200" placeholder="输入你想说的话，最多 200 字"></textarea>
              <button class="button primary" type="submit">发送消息</button>
            </form>
          </section>

          <section class="sidebar-card">
            <div class="meta-kicker">本局记录</div>
            <p class="record-meta">创建于 <span id="created-at">${formatDateTime(room.createdAt)}</span></p>
            <p class="record-meta" id="room-summary-text">累计聊天 ${room.chat.length} 条 · 已读到 ${myProgress.maxProgress.toFixed(1)}%</p>
            <div class="button-row">
              <button class="button secondary" id="mark-complete" ${myProgress.done ? "disabled" : ""}>标记我已读完</button>
              <button class="button ghost" id="leave-current-room">返回首页</button>
            </div>
          </section>
        </aside>

        <div class="reader-main">
          <section class="reader-card">
            <div class="notice-anchor">
              <div class="notice-card success" id="room-notice">
                <h3 id="notice-title">一起读就行。</h3>
                <p id="notice-body">${otherMember ? `你们当前进度差 ${difference}% ，这里只做参考展示，不会强制拦截阅读。` : "对方加入后，你们就能看到彼此的进度和消息动态。"}</p>
              </div>
              <div id="left-notice" style="display:none;"></div>
              <div class="live-feed" id="live-feed"></div>
            </div>

            <div class="reader-scroll" id="reader-scroll">
              <div class="reader-header">
                <div class="meta-kicker">${story.cover} · ${escapeHtml(story.author)}</div>
                <h2>${escapeHtml(story.title)}</h2>
                <p class="hero-copy" style="margin:0;">${escapeHtml(story.summary)}</p>
              </div>
              <div class="reader-body">
                ${story.body.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}
              </div>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function renderRoom(room) {
    const roomActions = [
      `<button class="button secondary" id="copy-code-inline">复制房间码</button>`,
      `<button class="button secondary" id="copy-invite-inline">复制邀请链接</button>`
    ];
    if (room.ownerId === state.user.id) {
      roomActions.push(`<button class="button ghost" id="close-room-inline">关闭房间</button>`);
    }

    app.innerHTML = pageChrome(
      room.story.title,
      roomMarkup(room),
      roomActions.join("")
    );

    bindReader(room);
    bindChat(room);
    startRelativeTimeTicker();

    document.getElementById("mark-complete").addEventListener("click", async () => {
      const data = await request(buildApiUrl(`/api/rooms/${room.id}/complete`), {
        method: "POST",
        body: JSON.stringify({ userId: state.user.id, name: state.user.name })
      });
      const prev = state.room;
      state.room = data.room;
      if (data.room.status === "completed") {
        state.records = (await request(buildApiUrl("/api/records"))).records;
        navigate("/done", { room: room.id });
      } else {
        patchRoomDom(data.room, prev);
      }
    });

    document.getElementById("leave-current-room").addEventListener("click", async () => {
      await request(buildApiUrl(`/api/rooms/${room.id}/leave`), {
        method: "POST",
        body: JSON.stringify({ userId: state.user.id, name: state.user.name })
      });
      disconnectRealtime();
      state.room = null;
      navigate("/");
    });

    document.getElementById("copy-code-inline").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(room.code);
        toast("已复制房间码", `${room.code} 已经在剪贴板里。`);
      } catch {
        toast("复制失败", "当前环境不支持自动复制。");
      }
    });

    document.getElementById("copy-invite-inline").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(buildInviteLink(room.code));
        toast("已复制邀请链接", "对方打开链接后会直接带上房间码。");
      } catch {
        toast("复制失败", "当前环境不支持自动复制。");
      }
    });

    const closeRoomButton = document.getElementById("close-room-inline");
    if (closeRoomButton) {
      closeRoomButton.addEventListener("click", async () => {
        const confirmed = window.confirm("关闭后，这个房间将不能继续加入。确定关闭吗？");
        if (!confirmed) return;
        await request(buildApiUrl(`/api/rooms/${room.id}/close`), {
          method: "POST",
          body: JSON.stringify({ userId: state.user.id, name: state.user.name })
        });
        await refreshRecords();
        saveActiveRoomId("");
        disconnectRealtime();
        state.room = null;
        toast("房间已关闭", "这个房间已经结束。");
        navigate("/");
      });
    }
  }

  function addLiveBurst(text, type = "info") {
    const feed = document.getElementById("live-feed");
    if (!feed) return;

    const now = Date.now();
    const cooldownByType = {
      mine: 1400,
      progress: 2200,
      chat: 900,
      info: 1600,
      warn: 1800
    };
    const cooldown = cooldownByType[type] || 1500;
    const lastAt = state.liveBurstMeta[type] || 0;
    if (now - lastAt < cooldown) return;
    state.liveBurstMeta[type] = now;

    while (feed.childElementCount >= 2) {
      feed.firstElementChild?.remove();
    }

    const node = document.createElement("div");
    node.className = `live-burst ${type}`;
    node.textContent = text;
    node.style.top = `${8 + Math.random() * 96}px`;
    feed.appendChild(node);
    const timer = setTimeout(() => node.remove(), 4200);
    state.liveFeedTimers.push(timer);
  }

  function refreshRelativeTimeDom() {
    if (state.routePath !== "/room" || !state.room) return;
    const otherMember = getOtherMember(state.room);
    const chipOnline = document.getElementById("chip-online");
    if (chipOnline) {
      chipOnline.textContent = describeMemberPresence(otherMember);
      chipOnline.className = `status-chip ${otherMember?.online ? "online" : ""}`;
    }
  }

  function startRelativeTimeTicker() {
    if (state.relativeTimeTimer) {
      clearInterval(state.relativeTimeTimer);
    }
    refreshRelativeTimeDom();
    state.relativeTimeTimer = setInterval(refreshRelativeTimeDom, 60_000);
  }

  function stopRelativeTimeTicker() {
    if (state.relativeTimeTimer) {
      clearInterval(state.relativeTimeTimer);
      state.relativeTimeTimer = null;
    }
  }

  function patchRoomDom(room, prevRoom) {
    state.room = room;
    const myProgress = getMyProgress(room);
    const otherMember = getOtherMember(room);
    const otherProgress = getOtherProgress(room);
    const difference = room.waitState?.diff || 0;
    const summary = computeChatSummary(room);

    const chipOnline = document.getElementById("chip-online");
    const chipStatus = document.getElementById("chip-status");
    const myText = document.getElementById("my-progress-text");
    const otherText = document.getElementById("other-progress-text");
    const myBar = document.getElementById("my-progress-bar");
    const otherBar = document.getElementById("other-progress-bar");
    const diffText = document.getElementById("diff-text");
    const roomSummary = document.getElementById("room-summary-text");
    const summaryCount = document.getElementById("chat-summary-count");
    const summaryRecent = document.getElementById("chat-summary-recent");
    const activitySummary = document.getElementById("activity-summary");
    const roomNotice = document.getElementById("room-notice");
    const noticeTitle = document.getElementById("notice-title");
    const noticeBody = document.getElementById("notice-body");
    const messageList = document.getElementById("message-list");

    if (chipOnline) {
      chipOnline.textContent = describeMemberPresence(otherMember);
      chipOnline.className = `status-chip ${otherMember?.online ? "online" : ""}`;
    }
    if (chipStatus) {
      chipStatus.textContent = myProgress.done ? "我已读完" : "一起阅读中";
      chipStatus.className = `status-chip ${myProgress.done ? "done" : ""}`;
    }
    if (myText) myText.textContent = `${myProgress.maxProgress.toFixed(1)}%`;
    if (otherText) otherText.textContent = otherProgress ? `${otherProgress.maxProgress.toFixed(1)}%` : "--";
    if (myBar) myBar.style.width = `${myProgress.maxProgress}%`;
    if (otherBar) otherBar.style.width = `${otherProgress ? otherProgress.maxProgress : 0}%`;
    if (diffText) diffText.textContent = `${difference}%`;
    if (roomSummary) roomSummary.textContent = `累计聊天 ${room.chat.length} 条 · 已读到 ${myProgress.maxProgress.toFixed(1)}%`;
    if (summaryCount) summaryCount.textContent = `共 ${summary.total} 条 · 我发了 ${summary.mine} 条 · TA 发了 ${summary.other} 条`;
    if (summaryRecent) summaryRecent.textContent = summary.recent;
    if (activitySummary) activitySummary.innerHTML = renderActivitySummary(room);

    if (roomNotice && noticeTitle && noticeBody) {
      roomNotice.className = "notice-card success";
      noticeTitle.textContent = "一起读就行。";
      noticeBody.textContent = otherMember
        ? `你们当前进度差 ${difference}% ，这里只做参考展示，不会强制拦截阅读。`
        : "对方加入后，你们就能看到彼此的进度和消息动态。";
    }

    if (messageList) {
      const oldCount = prevRoom?.chat?.length || 0;
      const newCount = room.chat.length;
      const oldLastId = prevRoom?.chat?.[oldCount - 1]?.id || "";
      const newLastId = room.chat[newCount - 1]?.id || "";
      const shouldStickBottom = messageList.scrollTop + messageList.clientHeight >= messageList.scrollHeight - 32;
      if (newCount !== oldCount || newLastId !== oldLastId) {
        messageList.innerHTML = renderMessages(room);
        if (shouldStickBottom) {
          messageList.scrollTop = messageList.scrollHeight;
        }
        const lastMessage = room.chat[room.chat.length - 1];
        if (lastMessage && (!prevRoom || !prevRoom.chat.find((item) => item.id === lastMessage.id))) {
          addLiveBurst(`${lastMessage.userName}：${lastMessage.content}`, lastMessage.userId === state.user.id ? "mine" : "chat");
        }
      }
    }

    const prevMine = prevRoom?.progress?.[state.user.id];
    const prevOther = prevRoom ? getOtherProgress(prevRoom) : null;
    if (prevMine && myProgress.maxProgress - prevMine.maxProgress >= 4) {
      addLiveBurst(`我读到了 ${myProgress.maxProgress.toFixed(1)}%`, "mine");
    }
    if (prevOther && otherProgress && otherProgress.maxProgress - prevOther.maxProgress >= 4) {
      addLiveBurst(`${otherMember?.name || "TA"} 读到了 ${otherProgress.maxProgress.toFixed(1)}%`, "progress");
    }
  }

  function bindReader(room) {
    const reader = document.getElementById("reader-scroll");
    const myProgress = getMyProgress(room);
    const ratio = Math.max(0, Math.min(1, (myProgress.maxProgress || 0) / 100));
    const maxScroll = Math.max(0, reader.scrollHeight - reader.clientHeight);
    reader.scrollTop = ratio * maxScroll;

    let pending = false;
    let lastSent = myProgress.maxProgress || 0;

    reader.addEventListener("scroll", () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const currentRoom = state.room;
        if (!currentRoom) return;
        const scrollMax = Math.max(1, reader.scrollHeight - reader.clientHeight);
        const raw = (reader.scrollTop / scrollMax) * 100;
        const target = Math.max(0, Math.min(100, raw));
        const reported = Math.max(getMyProgress(currentRoom).maxProgress, target);

        if (reported <= getMyProgress(currentRoom).maxProgress + 0.1) return;
        if (reported <= lastSent + 0.15) return;

        lastSent = Number(reported.toFixed(1));
        const optimisticPrev = cloneData(currentRoom);
        currentRoom.progress[state.user.id].progress = target;
        currentRoom.progress[state.user.id].maxProgress = Math.max(currentRoom.progress[state.user.id].maxProgress, lastSent);
        patchRoomDom(currentRoom, optimisticPrev);
        queueProgressFlush(currentRoom.id, lastSent);
      });
    }, { passive: true });
  }

  function queueProgressFlush(roomId, progress) {
    state.queuedProgressValue = progress;
    if (state.progressFlushTimer) {
      clearTimeout(state.progressFlushTimer);
    }

    const delay = Date.now() - state.lastProgressSentAt > 180 ? 0 : 120;
    state.progressFlushTimer = setTimeout(() => {
      state.progressFlushTimer = null;
      flushProgress(roomId);
    }, delay);
  }

  async function flushProgress(roomId) {
    if (state.progressInFlight || state.queuedProgressValue == null || !state.user?.id) return;

    const progress = state.queuedProgressValue;
    state.queuedProgressValue = null;
    state.progressInFlight = true;
    state.lastProgressSentAt = Date.now();

    try {
      const data = await request(buildApiUrl(`/api/rooms/${roomId}/progress`), {
        method: "POST",
        timeoutMs: 3500,
        body: JSON.stringify({
          userId: state.user.id,
          name: state.user.name,
          progress
        })
      });
      if (data.room?.status === "completed") {
        state.room = data.room;
        state.records = (await request(buildApiUrl("/api/records"))).records;
        navigate("/done", { room: roomId });
      } else if (data.progress) {
        applyProgressEvent({
          userId: data.userId || state.user.id,
          progress: data.progress,
          waitState: data.waitState,
          updatedAt: data.updatedAt
        });
      }
    } catch (error) {
      if (!isPermanentQueueError(error)) {
        enqueueOutboxItem({
          type: "progress",
          roomId,
          progress
        });
        notifyQueued();
      } else {
        toast("进度同步失败", "这个进度已经无法同步，请刷新房间状态。");
      }
    } finally {
      state.progressInFlight = false;
      if (state.queuedProgressValue != null && state.queuedProgressValue > progress) {
        flushProgress(roomId);
      }
    }
  }

  function bindChat(room) {
    const list = document.getElementById("message-list");
    list.scrollTop = list.scrollHeight;

    document.getElementById("chat-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("chat-input");
      const content = input.value.trim();
      if (!content) {
        toast("消息没发出去", "空消息发不出去。");
        return;
      }
      if (content.length > 200) {
        toast("消息没发出去", "一条消息最多 200 字。");
        return;
      }
      if (Date.now() - state.lastMessageAt < 450) {
        toast("发送太快了", "等一下再发。");
        return;
      }

      state.lastMessageAt = Date.now();
      const optimisticPrev = cloneData(state.room);
      const optimisticMessage = {
        id: `local-${Date.now()}`,
        userId: state.user.id,
        userName: state.user.name,
        content,
        createdAt: new Date().toISOString()
      };
      state.room.chat.push(optimisticMessage);
      patchRoomDom(state.room, optimisticPrev);
      addLiveBurst(`我：${content}`, "mine");
      input.value = "";

      try {
        const data = await request(buildApiUrl(`/api/rooms/${room.id}/messages`), {
          method: "POST",
          timeoutMs: 3500,
          body: JSON.stringify({
            userId: state.user.id,
            name: state.user.name,
            clientId: optimisticMessage.id,
            content
          })
        });
        if (data.room) {
          const prev = state.room;
          state.room = data.room;
          patchRoomDom(data.room, prev);
        } else {
          applyMessageEvent(data);
        }
      } catch (error) {
        if (!isPermanentQueueError(error)) {
          enqueueOutboxItem({
            type: "message",
            roomId: room.id,
            content,
            localId: optimisticMessage.id
          });
          notifyQueued();
          return;
        }
        toast("消息发送失败", "这条消息已经无法发送，请刷新房间状态。");
      }
    });

    document.querySelectorAll("[data-quick]").forEach((node) => {
      node.addEventListener("click", async () => {
        const content = node.textContent;
        if (Date.now() - state.lastMessageAt < 450) {
          toast("发送太快了", "等一下再发。");
          return;
        }
        state.lastMessageAt = Date.now();

        const optimisticPrev = cloneData(state.room);
        const optimisticMessage = {
          id: `local-${Date.now()}`,
          userId: state.user.id,
          userName: state.user.name,
          content,
          createdAt: new Date().toISOString()
        };
        state.room.chat.push(optimisticMessage);
        patchRoomDom(state.room, optimisticPrev);
        addLiveBurst(`我：${content}`, "mine");

        try {
          const data = await request(buildApiUrl(`/api/rooms/${room.id}/messages`), {
            method: "POST",
            timeoutMs: 3500,
            body: JSON.stringify({
              userId: state.user.id,
              name: state.user.name,
              clientId: optimisticMessage.id,
              content
            })
          });
          if (data.room) {
            const prev = state.room;
            state.room = data.room;
            patchRoomDom(data.room, prev);
          } else {
            applyMessageEvent(data);
          }
        } catch (error) {
          if (!isPermanentQueueError(error)) {
            enqueueOutboxItem({
              type: "message",
              roomId: room.id,
              content,
              localId: optimisticMessage.id
            });
            notifyQueued();
            return;
          }
          toast("消息发送失败", "这条消息已经无法发送，请刷新房间状态。");
        }
      });
    });
  }

  function renderDone(room) {
    const members = room.members.filter((member) => room.progress[member.userId]);
    app.innerHTML = `
      <section class="panel completion-shell centered-copy">
        <div class="section-kicker">阅读完成</div>
        <h1 class="section-title">你们一起读完啦</h1>
        <p class="hero-copy" style="margin: 0 auto;">这次共读持续了 ${minutesBetween(room.createdAt, room.endedAt || room.updatedAt)} 分钟，一共发了 ${room.chat.length} 条消息。</p>
        <div class="stats-grid" style="justify-content:center;">
          <div class="stat-pill"><span>房间码<strong>${room.code}</strong></span></div>
          <div class="stat-pill"><span>内容标题<strong>${escapeHtml(room.storyTitle)}</strong></span></div>
        </div>
      </section>
      <section class="panel completion-shell" style="margin-top: 18px;">
        <div class="card-grid">
          ${members.map((member) => {
            const progress = room.progress[member.userId];
            return `
              <div class="record-card">
                <div class="meta-kicker">${escapeHtml(member.name)}</div>
                <h3>${progress.maxProgress.toFixed(1)}%</h3>
                <p>最高进度 ${progress.maxProgress.toFixed(1)}% · 最后在线 ${formatTime(member.lastSeenAt)}</p>
              </div>
            `;
          }).join("")}
        </div>
        <div class="button-row" style="margin-top: 18px; justify-content:center;">
          <button class="button primary" data-nav="/">返回首页</button>
          <button class="button secondary" data-nav="/create">再开一局</button>
        </div>
      </section>
    `;
  }

  function bindGlobalEvents() {
    document.querySelectorAll("[data-nav]").forEach((node) => {
      node.addEventListener("click", () => navigate(node.getAttribute("data-nav")));
    });
    document.querySelectorAll("[data-activity-filter]").forEach((node) => {
      node.addEventListener("click", () => {
        state.activityFilter = node.getAttribute("data-activity-filter") || "all";
        document.querySelectorAll("[data-activity-filter]").forEach((item) => {
          item.classList.toggle("active", item === node);
        });
        const summary = document.getElementById("activity-summary");
        if (summary && state.room) {
          summary.innerHTML = renderActivitySummary(state.room);
        }
      });
    });
  }

  function maybeAnnounceRoomChanges(nextRoom) {
    const prev = state.lastRoomSnapshot;
    if (!prev || prev.id !== nextRoom.id) {
      if (nextRoom.ownerId === state.user?.id && nextRoom.activeMembers.length < 2 && state.routePath === "/waiting") {
        toast("房间已恢复", "你正在使用之前的身份继续等待对方加入。");
      }
      state.lastRoomSnapshot = nextRoom;
      return;
    }

    const prevOther = prev.activeMembers.find((member) => member.userId !== state.user.id);
    const nextOther = nextRoom.activeMembers.find((member) => member.userId !== state.user.id);

    if (prev.activeMembers.length < nextRoom.activeMembers.length && nextOther) {
      toast("TA 进来了", `${nextOther.name} 已经加入房间，可以开始一起读。`);
      addLiveBurst(`${nextOther.name} 进入房间`, "info");
    }
    if (prevOther && !prevOther.online && nextOther && nextOther.online) {
      toast("TA 回来了", `${nextOther.name} 已恢复连接，可以继续一起阅读。`);
      addLiveBurst(`${nextOther.name} 已重新连接`, "info");
    }
    if (prevOther && nextOther && prevOther.online && !nextOther.online) {
      toast("TA 暂时断线了", "你可以先继续读，TA 之后还能回来。");
    }
    if (prev.status !== nextRoom.status && nextRoom.status === "closed") {
      toast("房间已关闭", "房主已经关闭这个房间。");
    }

    state.lastRoomSnapshot = nextRoom;
  }

  function disconnectRealtime() {
    stopRelativeTimeTicker();
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    if (state.progressFlushTimer) {
      clearTimeout(state.progressFlushTimer);
      state.progressFlushTimer = null;
    }
    state.progressInFlight = false;
    state.queuedProgressValue = null;
    state.liveFeedTimers.forEach((timer) => clearTimeout(timer));
    state.liveFeedTimers = [];
    state.liveBurstMeta = {};
  }

  function pushRoomEvent(room, eventItem) {
    if (!eventItem) return;
    room.events = room.events || [];
    if (!room.events.some((item) => item.id === eventItem.id)) {
      room.events.push(eventItem);
      room.events = room.events.slice(-200);
    }
  }

  function updateRoomMember(room, member) {
    if (!member) return;
    const replace = (items) => {
      const index = items.findIndex((item) => item.userId === member.userId);
      if (index >= 0) {
        items[index] = { ...items[index], ...member };
      } else {
        items.push(member);
      }
    };
    replace(room.members);
    room.activeMembers = room.members.filter((item) => !item.leftAt);
  }

  function applyRealtimePatch(mutator) {
    if (!state.room) return;
    const prev = cloneData(state.room);
    mutator(state.room);
    maybeAnnounceRoomChanges(state.room);
    if (state.routePath === "/room" && document.getElementById("reader-scroll")) {
      patchRoomDom(state.room, prev);
    }
  }

  function applyProgressEvent(payload) {
    applyRealtimePatch((room) => {
      room.progress[payload.userId] = payload.progress;
      room.waitState = payload.waitState || room.waitState;
      room.updatedAt = payload.updatedAt || room.updatedAt;
    });
  }

  function applyMessageEvent(payload) {
    applyRealtimePatch((room) => {
      if (payload.message?.userId === state.user.id) {
        const localIndex = room.chat.findIndex((item) => (
          String(item.id).startsWith("local-") &&
          ((payload.message.clientId && item.id === payload.message.clientId) || item.content === payload.message.content)
        ));
        if (localIndex >= 0) {
          room.chat.splice(localIndex, 1);
        }
      }
      if (payload.message && !room.chat.some((item) => item.id === payload.message.id)) {
        room.chat.push(payload.message);
        room.chat = room.chat.slice(-200);
      }
      room.stats = room.stats || {};
      room.stats.totalMessages = payload.totalMessages || room.chat.length;
      room.updatedAt = payload.updatedAt || room.updatedAt;
      pushRoomEvent(room, payload.event);
    });
  }

  function applyPresenceEvent(payload) {
    applyRealtimePatch((room) => {
      updateRoomMember(room, payload.member);
      room.waitState = payload.waitState || room.waitState;
      room.updatedAt = payload.updatedAt || room.updatedAt;
      pushRoomEvent(room, payload.event);
    });
  }

  function connectRealtime(roomId) {
    disconnectRealtime();
    if (!roomId || !state.user?.id) return;

    state.eventSource = new EventSource(buildApiUrl(`/api/rooms/${roomId}/events`));
    state.eventSource.addEventListener("room", async (event) => {
      const payload = JSON.parse(event.data);
      const prev = state.room;
      state.room = payload.room;
      maybeAnnounceRoomChanges(payload.room);
      if (payload.room.status === "closed") {
        await refreshRecords();
        saveActiveRoomId("");
        disconnectRealtime();
        state.room = null;
        navigate("/");
        return;
      }
      if (payload.room.status === "completed") {
        state.records = (await request(buildApiUrl("/api/records"))).records;
        navigate("/done", { room: payload.room.id });
        return;
      }
      if (state.routePath === "/room" && prev && prev.id === payload.room.id && document.getElementById("reader-scroll")) {
        patchRoomDom(payload.room, prev);
      } else {
        render();
      }
    });

    state.eventSource.addEventListener("progress", (event) => {
      applyProgressEvent(JSON.parse(event.data));
    });

    state.eventSource.addEventListener("message", (event) => {
      applyMessageEvent(JSON.parse(event.data));
    });

    state.eventSource.addEventListener("presence", (event) => {
      applyPresenceEvent(JSON.parse(event.data));
    });

    state.eventSource.addEventListener("error", () => {
      const nowTime = Date.now();
      if (nowTime - state.lastRealtimeToastAt > 8000) {
        state.lastRealtimeToastAt = nowTime;
        toast("连接波动", "实时连接正在自动重连。");
      }
    });

    const heartbeat = async () => {
      if (!state.user?.id || !roomId) return;
      try {
        await request(buildApiUrl(`/api/rooms/${roomId}/presence`), {
          method: "POST",
          timeoutMs: 3500,
          body: JSON.stringify({
            userId: state.user.id,
            name: state.user.name
          })
        });
      } catch {
        // Let EventSource reconnect itself.
      }
    };

    heartbeat();
    state.heartbeatTimer = setInterval(heartbeat, 7000);
    scheduleOutboxFlush(0);
  }

  async function syncRoomFromRoute(route) {
    const roomId = route.params.get("room") || loadActiveRoomId();
    if (!roomId) {
      state.room = null;
      disconnectRealtime();
      return null;
    }
    const data = await request(buildApiUrl(`/api/rooms/${roomId}`));
    state.room = data.room;
    saveActiveRoomId(roomId);
    connectRealtime(roomId);
    return data.room;
  }

  async function render() {
    const route = getQuery();
    state.routePath = route.path;
    try {
      if (route.path === "/create") {
        disconnectRealtime();
        renderCreate();
      } else if (route.path === "/join") {
        disconnectRealtime();
        renderJoin(route.params.get("code") || "");
      } else if (route.path === "/waiting") {
        const room = await syncRoomFromRoute(route);
        if (!room) {
          navigate("/join");
          return;
        }
        if (room.status === "closed") {
          await refreshRecords();
          saveActiveRoomId("");
          toast("房间已关闭", "这个房间已经结束。");
          navigate("/");
          return;
        }
        if (room.activeMembers.length >= 2 || room.status === "reading") {
          navigate("/room", { room: room.id });
          return;
        }
        renderWaiting(room);
      } else if (route.path === "/room") {
        const room = await syncRoomFromRoute(route);
        if (!room) {
          navigate("/join");
          return;
        }
        if (room.status === "closed") {
          await refreshRecords();
          saveActiveRoomId("");
          toast("房间已关闭", "这个房间已经结束。");
          navigate("/");
          return;
        }
        if (room.status === "completed") {
          navigate("/done", { room: room.id });
          return;
        }
        renderRoom(room);
      } else if (route.path === "/done") {
        const room = await syncRoomFromRoute(route);
        if (!room) {
          navigate("/");
          return;
        }
        renderDone(room);
      } else if (route.path === "/records") {
        disconnectRealtime();
        await refreshRecords();
        renderRecords();
      } else {
        disconnectRealtime();
        renderHome();
      }

      bindGlobalEvents();
    } catch (error) {
      if (state.routePath === "/room" && error.message === "not_room_member") {
        toast("无法恢复房间", "当前身份不是这个房间的原成员。");
      } else if (error.message === "room_not_found") {
        toast("房间不存在", "保存的房间已经找不到了。");
      } else {
        toast("加载失败", "页面数据加载失败，请刷新重试。");
      }
      if (["room_not_found", "not_room_member"].includes(error.message)) {
        state.room = null;
        saveActiveRoomId("");
        disconnectRealtime();
        navigate("/");
      }
    }
  }

  window.addEventListener("hashchange", render);

  window.addEventListener("online", () => {
    state.networkOnline = true;
    if (state.outbox.length) {
      toast("连接恢复", "正在补发暂存的进度和消息。");
      scheduleOutboxFlush(0);
    }
  });

  window.addEventListener("offline", () => {
    state.networkOnline = false;
    toast("连接已断开", "当前会先在本地显示，恢复后再同步。");
  });

  window.addEventListener("beforeunload", () => {
    if (state.room?.id && state.user?.id && state.queuedProgressValue != null) {
      enqueueOutboxItem({
        type: "progress",
        roomId: state.room.id,
        progress: state.queuedProgressValue
      });
    }
    saveOutbox();
    if (state.room?.id && state.user?.id) {
      navigator.sendBeacon(buildApiUrl(`/api/rooms/${state.room.id}/leave`), JSON.stringify({
        userId: state.user.id,
        name: state.user.name
      }));
    }
    disconnectRealtime();
  });

  document.addEventListener("DOMContentLoaded", async () => {
    await bootstrap();
    if (!state.user) {
      const fallbackNames = ["小满", "阿桥", "南枝", "明野", "松果", "一禾"];
      const randomName = `${fallbackNames[Math.floor(Math.random() * fallbackNames.length)]}${Math.floor(Math.random() * 90 + 10)}`;
      await ensureServerUser(randomName);
    }
    state.outbox = loadOutbox().filter((item) => !item.userId || item.userId === state.user.id);
    saveOutbox();
    scheduleOutboxFlush(500);
    render();
  });
})();

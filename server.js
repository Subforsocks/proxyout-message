const path = require("path");
const fs = require("fs");
const http = require("http");

const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");

const USERS_PATH = path.join(DATA_DIR, "users.json");
const MESSAGES_PATH = path.join(DATA_DIR, "messages.json");
const RESET_PATH = path.join(DATA_DIR, "resetCodes.json");
const GROUPS_PATH = path.join(DATA_DIR, "groups.json");
const GROUP_INVITES_PATH = path.join(DATA_DIR, "groupInvites.json");

function ensureDirs() {
  for (const dir of [DATA_DIR, UPLOADS_DIR, PUBLIC_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(USERS_PATH)) fs.writeFileSync(USERS_PATH, "[]", "utf8");
  if (!fs.existsSync(MESSAGES_PATH)) fs.writeFileSync(MESSAGES_PATH, "{}", "utf8");
  if (!fs.existsSync(RESET_PATH)) fs.writeFileSync(RESET_PATH, "{}", "utf8");
  if (!fs.existsSync(GROUPS_PATH)) fs.writeFileSync(GROUPS_PATH, "[]", "utf8");
  if (!fs.existsSync(GROUP_INVITES_PATH)) fs.writeFileSync(GROUP_INVITES_PATH, "[]", "utf8");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeSpaces(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function isProperNamePart(part) {
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[-'][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/.test(part);
}

function looksLikeRealFullName(first, last) {
  const f = normalizeSpaces(first);
  const l = normalizeSpaces(last);
  if (!f || !l) return { ok: false, reason: "First and last name are required." };
  if (f.length < 2 || l.length < 2) return { ok: false, reason: "Names must be at least 2 characters." };
  if (!isProperNamePart(f) || !isProperNamePart(l)) {
    return { ok: false, reason: "Names must contain only letters and valid separators (e.g., O'Connor, Anne-Marie)." };
  }
  if (f[0] !== f[0].toUpperCase() || l[0] !== l[0].toUpperCase()) {
    return { ok: false, reason: "Please capitalize your first and last name (e.g., Ricardo Sanchez)." };
  }

  const bannedFull = new Set([
    "ben dover",
    "mike hunt",
    "hugh jass",
    "anita bath",
    "harry balls",
    "ivana tinkle",
    "pat myaz"
  ]);
  const fullLower = `${f} ${l}`.toLowerCase();
  if (bannedFull.has(fullLower)) {
    return { ok: false, reason: "That name appears fake. Enter a valid real name (e.g., Ricardo Sanchez)." };
  }

  const bannedParts = new Set(["test", "asdf", "qwerty", "fake", "null", "none", "admin"]);
  if (bannedParts.has(f.toLowerCase()) || bannedParts.has(l.toLowerCase())) {
    return { ok: false, reason: "That name appears invalid. Enter your real first and last name." };
  }
  if (f.toLowerCase() === l.toLowerCase()) return { ok: false, reason: "First and last name must be different." };

  // Reject obvious profanity in *real* names only.
  // Note: This is heuristic and not foolproof.
  const profaneTokens = ["fuck", "nigger", "nigga"];
  const normalizeForCompare = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  const fn = normalizeForCompare(f);
  const ln = normalizeForCompare(l);
  for (const tok of profaneTokens) {
    if (fn.includes(tok) || ln.includes(tok)) {
      return { ok: false, reason: "That name contains profanity. Enter a real, properly formatted name." };
    }
  }

  return { ok: true };
}

function sanitizeUsername(u) {
  const v = String(u || "").trim();
  // Username is allowed to be "whatever" (including profanity),
  // so we only enforce basic safety/length + no newlines.
  if (!v) return null;
  if (v.length < 3 || v.length > 24) return null;
  if (/[\r\n\t\0]/.test(v)) return null;
  return v;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    firstName: u.firstName,
    lastName: u.lastName,
    avatarUrl: u.avatarUrl || null
  };
}

function createInviteCode() {
  // URL-safe short code for joining a group.
  // This is for demo/local use; in production you'd add expiry/rate limiting.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function readGroups() {
  return readJson(GROUPS_PATH, []);
}

function writeGroups(groups) {
  writeJsonAtomic(GROUPS_PATH, groups);
}

function readGroupInvites() {
  return readJson(GROUP_INVITES_PATH, []);
}

function writeGroupInvites(invites) {
  writeJsonAtomic(GROUP_INVITES_PATH, invites);
}

ensureDirs();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/", express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || "").slice(0, 10);
      cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 }
});

function apiError(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

// ----- Auth -----
const sessions = new Map(); // token -> { userId, expiresAt }
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function createToken(userId) {
  const token = uuidv4() + uuidv4();
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getUserByToken(token, users) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return users.find((u) => u.id === s.userId) || null;
}

function authMe(req) {
  const users = readJson(USERS_PATH, []);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const me = getUserByToken(token, users);
  return { users, me };
}

app.post("/api/register", async (req, res) => {
  const users = readJson(USERS_PATH, []);
  const { username, password, passwordConfirm, firstName, lastName } = req.body || {};

  const cleanUsername = sanitizeUsername(username);
  if (!cleanUsername) return apiError(res, 400, "Username must be 3-24 characters and cannot contain newlines.");
  if (typeof password !== "string" || password.length < 6) return apiError(res, 400, "Password must be at least 6 characters.");
  if (typeof passwordConfirm !== "string" || passwordConfirm !== password) return apiError(res, 400, "Passwords do not match.");

  const nameCheck = looksLikeRealFullName(firstName, lastName);
  if (!nameCheck.ok) return apiError(res, 400, nameCheck.reason);

  if (users.some((u) => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
    return apiError(res, 400, "That username is already taken.");
  }

  const user = {
    id: uuidv4(),
    username: cleanUsername,
    passwordHash: await bcrypt.hash(password, 10),
    firstName: normalizeSpaces(firstName),
    lastName: normalizeSpaces(lastName),
    avatarUrl: null,
    createdAt: Date.now()
  };

  users.push(user);
  writeJsonAtomic(USERS_PATH, users);

  const token = createToken(user.id);
  res.json({ ok: true, token, user: publicUser(user) });
});

// ----- Forgot password (local demo) -----
// Sends a reset code back to the browser (no email). This is meant for local/demo use.
app.post("/api/password/request-reset", (req, res) => {
  const { username } = req.body || {};
  const cleanUsername = sanitizeUsername(username);
  if (!cleanUsername) return apiError(res, 400, "Invalid username.");

  const users = readJson(USERS_PATH, []);
  const user = users.find((u) => u.username.toLowerCase() === cleanUsername.toLowerCase());

  const resetCodes = readJson(RESET_PATH, {});
  const code = String(Math.floor(10000000 + Math.random() * 90000000)); // 8 digits
  const codeHash = crypto.createHash("sha256").update(`${user?.id || "nouser"}:${code}`).digest("hex");
  resetCodes[cleanUsername.toLowerCase()] = {
    codeHash,
    expiresAt: Date.now() + 1000 * 60 * 15 // 15 min
  };
  writeJsonAtomic(RESET_PATH, resetCodes);

  // Return code in response so you can complete reset without email.
  res.json({ ok: true, resetCode: code });
});

app.post("/api/password/reset", async (req, res) => {
  const { username, code, newPassword, newPasswordConfirm } = req.body || {};
  const cleanUsername = sanitizeUsername(username);
  if (!cleanUsername) return apiError(res, 400, "Invalid username.");
  if (typeof newPassword !== "string" || newPassword.length < 6) return apiError(res, 400, "Password must be at least 6 characters.");
  if (newPasswordConfirm !== newPassword) return apiError(res, 400, "Passwords do not match.");
  if (typeof code !== "string" || code.length < 4) return apiError(res, 400, "Invalid reset code.");

  const users = readJson(USERS_PATH, []);
  const user = users.find((u) => u.username.toLowerCase() === cleanUsername.toLowerCase());
  if (!user) return apiError(res, 400, "Invalid username or reset code.");

  const resetCodes = readJson(RESET_PATH, {});
  const record = resetCodes[cleanUsername.toLowerCase()];
  if (!record || !record.expiresAt || Date.now() > record.expiresAt) {
    return apiError(res, 400, "Reset code expired. Request a new one.");
  }

  const codeHash = crypto.createHash("sha256").update(`${user.id}:${code}`).digest("hex");
  if (record.codeHash !== codeHash) return apiError(res, 400, "Invalid reset code.");

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  writeJsonAtomic(USERS_PATH, users);

  delete resetCodes[cleanUsername.toLowerCase()];
  writeJsonAtomic(RESET_PATH, resetCodes);
  res.json({ ok: true });
});

app.post("/api/login", async (req, res) => {
  const users = readJson(USERS_PATH, []);
  const { username, password } = req.body || {};

  const cleanUsername = sanitizeUsername(username);
  if (!cleanUsername) return apiError(res, 400, "Invalid username.");

  const user = users.find((u) => u.username.toLowerCase() === cleanUsername.toLowerCase());
  if (!user) return apiError(res, 401, "Wrong username or password.");

  const ok = await bcrypt.compare(String(password || ""), user.passwordHash);
  if (!ok) return apiError(res, 401, "Wrong username or password.");

  const token = createToken(user.id);
  res.json({ ok: true, token, user: publicUser(user) });
});

app.get("/api/me", (req, res) => {
  const users = readJson(USERS_PATH, []);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const me = getUserByToken(token, users);
  if (!me) return apiError(res, 401, "Not authenticated.");
  res.json({ ok: true, user: publicUser(me) });
});

app.get("/api/users", (req, res) => {
  const users = readJson(USERS_PATH, []);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const me = getUserByToken(token, users);
  if (!me) return apiError(res, 401, "Not authenticated.");

  const q = normalizeSpaces(req.query.q || "").toLowerCase();
  const list = users
    .map(publicUser)
    .filter((u) => (q ? u.username.toLowerCase().includes(q) : true))
    .sort((a, b) => a.username.localeCompare(b.username));

  res.json({ ok: true, users: list });
});

app.post("/api/profile/username", (req, res) => {
  const users = readJson(USERS_PATH, []);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const me = getUserByToken(token, users);
  if (!me) return apiError(res, 401, "Not authenticated.");

  const { newUsername } = req.body || {};
  const clean = sanitizeUsername(newUsername);
  if (!clean) return apiError(res, 400, "Username must be 3-24 characters and cannot contain newlines.");

  if (users.some((u) => u.id !== me.id && u.username.toLowerCase() === clean.toLowerCase())) {
    return apiError(res, 400, "That username is already taken.");
  }

  me.username = clean;
  writeJsonAtomic(USERS_PATH, users);
  res.json({ ok: true, user: publicUser(me) });
});

app.post("/api/profile/avatar", upload.single("avatar"), (req, res) => {
  const users = readJson(USERS_PATH, []);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const me = getUserByToken(token, users);
  if (!me) return apiError(res, 401, "Not authenticated.");
  if (!req.file) return apiError(res, 400, "No file uploaded.");

  me.avatarUrl = `/uploads/${req.file.filename}`;
  writeJsonAtomic(USERS_PATH, users);
  res.json({ ok: true, user: publicUser(me) });
});

// ----- Group chats -----

function requireAuth(req, res) {
  const { users, me } = authMe(req);
  if (!me) {
    apiError(res, 401, "Not authenticated.");
    return null;
  }
  return { users, me };
}

function isMember(group, userId) {
  return Array.isArray(group.memberUserIds) && group.memberUserIds.includes(userId);
}

function groupPublic(group, users) {
  const owner = users.find((u) => u.id === group.ownerUserId);
  return {
    id: group.id,
    name: group.name,
    ownerUserId: group.ownerUserId,
    ownerUsername: owner?.username || null,
    memberCount: (group.memberUserIds || []).length,
    // For UI convenience
    members: (group.memberUserIds || [])
      .map((id) => users.find((u) => u.id === id))
      .filter(Boolean)
      .map((u) => publicUser(u))
  };
}

app.post("/api/groups/create", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { users, me } = auth;

  const { name } = req.body || {};
  const groupName = normalizeSpaces(name);
  if (!groupName || groupName.length < 2 || groupName.length > 40) return apiError(res, 400, "Group name must be 2-40 characters.");

  const groups = readGroups();
  const group = {
    id: uuidv4(),
    name: groupName,
    ownerUserId: me.id,
    memberUserIds: [me.id],
    createdAt: Date.now()
  };
  groups.push(group);
  writeGroups(groups);
  res.json({ ok: true, group: groupPublic(group, users) });
});

app.get("/api/groups", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { users, me } = auth;

  const groups = readGroups();
  const mine = groups.filter((g) => isMember(g, me.id));
  res.json({ ok: true, groups: mine.map((g) => groupPublic(g, users)) });
});

app.post("/api/groups/invite", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { users, me } = auth;

  const { groupId } = req.body || {};
  const groups = readGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return apiError(res, 404, "Group not found.");
  if (group.ownerUserId !== me.id) return apiError(res, 403, "Only the owner can create invites.");

  const code = createInviteCode();
  const invites = readGroupInvites();
  const inviteRecord = {
    codeHash: sha256Hex(code),
    groupId,
    createdAt: Date.now()
  };
  invites.push(inviteRecord);
  writeGroupInvites(invites);

  res.json({ ok: true, inviteCode: code, group: groupPublic(group, users) });
});

app.post("/api/groups/join", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { users, me } = auth;

  const { code } = req.body || {};
  const codeStr = String(code || "").trim().toUpperCase();
  if (!codeStr) return apiError(res, 400, "Invite code is required.");

  const invites = readGroupInvites();
  const invite = invites.find((i) => i.codeHash === sha256Hex(codeStr));
  if (!invite) return apiError(res, 400, "Invalid invite code.");

  const groups = readGroups();
  const group = groups.find((g) => g.id === invite.groupId);
  if (!group) return apiError(res, 400, "Group not found.");
  if (isMember(group, me.id)) return apiError(res, 400, "You are already in this group.");

  group.memberUserIds.push(me.id);
  writeGroups(groups);
  res.json({ ok: true, group: groupPublic(group, users) });
});

app.post("/api/groups/addMember", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { users, me } = auth;

  const { groupId, userIdToAdd } = req.body || {};
  const groups = readGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return apiError(res, 404, "Group not found.");
  if (group.ownerUserId !== me.id) return apiError(res, 403, "Only the owner can add members.");

  const user = users.find((u) => u.id === userIdToAdd);
  if (!user) return apiError(res, 404, "User not found.");
  if (isMember(group, user.id)) return apiError(res, 400, "User is already in the group.");

  group.memberUserIds.push(user.id);
  writeGroups(groups);
  res.json({ ok: true, group: groupPublic(group, users) });
});

app.post("/api/groups/kickMember", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { users, me } = auth;

  const { groupId, userIdToKick } = req.body || {};
  const groups = readGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return apiError(res, 404, "Group not found.");
  if (group.ownerUserId !== me.id) return apiError(res, 403, "Only the owner can kick members.");
  if (userIdToKick === group.ownerUserId) return apiError(res, 400, "Owner cannot be kicked. Transfer ownership first.");

  group.memberUserIds = (group.memberUserIds || []).filter((id) => id !== userIdToKick);
  writeGroups(groups);
  res.json({ ok: true, group: groupPublic(group, users) });
});

app.post("/api/groups/transferOwner", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { users, me } = auth;

  const { groupId, newOwnerUserId } = req.body || {};
  const groups = readGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return apiError(res, 404, "Group not found.");
  if (group.ownerUserId !== me.id) return apiError(res, 403, "Only the owner can transfer ownership.");
  if (!isMember(group, newOwnerUserId)) return apiError(res, 400, "New owner must be a member of the group.");

  group.ownerUserId = newOwnerUserId;
  writeGroups(groups);
  res.json({ ok: true, group: groupPublic(group, users) });
});

app.post("/api/groups/leave", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { users, me } = auth;

  const { groupId } = req.body || {};
  const groups = readGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return apiError(res, 404, "Group not found.");
  if (!isMember(group, me.id)) return apiError(res, 400, "You are not a member of this group.");
  if (group.ownerUserId === me.id) return apiError(res, 400, "Owner cannot leave. Transfer ownership first.");

  group.memberUserIds = (group.memberUserIds || []).filter((id) => id !== me.id);
  writeGroups(groups);
  res.json({ ok: true, group: groupPublic(group, users) });
});

// ----- Chat media upload -----
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || "").slice(0, 10);
      cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "");
    const ok = mime.startsWith("image/") || mime.startsWith("video/");
    cb(ok ? null : new Error("Only images and videos are allowed."), ok);
  }
});

app.post("/api/media/upload", mediaUpload.single("media"), (req, res) => {
  const users = readJson(USERS_PATH, []);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const me = getUserByToken(token, users);
  if (!me) return apiError(res, 401, "Not authenticated.");

  if (!req.file) return apiError(res, 400, "No file uploaded.");
  const mime = String(req.file.mimetype || "");
  const type = mime.startsWith("video/") ? "video" : "image";
  res.json({ ok: true, attachment: { type, url: `/uploads/${req.file.filename}` } });
});

// ----- WebSocket (chat + signaling) -----
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const wsByUserId = new Map(); // userId -> ws

function convoKey(a, b) {
  return [a, b].sort().join(":");
}

function appendMessage(a, b, msg) {
  const messages = readJson(MESSAGES_PATH, {});
  const key = convoKey(a, b);
  const arr = messages[key] || [];
  arr.push(msg);
  messages[key] = arr.slice(-500);
  writeJsonAtomic(MESSAGES_PATH, messages);
}

function groupKey(groupId) {
  return `group:${groupId}`;
}

function appendGroupMessage(groupId, msg) {
  const messages = readJson(MESSAGES_PATH, {});
  const key = groupKey(groupId);
  const arr = messages[key] || [];
  arr.push(msg);
  messages[key] = arr.slice(-500);
  writeJsonAtomic(MESSAGES_PATH, messages);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastPresence() {
  const online = Array.from(wsByUserId.keys());
  for (const ws of wsByUserId.values()) send(ws, { type: "presence", onlineUserIds: online });
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.userId = null;

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }

    const users = readJson(USERS_PATH, []);

    if (msg?.type === "auth") {
      const token = String(msg.token || "");
      const me = getUserByToken(token, users);
      if (!me) return send(ws, { type: "auth", ok: false, error: "Invalid session. Please log in again." });

      ws.userId = me.id;
      wsByUserId.set(me.id, ws);
      send(ws, { type: "auth", ok: true, me: publicUser(me) });
      broadcastPresence();
      return;
    }

    if (!ws.userId) return;
    const me = users.find((u) => u.id === ws.userId);
    if (!me) return;

    if (msg?.type === "get_history") {
      const otherId = String(msg.otherUserId || "");
      const other = users.find((u) => u.id === otherId);
      if (!other) return;

      const allMessages = readJson(MESSAGES_PATH, {});
      const history = allMessages[convoKey(me.id, otherId)] || [];
      send(ws, { type: "history", otherUserId: otherId, messages: history });
      return;
    }

    if (msg?.type === "get_group_history") {
      const groupId = String(msg.groupId || "");
      if (!groupId) return;

      const groups = readGroups();
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      if (!isMember(group, me.id)) return;

      const allMessages = readJson(MESSAGES_PATH, {});
      const history = allMessages[groupKey(groupId)] || [];
      send(ws, { type: "group_history", groupId, messages: history });
      return;
    }

    if (msg?.type === "dm") {
      const to = String(msg.toUserId || "");
      const text = typeof msg.text === "string" ? normalizeSpaces(msg.text) : "";
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (!to) return;
      if (!text && attachments.length === 0) return;
      if (text.length > 2000) return;
      if (!users.some((u) => u.id === to)) return;

      const safeAttachments = attachments
        .map((a) => {
          if (!a || typeof a !== "object") return null;
          const type = a.type === "video" ? "video" : a.type === "image" ? "image" : null;
          const url = typeof a.url === "string" ? a.url : "";
          if (!type) return null;
          if (!url.startsWith("/uploads/")) return null;
          if (url.includes("..")) return null;
          return { type, url };
        })
        .filter(Boolean)
        .slice(0, 6);

      if (!text && safeAttachments.length === 0) return;

      const message = {
        id: uuidv4(),
        fromUserId: me.id,
        toUserId: to,
        text,
        ts: Date.now(),
        attachments: safeAttachments
      };
      appendMessage(me.id, to, message);

      send(ws, { type: "dm", message });
      const recipientWs = wsByUserId.get(to);
      if (recipientWs && recipientWs !== ws) send(recipientWs, { type: "dm", message });
      return;
    }

    if (msg?.type === "group_message") {
      const groupId = String(msg.groupId || "");
      const text = typeof msg.text === "string" ? normalizeSpaces(msg.text) : "";
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (!groupId) return;
      if (!text && attachments.length === 0) return;
      if (text.length > 2000) return;

      const groups = readGroups();
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      if (!isMember(group, me.id)) return;

      const safeAttachments = attachments
        .map((a) => {
          if (!a || typeof a !== "object") return null;
          const type = a.type === "video" ? "video" : a.type === "image" ? "image" : null;
          const url = typeof a.url === "string" ? a.url : "";
          if (!type) return null;
          if (!url.startsWith("/uploads/")) return null;
          if (url.includes("..")) return null;
          return { type, url };
        })
        .filter(Boolean)
        .slice(0, 6);

      if (!text && safeAttachments.length === 0) return;

      const message = {
        id: uuidv4(),
        fromUserId: me.id,
        groupId,
        text,
        ts: Date.now(),
        attachments: safeAttachments
      };

      appendGroupMessage(groupId, message);

      // Deliver to online group members
      for (const memberId of group.memberUserIds || []) {
        const memberWs = wsByUserId.get(memberId);
        if (memberWs) send(memberWs, { type: "group_message", message });
      }
      return;
    }

    if (msg?.type === "signal") {
      const to = String(msg.toUserId || "");
      const kind = String(msg.kind || "");
      const data = msg.data ?? null;
      if (!to || !kind) return;

      const recipientWs = wsByUserId.get(to);
      if (!recipientWs) return send(ws, { type: "signal", ok: false, error: "User is offline.", toUserId: to, kind });
      send(recipientWs, { type: "signal", ok: true, fromUserId: me.id, toUserId: to, kind, data });
    }
  });

  ws.on("close", () => {
    if (ws.userId) wsByUserId.delete(ws.userId);
    broadcastPresence();
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30000);

server.listen(PORT, () => console.log(`Proxyout chat running on port ${PORT}`));


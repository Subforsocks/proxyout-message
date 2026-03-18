const path = require("path");
const fs = require("fs");
const http = require("http");

const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");

const USERS_PATH = path.join(DATA_DIR, "users.json");
const MESSAGES_PATH = path.join(DATA_DIR, "messages.json");

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function ensureDirs() {
  for (const dir of [DATA_DIR, UPLOADS_DIR, PUBLIC_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(USERS_PATH)) writeJsonAtomic(USERS_PATH, []);
  if (!fs.existsSync(MESSAGES_PATH)) writeJsonAtomic(MESSAGES_PATH, {});
}

function normalizeSpaces(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function isProperNamePart(part) {
  // Allow letters with accents, plus single hyphens/apostrophes inside.
  // Examples: "O'Connor", "Anne-Marie", "Sánchez"
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
  // Encourage proper formatting (simple check; still allow otherwise if it passes validation)
  const isCapitalized = (p) => p[0] === p[0].toUpperCase();
  if (!isCapitalized(f) || !isCapitalized(l)) {
    return { ok: false, reason: "Please capitalize your first and last name (e.g., Ricardo Sanchez)." };
  }

  const fullLower = `${f} ${l}`.toLowerCase();
  const bannedFull = new Set([
    "ben dover",
    "mike hunt",
    "hugh jass",
    "anita bath",
    "harry balls",
    "ivana tinkle",
    "al koholic",
    "pat myaz",
    "phil mccracken",
    "dixie normous"
  ]);
  if (bannedFull.has(fullLower)) {
    return { ok: false, reason: "That name appears fake. Enter a valid real name (e.g., Ricardo Sanchez)." };
  }
  // Obvious non-names
  const bannedParts = new Set(["test", "asdf", "qwerty", "fake", "null", "none", "admin"]);
  if (bannedParts.has(f.toLowerCase()) || bannedParts.has(l.toLowerCase())) {
    return { ok: false, reason: "That name appears invalid. Enter your real first and last name." };
  }
  if (f.toLowerCase() === l.toLowerCase()) {
    return { ok: false, reason: "First and last name must be different." };
  }
  return { ok: true };
}

function sanitizeUsername(u) {
  const v = normalizeSpaces(u);
  if (!/^[A-Za-z0-9_]{3,20}$/.test(v)) return null;
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

const sessions = new Map(); // token -> { userId, expiresAt }
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

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
  limits: { fileSize: 3 * 1024 * 1024 } // 3MB
});

function apiError(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

app.post("/api/register", async (req, res) => {
  const users = readJson(USERS_PATH, []);
  const { username, password, firstName, lastName } = req.body || {};

  const cleanUsername = sanitizeUsername(username);
  if (!cleanUsername) return apiError(res, 400, "Username must be 3-20 chars and use only letters, numbers, underscore.");
  if (typeof password !== "string" || password.length < 6) return apiError(res, 400, "Password must be at least 6 characters.");

  const nameCheck = looksLikeRealFullName(firstName, lastName);
  if (!nameCheck.ok) return apiError(res, 400, nameCheck.reason);

  if (users.some((u) => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
    return apiError(res, 400, "That username is already taken.");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username: cleanUsername,
    passwordHash,
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
  if (!clean) return apiError(res, 400, "Username must be 3-20 chars and use only letters, numbers, underscore.");
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

// ---------- WebSocket: chat + presence + WebRTC signaling ----------

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const wsByUserId = new Map(); // userId -> ws

function convoKey(a, b) {
  return [a, b].sort().join(":");
}

function getMessagesFor(usersMessages, a, b) {
  return usersMessages[convoKey(a, b)] || [];
}

function appendMessage(a, b, msg) {
  const messages = readJson(MESSAGES_PATH, {});
  const key = convoKey(a, b);
  const arr = messages[key] || [];
  arr.push(msg);
  messages[key] = arr.slice(-500); // keep last 500
  writeJsonAtomic(MESSAGES_PATH, messages);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastPresence() {
  const users = readJson(USERS_PATH, []);
  const online = new Set(Array.from(wsByUserId.keys()));
  const payload = {
    type: "presence",
    onlineUserIds: Array.from(online)
  };
  for (const ws of wsByUserId.values()) send(ws, payload);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.userId = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

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
      if (!me) {
        send(ws, { type: "auth", ok: false, error: "Invalid session. Please log in again." });
        return;
      }
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
      const history = getMessagesFor(allMessages, me.id, otherId);
      send(ws, { type: "history", otherUserId: otherId, messages: history });
      return;
    }

    if (msg?.type === "dm") {
      const to = String(msg.toUserId || "");
      const text = normalizeSpaces(msg.text || "");
      if (!to || !text) return;
      if (text.length > 2000) return;
      const other = users.find((u) => u.id === to);
      if (!other) return;

      const message = {
        id: uuidv4(),
        fromUserId: me.id,
        toUserId: to,
        text,
        ts: Date.now()
      };
      appendMessage(me.id, to, message);

      // deliver to sender + recipient instantly
      const recipientWs = wsByUserId.get(to);
      send(ws, { type: "dm", message });
      if (recipientWs && recipientWs !== ws) send(recipientWs, { type: "dm", message });
      return;
    }

    // WebRTC signaling: offer/answer/ice + call control
    if (msg?.type === "signal") {
      const to = String(msg.toUserId || "");
      const kind = String(msg.kind || "");
      const data = msg.data ?? null;
      if (!to || !kind) return;

      const recipientWs = wsByUserId.get(to);
      if (!recipientWs) {
        send(ws, { type: "signal", ok: false, error: "User is offline.", toUserId: to, kind });
        return;
      }
      send(recipientWs, { type: "signal", ok: true, fromUserId: me.id, toUserId: to, kind, data });
      return;
    }
  });

  ws.on("close", () => {
    if (ws.userId) wsByUserId.delete(ws.userId);
    broadcastPresence();
  });
});

// Keepalive
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

server.listen(PORT, () => {
  console.log(`Proxyout chat running on port ${PORT}`);
});


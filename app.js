const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem("psttpc_token") || null,
  me: null,
  ws: null,
  users: [],
  onlineUserIds: new Set(),
  activeUserId: null,
  messagesByUserId: new Map(), // otherUserId -> messages[]
  call: {
    pc: null,
    localStream: null,
    remoteStream: null,
    withUserId: null,
    mode: null, // "voice" | "video"
    role: null, // "caller" | "callee"
    incoming: false
  }
};

function apiFetch(path, { method = "GET", headers = {}, body } = {}) {
  const h = { ...headers };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  if (body && !(body instanceof FormData)) h["Content-Type"] = "application/json";
  return fetch(path, {
    method,
    headers: h,
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  });
}

function normalizeSpaces(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function setAuthError(msg) {
  const el = $("authError");
  if (!msg) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = msg;
}

function setProfileError(msg) {
  const el = $("profileError");
  if (!msg) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = msg;
}

function initialsFor(u) {
  return (u?.username || "?").slice(0, 2).toUpperCase();
}

function avatarEl(user, size = "sm") {
  const div = document.createElement("div");
  div.className = `avatar${size === "lg" ? " avatar--lg" : ""}${size === "xl" ? " avatar--xl" : ""}`;
  if (user?.avatarUrl) {
    const img = document.createElement("img");
    img.src = user.avatarUrl;
    img.alt = user.username;
    div.appendChild(img);
  } else {
    div.textContent = initialsFor(user);
  }
  return div;
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function isOnline(userId) {
  return state.onlineUserIds.has(userId);
}

function showAuth() {
  $("authView").style.display = "grid";
  $("chatView").style.display = "none";
  $("btnProfile").style.display = "none";
  $("btnLogout").style.display = "none";
}

function showChat() {
  $("authView").style.display = "none";
  $("chatView").style.display = "grid";
  $("btnProfile").style.display = "inline-flex";
  $("btnLogout").style.display = "inline-flex";
}

function setActiveTab(tab) {
  $("tabLogin").classList.toggle("tab--active", tab === "login");
  $("tabRegister").classList.toggle("tab--active", tab === "register");
  $("loginForm").style.display = tab === "login" ? "flex" : "none";
  $("registerForm").style.display = tab === "register" ? "flex" : "none";
  setAuthError(null);
}

async function fetchUsers() {
  if (!state.token) return;
  const q = $("userSearch").value.trim();
  const data = await apiFetch(`/api/users?q=${encodeURIComponent(q)}`);
  state.users = data.users || [];
  renderUsers();
  renderHeader();
}

function renderUsers() {
  const list = $("usersList");
  list.innerHTML = "";
  const users = state.users.filter((u) => !state.me || u.id !== state.me.id);
  for (const u of users) {
    const item = document.createElement("div");
    item.className = "userItem" + (u.id === state.activeUserId ? " userItem--active" : "");
    item.appendChild(avatarEl(u));

    const meta = document.createElement("div");
    meta.className = "userItem__meta";
    const name = document.createElement("div");
    name.className = "userItem__name";
    name.textContent = u.username;
    const sub = document.createElement("div");
    sub.className = "userItem__sub";
    sub.textContent = `${u.firstName} ${u.lastName}`;
    meta.appendChild(name);
    meta.appendChild(sub);
    item.appendChild(meta);

    const pill = document.createElement("div");
    pill.className = "pill" + (isOnline(u.id) ? "" : " pill--off");
    pill.textContent = isOnline(u.id) ? "Online" : "Offline";
    item.appendChild(pill);

    item.addEventListener("click", () => selectUser(u.id));
    list.appendChild(item);
  }
}

function renderHeader() {
  const other = state.users.find((u) => u.id === state.activeUserId) || null;
  const nameEl = $("chatWithName");
  const statusEl = $("chatWithStatus");
  const avatarSlot = $("chatWithAvatar");
  avatarSlot.innerHTML = "";

  if (!other) {
    nameEl.textContent = "Select a user";
    statusEl.textContent = "—";
    $("btnVoiceCall").disabled = true;
    $("btnVideoCall").disabled = true;
    $("messageInput").disabled = true;
    $("btnSend").disabled = true;
    return;
  }

  nameEl.textContent = other.username;
  statusEl.textContent = isOnline(other.id) ? "Online" : "Offline";
  avatarSlot.appendChild(avatarEl(other, "lg"));
  $("btnVoiceCall").disabled = !isOnline(other.id);
  $("btnVideoCall").disabled = !isOnline(other.id);
  $("messageInput").disabled = false;
  $("btnSend").disabled = false;
}

function renderMessages() {
  const wrap = $("messages");
  wrap.innerHTML = "";
  const otherId = state.activeUserId;
  if (!otherId || !state.me) return;

  const msgs = state.messagesByUserId.get(otherId) || [];
  for (const m of msgs) {
    const row = document.createElement("div");
    row.className = "msgRow" + (m.fromUserId === state.me.id ? " msgRow--me" : "");

    const user = m.fromUserId === state.me.id ? state.me : state.users.find((u) => u.id === m.fromUserId);
    row.appendChild(avatarEl(user));

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.text;
    const meta = document.createElement("div");
    meta.className = "bubble__meta";
    meta.textContent = formatTime(m.ts);
    bubble.appendChild(meta);
    row.appendChild(bubble);
    wrap.appendChild(row);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function upsertMessage(message) {
  if (!state.me) return;
  const otherId = message.fromUserId === state.me.id ? message.toUserId : message.fromUserId;
  const arr = state.messagesByUserId.get(otherId) || [];
  arr.push(message);
  state.messagesByUserId.set(otherId, arr.slice(-500));
  if (otherId === state.activeUserId) renderMessages();
}

function wsSend(obj) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(obj));
}

function selectUser(userId) {
  if (state.activeUserId === userId) return;
  state.activeUserId = userId;
  renderUsers();
  renderHeader();
  renderMessages();
  wsSend({ type: "get_history", otherUserId: userId });
}

function connectWs() {
  if (!state.token) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    wsSend({ type: "auth", token: state.token });
  });

  ws.addEventListener("message", async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "auth") {
      if (!msg.ok) {
        await logout();
        setAuthError(msg.error || "Session expired. Please log in again.");
      }
      return;
    }

    if (msg.type === "presence") {
      state.onlineUserIds = new Set(msg.onlineUserIds || []);
      renderUsers();
      renderHeader();
      return;
    }

    if (msg.type === "history") {
      const otherId = String(msg.otherUserId || "");
      if (!otherId) return;
      state.messagesByUserId.set(otherId, (msg.messages || []).slice(-500));
      if (otherId === state.activeUserId) renderMessages();
      return;
    }

    if (msg.type === "dm") {
      if (!msg.message) return;
      upsertMessage(msg.message);
      return;
    }

    if (msg.type === "signal") {
      if (msg.ok === false) return;
      await onSignal(msg);
      return;
    }
  });

  ws.addEventListener("close", () => {
    setTimeout(connectWs, 800);
  });
}

async function loginFlow(token, user) {
  state.token = token;
  localStorage.setItem("psttpc_token", token);
  state.me = user;
  showChat();
  await fetchUsers();
  connectWs();
  renderProfile();
}

async function logout() {
  state.token = null;
  state.me = null;
  state.activeUserId = null;
  state.users = [];
  state.onlineUserIds = new Set();
  state.messagesByUserId = new Map();
  localStorage.removeItem("psttpc_token");
  try {
    if (state.ws) state.ws.close();
  } catch {}
  state.ws = null;
  showAuth();
}

function openProfile() {
  setProfileError(null);
  $("profileModal").style.display = "grid";
  renderProfile();
}
function closeProfile() {
  $("profileModal").style.display = "none";
}

function renderProfile() {
  if (!state.me) return;
  $("meRealName").textContent = `${state.me.firstName} ${state.me.lastName}`;
  $("meUsername").textContent = state.me.username;
  const slot = $("meAvatar");
  slot.innerHTML = "";
  slot.appendChild(avatarEl(state.me, "xl"));
}

// ----- WebRTC calls -----

function setCallOverlay(show) {
  $("callOverlay").style.display = show ? "grid" : "none";
}

function resetCallUi() {
  $("btnAcceptCall").style.display = "none";
  $("callTitle").textContent = "Call";
  $("callSub").textContent = "—";
  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;
}

function rtcConfig() {
  return {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }]
  };
}

async function ensureLocalMedia(mode) {
  if (state.call.localStream) return state.call.localStream;
  const constraints = mode === "video" ? { audio: true, video: true } : { audio: true, video: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.call.localStream = stream;
  $("localVideo").srcObject = stream;
  return stream;
}

function ensurePeerConnection() {
  if (state.call.pc) return state.call.pc;
  const pc = new RTCPeerConnection(rtcConfig());
  state.call.pc = pc;
  state.call.remoteStream = new MediaStream();
  $("remoteVideo").srcObject = state.call.remoteStream;

  pc.onicecandidate = (ev) => {
    if (!ev.candidate || !state.call.withUserId) return;
    wsSend({ type: "signal", toUserId: state.call.withUserId, kind: "ice", data: ev.candidate });
  };

  pc.ontrack = (ev) => {
    for (const track of ev.streams[0].getTracks()) state.call.remoteStream.addTrack(track);
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) endCall(false);
  };

  return pc;
}

async function startCall(mode) {
  const otherId = state.activeUserId;
  const other = state.users.find((u) => u.id === otherId);
  if (!otherId || !other) return;

  resetCallUi();
  state.call.withUserId = otherId;
  state.call.mode = mode;
  state.call.role = "caller";
  state.call.incoming = false;

  $("callTitle").textContent = mode === "video" ? "Video call" : "Voice call";
  $("callSub").textContent = `Calling ${other.username}…`;
  setCallOverlay(true);
  wsSend({ type: "signal", toUserId: otherId, kind: "call_invite", data: { mode } });
}

async function acceptIncomingCall() {
  const otherId = state.call.withUserId;
  const other = state.users.find((u) => u.id === otherId);
  $("btnAcceptCall").style.display = "none";
  $("callSub").textContent = `Connecting with ${other?.username || "user"}…`;

  await ensureLocalMedia(state.call.mode);
  const pc = ensurePeerConnection();
  for (const track of state.call.localStream.getTracks()) pc.addTrack(track, state.call.localStream);
  wsSend({ type: "signal", toUserId: otherId, kind: "call_accept", data: { mode: state.call.mode } });
}

async function endCall(notify = true) {
  const otherId = state.call.withUserId;
  if (notify && otherId) wsSend({ type: "signal", toUserId: otherId, kind: "hangup", data: null });

  try {
    if (state.call.pc) state.call.pc.close();
  } catch {}
  state.call.pc = null;

  try {
    if (state.call.localStream) {
      for (const t of state.call.localStream.getTracks()) t.stop();
    }
  } catch {}
  state.call.localStream = null;
  state.call.remoteStream = null;
  state.call.withUserId = null;
  state.call.mode = null;
  state.call.role = null;
  state.call.incoming = false;

  resetCallUi();
  setCallOverlay(false);
}

async function onSignal(msg) {
  const kind = String(msg.kind || "");
  const from = String(msg.fromUserId || "");
  const data = msg.data;

  if (kind === "call_invite") {
    if (state.call.withUserId) {
      wsSend({ type: "signal", toUserId: from, kind: "call_busy", data: null });
      return;
    }
    const other = state.users.find((u) => u.id === from);
    resetCallUi();
    state.call.withUserId = from;
    state.call.mode = data?.mode === "video" ? "video" : "voice";
    state.call.role = "callee";
    state.call.incoming = true;
    $("callTitle").textContent = state.call.mode === "video" ? "Incoming video call" : "Incoming voice call";
    $("callSub").textContent = `${other?.username || "User"} is calling…`;
    $("btnAcceptCall").style.display = "inline-flex";
    setCallOverlay(true);
    return;
  }

  if (kind === "call_busy") {
    $("callSub").textContent = "User is busy.";
    setTimeout(() => endCall(false), 900);
    return;
  }

  if (kind === "hangup") {
    endCall(false);
    return;
  }

  if (kind === "call_accept") {
    // Caller prepares offer
    if (state.call.role !== "caller") return;
    const other = state.users.find((u) => u.id === from);
    $("callSub").textContent = `Connecting with ${other?.username || "user"}…`;
    await ensureLocalMedia(state.call.mode);
    const pc = ensurePeerConnection();
    for (const track of state.call.localStream.getTracks()) pc.addTrack(track, state.call.localStream);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: "signal", toUserId: from, kind: "offer", data: offer });
    return;
  }

  if (kind === "offer") {
    // Callee answers
    if (state.call.role !== "callee") return;
    await ensureLocalMedia(state.call.mode);
    const pc = ensurePeerConnection();
    for (const track of state.call.localStream.getTracks()) pc.addTrack(track, state.call.localStream);
    await pc.setRemoteDescription(new RTCSessionDescription(data));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: "signal", toUserId: from, kind: "answer", data: answer });
    return;
  }

  if (kind === "answer") {
    if (state.call.role !== "caller") return;
    const pc = ensurePeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(data));
    return;
  }

  if (kind === "ice") {
    const pc = ensurePeerConnection();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data));
    } catch {}
    return;
  }
}

// ----- Tab key toggle -----
function toggleChatHidden(force) {
  const hide = typeof force === "boolean" ? force : !document.body.classList.contains("chatHidden");
  document.body.classList.toggle("chatHidden", hide);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  // only toggle when not typing into inputs
  const t = e.target;
  const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
  e.preventDefault();
  toggleChatHidden();
});

// ----- UI events -----
$("tabLogin").addEventListener("click", () => setActiveTab("login"));
$("tabRegister").addEventListener("click", () => setActiveTab("register"));
$("btnLogout").addEventListener("click", () => logout());
$("btnProfile").addEventListener("click", () => openProfile());
$("btnCloseProfile").addEventListener("click", () => closeProfile());
$("btnAcceptCall").addEventListener("click", () => acceptIncomingCall());
$("btnHangup").addEventListener("click", () => endCall(true));
$("btnVoiceCall").addEventListener("click", () => startCall("voice"));
$("btnVideoCall").addEventListener("click", () => startCall("video"));

let searchTimer = null;
$("userSearch").addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => fetchUsers().catch(() => {}), 200);
});

$("messageForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const otherId = state.activeUserId;
  const text = normalizeSpaces($("messageInput").value);
  if (!otherId || !text) return;
  wsSend({ type: "dm", toUserId: otherId, text });
  $("messageInput").value = "";
});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    setAuthError(null);
    const username = $("loginUsername").value.trim();
    const password = $("loginPassword").value;
    const data = await apiFetch("/api/login", { method: "POST", body: { username, password } });
    await loginFlow(data.token, data.user);
  } catch (err) {
    setAuthError(err.message || "Login failed.");
  }
});

$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    setAuthError(null);
    const firstName = $("regFirstName").value.trim();
    const lastName = $("regLastName").value.trim();
    const username = $("regUsername").value.trim();
    const password = $("regPassword").value;
    const data = await apiFetch("/api/register", { method: "POST", body: { firstName, lastName, username, password } });
    await loginFlow(data.token, data.user);
  } catch (err) {
    setAuthError(err.message || "Registration failed.");
  }
});

$("usernameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    setProfileError(null);
    const newUsername = $("newUsername").value.trim();
    const data = await apiFetch("/api/profile/username", { method: "POST", body: { newUsername } });
    state.me = data.user;
    $("newUsername").value = "";
    await fetchUsers();
    renderProfile();
  } catch (err) {
    setProfileError(err.message || "Failed to update username.");
  }
});

$("avatarForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    setProfileError(null);
    const file = $("avatarFile").files?.[0];
    if (!file) throw new Error("Pick an image file first.");
    const fd = new FormData();
    fd.append("avatar", file);
    const data = await apiFetch("/api/profile/avatar", { method: "POST", body: fd });
    state.me = data.user;
    $("avatarFile").value = "";
    await fetchUsers();
    renderProfile();
  } catch (err) {
    setProfileError(err.message || "Failed to upload picture.");
  }
});

// ----- Boot -----
(async () => {
  setActiveTab("login");
  if (!state.token) {
    showAuth();
    return;
  }
  try {
    const data = await apiFetch("/api/me");
    state.me = data.user;
    showChat();
    await fetchUsers();
    connectWs();
    renderProfile();
  } catch {
    await logout();
  }
})();


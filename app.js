const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem("psttpc_token") || null,
  me: null,
  ws: null,
  users: [], // sidebar list for current mode (users mode)
  allUsers: [], // full user list for avatars / dropdowns
  onlineUserIds: new Set(),
  sidebarMode: "users", // "users" | "groups"
  activeUserId: null,
  activeGroupId: null,
  messagesByUserId: new Map(),
  groupMessagesById: new Map(),
  groups: [],
  pendingJoinCode: new URLSearchParams(location.search).get("join"),
  pendingAttachment: null,
  forgotResetCode: null,
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

function normalizeSpaces(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function apiFetch(url, { method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  let requestBody = undefined;
  if (body) {
    if (body instanceof FormData) {
      requestBody = body;
    } else {
      h["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
  }

  return fetch(url, { method, headers: h, body: requestBody }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  });
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

function setAuthError(msg) {
  const el = $("authError");
  el.style.display = msg ? "block" : "none";
  el.textContent = msg || "";
}

function setProfileError(msg) {
  const el = $("profileError");
  el.style.display = msg ? "block" : "none";
  el.textContent = msg || "";
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

function setActiveTab(tab) {
  $("tabLogin").classList.toggle("tab--active", tab === "login");
  $("tabRegister").classList.toggle("tab--active", tab === "register");
  $("loginForm").style.display = tab === "login" ? "flex" : "none";
  $("registerForm").style.display = tab === "register" ? "flex" : "none";
  setAuthError(null);
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

function renderGroups() {
  const list = $("usersList");
  list.innerHTML = "";
  const q = $("userSearch").value.trim().toLowerCase();
  const groups = (state.groups || []).filter((g) => (!q ? true : g.name.toLowerCase().includes(q)));

  for (const g of groups) {
    const item = document.createElement("div");
    item.className = "userItem" + (g.id === state.activeGroupId ? " userItem--active" : "");
    item.appendChild(avatarEl({ username: g.name }, "sm"));

    const meta = document.createElement("div");
    meta.className = "userItem__meta";
    const name = document.createElement("div");
    name.className = "userItem__name";
    name.textContent = g.name;
    const sub = document.createElement("div");
    sub.className = "userItem__sub";
    sub.textContent = `${g.memberCount || 0} members${state.me && g.ownerUserId === state.me.id ? " • Owner" : ""}`;
    meta.appendChild(name);
    meta.appendChild(sub);
    item.appendChild(meta);

    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = "Group";
    item.appendChild(pill);

    item.addEventListener("click", () => selectGroup(g.id));
    list.appendChild(item);
  }
}

function renderHeader() {
  if (state.activeGroupId) {
    const group = state.groups.find((g) => g.id === state.activeGroupId) || null;
    const nameEl = $("chatWithName");
    const statusEl = $("chatWithStatus");
    const avatarSlot = $("chatWithAvatar");
    avatarSlot.innerHTML = "";

    if (!group) {
      nameEl.textContent = "Loading group…";
      statusEl.textContent = "—";
      $("messageInput").disabled = true;
      $("btnSend").disabled = true;
      $("btnAttach").disabled = true;
      $("btnVoiceCall").disabled = true;
      $("btnVideoCall").disabled = true;
      $("btnGroupManage").style.display = "none";
      $("btnLeaveGroup").style.display = "none";
      return;
    }

    nameEl.textContent = group.name;
    statusEl.textContent = `${group.memberCount || 0} members${state.me && group.ownerUserId === state.me.id ? " • Owner" : ""}`;
    avatarSlot.appendChild(avatarEl({ username: group.name }, "lg"));

    $("btnVoiceCall").disabled = true;
    $("btnVideoCall").disabled = true;
    $("btnGroupManage").style.display = state.me && group.ownerUserId === state.me.id ? "inline-flex" : "none";
    $("btnLeaveGroup").style.display = state.me && group.ownerUserId !== state.me.id ? "inline-flex" : "none";

    $("messageInput").disabled = false;
    $("btnSend").disabled = false;
    $("btnAttach").disabled = false;
    return;
  }

  const other = state.users.find((u) => u.id === state.activeUserId) || null;

  const nameEl = $("chatWithName");
  const statusEl = $("chatWithStatus");
  const avatarSlot = $("chatWithAvatar");
  avatarSlot.innerHTML = "";

  if (!other) {
    nameEl.textContent = state.sidebarMode === "groups" ? "Select a group" : "Select a user";
    statusEl.textContent = "—";
    $("btnVoiceCall").disabled = true;
    $("btnVideoCall").disabled = true;
    $("messageInput").disabled = true;
    $("btnAttach").disabled = true;
    $("btnGroupManage").style.display = "none";
    $("btnLeaveGroup").style.display = "none";
    $("btnSend").disabled = true;
    return;
  }

  nameEl.textContent = other.username;
  statusEl.textContent = isOnline(other.id) ? "Online" : "Offline";
  avatarSlot.appendChild(avatarEl(other, "lg"));
  $("btnVoiceCall").disabled = !isOnline(other.id);
  $("btnVideoCall").disabled = !isOnline(other.id);
  $("messageInput").disabled = false;
  $("btnAttach").disabled = false;
  $("btnGroupManage").style.display = "none";
  $("btnLeaveGroup").style.display = "none";
  $("btnSend").disabled = false;
}

function renderTextWithLinks(container, text) {
  container.innerHTML = "";
  const t = String(text || "");
  const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(t)) !== null) {
    const start = match.index;
    const rawUrl = match[0];
    if (start > lastIndex) {
      container.appendChild(document.createTextNode(t.slice(lastIndex, start)));
    }

    // Trim some common trailing punctuation from URLs.
    let url = rawUrl;
    let suffix = "";
    const suffixMatch = rawUrl.match(/([)\].,!?;:]+)$/);
    if (suffixMatch) {
      suffix = suffixMatch[1];
      url = rawUrl.slice(0, -suffix.length);
    }

    const href = url.startsWith("http://") || url.startsWith("https://") ? url : `http://${url}`;
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    container.appendChild(a);
    if (suffix) container.appendChild(document.createTextNode(suffix));

    lastIndex = start + rawUrl.length;
  }

  if (lastIndex < t.length) container.appendChild(document.createTextNode(t.slice(lastIndex)));
}

function renderAttachmentsInto(container, attachments) {
  const arr = Array.isArray(attachments) ? attachments : [];
  if (arr.length === 0) return;

  const wrap = document.createElement("div");
  wrap.className = "attachment";

  for (const a of arr) {
    if (!a || !a.url) continue;
    if (a.type === "image") {
      const img = document.createElement("img");
      img.src = a.url;
      img.alt = "Image attachment";
      wrap.appendChild(img);
    } else if (a.type === "video") {
      const v = document.createElement("video");
      v.src = a.url;
      v.controls = true;
      v.playsInline = true;
      wrap.appendChild(v);
    }
  }

  container.appendChild(wrap);
}

function renderMessages() {
  const wrap = $("messages");
  wrap.innerHTML = "";
  if (!state.me || (!state.activeUserId && !state.activeGroupId)) return;

  const msgs = state.activeGroupId
    ? state.groupMessagesById.get(state.activeGroupId) || []
    : state.messagesByUserId.get(state.activeUserId) || [];
  for (const m of msgs) {
    const row = document.createElement("div");
    row.className = "msgRow" + (m.fromUserId === state.me.id ? " msgRow--me" : "");

    const user =
      m.fromUserId === state.me.id
        ? state.me
        : state.allUsers.find((u) => u.id === m.fromUserId) || state.users.find((u) => u.id === m.fromUserId);
    row.appendChild(avatarEl(user));

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (m.text) renderTextWithLinks(bubble, m.text);
    renderAttachmentsInto(bubble, m.attachments);

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

function upsertGroupMessage(message) {
  if (!state.me) return;
  const groupId = message.groupId;
  if (!groupId) return;
  const arr = state.groupMessagesById.get(groupId) || [];
  arr.push(message);
  state.groupMessagesById.set(groupId, arr.slice(-500));
  if (groupId === state.activeGroupId) renderMessages();
}

function wsSend(obj) {
  if (!state.ws) return;
  const ws = state.ws;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return;
  }
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener(
      "open",
      () => {
        if (state.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      },
      { once: true }
    );
  }
}

async function fetchUsers() {
  const q = $("userSearch").value.trim();
  const data = await apiFetch(`/api/users?q=${encodeURIComponent(q)}`);
  state.users = data.users || [];
  renderUsers();
  renderHeader();
}

async function fetchAllUsers() {
  const data = await apiFetch(`/api/users?q=${encodeURIComponent("")}`);
  state.allUsers = data.users || [];
  if (state.sidebarMode === "users") {
    state.users = state.allUsers;
    renderUsers();
    renderHeader();
  }
}

async function fetchGroups() {
  const data = await apiFetch("/api/groups");
  state.groups = data.groups || [];
  if (state.sidebarMode === "groups") renderGroups();
  renderHeader();
}

async function tryJoinFromUrl() {
  if (!state.pendingJoinCode) return;
  const code = String(state.pendingJoinCode || "").trim();
  if (!code) return;

  try {
    const data = await apiFetch("/api/groups/join", { method: "POST", body: { code } });
    state.pendingJoinCode = null;
    // Remove join param from URL after success
    try {
      const u = new URL(location.href);
      u.searchParams.delete("join");
      history.replaceState({}, "", u.toString());
    } catch {}

    await fetchGroups();
    selectGroup(data.group.id);
  } catch (err) {
    setAuthError(err.message || "Failed to join group with invite code.");
  }
}

function openGroupManageModal() {
  if (!state.activeGroupId) return;
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  if (!group) return;
  if (!state.me || group.ownerUserId !== state.me.id) return;

  $("groupManageError").style.display = "none";
  $("inviteLinkRow").style.display = "none";
  $("inviteLinkInput").value = "";
  $("groupMembersList").innerHTML = "";

  $("groupManageTitle").textContent = group.name;
  $("groupManageModal").style.display = "grid";

  // Members list + kick buttons
  for (const member of group.members || []) {
    const row = document.createElement("div");
    row.className = "userItem";
    row.style.cursor = "default";
    row.appendChild(avatarEl(member, "sm"));

    const meta = document.createElement("div");
    meta.className = "userItem__meta";
    const name = document.createElement("div");
    name.className = "userItem__name";
    name.textContent = `@${member.username}`;
    const sub = document.createElement("div");
    sub.className = "userItem__sub";
    sub.textContent = member.id === group.ownerUserId ? "Owner" : "";
    meta.appendChild(name);
    meta.appendChild(sub);
    row.appendChild(meta);

    if (member.id !== group.ownerUserId) {
      const kickBtn = document.createElement("button");
      kickBtn.type = "button";
      kickBtn.className = "ghost";
      kickBtn.textContent = "Kick";
      kickBtn.addEventListener("click", async () => {
        try {
          await apiFetch("/api/groups/kickMember", {
            method: "POST",
            body: { groupId: group.id, userIdToKick: member.id }
          });
          await fetchGroups();
          openGroupManageModal();
        } catch (err) {
          $("groupManageError").style.display = "block";
          $("groupManageError").textContent = err.message || "Kick failed.";
        }
      });
      row.appendChild(kickBtn);
    }

    $("groupMembersList").appendChild(row);
  }

  // Add member dropdown
  const addSelect = $("addMemberSelect");
  addSelect.innerHTML = "";
  const existing = new Set((group.memberUserIds || []).concat(group.members?.map((m) => m.id) || []));
  const candidates = (state.allUsers || []).filter((u) => u.id !== state.me.id && !existing.has(u.id));
  for (const u of candidates) {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = `@${u.username}`;
    addSelect.appendChild(opt);
  }
  if (addSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No available users";
    addSelect.appendChild(opt);
  }

  // Transfer owner dropdown
  const transferSelect = $("transferOwnerSelect");
  transferSelect.innerHTML = "";
  const members = (group.members || []).filter((m) => m.id !== group.ownerUserId);
  for (const m of members) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `@${m.username}`;
    transferSelect.appendChild(opt);
  }
  if (transferSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No other members";
    transferSelect.appendChild(opt);
  }
}

function selectUser(userId) {
  if (state.activeUserId === userId && !state.activeGroupId) return;
  state.activeGroupId = null;
  state.activeUserId = userId;
  state.sidebarMode = "users";
  $("btnSidebarUsers").classList.add("tabSmall--active");
  $("btnSidebarGroups").classList.remove("tabSmall--active");
  $("groupJoinBox").style.display = "none";
  $("btnCreateGroup").style.display = "none";
  $("userSearch").placeholder = "Search…";
  renderUsers();
  renderHeader();
  state.messagesByUserId.set(userId, []);
  renderMessages();
  wsSend({ type: "get_history", otherUserId: userId });
}

function selectGroup(groupId) {
  if (state.activeGroupId === groupId && state.sidebarMode === "groups") return;
  state.activeUserId = null;
  state.activeGroupId = groupId;
  state.sidebarMode = "groups";
  $("btnSidebarGroups").classList.add("tabSmall--active");
  $("btnSidebarUsers").classList.remove("tabSmall--active");
  $("groupJoinBox").style.display = "flex";
  $("btnCreateGroup").style.display = "inline-flex";
  $("userSearch").placeholder = "Search groups…";
  renderGroups();
  renderHeader();
  state.groupMessagesById.set(groupId, []);
  renderMessages();
  wsSend({ type: "get_group_history", groupId });
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

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "auth") {
      if (!msg.ok) {
        logout();
        setAuthError(msg.error || "Session expired. Please log in again.");
      }
      return;
    }

    if (msg.type === "presence") {
      state.onlineUserIds = new Set(msg.onlineUserIds || []);
      if (state.sidebarMode === "users") renderUsers();
      else renderGroups();
      renderHeader();
      return;
    }

    if (msg.type === "history") {
      const otherId = String(msg.otherUserId || "");
      state.messagesByUserId.set(otherId, (msg.messages || []).slice(-500));
      if (otherId === state.activeUserId) renderMessages();
      return;
    }

    if (msg.type === "group_history") {
      const groupId = String(msg.groupId || "");
      state.groupMessagesById.set(groupId, (msg.messages || []).slice(-500));
      if (groupId === state.activeGroupId) renderMessages();
      return;
    }

    if (msg.type === "dm") {
      if (msg.message) upsertMessage(msg.message);
      return;
    }

    if (msg.type === "group_message") {
      if (msg.message) upsertGroupMessage(msg.message);
      return;
    }

    if (msg.type === "signal") {
      if (msg.ok === false) return;
      onSignal(msg).catch(() => {});
      return;
    }
  });

  ws.addEventListener("close", () => setTimeout(connectWs, 900));
}

async function loginFlow(token, user) {
  state.token = token;
  localStorage.setItem("psttpc_token", token);
  state.me = user;
  showChat();
  await fetchAllUsers();
  await fetchGroups();
  connectWs();
  renderProfile();
  await tryJoinFromUrl();
}

async function logout() {
  state.token = null;
  state.me = null;
  state.activeUserId = null;
  state.activeGroupId = null;
  state.users = [];
  state.allUsers = [];
  state.sidebarMode = "users";
  state.groups = [];
  state.onlineUserIds = new Set();
  state.messagesByUserId = new Map();
  state.groupMessagesById = new Map();
  state.pendingAttachment = null;
  state.pendingJoinCode = null;
  state.call = { pc: null, localStream: null, remoteStream: null, withUserId: null, mode: null, role: null, incoming: false };
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

function openForgotModal() {
  setProfileError(null);
  setAuthError(null);
  const reqStep = $("forgotStep1");
  const step2 = $("forgotStep2");
  reqStep.style.display = "block";
  step2.style.display = "none";
  $("forgotError").style.display = "none";
  $("forgotError").textContent = "";
  $("fpUsername").value = $("fpUsername").value || "";
  $("fpCode").value = "";
  $("fpNewPassword").value = "";
  $("fpNewPasswordConfirm").value = "";
  $("forgotModal").style.display = "grid";
  state.forgotResetCode = null;
}

function closeForgotModal() {
  $("forgotModal").style.display = "none";
  state.forgotResetCode = null;
}

function setForgotError(msg) {
  const el = $("forgotError");
  el.style.display = msg ? "block" : "none";
  el.textContent = msg || "";
}

function renderProfile() {
  if (!state.me) return;
  $("meRealName").textContent = `${state.me.firstName} ${state.me.lastName}`;
  $("meUsername").textContent = state.me.username;
  const slot = $("meAvatar");
  slot.innerHTML = "";
  slot.appendChild(avatarEl(state.me, "xl"));
}

// ---- WebRTC ----
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
  return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
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
    const stream = ev.streams[0];
    if (!stream) return;
    for (const t of stream.getTracks()) state.call.remoteStream.addTrack(t);
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) endCall(false);
  };

  return pc;
}

async function startCall(mode) {
  if (!state.activeUserId) return;
  if (!isOnline(state.activeUserId)) return;

  resetCallUi();
  state.call.withUserId = state.activeUserId;
  state.call.mode = mode;
  state.call.role = "caller";
  state.call.incoming = false;

  $("callTitle").textContent = mode === "video" ? "Video call" : "Voice call";
  const other = state.users.find((u) => u.id === state.activeUserId);
  $("callSub").textContent = `Calling ${other?.username || "user"}…`;
  setCallOverlay(true);

  wsSend({ type: "signal", toUserId: state.activeUserId, kind: "call_invite", data: { mode } });
}

async function acceptIncomingCall() {
  if (!state.call.withUserId) return;
  $("btnAcceptCall").style.display = "none";

  await ensureLocalMedia(state.call.mode);
  const pc = ensurePeerConnection();
  for (const track of state.call.localStream.getTracks()) pc.addTrack(track, state.call.localStream);

  wsSend({ type: "signal", toUserId: state.call.withUserId, kind: "call_accept", data: { mode: state.call.mode } });
}

function endCall(notify = true) {
  const to = state.call.withUserId;
  if (notify && to) wsSend({ type: "signal", toUserId: to, kind: "hangup", data: null });

  try {
    if (state.call.pc) state.call.pc.close();
  } catch {}
  state.call.pc = null;

  try {
    if (state.call.localStream) for (const t of state.call.localStream.getTracks()) t.stop();
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

    state.call.withUserId = from;
    state.call.mode = data?.mode === "video" ? "video" : "voice";
    state.call.role = "callee";
    state.call.incoming = true;

    resetCallUi();
    $("callTitle").textContent = state.call.mode === "video" ? "Incoming video call" : "Incoming voice call";
    const other = state.users.find((u) => u.id === from);
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
  }
}

// ---- Tab toggle ----
function toggleChatHidden() {
  document.body.classList.toggle("chatHidden");
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const t = e.target;
  const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
  e.preventDefault();
  toggleChatHidden();
});

// ---- UI wiring ----
$("tabLogin").addEventListener("click", () => setActiveTab("login"));
$("tabRegister").addEventListener("click", () => setActiveTab("register"));
$("btnLogout").addEventListener("click", () => logout());
$("btnProfile").addEventListener("click", () => openProfile());
$("btnCloseProfile").addEventListener("click", () => closeProfile());

$("btnSidebarUsers").addEventListener("click", () => {
  state.sidebarMode = "users";
  state.activeGroupId = null;
  state.activeUserId = null;
  $("groupJoinBox").style.display = "none";
  $("btnCreateGroup").style.display = "none";
  $("btnSidebarUsers").classList.add("tabSmall--active");
  $("btnSidebarGroups").classList.remove("tabSmall--active");
  $("userSearch").placeholder = "Search…";
  renderUsers();
  renderHeader();
  renderMessages();
});

$("btnSidebarGroups").addEventListener("click", async () => {
  state.sidebarMode = "groups";
  state.activeGroupId = null;
  state.activeUserId = null;
  $("groupJoinBox").style.display = "flex";
  $("btnCreateGroup").style.display = "inline-flex";
  $("btnSidebarGroups").classList.add("tabSmall--active");
  $("btnSidebarUsers").classList.remove("tabSmall--active");
  $("userSearch").placeholder = "Search groups…";
  await fetchGroups();
  renderGroups();
  renderHeader();
  renderMessages();
});

$("btnJoinByCode").addEventListener("click", async () => {
  try {
    const code = $("joinCode").value.trim();
    if (!code) throw new Error("Enter an invite code.");
    const data = await apiFetch("/api/groups/join", { method: "POST", body: { code } });
    $("joinCode").value = "";
    await fetchGroups();
    selectGroup(data.group.id);
  } catch (err) {
    alert(err.message || "Join failed.");
  }
});

$("btnCreateGroup").addEventListener("click", () => {
  $("createGroupError").style.display = "none";
  $("createGroupName").value = "";
  $("createGroupModal").style.display = "grid";
});

$("btnCloseCreateGroup").addEventListener("click", () => {
  $("createGroupModal").style.display = "none";
});

$("createGroupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const name = $("createGroupName").value.trim();
    if (!name) throw new Error("Enter a group name.");
    const data = await apiFetch("/api/groups/create", { method: "POST", body: { name } });
    $("createGroupModal").style.display = "none";
    await fetchGroups();
    selectGroup(data.group.id);
  } catch (err) {
    const el = $("createGroupError");
    el.style.display = "block";
    el.textContent = err.message || "Create group failed.";
  }
});

$("btnGroupManage").addEventListener("click", () => openGroupManageModal());
$("btnCloseGroupManage").addEventListener("click", () => {
  $("groupManageModal").style.display = "none";
});

$("btnGenerateInvite").addEventListener("click", async () => {
  try {
    if (!state.activeGroupId) throw new Error("No group selected.");
    const data = await apiFetch("/api/groups/invite", {
      method: "POST",
      body: { groupId: state.activeGroupId }
    });
    const code = data.inviteCode;
    const link = `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`;
    $("inviteLinkInput").value = link;
    $("inviteLinkRow").style.display = "block";
  } catch (err) {
    $("groupManageError").style.display = "block";
    $("groupManageError").textContent = err.message || "Failed to generate invite.";
  }
});

$("btnCopyInvite").addEventListener("click", async () => {
  const input = $("inviteLinkInput");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(input.value);
      $("groupManageError").style.display = "none";
    } else {
      input.focus();
      input.select();
      document.execCommand("copy");
    }
  } catch {
    // best-effort; ignore
  }
});

$("addMemberForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (!state.activeGroupId) throw new Error("No group selected.");
    const userIdToAdd = $("addMemberSelect").value;
    if (!userIdToAdd) throw new Error("Pick a user to add.");
    await apiFetch("/api/groups/addMember", {
      method: "POST",
      body: { groupId: state.activeGroupId, userIdToAdd }
    });
    await fetchGroups();
    openGroupManageModal();
  } catch (err) {
    $("groupManageError").style.display = "block";
    $("groupManageError").textContent = err.message || "Add member failed.";
  }
});

$("transferOwnerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (!state.activeGroupId) throw new Error("No group selected.");
    const newOwnerUserId = $("transferOwnerSelect").value;
    if (!newOwnerUserId) throw new Error("Pick a new owner.");
    await apiFetch("/api/groups/transferOwner", {
      method: "POST",
      body: { groupId: state.activeGroupId, newOwnerUserId }
    });
    await fetchGroups();
    openGroupManageModal();
  } catch (err) {
    $("groupManageError").style.display = "block";
    $("groupManageError").textContent = err.message || "Transfer failed.";
  }
});

$("btnLeaveGroup").addEventListener("click", async () => {
  try {
    if (!state.activeGroupId) return;
    await apiFetch("/api/groups/leave", {
      method: "POST",
      body: { groupId: state.activeGroupId }
    });
    state.activeGroupId = null;
    state.activeUserId = null;
    await fetchGroups();
    renderHeader();
    renderMessages();
  } catch (err) {
    alert(err.message || "Failed to leave group.");
  }
});

$("btnForgot").addEventListener("click", () => openForgotModal());
$("btnCloseForgot").addEventListener("click", () => closeForgotModal());

$("forgotRequestForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    setForgotError(null);
    const username = $("fpUsername").value.trim();
    if (!username) throw new Error("Enter your username.");
    const data = await apiFetch("/api/password/request-reset", { method: "POST", body: { username } });
    state.forgotResetCode = data.resetCode;
    $("fpCode").value = data.resetCode;
    $("forgotStep1").style.display = "none";
    $("forgotStep2").style.display = "block";
  } catch (err) {
    setForgotError(err.message || "Failed to request reset code.");
  }
});

$("forgotResetForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    setForgotError(null);
    const username = $("fpUsername").value.trim();
    const code = $("fpCode").value.trim();
    const newPassword = $("fpNewPassword").value;
    const newPasswordConfirm = $("fpNewPasswordConfirm").value;
    if (!username || !code) throw new Error("Username and reset code are required.");
    if (!newPassword) throw new Error("Enter a new password.");
    if (newPassword !== newPasswordConfirm) throw new Error("Passwords do not match.");

    await apiFetch("/api/password/reset", {
      method: "POST",
      body: { username, code, newPassword, newPasswordConfirm }
    });
    closeForgotModal();
    setAuthError("Password reset complete. Please log in.");
  } catch (err) {
    setForgotError(err.message || "Reset failed.");
  }
});

$("btnAcceptCall").addEventListener("click", () => acceptIncomingCall());
$("btnHangup").addEventListener("click", () => endCall(true));
$("btnVoiceCall").addEventListener("click", () => startCall("voice"));
$("btnVideoCall").addEventListener("click", () => startCall("video"));

let userFetchTimer = null;
$("userSearch").addEventListener("input", () => {
  if (userFetchTimer) clearTimeout(userFetchTimer);
  userFetchTimer = setTimeout(async () => {
    if (state.sidebarMode === "users") {
      fetchUsers().catch(() => {});
    } else {
      // Group search is client-side over the already-loaded group list.
      renderGroups();
    }
  }, 200);
});

$("btnAttach").addEventListener("click", () => {
  $("mediaFile").click();
});

$("mediaFile").addEventListener("change", async () => {
  const file = $("mediaFile").files?.[0];
  if (!file) return;
  try {
    $("btnAttach").disabled = true;
    $("btnSend").disabled = true;
    const fd = new FormData();
    // Field name must match multer config in server.js
    fd.append("media", file);
    const data = await apiFetch("/api/media/upload", { method: "POST", body: fd });
    state.pendingAttachment = data.attachment || null;

    const pv = $("mediaPreview");
    pv.style.display = state.pendingAttachment ? "block" : "none";
    pv.innerHTML = "";
    if (state.pendingAttachment) {
      const att = document.createElement("div");
      att.className = "attachment";
      if (state.pendingAttachment.type === "image") {
        const img = document.createElement("img");
        img.src = state.pendingAttachment.url;
        img.alt = "Attachment";
        att.appendChild(img);
      } else {
        const v = document.createElement("video");
        v.src = state.pendingAttachment.url;
        v.controls = true;
        v.playsInline = true;
        att.appendChild(v);
      }

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "ghost";
      rm.textContent = "Remove";
      rm.style.marginTop = "10px";
      rm.addEventListener("click", () => {
        state.pendingAttachment = null;
        $("mediaFile").value = "";
        pv.style.display = "none";
        pv.innerHTML = "";
        renderHeader();
      });

      pv.appendChild(att);
      pv.appendChild(rm);
    }
  } catch (err) {
    alert(err.message || "Upload failed.");
    state.pendingAttachment = null;
    $("mediaFile").value = "";
    $("mediaPreview").style.display = "none";
    $("mediaPreview").innerHTML = "";
  } finally {
    $("btnAttach").disabled = false;
    renderHeader();
  }
});

$("messageForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const to = state.activeUserId;
  const groupId = state.activeGroupId;
  const text = normalizeSpaces($("messageInput").value);
  const attachments = state.pendingAttachment ? [state.pendingAttachment] : [];

  if (!to && !groupId) return;
  if (!text && attachments.length === 0) return;

  if (groupId) wsSend({ type: "group_message", groupId, text, attachments });
  else wsSend({ type: "dm", toUserId: to, text, attachments });

  $("messageInput").value = "";
  state.pendingAttachment = null;
  $("mediaFile").value = "";
  $("mediaPreview").style.display = "none";
  $("mediaPreview").innerHTML = "";
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
    const passwordConfirm = $("regPasswordConfirm").value;
    const data = await apiFetch("/api/register", {
      method: "POST",
      body: { firstName, lastName, username, password, passwordConfirm }
    });
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

// ---- Boot ----
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
    await fetchAllUsers();
    await fetchGroups();
    connectWs();
    renderProfile();
    await tryJoinFromUrl();
  } catch {
    await logout();
  }
})();


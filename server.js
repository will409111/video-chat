const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIG
// ============================================================

const MASTER_PIN = "230323038227";
const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// ============================================================
// IN-MEMORY STATE
// ============================================================

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Map();
const moderatorAccess = new Map();
const moderationLog = [];

let nextRoomNumber = 1;

// ============================================================
// HELPERS
// ============================================================

function makeId(prefix = "id") {
  return (
    prefix +
    "_" +
    crypto.randomBytes(8).toString("hex") +
    "_" +
    Date.now().toString(36)
  );
}

function hashPin(pin) {
  return crypto
    .createHash("sha256")
    .update(String(pin))
    .digest("hex");
}

function cleanName(value) {
  let name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) name = "Guest";
  return name.slice(0, 32);
}

function cleanRoomName(value) {
  let name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) name = "Room";
  return name.slice(0, 50);
}

function cleanRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 24);
}

function cleanPin(value) {
  return String(value || "").trim().slice(0, 64);
}

function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    ws.send(JSON.stringify(data));
  } catch (_) {}
}

function broadcastRoom(room, data, options = {}) {
  if (!room) return;

  for (const id of room.participants) {
    const client = clients.get(id);
    if (!client) continue;

    if (options.normalOnly && client.role !== "user") continue;
    if (options.moderatorsOnly && client.role !== "moderator") continue;
    if (options.excludeId && client.id === options.excludeId) continue;

    send(client.ws, data);
  }
}

function addLog(action, moderator, target, roomCode, details = "") {
  moderationLog.unshift({
    id: makeId("log"),
    action,
    moderatorId: moderator?.id || "",
    moderatorName: moderator?.name || "System",
    targetId: target?.id || "",
    targetName: target?.name || "",
    roomCode: roomCode || "",
    details,
    createdAt: Date.now()
  });

  if (moderationLog.length > 500) {
    moderationLog.length = 500;
  }

  broadcastModeratorData();
}

function formatDuration(amount, unit) {
  if (!amount || !unit) return "Unknown duration";

  const n = Number(amount);

  if (!Number.isFinite(n) || n <= 0) {
    return "Unknown duration";
  }

  const labels = {
    second: n === 1 ? "second" : "seconds",
    minute: n === 1 ? "minute" : "minutes",
    hour: n === 1 ? "hour" : "hours",
    day: n === 1 ? "day" : "days",
    week: n === 1 ? "week" : "weeks",
    month: n === 1 ? "month" : "months",
    year: n === 1 ? "year" : "years"
  };

  return `${n} ${labels[unit] || unit}`;
}

function calculateDuration(amount, unit, permanent) {
  if (permanent) return null;

  const n = Number(amount);

  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  const multipliers = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000
  };

  if (!multipliers[unit]) return null;

  return Date.now() + n * multipliers[unit];
}

// ============================================================
// BANS
// ============================================================

function cleanExpiredBans() {
  const now = Date.now();

  for (const [id, ban] of bannedUsers) {
    if (ban.expiresAt && ban.expiresAt <= now) {
      bannedUsers.delete(id);
    }
  }
}

function getBanByUserId(userId) {
  cleanExpiredBans();

  for (const ban of bannedUsers.values()) {
    if (ban.userId === userId) {
      return ban;
    }
  }

  return null;
}

// ============================================================
// MODERATOR ACCESS
// ============================================================

function cleanExpiredModeratorAccess() {
  const now = Date.now();

  for (const [id, access] of moderatorAccess) {
    if (access.expiresAt && access.expiresAt <= now) {
      moderatorAccess.delete(id);
    }
  }
}

function getModeratorAccessByPin(pin) {
  cleanExpiredModeratorAccess();

  const hash = hashPin(pin);

  for (const access of moderatorAccess.values()) {
    if (access.pinHash === hash) {
      return access;
    }
  }

  return null;
}

function isMasterModerator(client) {
  return client?.role === "moderator" &&
    client.moderatorLevel === "master";
}

function isModerator(client) {
  return client?.role === "moderator";
}

function canControlTarget(moderator, target) {
  if (!moderator || !target) return false;

  if (moderator.role !== "moderator") return false;

  // Delegated moderators cannot control other moderators.
  if (
    moderator.moderatorLevel !== "master" &&
    target.role === "moderator"
  ) {
    return false;
  }

  return true;
}

// ============================================================
// ROOMS
// ============================================================

function roomExists(code) {
  return rooms.has(code);
}

function makeRoomCode() {
  let code;

  do {
    code =
      "ROOM-" +
      String(nextRoomNumber++).padStart(4, "0") +
      "-" +
      crypto.randomBytes(2).toString("hex").toUpperCase();
  } while (rooms.has(code));

  return code;
}

function createRoom(name, requestedCode) {
  const roomName = cleanRoomName(name);

  let code = cleanRoomCode(requestedCode);

  if (!code) {
    code = makeRoomCode();
  }

  if (rooms.has(code)) {
    return null;
  }

  const room = {
    code,
    name: roomName,
    participants: new Set(),
    messages: [],
    createdAt: Date.now()
  };

  rooms.set(code, room);

  return room;
}

function getVisibleParticipants(room, viewer) {
  if (!room) return [];

  const result = [];

  for (const id of room.participants) {
    const client = clients.get(id);
    if (!client) continue;

    // Normal users NEVER see moderators.
    if (viewer?.role === "user" && client.role === "moderator") {
      continue;
    }

    // Moderators see normal participants.
    if (client.role === "user") {
      result.push({
        id: client.id,
        userId: client.userId,
        name: client.name,
        role: "user"
      });
    }
  }

  return result;
}

function getRoomInfo(room, viewer) {
  return {
    code: room.code,
    name: room.name,
    participants: getVisibleParticipants(room, viewer),
    messages: room.messages.slice(-100)
  };
}

function removeFromRoom(client, notify = true) {
  if (!client || !client.roomCode) return;

  const room = rooms.get(client.roomCode);

  if (!room) {
    client.roomCode = null;
    return;
  }

  room.participants.delete(client.id);

  const oldRoomCode = room.code;
  client.roomCode = null;

  // Normal users should know when another normal user leaves.
  if (client.role === "user" && notify) {
    broadcastRoom(
      room,
      {
        type: "userLeft",
        id: client.id,
        name: client.name
      },
      {
        excludeId: client.id
      }
    );
  }

  // Moderators are deliberately invisible to normal users.
  // Only other moderators get moderator presence information.
  if (client.role === "moderator" && notify) {
    broadcastRoom(
      room,
      {
        type: "moderatorLeft",
        id: client.id
      },
      {
        moderatorsOnly: true,
        excludeId: client.id
      }
    );
  }

  if (room.participants.size === 0) {
    rooms.delete(oldRoomCode);
  }

  broadcastModeratorData();
}

function joinRoom(client, room) {
  if (!client || !room) return false;

  if (client.roomCode) {
    removeFromRoom(client);
  }

  room.participants.add(client.id);
  client.roomCode = room.code;

  send(client.ws, {
    type: "roomJoined",
    room: getRoomInfo(room, client),
    selfId: client.id
  });

  // Existing normal users should know about a new normal user.
  if (client.role === "user") {
    broadcastRoom(
      room,
      {
        type: "userJoined",
        participant: {
          id: client.id,
          userId: client.userId,
          name: client.name,
          role: "user"
        }
      },
      {
        normalOnly: true,
        excludeId: client.id
      }
    );

    // Every existing moderator gets told that this normal user exists.
    broadcastRoom(
      room,
      {
        type: "userJoined",
        participant: {
          id: client.id,
          userId: client.userId,
          name: client.name,
          role: "user"
        }
      },
      {
        moderatorsOnly: true,
        excludeId: client.id
      }
    );

    // Existing anonymous moderators must receive this user's media.
    for (const id of room.participants) {
      const other = clients.get(id);

      if (other && other.role === "moderator") {
        send(client.ws, {
          type: "moderatorReady",
          moderatorId: other.id
        });
      }
    }
  }

  // When a moderator enters, normal users receive ONLY a signaling
  // message. The moderator does not appear in their participant list.
  if (client.role === "moderator") {
    for (const id of room.participants) {
      const other = clients.get(id);

      if (!other) continue;

      if (other.role === "user") {
        send(other.ws, {
          type: "moderatorReady",
          moderatorId: client.id
        });
      }
    }

    broadcastRoom(
      room,
      {
        type: "moderatorJoined",
        id: client.id
      },
      {
        moderatorsOnly: true,
        excludeId: client.id
      }
    );
  }

  broadcastModeratorData();

  return true;
}

// ============================================================
// MODERATOR DATA
// ============================================================

function getRoomList() {
  return [...rooms.values()].map(room => {
    const participants = [];

    for (const id of room.participants) {
      const client = clients.get(id);

      if (!client || client.role !== "user") continue;

      participants.push({
        id: client.id,
        userId: client.userId,
        name: client.name
      });
    }

    return {
      code: room.code,
      name: room.name,
      participantCount: participants.length,
      participants,
      createdAt: room.createdAt
    };
  });
}

function getBanList() {
  cleanExpiredBans();

  return [...bannedUsers.values()].map(ban => ({
    ...ban,
    expiresAt: ban.expiresAt
  }));
}

function getModeratorAccessList() {
  cleanExpiredModeratorAccess();

  return [...moderatorAccess.values()].map(access => ({
    id: access.id,
    name: access.name,
    targetUserId: access.targetUserId,
    createdBy: access.createdBy,
    createdAt: access.createdAt,
    expiresAt: access.expiresAt,
    durationText: access.durationText
  }));
}

function getModeratorLog() {
  return moderationLog.slice(0, 300);
}

function broadcastModeratorData() {
  const data = {
    type: "moderatorData",
    rooms: getRoomList(),
    bans: getBanList(),
    moderatorAccess: getModeratorAccessList(),
    moderationLog: getModeratorLog()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, data);
    }
  }
}

// ============================================================
// HTML
// ============================================================

const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Video Chat</title>

<style>
* {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  font-family: Arial, Helvetica, sans-serif;
  background: #080b12;
  color: #fff;
}

button,
input,
select {
  font: inherit;
}

button {
  cursor: pointer;
}

.hidden {
  display: none !important;
}

.page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.card {
  width: min(500px, 100%);
  background: #111722;
  border: 1px solid #273044;
  border-radius: 20px;
  padding: 28px;
  box-shadow: 0 20px 70px rgba(0,0,0,.35);
}

h1, h2, h3 {
  margin-top: 0;
}

.subtitle {
  color: #9da8bb;
  margin-bottom: 25px;
}

.field {
  margin-bottom: 15px;
}

.field label {
  display: block;
  color: #b7c0d0;
  font-size: 14px;
  margin-bottom: 7px;
}

input,
select {
  width: 100%;
  border: 1px solid #303b50;
  background: #0b1019;
  color: white;
  border-radius: 12px;
  padding: 13px 14px;
  outline: none;
}

input:focus,
select:focus {
  border-color: #5b8cff;
}

.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

button {
  border: 0;
  border-radius: 12px;
  padding: 13px 16px;
  background: #2d6cdf;
  color: white;
  font-weight: 700;
}

button.secondary {
  background: #252e3d;
}

button.danger {
  background: #d63838;
}

button.success {
  background: #198754;
}

button:disabled {
  opacity: .5;
  cursor: not-allowed;
}

.error {
  color: #ff8585;
  margin-top: 15px;
}

#roomPage {
  display: none;
  min-height: 100vh;
  padding: 12px;
}

.roomTop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.roomTitle {
  font-size: 20px;
  font-weight: 800;
}

.roomCode {
  color: #8fa0ba;
  font-size: 13px;
}

.topButtons {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}

.layoutButtons {
  display: flex;
  gap: 5px;
}

.layoutButtons button {
  padding: 8px 10px;
  font-size: 12px;
}

.layoutButtons button.active {
  background: #5b8cff;
}

.roomLayout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 12px;
  height: calc(100vh - 82px);
}

.stage {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mainVideoWrap {
  flex: 1;
  min-height: 300px;
  position: relative;
  background: #020408;
  border-radius: 18px;
  overflow: hidden;
  border: 2px solid #202938;
}

#mainVideo {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  display: block;
}

.mainLabel {
  position: absolute;
  left: 12px;
  bottom: 12px;
  background: rgba(0,0,0,.65);
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 13px;
}

.thumbnails {
  display: flex;
  gap: 9px;
  overflow-x: auto;
  min-height: 92px;
  padding-bottom: 2px;
}

.thumb {
  position: relative;
  flex: 0 0 125px;
  height: 82px;
  background: #030509;
  border: 2px solid #202938;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
}

.thumb.talking,
.mainVideoWrap.talking {
  border-color: #27d46b;
  box-shadow: 0 0 0 1px #27d46b;
}

.thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumbName {
  position: absolute;
  left: 5px;
  right: 5px;
  bottom: 5px;
  font-size: 11px;
  background: rgba(0,0,0,.65);
  padding: 3px 5px;
  border-radius: 5px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.chat {
  background: #101722;
  border: 1px solid #273044;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chatHeader {
  padding: 13px;
  border-bottom: 1px solid #273044;
  font-weight: 700;
}

.chatMessages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.message {
  margin-bottom: 11px;
}

.messageName {
  font-size: 11px;
  color: #7e91ae;
  margin-bottom: 3px;
}

.messageText {
  background: #1c2635;
  padding: 8px 10px;
  border-radius: 10px;
  word-break: break-word;
}

.chatForm {
  display: flex;
  gap: 7px;
  padding: 9px;
  border-top: 1px solid #273044;
}

.chatForm input {
  min-width: 0;
}

.chatForm button {
  width: auto;
}

body[data-layout="phone"] .roomLayout {
  grid-template-columns: 1fr;
  height: auto;
}

body[data-layout="phone"] .mainVideoWrap {
  height: 52vh;
  min-height: 240px;
  flex: none;
}

body[data-layout="phone"] .chat {
  height: 38vh;
}

@media (max-width: 700px) {
  .roomLayout {
    grid-template-columns: 1fr;
    height: auto;
  }

  .mainVideoWrap {
    height: 52vh;
    min-height: 240px;
    flex: none;
  }

  .chat {
    height: 38vh;
  }
}

body[data-layout="computer"] .roomLayout {
  grid-template-columns: minmax(0, 1fr) 320px;
  height: calc(100vh - 82px);
}

body[data-layout="computer"] .mainVideoWrap {
  min-height: 300px;
}

body[data-layout="computer"] .chat {
  height: auto;
}

body[data-layout="phone"] .topButtons {
  width: 100%;
}

body[data-layout="phone"] .topButtons button {
  flex: 1;
}
</style>
</head>

<body>

<div id="homePage" class="page">
  <div class="card">
    <h1>Video Chat</h1>
    <div class="subtitle">
      Create a temporary room or join one.
    </div>

    <div class="field">
      <label>Your name</label>
      <input id="nameInput" maxlength="32" placeholder="Your name" autocomplete="off">
    </div>

    <div class="field">
      <label>Room name</label>
      <input id="roomNameInput" maxlength="50" placeholder="Example: Game Night" autocomplete="off">
    </div>

    <div class="field">
      <label>Room code</label>
      <input id="roomCodeInput" maxlength="24" placeholder="Example: GAMENIGHT123" autocomplete="off">
    </div>

    <div class="actions">
      <button id="createBtn">Create Room</button>
      <button id="joinBtn" class="secondary">Join Room</button>
    </div>

    <div id="homeError" class="error"></div>
  </div>
</div>

<div id="roomPage">

  <div class="roomTop">
    <div>
      <div id="roomTitle" class="roomTitle"></div>
      <div id="roomCodeDisplay" class="roomCode"></div>
    </div>

    <div class="topButtons">
      <div class="layoutButtons">
        <button id="autoLayoutBtn" class="active">Auto</button>
        <button id="computerLayoutBtn">Computer</button>
        <button id="phoneLayoutBtn">Phone</button>
      </div>

      <button id="leaveBtn" class="danger">Leave Room</button>
    </div>
  </div>

  <div class="roomLayout">

    <div class="stage">

      <div id="mainVideoWrap" class="mainVideoWrap">
        <video id="mainVideo" autoplay playsinline muted></video>
        <div id="mainLabel" class="mainLabel">You</div>
      </div>

      <div id="thumbnails" class="thumbnails"></div>

    </div>

    <div class="chat">
      <div class="chatHeader">Room Chat</div>
      <div id="chatMessages" class="chatMessages"></div>

      <form id="chatForm" class="chatForm">
        <input id="chatInput" maxlength="500" placeholder="Message..." autocomplete="off">
        <button type="submit">Send</button>
      </form>
    </div>

  </div>
</div>

<script>
(() => {
  const state = {
    ws: null,
    registered: false,
    inRoom: false,
    room: null,
    selfId: null,
    name: "",
    localStream: null,
    peers: new Map(),
    participants: new Map(),
    selectedId: null,
    layout: "auto",
    audioContext: null,
    detectors: new Map()
  };

  const $ = id => document.getElementById(id);

  function wsUrl() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return protocol + "//" + location.host + "/ws";
  }

  function showHomeError(text) {
    $("homeError").textContent = text || "";
  }

  function connectSocket() {
    return new Promise((resolve, reject) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      const ws = new WebSocket(wsUrl());
      state.ws = ws;

      ws.onopen = () => {
        const savedId =
          localStorage.getItem("videoChatUserId") ||
          crypto.randomUUID();

        localStorage.setItem("videoChatUserId", savedId);

        ws.send(JSON.stringify({
          type: "register",
          userId: savedId
        }));

        resolve();
      };

      ws.onerror = () => {
        reject(new Error("Could not connect to server."));
      };

      ws.onclose = () => {
        state.registered = false;

        if (state.inRoom) {
          cleanupRoom(false);
          showHomeError("Connection lost. Please reconnect.");
        }
      };

      ws.onmessage = async event => {
        try {
          const msg = JSON.parse(event.data);
          await handleMessage(msg);
        } catch (err) {
          console.error(err);
        }
      };
    });
  }

  function send(data) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    state.ws.send(JSON.stringify(data));
    return true;
  }

  async function ensureMedia() {
    if (state.localStream) return true;

    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      $("mainVideo").srcObject = state.localStream;
      $("mainVideo").muted = true;

      await $("mainVideo").play().catch(() => {});

      createSpeakingDetector(
        state.selfId,
        state.localStream,
        $("mainVideoWrap")
      );

      return true;
    } catch (err) {
      showHomeError(
        "Camera and microphone permission is required to enter a room."
      );
      return false;
    }
  }

  async function createRoom() {
    showHomeError("");

    const name = $("nameInput").value.trim();
    const roomName = $("roomNameInput").value.trim();
    const roomCode = $("roomCodeInput").value.trim();

    if (!name) {
      showHomeError("Enter your name.");
      return;
    }

    if (!roomName) {
      showHomeError("Enter a room name.");
      return;
    }

    if (!roomCode) {
      showHomeError("Enter a room code.");
      return;
    }

    try {
      await connectSocket();

      state.name = name;

      if (!(await ensureMedia())) return;

      send({
        type: "setName",
        name
      });

      send({
        type: "createRoom",
        roomName,
        roomCode
      });
    } catch (err) {
      showHomeError(err.message);
    }
  }

  async function joinRoom() {
    showHomeError("");

    const name = $("nameInput").value.trim();
    const roomName = $("roomNameInput").value.trim();
    const roomCode = $("roomCodeInput").value.trim();

    if (!name) {
      showHomeError("Enter your name.");
      return;
    }

    if (!roomName) {
      showHomeError("Enter the room name.");
      return;
    }

    if (!roomCode) {
      showHomeError("Enter the room code.");
      return;
    }

    try {
      await connectSocket();

      state.name = name;

      if (!(await ensureMedia())) return;

      send({
        type: "setName",
        name
      });

      send({
        type: "joinRoom",
        roomCode
      });
    } catch (err) {
      showHomeError(err.message);
    }
  }

  async function handleMessage(msg) {
    switch (msg.type) {

      case "registered":
        state.registered = true;
        break;

      case "error":
        if (!state.inRoom) {
          showHomeError(msg.message || "Something went wrong.");
        } else {
          alert(msg.message || "Something went wrong.");
        }
        break;

      case "roomCreated":
        // Server automatically joins creator.
        break;

      case "roomJoined":
        await enterRoom(msg);
        break;

      case "userJoined":
        if (msg.participant?.role !== "user") return;

        state.participants.set(
          msg.participant.id,
          msg.participant
        );

        renderThumbnails();

        // Only one side creates the offer.
        if (state.selfId < msg.participant.id) {
          await createOffer(msg.participant.id);
        }
        break;

      case "userLeft":
        removeParticipant(msg.id);
        break;

      case "moderatorReady":
        // Moderator is intentionally NOT added to participants.
        // Normal users initiate a hidden WebRTC connection to the
        // moderator so the moderator can receive our media.
        await createOffer(msg.moderatorId, true);
        break;

      case "signal":
        await handleSignal(msg);
        break;

      case "chatMessage":
        addChatMessage(msg.message);
        break;

      case "kicked":
        cleanupRoom(false);
        showHomeError(msg.message || "You were kicked from the room.");
        break;

      case "banned":
        cleanupRoom(false);
        showHomeError(msg.message || "You are banned.");
        break;
    }
  }

  async function enterRoom(msg) {
    state.inRoom = true;
    state.room = msg.room;
    state.selfId = msg.selfId;

    $("homePage").style.display = "none";
    $("roomPage").style.display = "block";

    $("roomTitle").textContent = state.room.name;
    $("roomCodeDisplay").textContent =
      "Code: " + state.room.code;

    state.participants.clear();

    for (const person of state.room.participants || []) {
      state.participants.set(person.id, person);
    }

    $("chatMessages").innerHTML = "";

    for (const message of state.room.messages || []) {
      addChatMessage(message);
    }

    renderThumbnails();

    await $("mainVideo").play().catch(() => {});

    // Existing normal participants.
    for (const person of state.room.participants || []) {
      if (person.id === state.selfId) continue;

      if (state.selfId < person.id) {
        await createOffer(person.id);
      }
    }
  }

  function cleanupRoom(returnHome = true) {
    for (const [, peer] of state.peers) {
      try {
        peer.pc.close();
      } catch (_) {}
    }

    state.peers.clear();

    for (const [, detector] of state.detectors) {
      try {
        cancelAnimationFrame(detector.frame);
      } catch (_) {}
    }

    state.detectors.clear();

    state.participants.clear();
    state.inRoom = false;
    state.room = null;
    state.selfId = null;
    state.selectedId = null;

    $("thumbnails").innerHTML = "";
    $("chatMessages").innerHTML = "";

    if (state.localStream) {
      for (const track of state.localStream.getTracks()) {
        track.stop();
      }

      state.localStream = null;
    }

    $("mainVideo").srcObject = null;

    if (returnHome) {
      $("roomPage").style.display = "none";
      $("homePage").style.display = "flex";
    }
  }

  function leaveRoom() {
    if (!state.inRoom) return;

    send({
      type: "leaveRoom"
    });

    cleanupRoom(true);
  }

  function getPeer(id) {
    return state.peers.get(id);
  }

  function createPeer(remoteId) {
    let existing = state.peers.get(remoteId);

    if (existing) {
      return existing.pc;
    }

    const pc = new RTCPeerConnection({
      iceServers: ${JSON.stringify(STUN_SERVERS)}
    });

    const peer = {
      pc,
      remoteStream: new MediaStream(),
      iceQueue: []
    };

    state.peers.set(remoteId, peer);

    // Normal user always publishes local media.
    if (state.localStream) {
      for (const track of state.localStream.getTracks()) {
        pc.addTrack(track, state.localStream);
      }
    }

    pc.onicecandidate = event => {
      if (!event.candidate) return;

      send({
        type: "signal",
        targetId: remoteId,
        signalType: "ice",
        data: event.candidate
      });
    };

    pc.ontrack = event => {
      const stream = event.streams?.[0];

      if (stream) {
        peer.remoteStream = stream;
      } else {
        peer.remoteStream.addTrack(event.track);
      }

      attachRemoteVideo(remoteId, peer.remoteStream);
    };

    pc.onconnectionstatechange = () => {
      const bad = [
        "failed",
        "closed",
        "disconnected"
      ];

      if (bad.includes(pc.connectionState)) {
        if (pc.connectionState !== "disconnected") {
          removePeer(remoteId);
        }
      }
    };

    return pc;
  }

  async function createOffer(remoteId, hiddenModerator = false) {
    if (!remoteId || remoteId === state.selfId) return;

    const pc = createPeer(remoteId);

    // If already negotiating/connected, don't create another offer.
    const peer = state.peers.get(remoteId);

    if (!peer) return;

    if (
      pc.signalingState !== "stable" &&
      pc.signalingState !== "have-local-offer"
    ) {
      return;
    }

    if (pc.signalingState === "have-local-offer") {
      return;
    }

    try {
      const offer = await pc.createOffer();

      await pc.setLocalDescription(offer);

      send({
        type: "signal",
        targetId: remoteId,
        signalType: "offer",
        data: pc.localDescription
      });
    } catch (err) {
      console.error("Offer error:", err);
    }
  }

  async function handleSignal(msg) {
    const remoteId = msg.fromId;

    if (!remoteId) return;

    if (msg.signalType === "offer") {
      const pc = createPeer(remoteId);

      try {
        await pc.setRemoteDescription(
          new RTCSessionDescription(msg.data)
        );

        const peer = state.peers.get(remoteId);

        if (peer) {
          for (const candidate of peer.iceQueue) {
            await pc.addIceCandidate(candidate).catch(() => {});
          }

          peer.iceQueue = [];
        }

        const answer = await pc.createAnswer();

        await pc.setLocalDescription(answer);

        send({
          type: "signal",
          targetId: remoteId,
          signalType: "answer",
          data: pc.localDescription
        });
      } catch (err) {
        console.error("Offer handling error:", err);
      }

      return;
    }

    if (msg.signalType === "answer") {
      const peer = state.peers.get(remoteId);

      if (!peer) return;

      try {
        await peer.pc.setRemoteDescription(
          new RTCSessionDescription(msg.data)
        );

        for (const candidate of peer.iceQueue) {
          await peer.pc.addIceCandidate(candidate).catch(() => {});
        }

        peer.iceQueue = [];
      } catch (err) {
        console.error("Answer error:", err);
      }

      return;
    }

    if (msg.signalType === "ice") {
      const peer = state.peers.get(remoteId);

      if (!peer) return;

      const candidate = new RTCIceCandidate(msg.data);

      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(candidate).catch(() => {});
      } else {
        peer.iceQueue.push(candidate);
      }
    }
  }

  function attachRemoteVideo(id, stream) {
    let participant = state.participants.get(id);

    // Hidden moderator will not exist in participant map.
    if (!participant) {
      participant = {
        id,
        name: "Anonymous Moderator",
        role: "moderator"
      };
    }

    let thumb = document.querySelector(
      '[data-peer-id="' + CSS.escape(id) + '"]'
    );

    if (!thumb) {
      thumb = document.createElement("div");
      thumb.className = "thumb";
      thumb.dataset.peerId = id;

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;

      const label = document.createElement("div");
      label.className = "thumbName";
      label.textContent = participant.name;

      thumb.appendChild(video);
      thumb.appendChild(label);

      thumb.onclick = () => selectVideo(id);

      $("thumbnails").appendChild(thumb);
    }

    const video = thumb.querySelector("video");

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    video.muted = false;
    video.autoplay = true;
    video.playsInline = true;

    video.play().catch(() => {});

    createSpeakingDetector(id, stream, thumb);

    if (!state.selectedId) {
      selectVideo(id);
    }
  }

  function renderThumbnails() {
    $("thumbnails").innerHTML = "";

    // Local video.
    const localThumb = document.createElement("div");
    localThumb.className = "thumb";
    localThumb.dataset.peerId = "local";

    const localVideo = document.createElement("video");
    localVideo.srcObject = state.localStream;
    localVideo.autoplay = true;
    localVideo.playsInline = true;
    localVideo.muted = true;

    const label = document.createElement("div");
    label.className = "thumbName";
    label.textContent = state.name + " (You)";

    localThumb.appendChild(localVideo);
    localThumb.appendChild(label);

    localThumb.onclick = () => selectVideo("local");

    $("thumbnails").appendChild(localThumb);

    for (const person of state.participants.values()) {
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      thumb.dataset.peerId = person.id;

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;

      const peer = state.peers.get(person.id);

      if (peer) {
        video.srcObject = peer.remoteStream;
        video.muted = false;
      }

      const label = document.createElement("div");
      label.className = "thumbName";
      label.textContent = person.name;

      thumb.appendChild(video);
      thumb.appendChild(label);

      thumb.onclick = () => selectVideo(person.id);

      $("thumbnails").appendChild(thumb);
    }

    if (!state.selectedId) {
      selectVideo("local");
    }
  }

  function selectVideo(id) {
    state.selectedId = id;

    let video;
    let name;

    if (id === "local") {
      video = $("thumbnails")
        .querySelector('[data-peer-id="local"] video');

      name = state.name + " (You)";
    } else {
      const thumb = document.querySelector(
        '[data-peer-id="' + CSS.escape(id) + '"]'
      );

      if (!thumb) return;

      video = thumb.querySelector("video");

      const participant = state.participants.get(id);

      name =
        participant?.name ||
        "Anonymous Moderator";
    }

    if (!video) return;

    $("mainVideo").srcObject = video.srcObject;
    $("mainVideo").muted = id === "local";
    $("mainLabel").textContent = name;

    $("mainVideo").play().catch(() => {});

    $("mainVideoWrap").onclick = async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await $("mainVideoWrap").requestFullscreen();
        }
      } catch (_) {}
    };
  }

  function removePeer(id) {
    const peer = state.peers.get(id);

    if (peer) {
      try {
        peer.pc.close();
      } catch (_) {}
    }

    state.peers.delete(id);

    const thumb = document.querySelector(
      '[data-peer-id="' + CSS.escape(id) + '"]'
    );

    if (thumb) thumb.remove();

    if (state.selectedId === id) {
      state.selectedId = "local";
      selectVideo("local");
    }
  }

  function removeParticipant(id) {
    state.participants.delete(id);
    removePeer(id);
    renderThumbnails();
  }

  function addChatMessage(message) {
    if (!message) return;

    const wrapper = document.createElement("div");
    wrapper.className = "message";

    const name = document.createElement("div");
    name.className = "messageName";
    name.textContent = message.name || "Guest";

    const text = document.createElement("div");
    text.className = "messageText";
    text.textContent = message.text || "";

    wrapper.appendChild(name);
    wrapper.appendChild(text);

    $("chatMessages").appendChild(wrapper);
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  }

  function sendChat(event) {
    event.preventDefault();

    const text = $("chatInput").value.trim();

    if (!text || !state.inRoom) return;

    send({
      type: "chatMessage",
      text
    });

    $("chatInput").value = "";
  }

  function createSpeakingDetector(id, stream, element) {
    if (!stream || !stream.getAudioTracks().length) return;
    if (state.detectors.has(id)) return;

    try {
      if (!state.audioContext) {
        state.audioContext = new (
          window.AudioContext ||
          window.webkitAudioContext
        )();
      }

      const source =
        state.audioContext.createMediaStreamSource(stream);

      const analyser =
        state.audioContext.createAnalyser();

      analyser.fftSize = 256;

      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);

      const detector = {
        frame: 0
      };

      state.detectors.set(id, detector);

      const loop = () => {
        if (!state.detectors.has(id)) return;

        analyser.getByteFrequencyData(data);

        let total = 0;

        for (let i = 0; i < data.length; i++) {
          total += data[i];
        }

        const average = total / data.length;

        element.classList.toggle("talking", average > 25);

        detector.frame = requestAnimationFrame(loop);
      };

      loop();

      state.audioContext.resume().catch(() => {});
    } catch (err) {
      console.warn("Speaking detector unavailable:", err);
    }
  }

  function setLayout(layout) {
    state.layout = layout;

    document.body.dataset.layout =
      layout === "auto"
        ? (window.matchMedia("(max-width: 700px)").matches
            ? "phone"
            : "computer")
        : layout;

    $("autoLayoutBtn").classList.toggle(
      "active",
      layout === "auto"
    );

    $("computerLayoutBtn").classList.toggle(
      "active",
      layout === "computer"
    );

    $("phoneLayoutBtn").classList.toggle(
      "active",
      layout === "phone"
    );
  }

  $("createBtn").onclick = createRoom;
  $("joinBtn").onclick = joinRoom;
  $("leaveBtn").onclick = leaveRoom;
  $("chatForm").onsubmit = sendChat;

  $("autoLayoutBtn").onclick = () => setLayout("auto");
  $("computerLayoutBtn").onclick = () => setLayout("computer");
  $("phoneLayoutBtn").onclick = () => setLayout("phone");

  $("roomCodeInput").addEventListener("input", event => {
    event.target.value =
      event.target.value
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, "");
  });

  window.addEventListener("resize", () => {
    if (state.layout === "auto") {
      setLayout("auto");
    }
  });

  setLayout("auto");
})();
</script>
</body>
</html>`;

const MODERATOR_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Moderator Dashboard</title>

<style>
* {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  font-family: Arial, Helvetica, sans-serif;
  background: #080b12;
  color: #fff;
}

body {
  padding: 16px;
}

button,
input,
select {
  font: inherit;
}

button {
  cursor: pointer;
  border: 0;
  border-radius: 10px;
  padding: 10px 13px;
  background: #2d6cdf;
  color: white;
  font-weight: 700;
}

button.secondary {
  background: #273142;
}

button.danger {
  background: #d63838;
}

button.success {
  background: #198754;
}

button.warning {
  background: #c98b20;
}

input,
select {
  width: 100%;
  background: #0c111a;
  color: white;
  border: 1px solid #303b50;
  border-radius: 10px;
  padding: 10px 12px;
}

.hidden {
  display: none !important;
}

.login {
  min-height: calc(100vh - 32px);
  display: flex;
  justify-content: center;
  align-items: center;
}

.loginCard {
  width: min(430px, 100%);
  background: #111722;
  border: 1px solid #273044;
  border-radius: 20px;
  padding: 28px;
}

.field {
  margin-bottom: 13px;
}

.field label {
  display: block;
  color: #aeb9cb;
  font-size: 13px;
  margin-bottom: 6px;
}

.error {
  color: #ff8585;
  margin-top: 12px;
}

#dashboard {
  max-width: 1500px;
  margin: auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 15px;
}

.header h1 {
  margin: 0;
}

.headerButtons {
  display: flex;
  gap: 8px;
}

.level {
  display: inline-block;
  margin-left: 8px;
  padding: 4px 8px;
  border-radius: 7px;
  background: #243252;
  color: #9dbaff;
  font-size: 11px;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 400px);
  gap: 14px;
}

.panel {
  background: #111722;
  border: 1px solid #273044;
  border-radius: 15px;
  padding: 15px;
  margin-bottom: 14px;
}

.panel h2 {
  font-size: 17px;
  margin: 0 0 12px;
}

.roomRow,
.personRow,
.banRow,
.accessRow,
.logRow {
  border: 1px solid #273044;
  border-radius: 11px;
  padding: 11px;
  margin-bottom: 8px;
  background: #0c111a;
}

.rowTop {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.rowButtons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.muted {
  color: #8491a7;
  font-size: 12px;
}

.peopleList {
  margin-top: 10px;
}

.banControls {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 7px;
  margin-top: 8px;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  color: #aeb9cb;
  font-size: 13px;
}

.checkbox input {
  width: auto;
}

.createRoomGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.currentRoom {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
  gap: 10px;
}

.videoArea {
  min-height: 600px;
  background: #020408;
  border-radius: 13px;
  padding: 10px;
  border: 1px solid #273044;
}

.mainVideo {
  width: 100%;
  height: 440px;
  object-fit: contain;
  background: #000;
  border-radius: 11px;
  display: block;
}

.videoThumbs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  margin-top: 9px;
}

.thumb {
  flex: 0 0 120px;
  height: 80px;
  background: #000;
  border: 2px solid #273044;
  border-radius: 9px;
  overflow: hidden;
  position: relative;
  cursor: pointer;
}

.thumb.talking {
  border-color: #27d46b;
}

.thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb span {
  position: absolute;
  bottom: 4px;
  left: 4px;
  right: 4px;
  background: rgba(0,0,0,.7);
  border-radius: 4px;
  padding: 2px 4px;
  font-size: 10px;
}

.chat {
  height: 600px;
  display: flex;
  flex-direction: column;
  background: #0c111a;
  border: 1px solid #273044;
  border-radius: 12px;
}

.chatMessages {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}

.message {
  margin-bottom: 10px;
}

.messageName {
  color: #8190a9;
  font-size: 11px;
}

.messageText {
  margin-top: 3px;
  background: #1b2534;
  border-radius: 8px;
  padding: 7px;
  word-break: break-word;
}

.chatForm {
  display: flex;
  gap: 6px;
  padding: 7px;
  border-top: 1px solid #273044;
}

.chatForm input {
  min-width: 0;
}

.chatForm button {
  width: auto;
}

.status {
  padding: 8px 10px;
  border-radius: 8px;
  background: #15243a;
  color: #a9c8ff;
  margin-bottom: 10px;
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }

  .currentRoom {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  body {
    padding: 8px;
  }

  .createRoomGrid {
    grid-template-columns: 1fr;
  }

  .rowTop {
    align-items: flex-start;
    flex-direction: column;
  }

  .mainVideo {
    height: 45vh;
  }

  .videoArea {
    min-height: 0;
  }

  .chat {
    height: 45vh;
  }
}
</style>
</head>

<body>

<div id="login" class="login">
  <div class="loginCard">
    <h1>Moderator</h1>
    <p class="muted">
      Enter your master or delegated moderator PIN.
    </p>

    <div class="field">
      <label>Moderator PIN</label>
      <input id="pinInput" type="password" autocomplete="off">
    </div>

    <button id="loginBtn">Enter Dashboard</button>

    <div id="loginError" class="error"></div>
  </div>
</div>

<div id="dashboard" class="hidden">

  <div class="header">
    <div>
      <h1>
        Moderator Dashboard
        <span id="levelBadge" class="level"></span>
      </h1>
      <div id="connectionStatus" class="muted">
        Connected
      </div>
    </div>

    <div class="headerButtons">
      <button id="refreshBtn" class="secondary">Refresh</button>
      <button id="logoutBtn" class="danger">Log Out</button>
    </div>
  </div>

  <div id="dashboardStatus" class="status hidden"></div>

  <div class="grid">

    <div>

      <div class="panel">
        <h2>Create Room</h2>

        <div class="createRoomGrid">
          <div>
            <div class="field">
              <label>Room name</label>
              <input id="newRoomName" placeholder="Room name">
            </div>
          </div>

          <div>
            <div class="field">
              <label>Room code</label>
              <input id="newRoomCode" placeholder="Room code">
            </div>
          </div>
        </div>

        <button id="createRoomBtn">Create Room</button>
      </div>

      <div class="panel">
        <h2>Open Rooms</h2>
        <div id="roomsList"></div>
      </div>

      <div id="peoplePanel" class="panel hidden">
        <div class="rowTop">
          <h2 id="peopleTitle">People</h2>
          <button id="closePeopleBtn" class="secondary">Close</button>
        </div>

        <div id="peopleList" class="peopleList"></div>
      </div>

      <div id="currentRoomPanel" class="panel hidden">
        <div class="rowTop">
          <div>
            <h2 id="currentRoomTitle"></h2>
            <div id="currentRoomCode" class="muted"></div>
          </div>

          <button id="leaveRoomBtn" class="danger">
            Leave Room
          </button>
        </div>

        <div class="currentRoom">

          <div class="videoArea">
            <div style="color:#8491a7;font-size:12px;margin-bottom:7px">
              Anonymous moderator — camera and microphone are OFF
            </div>

            <video
              id="moderatorMainVideo"
              class="mainVideo"
              autoplay
              playsinline
            ></video>

            <div id="moderatorThumbs" class="videoThumbs"></div>
          </div>

          <div class="chat">
            <div class="chatMessages" id="moderatorChatMessages"></div>

            <form class="chatForm" id="moderatorChatForm">
              <input id="moderatorChatInput" placeholder="Message room...">
              <button>Send</button>
            </form>
          </div>

        </div>
      </div>

    </div>

    <div>

      <div class="panel">
        <h2>Banned Users</h2>
        <div id="bansList"></div>
      </div>

      <div class="panel">
        <h2>Moderator Access</h2>
        <div id="accessList"></div>
      </div>

      <div class="panel">
        <h2>Moderation History</h2>
        <div id="logList"></div>
      </div>

    </div>

  </div>
</div>

<script>
(() => {
  const state = {
    ws: null,
    authenticated: false,
    level: "",
    selfId: null,
    rooms: [],
    bans: [],
    accesses: [],
    logs: [],
    currentRoom: null,
    currentRoomParticipants: [],
    selectedPeopleRoom: null,
    peers: new Map(),
    audioContext: null,
    detectors: new Map()
  };

  const $ = id => document.getElementById(id);

  function wsUrl() {
    const protocol =
      location.protocol === "https:" ? "wss:" : "ws:";

    return protocol + "//" + location.host + "/ws";
  }

  function send(data) {
    if (!state.ws ||
        state.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    state.ws.send(JSON.stringify(data));
    return true;
  }

  function connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      state.ws = ws;

      ws.onopen = () => resolve();

      ws.onerror = () => {
        reject(new Error("Connection failed."));
      };

      ws.onclose = () => {
        $("connectionStatus").textContent =
          "Disconnected";
      };

      ws.onmessage = async event => {
        try {
          const msg = JSON.parse(event.data);
          await handleMessage(msg);
        } catch (err) {
          console.error(err);
        }
      };
    });
  }

  async function login() {
    $("loginError").textContent = "";

    const pin = $("pinInput").value.trim();

    if (!pin) {
      $("loginError").textContent = "Enter your PIN.";
      return;
    }

    try {
      if (!state.ws ||
          state.ws.readyState !== WebSocket.OPEN) {
        await connect();
      }

      send({
        type: "moderatorAuth",
        pin
      });
    } catch (err) {
      $("loginError").textContent = err.message;
    }
  }

  async function handleMessage(msg) {
    switch (msg.type) {

      case "moderatorAuthSuccess":
        state.authenticated = true;
        state.level = msg.level;
        state.selfId = msg.selfId;

        state.rooms = msg.rooms || [];
        state.bans = msg.bans || [];
        state.accesses = msg.moderatorAccess || [];
        state.logs = msg.moderationLog || [];

        $("login").classList.add("hidden");
        $("dashboard").classList.remove("hidden");

        $("levelBadge").textContent =
          msg.level === "master"
            ? "MASTER"
            : "DELEGATED";

        renderEverything();
        break;

      case "moderatorData":
        state.rooms = msg.rooms || [];
        state.bans = msg.bans || [];
        state.accesses = msg.moderatorAccess || [];
        state.logs = msg.moderationLog || [];

        renderEverything();
        break;

      case "roomJoined":
        await enterModeratorRoom(msg);
        break;

      case "signal":
        await handleSignal(msg);
        break;

      case "userJoined":
        if (msg.participant) {
          const exists =
            state.currentRoomParticipants.some(
              p => p.id === msg.participant.id
            );

          if (!exists) {
            state.currentRoomParticipants.push(
              msg.participant
            );
          }

          renderCurrentPeople();
        }
        break;

      case "userLeft":
        state.currentRoomParticipants =
          state.currentRoomParticipants.filter(
            p => p.id !== msg.id
          );

        removePeer(msg.id);
        renderCurrentPeople();
        break;

      case "chatMessage":
        addModeratorChat(msg.message);
        break;

      case "kicked":
        showStatus(msg.message || "User kicked.");
        break;

      case "banned":
        showStatus(msg.message || "User banned.");
        break;

      case "moderatorAccessCreated":
        showStatus(
          "Moderator created. PIN: " + msg.pin
        );
        break;

      case "error":
        showStatus(msg.message || "Error.");
        break;
    }
  }

  function showStatus(text) {
    $("dashboardStatus").textContent = text;
    $("dashboardStatus").classList.remove("hidden");

    clearTimeout(showStatus.timer);

    showStatus.timer = setTimeout(() => {
      $("dashboardStatus").classList.add("hidden");
    }, 5000);
  }

  function renderEverything() {
    renderRooms();
    renderBans();
    renderAccess();
    renderLogs();

    if (state.selectedPeopleRoom) {
      const room =
        state.rooms.find(
          r => r.code === state.selectedPeopleRoom
        );

      if (room) {
        renderPeople(room);
      } else {
        closePeople();
      }
    }

    if (state.currentRoom) {
      const room =
        state.rooms.find(
          r => r.code === state.currentRoom.code
        );

      if (room) {
        state.currentRoomParticipants =
          room.participants || [];

        renderCurrentPeople();
      }
    }
  }

  function renderRooms() {
    const list = $("roomsList");
    list.innerHTML = "";

    if (!state.rooms.length) {
      list.innerHTML =
        '<div class="muted">No open rooms.</div>';
      return;
    }

    for (const room of state.rooms) {
      const row = document.createElement("div");
      row.className = "roomRow";

      const top = document.createElement("div");
      top.className = "rowTop";

      const info = document.createElement("div");

      const title = document.createElement("strong");
      title.textContent = room.name;

      const details = document.createElement("div");
      details.className = "muted";
      details.textContent =
        room.code +
        " • " +
        room.participantCount +
        " participant" +
        (room.participantCount === 1 ? "" : "s");

      info.appendChild(title);
      info.appendChild(details);

      const buttons = document.createElement("div");
      buttons.className = "rowButtons";

      const people = document.createElement("button");
      people.className = "secondary";
      people.textContent = "View People";

      people.onclick = () => {
        state.selectedPeopleRoom = room.code;
        renderPeople(room);
      };

      const join = document.createElement("button");
      join.textContent = "Join";

      join.onclick = () => {
        joinRoom(room.code);
      };

      top.appendChild(info);
      top.appendChild(buttons);

      buttons.appendChild(people);
      buttons.appendChild(join);

      row.appendChild(top);
      list.appendChild(row);
    }
  }

  function renderPeople(room) {
    $("peoplePanel").classList.remove("hidden");

    $("peopleTitle").textContent =
      "People — " + room.name;

    const list = $("peopleList");
    list.innerHTML = "";

    const people = room.participants || [];

    if (!people.length) {
      list.innerHTML =
        '<div class="muted">Nobody is currently in this room.</div>';
      return;
    }

    for (const person of people) {
      const row = document.createElement("div");
      row.className = "personRow";

      const top = document.createElement("div");
      top.className = "rowTop";

      const name = document.createElement("strong");
      name.textContent = person.name;

      const buttons = document.createElement("div");
      buttons.className = "rowButtons";

      const kick = document.createElement("button");
      kick.className = "danger";
      kick.textContent = "Kick";

      // NO CONFIRMATION.
      kick.onclick = () => {
        send({
          type: "kick",
          targetId: person.id
        });
      };

      const ban = document.createElement("button");
      ban.className = "danger";
      ban.textContent = "Ban";

      ban.onclick = () => {
        const amountInput =
          row.querySelector(".banAmount");

        const unitInput =
          row.querySelector(".banUnit");

        const permanent =
          row.querySelector(".banPermanent").checked;

        send({
          type: "ban",
          targetId: person.id,
          amount: amountInput.value,
          unit: unitInput.value,
          permanent
        });
      };

      buttons.appendChild(kick);
      buttons.appendChild(ban);

      top.appendChild(name);
      top.appendChild(buttons);

      const controls = document.createElement("div");
      controls.className = "banControls";

      const amount = document.createElement("input");
      amount.className = "banAmount";
      amount.type = "number";
      amount.min = "1";
      amount.value = "10";

      const unit = document.createElement("select");
      unit.className = "banUnit";

      const units = [
        ["second", "Seconds"],
        ["minute", "Minutes"],
        ["hour", "Hours"],
        ["day", "Days"],
        ["week", "Weeks"],
        ["month", "Months"],
        ["year", "Years"]
      ];

      for (const [value, label] of units) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        unit.appendChild(option);
      }

      const permanentLabel =
        document.createElement("label");

      permanentLabel.className = "checkbox";

      const permanent =
        document.createElement("input");

      permanent.className = "banPermanent";
      permanent.type = "checkbox";

      permanent.onchange = () => {
        amount.disabled = permanent.checked;
        unit.disabled = permanent.checked;
      };

      permanentLabel.appendChild(permanent);
      permanentLabel.appendChild(
        document.createTextNode(" Permanent")
      );

      controls.appendChild(amount);
      controls.appendChild(unit);

      row.appendChild(top);
      row.appendChild(controls);
      row.appendChild(permanentLabel);

      list.appendChild(row);
    }
  }

  function closePeople() {
    state.selectedPeopleRoom = null;
    $("peoplePanel").classList.add("hidden");
  }

  function renderCurrentPeople() {
    if (!state.currentRoom) return;

    const room = state.rooms.find(
      r => r.code === state.currentRoom.code
    );

    if (!room) return;

    // Keep room participant list synchronized.
    state.currentRoomParticipants =
      room.participants || state.currentRoomParticipants;
  }

  function renderBans() {
    const list = $("bansList");
    list.innerHTML = "";

    if (!state.bans.length) {
      list.innerHTML =
        '<div class="muted">No active bans.</div>';
      return;
    }

    for (const ban of state.bans) {
      const row = document.createElement("div");
      row.className = "banRow";

      const top = document.createElement("div");
      top.className = "rowTop";

      const info = document.createElement("div");

      const name = document.createElement("strong");
      name.textContent = ban.name;

      const detail = document.createElement("div");
      detail.className = "muted";
      detail.textContent =
        ban.durationText +
        " • Room: " +
        (ban.roomCode || "unknown");

      info.appendChild(name);
      info.appendChild(detail);

      const button = document.createElement("button");
      button.className = "success";
      button.textContent = "Unban";

      button.onclick = () => {
        send({
          type: "unban",
          banId: ban.id
        });
      };

      top.appendChild(info);
      top.appendChild(button);

      row.appendChild(top);
      list.appendChild(row);
    }
  }

  function renderAccess() {
    const list = $("accessList");
    list.innerHTML = "";

    if (!state.accesses.length) {
      list.innerHTML =
        '<div class="muted">No delegated moderators.</div>';
      return;
    }

    for (const access of state.accesses) {
      const row = document.createElement("div");
      row.className = "accessRow";

      const top = document.createElement("div");
      top.className = "rowTop";

      const info = document.createElement("div");

      const name = document.createElement("strong");
      name.textContent = access.name;

      const detail = document.createElement("div");
      detail.className = "muted";
      detail.textContent =
        access.durationText;

      info.appendChild(name);
      info.appendChild(detail);

      const button = document.createElement("button");
      button.className = "danger";
      button.textContent = "Revoke";

      button.disabled =
        state.level !== "master";

      button.onclick = () => {
        send({
          type: "revokeModerator",
          accessId: access.id
        });
      };

      top.appendChild(info);
      top.appendChild(button);

      row.appendChild(top);
      list.appendChild(row);
    }
  }

  function renderLogs() {
    const list = $("logList");
    list.innerHTML = "";

    if (!state.logs.length) {
      list.innerHTML =
        '<div class="muted">No moderation history.</div>';
      return;
    }

    for (const log of state.logs.slice(0, 50)) {
      const row = document.createElement("div");
      row.className = "logRow";

      const action = document.createElement("strong");
      action.textContent = log.action;

      const detail = document.createElement("div");
      detail.className = "muted";

      detail.textContent =
        log.moderatorName +
        (log.targetName
          ? " → " + log.targetName
          : "") +
        (log.details
          ? " • " + log.details
          : "");

      row.appendChild(action);
      row.appendChild(detail);

      list.appendChild(row);
    }
  }

  function joinRoom(code) {
    send({
      type: "moderatorJoinRoom",
      roomCode: code
    });
  }

  async function enterModeratorRoom(msg) {
    state.currentRoom = msg.room;
    state.currentRoomParticipants =
      msg.room.participants || [];

    $("currentRoomPanel").classList.remove("hidden");

    $("currentRoomTitle").textContent =
      msg.room.name;

    $("currentRoomCode").textContent =
      "Code: " + msg.room.code;

    $("moderatorChatMessages").innerHTML = "";

    for (const message of msg.room.messages || []) {
      addModeratorChat(message);
    }

    renderCurrentPeople();

    // IMPORTANT:
    // The moderator does NOT call getUserMedia.
    // The moderator only answers incoming offers.
  }

  function leaveRoom() {
    if (!state.currentRoom) return;

    send({
      type: "leaveRoom"
    });

    for (const [, peer] of state.peers) {
      try {
        peer.pc.close();
      } catch (_) {}
    }

    state.peers.clear();

    for (const [, detector] of state.detectors) {
      cancelAnimationFrame(detector.frame);
    }

    state.detectors.clear();

    state.currentRoom = null;
    state.currentRoomParticipants = [];

    $("currentRoomPanel").classList.add("hidden");
    $("moderatorMainVideo").srcObject = null;
    $("moderatorThumbs").innerHTML = "";
    $("moderatorChatMessages").innerHTML = "";
  }

  function createPeer(remoteId) {
    let existing = state.peers.get(remoteId);

    if (existing) return existing.pc;

    const pc = new RTCPeerConnection({
      iceServers: ${JSON.stringify(STUN_SERVERS)}
    });

    const peer = {
      pc,
      stream: new MediaStream(),
      iceQueue: []
    };

    state.peers.set(remoteId, peer);

    // NO local tracks.
    // Moderator is receive-only.

    pc.onicecandidate = event => {
      if (!event.candidate) return;

      send({
        type: "signal",
        targetId: remoteId,
        signalType: "ice",
        data: event.candidate
      });
    };

    pc.ontrack = event => {
      const stream = event.streams?.[0];

      if (stream) {
        peer.stream = stream;
      } else {
        peer.stream.addTrack(event.track);
      }

      attachModeratorVideo(
        remoteId,
        peer.stream
      );
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        removePeer(remoteId);
      }
    };

    return pc;
  }

  async function handleSignal(msg) {
    const remoteId = msg.fromId;

    if (!remoteId) return;

    if (msg.signalType === "offer") {
      const pc = createPeer(remoteId);
      const peer = state.peers.get(remoteId);

      try {
        // The incoming offer already contains the sender's
        // audio/video tracks. The moderator adds NO local tracks.
        await pc.setRemoteDescription(
          new RTCSessionDescription(msg.data)
        );

        for (const candidate of peer.iceQueue) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }

        peer.iceQueue = [];

        const answer = await pc.createAnswer();

        await pc.setLocalDescription(answer);

        send({
          type: "signal",
          targetId: remoteId,
          signalType: "answer",
          data: pc.localDescription
        });
      } catch (err) {
        console.error(
          "Moderator offer handling error:",
          err
        );
      }

      return;
    }

    if (msg.signalType === "ice") {
      const peer = state.peers.get(remoteId);

      if (!peer) return;

      const candidate =
        new RTCIceCandidate(msg.data);

      if (peer.pc.remoteDescription) {
        await peer.pc
          .addIceCandidate(candidate)
          .catch(() => {});
      } else {
        peer.iceQueue.push(candidate);
      }
    }
  }

  function attachModeratorVideo(id, stream) {
    let thumb = document.querySelector(
      '[data-peer-id="' +
      CSS.escape(id) +
      '"]'
    );

    const person =
      state.currentRoomParticipants.find(
        p => p.id === id
      );

    const name =
      person?.name || "Participant";

    if (!thumb) {
      thumb = document.createElement("div");
      thumb.className = "thumb";
      thumb.dataset.peerId = id;

      const video = document.createElement("video");

      video.autoplay = true;
      video.playsInline = true;
      video.muted = false;

      const label = document.createElement("span");
      label.textContent = name;

      thumb.appendChild(video);
      thumb.appendChild(label);

      thumb.onclick = () => {
        $("moderatorMainVideo").srcObject =
          video.srcObject;

        $("moderatorMainVideo").muted = false;

        $("moderatorMainVideo")
          .play()
          .catch(() => {});
      };

      $("moderatorThumbs").appendChild(thumb);
    }

    const video = thumb.querySelector("video");

    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;

    video.play().catch(() => {
      // Browser may require a user interaction.
      // The moderator joined through a button, so this
      // normally succeeds.
    });

    if (!$("moderatorMainVideo").srcObject) {
      $("moderatorMainVideo").srcObject = stream;
      $("moderatorMainVideo").muted = false;
      $("moderatorMainVideo").play().catch(() => {});
    }

    createSpeakingDetector(id, stream, thumb);
  }

  function removePeer(id) {
    const peer = state.peers.get(id);

    if (peer) {
      try {
        peer.pc.close();
      } catch (_) {}
    }

    state.peers.delete(id);

    const thumb = document.querySelector(
      '[data-peer-id="' +
      CSS.escape(id) +
      '"]'
    );

    if (thumb) thumb.remove();
  }

  function addModeratorChat(message) {
    const wrapper = document.createElement("div");
    wrapper.className = "message";

    const name = document.createElement("div");
    name.className = "messageName";
    name.textContent =
      message.name || "Guest";

    const text = document.createElement("div");
    text.className = "messageText";
    text.textContent =
      message.text || "";

    wrapper.appendChild(name);
    wrapper.appendChild(text);

    $("moderatorChatMessages").appendChild(wrapper);

    $("moderatorChatMessages").scrollTop =
      $("moderatorChatMessages").scrollHeight;
  }

  function sendChat(event) {
    event.preventDefault();

    const input = $("moderatorChatInput");
    const text = input.value.trim();

    if (!text || !state.currentRoom) return;

    send({
      type: "chatMessage",
      text
    });

    input.value = "";
  }

  function createSpeakingDetector(id, stream, element) {
    if (!stream.getAudioTracks().length) return;
    if (state.detectors.has(id)) return;

    try {
      if (!state.audioContext) {
        state.audioContext = new (
          window.AudioContext ||
          window.webkitAudioContext
        )();
      }

      const source =
        state.audioContext.createMediaStreamSource(stream);

      const analyser =
        state.audioContext.createAnalyser();

      analyser.fftSize = 256;

      source.connect(analyser);

      const data =
        new Uint8Array(
          analyser.frequencyBinCount
        );

      const detector = { frame: 0 };

      state.detectors.set(id, detector);

      const loop = () => {
        if (!state.detectors.has(id)) return;

        analyser.getByteFrequencyData(data);

        let total = 0;

        for (let i = 0; i < data.length; i++) {
          total += data[i];
        }

        const average =
          total / data.length;

        element.classList.toggle(
          "talking",
          average > 25
        );

        detector.frame =
          requestAnimationFrame(loop);
      };

      loop();

      state.audioContext
        .resume()
        .catch(() => {});
    } catch (err) {
      console.warn(err);
    }
  }

  $("loginBtn").onclick = login;

  $("pinInput").addEventListener("keydown", event => {
    if (event.key === "Enter") login();
  });

  $("refreshBtn").onclick = () => {
    send({
      type: "getModeratorData"
    });
  };

  $("closePeopleBtn").onclick = closePeople;

  $("leaveRoomBtn").onclick = leaveRoom;

  $("moderatorChatForm").onsubmit = sendChat;

  $("createRoomBtn").onclick = () => {
    const name =
      $("newRoomName").value.trim();

    const code =
      $("newRoomCode").value.trim();

    if (!name || !code) {
      showStatus(
        "Enter both a room name and room code."
      );
      return;
    }

    send({
      type: "moderatorCreateRoom",
      roomName: name,
      roomCode: code
    });

    $("newRoomName").value = "";
    $("newRoomCode").value = "";
  };

  $("newRoomCode").addEventListener(
    "input",
    event => {
      event.target.value =
        event.target.value
          .toUpperCase()
          .replace(/[^A-Z0-9_-]/g, "");
    }
  );

  $("logoutBtn").onclick = () => {
    leaveRoom();

    if (state.ws) {
      state.ws.close();
    }

    location.reload();
  };
})();
</script>
</body>
</html>`;

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        ok: true,
        rooms: rooms.size,
        clients: clients.size
      })
    );

    return;
  }

  if (
    req.url === "/" ||
    req.url === "/index.html"
  ) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });

    res.end(INDEX_HTML);
    return;
  }

  if (
    req.url === "/blueberry" ||
    req.url === "/blueberry.html"
  ) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });

    res.end(MODERATOR_HTML);
    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain"
  });

  res.end("Not found");
});

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

wss.on("connection", ws => {
  const connection = {
    ws,
    id: makeId("client"),
    userId: null,
    name: "Guest",
    role: null,
    moderatorLevel: null,
    moderatorAccessId: null,
    roomCode: null
  };

  ws.on("message", raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      send(ws, {
        type: "error",
        message: "Invalid message."
      });
      return;
    }

    handleSocketMessage(connection, msg);
  });

  ws.on("close", () => {
    if (connection.roomCode) {
      removeFromRoom(connection);
    }

    clients.delete(connection.id);

    broadcastModeratorData();
  });
});

// ============================================================
// SOCKET MESSAGE HANDLER
// ============================================================

function handleSocketMessage(client, msg) {
  switch (msg.type) {

    // --------------------------------------------------------
    // NORMAL USER REGISTER
    // --------------------------------------------------------

    case "register": {
      const userId =
        String(msg.userId || "").slice(0, 100);

      if (!userId) {
        send(client.ws, {
          type: "error",
          message: "Missing user ID."
        });
        return;
      }

      const ban = getBanByUserId(userId);

      if (ban) {
        send(client.ws, {
          type: "error",
          message:
            "You are banned. " +
            ban.durationText
        });

        client.ws.close();
        return;
      }

      client.userId = userId;
      client.role = "user";

      clients.set(client.id, client);

      send(client.ws, {
        type: "registered",
        id: client.id
      });

      break;
    }

    // --------------------------------------------------------
    // SET NAME
    // --------------------------------------------------------

    case "setName": {
      client.name = cleanName(msg.name);
      break;
    }

    // --------------------------------------------------------
    // MODERATOR AUTH
    // --------------------------------------------------------

    case "moderatorAuth": {
      const pin = cleanPin(msg.pin);

      if (!pin) {
        send(client.ws, {
          type: "error",
          message: "Enter a moderator PIN."
        });
        return;
      }

      let level = null;
      let access = null;

      if (pin === MASTER_PIN) {
        level = "master";
      } else {
        access = getModeratorAccessByPin(pin);

        if (access) {
          level = "delegated";
        }
      }

      if (!level) {
        send(client.ws, {
          type: "error",
          message: "Invalid or expired moderator PIN."
        });
        return;
      }

      // A socket can switch from normal user to moderator
      // only before entering a room.
      if (client.roomCode) {
        removeFromRoom(client);
      }

      client.role = "moderator";
      client.name =
        access?.name ||
        "Moderator";

      client.moderatorLevel = level;
      client.moderatorAccessId =
        access?.id || null;

      clients.set(client.id, client);

      send(client.ws, {
        type: "moderatorAuthSuccess",
        selfId: client.id,
        level,
        rooms: getRoomList(),
        bans: getBanList(),
        moderatorAccess: getModeratorAccessList(),
        moderationLog: getModeratorLog()
      });

      break;
    }

    // --------------------------------------------------------
    // CREATE ROOM
    // --------------------------------------------------------

    case "createRoom": {
      if (client.role !== "user") {
        send(client.ws, {
          type: "error",
          message: "Only normal users can create rooms here."
        });
        return;
      }

      const roomName =
        cleanRoomName(msg.roomName);

      const requestedCode =
        cleanRoomCode(msg.roomCode);

      if (!requestedCode) {
        send(client.ws, {
          type: "error",
          message: "Enter a room code."
        });
        return;
      }

      const room =
        createRoom(roomName, requestedCode);

      if (!room) {
        send(client.ws, {
          type: "error",
          message:
            "That room code is already in use."
        });
        return;
      }

      send(client.ws, {
        type: "roomCreated",
        roomCode: room.code,
        roomName: room.name
      });

      joinRoom(client, room);

      break;
    }

    // --------------------------------------------------------
    // MODERATOR CREATE ROOM
    // --------------------------------------------------------

    case "moderatorCreateRoom": {
      if (!isModerator(client)) {
        send(client.ws, {
          type: "error",
          message: "Moderator access required."
        });
        return;
      }

      const room =
        createRoom(
          msg.roomName,
          msg.roomCode
        );

      if (!room) {
        send(client.ws, {
          type: "error",
          message:
            "That room code is already in use."
        });
        return;
      }

      send(client.ws, {
        type: "roomCreated",
        roomCode: room.code,
        roomName: room.name
      });

      broadcastModeratorData();

      break;
    }

    // --------------------------------------------------------
    // JOIN ROOM
    // --------------------------------------------------------

    case "joinRoom": {
      if (client.role !== "user") {
        send(client.ws, {
          type: "error",
          message: "Normal-user access required."
        });
        return;
      }

      const code =
        cleanRoomCode(msg.roomCode);

      const room = rooms.get(code);

      if (!room) {
        send(client.ws, {
          type: "error",
          message: "Room not found."
        });
        return;
      }

      joinRoom(client, room);
      break;
    }

    // --------------------------------------------------------
    // MODERATOR JOIN ROOM
    // --------------------------------------------------------

    case "moderatorJoinRoom": {
      if (!isModerator(client)) {
        send(client.ws, {
          type: "error",
          message: "Moderator access required."
        });
        return;
      }

      const code =
        cleanRoomCode(msg.roomCode);

      const room = rooms.get(code);

      if (!room) {
        send(client.ws, {
          type: "error",
          message: "Room not found."
        });
        return;
      }

      joinRoom(client, room);
      break;
    }

    // --------------------------------------------------------
    // LEAVE ROOM
    // --------------------------------------------------------

    case "leaveRoom": {
      removeFromRoom(client);
      break;
    }

    // --------------------------------------------------------
    // WEBRTC SIGNALING
    // --------------------------------------------------------

    case "signal": {
      if (!client.roomCode) return;

      const target =
        clients.get(String(msg.targetId || ""));

      if (!target) return;

      if (target.roomCode !== client.roomCode) {
        return;
      }

      send(target.ws, {
        type: "signal",
        fromId: client.id,
        signalType: msg.signalType,
        data: msg.data
      });

      break;
    }

    // --------------------------------------------------------
    // CHAT
    // --------------------------------------------------------

    case "chatMessage": {
      if (!client.roomCode) return;

      const room =
        rooms.get(client.roomCode);

      if (!room) return;

      let text =
        String(msg.text || "")
          .trim()
          .slice(0, 500);

      if (!text) return;

      const message = {
        id: makeId("message"),
        name: client.name,
        text,
        senderId: client.id,
        moderator:
          client.role === "moderator",
        createdAt: Date.now()
      };

      room.messages.push(message);

      if (room.messages.length > 100) {
        room.messages.splice(
          0,
          room.messages.length - 100
        );
      }

      broadcastRoom(room, {
        type: "chatMessage",
        message
      });

      break;
    }

    // --------------------------------------------------------
    // KICK
    // --------------------------------------------------------

    case "kick": {
      if (!isModerator(client)) {
        send(client.ws, {
          type: "error",
          message: "Moderator access required."
        });
        return;
      }

      const target =
        clients.get(String(msg.targetId || ""));

      if (!target) {
        send(client.ws, {
          type: "error",
          message: "User not found."
        });
        return;
      }

      if (!canControlTarget(client, target)) {
        send(client.ws, {
          type: "error",
          message:
            "You cannot control that account."
        });
        return;
      }

      if (!target.roomCode) {
        send(client.ws, {
          type: "error",
          message: "User is not in a room."
        });
        return;
      }

      const roomCode =
        target.roomCode;

      addLog(
        "KICK",
        client,
        target,
        roomCode
      );

      send(target.ws, {
        type: "kicked",
        message:
          "You were kicked from the room."
      });

      removeFromRoom(target);

      broadcastModeratorData();

      break;
    }

    // --------------------------------------------------------
    // BAN
    // --------------------------------------------------------

    case "ban": {
      if (!isModerator(client)) {
        send(client.ws, {
          type: "error",
          message: "Moderator access required."
        });
        return;
      }

      const target =
        clients.get(String(msg.targetId || ""));

      if (!target) {
        send(client.ws, {
          type: "error",
          message: "User not found."
        });
        return;
      }

      if (!canControlTarget(client, target)) {
        send(client.ws, {
          type: "error",
          message:
            "You cannot control that account."
        });
        return;
      }

      const permanent =
        Boolean(msg.permanent);

      const unit =
        String(msg.unit || "minute");

      const amount =
        Number(msg.amount || 10);

      if (
        !permanent &&
        (
          !Number.isFinite(amount) ||
          amount <= 0
        )
      ) {
        send(client.ws, {
          type: "error",
          message: "Enter a valid ban duration."
        });
        return;
      }

      const expiresAt =
        calculateDuration(
          amount,
          unit,
          permanent
        );

      if (!permanent && !expiresAt) {
        send(client.ws, {
          type: "error",
          message: "Invalid ban duration."
        });
        return;
      }

      const durationText =
        permanent
          ? "Permanent"
          : formatDuration(amount, unit);

      const existing =
        getBanByUserId(target.userId);

      if (existing) {
        bannedUsers.delete(existing.id);
      }

      const ban = {
        id: makeId("ban"),
        userId: target.userId,
        name: target.name,
        moderatorId: client.id,
        moderatorName: client.name,
        roomCode: target.roomCode || "",
        createdAt: Date.now(),
        expiresAt,
        durationText
      };

      bannedUsers.set(ban.id, ban);

      addLog(
        "BAN",
        client,
        target,
        target.roomCode,
        durationText
      );

      send(target.ws, {
        type: "banned",
        message:
          "You were banned. Duration: " +
          durationText
      });

      removeFromRoom(target);

      target.ws.close();

      broadcastModeratorData();

      break;
    }

    // --------------------------------------------------------
    // UNBAN
    // --------------------------------------------------------

    case "unban": {
      if (!isModerator(client)) {
        send(client.ws, {
          type: "error",
          message: "Moderator access required."
        });
        return;
      }

      const banId =
        String(msg.banId || "");

      const ban =
        bannedUsers.get(banId);

      if (!ban) {
        send(client.ws, {
          type: "error",
          message: "Ban not found."
        });
        return;
      }

      bannedUsers.delete(banId);

      addLog(
        "UNBAN",
        client,
        {
          id: ban.userId,
          name: ban.name
        },
        ban.roomCode
      );

      broadcastModeratorData();

      break;
    }

    // --------------------------------------------------------
    // GIVE MODERATOR
    // --------------------------------------------------------

    case "giveModerator": {
      if (!isMasterModerator(client)) {
        send(client.ws, {
          type: "error",
          message:
            "Only the master moderator can do this."
        });
        return;
      }

      const target =
        clients.get(String(msg.targetId || ""));

      if (!target || target.role !== "user") {
        send(client.ws, {
          type: "error",
          message:
            "That user is not available."
        });
        return;
      }

      const pin =
        cleanPin(msg.pin);

      if (pin.length < 4) {
        send(client.ws, {
          type: "error",
          message:
            "Moderator PIN must be at least 4 characters."
        });
        return;
      }

      if (pin === MASTER_PIN) {
        send(client.ws, {
          type: "error",
          message:
            "Choose a different PIN."
        });
        return;
      }

      if (getModeratorAccessByPin(pin)) {
        send(client.ws, {
          type: "error",
          message:
            "That moderator PIN is already in use."
        });
        return;
      }

      const permanent =
        Boolean(msg.permanent);

      const unit =
        String(msg.unit || "hour");

      const amount =
        Number(msg.amount || 1);

      const expiresAt =
        calculateDuration(
          amount,
          unit,
          permanent
        );

      if (!permanent && !expiresAt) {
        send(client.ws, {
          type: "error",
          message:
            "Invalid moderator duration."
        });
        return;
      }

      const access = {
        id: makeId("mod"),
        pinHash: hashPin(pin),
        name: target.name,
        targetUserId: target.userId,
        createdBy: client.name,
        createdAt: Date.now(),
        expiresAt,
        durationText:
          permanent
            ? "Permanent"
            : formatDuration(amount, unit)
      };

      moderatorAccess.set(
        access.id,
        access
      );

      send(client.ws, {
        type: "moderatorAccessCreated",
        pin,
        name: access.name,
        durationText:
          access.durationText
      });

      send(target.ws, {
        type: "moderatorAccessGranted",
        pin,
        durationText:
          access.durationText
      });

      addLog(
        "GIVE MODERATOR",
        client,
        target,
        target.roomCode,
        access.durationText
      );

      broadcastModeratorData();

      break;
    }

    // --------------------------------------------------------
    // REVOKE MODERATOR
    // --------------------------------------------------------

    case "revokeModerator": {
      if (!isMasterModerator(client)) {
        send(client.ws, {
          type: "error",
          message:
            "Only the master moderator can revoke access."
        });
        return;
      }

      const accessId =
        String(msg.accessId || "");

      const access =
        moderatorAccess.get(accessId);

      if (!access) {
        send(client.ws, {
          type: "error",
          message:
            "Moderator access not found."
        });
        return;
      }

      moderatorAccess.delete(accessId);

      for (const target of clients.values()) {
        if (
          target.role === "moderator" &&
          target.moderatorAccessId === accessId
        ) {
          if (target.roomCode) {
            removeFromRoom(target);
          }

          send(target.ws, {
            type: "error",
            message:
              "Your moderator access was revoked."
          });

          target.ws.close();
        }
      }

      addLog(
        "REVOKE MODERATOR",
        client,
        {
          id: access.targetUserId,
          name: access.name
        },
        ""
      );

      broadcastModeratorData();

      break;
    }

    // --------------------------------------------------------
    // GET MODERATOR DATA
    // --------------------------------------------------------

    case "getModeratorData": {
      if (!isModerator(client)) return;

      send(client.ws, {
        type: "moderatorData",
        rooms: getRoomList(),
        bans: getBanList(),
        moderatorAccess:
          getModeratorAccessList(),
        moderationLog:
          getModeratorLog()
      });

      break;
    }
  }
}

// ============================================================
// CLEANUP
// ============================================================

setInterval(() => {
  cleanExpiredBans();
  cleanExpiredModeratorAccess();
  broadcastModeratorData();
}, 5000);

// ============================================================
// START
// ============================================================

server.listen(PORT, () => {
  console.log(
    "Video Chat server running on port " + PORT
  );
});

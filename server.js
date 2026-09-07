const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

// ============================================================
// CONFIG
// ============================================================

const MASTER_PIN = "230323038227";

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" }
];

// ============================================================
// IN-MEMORY DATA
// ============================================================

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Map();
const moderatorAccess = new Map();
const moderationLog = [];

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

function send(client, data) {
  if (!client || !client.ws) return;

  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
}

function cleanName(name) {
  return String(name || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 40);
}

function cleanRoomName(name) {
  return String(name || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 60);
}

function cleanRoomCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

function cleanPin(pin) {
  return String(pin || "")
    .replace(/\s/g, "")
    .slice(0, 100);
}

function addLog(action, moderator, target, roomCode, details = "") {
  moderationLog.unshift({
    id: makeId("log"),
    action,
    moderator: moderator || "Unknown",
    target: target || "",
    roomCode: roomCode || "",
    details,
    createdAt: Date.now()
  });

  if (moderationLog.length > 500) {
    moderationLog.length = 500;
  }
}

function formatDuration(seconds) {
  if (seconds === null) return "Permanent";

  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  if (seconds < 3600) {
    const n = Math.floor(seconds / 60);
    return `${n} minute${n === 1 ? "" : "s"}`;
  }

  if (seconds < 86400) {
    const n = Math.floor(seconds / 3600);
    return `${n} hour${n === 1 ? "" : "s"}`;
  }

  if (seconds < 604800) {
    const n = Math.floor(seconds / 86400);
    return `${n} day${n === 1 ? "" : "s"}`;
  }

  if (seconds < 2592000) {
    const n = Math.floor(seconds / 604800);
    return `${n} week${n === 1 ? "" : "s"}`;
  }

  if (seconds < 31536000) {
    const n = Math.floor(seconds / 2592000);
    return `${n} month${n === 1 ? "" : "s"}`;
  }

  const n = Math.floor(seconds / 31536000);
  return `${n} year${n === 1 ? "" : "s"}`;
}

function calculateDuration(data) {
  if (data.permanent) {
    return null;
  }

  const seconds =
    Number(data.seconds || 0) +
    Number(data.minutes || 0) * 60 +
    Number(data.hours || 0) * 60 * 60 +
    Number(data.days || 0) * 24 * 60 * 60 +
    Number(data.weeks || 0) * 7 * 24 * 60 * 60 +
    Number(data.months || 0) * 30 * 24 * 60 * 60 +
    Number(data.years || 0) * 365 * 24 * 60 * 60;

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  return Math.floor(seconds);
}

function cleanExpiredBans() {
  const now = Date.now();

  for (const [key, ban] of bannedUsers.entries()) {
    if (ban.expiresAt !== null && ban.expiresAt <= now) {
      bannedUsers.delete(key);
    }
  }
}

function cleanExpiredModeratorAccess() {
  const now = Date.now();

  for (const [id, access] of moderatorAccess.entries()) {
    if (access.expiresAt !== null && access.expiresAt <= now) {
      moderatorAccess.delete(id);

      for (const client of clients.values()) {
        if (
          client.role === "moderator" &&
          client.moderatorAccessId === id
        ) {
          send(client, {
            type: "moderatorAccessExpired"
          });

          client.ws.close();
        }
      }
    }
  }
}

function getBan(client) {
  cleanExpiredBans();

  const possibleIds = [
    client.userId,
    client.name
  ].filter(Boolean);

  for (const ban of bannedUsers.values()) {
    if (possibleIds.includes(ban.userId) || possibleIds.includes(ban.name)) {
      return ban;
    }
  }

  return null;
}

function getModeratorAccessByPin(pin) {
  cleanExpiredModeratorAccess();

  const hashed = hashPin(pin);

  for (const access of moderatorAccess.values()) {
    if (access.pinHash === hashed) {
      return access;
    }
  }

  return null;
}

function isMasterModerator(client) {
  return (
    client &&
    client.role === "moderator" &&
    client.moderatorLevel === "master"
  );
}

function canModerate(client) {
  return client && client.role === "moderator";
}

function canControlTarget(moderator, target) {
  if (!moderator || !target) return false;

  // Delegated moderators cannot kick/ban other moderators.
  if (
    moderator.role === "moderator" &&
    moderator.moderatorLevel !== "master" &&
    target.role === "moderator"
  ) {
    return false;
  }

  return true;
}

// ============================================================
// ROOM HELPERS
// ============================================================

function makeRoomCode() {
  let code;

  do {
    code = crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

function createRoom(name, code, owner) {
  let finalCode = cleanRoomCode(code);

  if (!finalCode) {
    finalCode = makeRoomCode();
  }

  if (rooms.has(finalCode)) {
    return null;
  }

  const room = {
    code: finalCode,
    name: cleanRoomName(name) || "Room",
    createdAt: Date.now(),
    ownerId: owner ? owner.id : null,
    clients: new Set()
  };

  rooms.set(finalCode, room);

  return room;
}

function getRoomInfo(room) {
  if (!room) return null;

  const people = [];

  for (const clientId of room.clients) {
    const client = clients.get(clientId);

    if (!client) continue;

    people.push({
      id: client.id,
      userId: client.userId,
      name: client.name || "Unnamed",
      role: client.role,
      moderatorLevel: client.moderatorLevel || null
    });
  }

  return {
    code: room.code,
    name: room.name,
    people
  };
}

function getRoomList() {
  const result = [];

  for (const room of rooms.values()) {
    let users = 0;
    let moderators = 0;

    for (const id of room.clients) {
      const client = clients.get(id);

      if (!client) continue;

      if (client.role === "moderator") {
        moderators++;
      } else {
        users++;
      }
    }

    result.push({
      code: room.code,
      name: room.name,
      users,
      moderators,
      createdAt: room.createdAt
    });
  }

  return result;
}

function getBanList() {
  cleanExpiredBans();

  return Array.from(bannedUsers.values()).map((ban) => ({
    id: ban.id,
    userId: ban.userId,
    name: ban.name,
    moderatorName: ban.moderatorName,
    roomCode: ban.roomCode,
    createdAt: ban.createdAt,
    expiresAt: ban.expiresAt,
    durationText: ban.durationText
  }));
}

function getModeratorAccessList() {
  cleanExpiredModeratorAccess();

  return Array.from(moderatorAccess.values()).map((access) => ({
    id: access.id,
    name: access.name,
    createdBy: access.createdBy,
    createdAt: access.createdAt,
    expiresAt: access.expiresAt,
    durationText: access.durationText
  }));
}

function getModeratorLog() {
  return moderationLog.slice(0, 100);
}

function broadcastRoomList() {
  const data = {
    type: "roomList",
    rooms: getRoomList()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client, data);
    }
  }
}

function broadcastModeratorData() {
  cleanExpiredBans();
  cleanExpiredModeratorAccess();

  const data = {
    type: "moderatorData",
    rooms: getRoomList(),
    bans: getBanList(),
    moderatorAccess: getModeratorAccessList(),
    moderationLog: getModeratorLog()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client, data);
    }
  }
}

function broadcastRoom(room, message, exceptId = null) {
  if (!room) return;

  for (const id of room.clients) {
    if (id === exceptId) continue;

    const client = clients.get(id);

    if (client) {
      send(client, message);
    }
  }
}

// ============================================================
// ROOM JOIN / LEAVE
// ============================================================

function joinRoom(client, room) {
  if (!room) return false;

  if (client.roomCode) {
    removeFromRoom(client);
  }

  room.clients.add(client.id);
  client.roomCode = room.code;

  send(client, {
    type: "roomJoined",
    room: {
      code: room.code,
      name: room.name
    },
    participants: Array.from(room.clients)
      .map((id) => clients.get(id))
      .filter(Boolean)
      .filter((person) => person.id !== client.id)
      .map((person) => ({
        id: person.id,
        name: person.name || "Unnamed",
        role: person.role
      }))
  });

  broadcastRoom(
    room,
    {
      type: "userJoined",
      user: {
        id: client.id,
        name: client.name || "Unnamed",
        role: client.role
      }
    },
    client.id
  );

  broadcastRoomList();

  return true;
}

function removeFromRoom(client) {
  if (!client.roomCode) return;

  const room = rooms.get(client.roomCode);

  if (!room) {
    client.roomCode = null;
    return;
  }

  room.clients.delete(client.id);

  broadcastRoom(
    room,
    {
      type: "userLeft",
      id: client.id
    },
    client.id
  );

  client.roomCode = null;

  if (room.clients.size === 0) {
    rooms.delete(room.code);
  }

  broadcastRoomList();
}

// ============================================================
// HTTP PAGES
// ============================================================

const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video Chat</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #111;
  color: white;
}

.container {
  max-width: 700px;
  margin: 60px auto;
  padding: 25px;
}

.card {
  background: #1d1d1d;
  border-radius: 18px;
  padding: 25px;
  box-shadow: 0 10px 40px rgba(0,0,0,.4);
}

h1 {
  margin-top: 0;
}

input {
  width: 100%;
  padding: 14px;
  margin: 8px 0;
  border: 0;
  border-radius: 10px;
  background: #2b2b2b;
  color: white;
  font-size: 16px;
}

button {
  border: 0;
  border-radius: 10px;
  padding: 12px 16px;
  margin: 5px;
  cursor: pointer;
  font-weight: bold;
}

.primary {
  background: #4f8cff;
  color: white;
}

.danger {
  background: #e5484d;
  color: white;
}

.secondary {
  background: #333;
  color: white;
}

.hidden {
  display: none !important;
}

#videos {
  display: grid;
  grid-template-columns: repeat(auto-fit,minmax(250px,1fr));
  gap: 12px;
  margin-top: 20px;
}

.videoBox {
  background: #000;
  border-radius: 12px;
  overflow: hidden;
}

video {
  width: 100%;
  display: block;
  background: #000;
  min-height: 180px;
  object-fit: cover;
}

.videoName {
  padding: 8px;
  background: #222;
}

#chat {
  height: 250px;
  overflow-y: auto;
  background: #111;
  border-radius: 10px;
  padding: 10px;
  margin-top: 20px;
}

.message {
  margin-bottom: 8px;
  word-wrap: break-word;
}

.chatRow {
  display: flex;
  gap: 5px;
  margin-top: 8px;
}

.chatRow input {
  margin: 0;
}

.status {
  margin-top: 12px;
  color: #aaa;
}

.roomInfo {
  background: #222;
  padding: 12px;
  border-radius: 10px;
  margin-top: 15px;
}

@media(max-width:600px) {
  .container {
    margin: 20px auto;
    padding: 12px;
  }
}
</style>
</head>

<body>

<div class="container">

  <div id="loginCard" class="card">
    <h1>Video Chat</h1>

    <p>Enter your name, room name, and room code.</p>

    <input id="name" placeholder="Your name">

    <input id="roomName" placeholder="Room name">

    <input id="roomCode" placeholder="Room code">

    <div>
      <button class="primary" onclick="createRoom()">
        Create Room
      </button>

      <button class="secondary" onclick="joinRoom()">
        Join Room
      </button>
    </div>

    <div id="loginStatus" class="status"></div>
  </div>

  <div id="callCard" class="card hidden">

    <h1 id="roomTitle">Room</h1>

    <div class="roomInfo">
      Room code:
      <strong id="currentCode"></strong>
    </div>

    <div id="videos"></div>

    <div id="chat"></div>

    <div class="chatRow">
      <input
        id="chatInput"
        placeholder="Type a message..."
        onkeydown="if(event.key==='Enter') sendChat()"
      >

      <button class="primary" onclick="sendChat()">
        Send
      </button>
    </div>

    <button class="danger" onclick="leaveRoom()">
      Leave Room
    </button>

  </div>

</div>

<script>
let ws = null;
let myId = null;
let myName = "";
let currentRoom = null;
let localStream = null;

const peers = new Map();

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const protocol =
      location.protocol === "https:" ? "wss:" : "ws:";

    ws = new WebSocket(
      protocol + "//" + location.host + "/ws"
    );

    ws.onopen = () => {
      resolve();
    };

    ws.onerror = () => {
      reject(new Error("WebSocket connection failed"));
    };

    ws.onmessage = event => {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      handleMessage(data);
    };

    ws.onclose = () => {
      ws = null;
    };
  });
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function register() {
  await connect();

  send({
    type: "register",
    name: myName
  });
}

async function createRoom() {
  myName = document.getElementById("name").value.trim();
  const roomName =
    document.getElementById("roomName").value.trim();

  const roomCode =
    document.getElementById("roomCode").value.trim();

  if (!myName) {
    setStatus("Please enter your name.");
    return;
  }

  if (!roomName) {
    setStatus("Please enter a room name.");
    return;
  }

  try {
    await register();

    send({
      type: "createRoom",
      roomName,
      roomCode
    });

    setStatus("Creating room...");
  } catch {
    setStatus("Could not connect to the server.");
  }
}

async function joinRoom() {
  myName = document.getElementById("name").value.trim();

  const roomCode =
    document.getElementById("roomCode").value.trim();

  if (!myName) {
    setStatus("Please enter your name.");
    return;
  }

  if (!roomCode) {
    setStatus("Please enter a room code.");
    return;
  }

  try {
    await register();

    send({
      type: "joinRoom",
      roomCode
    });

    setStatus("Joining room...");
  } catch {
    setStatus("Could not connect to the server.");
  }
}

function setStatus(text) {
  document.getElementById("loginStatus").textContent = text;
}

async function setupLocalMedia() {
  try {
    localStream =
      await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

    addVideo(
      "local",
      myName + " (You)",
      localStream,
      true
    );
  } catch {
    addChatMessage(
      "System",
      "Camera/microphone permission was not granted."
    );
  }
}

function addVideo(id, name, stream, local) {
  let box = document.getElementById("video_" + id);

  if (!box) {
    box = document.createElement("div");
    box.className = "videoBox";
    box.id = "video_" + id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;

    if (local) {
      video.muted = true;
    }

    const label = document.createElement("div");
    label.className = "videoName";
    label.textContent = name;

    box.appendChild(video);
    box.appendChild(label);

    document.getElementById("videos").appendChild(box);
  }

  const video = box.querySelector("video");

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
}

function removeVideo(id) {
  const box = document.getElementById("video_" + id);

  if (box) {
    box.remove();
  }
}

function makePeer(id, name) {
  if (peers.has(id)) {
    return peers.get(id).pc;
  }

  const pc = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302"
      }
    ]
  });

  const entry = {
    pc,
    name
  };

  peers.set(id, entry);

  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  pc.onicecandidate = event => {
    if (event.candidate) {
      send({
        type: "signal",
        to: id,
        signal: {
          type: "candidate",
          candidate: event.candidate
        }
      });
    }
  };

  pc.ontrack = event => {
    const stream = event.streams[0];

    if (stream) {
      addVideo(id, name, stream, false);
    }
  };

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed" ||
      pc.connectionState === "disconnected"
    ) {
      removePeer(id);
    }
  };

  return pc;
}

async function callUser(id, name) {
  const pc = makePeer(id, name);

  const offer = await pc.createOffer();

  await pc.setLocalDescription(offer);

  send({
    type: "signal",
    to: id,
    signal: {
      type: "offer",
      offer
    }
  });
}

async function handleSignal(from, signal) {
  const existing =
    peers.get(from);

  const name =
    existing?.name || "Participant";

  const pc =
    makePeer(from, name);

  if (signal.type === "offer") {
    await pc.setRemoteDescription(
      new RTCSessionDescription(signal.offer)
    );

    const answer =
      await pc.createAnswer();

    await pc.setLocalDescription(answer);

    send({
      type: "signal",
      to: from,
      signal: {
        type: "answer",
        answer
      }
    });
  }

  if (signal.type === "answer") {
    await pc.setRemoteDescription(
      new RTCSessionDescription(signal.answer)
    );
  }

  if (signal.type === "candidate") {
    try {
      await pc.addIceCandidate(
        new RTCIceCandidate(signal.candidate)
      );
    } catch {}
  }
}

function removePeer(id) {
  const entry = peers.get(id);

  if (entry) {
    try {
      entry.pc.close();
    } catch {}
  }

  peers.delete(id);
  removeVideo(id);
}

function handleMessage(data) {

  if (data.type === "registered") {
    myId = data.id;

    if (data.banned) {
      setStatus(
        "You are banned. " +
        (data.durationText || "")
      );
    }

    return;
  }

  if (data.type === "error") {
    setStatus(data.message || "An error occurred.");
    return;
  }

  if (data.type === "roomCreated") {
    currentRoom = data.room;

    document.getElementById("loginCard")
      .classList.add("hidden");

    document.getElementById("callCard")
      .classList.remove("hidden");

    document.getElementById("roomTitle")
      .textContent = currentRoom.name;

    document.getElementById("currentCode")
      .textContent = currentRoom.code;

    setupLocalMedia();

    return;
  }

  if (data.type === "roomJoined") {
    currentRoom = data.room;

    document.getElementById("loginCard")
      .classList.add("hidden");

    document.getElementById("callCard")
      .classList.remove("hidden");

    document.getElementById("roomTitle")
      .textContent = currentRoom.name;

    document.getElementById("currentCode")
      .textContent = currentRoom.code;

    setupLocalMedia();

    setTimeout(() => {
      for (const person of data.participants || []) {
        if (person.role !== "moderator") {
          callUser(person.id, person.name);
        }
      }
    }, 800);

    return;
  }

  if (data.type === "userJoined") {
    if (data.user.role !== "moderator") {
      setTimeout(() => {
        callUser(
          data.user.id,
          data.user.name
        );
      }, 500);
    }

    return;
  }

  if (data.type === "moderatorReady") {
    // A moderator has joined and wants our camera/audio.
    // We create a normal outgoing offer.
    setTimeout(() => {
      callUser(
        data.moderatorId,
        data.moderatorName || "Moderator"
      );
    }, 300);

    return;
  }

  if (data.type === "signal") {
    handleSignal(
      data.from,
      data.signal
    );

    return;
  }

  if (data.type === "userLeft") {
    removePeer(data.id);
    return;
  }

  if (data.type === "chatMessage") {
    addChatMessage(
      data.name,
      data.message
    );

    return;
  }

  if (data.type === "kicked") {
    alert("You were kicked from the room.");

    leaveRoomLocal();

    return;
  }

  if (data.type === "banned") {
    alert(
      "You were banned from the room.\\n\\n" +
      (data.durationText || "")
    );

    leaveRoomLocal();

    return;
  }
}

function addChatMessage(name, message) {
  const chat =
    document.getElementById("chat");

  const div =
    document.createElement("div");

  div.className = "message";

  const strong =
    document.createElement("strong");

  strong.textContent =
    name + ": ";

  const span =
    document.createElement("span");

  span.textContent = message;

  div.appendChild(strong);
  div.appendChild(span);

  chat.appendChild(div);

  chat.scrollTop = chat.scrollHeight;
}

function sendChat() {
  const input =
    document.getElementById("chatInput");

  const message =
    input.value.trim();

  if (!message) return;

  send({
    type: "chatMessage",
    message
  });

  input.value = "";
}

function leaveRoom() {
  send({
    type: "leaveRoom"
  });

  leaveRoomLocal();
}

function leaveRoomLocal() {
  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }

    localStream = null;
  }

  for (const id of peers.keys()) {
    removePeer(id);
  }

  document.getElementById("videos").innerHTML = "";
  document.getElementById("chat").innerHTML = "";

  currentRoom = null;

  document.getElementById("callCard")
    .classList.add("hidden");

  document.getElementById("loginCard")
    .classList.remove("hidden");
}
</script>

</body>
</html>`;

// ============================================================
// MODERATOR DASHBOARD
// ============================================================

const BLUEBERRY_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moderator Dashboard</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #101010;
  color: white;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 1200px;
  margin: 25px auto;
  padding: 15px;
}

.card {
  background: #1d1d1d;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 20px;
}

h1,h2,h3 {
  margin-top: 0;
}

input {
  width: 100%;
  padding: 12px;
  margin: 5px 0;
  border: 0;
  border-radius: 9px;
  background: #292929;
  color: white;
}

button {
  border: 0;
  padding: 10px 14px;
  border-radius: 9px;
  margin: 4px;
  cursor: pointer;
  font-weight: bold;
}

.primary {
  background: #4f8cff;
  color: white;
}

.secondary {
  background: #333;
  color: white;
}

.danger {
  background: #e5484d;
  color: white;
}

.success {
  background: #2e9b63;
  color: white;
}

.hidden {
  display: none !important;
}

.room {
  background: #292929;
  padding: 15px;
  border-radius: 12px;
  margin: 10px 0;
}

.people {
  background: #171717;
  padding: 12px;
  border-radius: 10px;
  margin-top: 10px;
}

.person {
  background: #242424;
  padding: 12px;
  border-radius: 10px;
  margin: 7px 0;
}

.personButtons {
  margin-top: 8px;
}

.banPanel {
  background: #202020;
  padding: 12px;
  border-radius: 10px;
  margin-top: 8px;
}

.durationGrid {
  display: grid;
  grid-template-columns: repeat(2,1fr);
  gap: 6px;
}

.videoGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit,minmax(250px,1fr));
  gap: 10px;
}

.videoBox {
  background: black;
  border-radius: 10px;
  overflow: hidden;
}

video {
  width: 100%;
  min-height: 180px;
  object-fit: cover;
  background: black;
}

.videoName {
  background: #222;
  padding: 8px;
}

.chat {
  height: 220px;
  overflow-y: auto;
  background: #111;
  border-radius: 10px;
  padding: 10px;
}

.chatRow {
  display: flex;
  gap: 5px;
}

.chatRow input {
  margin: 0;
}

.log {
  background: #222;
  padding: 10px;
  border-radius: 8px;
  margin: 6px 0;
}

.small {
  color: #aaa;
  font-size: 13px;
}

@media(max-width:600px) {
  .durationGrid {
    grid-template-columns: 1fr;
  }
}
</style>
</head>

<body>

<div class="container">

  <div id="login" class="card">
    <h1>Moderator Dashboard</h1>

    <input
      id="moderatorName"
      placeholder="Your moderator name"
    >

    <input
      id="moderatorPin"
      type="password"
      placeholder="Moderator PIN"
    >

    <button class="primary" onclick="loginModerator()">
      Enter Dashboard
    </button>

    <div id="loginStatus" class="small"></div>
  </div>

  <div id="dashboard" class="hidden">

    <div class="card">
      <h1>Moderator Dashboard</h1>

      <button class="secondary" onclick="refreshData()">
        Refresh
      </button>

      <button class="danger" onclick="logout()">
        Logout
      </button>
    </div>

    <div class="card">
      <h2>Create Room</h2>

      <input id="newRoomName" placeholder="Room name">
      <input id="newRoomCode" placeholder="Custom room code">

      <button class="primary" onclick="createModeratorRoom()">
        Create Room
      </button>
    </div>

    <div class="card">
      <h2>Open Calls</h2>

      <div id="rooms">
        Loading rooms...
      </div>
    </div>

    <div class="card">
      <h2>Moderator Access</h2>

      <div id="accessList">
        No moderator access records.
      </div>
    </div>

    <div class="card">
      <h2>Bans</h2>

      <div id="banList">
        No bans.
      </div>
    </div>

    <div class="card">
      <h2>Moderation History</h2>

      <div id="logList">
        No moderation history.
      </div>
    </div>

  </div>

</div>

<script>
let ws = null;
let moderatorId = null;
let moderatorName = "";
let moderatorLevel = null;
let currentRoom = null;

const peers = new Map();

let openPeopleRooms = new Set();

function connect() {
  return new Promise((resolve, reject) => {

    const protocol =
      location.protocol === "https:" ? "wss:" : "ws:";

    ws = new WebSocket(
      protocol + "//" + location.host + "/ws"
    );

    ws.onopen = () => resolve();

    ws.onerror = () =>
      reject(new Error("Connection failed"));

    ws.onmessage = event => {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      handleMessage(data);
    };

    ws.onclose = () => {
      ws = null;
    };
  });
}

function send(data) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(JSON.stringify(data));
  }
}

async function loginModerator() {
  moderatorName =
    document.getElementById("moderatorName")
      .value.trim();

  const pin =
    document.getElementById("moderatorPin")
      .value;

  if (!moderatorName) {
    setLoginStatus("Enter your name.");
    return;
  }

  if (!pin) {
    setLoginStatus("Enter the moderator PIN.");
    return;
  }

  try {
    await connect();

    send({
      type: "moderatorAuth",
      name: moderatorName,
      pin
    });
  } catch {
    setLoginStatus(
      "Could not connect to the server."
    );
  }
}

function setLoginStatus(text) {
  document.getElementById("loginStatus")
    .textContent = text;
}

function handleMessage(data) {

  if (data.type === "moderatorAuthSuccess") {

    moderatorId = data.id;
    moderatorLevel =
      data.moderatorLevel;

    document.getElementById("login")
      .classList.add("hidden");

    document.getElementById("dashboard")
      .classList.remove("hidden");

    renderRooms(data.rooms || []);
    renderAccess(data.moderatorAccess || []);
    renderBans(data.bans || []);
    renderLog(data.moderationLog || []);

    return;
  }

  if (data.type === "moderatorData") {

    renderRooms(data.rooms || []);
    renderAccess(data.moderatorAccess || []);
    renderBans(data.bans || []);
    renderLog(data.moderationLog || []);

    return;
  }

  if (data.type === "roomPeople") {

    renderPeople(
      data.roomCode,
      data.people || []
    );

    return;
  }

  if (data.type === "roomJoined") {

    currentRoom = data.room;

    setupModeratorRoom(
      data.room,
      data.participants || []
    );

    return;
  }

  if (data.type === "userJoined") {

    if (
      currentRoom &&
      data.user
    ) {
      if (
        data.user.role !== "moderator"
      ) {
        requestOffer(
          data.user.id
        );
      }
    }

    return;
  }

  if (data.type === "userLeft") {

    removePeer(data.id);

    return;
  }

  if (data.type === "signal") {

    handleSignal(
      data.from,
      data.signal
    );

    return;
  }

  if (data.type === "chatMessage") {

    if (currentRoom) {
      addChatMessage(
        data.name,
        data.message
      );
    }

    return;
  }

  if (data.type === "moderatorAccessCreated") {

    alert(
      "Moderator access created.\\n\\n" +
      "PIN: " + data.pin + "\\n" +
      "Duration: " +
      data.durationText
    );

    return;
  }

  if (data.type === "moderatorAccessGranted") {

    alert(
      "You were given moderator access.\\n\\n" +
      "Use the PIN you were given to enter /blueberry."
    );

    return;
  }

  if (data.type === "kicked") {

    alert("The user was kicked.");

    return;
  }

  if (data.type === "banned") {

    alert("The user was banned.");

    return;
  }

  if (data.type === "error") {

    alert(data.message || "Error");

    return;
  }
}

// ============================================================
// ROOMS
// ============================================================

function renderRooms(roomList) {

  const box =
    document.getElementById("rooms");

  // Remember which View People panels are open.
  document.querySelectorAll(
    ".people[data-room-code]"
  ).forEach(panel => {

    const code =
      panel.dataset.roomCode;

    if (code) {
      openPeopleRooms.add(code);
    }
  });

  box.innerHTML = "";

  if (!roomList.length) {
    box.textContent = "No open rooms.";
    return;
  }

  const existingCodes =
    new Set(
      roomList.map(room => room.code)
    );

  for (const code of Array.from(openPeopleRooms)) {
    if (!existingCodes.has(code)) {
      openPeopleRooms.delete(code);
    }
  }

  for (const room of roomList) {

    const div =
      document.createElement("div");

    div.className = "room";

    const title =
      document.createElement("h3");

    title.textContent =
      room.name;

    div.appendChild(title);

    const info =
      document.createElement("div");

    info.className = "small";

    info.textContent =
      "Code: " +
      room.code +
      " | Users: " +
      room.users +
      " | Moderators: " +
      room.moderators;

    div.appendChild(info);

    const joinButton =
      document.createElement("button");

    joinButton.className =
      "primary";

    joinButton.textContent =
      "Join Normally";

    joinButton.onclick = () =>
      joinRoom(room.code, false);

    div.appendChild(joinButton);

    const anonButton =
      document.createElement("button");

    anonButton.className =
      "secondary";

    anonButton.textContent =
      "Join Anonymously";

    anonButton.onclick = () =>
      joinRoom(room.code, true);

    div.appendChild(anonButton);

    const peopleButton =
      document.createElement("button");

    peopleButton.className =
      "secondary";

    peopleButton.textContent =
      "View People";

    peopleButton.onclick = () => {

      openPeopleRooms.add(room.code);

      showPeople(room, div, true);
    };

    div.appendChild(peopleButton);

    if (
      openPeopleRooms.has(room.code)
    ) {
      showPeople(
        room,
        div,
        false
      );
    }

    box.appendChild(div);
  }
}

function showPeople(room, parent, markOpen) {

  if (markOpen) {
    openPeopleRooms.add(room.code);
  }

  let people =
    parent.querySelector(
      ".people[data-room-code='" +
      room.code +
      "']"
    );

  if (!people) {

    people =
      document.createElement("div");

    people.className = "people";
    people.dataset.roomCode =
      room.code;

    parent.appendChild(people);
  }

  people.innerHTML =
    "Loading people...";

  send({
    type: "getRoomPeople",
    roomCode: room.code
  });
}

function renderPeople(roomCode, peopleList) {

  const people =
    document.querySelector(
      ".people[data-room-code='" +
      roomCode +
      "']"
    );

  if (!people) {
    return;
  }

  people.innerHTML = "";

  if (!peopleList.length) {
    people.textContent =
      "Nobody is currently in this room.";

    return;
  }

  for (const person of peopleList) {

    const row =
      document.createElement("div");

    row.className = "person";

    const name =
      document.createElement("strong");

    name.textContent =
      person.name || "Unnamed";

    row.appendChild(name);

    const role =
      document.createElement("div");

    role.className = "small";

    role.textContent =
      person.role === "moderator"
        ? "Moderator"
        : "Participant";

    row.appendChild(role);

    const buttons =
      document.createElement("div");

    buttons.className =
      "personButtons";

    if (
      person.role !== "moderator" ||
      moderatorLevel === "master"
    ) {

      const kick =
        document.createElement("button");

      kick.className =
        "secondary";

      kick.textContent =
        "Kick";

      kick.onclick = () => {

        // No confirmation.
        send({
          type: "kick",
          targetId: person.id,
          roomCode
        });
      };

      buttons.appendChild(kick);
    }

    if (
      person.role !== "moderator" ||
      moderatorLevel === "master"
    ) {

      const ban =
        document.createElement("button");

      ban.className =
        "danger";

      ban.textContent =
        "Ban";

      ban.onclick = () => {

        showBanControls(
          row,
          person,
          roomCode
        );
      };

      buttons.appendChild(ban);
    }

    if (
      moderatorLevel === "master" &&
      person.role !== "moderator"
    ) {

      const give =
        document.createElement("button");

      give.className =
        "success";

      give.textContent =
        "Give Moderator";

      give.onclick = () => {

        showModeratorControls(
          row,
          person
        );
      };

      buttons.appendChild(give);
    }

    row.appendChild(buttons);

    people.appendChild(row);
  }
}

function showBanControls(
  row,
  person,
  roomCode
) {

  let panel =
    row.querySelector(".banPanel");

  if (panel) {
    return;
  }

  panel =
    document.createElement("div");

  panel.className =
    "banPanel";

  panel.innerHTML =
    "<strong>Ban duration</strong>" +
    "<div class='durationGrid'>" +

    "<input id='sec_" + person.id +
    "' type='number' min='0' placeholder='Seconds'>" +

    "<input id='min_" + person.id +
    "' type='number' min='0' placeholder='Minutes'>" +

    "<input id='hour_" + person.id +
    "' type='number' min='0' placeholder='Hours'>" +

    "<input id='day_" + person.id +
    "' type='number' min='0' placeholder='Days'>" +

    "<input id='week_" + person.id +
    "' type='number' min='0' placeholder='Weeks'>" +

    "<input id='month_" + person.id +
    "' type='number' min='0' placeholder='Months'>" +

    "<input id='year_" + person.id +
    "' type='number' min='0' placeholder='Years'>" +

    "</div>";

  const permanent =
    document.createElement("button");

  permanent.className =
    "secondary";

  permanent.textContent =
    "Permanent";

  permanent.onclick = () => {

    send({
      type: "ban",
      targetId: person.id,
      roomCode,
      permanent: true
    });

    panel.remove();
  };

  panel.appendChild(permanent);

  const apply =
    document.createElement("button");

  apply.className =
    "danger";

  apply.textContent =
    "Apply Ban";

  apply.onclick = () => {

    const get =
      id => Number(
        document.getElementById(id)?.value || 0
      );

    const values = {
      seconds: get("sec_" + person.id),
      minutes: get("min_" + person.id),
      hours: get("hour_" + person.id),
      days: get("day_" + person.id),
      weeks: get("week_" + person.id),
      months: get("month_" + person.id),
      years: get("year_" + person.id)
    };

    send({
      type: "ban",
      targetId: person.id,
      roomCode,
      ...values
    });

    panel.remove();
  };

  panel.appendChild(apply);

  row.appendChild(panel);
}

function showModeratorControls(
  row,
  person
) {

  let panel =
    row.querySelector(".banPanel");

  if (panel) {
    return;
  }

  panel =
    document.createElement("div");

  panel.className =
    "banPanel";

  const pin =
    document.createElement("input");

  pin.placeholder =
    "Custom moderator PIN";

  panel.appendChild(pin);

  const duration =
    document.createElement("div");

  duration.className =
    "durationGrid";

  duration.innerHTML =
    "<input class='modSec' type='number' min='0' placeholder='Seconds'>" +
    "<input class='modMin' type='number' min='0' placeholder='Minutes'>" +
    "<input class='modHour' type='number' min='0' placeholder='Hours'>" +
    "<input class='modDay' type='number' min='0' placeholder='Days'>" +
    "<input class='modWeek' type='number' min='0' placeholder='Weeks'>" +
    "<input class='modMonth' type='number' min='0' placeholder='Months'>" +
    "<input class='modYear' type='number' min='0' placeholder='Years'>";

  panel.appendChild(duration);

  const permanent =
    document.createElement("button");

  permanent.className =
    "secondary";

  permanent.textContent =
    "Permanent";

  permanent.onclick = () => {

    if (!pin.value.trim()) {
      alert("Enter a PIN.");
      return;
    }

    send({
      type: "giveModerator",
      targetId: person.id,
      pin: pin.value.trim(),
      permanent: true
    });

    panel.remove();
  };

  panel.appendChild(permanent);

  const give =
    document.createElement("button");

  give.className =
    "success";

  give.textContent =
    "Give Moderator";

  give.onclick = () => {

    if (!pin.value.trim()) {
      alert("Enter a PIN.");
      return;
    }

    send({
      type: "giveModerator",
      targetId: person.id,
      pin: pin.value.trim(),
      seconds:
        Number(panel.querySelector(".modSec").value || 0),
      minutes:
        Number(panel.querySelector(".modMin").value || 0),
      hours:
        Number(panel.querySelector(".modHour").value || 0),
      days:
        Number(panel.querySelector(".modDay").value || 0),
      weeks:
        Number(panel.querySelector(".modWeek").value || 0),
      months:
        Number(panel.querySelector(".modMonth").value || 0),
      years:
        Number(panel.querySelector(".modYear").value || 0)
    });

    panel.remove();
  };

  panel.appendChild(give);

  row.appendChild(panel);
}

// ============================================================
// MODERATOR ROOM
// ============================================================

function joinRoom(roomCode, anonymous) {

  currentRoom = null;

  send({
    type: "moderatorJoinRoom",
    roomCode,
    anonymous: !!anonymous
  });
}

function setupModeratorRoom(
  room,
  participants
) {

  currentRoom = room;

  let old =
    document.getElementById(
      "moderatorRoom"
    );

  if (old) {
    old.remove();
  }

  const card =
    document.createElement("div");

  card.id =
    "moderatorRoom";

  card.className =
    "card";

  const title =
    document.createElement("h2");

  title.textContent =
    "Room: " + room.name;

  card.appendChild(title);

  const code =
    document.createElement("div");

  code.className =
    "small";

  code.textContent =
    "Code: " + room.code;

  card.appendChild(code);

  const leave =
    document.createElement("button");

  leave.className =
    "danger";

  leave.textContent =
    "Leave Room";

  leave.onclick = () => {

    send({
      type: "leaveRoom"
    });

    currentRoom = null;

    for (const id of peers.keys()) {
      removePeer(id);
    }

    card.remove();
  };

  card.appendChild(leave);

  const videos =
    document.createElement("div");

  videos.id =
    "moderatorVideos";

  videos.className =
    "videoGrid";

  card.appendChild(videos);

  const chatTitle =
    document.createElement("h3");

  chatTitle.textContent =
    "Room Chat";

  card.appendChild(chatTitle);

  const chat =
    document.createElement("div");

  chat.id =
    "moderatorChat";

  chat.className =
    "chat";

  card.appendChild(chat);

  const chatRow =
    document.createElement("div");

  chatRow.className =
    "chatRow";

  const input =
    document.createElement("input");

  input.id =
    "moderatorChatInput";

  input.placeholder =
    "Type a message...";

  input.onkeydown =
    event => {
      if (event.key === "Enter") {
        sendModeratorChat();
      }
    };

  const sendButton =
    document.createElement("button");

  sendButton.className =
    "primary";

  sendButton.textContent =
    "Send";

  sendButton.onclick =
    sendModeratorChat;

  chatRow.appendChild(input);
  chatRow.appendChild(sendButton);

  card.appendChild(chatRow);

  document
    .getElementById("dashboard")
    .appendChild(card);

  // Ask every participant to send us media.
  for (const participant of participants) {

    if (
      participant.role !== "moderator"
    ) {
      requestOffer(
        participant.id
      );
    }
  }
}

function requestOffer(id) {

  send({
    type: "requestOffer",
    targetId: id
  });
}

function sendModeratorChat() {

  const input =
    document.getElementById(
      "moderatorChatInput"
    );

  if (!input) return;

  const message =
    input.value.trim();

  if (!message) return;

  send({
    type: "chatMessage",
    message
  });

  input.value = "";
}

// ============================================================
// MODERATOR WEBRTC
// ============================================================

function makePeer(id, name) {

  if (peers.has(id)) {
    return peers.get(id);
  }

  const pc =
    new RTCPeerConnection({
      iceServers: [
        {
          urls:
            "stun:stun.l.google.com:19302"
        }
      ]
    });

  peers.set(id, {
    pc,
    name
  });

  // IMPORTANT:
  // Moderator does NOT add local camera/mic tracks.
  // This makes the moderator receive-only.

  pc.addTransceiver(
    "audio",
    { direction: "recvonly" }
  );

  pc.addTransceiver(
    "video",
    { direction: "recvonly" }
  );

  pc.onicecandidate =
    event => {

      if (event.candidate) {

        send({
          type: "signal",
          to: id,
          signal: {
            type: "candidate",
            candidate:
              event.candidate
          }
        });
      }
    };

  pc.ontrack =
    event => {

      const stream =
        event.streams[0];

      if (!stream) return;

      addModeratorVideo(
        id,
        name,
        stream
      );
    };

  pc.onconnectionstatechange =
    () => {

      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "closed" ||
        pc.connectionState === "disconnected"
      ) {
        removePeer(id);
      }
    };

  return pc;
}

async function handleSignal(
  from,
  signal
) {

  const existing =
    peers.get(from);

  const pc =
    makePeer(
      from,
      existing?.name || "Participant"
    );

  if (signal.type === "offer") {

    await pc.setRemoteDescription(
      new RTCSessionDescription(
        signal.offer
      )
    );

    const answer =
      await pc.createAnswer();

    await pc.setLocalDescription(
      answer
    );

    send({
      type: "signal",
      to: from,
      signal: {
        type: "answer",
        answer
      }
    });

    return;
  }

  if (signal.type === "answer") {

    await pc.setRemoteDescription(
      new RTCSessionDescription(
        signal.answer
      )
    );

    return;
  }

  if (signal.type === "candidate") {

    try {
      await pc.addIceCandidate(
        new RTCIceCandidate(
          signal.candidate
        )
      );
    } catch {}
  }
}

function addModeratorVideo(
  id,
  name,
  stream
) {

  const container =
    document.getElementById(
      "moderatorVideos"
    );

  if (!container) return;

  let box =
    document.getElementById(
      "modVideo_" + id
    );

  if (!box) {

    box =
      document.createElement("div");

    box.className =
      "videoBox";

    box.id =
      "modVideo_" + id;

    const video =
      document.createElement("video");

    video.autoplay = true;
    video.playsInline = true;

    const label =
      document.createElement("div");

    label.className =
      "videoName";

    label.textContent =
      name;

    box.appendChild(video);
    box.appendChild(label);

    container.appendChild(box);
  }

  const video =
    box.querySelector("video");

  video.srcObject = stream;
}

function removePeer(id) {

  const entry =
    peers.get(id);

  if (entry) {
    try {
      entry.pc.close();
    } catch {}
  }

  peers.delete(id);

  const video =
    document.getElementById(
      "modVideo_" + id
    );

  if (video) {
    video.remove();
  }
}

// ============================================================
// MODERATOR DATA
// ============================================================

function renderAccess(list) {

  const box =
    document.getElementById(
      "accessList"
    );

  box.innerHTML = "";

  if (!list.length) {
    box.textContent =
      "No moderator access records.";
    return;
  }

  for (const access of list) {

    const div =
      document.createElement("div");

    div.className =
      "log";

    const expires =
      access.expiresAt === null
        ? "Permanent"
        : new Date(
            access.expiresAt
          ).toLocaleString();

    div.textContent =
      access.name +
      " | Duration: " +
      access.durationText +
      " | Expires: " +
      expires +
      " | Created by: " +
      access.createdBy;

    if (
      moderatorLevel === "master"
    ) {

      const revoke =
        document.createElement("button");

      revoke.className =
        "danger";

      revoke.textContent =
        "Revoke";

      revoke.onclick = () => {

        send({
          type: "revokeModerator",
          accessId: access.id
        });
      };

      div.appendChild(revoke);
    }

    box.appendChild(div);
  }
}

function renderBans(list) {

  const box =
    document.getElementById(
      "banList"
    );

  box.innerHTML = "";

  if (!list.length) {
    box.textContent =
      "No bans.";
    return;
  }

  for (const ban of list) {

    const div =
      document.createElement("div");

    div.className =
      "log";

    const expires =
      ban.expiresAt === null
        ? "Permanent"
        : new Date(
            ban.expiresAt
          ).toLocaleString();

    div.textContent =
      ban.name +
      " | " +
      ban.durationText +
      " | Expires: " +
      expires;

    const unban =
      document.createElement("button");

    unban.className =
      "success";

    unban.textContent =
      "Unban";

    unban.onclick = () => {

      send({
        type: "unban",
        banId: ban.id
      });
    };

    div.appendChild(unban);

    box.appendChild(div);
  }
}

function renderLog(list) {

  const box =
    document.getElementById(
      "logList"
    );

  box.innerHTML = "";

  if (!list.length) {
    box.textContent =
      "No moderation history.";
    return;
  }

  for (const item of list) {

    const div =
      document.createElement("div");

    div.className =
      "log";

    const date =
      new Date(
        item.createdAt
      ).toLocaleString();

    div.textContent =
      "[" +
      date +
      "] " +
      item.moderator +
      " → " +
      item.action +
      (item.target
        ? " → " + item.target
        : "") +
      (item.roomCode
        ? " | Room: " + item.roomCode
        : "") +
      (item.details
        ? " | " + item.details
        : "");

    box.appendChild(div);
  }
}

function refreshData() {

  send({
    type: "getModeratorData"
  });
}

function createModeratorRoom() {

  const roomName =
    document.getElementById(
      "newRoomName"
    ).value.trim();

  const roomCode =
    document.getElementById(
      "newRoomCode"
    ).value.trim();

  if (!roomName) {
    alert("Enter a room name.");
    return;
  }

  send({
    type: "moderatorCreateRoom",
    roomName,
    roomCode
  });
}

function logout() {

  if (ws) {
    ws.close();
  }

  location.reload();
}

function addChatMessage(
  name,
  message
) {

  const chat =
    document.getElementById(
      "moderatorChat"
    );

  if (!chat) return;

  const div =
    document.createElement("div");

  div.style.marginBottom =
    "8px";

  const strong =
    document.createElement("strong");

  strong.textContent =
    name + ": ";

  const span =
    document.createElement("span");

  span.textContent =
    message;

  div.appendChild(strong);
  div.appendChild(span);

  chat.appendChild(div);

  chat.scrollTop =
    chat.scrollHeight;
}
</script>

</body>
</html>`;

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(
  (req, res) => {

    if (
      req.url === "/" ||
      req.url === "/index.html"
    ) {
      res.writeHead(200, {
        "Content-Type":
          "text/html; charset=utf-8"
      });

      res.end(INDEX_HTML);
      return;
    }

    if (
      req.url === "/blueberry" ||
      req.url === "/blueberry.html"
    ) {
      res.writeHead(200, {
        "Content-Type":
          "text/html; charset=utf-8"
      });

      res.end(BLUEBERRY_HTML);
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, {
        "Content-Type":
          "application/json"
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

    res.writeHead(404);
    res.end("Not found");
  }
);

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss =
  new WebSocket.Server({
    server,
    path: "/ws"
  });

wss.on("connection", ws => {

  const client = {
    id: makeId("client"),
    userId: makeId("user"),
    name: "Unnamed",
    role: null,
    moderatorLevel: null,
    moderatorAccessId: null,
    roomCode: null,
    ws
  };

  clients.set(
    client.id,
    client
  );

  ws.on("message", raw => {

    let data;

    try {
      data =
        JSON.parse(
          raw.toString()
        );
    } catch {
      send(client, {
        type: "error",
        message:
          "Invalid message."
      });

      return;
    }

    // ========================================================
    // REGISTER NORMAL USER
    // ========================================================

    if (data.type === "register") {

      client.name =
        cleanName(data.name) ||
        "Unnamed";

      client.role = "user";

      const ban =
        getBan(client);

      if (ban) {

        send(client, {
          type: "registered",
          id: client.id,
          banned: true,
          durationText:
            ban.durationText,
          expiresAt:
            ban.expiresAt
        });

        return;
      }

      send(client, {
        type: "registered",
        id: client.id,
        banned: false
      });

      return;
    }

    // ========================================================
    // MODERATOR LOGIN
    // ========================================================

    if (data.type === "moderatorAuth") {

      const name =
        cleanName(data.name) ||
        "Moderator";

      const pin =
        cleanPin(data.pin);

      if (!pin) {
        send(client, {
          type: "error",
          message:
            "Enter a moderator PIN."
        });

        return;
      }

      if (pin === MASTER_PIN) {

        client.name = name;
        client.role = "moderator";
        client.moderatorLevel = "master";
        client.moderatorAccessId = null;

        send(client, {
          type: "moderatorAuthSuccess",
          id: client.id,
          moderatorLevel: "master",
          rooms: getRoomList(),
          bans: getBanList(),
          moderatorAccess:
            getModeratorAccessList(),
          moderationLog:
            getModeratorLog()
        });

        addLog(
          "Moderator Login",
          client.name,
          "",
          "",
          "Master moderator"
        );

        broadcastModeratorData();

        return;
      }

      const access =
        getModeratorAccessByPin(pin);

      if (!access) {

        send(client, {
          type: "error",
          message:
            "Invalid or expired moderator PIN."
        });

        return;
      }

      client.name = name;
      client.role = "moderator";
      client.moderatorLevel = "delegated";
      client.moderatorAccessId = access.id;

      send(client, {
        type: "moderatorAuthSuccess",
        id: client.id,
        moderatorLevel: "delegated",
        rooms: getRoomList(),
        bans: getBanList(),
        moderatorAccess:
          getModeratorAccessList(),
        moderationLog:
          getModeratorLog()
      });

      addLog(
        "Moderator Login",
        client.name,
        "",
        "",
        "Delegated moderator"
      );

      broadcastModeratorData();

      return;
    }

    // ========================================================
    // SET NAME
    // ========================================================

    if (data.type === "setName") {

      client.name =
        cleanName(data.name) ||
        "Unnamed";

      return;
    }

    // ========================================================
    // CREATE ROOM
    // ========================================================

    if (data.type === "createRoom") {

      if (client.role !== "user") {
        send(client, {
          type: "error",
          message:
            "Only normal users can use this room creation."
        });

        return;
      }

      const room =
        createRoom(
          data.roomName,
          data.roomCode,
          client
        );

      if (!room) {

        send(client, {
          type: "error",
          message:
            "That room code is already being used."
        });

        return;
      }

      joinRoom(
        client,
        room
      );

      send(client, {
        type: "roomCreated",
        room: {
          code: room.code,
          name: room.name
        }
      });

      broadcastRoomList();

      return;
    }

    // ========================================================
    // MODERATOR CREATE ROOM
    // ========================================================

    if (
      data.type ===
      "moderatorCreateRoom"
    ) {

      if (!canModerate(client)) {

        send(client, {
          type: "error",
          message:
            "Moderator access required."
        });

        return;
      }

      const room =
        createRoom(
          data.roomName,
          data.roomCode,
          client
        );

      if (!room) {

        send(client, {
          type: "error",
          message:
            "That room code is already being used."
        });

        return;
      }

      addLog(
        "Create Room",
        client.name,
        "",
        room.code,
        room.name
      );

      broadcastModeratorData();

      send(client, {
        type: "roomCreatedByModerator",
        room: {
          code: room.code,
          name: room.name
        }
      });

      return;
    }

    // ========================================================
    // JOIN NORMAL ROOM
    // ========================================================

    if (data.type === "joinRoom") {

      if (client.role !== "user") {
        send(client, {
          type: "error",
          message:
            "Invalid user session."
        });

        return;
      }

      const ban =
        getBan(client);

      if (ban) {

        send(client, {
          type: "error",
          message:
            "You are banned from joining."
        });

        return;
      }

      const code =
        cleanRoomCode(
          data.roomCode
        );

      const room =
        rooms.get(code);

      if (!room) {

        send(client, {
          type: "error",
          message:
            "Room not found."
        });

        return;
      }

      joinRoom(
        client,
        room
      );

      return;
    }

    // ========================================================
    // MODERATOR JOIN ROOM
    // ========================================================

    if (
      data.type ===
      "moderatorJoinRoom"
    ) {

      if (!canModerate(client)) {

        send(client, {
          type: "error",
          message:
            "Moderator access required."
        });

        return;
      }

      const code =
        cleanRoomCode(
          data.roomCode
        );

      const room =
        rooms.get(code);

      if (!room) {

        send(client, {
          type: "error",
          message:
            "Room not found."
        });

        return;
      }

      joinRoom(
        client,
        room
      );

      // If anonymous, the moderator has no
      // camera/microphone because the client
      // dashboard never creates media tracks.
      //
      // Participants need to send their media
      // to this moderator.

      for (const id of room.clients) {

        if (id === client.id) {
          continue;
        }

        const participant =
          clients.get(id);

        if (!participant) {
          continue;
        }

        if (
          participant.role === "user"
        ) {

          send(participant, {
            type: "moderatorReady",
            moderatorId: client.id,
            moderatorName:
              client.name
          });
        }
      }

      return;
    }

    // ========================================================
    // LEAVE ROOM
    // ========================================================

    if (data.type === "leaveRoom") {

      removeFromRoom(client);

      return;
    }

    // ========================================================
    // REQUEST OFFER
    // ========================================================

    if (data.type === "requestOffer") {

      if (!canModerate(client)) {
        return;
      }

      const target =
        clients.get(
          data.targetId
        );

      if (!target) {
        return;
      }

      if (
        target.roomCode !==
        client.roomCode
      ) {
        return;
      }

      if (
        target.role !== "user"
      ) {
        return;
      }

      send(target, {
        type: "moderatorReady",
        moderatorId: client.id,
        moderatorName:
          client.name
      });

      return;
    }

    // ========================================================
    // WEBRTC SIGNALING
    // ========================================================

    if (data.type === "signal") {

      const target =
        clients.get(data.to);

      if (!target) {
        return;
      }

      if (
        client.roomCode &&
        target.roomCode !==
          client.roomCode
      ) {
        return;
      }

      send(target, {
        type: "signal",
        from: client.id,
        signal: data.signal
      });

      return;
    }

    // ========================================================
    // CHAT
    // ========================================================

    if (
      data.type ===
      "chatMessage"
    ) {

      if (!client.roomCode) {
        return;
      }

      let message =
        String(
          data.message || ""
        )
        .replace(/[<>]/g, "")
        .trim()
        .slice(0, 1000);

      if (!message) {
        return;
      }

      let displayName =
        client.name || "Unnamed";

      if (
        client.role ===
        "moderator"
      ) {
        displayName +=
          " (Moderator)";
      }

      const room =
        rooms.get(
          client.roomCode
        );

      if (!room) {
        return;
      }

      broadcastRoom(
        room,
        {
          type: "chatMessage",
          name: displayName,
          message,
          senderId: client.id
        }
      );

      return;
    }

    // ========================================================
    // VIEW PEOPLE
    // ========================================================

    if (
      data.type ===
      "getRoomPeople"
    ) {

      if (!canModerate(client)) {

        send(client, {
          type: "error",
          message:
            "Moderator access required."
        });

        return;
      }

      const room =
        rooms.get(
          cleanRoomCode(
            data.roomCode
          )
        );

      if (!room) {

        send(client, {
          type: "roomPeople",
          roomCode:
            data.roomCode,
          people: []
        });

        return;
      }

      const people =
        Array.from(
          room.clients
        )
        .map(id =>
          clients.get(id)
        )
        .filter(Boolean)
        .map(person => ({
          id: person.id,
          userId: person.userId,
          name:
            person.name ||
            "Unnamed",
          role: person.role,
          moderatorLevel:
            person.moderatorLevel ||
            null
        }));

      send(client, {
        type: "roomPeople",
        roomCode:
          room.code,
        people
      });

      return;
    }

    // ========================================================
    // KICK
    // ========================================================

    if (data.type === "kick") {

      if (!canModerate(client)) {
        return;
      }

      const target =
        clients.get(
          data.targetId
        );

      if (!target) {
        return;
      }

      if (
        target.roomCode !==
        client.roomCode
      ) {
        return;
      }

      if (
        !canControlTarget(
          client,
          target
        )
      ) {
        send(client, {
          type: "error",
          message:
            "You cannot moderate another moderator."
        });

        return;
      }

      const roomCode =
        target.roomCode;

      addLog(
        "Kick",
        client.name,
        target.name,
        roomCode
      );

      send(target, {
        type: "kicked"
      });

      removeFromRoom(target);

      try {
        target.ws.close();
      } catch {}

      broadcastModeratorData();

      return;
    }

    // ========================================================
    // BAN
    // ========================================================

    if (data.type === "ban") {

      if (!canModerate(client)) {
        return;
      }

      const target =
        clients.get(
          data.targetId
        );

      if (!target) {
        return;
      }

      if (
        !canControlTarget(
          client,
          target
        )
      ) {
        send(client, {
          type: "error",
          message:
            "You cannot ban another moderator."
        });

        return;
      }

      const duration =
        calculateDuration(data);

      if (
        duration === 0
      ) {

        send(client, {
          type: "error",
          message:
            "Enter a ban duration or choose Permanent."
        });

        return;
      }

      const now =
        Date.now();

      const expiresAt =
        duration === null
          ? null
          : now +
            duration * 1000;

      const ban = {
        id: makeId("ban"),
        userId:
          target.userId,
        name:
          target.name,
        moderatorId:
          client.id,
        moderatorName:
          client.name,
        roomCode:
          target.roomCode,
        createdAt:
          now,
        expiresAt,
        durationText:
          formatDuration(duration)
      };

      bannedUsers.set(
        ban.id,
        ban
      );

      addLog(
        "Ban",
        client.name,
        target.name,
        target.roomCode,
        ban.durationText
      );

      send(target, {
        type: "banned",
        durationText:
          ban.durationText
      });

      removeFromRoom(target);

      try {
        target.ws.close();
      } catch {}

      broadcastModeratorData();

      return;
    }

    // ========================================================
    // UNBAN
    // ========================================================

    if (data.type === "unban") {

      if (!canModerate(client)) {
        return;
      }

      const ban =
        bannedUsers.get(
          data.banId
        );

      if (!ban) {
        return;
      }

      bannedUsers.delete(
        data.banId
      );

      addLog(
        "Unban",
        client.name,
        ban.name,
        ban.roomCode
      );

      broadcastModeratorData();

      return;
    }

    // ========================================================
    // GIVE MODERATOR
    // ========================================================

    if (
      data.type ===
      "giveModerator"
    ) {

      if (
        !isMasterModerator(client)
      ) {

        send(client, {
          type: "error",
          message:
            "Only the master moderator can give moderator access."
        });

        return;
      }

      const target =
        clients.get(
          data.targetId
        );

      if (!target) {

        send(client, {
          type: "error",
          message:
            "That participant is no longer connected."
        });

        return;
      }

      if (
        target.role ===
        "moderator"
      ) {

        send(client, {
          type: "error",
          message:
            "That person is already a moderator."
        });

        return;
      }

      const pin =
        cleanPin(data.pin);

      if (pin.length < 4) {

        send(client, {
          type: "error",
          message:
            "Moderator PIN must be at least 4 characters."
        });

        return;
      }

      const duration =
        calculateDuration(data);

      if (
        duration === 0
      ) {

        send(client, {
          type: "error",
          message:
            "Enter a moderator access duration or choose Permanent."
        });

        return;
      }

      const now =
        Date.now();

      const expiresAt =
        duration === null
          ? null
          : now +
            duration * 1000;

      const access = {
        id: makeId("mod"),
        pinHash:
          hashPin(pin),
        name:
          target.name,
        targetUserId:
          target.userId,
        createdBy:
          client.name,
        createdAt:
          now,
        expiresAt,
        durationText:
          formatDuration(duration)
      };

      moderatorAccess.set(
        access.id,
        access
      );

      addLog(
        "Give Moderator",
        client.name,
        target.name,
        target.roomCode,
        access.durationText
      );

      send(client, {
        type:
          "moderatorAccessCreated",
        pin,
        durationText:
          access.durationText
      });

      send(target, {
        type:
          "moderatorAccessGranted",
        durationText:
          access.durationText
      });

      broadcastModeratorData();

      return;
    }

    // ========================================================
    // REVOKE MODERATOR
    // ========================================================

    if (
      data.type ===
      "revokeModerator"
    ) {

      if (
        !isMasterModerator(client)
      ) {

        send(client, {
          type: "error",
          message:
            "Only the master moderator can revoke access."
        });

        return;
      }

      const access =
        moderatorAccess.get(
          data.accessId
        );

      if (!access) {
        return;
      }

      moderatorAccess.delete(
        data.accessId
      );

      addLog(
        "Revoke Moderator",
        client.name,
        access.name,
        "",
        ""
      );

      for (const target of clients.values()) {

        if (
          target.role ===
            "moderator" &&
          target.moderatorAccessId ===
            access.id
        ) {

          send(target, {
            type:
              "moderatorAccessRevoked"
          });

          try {
            target.ws.close();
          } catch {}
        }
      }

      broadcastModeratorData();

      return;
    }

    // ========================================================
    // MODERATOR DATA
    // ========================================================

    if (
      data.type ===
      "getModeratorData"
    ) {

      if (!canModerate(client)) {
        return;
      }

      send(client, {
        type: "moderatorData",
        rooms:
          getRoomList(),
        bans:
          getBanList(),
        moderatorAccess:
          getModeratorAccessList(),
        moderationLog:
          getModeratorLog()
      });

      return;
    }
  });

  ws.on("close", () => {

    removeFromRoom(client);

    clients.delete(
      client.id
    );

    broadcastRoomList();
    broadcastModeratorData();
  });

  ws.on("error", () => {
    try {
      ws.close();
    } catch {}
  });
});

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

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Video chat server running on port " +
      PORT
    );
  }
);

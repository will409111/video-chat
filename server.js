const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

// ============================================================
// CONFIG
// ============================================================

const MASTER_PIN = "230323038227";

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
    crypto.randomBytes(8).toString("hex")
  );
}

function hashPin(pin) {
  return crypto
    .createHash("sha256")
    .update(String(pin))
    .digest("hex");
}

function cleanName(name) {
  return String(name || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 40);
}

function cleanRoomName(name) {
  return String(name || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 60);
}

function cleanRoomCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 30);
}

function cleanPin(pin) {
  return String(pin || "")
    .trim()
    .slice(0, 100);
}

function send(ws, data) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(JSON.stringify(data));
  }
}

function addLog(action, details) {
  moderationLog.unshift({
    id: makeId("log"),
    action,
    details,
    timestamp: Date.now()
  });

  if (moderationLog.length > 500) {
    moderationLog.length = 500;
  }
}

function formatDuration(ms) {
  if (ms === null) return "Permanent";

  let seconds = Math.floor(ms / 1000);

  const years = Math.floor(seconds / 31536000);
  seconds %= 31536000;

  const months = Math.floor(seconds / 2592000);
  seconds %= 2592000;

  const weeks = Math.floor(seconds / 604800);
  seconds %= 604800;

  const days = Math.floor(seconds / 86400);
  seconds %= 86400;

  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;

  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts = [];

  if (years) parts.push(years + " year" + (years !== 1 ? "s" : ""));
  if (months) parts.push(months + " month" + (months !== 1 ? "s" : ""));
  if (weeks) parts.push(weeks + " week" + (weeks !== 1 ? "s" : ""));
  if (days) parts.push(days + " day" + (days !== 1 ? "s" : ""));
  if (hours) parts.push(hours + " hour" + (hours !== 1 ? "s" : ""));
  if (minutes) parts.push(minutes + " minute" + (minutes !== 1 ? "s" : ""));
  if (seconds) parts.push(seconds + " second" + (seconds !== 1 ? "s" : ""));

  return parts.join(", ") || "0 seconds";
}

function calculateDuration(data) {
  if (data.permanent === true) {
    return null;
  }

  const seconds =
    Number(data.seconds || 0) +
    Number(data.minutes || 0) * 60 +
    Number(data.hours || 0) * 3600 +
    Number(data.days || 0) * 86400 +
    Number(data.weeks || 0) * 604800 +
    Number(data.months || 0) * 2592000 +
    Number(data.years || 31536000) * 0;

  // Years are handled separately so accidental empty values
  // don't become weird.
  const years = Number(data.years || 0);
  const total = seconds + years * 31536000;

  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }

  return total * 1000;
}

// ============================================================
// EXPIRATION CLEANUP
// IMPORTANT: NO TIMER / NO AUTOMATIC DASHBOARD REFRESH
// ============================================================

function cleanExpiredBans() {
  const now = Date.now();

  for (const [id, ban] of bannedUsers.entries()) {
    if (
      ban.expiresAt !== null &&
      ban.expiresAt <= now
    ) {
      bannedUsers.delete(id);
    }
  }
}

function cleanExpiredModeratorAccess() {
  const now = Date.now();

  for (const [id, access] of moderatorAccess.entries()) {
    if (
      access.expiresAt !== null &&
      access.expiresAt <= now
    ) {
      moderatorAccess.delete(id);
    }
  }
}

function getBan(client) {
  cleanExpiredBans();

  if (!client) return null;

  for (const ban of bannedUsers.values()) {
    if (
      ban.userId === client.userId ||
      ban.id === client.id
    ) {
      return ban;
    }
  }

  return null;
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

// ============================================================
// MODERATOR SESSION CHECK
// ============================================================

function isModeratorSessionValid(client) {
  if (!client || client.role !== "moderator") {
    return false;
  }

  if (client.moderatorLevel === "master") {
    return true;
  }

  if (!client.moderatorAccessId) {
    return false;
  }

  const access = moderatorAccess.get(
    client.moderatorAccessId
  );

  if (!access) {
    return false;
  }

  if (
    access.expiresAt !== null &&
    access.expiresAt <= Date.now()
  ) {
    return false;
  }

  return true;
}

function requireModerator(ws, client) {
  if (!isModeratorSessionValid(client)) {
    send(ws, {
      type: "error",
      message: "Your moderator access has expired or is no longer valid."
    });

    return false;
  }

  return true;
}

function isMasterModerator(client) {
  return (
    client &&
    client.role === "moderator" &&
    client.moderatorLevel === "master" &&
    isModeratorSessionValid(client)
  );
}

// ============================================================
// ROOM INFORMATION
// ============================================================

function getRoomInfo(room) {
  if (!room) return null;

  return {
    code: room.code,
    name: room.name,
    creatorName: room.creatorName,
    createdAt: room.createdAt,
    people: [...room.clients]
      .map(id => clients.get(id))
      .filter(Boolean)
      .map(client => ({
        id: client.id,
        userId: client.userId,
        name: client.name,
        role: client.role
      }))
  };
}

function getRoomList() {
  return [...rooms.values()]
    .map(getRoomInfo)
    .filter(Boolean);
}

function getBanList() {
  cleanExpiredBans();

  return [...bannedUsers.values()].map(ban => ({
    id: ban.id,
    userId: ban.userId,
    name: ban.name,
    moderatorName: ban.moderatorName,
    createdAt: ban.createdAt,
    expiresAt: ban.expiresAt,
    durationText: ban.durationText
  }));
}

function getModeratorAccessList() {
  cleanExpiredModeratorAccess();

  return [...moderatorAccess.values()].map(access => ({
    id: access.id,
    name: access.name,
    createdBy: access.createdBy,
    createdAt: access.createdAt,
    expiresAt: access.expiresAt,
    durationText: access.durationText
  }));
}

function getModeratorLog() {
  return moderationLog.slice(0, 200);
}

// ============================================================
// ROOM MANAGEMENT
// ============================================================

function makeRoomCode() {
  let code;

  do {
    code =
      Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();
  } while (rooms.has(code));

  return code;
}

function createRoom(name, code, creator) {
  let finalCode = cleanRoomCode(code);

  if (!finalCode) {
    finalCode = makeRoomCode();
  }

  if (rooms.has(finalCode)) {
    return null;
  }

  const room = {
    code: finalCode,
    name: cleanRoomName(name) || "Untitled Room",
    creatorName: creator ? creator.name : "Moderator",
    createdAt: Date.now(),
    clients: new Set()
  };

  rooms.set(finalCode, room);

  return room;
}

function removeFromRoom(client) {
  if (!client || !client.roomCode) {
    return;
  }

  const room = rooms.get(client.roomCode);

  if (!room) {
    client.roomCode = null;
    return;
  }

  room.clients.delete(client.id);

  for (const id of room.clients) {
    const other = clients.get(id);

    if (other) {
      send(other.ws, {
        type: "userLeft",
        id: client.id,
        name: client.name,
        role: client.role
      });
    }
  }

  client.roomCode = null;

  if (room.clients.size === 0) {
    rooms.delete(room.code);
  }
}

function joinRoom(client, roomCode) {
  const code = cleanRoomCode(roomCode);
  const room = rooms.get(code);

  if (!room) {
    send(client.ws, {
      type: "error",
      message: "Room not found."
    });

    return false;
  }

  if (client.roomCode) {
    removeFromRoom(client);
  }

  room.clients.add(client.id);
  client.roomCode = room.code;

  const people = [...room.clients]
    .map(id => clients.get(id))
    .filter(Boolean)
    .map(other => ({
      id: other.id,
      name: other.name,
      role: other.role
    }));

  send(client.ws, {
    type: "roomJoined",
    room: {
      code: room.code,
      name: room.name
    },
    people
  });

  for (const id of room.clients) {
    if (id === client.id) continue;

    const other = clients.get(id);

    if (other) {
      send(other.ws, {
        type: "userJoined",
        id: client.id,
        name: client.name,
        role: client.role
      });
    }
  }

  return true;
}

// ============================================================
// MODERATOR CONTROL
// ============================================================

function canControlTarget(moderator, target) {
  if (!moderator || !target) {
    return false;
  }

  if (target.id === moderator.id) {
    return false;
  }

  // Delegated moderators cannot control moderators.
  if (
    moderator.moderatorLevel !== "master" &&
    target.role === "moderator"
  ) {
    return false;
  }

  return true;
}

// ============================================================
// HTTP
// ============================================================

const INDEX_HTML = `
<!DOCTYPE html>
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
  max-width: 1000px;
  margin: auto;
  padding: 25px;
}

.card {
  background: #1d1d1d;
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 20px;
}

h1 {
  margin-top: 0;
}

input,
button {
  width: 100%;
  padding: 13px;
  margin-top: 10px;
  border-radius: 10px;
  border: none;
  font-size: 16px;
}

input {
  background: #2c2c2c;
  color: white;
}

button {
  background: #4b7bec;
  color: white;
  cursor: pointer;
}

button:hover {
  opacity: .9;
}

.danger {
  background: #d63031;
}

.secondary {
  background: #444;
}

.hidden {
  display: none !important;
}

.videoGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit,minmax(280px,1fr));
  gap: 15px;
}

.videoBox {
  background: #000;
  border-radius: 15px;
  overflow: hidden;
  position: relative;
}

video {
  width: 100%;
  display: block;
  background: #000;
}

.videoName {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0,0,0,.65);
  padding: 5px 8px;
  border-radius: 8px;
}

.chat {
  height: 250px;
  overflow-y: auto;
  background: #101010;
  border-radius: 10px;
  padding: 10px;
}

.message {
  padding: 6px;
}

.status {
  margin-top: 10px;
  color: #aaa;
}
</style>
</head>

<body>

<div class="container">

<div id="setup" class="card">
  <h1>Video Chat</h1>

  <input id="name" placeholder="Your name">

  <input id="roomName" placeholder="Room name">

  <input id="roomCode" placeholder="Room code">

  <button onclick="createRoom()">Create Room</button>

  <button class="secondary" onclick="joinRoom()">Join Room</button>

  <div id="setupStatus" class="status"></div>
</div>

<div id="call" class="hidden">

  <div class="card">
    <h2 id="roomTitle"></h2>
    <div id="roomCodeDisplay"></div>

    <button class="danger" onclick="leaveRoom()">
      Leave Room
    </button>
  </div>

  <div class="card">
    <div id="videos" class="videoGrid"></div>
  </div>

  <div class="card">
    <h2>Chat</h2>

    <div id="chat" class="chat"></div>

    <input
      id="chatInput"
      placeholder="Type a message..."
      onkeydown="if(event.key==='Enter') sendChat()"
    >

    <button onclick="sendChat()">Send</button>
  </div>

</div>

</div>

<script>
let ws;
let myId = null;
let myName = "";
let currentRoom = null;

const peers = new Map();
const remoteNames = new Map();

let localStream = null;

function connect() {
  return new Promise((resolve, reject) => {

    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const protocol =
      location.protocol === "https:"
        ? "wss:"
        : "ws:";

    ws = new WebSocket(
      protocol + "//" + location.host + "/ws"
    );

    ws.onopen = () => {
      resolve();
    };

    ws.onerror = () => {
      reject(new Error("Connection failed."));
    };

    ws.onmessage = event => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch(e) {
        console.error(e);
      }
    };

    ws.onclose = () => {
      console.log("Disconnected.");
    };
  });
}

async function setupLocalMedia() {
  try {
    localStream =
      await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
  } catch(e) {
    console.warn(e);

    localStream = null;

    alert(
      "Camera/microphone permission was not available. " +
      "You can still enter the room."
    );
  }
}

async function createRoom() {
  myName =
    document.getElementById("name").value.trim();

  const roomName =
    document.getElementById("roomName").value.trim();

  const roomCode =
    document.getElementById("roomCode").value.trim();

  if (!myName) {
    alert("Enter your name.");
    return;
  }

  if (!roomName) {
    alert("Enter a room name.");
    return;
  }

  if (!roomCode) {
    alert("Enter a room code.");
    return;
  }

  await connect();
  await setupLocalMedia();

  ws.send(JSON.stringify({
    type: "register",
    name: myName
  }));

  ws.send(JSON.stringify({
    type: "createRoom",
    name: roomName,
    code: roomCode
  }));
}

async function joinRoom() {
  myName =
    document.getElementById("name").value.trim();

  const roomCode =
    document.getElementById("roomCode").value.trim();

  if (!myName) {
    alert("Enter your name.");
    return;
  }

  if (!roomCode) {
    alert("Enter a room code.");
    return;
  }

  await connect();
  await setupLocalMedia();

  ws.send(JSON.stringify({
    type: "register",
    name: myName
  }));

  ws.send(JSON.stringify({
    type: "joinRoom",
    roomCode
  }));
}

function addLocalVideo() {
  if (!localStream) return;

  const box = document.createElement("div");
  box.className = "videoBox";
  box.id = "video_local";

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = localStream;

  const label = document.createElement("div");
  label.className = "videoName";
  label.textContent = myName + " (You)";

  box.appendChild(video);
  box.appendChild(label);

  document.getElementById("videos").appendChild(box);
}

function addRemoteVideo(id, name, stream) {
  let box = document.getElementById(
    "video_" + id
  );

  if (!box) {
    box = document.createElement("div");
    box.className = "videoBox";
    box.id = "video_" + id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;

    const label = document.createElement("div");
    label.className = "videoName";
    label.textContent = name;

    box.appendChild(video);
    box.appendChild(label);

    document
      .getElementById("videos")
      .appendChild(box);
  }

  const video = box.querySelector("video");

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
}

function removeRemoteVideo(id) {
  const box =
    document.getElementById("video_" + id);

  if (box) {
    box.remove();
  }

  const peer = peers.get(id);

  if (peer) {
    peer.close();
  }

  peers.delete(id);
  remoteNames.delete(id);
}

function makePeer(id, name) {
  if (peers.has(id)) {
    return peers.get(id);
  }

  const pc = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302"
      }
    ]
  });

  remoteNames.set(id, name);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  } else {
    pc.addTransceiver("audio", {
      direction: "recvonly"
    });

    pc.addTransceiver("video", {
      direction: "recvonly"
    });
  }

  pc.onicecandidate = event => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "signal",
        to: id,
        data: {
          candidate: event.candidate
        }
      }));
    }
  };

  pc.ontrack = event => {
    addRemoteVideo(
      id,
      remoteNames.get(id) || "User",
      event.streams[0]
    );
  };

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed" ||
      pc.connectionState === "disconnected"
    ) {
      removeRemoteVideo(id);
    }
  };

  peers.set(id, pc);

  return pc;
}

async function makeOffer(id, name) {
  const pc = makePeer(id, name);

  const offer = await pc.createOffer();

  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: "signal",
    to: id,
    data: {
      description: pc.localDescription
    }
  }));
}

async function handleSignal(from, data) {
  const pc =
    makePeer(
      from,
      remoteNames.get(from) || "User"
    );

  if (data.description) {

    await pc.setRemoteDescription(
      data.description
    );

    if (
      data.description.type === "offer"
    ) {

      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(answer);

      ws.send(JSON.stringify({
        type: "signal",
        to: from,
        data: {
          description: pc.localDescription
        }
      }));
    }

  } else if (data.candidate) {

    try {
      await pc.addIceCandidate(
        data.candidate
      );
    } catch(e) {
      console.warn(e);
    }
  }
}

function addChatMessage(name, text) {
  const chat =
    document.getElementById("chat");

  const div =
    document.createElement("div");

  div.className = "message";

  div.textContent =
    name + ": " + text;

  chat.appendChild(div);

  chat.scrollTop =
    chat.scrollHeight;
}

function sendChat() {
  const input =
    document.getElementById("chatInput");

  const text =
    input.value.trim();

  if (!text || !ws) {
    return;
  }

  ws.send(JSON.stringify({
    type: "chatMessage",
    text
  }));

  input.value = "";
}

function enterRoom(room) {
  currentRoom = room;

  document
    .getElementById("setup")
    .classList.add("hidden");

  document
    .getElementById("call")
    .classList.remove("hidden");

  document
    .getElementById("roomTitle")
    .textContent = room.name;

  document
    .getElementById("roomCodeDisplay")
    .textContent =
      "Room code: " + room.code;

  document
    .getElementById("videos")
    .innerHTML = "";

  document
    .getElementById("chat")
    .innerHTML = "";

  addLocalVideo();

  room.people.forEach(person => {
    if (person.id !== myId) {
      remoteNames.set(
        person.id,
        person.name
      );

      makeOffer(
        person.id,
        person.name
      );
    }
  });
}

function leaveRoom() {
  if (ws) {
    ws.send(JSON.stringify({
      type: "leaveRoom"
    }));
  }

  peers.forEach(pc => pc.close());

  peers.clear();

  currentRoom = null;

  document
    .getElementById("call")
    .classList.add("hidden");

  document
    .getElementById("setup")
    .classList.remove("hidden");

  document
    .getElementById("videos")
    .innerHTML = "";
}

function handleMessage(data) {

  if (data.type === "registered") {

    myId = data.id;

    return;
  }

  if (data.type === "roomCreated") {

    enterRoom(data.room);

    return;
  }

  if (data.type === "roomJoined") {

    enterRoom(data.room);

    return;
  }

  if (data.type === "userJoined") {

    remoteNames.set(
      data.id,
      data.name
    );

    makeOffer(
      data.id,
      data.name
    );

    return;
  }

  if (data.type === "signal") {

    handleSignal(
      data.from,
      data.data
    );

    return;
  }

  if (data.type === "moderatorReady") {

    makeOffer(
      data.moderatorId,
      data.moderatorName
    );

    return;
  }

  if (data.type === "userLeft") {

    removeRemoteVideo(
      data.id
    );

    return;
  }

  if (data.type === "chatMessage") {

    addChatMessage(
      data.name,
      data.text
    );

    return;
  }

  if (data.type === "kicked") {

    alert(
      data.message ||
      "You were kicked from the room."
    );

    leaveRoom();

    return;
  }

  if (data.type === "banned") {

    alert(
      data.message ||
      "You were banned."
    );

    leaveRoom();

    return;
  }

  if (data.type === "error") {

    document
      .getElementById("setupStatus")
      .textContent = data.message;

    alert(data.message);

    return;
  }
}
</script>

</body>
</html>
`;

const BLUEBERRY_HTML = `
<!DOCTYPE html>
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
  font-family: Arial, sans-serif;
  background: #101010;
  color: white;
}

.container {
  max-width: 1200px;
  margin: auto;
  padding: 20px;
}

.card {
  background: #1d1d1d;
  border-radius: 16px;
  padding: 18px;
  margin-bottom: 18px;
}

h1,
h2,
h3 {
  margin-top: 0;
}

input,
button {
  padding: 11px;
  border-radius: 9px;
  border: none;
  margin-top: 7px;
  font-size: 15px;
}

input {
  background: #2a2a2a;
  color: white;
}

button {
  background: #4b7bec;
  color: white;
  cursor: pointer;
}

button:hover {
  opacity: .9;
}

.danger {
  background: #d63031;
}

.green {
  background: #00b894;
}

.gray {
  background: #444;
}

.hidden {
  display: none !important;
}

.room {
  background: #282828;
  border-radius: 12px;
  padding: 15px;
  margin-top: 12px;
}

.people {
  margin-top: 12px;
  background: #171717;
  padding: 12px;
  border-radius: 10px;
}

.person {
  background: #292929;
  padding: 10px;
  border-radius: 9px;
  margin-top: 8px;
}

.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.row button {
  flex: 1;
  min-width: 100px;
}

.duration {
  display: grid;
  grid-template-columns: repeat(auto-fit,minmax(120px,1fr));
  gap: 8px;
}

.duration input {
  width: 100%;
}

.chat {
  height: 220px;
  overflow-y: auto;
  background: #111;
  border-radius: 10px;
  padding: 10px;
}

.message {
  padding: 5px;
}

video {
  width: 100%;
  background: #000;
  border-radius: 12px;
}

.videoGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit,minmax(250px,1fr));
  gap: 12px;
}

.videoBox {
  position: relative;
}

.videoLabel {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0,0,0,.7);
  padding: 5px;
  border-radius: 6px;
}

.small {
  color: #aaa;
  font-size: 13px;
}

.log {
  background: #242424;
  border-radius: 8px;
  padding: 9px;
  margin-top: 7px;
}
</style>
</head>

<body>

<div class="container">

<div id="login" class="card">

  <h1>🫐 Moderator Dashboard</h1>

  <input
    id="modName"
    placeholder="Your moderator name"
  >

  <input
    id="modPin"
    type="password"
    placeholder="Moderator PIN"
  >

  <button onclick="loginModerator()">
    Enter Dashboard
  </button>

  <div id="loginStatus"></div>

</div>

<div id="dashboard" class="hidden">

  <div class="card">

    <h1>Moderator Dashboard</h1>

    <div>
      Logged in as:
      <strong id="loggedInName"></strong>
    </div>

    <button onclick="manualRefresh()">
      🔄 Refresh
    </button>

    <button
      class="gray"
      onclick="logoutModerator()"
    >
      Logout
    </button>

    <div class="small">
      The dashboard does NOT automatically refresh.
      Click Refresh whenever you want updated lists.
    </div>

  </div>

  <div class="card">

    <h2>Create Room</h2>

    <input
      id="newRoomName"
      placeholder="Room name"
    >

    <input
      id="newRoomCode"
      placeholder="Room code"
    >

    <button
      class="green"
      onclick="createModeratorRoom()"
    >
      Create Room
    </button>

  </div>

  <div class="card">

    <h2>Open Calls</h2>

    <div id="rooms"></div>

  </div>

  <div class="card">

    <h2>Ban List</h2>

    <div id="bans"></div>

  </div>

  <div
    id="moderatorAccessCard"
    class="card"
  >

    <h2>Moderator Access</h2>

    <div id="moderatorAccess"></div>

  </div>

  <div class="card">

    <h2>Moderation History</h2>

    <div id="logs"></div>

  </div>

</div>

<script>

let ws;
let moderatorName = "";
let moderatorLevel = "";
let currentRoom = null;

const peers = new Map();
const remoteNames = new Map();

function connect() {

  return new Promise((resolve, reject) => {

    const protocol =
      location.protocol === "https:"
        ? "wss:"
        : "ws:";

    ws = new WebSocket(
      protocol + "//" + location.host + "/ws"
    );

    ws.onopen = () => {
      resolve();
    };

    ws.onerror = () => {
      reject(
        new Error("Connection failed.")
      );
    };

    ws.onmessage = event => {

      try {
        handleMessage(
          JSON.parse(event.data)
        );
      } catch(e) {
        console.error(e);
      }

    };

  });
}

async function loginModerator() {

  moderatorName =
    document
      .getElementById("modName")
      .value
      .trim();

  const pin =
    document
      .getElementById("modPin")
      .value
      .trim();

  if (!moderatorName) {
    alert("Enter your moderator name.");
    return;
  }

  if (!pin) {
    alert("Enter the moderator PIN.");
    return;
  }

  try {
    await connect();

    ws.send(JSON.stringify({
      type: "moderatorAuth",
      name: moderatorName,
      pin
    }));

  } catch(e) {

    alert(
      "Could not connect to the server."
    );

  }
}

function manualRefresh() {

  if (!ws ||
      ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({
    type: "getModeratorData"
  }));
}

function logoutModerator() {

  if (ws) {
    ws.close();
  }

  location.reload();
}

function createModeratorRoom() {

  const name =
    document
      .getElementById("newRoomName")
      .value
      .trim();

  const code =
    document
      .getElementById("newRoomCode")
      .value
      .trim();

  if (!name || !code) {
    alert(
      "Enter both a room name and room code."
    );
    return;
  }

  ws.send(JSON.stringify({
    type: "moderatorCreateRoom",
    name,
    code
  }));
}

function showRoomChat(room) {

  const card =
    document.querySelector(
      ".room[data-room-code='" +
      room.code +
      "']"
    );

  if (!card) return;

  let chat =
    card.querySelector(".roomChat");

  if (!chat) {

    chat =
      document.createElement("div");

    chat.className = "roomChat";

    chat.innerHTML =

      "<h3>Room Chat</h3>" +

      "<div class='chat'></div>" +

      "<input placeholder='Moderator message...' " +
      "class='modChatInput'>" +

      "<button class='green'>Send</button>";

    card.appendChild(chat);

    const input =
      chat.querySelector(
        ".modChatInput"
      );

    const button =
      chat.querySelector(
        "button"
      );

    button.onclick = () => {

      const text =
        input.value.trim();

      if (!text) return;

      ws.send(JSON.stringify({
        type: "chatMessage",
        text
      }));

      input.value = "";
    };
  }
}

function joinRoom(roomCode) {

  ws.send(JSON.stringify({
    type: "moderatorJoinRoom",
    roomCode,
    anonymous: true
  }));

}

function leaveRoom() {

  if (ws) {

    ws.send(JSON.stringify({
      type: "leaveRoom"
    }));

  }

  peers.forEach(
    pc => pc.close()
  );

  peers.clear();

  currentRoom = null;

  const call =
    document.getElementById(
      "moderatorCall"
    );

  if (call) {
    call.remove();
  }
}

function showPeople(room, parent) {

  let people =
    parent.querySelector(".people");

  if (people) {
    people.remove();
  }

  people =
    document.createElement("div");

  people.className = "people";

  people.dataset.roomCode =
    room.code;

  people.innerHTML =
    "Loading people...";

  parent.appendChild(people);

  ws.send(JSON.stringify({
    type: "getRoomPeople",
    roomCode: room.code
  }));

}

function renderPeople(roomCode, peopleList) {

  const people =
    document.querySelector(
      ".people[data-room-code='" +
      roomCode +
      "']"
    );

  if (!people) return;

  people.innerHTML = "";

  if (!peopleList.length) {

    people.textContent =
      "No people currently in this room.";

    return;
  }

  peopleList.forEach(person => {

    const div =
      document.createElement("div");

    div.className = "person";

    const name =
      document.createElement("strong");

    name.textContent =
      person.name;

    div.appendChild(name);

    const info =
      document.createElement("div");

    info.className = "small";

    info.textContent =
      person.role === "moderator"
        ? "Moderator"
        : "Participant";

    div.appendChild(info);

    const buttons =
      document.createElement("div");

    buttons.className = "row";

    if (person.role !== "moderator") {

      const kick =
        document.createElement("button");

      kick.className = "danger";

      kick.textContent = "Kick";

      kick.onclick = () => {

        ws.send(JSON.stringify({
          type: "kick",
          targetId: person.id
        }));

      };

      buttons.appendChild(kick);

      const ban =
        document.createElement("button");

      ban.className = "danger";

      ban.textContent = "Ban";

      ban.onclick = () => {
        showBanControls(
          div,
          person
        );
      };

      buttons.appendChild(ban);

      if (moderatorLevel === "master") {

        const modButton =
          document.createElement("button");

        modButton.className = "green";

        modButton.textContent =
          "Give Moderator";

        modButton.onclick = () => {

          showGiveModerator(
            div,
            person
          );

        };

        buttons.appendChild(
          modButton
        );
      }
    }

    div.appendChild(buttons);

    people.appendChild(div);

  });

}

function showBanControls(parent, person) {

  if (
    parent.querySelector(
      ".banControls"
    )
  ) {
    return;
  }

  const box =
    document.createElement("div");

  box.className =
    "banControls";

  box.innerHTML =

    "<h4>Ban " +
    escapeHtml(person.name) +
    "</h4>" +

    "<label>" +
    "<input class='banPermanent' type='checkbox'>" +
    " Permanent ban" +
    "</label>" +

    "<div class='duration'>" +

    "<input class='banSeconds' type='number' min='0' placeholder='Seconds'>" +

    "<input class='banMinutes' type='number' min='0' placeholder='Minutes'>" +

    "<input class='banHours' type='number' min='0' placeholder='Hours'>" +

    "<input class='banDays' type='number' min='0' placeholder='Days'>" +

    "<input class='banWeeks' type='number' min='0' placeholder='Weeks'>" +

    "<input class='banMonths' type='number' min='0' placeholder='Months'>" +

    "<input class='banYears' type='number' min='0' placeholder='Years'>" +

    "</div>" +

    "<button class='danger'>Apply Ban</button>";

  parent.appendChild(box);

  box.querySelector("button").onclick =
    () => {

      ws.send(JSON.stringify({
        type: "ban",
        targetId: person.id,
        permanent:
          box.querySelector(
            ".banPermanent"
          ).checked,
        seconds:
          box.querySelector(
            ".banSeconds"
          ).value,
        minutes:
          box.querySelector(
            ".banMinutes"
          ).value,
        hours:
          box.querySelector(
            ".banHours"
          ).value,
        days:
          box.querySelector(
            ".banDays"
          ).value,
        weeks:
          box.querySelector(
            ".banWeeks"
          ).value,
        months:
          box.querySelector(
            ".banMonths"
          ).value,
        years:
          box.querySelector(
            ".banYears"
          ).value
      }));

    };
}

function showGiveModerator(parent, person) {

  if (
    parent.querySelector(
      ".giveModControls"
    )
  ) {
    return;
  }

  const box =
    document.createElement("div");

  box.className =
    "giveModControls";

  box.innerHTML =

    "<h4>Give Moderator Access</h4>" +

    "<input class='newModPin' " +
    "placeholder='Custom moderator PIN'>" +

    "<div class='duration'>" +

    "<input class='modSeconds' type='number' min='0' placeholder='Seconds'>" +

    "<input class='modMinutes' type='number' min='0' placeholder='Minutes'>" +

    "<input class='modHours' type='number' min='0' placeholder='Hours'>" +

    "<input class='modDays' type='number' min='0' placeholder='Days'>" +

    "<input class='modWeeks' type='number' min='0' placeholder='Weeks'>" +

    "<input class='modMonths' type='number' min='0' placeholder='Months'>" +

    "<input class='modYears' type='number' min='0' placeholder='Years'>" +

    "</div>" +

    "<button class='green'>Give Moderator</button>";

  parent.appendChild(box);

  box.querySelector("button").onclick =
    () => {

      ws.send(JSON.stringify({
        type: "giveModerator",
        targetId: person.id,
        pin:
          box.querySelector(
            ".newModPin"
          ).value,
        seconds:
          box.querySelector(
            ".modSeconds"
          ).value,
        minutes:
          box.querySelector(
            ".modMinutes"
          ).value,
        hours:
          box.querySelector(
            ".modHours"
          ).value,
        days:
          box.querySelector(
            ".modDays"
          ).value,
        weeks:
          box.querySelector(
            ".modWeeks"
          ).value,
        months:
          box.querySelector(
            ".modMonths"
          ).value,
        years:
          box.querySelector(
            ".modYears"
          ).value
      }));

    };
}

function renderRooms(roomList) {

  const container =
    document.getElementById(
      "rooms"
    );

  // Save which View People panels
  // the moderator manually opened.
  const openPeople =
    new Set();

  document
    .querySelectorAll(
      ".people[data-room-code]"
    )
    .forEach(el => {

      openPeople.add(
        el.dataset.roomCode
      );

    });

  container.innerHTML = "";

  if (!roomList.length) {

    container.textContent =
      "No open calls.";

    return;
  }

  roomList.forEach(room => {

    const div =
      document.createElement("div");

    div.className = "room";

    div.dataset.roomCode =
      room.code;

    div.innerHTML =

      "<strong>" +
      escapeHtml(room.name) +
      "</strong>" +

      "<div class='small'>" +
      "Code: " +
      escapeHtml(room.code) +
      "</div>" +

      "<div class='small'>" +
      "People: " +
      room.people.length +
      "</div>";

    const buttons =
      document.createElement("div");

    buttons.className = "row";

    const view =
      document.createElement("button");

    view.textContent =
      "View People";

    view.onclick = () => {

      showPeople(
        room,
        div
      );

    };

    buttons.appendChild(view);

    const join =
      document.createElement("button");

    join.className = "green";

    join.textContent =
      "Join Anonymously";

    join.onclick = () => {

      joinRoom(room.code);

    };

    buttons.appendChild(join);

    div.appendChild(buttons);

    container.appendChild(div);

  });

  // Restore manually opened panels
  // after a MANUAL refresh only.
  openPeople.forEach(code => {

    const room =
      roomList.find(
        r => r.code === code
      );

    if (!room) return;

    const div =
      container.querySelector(
        ".room[data-room-code='" +
        code +
        "']"
      );

    if (div) {
      showPeople(
        room,
        div
      );
    }

  });

}

function renderBans(bans) {

  const container =
    document.getElementById(
      "bans"
    );

  container.innerHTML = "";

  if (!bans.length) {

    container.textContent =
      "No active bans.";

    return;
  }

  bans.forEach(ban => {

    const div =
      document.createElement("div");

    div.className = "log";

    div.innerHTML =
      "<strong>" +
      escapeHtml(ban.name) +
      "</strong>" +

      "<div class='small'>" +
      escapeHtml(
        ban.durationText
      ) +
      "</div>";

    const button =
      document.createElement("button");

    button.className = "gray";

    button.textContent =
      "Unban";

    button.onclick = () => {

      ws.send(JSON.stringify({
        type: "unban",
        banId: ban.id
      }));

    };

    div.appendChild(button);

    container.appendChild(div);

  });

}

function renderModeratorAccess(list) {

  const container =
    document.getElementById(
      "moderatorAccess"
    );

  container.innerHTML = "";

  if (!list.length) {

    container.textContent =
      "No delegated moderator access.";

    return;
  }

  list.forEach(access => {

    const div =
      document.createElement("div");

    div.className = "log";

    div.innerHTML =

      "<strong>" +
      escapeHtml(access.name) +
      "</strong>" +

      "<div class='small'>" +
      "Created by: " +
      escapeHtml(access.createdBy) +
      "</div>" +

      "<div class='small'>" +
      "Duration: " +
      escapeHtml(access.durationText) +
      "</div>";

    if (moderatorLevel === "master") {

      const revoke =
        document.createElement("button");

      revoke.className = "danger";

      revoke.textContent =
        "Revoke Moderator";

      revoke.onclick = () => {

        ws.send(JSON.stringify({
          type: "revokeModerator",
          accessId: access.id
        }));

      };

      div.appendChild(revoke);

    }

    container.appendChild(div);

  });

}

function renderLogs(logs) {

  const container =
    document.getElementById(
      "logs"
    );

  container.innerHTML = "";

  if (!logs.length) {

    container.textContent =
      "No moderation history.";

    return;
  }

  logs.forEach(log => {

    const div =
      document.createElement("div");

    div.className = "log";

    div.innerHTML =

      "<strong>" +
      escapeHtml(log.action) +
      "</strong>" +

      "<div>" +
      escapeHtml(
        JSON.stringify(
          log.details
        )
      ) +
      "</div>" +

      "<div class='small'>" +
      new Date(
        log.timestamp
      ).toLocaleString() +
      "</div>";

    container.appendChild(div);

  });

}

function renderModeratorCall(room) {

  let call =
    document.getElementById(
      "moderatorCall"
    );

  if (call) {
    call.remove();
  }

  call =
    document.createElement("div");

  call.id =
    "moderatorCall";

  call.className =
    "card";

  call.innerHTML =

    "<h2>" +
    escapeHtml(room.name) +
    "</h2>" +

    "<div class='small'>" +
    "Room code: " +
    escapeHtml(room.code) +
    "</div>" +

    "<button class='danger'>" +
    "Leave Room" +
    "</button>" +

    "<div id='modVideos' class='videoGrid'>" +
    "</div>";

  call
    .querySelector("button")
    .onclick =
      leaveRoom;

  document
    .getElementById(
      "dashboard"
    )
    .prepend(call);
}

function addModeratorVideo(
  id,
  name,
  stream
) {

  const container =
    document.getElementById(
      "modVideos"
    );

  if (!container) return;

  let box =
    document.getElementById(
      "mod_video_" + id
    );

  if (!box) {

    box =
      document.createElement("div");

    box.className =
      "videoBox";

    box.id =
      "mod_video_" + id;

    const video =
      document.createElement("video");

    video.autoplay = true;
    video.playsInline = true;

    const label =
      document.createElement("div");

    label.className =
      "videoLabel";

    label.textContent =
      name;

    box.appendChild(video);
    box.appendChild(label);

    container.appendChild(box);

  }

  box.querySelector(
    "video"
  ).srcObject = stream;
}

function makeModeratorPeer(
  id,
  name
) {

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

  remoteNames.set(
    id,
    name
  );

  // IMPORTANT:
  // Moderator publishes NO camera/mic.
  pc.addTransceiver(
    "audio",
    {
      direction: "recvonly"
    }
  );

  pc.addTransceiver(
    "video",
    {
      direction: "recvonly"
    }
  );

  pc.onicecandidate =
    event => {

      if (
        event.candidate
      ) {

        ws.send(JSON.stringify({
          type: "signal",
          to: id,
          data: {
            candidate:
              event.candidate
          }
        }));

      }

    };

  pc.ontrack =
    event => {

      addModeratorVideo(
        id,
        remoteNames.get(id) ||
          "Participant",
        event.streams[0]
      );

    };

  pc.onconnectionstatechange =
    () => {

      if (
        pc.connectionState ===
          "failed" ||
        pc.connectionState ===
          "closed" ||
        pc.connectionState ===
          "disconnected"
      ) {

        const box =
          document.getElementById(
            "mod_video_" + id
          );

        if (box) {
          box.remove();
        }

        peers.delete(id);

      }

    };

  peers.set(id, pc);

  return pc;
}

async function handleModeratorSignal(
  from,
  data
) {

  const pc =
    makeModeratorPeer(
      from,
      remoteNames.get(from) ||
        "Participant"
    );

  if (data.description) {

    await pc.setRemoteDescription(
      data.description
    );

    if (
      data.description.type ===
      "offer"
    ) {

      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(
        answer
      );

      ws.send(JSON.stringify({
        type: "signal",
        to: from,
        data: {
          description:
            pc.localDescription
        }
      }));

    }

  } else if (data.candidate) {

    try {

      await pc.addIceCandidate(
        data.candidate
      );

    } catch(e) {

      console.warn(e);

    }

  }

}

function addRoomChatMessage(
  name,
  text
) {

  const card =
    document.querySelector(
      ".room[data-room-code='" +
      currentRoom.code +
      "']"
    );

  // Moderator call has its own chat
  // below, so room chat is rendered
  // there when available.
  const chats =
    document.querySelectorAll(
      ".chat"
    );

  chats.forEach(chat => {

    const div =
      document.createElement("div");

    div.className =
      "message";

    div.textContent =
      name + ": " + text;

    chat.appendChild(div);

    chat.scrollTop =
      chat.scrollHeight;

  });

}

function handleMessage(data) {

  if (data.type === "moderatorAuthSuccess") {

    moderatorLevel =
      data.level;

    document
      .getElementById(
        "login"
      )
      .classList.add(
        "hidden"
      );

    document
      .getElementById(
        "dashboard"
      )
      .classList.remove(
        "hidden"
      );

    document
      .getElementById(
        "loggedInName"
      )
      .textContent =
        moderatorName;

    // Initial login gets the first
    // dashboard data.
    renderRooms(
      data.rooms || []
    );

    renderBans(
      data.bans || []
    );

    renderModeratorAccess(
      data.moderatorAccess || []
    );

    renderLogs(
      data.logs || []
    );

    return;
  }

  if (data.type === "moderatorData") {

    // This ONLY happens when the
    // moderator manually presses Refresh.
    renderRooms(
      data.rooms || []
    );

    renderBans(
      data.bans || []
    );

    renderModeratorAccess(
      data.moderatorAccess || []
    );

    renderLogs(
      data.logs || []
    );

    return;
  }

  if (data.type === "roomPeople") {

    renderPeople(
      data.roomCode,
      data.people || []
    );

    return;
  }

  if (data.type === "roomCreated") {

    alert(
      "Room created: " +
      data.room.code
    );

    return;
  }

  if (data.type === "roomJoined") {

    currentRoom =
      data.room;

    renderModeratorCall(
      data.room
    );

    // Ask every participant to
    // create an offer to this
    // receive-only moderator.
    (data.people || [])
      .forEach(person => {

        if (
          person.role !==
          "moderator"
        ) {

          remoteNames.set(
            person.id,
            person.name
          );

          ws.send(JSON.stringify({
            type:
              "requestOffer",
            to:
              person.id
          }));

        }

      });

    return;
  }

  if (data.type === "userJoined") {

    if (
      currentRoom &&
      data.role !== "moderator"
    ) {

      remoteNames.set(
        data.id,
        data.name
      );

      ws.send(JSON.stringify({
        type:
          "requestOffer",
        to:
          data.id
      }));

    }

    return;
  }

  if (data.type === "signal") {

    handleModeratorSignal(
      data.from,
      data.data
    );

    return;
  }

  if (data.type === "chatMessage") {

    addRoomChatMessage(
      data.name,
      data.text
    );

    return;
  }

  if (data.type === "roomLeft") {

    leaveRoom();

    return;
  }

  if (data.type === "roomPeople") {

    renderPeople(
      data.roomCode,
      data.people || []
    );

    return;
  }

  if (data.type === "kicked") {

    alert(
      "User kicked."
    );

    return;
  }

  if (data.type === "banned") {

    alert(
      "User banned."
    );

    return;
  }

  if (
    data.type ===
    "moderatorAccessCreated"
  ) {

    alert(
      "Moderator access created."
    );

    return;
  }

  if (
    data.type ===
    "moderatorAccessGranted"
  ) {

    alert(
      "You have been granted moderator access."
    );

    return;
  }

  if (
    data.type ===
    "moderatorAccessRevoked"
  ) {

    alert(
      "Moderator access revoked."
    );

    return;
  }

  if (data.type === "error") {

    alert(
      data.message
    );

    return;
  }
}

function renderPeople(
  roomCode,
  peopleList
) {

  const people =
    document.querySelector(
      ".people[data-room-code='" +
      roomCode +
      "']"
    );

  if (!people) return;

  people.innerHTML = "";

  if (!peopleList.length) {

    people.textContent =
      "No people currently in this room.";

    return;
  }

  peopleList.forEach(person => {

    const div =
      document.createElement("div");

    div.className =
      "person";

    const strong =
      document.createElement("strong");

    strong.textContent =
      person.name;

    div.appendChild(strong);

    const small =
      document.createElement("div");

    small.className =
      "small";

    small.textContent =
      person.role === "moderator"
        ? "Moderator"
        : "Participant";

    div.appendChild(small);

    if (
      person.role !==
      "moderator"
    ) {

      const row =
        document.createElement("div");

      row.className =
        "row";

      const kick =
        document.createElement("button");

      kick.className =
        "danger";

      kick.textContent =
        "Kick";

      kick.onclick =
        () => {

          ws.send(JSON.stringify({
            type: "kick",
            targetId:
              person.id
          }));

        };

      row.appendChild(
        kick
      );

      const ban =
        document.createElement("button");

      ban.className =
        "danger";

      ban.textContent =
        "Ban";

      ban.onclick =
        () => {

          showBanControls(
            div,
            person
          );

        };

      row.appendChild(
        ban
      );

      if (
        moderatorLevel ===
        "master"
      ) {

        const give =
          document.createElement(
            "button"
          );

        give.className =
          "green";

        give.textContent =
          "Give Moderator";

        give.onclick =
          () => {

            showGiveModerator(
              div,
              person
            );

          };

        row.appendChild(
          give
        );

      }

      div.appendChild(
        row
      );

    }

    people.appendChild(
      div
    );

  });

}

function escapeHtml(value) {

  const div =
    document.createElement(
      "div"
    );

  div.textContent =
    String(value);

  return div.innerHTML;
}

</script>

</body>
</html>
`;

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(
  (req, res) => {

    if (
      req.url === "/" ||
      req.url === "/index.html"
    ) {

      res.writeHead(
        200,
        {
          "Content-Type":
            "text/html; charset=utf-8"
        }
      );

      res.end(
        INDEX_HTML
      );

      return;
    }

    if (
      req.url === "/blueberry" ||
      req.url === "/blueberry.html"
    ) {

      res.writeHead(
        200,
        {
          "Content-Type":
            "text/html; charset=utf-8"
        }
      );

      res.end(
        BLUEBERRY_HTML
      );

      return;
    }

    if (req.url === "/health") {

      res.writeHead(
        200,
        {
          "Content-Type":
            "application/json"
        }
      );

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
    noServer: true
  });

server.on(
  "upgrade",
  (request, socket, head) => {

    if (
      request.url !== "/ws"
    ) {

      socket.destroy();

      return;
    }

    wss.handleUpgrade(
      request,
      socket,
      head,
      ws => {

        wss.emit(
          "connection",
          ws,
          request
        );

      }
    );
  }
);

wss.on(
  "connection",
  ws => {

    const client = {
      id: makeId("client"),
      userId: makeId("user"),
      name: "Anonymous",
      role: "unknown",
      moderatorLevel: null,
      moderatorAccessId: null,
      roomCode: null,
      ws
    };

    clients.set(
      client.id,
      client
    );

    send(ws, {
      type: "connected",
      id: client.id
    });

    ws.on(
      "message",
      raw => {

        let data;

        try {
          data =
            JSON.parse(
              raw.toString()
            );
        } catch(e) {

          send(ws, {
            type: "error",
            message:
              "Invalid message."
          });

          return;
        }

        // ====================================================
        // NORMAL USER REGISTER
        // ====================================================

        if (
          data.type ===
          "register"
        ) {

          const name =
            cleanName(
              data.name
            );

          if (!name) {

            send(ws, {
              type: "error",
              message:
                "Name is required."
            });

            return;
          }

          client.name =
            name;

          client.role =
            "user";

          const ban =
            getBan(
              client
            );

          if (ban) {

            send(ws, {
              type: "banned",
              message:
                "You are banned from this server."
            });

            return;
          }

          send(ws, {
            type: "registered",
            id: client.id,
            userId: client.userId
          });

          return;
        }

        // ====================================================
        // MODERATOR AUTH
        // ====================================================

        if (
          data.type ===
          "moderatorAuth"
        ) {

          const name =
            cleanName(
              data.name
            );

          const pin =
            cleanPin(
              data.pin
            );

          if (!name || !pin) {

            send(ws, {
              type: "error",
              message:
                "Moderator name and PIN are required."
            });

            return;
          }

          if (
            pin === MASTER_PIN
          ) {

            client.name =
              name;

            client.role =
              "moderator";

            client.moderatorLevel =
              "master";

            send(ws, {
              type:
                "moderatorAuthSuccess",
              level:
                "master",
              rooms:
                getRoomList(),
              bans:
                getBanList(),
              moderatorAccess:
                getModeratorAccessList(),
              logs:
                getModeratorLog()
            });

            return;
          }

          const access =
            getModeratorAccessByPin(
              pin
            );

          if (!access) {

            send(ws, {
              type: "error",
              message:
                "Invalid moderator PIN."
            });

            return;
          }

          client.name =
            name;

          client.role =
            "moderator";

          client.moderatorLevel =
            "delegated";

          client.moderatorAccessId =
            access.id;

          send(ws, {
            type:
              "moderatorAuthSuccess",
            level:
              "delegated",
            rooms:
              getRoomList(),
            bans:
              getBanList(),
            moderatorAccess:
              getModeratorAccessList(),
            logs:
              getModeratorLog()
          });

          return;
        }

        // ====================================================
        // SET NAME
        // ====================================================

        if (
          data.type ===
          "setName"
        ) {

          const name =
            cleanName(
              data.name
            );

          if (name) {
            client.name =
              name;
          }

          return;
        }

        // ====================================================
        // NORMAL CREATE ROOM
        // ====================================================

        if (
          data.type ===
          "createRoom"
        ) {

          if (
            client.role !==
            "user"
          ) {

            send(ws, {
              type: "error",
              message:
                "Only normal users can use this."
            });

            return;
          }

          const room =
            createRoom(
              data.name,
              data.code,
              client
            );

          if (!room) {

            send(ws, {
              type: "error",
              message:
                "That room code is already in use."
            });

            return;
          }

          joinRoom(
            client,
            room.code
          );

          send(ws, {
            type: "roomCreated",
            room: {
              code:
                room.code,
              name:
                room.name
            }
          });

          return;
        }

        // ====================================================
        // MODERATOR CREATE ROOM
        // ====================================================

        if (
          data.type ===
          "moderatorCreateRoom"
        ) {

          if (
            !requireModerator(
              ws,
              client
            )
          ) {
            return;
          }

          const room =
            createRoom(
              data.name,
              data.code,
              client
            );

          if (!room) {

            send(ws, {
              type: "error",
              message:
                "That room code is already in use."
            });

            return;
          }

          send(ws, {
            type: "roomCreated",
            room: {
              code:
                room.code,
              name:
                room.name
            }
          });

          addLog(
            "ROOM_CREATED",
            {
              moderator:
                client.name,
              room:
                room.code
            }
          );

          // IMPORTANT:
          // We DO NOT broadcast dashboard data.
          // Moderator must press Refresh.
          return;
        }

        // ====================================================
        // NORMAL JOIN
        // ====================================================

        if (
          data.type ===
          "joinRoom"
        ) {

          if (
            client.role !==
            "user"
          ) {

            send(ws, {
              type: "error",
              message:
                "Only normal users can use this."
            });

            return;
          }

          const ban =
            getBan(
              client
            );

          if (ban) {

            send(ws, {
              type: "banned",
              message:
                "You are banned."
            });

            return;
          }

          joinRoom(
            client,
            data.roomCode
          );

          return;
        }

        // ====================================================
        // MODERATOR JOIN
        // ====================================================

        if (
          data.type ===
          "moderatorJoinRoom"
        ) {

          if (
            !requireModerator(
              ws,
              client
            )
          ) {
            return;
          }

          const ok =
            joinRoom(
              client,
              data.roomCode
            );

          if (!ok) {
            return;
          }

          // Tell normal users that a
          // moderator is ready to receive media.
          const room =
            rooms.get(
              client.roomCode
            );

          if (room) {

            for (
              const id of room.clients
            ) {

              if (
                id ===
                client.id
              ) {
                continue;
              }

              const other =
                clients.get(id);

              if (
                other &&
                other.role ===
                "user"
              ) {

                send(
                  other.ws,
                  {
                    type:
                      "moderatorReady",
                    moderatorId:
                      client.id,
                    moderatorName:
                      client.name
                  }
                );

              }

            }

          }

          return;
        }

        // ====================================================
        // LEAVE ROOM
        // ====================================================

        if (
          data.type ===
          "leaveRoom"
        ) {

          removeFromRoom(
            client
          );

          send(ws, {
            type:
              "roomLeft"
          });

          return;
        }

        // ====================================================
        // REQUEST OFFER
        // ====================================================

        if (
          data.type ===
          "requestOffer"
        ) {

          if (
            !requireModerator(
              ws,
              client
            )
          ) {
            return;
          }

          const target =
            clients.get(
              data.to
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

          send(
            target.ws,
            {
              type:
                "moderatorReady",
              moderatorId:
                client.id,
              moderatorName:
                client.name
            }
          );

          return;
        }

        // ====================================================
        // SIGNAL
        // ====================================================

        if (
          data.type ===
          "signal"
        ) {

          const target =
            clients.get(
              data.to
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

          send(
            target.ws,
            {
              type:
                "signal",
              from:
                client.id,
              data:
                data.data
            }
          );

          return;
        }

        // ====================================================
        // CHAT
        // ====================================================

        if (
          data.type ===
          "chatMessage"
        ) {

          if (!client.roomCode) {

            return;
          }

          const room =
            rooms.get(
              client.roomCode
            );

          if (!room) {
            return;
          }

          const text =
            String(
              data.text || ""
            )
              .trim()
              .slice(0, 500);

          if (!text) {
            return;
          }

          let displayName =
            client.name;

          if (
            client.role ===
            "moderator"
          ) {

            displayName =
              client.name +
              " (Moderator)";

          }

          for (
            const id of room.clients
          ) {

            const other =
              clients.get(id);

            if (other) {

              send(
                other.ws,
                {
                  type:
                    "chatMessage",
                  name:
                    displayName,
                  text
                }
              );

            }

          }

          return;
        }

        // ====================================================
        // GET ROOM PEOPLE
        // MANUAL ONLY
        // ====================================================

        if (
          data.type ===
          "getRoomPeople"
        ) {

          if (
            !requireModerator(
              ws,
              client
            )
          ) {
            return;
          }

          const room =
            rooms.get(
              cleanRoomCode(
                data.roomCode
              )
            );

          if (!room) {

            send(ws, {
              type: "roomPeople",
              roomCode:
                data.roomCode,
              people: []
            });

            return;
          }

          const people =
            [...room.clients]
              .map(id =>
                clients.get(id)
              )
              .filter(Boolean)
              .map(person => ({
                id:
                  person.id,
                userId:
                  person.userId,
                name:
                  person.name,
                role:
                  person.role
              }));

          send(ws, {
            type:
              "roomPeople",
            roomCode:
              room.code,
            people
          });

          return;
        }

        // ====================================================
        // KICK
        // ====================================================

        if (
          data.type ===
          "kick"
        ) {

          if (
            !requireModerator(
              ws,
              client
            )
          ) {
            return;
          }

          const target =
            clients.get(
              data.targetId
            );

          if (!target) {

            send(ws, {
              type: "error",
              message:
                "User is no longer connected."
            });

            return;
          }

          if (
            !canControlTarget(
              client,
              target
            )
          ) {

            send(ws, {
              type: "error",
              message:
                "You cannot control this user."
            });

            return;
          }

          addLog(
            "KICK",
            {
              moderator:
                client.name,
              target:
                target.name,
              targetId:
                target.id,
              room:
                target.roomCode
            }
          );

          send(
            target.ws,
            {
              type:
                "kicked",
              message:
                "You were kicked from the room."
            }
          );

          removeFromRoom(
            target
          );

          // NO dashboard refresh.
          return;
        }

        // ====================================================
        // BAN
        // ====================================================

        if (
          data.type ===
          "ban"
        ) {

          if (
            !requireModerator(
              ws,
              client
            )
          ) {
            return;
          }

          const target =
            clients.get(
              data.targetId
            );

          if (!target) {

            send(ws, {
              type: "error",
              message:
                "User is no longer connected."
            });

            return;
          }

          if (
            !canControlTarget(
              client,
              target
            )
          ) {

            send(ws, {
              type: "error",
              message:
                "You cannot ban this user."
            });

            return;
          }

          const duration =
            calculateDuration(
              data
            );

          if (
            duration === 0
          ) {

            send(ws, {
              type: "error",
              message:
                "Enter a ban duration or choose Permanent."
            });

            return;
          }

          const banId =
            makeId("ban");

          const createdAt =
            Date.now();

          const expiresAt =
            duration === null
              ? null
              : createdAt +
                duration;

          const ban = {
            id:
              banId,
            userId:
              target.userId,
            name:
              target.name,
            moderatorId:
              client.id,
            moderatorName:
              client.name,
            createdAt,
            expiresAt,
            durationText:
              formatDuration(
                duration
              )
          };

          bannedUsers.set(
            banId,
            ban
          );

          addLog(
            "BAN",
            {
              moderator:
                client.name,
              target:
                target.name,
              targetId:
                target.id,
              duration:
                ban.durationText,
              room:
                target.roomCode
            }
          );

          send(
            target.ws,
            {
              type:
                "banned",
              message:
                "You were banned for " +
                ban.durationText +
                "."
            }
          );

          removeFromRoom(
            target
          );

          try {
            target.ws.close();
          } catch(e) {}

          // NO dashboard refresh.
          return;
        }

        // ====================================================
        // UNBAN
        // ====================================================

        if (
          data.type ===
          "unban"
        ) {

          if (
            !requireModerator(
              ws,
              client
            )
          ) {
            return;
          }

          const ban =
            bannedUsers.get(
              data.banId
            );

          if (!ban) {

            send(ws, {
              type: "error",
              message:
                "Ban not found."
            });

            return;
          }

          bannedUsers.delete(
            data.banId
          );

          addLog(
            "UNBAN",
            {
              moderator:
                client.name,
              target:
                ban.name
            }
          );

          // NO dashboard refresh.
          return;
        }

        // ====================================================
        // GIVE MODERATOR
        // ====================================================

        if (
          data.type ===
          "giveModerator"
        ) {

          if (
            !isMasterModerator(
              client
            )
          ) {

            send(ws, {
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

            send(ws, {
              type: "error",
              message:
                "User is no longer connected."
            });

            return;
          }

          if (
            target.role ===
            "moderator"
          ) {

            send(ws, {
              type: "error",
              message:
                "That user is already a moderator."
            });

            return;
          }

          const pin =
            cleanPin(
              data.pin
            );

          if (
            pin.length < 4
          ) {

            send(ws, {
              type: "error",
              message:
                "Moderator PIN must be at least 4 characters."
            });

            return;
          }

          const duration =
            calculateDuration(
              data
            );

          if (
            duration === 0
          ) {

            send(ws, {
              type: "error",
              message:
                "Enter a moderator access duration."
            });

            return;
          }

          const createdAt =
            Date.now();

          const expiresAt =
            duration === null
              ? null
              : createdAt +
                duration;

          const accessId =
            makeId("mod");

          const access = {
            id:
              accessId,
            pinHash:
              hashPin(pin),
            name:
              target.name,
            targetUserId:
              target.userId,
            createdBy:
              client.name,
            createdAt,
            expiresAt,
            durationText:
              formatDuration(
                duration
              )
          };

          moderatorAccess.set(
            accessId,
            access
          );

          addLog(
            "GIVE_MODERATOR",
            {
              moderator:
                client.name,
              target:
                target.name,
              duration:
                access.durationText
            }
          );

          send(ws, {
            type:
              "moderatorAccessCreated",
            name:
              target.name,
            pin,
            durationText:
              access.durationText
          });

          send(
            target.ws,
            {
              type:
                "moderatorAccessGranted",
              name:
                target.name,
              durationText:
                access.durationText
            }
          );

          // NO dashboard refresh.
          return;
        }

        // ====================================================
        // REVOKE MODERATOR
        // ====================================================

        if (
          data.type ===
          "revokeModerator"
        ) {

          if (
            !isMasterModerator(
              client
            )
          ) {

            send(ws, {
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

            send(ws, {
              type: "error",
              message:
                "Moderator access not found."
            });

            return;
          }

          moderatorAccess.delete(
            data.accessId
          );

          addLog(
            "REVOKE_MODERATOR",
            {
              moderator:
                client.name,
              target:
                access.name
            }
          );

          for (
            const other of clients.values()
          ) {

            if (
              other.role ===
                "moderator" &&
              other.moderatorAccessId ===
                data.accessId
            ) {

              send(
                other.ws,
                {
                  type:
                    "moderatorAccessRevoked"
                }
              );

            }

          }

          // NO dashboard refresh.
          return;
        }

        // ====================================================
        // MANUAL DASHBOARD REFRESH
        // ====================================================

        if (
          data.type ===
          "getModeratorData"
        ) {

          if (
            !requireModerator(
              ws,
              client
            )
          ) {
            return;
          }

          send(ws, {
            type:
              "moderatorData",
            rooms:
              getRoomList(),
            bans:
              getBanList(),
            moderatorAccess:
              getModeratorAccessList(),
            logs:
              getModeratorLog()
          });

          return;
        }

      }
    );

    ws.on(
      "close",
      () => {

        removeFromRoom(
          client
        );

        clients.delete(
          client.id
        );

      }
    );

  }
);

// ============================================================
// START
// ============================================================

// IMPORTANT:
// There is intentionally NO setInterval here.
//
// The moderator dashboard does not automatically refresh.
// Expiration cleanup happens when relevant requests occur.

server.listen(
  PORT,
  () => {

    console.log(
      "Video Chat server running on port " +
      PORT
    );

  }
);

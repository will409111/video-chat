const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// Master moderator PIN
const MASTER_PIN = "230323038227";

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Map();
const moderatorAccess = new Map();
const moderationLog = [];

function makeId(prefix = "") {
  return prefix + crypto.randomBytes(8).toString("hex");
}

function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}

function cleanName(value) {
  let name = String(value || "").trim();
  name = name.replace(/\s+/g, " ");
  if (!name) name = "Anonymous";
  return name.slice(0, 40);
}

function cleanRoomName(value) {
  let name = String(value || "").trim();
  name = name.replace(/\s+/g, " ");
  if (!name) name = "Room";
  return name.slice(0, 60);
}

function cleanRoomCode(value) {
  let code = String(value || "").trim().toUpperCase();
  code = code.replace(/[^A-Z0-9_-]/g, "");
  return code.slice(0, 20);
}

function cleanPin(value) {
  return String(value || "").trim().slice(0, 100);
}

function send(client, data) {
  if (
    client &&
    client.ws &&
    client.ws.readyState === WebSocket.OPEN
  ) {
    client.ws.send(JSON.stringify(data));
  }
}

function addLog(action, details) {
  moderationLog.unshift({
    id: makeId("log_"),
    action,
    details,
    time: Date.now()
  });

  if (moderationLog.length > 300) {
    moderationLog.length = 300;
  }
}

function formatDuration(ms) {
  if (ms == null) return "Permanent";

  let seconds = Math.floor(ms / 1000);

  const years = Math.floor(seconds / (365 * 24 * 60 * 60));
  seconds %= 365 * 24 * 60 * 60;

  const months = Math.floor(seconds / (30 * 24 * 60 * 60));
  seconds %= 30 * 24 * 60 * 60;

  const weeks = Math.floor(seconds / (7 * 24 * 60 * 60));
  seconds %= 7 * 24 * 60 * 60;

  const days = Math.floor(seconds / (24 * 60 * 60));
  seconds %= 24 * 60 * 60;

  const hours = Math.floor(seconds / (60 * 60));
  seconds %= 60 * 60;

  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts = [];

  if (years) parts.push(years + " year" + (years === 1 ? "" : "s"));
  if (months) parts.push(months + " month" + (months === 1 ? "" : "s"));
  if (weeks) parts.push(weeks + " week" + (weeks === 1 ? "" : "s"));
  if (days) parts.push(days + " day" + (days === 1 ? "" : "s"));
  if (hours) parts.push(hours + " hour" + (hours === 1 ? "" : "s"));
  if (minutes) parts.push(minutes + " minute" + (minutes === 1 ? "" : "s"));
  if (seconds) parts.push(seconds + " second" + (seconds === 1 ? "" : "s"));

  return parts.length ? parts.join(", ") : "0 seconds";
}

function calculateDuration(data) {
  if (data.permanent) {
    return {
      expiresAt: null,
      durationText: "Permanent"
    };
  }

  const seconds =
    Math.max(0, Number(data.seconds) || 0) +
    Math.max(0, Number(data.minutes) || 0) * 60 +
    Math.max(0, Number(data.hours) || 0) * 60 * 60 +
    Math.max(0, Number(data.days) || 0) * 24 * 60 * 60 +
    Math.max(0, Number(data.weeks) || 0) * 7 * 24 * 60 * 60 +
    Math.max(0, Number(data.months) || 0) * 30 * 24 * 60 * 60 +
    Math.max(0, Number(data.years) || 0) * 365 * 24 * 60 * 60;

  if (seconds <= 0) {
    return {
      expiresAt: Date.now(),
      durationText: "0 seconds"
    };
  }

  return {
    expiresAt: Date.now() + seconds * 1000,
    durationText: formatDuration(seconds * 1000)
  };
}

function cleanExpiredModeratorAccess() {
  const now = Date.now();

  for (const [id, access] of moderatorAccess) {
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

function cleanExpiredBans() {
  const now = Date.now();

  for (const [id, ban] of bannedUsers) {
    if (ban.expiresAt !== null && ban.expiresAt <= now) {
      bannedUsers.delete(id);
    }
  }
}

function getBan(userId) {
  cleanExpiredBans();

  for (const ban of bannedUsers.values()) {
    if (ban.userId === userId) {
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

function getRoomInfo(room) {
  const participants = [];

  for (const id of room.participants) {
    const client = clients.get(id);

    if (!client) continue;

    if (client.role === "user") {
      participants.push({
        id: client.id,
        userId: client.userId,
        name: client.name
      });
    }
  }

  return {
    code: room.code,
    name: room.name,
    participants,
    participantCount: participants.length,
    messages: room.messages.slice(-100)
  };
}

function getRoomList() {
  const list = [];

  for (const room of rooms.values()) {
    let userCount = 0;
    let moderatorCount = 0;

    for (const id of room.participants) {
      const client = clients.get(id);
      if (!client) continue;

      if (client.role === "user") {
        userCount++;
      } else {
        moderatorCount++;
      }
    }

    list.push({
      code: room.code,
      name: room.name,
      participantCount: userCount,
      moderatorCount
    });
  }

  return list;
}

function getBanList() {
  cleanExpiredBans();

  return Array.from(bannedUsers.values()).map((ban) => ({
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

  return Array.from(moderatorAccess.values()).map((access) => ({
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

function broadcastRoomList() {
  const data = {
    type: "moderatorData",
    rooms: getRoomList(),
    bans: getBanList(),
    moderatorAccess: getModeratorAccessList(),
    log: getModeratorLog()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client, data);
    }
  }
}

function broadcastRoom(room, data, options = {}) {
  const includeUsers = options.includeUsers !== false;
  const includeModerators = options.includeModerators !== false;

  for (const id of room.participants) {
    const client = clients.get(id);

    if (!client) continue;

    if (client.role === "user" && includeUsers) {
      send(client, data);
    }

    if (client.role === "moderator" && includeModerators) {
      send(client, data);
    }
  }
}

function createRoom(client, roomName, requestedCode) {
  const name = cleanRoomName(roomName);
  let code = cleanRoomCode(requestedCode);

  if (!code) {
    code = makeRoomCode();
  }

  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) {
    send(client, {
      type: "error",
      message: "Room code must be 3-20 letters, numbers, _ or -."
    });
    return null;
  }

  if (rooms.has(code)) {
    send(client, {
      type: "error",
      message: "That room code is already being used."
    });
    return null;
  }

  const room = {
    code,
    name,
    participants: new Set(),
    messages: []
  };

  rooms.set(code, room);

  addLog(
    "Room created",
    client.name + " created room " + name + " (" + code + ")"
  );

  return room;
}

function makeRoomCode() {
  let code;

  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));

  return code;
}

function removeFromRoom(client, reason = "left") {
  if (!client.roomCode) return;

  const room = rooms.get(client.roomCode);

  if (!room) {
    client.roomCode = null;
    return;
  }

  const oldRoomCode = room.code;

  room.participants.delete(client.id);
  client.roomCode = null;

  if (client.role === "user") {
    broadcastRoom(
      room,
      {
        type: "userLeft",
        id: client.id,
        reason
      },
      {
        includeUsers: true,
        includeModerators: true
      }
    );
  } else {
    // Moderators remain hidden from normal users.
    broadcastRoom(
      room,
      {
        type: "moderatorLeft",
        id: client.id
      },
      {
        includeUsers: false,
        includeModerators: true
      }
    );
  }

  if (room.participants.size === 0) {
    rooms.delete(oldRoomCode);
  }

  broadcastRoomList();
}

function joinRoom(client, roomCode, isModerator = false) {
  const code = cleanRoomCode(roomCode);
  const room = rooms.get(code);

  if (!room) {
    send(client, {
      type: "error",
      message: "Room not found."
    });
    return false;
  }

  if (client.roomCode) {
    removeFromRoom(client, "switching rooms");
  }

  room.participants.add(client.id);
  client.roomCode = room.code;

  const participantData = getRoomInfo(room);

  if (client.role === "user") {
    send(client, {
      type: "roomJoined",
      room: {
        code: room.code,
        name: room.name
      },
      participants: participantData.participants,
      messages: participantData.messages
    });

    // Tell the user about moderators already in the room.
    for (const id of room.participants) {
      const other = clients.get(id);

      if (
        other &&
        other.role === "moderator" &&
        other.id !== client.id
      ) {
        send(client, {
          type: "moderatorReady",
          id: other.id
        });
      }
    }

    // Tell existing normal users about the new normal user.
    broadcastRoom(
      room,
      {
        type: "userJoined",
        participant: {
          id: client.id,
          userId: client.userId,
          name: client.name
        }
      },
      {
        includeUsers: true,
        includeModerators: true
      }
    );
  } else {
    send(client, {
      type: "roomJoined",
      room: {
        code: room.code,
        name: room.name
      },
      participants: participantData.participants,
      messages: participantData.messages
    });

    // Notify existing moderators only.
    broadcastRoom(
      room,
      {
        type: "moderatorJoined",
        id: client.id
      },
      {
        includeUsers: false,
        includeModerators: true
      }
    );

    // Make every normal participant initiate a WebRTC connection
    // toward this receive-only moderator.
    for (const id of room.participants) {
      const other = clients.get(id);

      if (other && other.role === "user") {
        send(other, {
          type: "moderatorReady",
          id: client.id
        });
      }
    }
  }

  broadcastRoomList();

  return true;
}

function isMasterModerator(client) {
  return (
    client.role === "moderator" &&
    client.moderatorLevel === "master"
  );
}

function canModerate(client) {
  return client.role === "moderator";
}

function canControlTarget(moderator, target) {
  if (!target) return false;

  if (target.role === "moderator") {
    return false;
  }

  return true;
}

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
  width: min(900px, 94%);
  margin: 30px auto;
}

.card {
  background: #1d1d1d;
  border-radius: 18px;
  padding: 22px;
  margin-bottom: 20px;
}

h1, h2 {
  margin-top: 0;
}

input,
button {
  font-size: 16px;
  border-radius: 10px;
  padding: 12px;
}

input {
  width: 100%;
  border: 1px solid #555;
  background: #111;
  color: white;
  margin-bottom: 10px;
}

button {
  border: 0;
  cursor: pointer;
  margin: 4px;
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
  background: #444;
  color: white;
}

.hidden {
  display: none !important;
}

.error {
  color: #ff6b6b;
  margin-top: 10px;
}

.info {
  color: #aaa;
}

.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 12px;
}

.video-tile {
  background: #000;
  border-radius: 14px;
  overflow: hidden;
  min-height: 180px;
  position: relative;
}

.video-tile video {
  width: 100%;
  height: 100%;
  min-height: 180px;
  object-fit: cover;
  display: block;
}

.video-name {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0,0,0,.65);
  padding: 6px 9px;
  border-radius: 8px;
}

.chat {
  height: 260px;
  overflow-y: auto;
  background: #101010;
  padding: 12px;
  border-radius: 12px;
  margin-bottom: 10px;
}

.chat-message {
  margin-bottom: 8px;
}

.chat-name {
  font-weight: bold;
}

.chat-row {
  display: flex;
  gap: 8px;
}

.chat-row input {
  margin: 0;
  flex: 1;
}

.chat-row button {
  margin: 0;
}
</style>
</head>

<body>

<div class="container">

  <div id="home">

    <div class="card">
      <h1>Video Chat</h1>
      <p class="info">
        Create a temporary room or join one using a room name and code.
      </p>

      <input id="name" placeholder="Your Name">

      <input id="roomName" placeholder="Room Name">

      <input id="roomCode" placeholder="Room Code">

      <button class="primary" onclick="createRoom()">
        Create Room
      </button>

      <button class="secondary" onclick="joinRoom()">
        Join Room
      </button>

      <div id="homeError" class="error"></div>
    </div>

  </div>

  <div id="call" class="hidden">

    <div class="card">
      <h2 id="roomTitle">Room</h2>

      <p id="roomCodeDisplay" class="info"></p>

      <button class="danger" onclick="leaveRoom()">
        Leave Room
      </button>
    </div>

    <div class="card">
      <h2>People</h2>
      <div id="videoGrid" class="video-grid"></div>
    </div>

    <div class="card">
      <h2>Chat</h2>

      <div id="chat" class="chat"></div>

      <div class="chat-row">
        <input id="chatInput" placeholder="Type a message">
        <button class="primary" onclick="sendChat()">Send</button>
      </div>
    </div>

  </div>

</div>

<script>
let ws = null;
let myId = null;
let myName = "";
let currentRoom = null;
let localStream = null;

const peers = new Map();
const participants = new Map();

function connect() {
  return new Promise(function(resolve, reject) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";

    ws = new WebSocket(
      protocol + "//" + location.host + "/ws"
    );

    ws.onopen = function() {
      resolve();
    };

    ws.onerror = function() {
      reject(new Error("WebSocket connection failed."));
    };

    ws.onmessage = async function(event) {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      await handleMessage(data);
    };

    ws.onclose = function() {
      if (currentRoom) {
        showError("Connection closed.");
      }
    };
  });
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function prepareMedia() {
  if (localStream) return true;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    const videoGrid = document.getElementById("videoGrid");

    let tile = document.getElementById("localTile");

    if (!tile) {
      tile = document.createElement("div");
      tile.className = "video-tile";
      tile.id = "localTile";

      const video = document.createElement("video");
      video.id = "localVideo";
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;

      const label = document.createElement("div");
      label.className = "video-name";
      label.textContent = myName + " (You)";

      tile.appendChild(video);
      tile.appendChild(label);

      videoGrid.appendChild(tile);
    }

    document.getElementById("localVideo").srcObject = localStream;

    return true;
  } catch (err) {
    showError(
      "Camera/microphone permission is required to join a call."
    );

    return false;
  }
}

async function createRoom() {
  clearError();

  myName = document.getElementById("name").value.trim();
  const roomName =
    document.getElementById("roomName").value.trim();
  const roomCode =
    document.getElementById("roomCode").value.trim();

  if (!myName) {
    showError("Enter your name.");
    return;
  }

  if (!roomName) {
    showError("Enter a room name.");
    return;
  }

  if (!roomCode) {
    showError("Enter a room code.");
    return;
  }

  const ready = await prepareMedia();

  if (!ready) return;

  await connect();

  send({
    type: "register",
    name: myName
  });

  send({
    type: "createRoom",
    roomName: roomName,
    roomCode: roomCode
  });
}

async function joinRoom() {
  clearError();

  myName = document.getElementById("name").value.trim();
  const roomCode =
    document.getElementById("roomCode").value.trim();

  if (!myName) {
    showError("Enter your name.");
    return;
  }

  if (!roomCode) {
    showError("Enter a room code.");
    return;
  }

  const ready = await prepareMedia();

  if (!ready) return;

  await connect();

  send({
    type: "register",
    name: myName
  });

  send({
    type: "joinRoom",
    roomCode: roomCode
  });
}

async function handleMessage(data) {
  if (data.type === "registered") {
    myId = data.id;
    return;
  }

  if (data.type === "roomCreated") {
    currentRoom = {
      code: data.roomCode,
      name: data.roomName
    };

    showCall();
    return;
  }

  if (data.type === "roomJoined") {
    currentRoom = data.room;

    participants.clear();

    for (const participant of data.participants || []) {
      participants.set(participant.id, participant);
    }

    showCall();
    renderParticipants();

    clearChat();

    for (const message of data.messages || []) {
      addChatMessage(message);
    }

    // Only one side creates a normal user-to-user offer.
    for (const participant of data.participants || []) {
      if (
        participant.id !== myId &&
        myId &&
        myId < participant.id
      ) {
        await makeOffer(participant.id);
      }
    }

    return;
  }

  if (data.type === "userJoined") {
    if (!data.participant) return;

    participants.set(
      data.participant.id,
      data.participant
    );

    renderParticipants();

    if (
      data.participant.id !== myId &&
      myId &&
      myId < data.participant.id
    ) {
      await makeOffer(data.participant.id);
    }

    return;
  }

  if (data.type === "userLeft") {
    participants.delete(data.id);
    removePeer(data.id);
    renderParticipants();
    return;
  }

  if (data.type === "moderatorReady") {
    // Moderators are invisible in the participant list,
    // but normal users create a WebRTC offer to them.
    await makeOffer(data.id);
    return;
  }

  if (data.type === "signal") {
    await handleSignal(data);
    return;
  }

  if (data.type === "chatMessage") {
    addChatMessage(data.message);
    return;
  }

  if (data.type === "kicked") {
    alert("You were kicked from the room.");
    cleanupCall();
    return;
  }

  if (data.type === "banned") {
    alert(
      "You were banned from the room." +
      (data.durationText
        ? " Duration: " + data.durationText
        : "")
    );

    cleanupCall();
    return;
  }

  if (data.type === "error") {
    showError(data.message || "Something went wrong.");
  }
}

function showCall() {
  document.getElementById("home").classList.add("hidden");
  document.getElementById("call").classList.remove("hidden");

  document.getElementById("roomTitle").textContent =
    currentRoom.name;

  document.getElementById("roomCodeDisplay").textContent =
    "Room Code: " + currentRoom.code;
}

function getPeer(remoteId) {
  if (peers.has(remoteId)) {
    return peers.get(remoteId);
  }

  const pc = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302"
      }
    ]
  });

  const peer = {
    pc: pc,
    remoteStream: new MediaStream(),
    iceQueue: []
  };

  peers.set(remoteId, peer);

  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  pc.onicecandidate = function(event) {
    if (event.candidate) {
      send({
        type: "signal",
        to: remoteId,
        signalType: "ice",
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = function(event) {
    const stream = event.streams && event.streams[0];

    if (stream) {
      peer.remoteStream = stream;
    } else {
      peer.remoteStream.addTrack(event.track);
    }

    const participant = participants.get(remoteId);

    // Hidden moderators don't have a participant entry.
    // Their video/audio still gets rendered.
    const name = participant
      ? participant.name
      : "Moderator";

    renderRemoteVideo(
      remoteId,
      peer.remoteStream,
      name
    );
  };

  pc.onconnectionstatechange = function() {
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed"
    ) {
      removePeer(remoteId);
    }
  };

  return peer;
}

async function makeOffer(remoteId) {
  const peer = getPeer(remoteId);

  if (peer.pc.signalingState !== "stable") {
    return;
  }

  try {
    const offer = await peer.pc.createOffer();

    await peer.pc.setLocalDescription(offer);

    send({
      type: "signal",
      to: remoteId,
      signalType: "offer",
      description: peer.pc.localDescription
    });
  } catch (err) {
    console.error("Offer error:", err);
  }
}

async function handleSignal(data) {
  if (!data.from) return;

  const peer = getPeer(data.from);
  const pc = peer.pc;

  try {
    if (data.signalType === "offer") {
      await pc.setRemoteDescription(
        new RTCSessionDescription(data.description)
      );

      while (peer.iceQueue.length) {
        const candidate = peer.iceQueue.shift();

        try {
          await pc.addIceCandidate(candidate);
        } catch {}
      }

      const answer = await pc.createAnswer();

      await pc.setLocalDescription(answer);

      send({
        type: "signal",
        to: data.from,
        signalType: "answer",
        description: pc.localDescription
      });

      return;
    }

    if (data.signalType === "answer") {
      await pc.setRemoteDescription(
        new RTCSessionDescription(data.description)
      );

      while (peer.iceQueue.length) {
        const candidate = peer.iceQueue.shift();

        try {
          await pc.addIceCandidate(candidate);
        } catch {}
      }

      return;
    }

    if (data.signalType === "ice") {
      const candidate =
        new RTCIceCandidate(data.candidate);

      if (pc.remoteDescription) {
        await pc.addIceCandidate(candidate);
      } else {
        peer.iceQueue.push(candidate);
      }
    }
  } catch (err) {
    console.error("Signal error:", err);
  }
}

function renderParticipants() {
  const grid = document.getElementById("videoGrid");

  if (!grid) return;

  // Keep exactly one local tile.
  const localTile =
    document.getElementById("localTile");

  grid.innerHTML = "";

  if (localTile) {
    grid.appendChild(localTile);
  }

  for (const participant of participants.values()) {
    if (participant.id === myId) continue;

    renderRemotePlaceholder(
      participant.id,
      participant.name
    );
  }

  // Reattach already received remote streams.
  for (const [id, peer] of peers) {
    if (peer.remoteStream) {
      const participant = participants.get(id);

      const name = participant
        ? participant.name
        : "Moderator";

      renderRemoteVideo(
        id,
        peer.remoteStream,
        name
      );
    }
  }
}

function renderRemotePlaceholder(id, name) {
  const grid = document.getElementById("videoGrid");

  if (document.getElementById("tile-" + id)) {
    return;
  }

  const tile = document.createElement("div");
  tile.className = "video-tile";
  tile.id = "tile-" + id;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  const label = document.createElement("div");
  label.className = "video-name";
  label.textContent = name;

  tile.appendChild(video);
  tile.appendChild(label);

  grid.appendChild(tile);
}

function renderRemoteVideo(id, stream, name) {
  const grid = document.getElementById("videoGrid");

  let tile = document.getElementById("tile-" + id);

  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-tile";
    tile.id = "tile-" + id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;

    const label = document.createElement("div");
    label.className = "video-name";

    tile.appendChild(video);
    tile.appendChild(label);

    grid.appendChild(tile);
  }

  const video = tile.querySelector("video");
  const label = tile.querySelector(".video-name");

  video.srcObject = stream;
  video.muted = false;

  label.textContent = name;

  video.play().catch(function() {});
}

function removePeer(id) {
  const peer = peers.get(id);

  if (peer) {
    try {
      peer.pc.close();
    } catch {}
  }

  peers.delete(id);

  const tile = document.getElementById("tile-" + id);

  if (tile) {
    tile.remove();
  }
}

function sendChat() {
  const input =
    document.getElementById("chatInput");

  const text = input.value.trim();

  if (!text || !currentRoom) return;

  send({
    type: "chatMessage",
    text: text
  });

  input.value = "";
}

function clearChat() {
  document.getElementById("chat").innerHTML = "";
}

function addChatMessage(message) {
  const chat = document.getElementById("chat");

  const row = document.createElement("div");
  row.className = "chat-message";

  const name = document.createElement("span");
  name.className = "chat-name";
  name.textContent = message.name + ": ";

  const text = document.createElement("span");
  text.textContent = message.text;

  row.appendChild(name);
  row.appendChild(text);

  chat.appendChild(row);

  chat.scrollTop = chat.scrollHeight;
}

function leaveRoom() {
  send({
    type: "leaveRoom"
  });

  cleanupCall();
}

function cleanupCall() {
  for (const peer of peers.values()) {
    try {
      peer.pc.close();
    } catch {}
  }

  peers.clear();
  participants.clear();

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }

    localStream = null;
  }

  currentRoom = null;

  document.getElementById("videoGrid").innerHTML = "";
  document.getElementById("chat").innerHTML = "";

  document.getElementById("call").classList.add("hidden");
  document.getElementById("home").classList.remove("hidden");
}

function showError(message) {
  document.getElementById("homeError").textContent = message;
}

function clearError() {
  document.getElementById("homeError").textContent = "";
}

document.getElementById("chatInput").addEventListener(
  "keydown",
  function(event) {
    if (event.key === "Enter") {
      sendChat();
    }
  }
);
</script>

</body>
</html>`;

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
  font-family: Arial, sans-serif;
  background: #0e0e0e;
  color: white;
}

.container {
  width: min(1200px, 95%);
  margin: 25px auto;
}

.card {
  background: #1c1c1c;
  padding: 20px;
  border-radius: 16px;
  margin-bottom: 18px;
}

input,
button {
  font-size: 15px;
  border-radius: 9px;
  padding: 10px;
}

input {
  background: #111;
  color: white;
  border: 1px solid #555;
}

button {
  border: 0;
  cursor: pointer;
  margin: 3px;
}

.primary {
  background: #4f8cff;
  color: white;
}

.secondary {
  background: #444;
  color: white;
}

.danger {
  background: #e5484d;
  color: white;
}

.success {
  background: #30a46c;
  color: white;
}

.hidden {
  display: none !important;
}

.error {
  color: #ff7070;
  margin-top: 10px;
}

.room {
  border: 1px solid #444;
  border-radius: 14px;
  padding: 15px;
  margin-bottom: 12px;
}

.room-title {
  font-size: 19px;
  font-weight: bold;
}

.people {
  background: #111;
  border-radius: 12px;
  padding: 12px;
  margin-top: 12px;
}

.person {
  border: 1px solid #444;
  border-radius: 10px;
  padding: 10px;
  margin: 8px 0;
}

.person-name {
  font-weight: bold;
  margin-bottom: 6px;
}

.ban-controls {
  margin-top: 10px;
  padding: 10px;
  background: #222;
  border-radius: 10px;
}

.duration-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 6px;
  margin: 8px 0;
}

.duration-grid input {
  width: 100%;
}

.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
}

.video-tile {
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
}

.video-tile video {
  width: 100%;
  min-height: 180px;
  object-fit: cover;
  display: block;
}

.video-name {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0,0,0,.7);
  padding: 5px 8px;
  border-radius: 7px;
}

.chat {
  background: #101010;
  border-radius: 10px;
  height: 240px;
  overflow-y: auto;
  padding: 10px;
  margin-bottom: 10px;
}

.chat-message {
  margin-bottom: 7px;
}

.chat-name {
  font-weight: bold;
}

.chat-row {
  display: flex;
  gap: 8px;
}

.chat-row input {
  flex: 1;
}

table {
  width: 100%;
  border-collapse: collapse;
}

td,
th {
  border-bottom: 1px solid #444;
  padding: 8px;
  text-align: left;
}

.small {
  color: #999;
  font-size: 13px;
}

.inline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.inline-form input {
  flex: 1;
  min-width: 150px;
}
</style>
</head>

<body>

<div class="container">

  <div id="login" class="card">
    <h1>Moderator Dashboard</h1>

    <input
      id="moderatorName"
      placeholder="Moderator Name"
    >

    <br><br>

    <input
      id="pin"
      type="password"
      placeholder="Moderator PIN"
    >

    <br><br>

    <button class="primary" onclick="login()">
      Enter
    </button>

    <div id="loginError" class="error"></div>
  </div>

  <div id="dashboard" class="hidden">

    <div class="card">
      <h1>Moderator Dashboard</h1>

      <div>
        Logged in as:
        <strong id="loggedInName"></strong>
      </div>

      <p class="small">
        Master moderators can give other connected users moderator access.
      </p>

      <button class="secondary" onclick="refreshData()">
        Refresh
      </button>

      <button class="danger" onclick="logout()">
        Logout
      </button>
    </div>

    <div class="card">
      <h2>Create Room</h2>

      <div class="inline-form">
        <input id="newRoomName" placeholder="Room Name">
        <input id="newRoomCode" placeholder="Room Code">
        <button class="primary" onclick="createModeratorRoom()">
          Create
        </button>
      </div>
    </div>

    <div class="card">
      <h2>Open Calls</h2>

      <div id="rooms"></div>
    </div>

    <div class="card">
      <h2>Current Room</h2>

      <div id="currentRoomInfo">
        No room selected.
      </div>

      <div id="moderatorVideoGrid" class="video-grid"></div>

      <h3>Room Chat</h3>

      <div id="moderatorChat" class="chat"></div>

      <div class="chat-row">
        <input
          id="moderatorChatInput"
          placeholder="Message the room as a moderator"
        >

        <button class="primary" onclick="sendModeratorChat()">
          Send
        </button>
      </div>

      <button
        id="leaveModeratorRoomButton"
        class="danger hidden"
        onclick="leaveModeratorRoom()"
      >
        Leave Room
      </button>
    </div>

    <div class="card">
      <h2>Bans</h2>
      <div id="bans"></div>
    </div>

    <div class="card">
      <h2>Moderator Access</h2>
      <div id="moderatorAccess"></div>
    </div>

    <div class="card">
      <h2>Moderation History</h2>
      <div id="log"></div>
    </div>

  </div>

</div>

<script>
let ws = null;
let myId = null;
let moderatorName = "";
let moderatorLevel = "";
let currentRoom = null;

const peers = new Map();

let openPeopleRooms = new Set();

function connect() {
  return new Promise(function(resolve, reject) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const protocol =
      location.protocol === "https:" ? "wss:" : "ws:";

    ws = new WebSocket(
      protocol + "//" + location.host + "/ws"
    );

    ws.onopen = function() {
      resolve();
    };

    ws.onerror = function() {
      reject(new Error("WebSocket connection failed."));
    };

    ws.onmessage = async function(event) {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      await handleMessage(data);
    };
  });
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function login() {
  document.getElementById("loginError").textContent = "";

  moderatorName =
    document.getElementById("moderatorName").value.trim();

  const pin =
    document.getElementById("pin").value.trim();

  if (!moderatorName) {
    document.getElementById("loginError").textContent =
      "Enter your moderator name.";
    return;
  }

  if (!pin) {
    document.getElementById("loginError").textContent =
      "Enter the moderator PIN.";
    return;
  }

  try {
    await connect();

    send({
      type: "moderatorAuth",
      name: moderatorName,
      pin: pin
    });
  } catch (err) {
    document.getElementById("loginError").textContent =
      err.message;
  }
}

async function handleMessage(data) {
  if (data.type === "moderatorAuthSuccess") {
    myId = data.id;
    moderatorName = data.name;
    moderatorLevel = data.level;

    document.getElementById("login").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");

    document.getElementById("loggedInName").textContent =
      moderatorName +
      " (" +
      moderatorLevel +
      ")";

    renderAll(
      data.rooms || [],
      data.bans || [],
      data.moderatorAccess || [],
      data.log || []
    );

    return;
  }

  if (data.type === "moderatorData") {
    renderAll(
      data.rooms || [],
      data.bans || [],
      data.moderatorAccess || [],
      data.log || []
    );

    return;
  }

  if (data.type === "roomJoined") {
    currentRoom = data.room;

    document.getElementById(
      "currentRoomInfo"
    ).textContent =
      currentRoom.name +
      " — " +
      currentRoom.code;

    document
      .getElementById("leaveModeratorRoomButton")
      .classList.remove("hidden");

    clearModeratorChat();

    for (const message of data.messages || []) {
      addModeratorChatMessage(message);
    }

    for (const participant of data.participants || []) {
      // Moderator only receives media from users.
      // It does not publish its own media.
      ensurePeer(participant.id);

      send({
        type: "requestOffer",
        to: participant.id
      });
    }

    return;
  }

  if (data.type === "userJoined") {
    if (currentRoom) {
      ensurePeer(data.participant.id);

      send({
        type: "requestOffer",
        to: data.participant.id
      });
    }

    return;
  }

  if (data.type === "userLeft") {
    removePeer(data.id);
    return;
  }

  if (data.type === "signal") {
    await handleSignal(data);
    return;
  }

  if (data.type === "chatMessage") {
    addModeratorChatMessage(data.message);
    return;
  }

  if (data.type === "kicked") {
    alert("User kicked.");
    return;
  }

  if (data.type === "banned") {
    alert("User banned.");
    return;
  }

  if (data.type === "moderatorAccessCreated") {
    alert(
      "Moderator access created.\\n\\n" +
      "PIN: " +
      data.pin +
      "\\nDuration: " +
      data.durationText
    );

    refreshData();
    return;
  }

  if (data.type === "error") {
    alert(data.message || "Something went wrong.");
  }
}

function renderAll(rooms, bans, access, log) {
  renderRooms(rooms);
  renderBans(bans);
  renderModeratorAccess(access);
  renderLog(log);
}

function renderRooms(rooms) {
  const box = document.getElementById("rooms");

  // Keep any currently open View People panels.
  box.querySelectorAll(
    ".people[data-room-code]"
  ).forEach(function(panel) {
    openPeopleRooms.add(
      panel.dataset.roomCode
    );
  });

  const existingCodes = new Set(
    rooms.map(function(room) {
      return room.code;
    })
  );

  for (const code of Array.from(openPeopleRooms)) {
    if (!existingCodes.has(code)) {
      openPeopleRooms.delete(code);
    }
  }

  box.innerHTML = "";

  if (!rooms.length) {
    box.textContent = "No open rooms.";
    return;
  }

  for (const room of rooms) {
    const div = document.createElement("div");
    div.className = "room";

    const title = document.createElement("div");
    title.className = "room-title";
    title.textContent =
      room.name + " (" + room.code + ")";

    const info = document.createElement("div");
    info.className = "small";
    info.textContent =
      room.participantCount +
      " participant(s)";

    div.appendChild(title);
    div.appendChild(info);

    const viewButton = document.createElement("button");
    viewButton.className = "secondary";
    viewButton.textContent = "View People";

    viewButton.onclick = function() {
      togglePeople(room, div);
    };

    div.appendChild(viewButton);

    const joinButton = document.createElement("button");
    joinButton.className = "primary";
    joinButton.textContent = "Join";

    joinButton.onclick = function() {
      joinModeratorRoom(
        room.code,
        false
      );
    };

    div.appendChild(joinButton);

    const anonymousButton =
      document.createElement("button");

    anonymousButton.className = "secondary";
    anonymousButton.textContent =
      "Join Anonymous";

    anonymousButton.onclick = function() {
      joinModeratorRoom(
        room.code,
        true
      );
    };

    div.appendChild(anonymousButton);

    if (openPeopleRooms.has(room.code)) {
      showPeople(
        room,
        div,
        false
      );
    }

    box.appendChild(div);
  }
}

function togglePeople(room, parent) {
  const existing =
    parent.querySelector(
      ".people[data-room-code='" +
      CSS.escape(room.code) +
      "']"
    );

  if (existing) {
    existing.remove();
    openPeopleRooms.delete(room.code);
    return;
  }

  openPeopleRooms.add(room.code);

  showPeople(
    room,
    parent,
    false
  );
}

function showPeople(room, parent, markOpen) {
  if (markOpen !== false) {
    openPeopleRooms.add(room.code);
  }

  const existing =
    parent.querySelector(
      ".people[data-room-code='" +
      CSS.escape(room.code) +
      "']"
    );

  if (existing) {
    existing.remove();
  }

  const people =
    document.createElement("div");

  people.className = "people";
  people.dataset.roomCode = room.code;

  if (!room.participantCount) {
    people.textContent = "No participants.";
  }

  // The room list only has counts.
  // Ask the server for the current people.
  const loading =
    document.createElement("div");

  loading.textContent =
    "Loading people...";

  people.appendChild(loading);

  parent.appendChild(people);

  send({
    type: "getRoomPeople",
    roomCode: room.code
  });
}

function renderPeople(roomCode, peopleList) {
  const panel =
    document.querySelector(
      ".people[data-room-code='" +
      CSS.escape(roomCode) +
      "']"
    );

  if (!panel) return;

  panel.innerHTML = "";

  if (!peopleList.length) {
    panel.textContent = "No participants.";
    return;
  }

  for (const person of peopleList) {
    const row =
      document.createElement("div");

    row.className = "person";

    const name =
      document.createElement("div");

    name.className = "person-name";
    name.textContent = person.name;

    row.appendChild(name);

    const kick =
      document.createElement("button");

    kick.className = "danger";
    kick.textContent = "Kick";

    kick.onclick = function() {
      // Intentionally NO confirmation.
      send({
        type: "kick",
        targetId: person.id
      });
    };

    row.appendChild(kick);

    const ban =
      document.createElement("button");

    ban.className = "danger";
    ban.textContent = "Ban";

    const controls =
      document.createElement("div");

    controls.className =
      "ban-controls hidden";

    controls.innerHTML =
      '<div>Ban Duration</div>' +
      '<div class="duration-grid">' +
      '<input type="number" min="0" class="ban-seconds" placeholder="Seconds">' +
      '<input type="number" min="0" class="ban-minutes" placeholder="Minutes">' +
      '<input type="number" min="0" class="ban-hours" placeholder="Hours">' +
      '<input type="number" min="0" class="ban-days" placeholder="Days">' +
      '<input type="number" min="0" class="ban-weeks" placeholder="Weeks">' +
      '<input type="number" min="0" class="ban-months" placeholder="Months">' +
      '<input type="number" min="0" class="ban-years" placeholder="Years">' +
      '</div>' +
      '<label>' +
      '<input type="checkbox" class="ban-permanent">' +
      ' Permanent' +
      '</label><br>' +
      '<button class="danger ban-submit">Ban User</button>';

    ban.onclick = function() {
      controls.classList.toggle("hidden");
    };

    row.appendChild(ban);
    row.appendChild(controls);

    controls
      .querySelector(".ban-submit")
      .onclick = function() {
        send({
          type: "ban",
          targetId: person.id,
          seconds:
            controls.querySelector(
              ".ban-seconds"
            ).value,
          minutes:
            controls.querySelector(
              ".ban-minutes"
            ).value,
          hours:
            controls.querySelector(
              ".ban-hours"
            ).value,
          days:
            controls.querySelector(
              ".ban-days"
            ).value,
          weeks:
            controls.querySelector(
              ".ban-weeks"
            ).value,
          months:
            controls.querySelector(
              ".ban-months"
            ).value,
          years:
            controls.querySelector(
              ".ban-years"
            ).value,
          permanent:
            controls.querySelector(
              ".ban-permanent"
            ).checked
        });

        controls.classList.add("hidden");
      };

    // Master-only Give Moderator.
    if (moderatorLevel === "master") {
      const give =
        document.createElement("button");

      give.className = "success";
      give.textContent = "Give Moderator";

      give.onclick = function() {
        giveModerator(person.id, person.name);
      };

      row.appendChild(give);
    }

    panel.appendChild(row);
  }
}

function giveModerator(targetId, targetName) {
  const pin = prompt(
    "Create a moderator PIN for " +
    targetName +
    ":"
  );

  if (pin === null) return;

  if (pin.trim().length < 4) {
    alert("PIN must be at least 4 characters.");
    return;
  }

  const duration =
    prompt(
      "Enter duration in this format:\\n" +
      "seconds,minutes,hours,days,weeks,months,years\\n\\n" +
      "Example: 0,0,2,0,0,0,0 = 2 hours\\n" +
      "Use PERMANENT for permanent access."
    );

  if (duration === null) return;

  if (
    duration.trim().toUpperCase() ===
    "PERMANENT"
  ) {
    send({
      type: "giveModerator",
      targetId: targetId,
      pin: pin,
      permanent: true
    });

    return;
  }

  const parts =
    duration.split(",").map(function(x) {
      return Number(x.trim()) || 0;
    });

  while (parts.length < 7) {
    parts.push(0);
  }

  send({
    type: "giveModerator",
    targetId: targetId,
    pin: pin,
    seconds: parts[0],
    minutes: parts[1],
    hours: parts[2],
    days: parts[3],
    weeks: parts[4],
    months: parts[5],
    years: parts[6],
    permanent: false
  });
}

function renderBans(bans) {
  const box =
    document.getElementById("bans");

  box.innerHTML = "";

  if (!bans.length) {
    box.textContent = "No active bans.";
    return;
  }

  const table =
    document.createElement("table");

  table.innerHTML =
    "<tr>" +
    "<th>Name</th>" +
    "<th>Duration</th>" +
    "<th>Moderator</th>" +
    "<th>Action</th>" +
    "</tr>";

  for (const ban of bans) {
    const row =
      document.createElement("tr");

    row.innerHTML =
      "<td>" +
      escapeHtml(ban.name) +
      "</td>" +
      "<td>" +
      escapeHtml(ban.durationText) +
      "</td>" +
      "<td>" +
      escapeHtml(ban.moderatorName) +
      "</td>" +
      "<td></td>";

    const button =
      document.createElement("button");

    button.className = "success";
    button.textContent = "Unban";

    button.onclick = function() {
      send({
        type: "unban",
        banId: ban.id
      });
    };

    row.lastElementChild.appendChild(button);

    table.appendChild(row);
  }

  box.appendChild(table);
}

function renderModeratorAccess(access) {
  const box =
    document.getElementById(
      "moderatorAccess"
    );

  box.innerHTML = "";

  if (!access.length) {
    box.textContent =
      "No delegated moderator access.";
    return;
  }

  const table =
    document.createElement("table");

  table.innerHTML =
    "<tr>" +
    "<th>Name</th>" +
    "<th>Created By</th>" +
    "<th>Duration</th>" +
    "<th>Action</th>" +
    "</tr>";

  for (const item of access) {
    const row =
      document.createElement("tr");

    row.innerHTML =
      "<td>" +
      escapeHtml(item.name) +
      "</td>" +
      "<td>" +
      escapeHtml(item.createdBy) +
      "</td>" +
      "<td>" +
      escapeHtml(item.durationText) +
      "</td>" +
      "<td></td>";

    if (moderatorLevel === "master") {
      const button =
        document.createElement("button");

      button.className = "danger";
      button.textContent = "Revoke";

      button.onclick = function() {
        send({
          type: "revokeModerator",
          accessId: item.id
        });
      };

      row.lastElementChild.appendChild(button);
    }

    table.appendChild(row);
  }

  box.appendChild(table);
}

function renderLog(log) {
  const box =
    document.getElementById("log");

  box.innerHTML = "";

  if (!log.length) {
    box.textContent = "No moderation history.";
    return;
  }

  for (const item of log) {
    const div =
      document.createElement("div");

    div.className = "person";

    div.innerHTML =
      "<strong>" +
      escapeHtml(item.action) +
      "</strong><br>" +
      escapeHtml(item.details) +
      "<br><span class='small'>" +
      new Date(item.time).toLocaleString() +
      "</span>";

    box.appendChild(div);
  }
}

function escapeHtml(value) {
  const div =
    document.createElement("div");

  div.textContent =
    String(value == null ? "" : value);

  return div.innerHTML;
}

function joinModeratorRoom(
  roomCode,
  anonymous
) {
  send({
    type: "moderatorJoinRoom",
    roomCode: roomCode,
    anonymous: anonymous
  });
}

function leaveModeratorRoom() {
  send({
    type: "leaveRoom"
  });

  currentRoom = null;

  for (const peer of peers.values()) {
    try {
      peer.pc.close();
    } catch {}
  }

  peers.clear();

  document.getElementById(
    "moderatorVideoGrid"
  ).innerHTML = "";

  document.getElementById(
    "moderatorChat"
  ).innerHTML = "";

  document.getElementById(
    "currentRoomInfo"
  ).textContent =
    "No room selected.";

  document
    .getElementById(
      "leaveModeratorRoomButton"
    )
    .classList.add("hidden");
}

function ensurePeer(remoteId) {
  if (peers.has(remoteId)) {
    return peers.get(remoteId);
  }

  const pc =
    new RTCPeerConnection({
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302"
        }
      ]
    });

  // Moderator is RECEIVE-ONLY.
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

  const peer = {
    pc: pc,
    remoteStream: new MediaStream(),
    iceQueue: []
  };

  peers.set(remoteId, peer);

  pc.onicecandidate = function(event) {
    if (event.candidate) {
      send({
        type: "signal",
        to: remoteId,
        signalType: "ice",
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = function(event) {
    if (event.streams && event.streams[0]) {
      peer.remoteStream =
        event.streams[0];
    } else {
      peer.remoteStream.addTrack(
        event.track
      );
    }

    renderModeratorVideo(
      remoteId,
      peer.remoteStream
    );
  };

  pc.onconnectionstatechange =
    function() {
      if (
        pc.connectionState ===
          "failed" ||
        pc.connectionState ===
          "closed"
      ) {
        removePeer(remoteId);
      }
    };

  return peer;
}

async function handleSignal(data) {
  if (!data.from) return;

  const peer =
    ensurePeer(data.from);

  const pc = peer.pc;

  try {
    if (data.signalType === "offer") {
      await pc.setRemoteDescription(
        new RTCSessionDescription(
          data.description
        )
      );

      while (peer.iceQueue.length) {
        const candidate =
          peer.iceQueue.shift();

        try {
          await pc.addIceCandidate(
            candidate
          );
        } catch {}
      }

      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(
        answer
      );

      send({
        type: "signal",
        to: data.from,
        signalType: "answer",
        description:
          pc.localDescription
      });

      return;
    }

    if (data.signalType === "answer") {
      await pc.setRemoteDescription(
        new RTCSessionDescription(
          data.description
        )
      );

      while (peer.iceQueue.length) {
        const candidate =
          peer.iceQueue.shift();

        try {
          await pc.addIceCandidate(
            candidate
          );
        } catch {}
      }

      return;
    }

    if (data.signalType === "ice") {
      const candidate =
        new RTCIceCandidate(
          data.candidate
        );

      if (pc.remoteDescription) {
        await pc.addIceCandidate(
          candidate
        );
      } else {
        peer.iceQueue.push(candidate);
      }
    }
  } catch (err) {
    console.error(
      "Moderator signal error:",
      err
    );
  }
}

function renderModeratorVideo(
  id,
  stream
) {
  const grid =
    document.getElementById(
      "moderatorVideoGrid"
    );

  let tile =
    document.getElementById(
      "moderator-tile-" + id
    );

  if (!tile) {
    tile =
      document.createElement("div");

    tile.className =
      "video-tile";

    tile.id =
      "moderator-tile-" + id;

    const video =
      document.createElement("video");

    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;

    const label =
      document.createElement("div");

    label.className =
      "video-name";

    label.textContent =
      "Participant";

    tile.appendChild(video);
    tile.appendChild(label);

    grid.appendChild(tile);
  }

  const video =
    tile.querySelector("video");

  video.srcObject = stream;

  video.play().catch(function() {});
}

function removePeer(id) {
  const peer = peers.get(id);

  if (peer) {
    try {
      peer.pc.close();
    } catch {}
  }

  peers.delete(id);

  const tile =
    document.getElementById(
      "moderator-tile-" + id
    );

  if (tile) {
    tile.remove();
  }
}

function sendModeratorChat() {
  const input =
    document.getElementById(
      "moderatorChatInput"
    );

  const text =
    input.value.trim();

  if (!text || !currentRoom) {
    return;
  }

  send({
    type: "chatMessage",
    text: text
  });

  input.value = "";
}

function clearModeratorChat() {
  document.getElementById(
    "moderatorChat"
  ).innerHTML = "";
}

function addModeratorChatMessage(
  message
) {
  const chat =
    document.getElementById(
      "moderatorChat"
    );

  const row =
    document.createElement("div");

  row.className =
    "chat-message";

  const name =
    document.createElement("span");

  name.className =
    "chat-name";

  name.textContent =
    message.name + ": ";

  const text =
    document.createElement("span");

  text.textContent =
    message.text;

  row.appendChild(name);
  row.appendChild(text);

  chat.appendChild(row);

  chat.scrollTop =
    chat.scrollHeight;
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

  if (!roomName || !roomCode) {
    alert(
      "Enter a room name and room code."
    );

    return;
  }

  send({
    type: "moderatorCreateRoom",
    roomName: roomName,
    roomCode: roomCode
  });
}

function refreshData() {
  send({
    type: "getModeratorData"
  });
}

function logout() {
  if (ws) {
    ws.close();
  }

  location.reload();
}

document
  .getElementById(
    "moderatorChatInput"
  )
  .addEventListener(
    "keydown",
    function(event) {
      if (event.key === "Enter") {
        sendModeratorChat();
      }
    }
  );

setInterval(function() {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    refreshData();
  }
}, 5000);
</script>

</body>
</html>`;

const server = http.createServer(
  function(req, res) {
    if (
      req.url === "/" ||
      req.url === "/index.html"
    ) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      res.end(INDEX_HTML);
      return;
    }

    if (
      req.url === "/blueberry" ||
      req.url === "/blueberry.html"
    ) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      res.end(BLUEBERRY_HTML);
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(
        JSON.stringify({
          ok: true,
          rooms: rooms.size
        })
      );

      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }
);

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

wss.on("connection", function(ws) {
  const client = {
    id: makeId("client_"),
    userId: makeId("user_"),
    name: "Anonymous",
    role: "user",
    moderatorLevel: null,
    moderatorAccessId: null,
    anonymousModerator: false,
    roomCode: null,
    ws
  };

  clients.set(client.id, client);

  ws.on("message", function(raw) {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      send(client, {
        type: "error",
        message: "Invalid message."
      });

      return;
    }

    handleClientMessage(client, data);
  });

  ws.on("close", function() {
    removeFromRoom(client, "disconnected");
    clients.delete(client.id);

    broadcastRoomList();
  });
});

function handleClientMessage(client, data) {
  if (!data || typeof data.type !== "string") {
    return;
  }

  if (data.type === "register") {
    if (client.role === "moderator") {
      return;
    }

    client.name = cleanName(data.name);

    const ban = getBan(client.userId);

    if (ban) {
      send(client, {
        type: "banned",
        durationText: ban.durationText
      });

      client.ws.close();
      return;
    }

    send(client, {
      type: "registered",
      id: client.id,
      userId: client.userId,
      name: client.name
    });

    return;
  }

  if (data.type === "moderatorAuth") {
    const name = cleanName(data.name);
    const pin = cleanPin(data.pin);

    if (!name) {
      send(client, {
        type: "error",
        message: "Moderator name is required."
      });

      return;
    }

    if (pin === MASTER_PIN) {
      client.role = "moderator";
      client.moderatorLevel = "master";
      client.moderatorAccessId = null;
      client.name = name;

      send(client, {
        type: "moderatorAuthSuccess",
        id: client.id,
        name: client.name,
        level: "master",
        rooms: getRoomList(),
        bans: getBanList(),
        moderatorAccess: getModeratorAccessList(),
        log: getModeratorLog()
      });

      addLog(
        "Master moderator login",
        client.name + " logged in."
      );

      return;
    }

    const access =
      getModeratorAccessByPin(pin);

    if (!access) {
      send(client, {
        type: "error",
        message: "Invalid or expired moderator PIN."
      });

      return;
    }

    client.role = "moderator";
    client.moderatorLevel = "delegated";
    client.moderatorAccessId = access.id;
    client.name = name;

    send(client, {
      type: "moderatorAuthSuccess",
      id: client.id,
      name: client.name,
      level: "delegated",
      rooms: getRoomList(),
      bans: getBanList(),
      moderatorAccess: getModeratorAccessList(),
      log: getModeratorLog()
    });

    addLog(
      "Moderator login",
      client.name + " logged in using delegated moderator access."
    );

    return;
  }

  if (data.type === "setName") {
    client.name = cleanName(data.name);
    return;
  }

  if (data.type === "createRoom") {
    if (client.role !== "user") return;

    if (!client.name || client.name === "Anonymous") {
      client.name = cleanName(data.name);
    }

    const room =
      createRoom(
        client,
        data.roomName,
        data.roomCode
      );

    if (!room) return;

    joinRoom(client, room.code, false);

    send(client, {
      type: "roomCreated",
      roomCode: room.code,
      roomName: room.name
    });

    return;
  }

  if (data.type === "moderatorCreateRoom") {
    if (!canModerate(client)) {
      send(client, {
        type: "error",
        message: "Moderator access required."
      });

      return;
    }

    const room =
      createRoom(
        client,
        data.roomName,
        data.roomCode
      );

    if (!room) return;

    addLog(
      "Moderator created room",
      client.name +
        " created " +
        room.name +
        " (" +
        room.code +
        ")"
    );

    send(client, {
      type: "roomCreated",
      roomCode: room.code,
      roomName: room.name
    });

    broadcastRoomList();

    return;
  }

  if (data.type === "joinRoom") {
    if (client.role !== "user") return;

    joinRoom(
      client,
      data.roomCode,
      false
    );

    return;
  }

  if (data.type === "moderatorJoinRoom") {
    if (!canModerate(client)) {
      send(client, {
        type: "error",
        message: "Moderator access required."
      });

      return;
    }

    client.anonymousModerator =
      data.anonymous === true;

    joinRoom(
      client,
      data.roomCode,
      true
    );

    return;
  }

  if (data.type === "leaveRoom") {
    removeFromRoom(client, "left");
    return;
  }

  if (data.type === "requestOffer") {
    // Moderator asks a normal participant to initiate
    // a connection. The participant's client handles this
    // by creating an offer.
    const target = clients.get(data.to);

    if (
      target &&
      target.role === "user" &&
      client.role === "moderator"
    ) {
      send(target, {
        type: "moderatorReady",
        id: client.id
      });
    }

    return;
  }

  if (data.type === "signal") {
    const target = clients.get(data.to);

    if (!target) return;

    if (!client.roomCode) return;

    if (target.roomCode !== client.roomCode) {
      return;
    }

    send(target, {
      type: "signal",
      from: client.id,
      signalType: data.signalType,
      description: data.description,
      candidate: data.candidate
    });

    return;
  }

  if (data.type === "chatMessage") {
    if (!client.roomCode) return;

    const room =
      rooms.get(client.roomCode);

    if (!room) return;

    let text =
      String(data.text || "").trim();

    if (!text) return;

    text = text.slice(0, 1000);

    // IMPORTANT:
    // Moderators explicitly identify themselves in chat.
    const displayName =
      client.role === "moderator"
        ? client.name + " (Moderator)"
        : client.name;

    const message = {
      id: makeId("msg_"),
      name: displayName,
      text,
      time: Date.now(),
      isModerator:
        client.role === "moderator"
    };

    room.messages.push(message);

    if (room.messages.length > 100) {
      room.messages.shift();
    }

    broadcastRoom(
      room,
      {
        type: "chatMessage",
        message
      },
      {
        includeUsers: true,
        includeModerators: true
      }
    );

    return;
  }

  if (data.type === "getRoomPeople") {
    if (!canModerate(client)) {
      return;
    }

    const room =
      rooms.get(
        cleanRoomCode(data.roomCode)
      );

    if (!room) {
      send(client, {
        type: "roomPeople",
        roomCode: data.roomCode,
        people: []
      });

      return;
    }

    const people = [];

    for (const id of room.participants) {
      const target = clients.get(id);

      if (
        target &&
        target.role === "user"
      ) {
        people.push({
          id: target.id,
          userId: target.userId,
          name: target.name
        });
      }
    }

    send(client, {
      type: "roomPeople",
      roomCode: room.code,
      people
    });

    return;
  }

  if (data.type === "kick") {
    if (!canModerate(client)) {
      return;
    }

    const target =
      clients.get(data.targetId);

    if (!target) return;

    if (!canControlTarget(client, target)) {
      return;
    }

    if (
      client.roomCode &&
      target.roomCode !== client.roomCode
    ) {
      return;
    }

    addLog(
      "Kick",
      client.name +
        " kicked " +
        target.name
    );

    send(target, {
      type: "kicked"
    });

    removeFromRoom(
      target,
      "kicked"
    );

    return;
  }

  if (data.type === "ban") {
    if (!canModerate(client)) {
      return;
    }

    const target =
      clients.get(data.targetId);

    if (!target) return;

    if (!canControlTarget(client, target)) {
      return;
    }

    if (
      client.roomCode &&
      target.roomCode !== client.roomCode
    ) {
      return;
    }

    const duration =
      calculateDuration(data);

    const ban = {
      id: makeId("ban_"),
      userId: target.userId,
      name: target.name,
      moderatorId: client.id,
      moderatorName: client.name,
      createdAt: Date.now(),
      expiresAt: duration.expiresAt,
      durationText: duration.durationText
    };

    bannedUsers.set(
      ban.id,
      ban
    );

    addLog(
      "Ban",
      client.name +
        " banned " +
        target.name +
        " for " +
        ban.durationText
    );

    send(target, {
      type: "banned",
      durationText:
        ban.durationText
    });

    removeFromRoom(
      target,
      "banned"
    );

    try {
      target.ws.close();
    } catch {}

    broadcastRoomList();

    return;
  }

  if (data.type === "unban") {
    if (!canModerate(client)) {
      return;
    }

    const ban =
      bannedUsers.get(data.banId);

    if (!ban) return;

    bannedUsers.delete(data.banId);

    addLog(
      "Unban",
      client.name +
        " unbanned " +
        ban.name
    );

    broadcastRoomList();

    return;
  }

  if (data.type === "giveModerator") {
    if (!isMasterModerator(client)) {
      send(client, {
        type: "error",
        message:
          "Only the master moderator can give moderator access."
      });

      return;
    }

    const target =
      clients.get(data.targetId);

    if (!target) {
      send(client, {
        type: "error",
        message:
          "That user is no longer connected."
      });

      return;
    }

    if (target.role !== "user") {
      send(client, {
        type: "error",
        message:
          "That user is already a moderator."
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

    const access = {
      id: makeId("mod_"),
      pinHash: hashPin(pin),
      name: target.name,
      targetUserId: target.userId,
      createdBy: client.name,
      createdAt: Date.now(),
      expiresAt: duration.expiresAt,
      durationText: duration.durationText
    };

    moderatorAccess.set(
      access.id,
      access
    );

    addLog(
      "Moderator access granted",
      client.name +
        " gave moderator access to " +
        target.name +
        " for " +
        access.durationText
    );

    send(client, {
      type: "moderatorAccessCreated",
      pin: pin,
      durationText:
        access.durationText
    });

    send(target, {
      type: "moderatorAccessGranted",
      durationText:
        access.durationText
    });

    broadcastRoomList();

    return;
  }

  if (data.type === "revokeModerator") {
    if (!isMasterModerator(client)) {
      return;
    }

    const access =
      moderatorAccess.get(
        data.accessId
      );

    if (!access) return;

    moderatorAccess.delete(
      data.accessId
    );

    addLog(
      "Moderator access revoked",
      client.name +
        " revoked moderator access for " +
        access.name
    );

    for (const target of clients.values()) {
      if (
        target.role === "moderator" &&
        target.moderatorAccessId ===
          data.accessId
      ) {
        send(target, {
          type: "moderatorAccessRevoked"
        });

        try {
          target.ws.close();
        } catch {}
      }
    }

    broadcastRoomList();

    return;
  }

  if (data.type === "getModeratorData") {
    if (!canModerate(client)) {
      return;
    }

    send(client, {
      type: "moderatorData",
      rooms: getRoomList(),
      bans: getBanList(),
      moderatorAccess:
        getModeratorAccessList(),
      log: getModeratorLog()
    });

    return;
  }
}

setInterval(function() {
  cleanExpiredModeratorAccess();
  cleanExpiredBans();
  broadcastRoomList();
}, 5000);

server.listen(PORT, function() {
  console.log(
    "Video chat server running on port " +
      PORT
  );
});

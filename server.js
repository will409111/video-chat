const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MASTER_PIN = "230323038227";

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Map();
const moderatorAccess = new Map();
const moderationLog = [];

function makeId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 30) || "Anonymous";
}

function cleanRoomName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 50) || "Untitled Room";
}

function cleanRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 20);
}

function cleanPin(value) {
  return String(value || "")
    .trim()
    .slice(0, 100);
}

function hashPin(pin) {
  return crypto
    .createHash("sha256")
    .update(pin)
    .digest("hex");
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastRoom(room, data, excludeId = null) {
  for (const id of room.participants) {
    if (id === excludeId) continue;

    const client = clients.get(id);
    if (client) {
      send(client.ws, data);
    }
  }
}

function addLog(action, moderator, target, roomCode, details = "") {
  moderationLog.unshift({
    id: makeId("log"),
    action,
    moderator: moderator || "System",
    target: target || "",
    roomCode: roomCode || "",
    details,
    createdAt: Date.now()
  });

  if (moderationLog.length > 200) {
    moderationLog.length = 200;
  }

  broadcastModeratorData();
}

function formatDuration(ms) {
  if (ms === null) return "Permanent";

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

  if (years) parts.push(`${years}y`);
  if (months) parts.push(`${months}mo`);
  if (weeks) parts.push(`${weeks}w`);
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);

  return parts.join(" ") || "0 seconds";
}

function calculateDuration(data) {
  if (data.permanent) {
    return null;
  }

  const seconds = Number(data.seconds || 0);
  const minutes = Number(data.minutes || 0);
  const hours = Number(data.hours || 0);
  const days = Number(data.days || 0);
  const weeks = Number(data.weeks || 0);
  const months = Number(data.months || 0);
  const years = Number(data.years || 0);

  const total =
    seconds * 1000 +
    minutes * 60 * 1000 +
    hours * 60 * 60 * 1000 +
    days * 24 * 60 * 60 * 1000 +
    weeks * 7 * 24 * 60 * 60 * 1000 +
    months * 30 * 24 * 60 * 60 * 1000 +
    years * 365 * 24 * 60 * 60 * 1000;

  return total > 0 ? total : 0;
}

function cleanExpiredBans() {
  const now = Date.now();

  for (const [id, ban] of bannedUsers) {
    if (ban.expiresAt !== null && ban.expiresAt <= now) {
      bannedUsers.delete(id);
    }
  }
}

function cleanExpiredModeratorAccess() {
  const now = Date.now();

  for (const [id, access] of moderatorAccess) {
    if (access.expiresAt !== null && access.expiresAt <= now) {
      moderatorAccess.delete(id);
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

function isMasterModerator(client) {
  return client &&
    client.role === "moderator" &&
    client.moderatorLevel === "master";
}

function canModerate(client) {
  return client && client.role === "moderator";
}

function canControlTarget(moderator, target) {
  if (!moderator || !target) return false;

  if (target.role === "moderator") {
    return false;
  }

  return true;
}

function getRoomList() {
  return [...rooms.values()].map(room => ({
    name: room.name,
    code: room.code,
    participants: [...room.participants]
      .map(id => clients.get(id))
      .filter(Boolean)
      .filter(c => c.role === "user")
      .map(c => ({
        id: c.id,
        userId: c.userId,
        name: c.name
      }))
  }));
}

function getBanList() {
  cleanExpiredBans();

  return [...bannedUsers.values()].map(ban => ({
    ...ban
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
  return moderationLog;
}

function broadcastModeratorData() {
  const data = {
    type: "moderatorData",
    rooms: getRoomList(),
    bans: getBanList(),
    moderatorAccess: getModeratorAccessList(),
    log: getModeratorLog()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, data);
    }
  }
}

function makeRoomCode() {
  let code;

  do {
    code = crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase();
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
    name: roomName,
    code,
    participants: new Set(),
    messages: []
  };

  rooms.set(code, room);

  return room;
}

function removeFromRoom(client) {
  if (!client.roomCode) return;

  const room = rooms.get(client.roomCode);

  if (!room) {
    client.roomCode = null;
    return;
  }

  room.participants.delete(client.id);

  if (client.role === "user") {
    broadcastRoom(room, {
      type: "userLeft",
      id: client.id
    }, client.id);
  } else {
    for (const id of room.participants) {
      const other = clients.get(id);

      if (other && other.role === "moderator") {
        send(other.ws, {
          type: "moderatorLeft",
          id: client.id
        });
      }
    }
  }

  client.roomCode = null;

  if (room.participants.size === 0) {
    rooms.delete(room.code);
  }

  broadcastModeratorData();
}

function joinRoom(client, roomCode, moderatorJoin = false) {
  const code = cleanRoomCode(roomCode);
  const room = rooms.get(code);

  if (!room) {
    send(client.ws, {
      type: "error",
      message: "Room not found."
    });
    return;
  }

  removeFromRoom(client);

  client.roomCode = room.code;
  room.participants.add(client.id);

  const participants = [...room.participants]
    .map(id => clients.get(id))
    .filter(Boolean)
    .filter(c => c.role === "user")
    .map(c => ({
      id: c.id,
      userId: c.userId,
      name: c.name
    }));

  send(client.ws, {
    type: "roomJoined",
    roomName: room.name,
    roomCode: room.code,
    anonymous: moderatorJoin,
    participants,
    messages: room.messages
  });

  if (client.role === "user") {
    for (const id of room.participants) {
      if (id === client.id) continue;

      const other = clients.get(id);

      if (!other) continue;

      if (other.role === "user") {
        send(other.ws, {
          type: "userJoined",
          participant: {
            id: client.id,
            userId: client.userId,
            name: client.name
          }
        });
      }

      if (other.role === "moderator") {
        send(client.ws, {
          type: "moderatorReady",
          id: other.id
        });
      }
    }

    for (const id of room.participants) {
      const other = clients.get(id);

      if (
        other &&
        other.role === "moderator" &&
        other.id !== client.id
      ) {
        send(other.ws, {
          type: "userJoined",
          participant: {
            id: client.id,
            userId: client.userId,
            name: client.name
          }
        });
      }
    }
  }

  if (client.role === "moderator") {
    for (const id of room.participants) {
      if (id === client.id) continue;

      const other = clients.get(id);

      if (!other) continue;

      if (other.role === "user") {
        send(other.ws, {
          type: "moderatorReady",
          id: client.id
        });
      }
    }

    for (const id of room.participants) {
      const other = clients.get(id);

      if (
        other &&
        other.role === "moderator" &&
        other.id !== client.id
      ) {
        send(other.ws, {
          type: "moderatorJoined",
          id: client.id
        });
      }
    }
  }

  broadcastModeratorData();
}

function removeClient(client) {
  removeFromRoom(client);
  clients.delete(client.id);
}

function sendError(ws, message) {
  send(ws, {
    type: "error",
    message
  });
}

const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video Chat</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#111;
  color:white;
}
.container{
  max-width:900px;
  margin:50px auto;
  padding:20px;
}
.card{
  background:#1d1d1d;
  padding:25px;
  border-radius:18px;
}
input,button{
  width:100%;
  padding:14px;
  margin:7px 0;
  border-radius:10px;
  border:0;
  font-size:16px;
}
button{
  cursor:pointer;
  font-weight:bold;
}
.primary{background:#4caf50;color:white}
.secondary{background:#444;color:white}
#call{display:none}
.video-area{
  display:grid;
  grid-template-columns:1fr;
  gap:12px;
}
video{
  width:100%;
  background:#000;
  border-radius:14px;
  object-fit:cover;
}
.local{
  border:2px solid #4caf50;
}
.remote-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
  gap:12px;
}
.chat{
  margin-top:15px;
  background:#1d1d1d;
  padding:15px;
  border-radius:14px;
}
#messages{
  height:180px;
  overflow-y:auto;
  background:#111;
  padding:10px;
  border-radius:10px;
}
.chat-row{
  display:flex;
  gap:8px;
}
.chat-row input{margin:0}
.chat-row button{
  width:120px;
}
#status{
  margin:10px 0;
  color:#aaa;
}
@media(max-width:700px){
  .container{
    margin:10px auto;
    padding:10px;
  }
  .remote-grid{
    grid-template-columns:1fr;
  }
}
</style>
</head>
<body>

<div class="container">

<div id="lobby" class="card">
<h1>Video Chat</h1>

<input id="name" placeholder="Name">
<input id="roomName" placeholder="Room Name">
<input id="roomCode" placeholder="Room Code">

<button class="primary" onclick="createRoom()">Create Room</button>
<button class="secondary" onclick="joinRoom()">Join Room</button>

<div id="lobbyStatus"></div>
</div>

<div id="call">

<h2 id="roomTitle"></h2>

<div id="status"></div>

<div class="video-area">
  <video id="localVideo" class="local" autoplay muted playsinline></video>

  <div id="remoteGrid" class="remote-grid"></div>
</div>

<div class="chat">
<h3>Chat</h3>

<div id="messages"></div>

<div class="chat-row">
<input id="chatInput" placeholder="Message">
<button onclick="sendChat()">Send</button>
</div>
</div>

<button class="secondary" onclick="leaveRoom()">Leave Room</button>

</div>

</div>

<script>
let ws;
let myId = null;
let myUserId = null;
let myName = "";
let roomCode = "";
let localStream = null;

const peers = new Map();
const participants = new Map();

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";

  ws = new WebSocket(protocol + "//" + location.host + "/ws");

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type:"register"
    }));
  };

  ws.onmessage = async event => {
    const data = JSON.parse(event.data);
    await handleMessage(data);
  };

  ws.onclose = () => {
    document.getElementById("status").textContent =
      "Disconnected from server.";
  };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function createRoom() {
  const name = document.getElementById("name").value.trim();
  const roomName = document.getElementById("roomName").value.trim();
  const code = document.getElementById("roomCode").value.trim();

  if (!name) {
    alert("Enter your name.");
    return;
  }

  await startCamera();

  send({
    type:"setName",
    name
  });

  send({
    type:"createRoom",
    roomName,
    roomCode:code
  });
}

async function joinRoom() {
  const name = document.getElementById("name").value.trim();
  const code = document.getElementById("roomCode").value.trim();

  if (!name) {
    alert("Enter your name.");
    return;
  }

  if (!code) {
    alert("Enter a room code.");
    return;
  }

  await startCamera();

  send({
    type:"setName",
    name
  });

  send({
    type:"joinRoom",
    roomCode:code
  });
}

async function startCamera() {
  if (localStream) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video:true,
      audio:true
    });

    const video = document.getElementById("localVideo");

    // IMPORTANT:
    // There is exactly ONE local video element.
    video.srcObject = localStream;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;

    await video.play().catch(()=>{});
  } catch(err) {
    alert("Camera/microphone permission failed: " + err.message);
    throw err;
  }
}

function addParticipant(participant) {
  if (!participant || participant.id === myId) return;

  participants.set(participant.id, participant);
  renderParticipants();
}

function removeParticipant(id) {
  participants.delete(id);

  const peer = peers.get(id);

  if (peer) {
    peer.pc.close();
    peers.delete(id);
  }

  const tile = document.getElementById("remote-" + id);

  if (tile) {
    tile.remove();
  }

  renderParticipants();
}

function renderParticipants() {
  // Do NOT create a video for ourselves.
  // The local video is handled only by #localVideo.

  for (const [id, participant] of participants) {
    if (id === myId) continue;

    let tile = document.getElementById("remote-" + id);

    if (!tile) {
      tile = document.createElement("div");
      tile.id = "remote-" + id;

      const title = document.createElement("div");
      title.textContent = participant.name;
      title.style.marginBottom = "4px";

      const video = document.createElement("video");
      video.id = "video-" + id;
      video.autoplay = true;
      video.playsInline = true;

      tile.appendChild(title);
      tile.appendChild(video);

      document.getElementById("remoteGrid").appendChild(tile);
    }
  }
}

function getPeer(id) {
  if (peers.has(id)) {
    return peers.get(id);
  }

  const pc = new RTCPeerConnection({
    iceServers:[
      {
        urls:"stun:stun.l.google.com:19302"
      }
    ]
  });

  const peer = {
    pc,
    iceQueue:[]
  };

  peers.set(id, peer);

  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  pc.onicecandidate = event => {
    if (event.candidate) {
      send({
        type:"signal",
        target:id,
        signalType:"ice",
        data:event.candidate
      });
    }
  };

  pc.ontrack = event => {
    const video = document.getElementById("video-" + id);

    if (!video) return;

    if (event.streams && event.streams[0]) {
      video.srcObject = event.streams[0];
    } else {
      let stream = video.srcObject;

      if (!stream) {
        stream = new MediaStream();
        video.srcObject = stream;
      }

      if (!stream.getTracks().some(t => t.id === event.track.id)) {
        stream.addTrack(event.track);
      }
    }

    video.autoplay = true;
    video.playsInline = true;
    video.play().catch(()=>{});
  };

  return peer;
}

async function makeOffer(id) {
  if (id === myId) return;

  const peer = getPeer(id);

  const offer = await peer.pc.createOffer();

  await peer.pc.setLocalDescription(offer);

  send({
    type:"signal",
    target:id,
    signalType:"offer",
    data:peer.pc.localDescription
  });
}

async function handleSignal(data) {
  const id = data.from;

  const peer = getPeer(id);
  const pc = peer.pc;

  if (data.signalType === "offer") {
    await pc.setRemoteDescription(data.data);

    const answer = await pc.createAnswer();

    await pc.setLocalDescription(answer);

    send({
      type:"signal",
      target:id,
      signalType:"answer",
      data:pc.localDescription
    });

    while (peer.iceQueue.length) {
      const candidate = peer.iceQueue.shift();

      try {
        await pc.addIceCandidate(candidate);
      } catch(e){}
    }
  }

  else if (data.signalType === "answer") {
    await pc.setRemoteDescription(data.data);

    while (peer.iceQueue.length) {
      const candidate = peer.iceQueue.shift();

      try {
        await pc.addIceCandidate(candidate);
      } catch(e){}
    }
  }

  else if (data.signalType === "ice") {
    if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(data.data);
      } catch(e){}
    } else {
      peer.iceQueue.push(data.data);
    }
  }
}

async function handleMessage(data) {

  if (data.type === "registered") {
    myId = data.id;
    myUserId = data.userId;
    connectDone = true;
    return;
  }

  if (data.type === "roomCreated") {
    roomCode = data.roomCode;

    document.getElementById("roomCode").value = roomCode;

    return;
  }

  if (data.type === "roomJoined") {
    roomCode = data.roomCode;

    document.getElementById("lobby").style.display = "none";
    document.getElementById("call").style.display = "block";

    document.getElementById("roomTitle").textContent =
      data.roomName + " — " + data.roomCode;

    participants.clear();

    for (const participant of data.participants || []) {
      if (participant.id !== myId) {
        participants.set(participant.id, participant);
      }
    }

    renderParticipants();

    for (const message of data.messages || []) {
      addMessage(message);
    }

    // Only initiate user-to-user connections when our ID
    // sorts before the other user's ID.
    for (const participant of data.participants || []) {
      if (
        participant.id !== myId &&
        myId < participant.id
      ) {
        await makeOffer(participant.id);
      }
    }

    return;
  }

  if (data.type === "userJoined") {
    if (data.participant.id !== myId) {
      addParticipant(data.participant);

      if (myId < data.participant.id) {
        await makeOffer(data.participant.id);
      }
    }

    return;
  }

  if (data.type === "userLeft") {
    removeParticipant(data.id);
    return;
  }

  if (data.type === "moderatorReady") {
    // Moderator is intentionally hidden from the participant list.
    // We still create a WebRTC connection to them.
    await makeOffer(data.id);
    return;
  }

  if (data.type === "moderatorLeft") {
    const peer = peers.get(data.id);

    if (peer) {
      peer.pc.close();
      peers.delete(data.id);
    }

    return;
  }

  if (data.type === "signal") {
    await handleSignal(data);
    return;
  }

  if (data.type === "chatMessage") {
    addMessage(data.message);
    return;
  }

  if (data.type === "kicked") {
    alert("You were kicked from the room.");

    cleanupCall();

    document.getElementById("lobby").style.display = "block";
    document.getElementById("call").style.display = "none";

    return;
  }

  if (data.type === "banned") {
    alert(
      "You are banned from this service." +
      (data.durationText ? "\\nDuration: " + data.durationText : "")
    );

    cleanupCall();

    document.getElementById("lobby").style.display = "block";
    document.getElementById("call").style.display = "none";

    return;
  }

  if (data.type === "error") {
    document.getElementById("lobbyStatus").textContent =
      data.message;

    document.getElementById("status").textContent =
      data.message;

    return;
  }
}

function addMessage(message) {
  const box = document.getElementById("messages");

  const div = document.createElement("div");

  const name = document.createElement("b");
  name.textContent = message.name + ": ";

  const text = document.createElement("span");
  text.textContent = message.text;

  div.appendChild(name);
  div.appendChild(text);

  box.appendChild(div);

  box.scrollTop = box.scrollHeight;
}

function sendChat() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();

  if (!text) return;

  send({
    type:"chatMessage",
    text
  });

  input.value = "";
}

function leaveRoom() {
  send({
    type:"leaveRoom"
  });

  cleanupCall();

  document.getElementById("call").style.display = "none";
  document.getElementById("lobby").style.display = "block";
}

function cleanupCall() {
  for (const peer of peers.values()) {
    peer.pc.close();
  }

  peers.clear();
  participants.clear();

  document.getElementById("remoteGrid").innerHTML = "";
  document.getElementById("messages").innerHTML = "";

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }

    localStream = null;
  }

  document.getElementById("localVideo").srcObject = null;
}

let connectDone = false;
connect();
</script>

</body>
</html>`;

const BLUEBERRY_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moderator</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#111;
  color:white;
}
.container{
  max-width:1200px;
  margin:auto;
  padding:20px;
}
.card{
  background:#1d1d1d;
  border-radius:16px;
  padding:20px;
  margin-bottom:18px;
}
input,button{
  padding:12px;
  border-radius:9px;
  border:0;
  margin:4px;
  font-size:15px;
}
input{
  background:#333;
  color:white;
}
button{
  cursor:pointer;
  font-weight:bold;
}
.primary{background:#4caf50;color:white}
.danger{background:#d32f2f;color:white}
.warning{background:#f57c00;color:white}
.secondary{background:#444;color:white}
.hidden{display:none}
.room{
  background:#292929;
  padding:15px;
  border-radius:12px;
  margin:10px 0;
}
.people{
  margin-top:10px;
  padding:10px;
  background:#171717;
  border-radius:10px;
}
.person{
  padding:10px;
  border-bottom:1px solid #333;
}
.person:last-child{
  border-bottom:0;
}
.ban-controls{
  margin-top:10px;
  padding:12px;
  background:#252525;
  border-radius:10px;
}
.duration-grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:6px;
}
.duration-grid input{
  width:100%;
  margin:0;
}
video{
  width:100%;
  max-height:500px;
  background:#000;
  border-radius:12px;
}
.video-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(250px,1fr));
  gap:10px;
}
.chat{
  background:#171717;
  padding:12px;
  border-radius:12px;
  margin-top:12px;
}
#roomMessages{
  height:180px;
  overflow:auto;
}
@media(max-width:700px){
  .duration-grid{
    grid-template-columns:repeat(2,1fr);
  }
}
</style>
</head>
<body>

<div class="container">

<div id="login" class="card">
<h1>Moderator Login</h1>

<input id="pin" type="password" placeholder="Moderator PIN">

<button class="primary" onclick="login()">Enter</button>

<div id="loginStatus"></div>
</div>

<div id="dashboard" class="hidden">

<div class="card">
<h1>Moderator Dashboard</h1>

<button class="secondary" onclick="refreshData()">Refresh</button>

<button class="secondary" onclick="showCreateRoom()">
Create Room
</button>

</div>

<div id="createRoomBox" class="card hidden">

<h2>Create Room</h2>

<input id="newRoomName" placeholder="Room Name">
<input id="newRoomCode" placeholder="Room Code">

<button class="primary" onclick="createModeratorRoom()">
Create
</button>

<button class="secondary" onclick="hideCreateRoom()">
Cancel
</button>

</div>

<div class="card">
<h2>Open Calls</h2>
<div id="rooms"></div>
</div>

<div class="card">
<h2>Current Room</h2>

<div id="currentRoom"></div>

<div class="video-grid" id="moderatorVideos"></div>

<div class="chat">
<h3>Room Chat</h3>
<div id="roomMessages"></div>
</div>

<button class="secondary" onclick="leaveRoom()">
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

<script>
let ws;
let moderator = null;
let currentRoomCode = null;
let currentRoomParticipants = new Map();
let peers = new Map();

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";

  ws = new WebSocket(protocol + "//" + location.host + "/ws");

  ws.onopen = () => {
    document.getElementById("loginStatus").textContent =
      "Connected.";
  };

  ws.onmessage = async event => {
    const data = JSON.parse(event.data);
    await handleMessage(data);
  };

  ws.onclose = () => {
    document.getElementById("loginStatus").textContent =
      "Disconnected.";
  };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function login() {
  const pin = document.getElementById("pin").value;

  send({
    type:"moderatorAuth",
    pin
  });
}

async function handleMessage(data) {

  if (data.type === "moderatorAuthSuccess") {
    moderator = data;

    document.getElementById("login").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");

    updateDashboard(data);

    return;
  }

  if (data.type === "moderatorData") {
    updateDashboard(data);
    return;
  }

  if (data.type === "roomJoined") {
    currentRoomCode = data.roomCode;

    currentRoomParticipants.clear();

    for (const p of data.participants || []) {
      currentRoomParticipants.set(p.id, p);
    }

    document.getElementById("currentRoom").textContent =
      data.roomName + " — " + data.roomCode;

    document.getElementById("roomMessages").innerHTML = "";

    for (const message of data.messages || []) {
      addRoomMessage(message);
    }

    renderModeratorPeople();

    return;
  }

  if (data.type === "userJoined") {
    currentRoomParticipants.set(
      data.participant.id,
      data.participant
    );

    renderModeratorPeople();

    return;
  }

  if (data.type === "userLeft") {
    currentRoomParticipants.delete(data.id);

    removeVideo(data.id);

    renderModeratorPeople();

    return;
  }

  if (data.type === "signal") {
    await handleSignal(data);
    return;
  }

  if (data.type === "chatMessage") {
    addRoomMessage(data.message);
    return;
  }

  if (data.type === "moderatorAccessCreated") {
    alert(
      "Moderator access created.\\n\\nPIN: " +
      data.pin +
      "\\nDuration: " +
      data.durationText
    );

    refreshData();

    return;
  }

  if (data.type === "moderatorAccessGranted") {
    alert(
      "You have been given moderator access.\\nPIN: " +
      data.pin
    );

    return;
  }

  if (data.type === "error") {
    document.getElementById("loginStatus").textContent =
      data.message;

    alert(data.message);

    return;
  }
}

function updateDashboard(data) {
  renderRooms(data.rooms || []);
  renderBans(data.bans || []);
  renderModeratorAccess(data.moderatorAccess || []);
  renderLog(data.log || []);
}

function renderRooms(rooms) {
  const box = document.getElementById("rooms");

  box.innerHTML = "";

  if (!rooms.length) {
    box.textContent = "No open rooms.";
    return;
  }

  for (const room of rooms) {

    const div = document.createElement("div");
    div.className = "room";

    const title = document.createElement("h3");

    title.textContent =
      room.name + " — " +
      room.code +
      " (" +
      room.participants.length +
      ")";

    div.appendChild(title);

    const view = document.createElement("button");

    view.className = "secondary";
    view.textContent = "View People";

    view.onclick = () => {
      // IMPORTANT:
      // View People ONLY opens the people list.
      // It does NOT open ban controls.
      showPeople(room);
    };

    div.appendChild(view);

    const join = document.createElement("button");

    join.className = "primary";
    join.textContent = "Join";

    join.onclick = () => {
      joinModerator(room.code, false);
    };

    div.appendChild(join);

    const anonymous = document.createElement("button");

    anonymous.className = "secondary";
    anonymous.textContent = "Join Anonymous";

    anonymous.onclick = () => {
      joinModerator(room.code, true);
    };

    div.appendChild(anonymous);

    box.appendChild(div);
  }
}

function showPeople(room) {
  const existing = document.getElementById(
    "people-" + room.code
  );

  if (existing) {
    existing.remove();
    return;
  }

  const people = document.createElement("div");

  people.id = "people-" + room.code;
  people.className = "people";

  if (!room.participants.length) {
    people.textContent = "No participants.";
  }

  for (const person of room.participants) {

    const row = document.createElement("div");
    row.className = "person";

    const name = document.createElement("b");

    name.textContent = person.name;

    row.appendChild(name);

    const kick = document.createElement("button");

    kick.className = "warning";
    kick.textContent = "Kick";

    // NO confirmation.
    kick.onclick = () => {
      send({
        type:"kick",
        targetId:person.id
      });
    };

    row.appendChild(kick);

    const ban = document.createElement("button");

    ban.className = "danger";
    ban.textContent = "Ban";

    const controls = document.createElement("div");

    controls.className = "ban-controls hidden";

    controls.innerHTML = \`
      <label>Ban Duration</label>

      <div class="duration-grid">

        <input type="number"
          min="0"
          placeholder="Seconds"
          class="ban-seconds">

        <input type="number"
          min="0"
          placeholder="Minutes"
          class="ban-minutes">

        <input type="number"
          min="0"
          placeholder="Hours"
          class="ban-hours">

        <input type="number"
          min="0"
          placeholder="Days"
          class="ban-days">

        <input type="number"
          min="0"
          placeholder="Weeks"
          class="ban-weeks">

        <input type="number"
          min="0"
          placeholder="Months"
          class="ban-months">

        <input type="number"
          min="0"
          placeholder="Years"
          class="ban-years">

      </div>

      <label>
        <input type="checkbox" class="ban-permanent">
        Permanent
      </label>

      <br>

      <button class="danger ban-submit">
        Ban User
      </button>
    \`;

    ban.onclick = () => {
      controls.classList.toggle("hidden");
    };

    const submit = controls.querySelector(".ban-submit");

    submit.onclick = () => {

      const permanent =
        controls.querySelector(".ban-permanent").checked;

      const seconds =
        controls.querySelector(".ban-seconds").value;

      const minutes =
        controls.querySelector(".ban-minutes").value;

      const hours =
        controls.querySelector(".ban-hours").value;

      const days =
        controls.querySelector(".ban-days").value;

      const weeks =
        controls.querySelector(".ban-weeks").value;

      const months =
        controls.querySelector(".ban-months").value;

      const years =
        controls.querySelector(".ban-years").value;

      if (
        !permanent &&
        !seconds &&
        !minutes &&
        !hours &&
        !days &&
        !weeks &&
        !months &&
        !years
      ) {
        alert("Enter a ban duration or select Permanent.");
        return;
      }

      send({
        type:"ban",
        targetId:person.id,
        seconds,
        minutes,
        hours,
        days,
        weeks,
        months,
        years,
        permanent
      });

      controls.classList.add("hidden");
    };

    row.appendChild(ban);
    row.appendChild(controls);

    people.appendChild(row);
  }

  room.__peopleElement = people;

  const parent =
    [...document.querySelectorAll(".room")]
      .find(el => el.textContent.includes(room.code));

  if (parent) {
    parent.appendChild(people);
  }
}

function renderModeratorPeople() {
  // Current room people list is intentionally separate
  // from the dashboard View People controls.
}

function joinModerator(code, anonymous) {
  currentRoomParticipants.clear();

  send({
    type:"moderatorJoinRoom",
    roomCode:code,
    anonymous:!!anonymous
  });
}

function leaveRoom() {
  send({
    type:"leaveRoom"
  });

  currentRoomCode = null;

  for (const peer of peers.values()) {
    peer.pc.close();
  }

  peers.clear();

  currentRoomParticipants.clear();

  document.getElementById("moderatorVideos").innerHTML = "";
  document.getElementById("roomMessages").innerHTML = "";
  document.getElementById("currentRoom").textContent = "";
}

function getPeer(id) {
  if (peers.has(id)) {
    return peers.get(id);
  }

  const pc = new RTCPeerConnection({
    iceServers:[
      {
        urls:"stun:stun.l.google.com:19302"
      }
    ]
  });

  const peer = {
    pc,
    iceQueue:[]
  };

  peers.set(id, peer);

  // MODERATOR IS RECEIVE-ONLY.
  pc.addTransceiver("audio", {
    direction:"recvonly"
  });

  pc.addTransceiver("video", {
    direction:"recvonly"
  });

  pc.onicecandidate = event => {
    if (event.candidate) {
      send({
        type:"signal",
        target:id,
        signalType:"ice",
        data:event.candidate
      });
    }
  };

  pc.ontrack = event => {

    let tile = document.getElementById(
      "mod-video-" + id
    );

    if (!tile) {

      tile = document.createElement("div");

      tile.id = "mod-video-" + id;

      const title = document.createElement("div");

      const person =
        currentRoomParticipants.get(id);

      title.textContent =
        person ? person.name : "Participant";

      const video = document.createElement("video");

      video.id = "mod-video-element-" + id;
      video.autoplay = true;
      video.playsInline = true;

      tile.appendChild(title);
      tile.appendChild(video);

      document
        .getElementById("moderatorVideos")
        .appendChild(tile);
    }

    const video =
      document.getElementById(
        "mod-video-element-" + id
      );

    if (event.streams && event.streams[0]) {
      video.srcObject = event.streams[0];
    }

    video.play().catch(()=>{});
  };

  return peer;
}

async function handleSignal(data) {

  const id = data.from;

  const peer = getPeer(id);
  const pc = peer.pc;

  if (data.signalType === "offer") {

    await pc.setRemoteDescription(data.data);

    const answer =
      await pc.createAnswer();

    await pc.setLocalDescription(answer);

    send({
      type:"signal",
      target:id,
      signalType:"answer",
      data:pc.localDescription
    });

    while (peer.iceQueue.length) {

      const candidate =
        peer.iceQueue.shift();

      try {
        await pc.addIceCandidate(candidate);
      } catch(e){}
    }
  }

  else if (data.signalType === "ice") {

    if (pc.remoteDescription) {

      try {
        await pc.addIceCandidate(data.data);
      } catch(e){}

    } else {
      peer.iceQueue.push(data.data);
    }
  }
}

function addRoomMessage(message) {
  const box =
    document.getElementById("roomMessages");

  const div =
    document.createElement("div");

  const b =
    document.createElement("b");

  b.textContent =
    message.name + ": ";

  const text =
    document.createElement("span");

  text.textContent =
    message.text;

  div.appendChild(b);
  div.appendChild(text);

  box.appendChild(div);

  box.scrollTop =
    box.scrollHeight;
}

function removeVideo(id) {

  const tile =
    document.getElementById("mod-video-" + id);

  if (tile) {
    tile.remove();
  }

  const peer = peers.get(id);

  if (peer) {
    peer.pc.close();
    peers.delete(id);
  }
}

function refreshData() {
  send({
    type:"getModeratorData"
  });
}

function showCreateRoom() {
  document
    .getElementById("createRoomBox")
    .classList.remove("hidden");
}

function hideCreateRoom() {
  document
    .getElementById("createRoomBox")
    .classList.add("hidden");
}

function createModeratorRoom() {

  const name =
    document.getElementById("newRoomName").value;

  const code =
    document.getElementById("newRoomCode").value;

  send({
    type:"moderatorCreateRoom",
    roomName:name,
    roomCode:code
  });

  hideCreateRoom();
}

function renderBans(bans) {

  const box =
    document.getElementById("bans");

  box.innerHTML = "";

  if (!bans.length) {
    box.textContent = "No active bans.";
    return;
  }

  for (const ban of bans) {

    const div =
      document.createElement("div");

    div.className = "room";

    div.textContent =
      ban.name +
      " — " +
      ban.durationText;

    const button =
      document.createElement("button");

    button.className = "secondary";
    button.textContent = "Unban";

    button.onclick = () => {

      send({
        type:"unban",
        banId:ban.id
      });

    };

    div.appendChild(button);

    box.appendChild(div);
  }
}

function renderModeratorAccess(accessList) {

  const box =
    document.getElementById("moderatorAccess");

  box.innerHTML = "";

  if (!accessList.length) {
    box.textContent =
      "No delegated moderator access.";
    return;
  }

  for (const access of accessList) {

    const div =
      document.createElement("div");

    div.className = "room";

    div.textContent =
      access.name +
      " — " +
      access.durationText;

    if (
      moderator &&
      moderator.moderatorLevel === "master"
    ) {

      const button =
        document.createElement("button");

      button.className = "danger";
      button.textContent = "Revoke";

      button.onclick = () => {

        send({
          type:"revokeModerator",
          accessId:access.id
        });

      };

      div.appendChild(button);
    }

    box.appendChild(div);
  }
}

function renderLog(log) {

  const box =
    document.getElementById("log");

  box.innerHTML = "";

  for (const item of log) {

    const div =
      document.createElement("div");

    div.className = "room";

    div.textContent =
      item.action +
      " — " +
      item.target +
      " — " +
      item.details;

    box.appendChild(div);
  }
}

connect();
</script>

</body>
</html>`;

const server = http.createServer((req, res) => {

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, {
      "Content-Type":"text/html; charset=utf-8"
    });

    res.end(INDEX_HTML);
    return;
  }

  if (
    req.url === "/blueberry" ||
    req.url === "/blueberry.html"
  ) {
    res.writeHead(200, {
      "Content-Type":"text/html; charset=utf-8"
    });

    res.end(BLUEBERRY_HTML);
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type":"application/json"
    });

    res.end(JSON.stringify({
      ok:true
    }));

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocket.Server({
  server,
  path:"/ws"
});

wss.on("connection", ws => {

  const client = {
    id:makeId("client"),
    userId:makeId("user"),
    name:"Anonymous",
    role:"user",
    moderatorLevel:null,
    moderatorAccessId:null,
    roomCode:null,
    ws
  };

  clients.set(client.id, client);

  send(ws, {
    type:"registered",
    id:client.id,
    userId:client.userId
  });

  ws.on("message", raw => {

    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      sendError(ws, "Invalid message.");
      return;
    }

    handleMessage(client, data);
  });

  ws.on("close", () => {
    removeClient(client);
    broadcastModeratorData();
  });
});

function handleMessage(client, data) {

  cleanExpiredBans();
  cleanExpiredModeratorAccess();

  if (data.type === "register") {

    const ban = getBan(client.userId);

    if (ban) {
      send(client.ws, {
        type:"banned",
        durationText:ban.durationText
      });

      client.ws.close();
      return;
    }

    client.role = "user";

    return;
  }

  if (data.type === "moderatorAuth") {

    const pin = cleanPin(data.pin);

    if (pin === MASTER_PIN) {

      client.role = "moderator";
      client.moderatorLevel = "master";
      client.moderatorAccessId = null;

      send(client.ws, {
        type:"moderatorAuthSuccess",
        moderatorLevel:"master",
        rooms:getRoomList(),
        bans:getBanList(),
        moderatorAccess:getModeratorAccessList(),
        log:getModeratorLog()
      });

      return;
    }

    const access =
      getModeratorAccessByPin(pin);

    if (!access) {
      sendError(client.ws, "Invalid moderator PIN.");
      return;
    }

    client.role = "moderator";
    client.moderatorLevel = "delegated";
    client.moderatorAccessId = access.id;

    send(client.ws, {
      type:"moderatorAuthSuccess",
      moderatorLevel:"delegated",
      rooms:getRoomList(),
      bans:getBanList(),
      moderatorAccess:getModeratorAccessList(),
      log:getModeratorLog()
    });

    return;
  }

  if (data.type === "setName") {

    if (client.role !== "user") return;

    client.name =
      cleanName(data.name);

    return;
  }

  if (data.type === "createRoom") {

    if (client.role !== "user") {
      sendError(client.ws, "Not allowed.");
      return;
    }

    const room =
      createRoom(
        data.roomName,
        data.roomCode
      );

    if (!room) {
      sendError(
        client.ws,
        "That room code is already in use."
      );
      return;
    }

    send(client.ws, {
      type:"roomCreated",
      roomName:room.name,
      roomCode:room.code
    });

    joinRoom(
      client,
      room.code,
      false
    );

    return;
  }

  if (data.type === "moderatorCreateRoom") {

    if (!canModerate(client)) {
      sendError(client.ws, "Moderator access required.");
      return;
    }

    const room =
      createRoom(
        data.roomName,
        data.roomCode
      );

    if (!room) {
      sendError(
        client.ws,
        "That room code is already in use."
      );
      return;
    }

    send(client.ws, {
      type:"roomCreated",
      roomName:room.name,
      roomCode:room.code
    });

    broadcastModeratorData();

    return;
  }

  if (data.type === "joinRoom") {

    if (client.role !== "user") {
      sendError(client.ws, "Not allowed.");
      return;
    }

    const ban = getBan(client.userId);

    if (ban) {
      send(client.ws, {
        type:"banned",
        durationText:ban.durationText
      });
      return;
    }

    joinRoom(
      client,
      data.roomCode,
      false
    );

    return;
  }

  if (data.type === "moderatorJoinRoom") {

    if (!canModerate(client)) {
      sendError(client.ws, "Moderator access required.");
      return;
    }

    joinRoom(
      client,
      data.roomCode,
      true
    );

    return;
  }

  if (data.type === "leaveRoom") {

    removeFromRoom(client);
    return;
  }

  if (data.type === "signal") {

    const target =
      clients.get(data.target);

    if (!target) return;

    if (!client.roomCode ||
        target.roomCode !== client.roomCode) {
      return;
    }

    send(target.ws, {
      type:"signal",
      from:client.id,
      signalType:data.signalType,
      data:data.data
    });

    return;
  }

  if (data.type === "chatMessage") {

    if (!client.roomCode) return;

    const room =
      rooms.get(client.roomCode);

    if (!room) return;

    const text =
      String(data.text || "")
        .trim()
        .slice(0, 500);

    if (!text) return;

    const message = {
      id:makeId("message"),
      userId:client.userId,
      name:client.name,
      text,
      createdAt:Date.now()
    };

    room.messages.push(message);

    if (room.messages.length > 100) {
      room.messages.shift();
    }

    broadcastRoom(room, {
      type:"chatMessage",
      message
    });

    return;
  }

  if (data.type === "kick") {

    if (!canModerate(client)) {
      sendError(client.ws, "Moderator access required.");
      return;
    }

    const target =
      clients.get(data.targetId);

    if (!target) return;

    if (!canControlTarget(client, target)) {
      sendError(
        client.ws,
        "You cannot control this user."
      );
      return;
    }

    const roomCode =
      target.roomCode;

    addLog(
      "KICK",
      client.name,
      target.name,
      roomCode,
      "User kicked"
    );

    send(target.ws, {
      type:"kicked"
    });

    removeFromRoom(target);

    return;
  }

  if (data.type === "ban") {

    if (!canModerate(client)) {
      sendError(client.ws, "Moderator access required.");
      return;
    }

    const target =
      clients.get(data.targetId);

    if (!target) return;

    if (!canControlTarget(client, target)) {
      sendError(
        client.ws,
        "You cannot ban this user."
      );
      return;
    }

    const duration =
      calculateDuration(data);

    if (
      duration === 0 &&
      !data.permanent
    ) {
      sendError(
        client.ws,
        "Enter a ban duration."
      );
      return;
    }

    const expiresAt =
      duration === null
        ? null
        : Date.now() + duration;

    const ban = {
      id:makeId("ban"),
      userId:target.userId,
      name:target.name,
      moderatorId:client.userId,
      moderatorName:client.name,
      createdAt:Date.now(),
      expiresAt,
      durationText:formatDuration(duration)
    };

    bannedUsers.set(
      ban.id,
      ban
    );

    addLog(
      "BAN",
      client.name,
      target.name,
      target.roomCode,
      ban.durationText
    );

    send(target.ws, {
      type:"banned",
      durationText:ban.durationText
    });

    removeFromRoom(target);

    try {
      target.ws.close();
    } catch {}

    broadcastModeratorData();

    return;
  }

  if (data.type === "unban") {

    if (!canModerate(client)) {
      sendError(client.ws, "Moderator access required.");
      return;
    }

    const ban =
      bannedUsers.get(data.banId);

    if (!ban) return;

    bannedUsers.delete(data.banId);

    addLog(
      "UNBAN",
      client.name,
      ban.name,
      "",
      "Ban removed"
    );

    broadcastModeratorData();

    return;
  }

  if (data.type === "giveModerator") {

    if (!isMasterModerator(client)) {
      sendError(
        client.ws,
        "Only the master moderator can give moderator access."
      );
      return;
    }

    const target =
      clients.get(data.targetId);

    if (!target || target.role !== "user") {
      sendError(
        client.ws,
        "Target user not found."
      );
      return;
    }

    const pin =
      cleanPin(data.pin);

    if (pin.length < 4) {
      sendError(
        client.ws,
        "Moderator PIN must be at least 4 characters."
      );
      return;
    }

    const duration =
      calculateDuration(data);

    if (
      duration === 0 &&
      !data.permanent
    ) {
      sendError(
        client.ws,
        "Enter a moderator access duration."
      );
      return;
    }

    const expiresAt =
      duration === null
        ? null
        : Date.now() + duration;

    const access = {
      id:makeId("mod"),
      pinHash:hashPin(pin),
      name:target.name,
      targetUserId:target.userId,
      createdBy:client.userId,
      createdAt:Date.now(),
      expiresAt,
      durationText:formatDuration(duration)
    };

    moderatorAccess.set(
      access.id,
      access
    );

    send(client.ws, {
      type:"moderatorAccessCreated",
      pin,
      durationText:access.durationText
    });

    send(target.ws, {
      type:"moderatorAccessGranted",
      pin,
      durationText:access.durationText
    });

    addLog(
      "GIVE MODERATOR",
      client.name,
      target.name,
      target.roomCode,
      access.durationText
    );

    broadcastModeratorData();

    return;
  }

  if (data.type === "revokeModerator") {

    if (!isMasterModerator(client)) {
      sendError(
        client.ws,
        "Only the master moderator can revoke moderator access."
      );
      return;
    }

    const access =
      moderatorAccess.get(data.accessId);

    if (!access) return;

    moderatorAccess.delete(
      data.accessId
    );

    for (const other of clients.values()) {

      if (
        other.role === "moderator" &&
        other.moderatorAccessId === data.accessId
      ) {

        send(other.ws, {
          type:"error",
          message:"Your moderator access has been revoked."
        });

        try {
          other.ws.close();
        } catch {}
      }
    }

    addLog(
      "REVOKE MODERATOR",
      client.name,
      access.name,
      "",
      "Moderator access revoked"
    );

    broadcastModeratorData();

    return;
  }

  if (data.type === "getModeratorData") {

    if (!canModerate(client)) {
      sendError(client.ws, "Moderator access required.");
      return;
    }

    send(client.ws, {
      type:"moderatorData",
      rooms:getRoomList(),
      bans:getBanList(),
      moderatorAccess:getModeratorAccessList(),
      log:getModeratorLog()
    });

    return;
  }
}

setInterval(() => {
  cleanExpiredBans();
  cleanExpiredModeratorAccess();
  broadcastModeratorData();
}, 5000);

server.listen(PORT, () => {
  console.log("Video chat server running on port " + PORT);
});

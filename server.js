const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const MASTER_PIN = "230323038227";

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Map();
const moderatorAccess = new Map();
const moderationLog = [];

const server = http.createServer((req, res) => {
  let requestPath = req.url.split("?")[0];

  if (requestPath === "/") {
    requestPath = "/index.html";
  }

  if (requestPath === "/blueberry") {
    requestPath = "/blueberry.html";
  }

  if (requestPath === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });

    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      clients: clients.size
    }));

    return;
  }

  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        "Content-Type": "text/plain"
      });

      res.end("Not found");
      return;
    }

    let contentType = "text/html";

    if (filePath.endsWith(".js")) {
      contentType = "application/javascript";
    }

    if (filePath.endsWith(".css")) {
      contentType = "text/css";
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

function makeId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function hashPin(pin) {
  return crypto
    .createHash("sha256")
    .update(String(pin))
    .digest("hex");
}

function cleanName(value) {
  let name = String(value || "").trim();

  if (!name) {
    name = "Guest";
  }

  return name.slice(0, 40);
}

function cleanRoomName(value) {
  let name = String(value || "").trim();

  if (!name) {
    name = "Room";
  }

  return name.slice(0, 60);
}

function cleanRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .slice(0, 24);
}

function cleanChat(value) {
  return String(value || "")
    .trim()
    .slice(0, 500);
}

function cleanPin(value) {
  return String(value || "")
    .trim()
    .slice(0, 100);
}

function send(client, data) {
  if (!client || !client.ws) return;

  if (client.ws.readyState !== WebSocket.OPEN) return;

  try {
    client.ws.send(JSON.stringify(data));
  } catch (_) {}
}

function broadcastRoom(room, data, exceptId = null) {
  if (!room) return;

  for (const clientId of room.members) {
    if (clientId === exceptId) continue;

    const client = clients.get(clientId);

    if (client) {
      send(client, data);
    }
  }
}

function addLog(action, moderator, target, extra = {}) {
  moderationLog.unshift({
    id: makeId("log"),
    action,
    moderator: moderator
      ? {
          id: moderator.id,
          name: moderator.name,
          level: moderator.moderatorLevel || "moderator"
        }
      : null,
    target: target
      ? {
          id: target.id,
          name: target.name
        }
      : null,
    time: Date.now(),
    ...extra
  });

  if (moderationLog.length > 500) {
    moderationLog.length = 500;
  }

  broadcastModeratorData();
}

function calculateDuration(amount, unit, permanent) {
  if (permanent) {
    return null;
  }

  const n = Number(amount);

  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  const multipliers = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
    years: 365 * 24 * 60 * 60 * 1000
  };

  if (!multipliers[unit]) {
    return null;
  }

  return Date.now() + n * multipliers[unit];
}

function formatDuration(amount, unit, permanent) {
  if (permanent) {
    return "Permanent";
  }

  return `${amount} ${unit}`;
}

function cleanExpiredBans() {
  const now = Date.now();

  for (const [banId, ban] of bannedUsers) {
    if (ban.expiresAt !== null && ban.expiresAt <= now) {
      bannedUsers.delete(banId);
    }
  }
}

function cleanExpiredModeratorAccess() {
  const now = Date.now();

  for (const [accessId, access] of moderatorAccess) {
    if (access.expiresAt !== null && access.expiresAt <= now) {
      moderatorAccess.delete(accessId);

      for (const client of clients.values()) {
        if (
          client.role === "moderator" &&
          client.moderatorAccessId === accessId
        ) {
          send(client, {
            type: "moderatorAccessRevoked",
            reason: "Your moderator access has expired."
          });

          try {
            client.ws.close();
          } catch (_) {}
        }
      }
    }
  }
}

function getBanForUser(userId) {
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
  if (!room) return null;

  const participants = [];

  for (const id of room.members) {
    const client = clients.get(id);

    if (!client) continue;

    /*
      IMPORTANT:
      Anonymous moderators are deliberately excluded from the participant
      list sent to normal users.

      Moderators still get the moderator information separately.
    */
    if (client.role === "moderator") {
      continue;
    }

    participants.push({
      id: client.id,
      name: client.name,
      role: "user"
    });
  }

  return {
    code: room.code,
    name: room.name,
    participants,
    messages: room.messages.slice(-100)
  };
}

function getModeratorRoomInfo(room) {
  if (!room) return null;

  const participants = [];

  for (const id of room.members) {
    const client = clients.get(id);

    if (!client) continue;

    participants.push({
      id: client.id,
      name: client.name,
      role: client.role,
      moderatorLevel: client.moderatorLevel || null,
      anonymous: client.role === "moderator"
    });
  }

  return {
    code: room.code,
    name: room.name,
    participants,
    messages: room.messages.slice(-100)
  };
}

function getRoomList() {
  const list = [];

  for (const room of rooms.values()) {
    let normalCount = 0;
    let moderatorCount = 0;

    for (const id of room.members) {
      const client = clients.get(id);

      if (!client) continue;

      if (client.role === "moderator") {
        moderatorCount++;
      } else {
        normalCount++;
      }
    }

    list.push({
      code: room.code,
      name: room.name,
      participants: normalCount,
      moderators: moderatorCount,
      total: normalCount + moderatorCount
    });
  }

  return list;
}

function getBanList() {
  cleanExpiredBans();

  return Array.from(bannedUsers.values()).map(ban => ({
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

  return Array.from(moderatorAccess.values()).map(access => ({
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
  return moderationLog.slice(0, 200);
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
    logs: getModeratorLog()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client, data);
    }
  }
}

function broadcastRoomParticipants(room) {
  if (!room) return;

  /*
    Normal users get ONLY normal users.

    Anonymous moderators are intentionally invisible.
  */
  const normalParticipants = [];

  for (const id of room.members) {
    const client = clients.get(id);

    if (!client) continue;

    if (client.role === "user") {
      normalParticipants.push({
        id: client.id,
        name: client.name,
        role: "user"
      });
    }
  }

  for (const id of room.members) {
    const client = clients.get(id);

    if (!client) continue;

    if (client.role === "moderator") {
      /*
        Moderator gets everybody, including other moderators.
      */
      send(client, {
        type: "participants",
        participants: Array.from(room.members)
          .map(memberId => clients.get(memberId))
          .filter(Boolean)
          .map(member => ({
            id: member.id,
            name: member.name,
            role: member.role,
            moderatorLevel: member.moderatorLevel || null,
            anonymous: member.role === "moderator"
          }))
      });
    } else {
      send(client, {
        type: "participants",
        participants: normalParticipants
      });
    }
  }
}

function createRoom(client, roomName, requestedCode) {
  const name = cleanRoomName(roomName);
  let code = cleanRoomCode(requestedCode);

  if (!code) {
    code = makeRoomCode();
  }

  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
    send(client, {
      type: "error",
      message:
        "Room code must be 3-24 characters and use only letters, numbers, - or _."
    });

    return null;
  }

  if (rooms.has(code)) {
    send(client, {
      type: "error",
      message: "That room code is already in use."
    });

    return null;
  }

  const room = {
    code,
    name,
    ownerId: client.id,
    members: new Set(),
    messages: []
  };

  rooms.set(code, room);

  /*
    Creator is automatically joined.
    There is intentionally no second client-side joinRoom() call.
  */
  client.roomCode = code;
  room.members.add(client.id);

  send(client, {
    type: "roomCreated",
    roomCode: room.code,
    roomName: room.name,
    room: getRoomInfo(room)
  });

  send(client, {
    type: "roomJoined",
    room: getRoomInfo(room)
  });

  broadcastRoomParticipants(room);
  broadcastRoomList();

  return room;
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

function removeFromRoom(client, notify = true) {
  if (!client.roomCode) return;

  const room = rooms.get(client.roomCode);

  if (!room) {
    client.roomCode = null;
    return;
  }

  room.members.delete(client.id);
  client.roomCode = null;

  if (notify) {
    send(client, {
      type: "leftRoom"
    });
  }

  /*
    Empty rooms are temporary and disappear.
  */
  if (room.members.size === 0) {
    rooms.delete(room.code);
  } else {
    broadcastRoomParticipants(room);
  }

  broadcastRoomList();
  broadcastModeratorData();
}

function joinRoom(client, roomCode) {
  const code = cleanRoomCode(roomCode);
  const room = rooms.get(code);

  if (!room) {
    send(client, {
      type: "error",
      message: "Room not found."
    });

    return;
  }

  const ban = getBanForUser(client.id);

  if (ban) {
    send(client, {
      type: "banned",
      expiresAt: ban.expiresAt,
      durationText: ban.durationText,
      message: `You are banned from this service.`
    });

    return;
  }

  if (client.roomCode && client.roomCode !== code) {
    removeFromRoom(client, false);
  }

  client.roomCode = code;
  room.members.add(client.id);

  send(client, {
    type: "roomJoined",
    room: getRoomInfo(room)
  });

  broadcastRoomParticipants(room);
  broadcastRoomList();
  broadcastModeratorData();
}

function moderatorJoinRoom(client, roomCode) {
  if (client.role !== "moderator") {
    return;
  }

  const code = cleanRoomCode(roomCode);
  const room = rooms.get(code);

  if (!room) {
    send(client, {
      type: "error",
      message: "Room not found."
    });

    return;
  }

  if (client.roomCode && client.roomCode !== code) {
    removeFromRoom(client, false);
  }

  client.roomCode = code;
  room.members.add(client.id);

  /*
    Moderator gets the complete room information, including previous chat.
  */
  send(client, {
    type: "moderatorRoomJoined",
    room: getModeratorRoomInfo(room)
  });

  broadcastRoomParticipants(room);
  broadcastRoomList();
  broadcastModeratorData();
}

function canModerate(client) {
  return client && client.role === "moderator";
}

function isMasterModerator(client) {
  return canModerate(client) && client.moderatorLevel === "master";
}

function canControlTarget(client, target) {
  if (!target) return false;

  if (target.role === "moderator") {
    return false;
  }

  return true;
}

wss.on("connection", ws => {
  const client = {
    ws,
    id: makeId("user"),
    name: "Guest",
    role: "user",
    moderatorLevel: null,
    moderatorAccessId: null,
    roomCode: null
  };

  clients.set(client.id, client);

  send(client, {
    type: "connected",
    id: client.id
  });

  ws.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    const type = data.type;

    if (type === "register") {
      /*
        Do not allow clients to claim moderator status.
        Only moderatorAuth can create a moderator session.
      */

      client.name = cleanName(data.name);
      client.role = "user";
      client.moderatorLevel = null;
      client.moderatorAccessId = null;

      const ban = getBanForUser(client.id);

      if (ban) {
        send(client, {
          type: "banned",
          expiresAt: ban.expiresAt,
          durationText: ban.durationText,
          message: "You are banned."
        });

        return;
      }

      send(client, {
        type: "registered",
        id: client.id,
        name: client.name
      });

      return;
    }

    if (type === "moderatorAuth") {
      const name = cleanName(data.name);
      const pin = cleanPin(data.pin);

      if (pin === MASTER_PIN) {
        client.name = name || "Master Moderator";
        client.role = "moderator";
        client.moderatorLevel = "master";
        client.moderatorAccessId = null;

        send(client, {
          type: "moderatorAuthSuccess",
          id: client.id,
          name: client.name,
          level: "master",
          rooms: getRoomList(),
          bans: getBanList(),
          moderatorAccess: getModeratorAccessList(),
          logs: getModeratorLog()
        });

        broadcastModeratorData();
        return;
      }

      const access = getModeratorAccessByPin(pin);

      if (!access) {
        send(client, {
          type: "error",
          message: "Invalid moderator PIN."
        });

        return;
      }

      client.name = name || access.name || "Moderator";
      client.role = "moderator";
      client.moderatorLevel = "delegated";
      client.moderatorAccessId = access.id;

      send(client, {
        type: "moderatorAuthSuccess",
        id: client.id,
        name: client.name,
        level: "delegated",
        rooms: getRoomList(),
        bans: getBanList(),
        moderatorAccess: getModeratorAccessList(),
        logs: getModeratorLog()
      });

      broadcastModeratorData();
      return;
    }

    if (type === "setName") {
      client.name = cleanName(data.name);
      return;
    }

    if (type === "createRoom") {
      if (client.role !== "user") {
        send(client, {
          type: "error",
          message: "Use moderator room creation from the moderator dashboard."
        });

        return;
      }

      createRoom(
        client,
        data.roomName,
        data.roomCode
      );

      return;
    }

    if (type === "moderatorCreateRoom") {
      if (!canModerate(client)) {
        send(client, {
          type: "error",
          message: "Moderator access required."
        });

        return;
      }

      const room = createRoom(
        client,
        data.roomName,
        data.roomCode
      );

      if (room) {
        /*
          A moderator-created room is still a normal room.
          The moderator is simply already inside it.
        */

        send(client, {
          type: "moderatorRoomCreated",
          roomCode: room.code,
          roomName: room.name,
          room: getModeratorRoomInfo(room)
        });
      }

      return;
    }

    if (type === "joinRoom") {
      if (client.role !== "user") {
        send(client, {
          type: "error",
          message: "Use moderatorJoinRoom for moderators."
        });

        return;
      }

      joinRoom(client, data.roomCode);
      return;
    }

    if (type === "moderatorJoinRoom") {
      moderatorJoinRoom(client, data.roomCode);
      return;
    }

    if (type === "leaveRoom") {
      removeFromRoom(client, true);
      return;
    }

    /*
      WebRTC signaling.

      We do NOT send media through the server.
      Only SDP/ICE signaling travels through WebSocket.
    */
    if (type === "signal") {
      const target = clients.get(data.target);

      if (!target) {
        return;
      }

      if (!client.roomCode || client.roomCode !== target.roomCode) {
        return;
      }

      send(target, {
        type: "signal",
        from: client.id,
        fromName: client.name,
        fromRole: client.role,
        signal: data.signal
      });

      return;
    }

    /*
      Room chat.
      Messages are stored only in memory while the room exists.
    */
    if (type === "chatMessage") {
      if (!client.roomCode) {
        return;
      }

      const room = rooms.get(client.roomCode);

      if (!room) {
        return;
      }

      const text = cleanChat(data.text);

      if (!text) {
        return;
      }

      const message = {
        id: makeId("msg"),
        userId: client.id,
        name: client.name,
        text,
        timestamp: Date.now(),
        moderator: client.role === "moderator"
      };

      room.messages.push(message);

      if (room.messages.length > 100) {
        room.messages.splice(0, room.messages.length - 100);
      }

      /*
        Everyone currently in the room receives the message,
        including anonymous moderators.
      */
      broadcastRoom(room, {
        type: "chatMessage",
        message
      });

      return;
    }

    if (type === "kick") {
      if (!canModerate(client)) {
        return;
      }

      const target = clients.get(data.targetId);

      if (!target || target.roomCode !== client.roomCode) {
        return;
      }

      if (!canControlTarget(client, target)) {
        return;
      }

      addLog("kick", client, target);

      send(target, {
        type: "kicked",
        message: "You were removed from the room by a moderator."
      });

      removeFromRoom(target, false);

      try {
        target.ws.close();
      } catch (_) {}

      return;
    }

    if (type === "ban") {
      if (!canModerate(client)) {
        return;
      }

      const target = clients.get(data.targetId);

      if (!target) {
        return;
      }

      if (!canControlTarget(client, target)) {
        return;
      }

      const permanent = Boolean(data.permanent);

      const expiresAt = calculateDuration(
        data.amount,
        data.unit,
        permanent
      );

      if (!permanent && expiresAt === null) {
        send(client, {
          type: "error",
          message: "Invalid ban duration."
        });

        return;
      }

      const ban = {
        id: makeId("ban"),
        userId: target.id,
        name: target.name,
        moderatorId: client.id,
        moderatorName: client.name,
        createdAt: Date.now(),
        expiresAt,
        durationText: formatDuration(
          data.amount,
          data.unit,
          permanent
        )
      };

      bannedUsers.set(ban.id, ban);

      addLog("ban", client, target, {
        durationText: ban.durationText,
        expiresAt
      });

      send(target, {
        type: "banned",
        expiresAt,
        durationText: ban.durationText,
        message: "You have been banned."
      });

      removeFromRoom(target, false);

      try {
        target.ws.close();
      } catch (_) {}

      broadcastModeratorData();

      return;
    }

    if (type === "unban") {
      if (!canModerate(client)) {
        return;
      }

      const ban = bannedUsers.get(data.banId);

      if (!ban) {
        return;
      }

      bannedUsers.delete(data.banId);

      addLog("unban", client, {
        id: ban.userId,
        name: ban.name
      });

      broadcastModeratorData();

      return;
    }

    if (type === "giveModerator") {
      if (!isMasterModerator(client)) {
        send(client, {
          type: "error",
          message: "Only the master moderator can give moderator access."
        });

        return;
      }

      const target = clients.get(data.targetId);

      if (!target || target.role !== "user") {
        send(client, {
          type: "error",
          message: "That user is no longer connected."
        });

        return;
      }

      const pin = cleanPin(data.pin);

      if (pin.length < 4) {
        send(client, {
          type: "error",
          message: "Moderator PIN must be at least 4 characters."
        });

        return;
      }

      const permanent = Boolean(data.permanent);

      const expiresAt = calculateDuration(
        data.amount,
        data.unit,
        permanent
      );

      if (!permanent && expiresAt === null) {
        send(client, {
          type: "error",
          message: "Invalid moderator duration."
        });

        return;
      }

      const access = {
        id: makeId("mod"),
        pinHash: hashPin(pin),
        name: target.name,
        targetUserId: target.id,
        createdBy: client.name,
        createdAt: Date.now(),
        expiresAt,
        durationText: formatDuration(
          data.amount,
          data.unit,
          permanent
        )
      };

      moderatorAccess.set(access.id, access);

      send(client, {
        type: "moderatorAccessCreated",
        access: {
          id: access.id,
          name: access.name,
          pin,
          durationText: access.durationText,
          expiresAt: access.expiresAt
        }
      });

      send(target, {
        type: "moderatorAccessGranted",
        name: target.name,
        durationText: access.durationText,
        expiresAt: access.expiresAt
      });

      addLog("giveModerator", client, target, {
        durationText: access.durationText,
        expiresAt: access.expiresAt
      });

      broadcastModeratorData();

      return;
    }

    if (type === "revokeModerator") {
      if (!isMasterModerator(client)) {
        return;
      }

      const access = moderatorAccess.get(data.accessId);

      if (!access) {
        return;
      }

      moderatorAccess.delete(data.accessId);

      for (const other of clients.values()) {
        if (
          other.role === "moderator" &&
          other.moderatorAccessId === data.accessId
        ) {
          send(other, {
            type: "moderatorAccessRevoked",
            reason: "Your moderator access was revoked."
          });

          try {
            other.ws.close();
          } catch (_) {}
        }
      }

      addLog(
        "revokeModerator",
        client,
        {
          id: access.targetUserId,
          name: access.name
        }
      );

      broadcastModeratorData();

      return;
    }

    if (type === "getModeratorData") {
      if (!canModerate(client)) {
        return;
      }

      send(client, {
        type: "moderatorData",
        rooms: getRoomList(),
        bans: getBanList(),
        moderatorAccess: getModeratorAccessList(),
        logs: getModeratorLog()
      });

      return;
    }
  });

  ws.on("close", () => {
    const room = client.roomCode
      ? rooms.get(client.roomCode)
      : null;

    if (room) {
      room.members.delete(client.id);

      if (room.members.size === 0) {
        rooms.delete(room.code);
      } else {
        broadcastRoomParticipants(room);
      }
    }

    clients.delete(client.id);

    broadcastRoomList();
    broadcastModeratorData();
  });
});

setInterval(() => {
  cleanExpiredBans();
  cleanExpiredModeratorAccess();

  for (const room of rooms.values()) {
    /*
      Remove dead client IDs.
    */
    for (const id of room.members) {
      if (!clients.has(id)) {
        room.members.delete(id);
      }
    }

    if (room.members.size === 0) {
      rooms.delete(room.code);
    }
  }

  broadcastRoomList();
}, 5000);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

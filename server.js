const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

// MASTER MODERATOR PIN
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      users: clients.size
    }));
    return;
  }

  const filePath = path.join(__dirname, requestPath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    let contentType = "text/html";

    if (filePath.endsWith(".js")) {
      contentType = "application/javascript";
    } else if (filePath.endsWith(".css")) {
      contentType = "text/css";
    } else if (filePath.endsWith(".json")) {
      contentType = "application/json";
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache"
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function hashPin(pin) {
  return crypto
    .createHash("sha256")
    .update(String(pin))
    .digest("hex");
}

function cleanName(name) {
  let value = String(name || "").trim();

  if (!value) {
    value = "Guest";
  }

  return value.slice(0, 30);
}

function cleanRoomName(name) {
  let value = String(name || "").trim();

  if (!value) {
    value = "Untitled Room";
  }

  return value.slice(0, 50);
}

function cleanRoomCode(code) {
  return String(code || "")
    .trim()
    .replace(/\s+/g, "")
    .slice(0, 30);
}

function cleanPin(pin) {
  return String(pin || "")
    .trim()
    .slice(0, 100);
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function addLog(action, moderator, target, durationText = "") {
  moderationLog.unshift({
    id: makeId(),
    action,
    moderator: moderator || "System",
    target: target || "",
    durationText,
    createdAt: Date.now()
  });

  if (moderationLog.length > 500) {
    moderationLog.length = 500;
  }

  broadcastModeratorData();
}

function formatDuration(unit, amount) {
  const n = Number(amount) || 0;

  if (unit === "seconds") return `${n} second${n === 1 ? "" : "s"}`;
  if (unit === "minutes") return `${n} minute${n === 1 ? "" : "s"}`;
  if (unit === "hours") return `${n} hour${n === 1 ? "" : "s"}`;
  if (unit === "days") return `${n} day${n === 1 ? "" : "s"}`;
  if (unit === "weeks") return `${n} week${n === 1 ? "" : "s"}`;
  if (unit === "months") return `${n} month${n === 1 ? "" : "s"}`;
  if (unit === "years") return `${n} year${n === 1 ? "" : "s"}`;

  return "Permanent";
}

function calculateDuration(unit, amount, permanent) {
  if (permanent) {
    return null;
  }

  const n = Math.max(1, Number(amount) || 1);

  const multipliers = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
    years: 365 * 24 * 60 * 60 * 1000
  };

  return Date.now() + n * (multipliers[unit] || multipliers.minutes);
}

function cleanExpiredModeratorAccess() {
  for (const [id, access] of moderatorAccess) {
    if (access.expiresAt && access.expiresAt <= Date.now()) {
      moderatorAccess.delete(id);

      for (const client of clients.values()) {
        if (
          client.role === "moderator" &&
          client.moderatorAccessId === id
        ) {
          send(client.ws, {
            type: "moderatorAccessRevoked",
            reason: "Your moderator access expired."
          });

          try {
            client.ws.close();
          } catch {}
        }
      }
    }
  }
}

function cleanExpiredBans() {
  for (const [id, ban] of bannedUsers) {
    if (ban.expiresAt && ban.expiresAt <= Date.now()) {
      bannedUsers.delete(id);
    }
  }
}

function getBan(userId) {
  cleanExpiredBans();

  for (const ban of bannedUsers.values()) {
    if (ban.userId === userId || ban.id === userId) {
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
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    participants: [...room.participants]
      .map(id => clients.get(id))
      .filter(Boolean)
      .map(client => ({
        id: client.id,
        name: client.name,
        role: client.role,
        moderatorLevel: client.moderatorLevel || null
      }))
  };
}

function getRoomList() {
  return [...rooms.values()].map(getRoomInfo);
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
    targetUserId: access.targetUserId,
    createdBy: access.createdBy,
    createdAt: access.createdAt,
    expiresAt: access.expiresAt,
    durationText: access.durationText
  }));
}

function getModeratorLog() {
  return moderationLog.slice(0, 500);
}

function broadcastRoomList() {
  const message = {
    type: "roomList",
    rooms: getRoomList()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, message);
    }
  }
}

function broadcastModeratorData() {
  const message = {
    type: "moderatorData",
    rooms: getRoomList(),
    bans: getBanList(),
    moderatorAccess: getModeratorAccessList(),
    logs: getModeratorLog()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, message);
    }
  }
}

function makeRoomCode() {
  let code;

  do {
    code = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

function createRoom(name, requestedCode) {
  const roomName = cleanRoomName(name);
  let code = cleanRoomCode(requestedCode);

  /*
   * IMPORTANT:
   * If the user entered a code, USE THAT CODE.
   * Only generate a code when the field is blank.
   */
  if (!code) {
    code = makeRoomCode();
  }

  if (rooms.has(code)) {
    return {
      error: "That room code is already in use."
    };
  }

  const room = {
    code,
    name: roomName,
    createdAt: Date.now(),
    participants: new Set(),
    messages: []
  };

  rooms.set(code, room);

  return {
    room
  };
}

function removeFromRoom(client) {
  if (!client.roomCode) {
    return;
  }

  const room = rooms.get(client.roomCode);

  if (!room) {
    client.roomCode = null;
    return;
  }

  room.participants.delete(client.id);

  for (const participantId of room.participants) {
    const participant = clients.get(participantId);

    if (participant) {
      send(participant.ws, {
        type: "userLeft",
        id: client.id
      });
    }
  }

  client.roomCode = null;

  if (room.participants.size === 0) {
    rooms.delete(room.code);
  }

  broadcastRoomList();
  broadcastModeratorData();
}

function joinRoom(client, roomCode) {
  const code = cleanRoomCode(roomCode);
  const room = rooms.get(code);

  if (!room) {
    send(client.ws, {
      type: "error",
      message: "Room not found."
    });
    return;
  }

  const ban = getBan(client.id);

  if (ban) {
    send(client.ws, {
      type: "banned",
      message: "You are banned from this service.",
      expiresAt: ban.expiresAt,
      durationText: ban.durationText
    });

    return;
  }

  if (client.roomCode) {
    removeFromRoom(client);
  }

  const existingParticipants = [...room.participants]
    .map(id => clients.get(id))
    .filter(Boolean);

  room.participants.add(client.id);
  client.roomCode = code;

  send(client.ws, {
    type: "roomJoined",
    room: {
      code: room.code,
      name: room.name
    },
    participants: existingParticipants.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role
    })),
    messages: room.messages.slice(-100)
  });

  for (const participant of existingParticipants) {
    send(participant.ws, {
      type: "userJoined",
      participant: {
        id: client.id,
        name: client.name,
        role: client.role
      }
    });
  }

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
  if (!target) {
    return false;
  }

  if (target.role === "moderator") {
    return false;
  }

  return true;
}

wss.on("connection", ws => {
  let currentClient = null;

  ws.on("message", raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, {
        type: "error",
        message: "Invalid message."
      });
      return;
    }

    const type = message.type;

    /*
     * NORMAL USER REGISTRATION
     */
    if (type === "register") {
      if (currentClient) {
        return;
      }

      const requestedId = String(message.id || "").trim();
      const id = requestedId || makeId();
      const name = cleanName(message.name);

      const existingBan = getBan(id);

      if (existingBan) {
        send(ws, {
          type: "banned",
          message: "You are banned from this service.",
          expiresAt: existingBan.expiresAt,
          durationText: existingBan.durationText
        });

        return;
      }

      const client = {
        id,
        name,
        ws,
        role: "user",
        moderatorLevel: null,
        moderatorAccessId: null,
        roomCode: null
      };

      clients.set(id, client);
      currentClient = client;

      send(ws, {
        type: "registered",
        id,
        name
      });

      broadcastModeratorData();
      return;
    }

    /*
     * MODERATOR LOGIN
     */
    if (type === "moderatorAuth") {
      if (currentClient) {
        return;
      }

      const pin = cleanPin(message.pin);
      const requestedId = String(message.id || "").trim();
      const name = cleanName(message.name || "Moderator");

      let moderatorLevel = null;
      let accessId = null;

      if (pin === MASTER_PIN) {
        moderatorLevel = "master";
      } else {
        const access = getModeratorAccessByPin(pin);

        if (access) {
          moderatorLevel = "delegated";
          accessId = access.id;
        }
      }

      if (!moderatorLevel) {
        send(ws, {
          type: "moderatorAuthFailed",
          message: "Incorrect moderator PIN."
        });

        return;
      }

      const id = requestedId || makeId();

      const client = {
        id,
        name,
        ws,
        role: "moderator",
        moderatorLevel,
        moderatorAccessId: accessId,
        roomCode: null
      };

      clients.set(id, client);
      currentClient = client;

      send(ws, {
        type: "moderatorAuthSuccess",
        id,
        name,
        moderatorLevel,
        rooms: getRoomList(),
        bans: getBanList(),
        moderatorAccess: getModeratorAccessList(),
        logs: getModeratorLog()
      });

      broadcastModeratorData();
      return;
    }

    if (!currentClient) {
      send(ws, {
        type: "error",
        message: "You are not registered."
      });
      return;
    }

    /*
     * CHANGE NAME
     */
    if (type === "setName") {
      const oldName = currentClient.name;
      currentClient.name = cleanName(message.name);

      if (currentClient.roomCode) {
        const room = rooms.get(currentClient.roomCode);

        if (room) {
          for (const participantId of room.participants) {
            const participant = clients.get(participantId);

            if (participant) {
              send(participant.ws, {
                type: "userNameChanged",
                id: currentClient.id,
                name: currentClient.name
              });
            }
          }
        }
      }

      if (
        currentClient.role === "moderator" &&
        oldName !== currentClient.name
      ) {
        broadcastModeratorData();
      }

      return;
    }

    /*
     * NORMAL USER CREATE ROOM
     */
    if (type === "createRoom") {
      if (currentClient.role !== "user") {
        send(ws, {
          type: "error",
          message: "Use the moderator room creator."
        });
        return;
      }

      /*
       * IMPORTANT:
       * message.roomName and message.roomCode come directly
       * from the normal user's form.
       */
      const result = createRoom(
        message.roomName,
        message.roomCode
      );

      if (result.error) {
        send(ws, {
          type: "error",
          message: result.error
        });
        return;
      }

      send(ws, {
        type: "roomCreated",
        room: {
          name: result.room.name,
          code: result.room.code
        }
      });

      /*
       * Automatically join the room.
       */
      joinRoom(currentClient, result.room.code);
      return;
    }

    /*
     * MODERATOR CREATE ROOM
     */
    if (type === "moderatorCreateRoom") {
      if (!canModerate(currentClient)) {
        return;
      }

      const result = createRoom(
        message.roomName,
        message.roomCode
      );

      if (result.error) {
        send(ws, {
          type: "error",
          message: result.error
        });
        return;
      }

      send(ws, {
        type: "moderatorRoomCreated",
        room: {
          name: result.room.name,
          code: result.room.code
        }
      });

      broadcastModeratorData();
      return;
    }

    /*
     * NORMAL JOIN
     */
    if (type === "joinRoom") {
      if (currentClient.role !== "user") {
        return;
      }

      joinRoom(currentClient, message.roomCode);
      return;
    }

    /*
     * MODERATOR JOIN
     *
     * Moderators do NOT publish camera/mic automatically.
     * They still receive the WebRTC streams published by users.
     */
    if (type === "moderatorJoinRoom") {
      if (!canModerate(currentClient)) {
        return;
      }

      joinRoom(currentClient, message.roomCode);
      return;
    }

    /*
     * LEAVE ROOM
     */
    if (type === "leaveRoom") {
      removeFromRoom(currentClient);

      send(ws, {
        type: "roomLeft"
      });

      return;
    }

    /*
     * WEBRTC SIGNALING
     */
    if (type === "signal") {
      const targetId = String(message.target || "");
      const target = clients.get(targetId);

      if (!target) {
        return;
      }

      if (
        currentClient.roomCode &&
        target.roomCode === currentClient.roomCode
      ) {
        send(target.ws, {
          type: "signal",
          from: currentClient.id,
          signal: message.signal
        });
      }

      return;
    }

    /*
     * TEXT CHAT
     */
    if (type === "chatMessage") {
      if (!currentClient.roomCode) {
        return;
      }

      const room = rooms.get(currentClient.roomCode);

      if (!room) {
        return;
      }

      let text = String(message.text || "").trim();

      if (!text) {
        return;
      }

      text = text.slice(0, 1000);

      const chatMessage = {
        id: makeId(),
        userId: currentClient.id,
        name: currentClient.name,
        text,
        createdAt: Date.now(),
        moderator: currentClient.role === "moderator"
      };

      room.messages.push(chatMessage);

      if (room.messages.length > 200) {
        room.messages.shift();
      }

      for (const participantId of room.participants) {
        const participant = clients.get(participantId);

        if (participant) {
          send(participant.ws, {
            type: "chatMessage",
            message: chatMessage
          });
        }
      }

      return;
    }

    /*
     * KICK
     */
    if (type === "kick") {
      if (!canModerate(currentClient)) {
        return;
      }

      const target = clients.get(String(message.targetId || ""));

      if (!target || !canControlTarget(currentClient, target)) {
        return;
      }

      addLog(
        "Kick",
        currentClient.name,
        target.name
      );

      send(target.ws, {
        type: "kicked",
        message: "You were kicked by a moderator."
      });

      removeFromRoom(target);

      broadcastModeratorData();
      return;
    }

    /*
     * BAN
     */
    if (type === "ban") {
      if (!canModerate(currentClient)) {
        return;
      }

      const target = clients.get(String(message.targetId || ""));

      if (!target || !canControlTarget(currentClient, target)) {
        return;
      }

      const permanent = Boolean(message.permanent);
      const unit = String(message.unit || "minutes");
      const amount = Math.max(1, Number(message.amount) || 1);

      const durationText = permanent
        ? "Permanent"
        : formatDuration(unit, amount);

      const expiresAt = calculateDuration(
        unit,
        amount,
        permanent
      );

      const ban = {
        id: makeId(),
        userId: target.id,
        name: target.name,
        moderatorId: currentClient.id,
        moderatorName: currentClient.name,
        createdAt: Date.now(),
        expiresAt,
        durationText
      };

      bannedUsers.set(ban.id, ban);

      addLog(
        "Ban",
        currentClient.name,
        target.name,
        durationText
      );

      send(target.ws, {
        type: "banned",
        message: `You were banned. Duration: ${durationText}.`,
        expiresAt,
        durationText
      });

      removeFromRoom(target);

      try {
        target.ws.close();
      } catch {}

      broadcastModeratorData();
      return;
    }

    /*
     * UNBAN
     */
    if (type === "unban") {
      if (!canModerate(currentClient)) {
        return;
      }

      const banId = String(message.banId || "");

      if (!bannedUsers.has(banId)) {
        return;
      }

      const ban = bannedUsers.get(banId);

      bannedUsers.delete(banId);

      addLog(
        "Unban",
        currentClient.name,
        ban.name
      );

      broadcastModeratorData();
      return;
    }

    /*
     * GIVE MODERATOR
     */
    if (type === "giveModerator") {
      if (!isMasterModerator(currentClient)) {
        send(ws, {
          type: "error",
          message: "Only the master moderator can give moderator access."
        });
        return;
      }

      const target = clients.get(String(message.targetId || ""));

      if (!target || target.role === "moderator") {
        return;
      }

      const customPin = cleanPin(message.pin);

      if (customPin.length < 4) {
        send(ws, {
          type: "error",
          message: "Moderator PIN must be at least 4 characters."
        });
        return;
      }

      if (customPin === MASTER_PIN) {
        send(ws, {
          type: "error",
          message: "That PIN cannot be used."
        });
        return;
      }

      if (getModeratorAccessByPin(customPin)) {
        send(ws, {
          type: "error",
          message: "That moderator PIN is already being used."
        });
        return;
      }

      const permanent = Boolean(message.permanent);
      const unit = String(message.unit || "hours");
      const amount = Math.max(1, Number(message.amount) || 1);

      const durationText = permanent
        ? "Permanent"
        : formatDuration(unit, amount);

      const expiresAt = calculateDuration(
        unit,
        amount,
        permanent
      );

      const access = {
        id: makeId(),
        pinHash: hashPin(customPin),
        name: target.name,
        targetUserId: target.id,
        createdBy: currentClient.name,
        createdAt: Date.now(),
        expiresAt,
        durationText
      };

      moderatorAccess.set(access.id, access);

      send(currentClient.ws, {
        type: "moderatorAccessCreated",
        access: {
          id: access.id,
          name: access.name,
          targetUserId: access.targetUserId,
          createdBy: access.createdBy,
          createdAt: access.createdAt,
          expiresAt: access.expiresAt,
          durationText: access.durationText
        }
      });

      send(target.ws, {
        type: "moderatorAccessGranted",
        message: `You have been given moderator access for ${durationText}.`
      });

      addLog(
        "Give Moderator",
        currentClient.name,
        target.name,
        durationText
      );

      broadcastModeratorData();
      return;
    }

    /*
     * REVOKE MODERATOR
     */
    if (type === "revokeModerator") {
      if (!isMasterModerator(currentClient)) {
        return;
      }

      const accessId = String(message.accessId || "");

      const access = moderatorAccess.get(accessId);

      if (!access) {
        return;
      }

      moderatorAccess.delete(accessId);

      for (const client of clients.values()) {
        if (
          client.role === "moderator" &&
          client.moderatorAccessId === accessId
        ) {
          send(client.ws, {
            type: "moderatorAccessRevoked",
            reason: "Your moderator access was revoked."
          });

          try {
            client.ws.close();
          } catch {}
        }
      }

      addLog(
        "Revoke Moderator",
        currentClient.name,
        access.name
      );

      broadcastModeratorData();
      return;
    }

    /*
     * GET MODERATOR DATA
     */
    if (type === "getModeratorData") {
      if (!canModerate(currentClient)) {
        return;
      }

      send(ws, {
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
    if (!currentClient) {
      return;
    }

    const client = clients.get(currentClient.id);

    if (client === currentClient) {
      removeFromRoom(currentClient);
      clients.delete(currentClient.id);
    }

    broadcastRoomList();
    broadcastModeratorData();
  });
});

setInterval(() => {
  cleanExpiredBans();
  cleanExpiredModeratorAccess();

  for (const room of rooms.values()) {
    if (room.participants.size === 0) {
      rooms.delete(room.code);
    }
  }

  broadcastRoomList();
  broadcastModeratorData();
}, 5000);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

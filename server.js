const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const MASTER_PIN = "230323038227";

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Map();
const moderatorAccess = new Map();
const moderationLog = [];

function makeId(prefix = "") {
  return prefix + crypto.randomBytes(10).toString("hex");
}

function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}

function cleanName(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 40) || "Guest";
}

function cleanRoomName(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 60) || "Untitled Room";
}

function cleanRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 20);
}

function cleanPin(value) {
  return String(value || "").trim().slice(0, 100);
}

function cleanChat(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 500);
}

function send(client, data) {
  if (!client || !client.ws) return;

  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
}

function broadcastRoom(room, data, options = {}) {
  for (const clientId of room.members) {
    const client = clients.get(clientId);
    if (!client) continue;

    if (options.exclude && client.id === options.exclude) {
      continue;
    }

    send(client, data);
  }
}

function addLog(action, moderator, target, extra = {}) {
  moderationLog.unshift({
    id: makeId("log_"),
    action,
    moderator: moderator || "Unknown",
    target: target || "",
    time: Date.now(),
    ...extra
  });

  if (moderationLog.length > 300) {
    moderationLog.length = 300;
  }

  broadcastModeratorData();
}

function formatDuration(value, unit, permanent) {
  if (permanent) return "Permanent";

  const amount = Number(value);

  const labels = {
    seconds: "second",
    minutes: "minute",
    hours: "hour",
    days: "day",
    weeks: "week",
    months: "month",
    years: "year"
  };

  const label = labels[unit] || "minute";

  return `${amount} ${label}${amount === 1 ? "" : "s"}`;
}

function calculateDuration(value, unit, permanent) {
  if (permanent) return null;

  const amount = Number(value);

  const multipliers = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
    years: 365 * 24 * 60 * 60 * 1000
  };

  if (!Number.isFinite(amount) || amount <= 0) {
    return 60 * 1000;
  }

  return amount * (multipliers[unit] || multipliers.minutes);
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

      for (const client of clients.values()) {
        if (
          client.role === "moderator" &&
          client.moderatorAccessId === id
        ) {
          send(client, {
            type: "moderatorAccessExpired"
          });

          try {
            client.ws.close();
          } catch {}
        }
      }
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

  for (const memberId of room.members) {
    const client = clients.get(memberId);
    if (!client) continue;

    // IMPORTANT:
    // Moderators are deliberately excluded from the normal
    // participant list so anonymous moderators stay anonymous.
    if (client.role === "moderator") continue;

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
  const participants = [];

  for (const memberId of room.members) {
    const client = clients.get(memberId);
    if (!client) continue;

    if (client.role === "moderator") continue;

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

function getRoomList() {
  const result = [];

  for (const room of rooms.values()) {
    let count = 0;

    for (const memberId of room.members) {
      const client = clients.get(memberId);

      if (client && client.role === "user") {
        count++;
      }
    }

    result.push({
      code: room.code,
      name: room.name,
      participants: count,
      createdAt: room.createdAt
    });
  }

  return result;
}

function getBanList() {
  cleanExpiredBans();

  return Array.from(bannedUsers.values()).map(ban => ({
    id: ban.id,
    userId: ban.userId,
    name: ban.name,
    createdAt: ban.createdAt,
    expiresAt: ban.expiresAt,
    durationText: ban.durationText,
    moderatorName: ban.moderatorName
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
  return moderationLog.slice(0, 300);
}

function broadcastRoomList() {
  const roomsList = getRoomList();

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client, {
        type: "roomList",
        rooms: roomsList
      });
    }
  }
}

function broadcastModeratorData() {
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

function createRoom(roomName, requestedCode) {
  const name = cleanRoomName(roomName);
  let code = cleanRoomCode(requestedCode);

  if (!code) {
    code = makeRoomCode();
  }

  if (code.length < 3) {
    return {
      error: "Room code must be at least 3 characters."
    };
  }

  if (rooms.has(code)) {
    return {
      error: "That room code is already in use."
    };
  }

  const room = {
    code,
    name,
    createdAt: Date.now(),
    members: new Set(),
    messages: []
  };

  rooms.set(code, room);

  return {
    room
  };
}

function removeFromRoom(client) {
  if (!client.roomCode) return;

  const room = rooms.get(client.roomCode);

  if (!room) {
    client.roomCode = null;
    return;
  }

  room.members.delete(client.id);

  client.roomCode = null;

  // Tell other moderators that the user disappeared.
  for (const memberId of room.members) {
    const member = clients.get(memberId);

    if (member && member.role === "moderator") {
      send(member, {
        type: "roomPeopleChanged",
        room: getModeratorRoomInfo(room)
      });
    }
  }

  // Tell normal users that another normal user left.
  for (const memberId of room.members) {
    const member = clients.get(memberId);

    if (member && member.role === "user") {
      send(member, {
        type: "userLeft",
        id: client.id
      });
    }
  }

  if (room.members.size === 0) {
    rooms.delete(room.code);
  }

  broadcastRoomList();
  broadcastModeratorData();
}

function joinRoom(client, roomCode, moderatorJoin = false) {
  const code = cleanRoomCode(roomCode);
  const room = rooms.get(code);

  if (!room) {
    send(client, {
      type: "error",
      message: "Room not found."
    });
    return;
  }

  if (client.role === "user") {
    const ban = getBan(client.id);

    if (ban) {
      send(client, {
        type: "banned",
        expiresAt: ban.expiresAt,
        durationText: ban.durationText
      });
      return;
    }
  }

  removeFromRoom(client);

  client.roomCode = code;
  room.members.add(client.id);

  if (client.role === "user") {
    // Give the normal user all visible normal participants.
    const participants = [];

    for (const memberId of room.members) {
      const member = clients.get(memberId);

      if (
        member &&
        member.role === "user" &&
        member.id !== client.id
      ) {
        participants.push({
          id: member.id,
          name: member.name,
          role: "user"
        });
      }
    }

    send(client, {
      type: "roomJoined",
      room: {
        code: room.code,
        name: room.name
      },
      participants,
      messages: room.messages.slice(-100)
    });

    // Notify existing normal users about this user.
    for (const memberId of room.members) {
      if (memberId === client.id) continue;

      const member = clients.get(memberId);

      if (member && member.role === "user") {
        send(member, {
          type: "userJoined",
          participant: {
            id: client.id,
            name: client.name,
            role: "user"
          }
        });
      }
    }

    // IMPORTANT:
    // Anonymous moderators are not displayed to the user.
    // Instead, the user gets a hidden WebRTC connection request.
    for (const memberId of room.members) {
      const member = clients.get(memberId);

      if (member && member.role === "moderator") {
        send(client, {
          type: "hiddenModeratorReady",
          moderatorId: member.id
        });
      }
    }

    // Tell moderators that this user exists.
    for (const memberId of room.members) {
      const member = clients.get(memberId);

      if (member && member.role === "moderator") {
        send(member, {
          type: "roomPeopleChanged",
          room: getModeratorRoomInfo(room)
        });

        send(member, {
          type: "userJoined",
          participant: {
            id: client.id,
            name: client.name,
            role: "user"
          }
        });
      }
    }
  }

  if (moderatorJoin) {
    send(client, {
      type: "moderatorRoomJoined",
      room: {
        code: room.code,
        name: room.name
      },
      participants: getModeratorRoomInfo(room).participants,
      messages: room.messages.slice(-100)
    });

    // Ask every normal user to establish a hidden peer connection.
    for (const memberId of room.members) {
      const member = clients.get(memberId);

      if (member && member.role === "user") {
        send(member, {
          type: "hiddenModeratorReady",
          moderatorId: client.id
        });
      }
    }
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
  if (!target) return false;

  // Delegated moderators cannot control other moderators.
  if (
    client.moderatorLevel !== "master" &&
    target.role === "moderator"
  ) {
    return false;
  }

  return target.role === "user";
}

function closeClientConnection(target, reason) {
  if (!target) return;

  send(target, {
    type: reason === "kicked" ? "kicked" : "banned"
  });

  try {
    target.ws.close();
  } catch {}
}

const server = http.createServer((req, res) => {
  let pathname = req.url.split("?")[0];

  if (pathname === "/") {
    pathname = "/index.html";
  }

  if (pathname === "/blueberry") {
    pathname = "/blueberry.html";
  }

  if (pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        ok: true,
        rooms: rooms.size,
        users: Array.from(clients.values()).filter(c => c.role === "user").length
      })
    );

    return;
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream"
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

wss.on("connection", ws => {
  let client = null;

  ws.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!data || typeof data.type !== "string") {
      return;
    }

    // ----------------------------
    // NORMAL USER REGISTER
    // ----------------------------

    if (data.type === "register") {
      const requestedId = String(data.id || "");

      if (!requestedId || requestedId.length > 100) {
        return;
      }

      const existingBan = getBan(requestedId);

      if (existingBan) {
        send(
          {
            ws
          },
          {
            type: "banned",
            expiresAt: existingBan.expiresAt,
            durationText: existingBan.durationText
          }
        );

        try {
          ws.close();
        } catch {}

        return;
      }

      client = {
        id: requestedId,
        name: cleanName(data.name),
        role: "user",
        roomCode: null,
        ws
      };

      clients.set(client.id, client);

      send(client, {
        type: "registered",
        id: client.id,
        name: client.name
      });

      broadcastModeratorData();
      return;
    }

    // ----------------------------
    // MODERATOR AUTH
    // ----------------------------

    if (data.type === "moderatorAuth") {
      const id = String(data.id || makeId("mod_"));
      const name = cleanName(data.name || "Moderator");
      const pin = cleanPin(data.pin);

      if (pin === MASTER_PIN) {
        client = {
          id,
          name,
          role: "moderator",
          moderatorLevel: "master",
          moderatorAccessId: null,
          roomCode: null,
          ws
        };

        clients.set(id, client);

        send(client, {
          type: "moderatorAuthSuccess",
          level: "master",
          id,
          name,
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

      client = {
        id,
        name,
        role: "moderator",
        moderatorLevel: "delegated",
        moderatorAccessId: access.id,
        roomCode: null,
        ws
      };

      clients.set(id, client);

      send(client, {
        type: "moderatorAuthSuccess",
        level: "delegated",
        id,
        name,
        rooms: getRoomList(),
        bans: getBanList(),
        moderatorAccess: getModeratorAccessList(),
        logs: getModeratorLog()
      });

      broadcastModeratorData();
      return;
    }

    if (!client) {
      return;
    }

    // ----------------------------
    // SET NAME
    // ----------------------------

    if (data.type === "setName") {
      client.name = cleanName(data.name);

      send(client, {
        type: "nameUpdated",
        name: client.name
      });

      return;
    }

    // ----------------------------
    // CREATE ROOM
    // ----------------------------

    if (data.type === "createRoom") {
      if (client.role !== "user") return;

      const result = createRoom(
        data.roomName,
        data.roomCode
      );

      if (result.error) {
        send(client, {
          type: "error",
          message: result.error
        });
        return;
      }

      send(client, {
        type: "roomCreated",
        roomCode: result.room.code,
        roomName: result.room.name
      });

      // Automatically join the creator.
      joinRoom(client, result.room.code);

      return;
    }

    // ----------------------------
    // MODERATOR CREATE ROOM
    // ----------------------------

    if (data.type === "moderatorCreateRoom") {
      if (!canModerate(client)) return;

      const result = createRoom(
        data.roomName,
        data.roomCode
      );

      if (result.error) {
        send(client, {
          type: "error",
          message: result.error
        });
        return;
      }

      send(client, {
        type: "moderatorRoomCreated",
        roomCode: result.room.code,
        roomName: result.room.name
      });

      broadcastRoomList();
      broadcastModeratorData();
      return;
    }

    // ----------------------------
    // JOIN ROOM
    // ----------------------------

    if (data.type === "joinRoom") {
      if (client.role !== "user") return;

      joinRoom(client, data.roomCode, false);
      return;
    }

    // ----------------------------
    // MODERATOR JOIN ROOM
    // ----------------------------

    if (data.type === "moderatorJoinRoom") {
      if (!canModerate(client)) return;

      joinRoom(client, data.roomCode, true);
      return;
    }

    // ----------------------------
    // LEAVE ROOM
    // ----------------------------

    if (data.type === "leaveRoom") {
      removeFromRoom(client);

      send(client, {
        type: "leftRoom"
      });

      return;
    }

    // ----------------------------
    // CHAT
    // ----------------------------

    if (data.type === "chatMessage") {
      if (!client.roomCode) return;

      const room = rooms.get(client.roomCode);

      if (!room) return;

      const text = cleanChat(data.text);

      if (!text) return;

      const message = {
        id: makeId("msg_"),
        userId: client.id,
        name: client.name,
        text,
        timestamp: Date.now(),
        moderator: client.role === "moderator"
      };

      room.messages.push(message);

      if (room.messages.length > 100) {
        room.messages.shift();
      }

      // Everyone in the room receives the message,
      // including moderators.
      broadcastRoom(room, {
        type: "chatMessage",
        message
      });

      return;
    }

    // ----------------------------
    // WEBRTC SIGNALING
    // ----------------------------

    if (data.type === "signal") {
      if (!client.roomCode) return;

      const room = rooms.get(client.roomCode);

      if (!room) return;

      const targetId = String(data.target || "");
      const target = clients.get(targetId);

      if (!target) return;

      if (target.roomCode !== client.roomCode) return;

      send(target, {
        type: "signal",
        from: client.id,
        signal: data.signal
      });

      return;
    }

    // ----------------------------
    // KICK
    // ----------------------------

    if (data.type === "kick") {
      if (!canModerate(client)) return;

      const target = clients.get(String(data.targetId || ""));

      if (!canControlTarget(client, target)) {
        return;
      }

      const targetName = target.name;

      addLog(
        "kick",
        client.name,
        targetName
      );

      // No confirmation step.
      closeClientConnection(target, "kicked");

      return;
    }

    // ----------------------------
    // BAN
    // ----------------------------

    if (data.type === "ban") {
      if (!canModerate(client)) return;

      const target = clients.get(String(data.targetId || ""));

      if (!canControlTarget(client, target)) {
        return;
      }

      const permanent = Boolean(data.permanent);
      const value = Number(data.value || 10);
      const unit = String(data.unit || "minutes");

      const duration = calculateDuration(
        value,
        unit,
        permanent
      );

      const expiresAt =
        duration === null
          ? null
          : Date.now() + duration;

      const ban = {
        id: makeId("ban_"),
        userId: target.id,
        name: target.name,
        moderatorId: client.id,
        moderatorName: client.name,
        createdAt: Date.now(),
        expiresAt,
        durationText: formatDuration(
          value,
          unit,
          permanent
        )
      };

      bannedUsers.set(ban.id, ban);

      addLog(
        "ban",
        client.name,
        target.name,
        {
          durationText: ban.durationText
        }
      );

      closeClientConnection(target, "banned");

      broadcastModeratorData();

      return;
    }

    // ----------------------------
    // UNBAN
    // ----------------------------

    if (data.type === "unban") {
      if (!canModerate(client)) return;

      const banId = String(data.banId || "");
      const ban = bannedUsers.get(banId);

      if (!ban) return;

      bannedUsers.delete(banId);

      addLog(
        "unban",
        client.name,
        ban.name
      );

      broadcastModeratorData();

      return;
    }

    // ----------------------------
    // GIVE MODERATOR
    // ----------------------------

    if (data.type === "giveModerator") {
      if (!isMasterModerator(client)) return;

      const target = clients.get(
        String(data.targetId || "")
      );

      if (!target || target.role !== "user") {
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
      const value = Number(data.value || 1);
      const unit = String(data.unit || "hours");

      const duration = calculateDuration(
        value,
        unit,
        permanent
      );

      const access = {
        id: makeId("modaccess_"),
        pinHash: hashPin(pin),
        name: target.name,
        targetUserId: target.id,
        createdBy: client.name,
        createdAt: Date.now(),
        expiresAt:
          duration === null
            ? null
            : Date.now() + duration,
        durationText: formatDuration(
          value,
          unit,
          permanent
        )
      };

      moderatorAccess.set(access.id, access);

      send(client, {
        type: "moderatorAccessCreated",
        name: access.name,
        pin,
        durationText: access.durationText
      });

      send(target, {
        type: "moderatorAccessGranted",
        pin,
        durationText: access.durationText
      });

      addLog(
        "giveModerator",
        client.name,
        target.name,
        {
          durationText: access.durationText
        }
      );

      broadcastModeratorData();

      return;
    }

    // ----------------------------
    // REVOKE MODERATOR
    // ----------------------------

    if (data.type === "revokeModerator") {
      if (!isMasterModerator(client)) return;

      const accessId = String(
        data.accessId || ""
      );

      const access = moderatorAccess.get(accessId);

      if (!access) return;

      moderatorAccess.delete(accessId);

      for (const target of clients.values()) {
        if (
          target.role === "moderator" &&
          target.moderatorAccessId === accessId
        ) {
          send(target, {
            type: "moderatorRevoked"
          });

          try {
            target.ws.close();
          } catch {}
        }
      }

      addLog(
        "revokeModerator",
        client.name,
        access.name
      );

      broadcastModeratorData();

      return;
    }

    // ----------------------------
    // REQUEST MODERATOR DATA
    // ----------------------------

    if (data.type === "getModeratorData") {
      if (!canModerate(client)) return;

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
    if (!client) return;

    removeFromRoom(client);

    clients.delete(client.id);

    broadcastRoomList();
    broadcastModeratorData();
  });

  ws.on("error", () => {
    try {
      ws.close();
    } catch {}
  });
});

setInterval(() => {
  cleanExpiredBans();
  cleanExpiredModeratorAccess();

  broadcastRoomList();
  broadcastModeratorData();
}, 5000);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

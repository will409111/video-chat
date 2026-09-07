const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const MODERATOR_PIN = "230323038227";

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Map();

function makeId() {
  return crypto.randomBytes(16).toString("hex");
}

function cleanName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 30) || "Guest";
}

function cleanRoomName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40) || "Untitled Room";
}

function cleanRoomCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 12);
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";

    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getRoomInfo(room) {
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    userCount: room.users.size,
    participants: Array.from(room.users)
      .map(id => clients.get(id))
      .filter(Boolean)
      .map(client => ({
        id: client.id,
        name: client.name,
        role: client.role,
        anonymous: client.anonymous
      }))
  };
}

function getRoomList() {
  return Array.from(rooms.values()).map(getRoomInfo);
}

function cleanExpiredBans() {
  const now = Date.now();

  for (const [id, ban] of bannedUsers) {
    if (
      ban.expiresAt !== null &&
      ban.expiresAt <= now
    ) {
      bannedUsers.delete(id);
    }
  }
}

function getBanList() {
  cleanExpiredBans();

  return Array.from(bannedUsers.values()).map(ban => ({
    userId: ban.userId,
    name: ban.name,
    createdAt: ban.createdAt,
    expiresAt: ban.expiresAt
  }));
}

function getBan(userId) {
  cleanExpiredBans();
  return bannedUsers.get(userId) || null;
}

function broadcastRoomList() {
  const roomsList = getRoomList();

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, {
        type: "roomsUpdated",
        rooms: roomsList
      });
    }
  }
}

function broadcastBanList() {
  const bans = getBanList();

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, {
        type: "banList",
        bans
      });
    }
  }
}

function createRoom(name, requestedCode) {
  let code = cleanRoomCode(requestedCode);

  if (!code) {
    code = makeRoomCode();
  }

  if (rooms.has(code)) {
    return null;
  }

  const room = {
    code,
    name: cleanRoomName(name),
    users: new Set(),
    createdAt: Date.now()
  };

  rooms.set(code, room);

  return room;
}

function removeFromRoom(client) {
  if (!client.room) {
    return;
  }

  const room = rooms.get(client.room);

  if (!room) {
    client.room = null;
    client.anonymous = false;
    return;
  }

  room.users.delete(client.id);

  for (const id of room.users) {
    const other = clients.get(id);

    if (other) {
      send(other.ws, {
        type: "userLeft",
        userId: client.id
      });
    }
  }

  client.room = null;
  client.anonymous = false;

  if (room.users.size === 0) {
    rooms.delete(room.code);
  }

  broadcastRoomList();
}

function joinRoom(client, roomCode, anonymous) {
  const room = rooms.get(roomCode);

  if (!room) {
    send(client.ws, {
      type: "error",
      message: "That room does not exist."
    });

    return false;
  }

  const ban = getBan(client.id);

  if (ban) {
    send(client.ws, {
      type: "banned",
      message:
        ban.expiresAt === null
          ? "You are permanently banned."
          : "You are banned until " +
            new Date(ban.expiresAt).toLocaleString()
    });

    return false;
  }

  if (client.room) {
    removeFromRoom(client);
  }

  const existingUsers = Array.from(room.users)
    .map(id => clients.get(id))
    .filter(Boolean)
    .filter(user => user.id !== client.id)
    .map(user => ({
      id: user.id,
      name: user.name,
      role: user.role,
      anonymous: user.anonymous
    }));

  client.room = room.code;
  client.anonymous = !!anonymous;

  room.users.add(client.id);

  send(client.ws, {
    type: "roomJoined",
    room: {
      code: room.code,
      name: room.name
    },
    self: {
      id: client.id,
      name: client.name
    },
    anonymous: client.anonymous,
    users: existingUsers
  });

  for (const id of room.users) {
    if (id === client.id) {
      continue;
    }

    const other = clients.get(id);

    if (other) {
      send(other.ws, {
        type: "userJoined",
        user: {
          id: client.id,
          name: client.name,
          role: client.role,
          anonymous: client.anonymous
        }
      });
    }
  }

  broadcastRoomList();

  return true;
}

const server = http.createServer((req, res) => {
  let fileName = null;

  if (
    req.url === "/" ||
    req.url === "/index.html"
  ) {
    fileName = "index.html";
  }

  else if (
    req.url === "/blueberry" ||
    req.url === "/blueberry.html"
  ) {
    fileName = "blueberry.html";
  }

  else if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("OK");
    return;
  }

  else {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const filePath = path.join(__dirname, fileName);

  fs.readFile(filePath, (error, data) => {
    if (error) {
      console.error(error);

      res.writeHead(500);
      res.end("Server error");

      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

wss.on("connection", ws => {
  const client = {
    ws,
    id: null,
    name: "Guest",
    role: "user",
    room: null,
    anonymous: false
  };

  ws.on("message", raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (message.type) {

      case "register": {
        const requestedId = String(
          message.id || makeId()
        );

        const requestedRole =
          message.role === "moderator"
            ? "moderator"
            : "user";

        if (requestedRole === "moderator") {
          if (String(message.pin || "") !== MODERATOR_PIN) {
            send(ws, {
              type: "authError",
              message: "Incorrect moderator PIN."
            });

            ws.close();
            return;
          }
        }

        const oldClient =
          clients.get(requestedId);

        if (
          oldClient &&
          oldClient.ws !== ws
        ) {
          removeFromRoom(oldClient);

          try {
            oldClient.ws.close();
          } catch {}

          clients.delete(requestedId);
        }

        client.id = requestedId;
        client.name = cleanName(message.name);
        client.role = requestedRole;

        const ban = getBan(client.id);

        if (ban) {
          send(ws, {
            type: "banned",
            message:
              ban.expiresAt === null
                ? "You are permanently banned."
                : "You are banned until " +
                  new Date(
                    ban.expiresAt
                  ).toLocaleString()
          });

          ws.close();
          return;
        }

        clients.set(client.id, client);

        if (client.role === "moderator") {
          send(ws, {
            type: "roomList",
            rooms: getRoomList()
          });

          send(ws, {
            type: "banList",
            bans: getBanList()
          });
        }

        broadcastRoomList();

        break;
      }

      case "setName": {
        if (!client.id) {
          return;
        }

        client.name = cleanName(message.name);

        if (client.room) {
          const room = rooms.get(client.room);

          if (room) {
            for (const id of room.users) {
              if (id === client.id) {
                continue;
              }

              const other = clients.get(id);

              if (other) {
                send(other.ws, {
                  type: "userNameChanged",
                  userId: client.id,
                  name: client.name
                });
              }
            }
          }
        }

        broadcastRoomList();

        break;
      }

      case "createRoom": {
        if (!client.id) {
          return;
        }

        const room = createRoom(
          message.name,
          message.code
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
          room: getRoomInfo(room)
        });

        joinRoom(
          client,
          room.code,
          false
        );

        break;
      }

      case "moderatorCreateRoom": {
        if (client.role !== "moderator") {
          return;
        }

        const room = createRoom(
          message.name,
          message.code
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
          room: getRoomInfo(room)
        });

        if (message.join === true) {
          joinRoom(
            client,
            room.code,
            !!message.anonymous
          );
        }

        broadcastRoomList();

        break;
      }

      case "joinRoom": {
        if (!client.id) {
          return;
        }

        joinRoom(
          client,
          cleanRoomCode(message.code),
          false
        );

        break;
      }

      case "moderatorJoinRoom": {
        if (client.role !== "moderator") {
          return;
        }

        joinRoom(
          client,
          cleanRoomCode(message.code),
          !!message.anonymous
        );

        break;
      }

      case "leaveRoom": {
        removeFromRoom(client);

        send(ws, {
          type: "roomLeft"
        });

        break;
      }

      case "signal": {
        if (!client.id) {
          return;
        }

        const target = clients.get(
          String(message.target || "")
        );

        if (!target) {
          return;
        }

        if (
          !client.room ||
          client.room !== target.room
        ) {
          return;
        }

        send(target.ws, {
          type: "signal",
          from: client.id,
          data: message.data
        });

        break;
      }

      case "kick": {
        if (client.role !== "moderator") {
          return;
        }

        const target =
          clients.get(
            String(message.userId || "")
          );

        if (!target) {
          return;
        }

        send(target.ws, {
          type: "kicked",
          message:
            "You were kicked by a moderator."
        });

        removeFromRoom(target);

        break;
      }

      case "ban": {
        if (client.role !== "moderator") {
          return;
        }

        const target =
          clients.get(
            String(message.userId || "")
          );

        if (!target) {
          return;
        }

        let duration =
          Number(message.duration);

        if (
          !Number.isFinite(duration) ||
          duration < 0
        ) {
          duration = 0;
        }

        const expiresAt =
          duration === 0
            ? null
            : Date.now() + duration;

        bannedUsers.set(target.id, {
          userId: target.id,
          name: target.name,
          createdAt: Date.now(),
          expiresAt
        });

        send(target.ws, {
          type: "banned",
          message:
            expiresAt === null
              ? "You were permanently banned."
              : "You were banned until " +
                new Date(
                  expiresAt
                ).toLocaleString()
        });

        removeFromRoom(target);

        try {
          target.ws.close();
        } catch {}

        broadcastBanList();
        broadcastRoomList();

        break;
      }

      case "unban": {
        if (client.role !== "moderator") {
          return;
        }

        const userId =
          String(message.userId || "");

        bannedUsers.delete(userId);

        broadcastBanList();

        break;
      }

      case "getBans": {
        if (client.role !== "moderator") {
          return;
        }

        send(ws, {
          type: "banList",
          bans: getBanList()
        });

        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    if (
      client.id &&
      clients.get(client.id)?.ws === ws
    ) {
      removeFromRoom(client);
      clients.delete(client.id);
      broadcastRoomList();
    }
  });

  ws.on("error", error => {
    console.error(
      "WebSocket error:",
      error
    );
  });
});

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

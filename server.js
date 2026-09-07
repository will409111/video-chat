const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Set();

function makeId() {
  return crypto.randomBytes(16).toString("hex");
}

function cleanName(name) {
  const result = String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 30);

  return result || "Guest";
}

function cleanRoomName(name) {
  const result = String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);

  return result || "Untitled Room";
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

function broadcastRoomList() {
  const list = getRoomList();

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, {
        type: "roomsUpdated",
        rooms: list
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
    code: code,
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

function addToRoom(client, roomCode, anonymous) {
  const room = rooms.get(roomCode);

  if (!room) {
    send(client.ws, {
      type: "error",
      message: "That room does not exist."
    });

    return;
  }

  if (client.room) {
    removeFromRoom(client);
  }

  const existingUsers = Array.from(room.users)
    .map(id => clients.get(id))
    .filter(Boolean)
    .map(user => ({
      id: user.id,
      name: user.name,
      role: user.role,
      anonymous: user.anonymous
    }));

  client.room = roomCode;
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
}

const server = http.createServer((req, res) => {
  let fileName;

  if (
    req.url === "/" ||
    req.url === "/index.html"
  ) {
    fileName = "index.html";
  } else if (
    req.url === "/moderator" ||
    req.url === "/moderator.html"
  ) {
    fileName = "moderator.html";
  } else if (
    req.url === "/health"
  ) {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("OK");
    return;
  } else {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const filePath = path.join(
    __dirname,
    fileName
  );

  fs.readFile(
    filePath,
    (error, data) => {
      if (error) {
        console.error(error);

        res.writeHead(500);
        res.end("Server error");
        return;
      }

      res.writeHead(200, {
        "Content-Type":
          "text/html; charset=utf-8"
      });

      res.end(data);
    }
  );
});

const wss = new WebSocket.Server({
  server: server,
  path: "/ws"
});

wss.on("connection", ws => {
  const client = {
    ws: ws,
    id: null,
    name: "Guest",
    role: "user",
    room: null,
    anonymous: false
  };

  ws.on("message", raw => {
    let message;

    try {
      message = JSON.parse(
        raw.toString()
      );
    } catch (error) {
      console.error(
        "Invalid WebSocket message"
      );
      return;
    }

    switch (message.type) {

      case "register": {
        client.id = String(
          message.id || makeId()
        );

        client.name = cleanName(
          message.name
        );

        client.role =
          message.role === "moderator"
            ? "moderator"
            : "user";

        if (
          bannedUsers.has(client.id)
        ) {
          send(ws, {
            type: "banned",
            message: "You are banned."
          });

          ws.close();
          return;
        }

        clients.set(
          client.id,
          client
        );

        if (
          client.role === "moderator"
        ) {
          send(ws, {
            type: "roomList",
            rooms: getRoomList()
          });
        }

        broadcastRoomList();

        break;
      }

      case "setName": {
        if (!client.id) {
          return;
        }

        client.name = cleanName(
          message.name
        );

        broadcastRoomList();

        if (client.room) {
          const room = rooms.get(
            client.room
          );

          if (room) {
            for (
              const id of room.users
            ) {
              if (id === client.id) {
                continue;
              }

              const other =
                clients.get(id);

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

        break;
      }

      case "createRoom": {
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

        broadcastRoomList();

        break;
      }

      case "moderatorCreateRoom": {
        if (
          client.role !== "moderator"
        ) {
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

        broadcastRoomList();

        break;
      }

      case "joinRoom": {
        if (!client.id) {
          return;
        }

        const code = cleanRoomCode(
          message.code
        );

        addToRoom(
          client,
          code,
          false
        );

        break;
      }

      case "moderatorJoinRoom": {
        if (
          client.role !== "moderator"
        ) {
          return;
        }

        const code = cleanRoomCode(
          message.code
        );

        addToRoom(
          client,
          code,
          !!message.anonymous
        );

        break;
      }

      case "leaveRoom": {
        removeFromRoom(client);
        break;
      }

      case "signal": {
        if (!client.id) {
          return;
        }

        const target =
          clients.get(message.target);

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
        if (
          client.role !== "moderator"
        ) {
          return;
        }

        const target =
          clients.get(message.userId);

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
        if (
          client.role !== "moderator"
        ) {
          return;
        }

        const target =
          clients.get(message.userId);

        if (!target) {
          return;
        }

        bannedUsers.add(target.id);

        send(target.ws, {
          type: "banned",
          message:
            "You were banned by a moderator."
        });

        removeFromRoom(target);

        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    removeFromRoom(client);

    if (client.id) {
      clients.delete(client.id);
    }

    broadcastRoomList();
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
      "Server running on port " + PORT
    );
  }
);

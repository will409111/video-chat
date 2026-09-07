```js
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Set();

function makeId(length = 12) {
  return crypto.randomBytes(12).toString("hex").slice(0, length);
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

function broadcastRoomList() {
  const roomList = [...rooms.values()].map(room => ({
    code: room.code,
    createdAt: room.createdAt,
    userCount: room.users.size,

    participants: [...room.users].map(id => {
      const client = clients.get(id);

      return {
        id,
        name: client?.name || "Guest",
        role: client?.role || "user",
        anonymous: !!client?.anonymous
      };
    })
  }));

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, {
        type: "roomsUpdated",
        rooms: roomList
      });
    }
  }
}

function getRoomList() {
  return [...rooms.values()].map(room => ({
    code: room.code,
    createdAt: room.createdAt,
    userCount: room.users.size,

    participants: [...room.users].map(id => {
      const client = clients.get(id);

      return {
        id,
        name: client?.name || "Guest",
        role: client?.role || "user",
        anonymous: !!client?.anonymous
      };
    })
  }));
}

function createRoom() {
  const code = makeRoomCode();

  rooms.set(code, {
    code,
    users: new Set(),
    createdAt: Date.now()
  });

  return code;
}

function removeFromRoom(client) {
  if (!client.room) return;

  const room = rooms.get(client.room);

  if (!room) {
    client.room = null;
    return;
  }

  room.users.delete(client.id);

  for (const id of room.users) {
    const other = clients.get(id);

    send(other?.ws, {
      type: "userLeft",
      userId: client.id
    });
  }

  client.room = null;

  if (room.users.size === 0) {
    rooms.delete(room.code);
  }

  broadcastRoomList();
}

function addToRoom(client, roomCode, anonymous = false) {
  const room = rooms.get(roomCode);

  if (!room) {
    send(client.ws, {
      type: "error",
      message: "Room does not exist."
    });
    return;
  }

  if (client.room) {
    removeFromRoom(client);
  }

  client.room = roomCode;
  client.anonymous = anonymous;

  const existingUsers = [...room.users]
    .map(id => clients.get(id))
    .filter(Boolean)
    .map(user => ({
      id: user.id,
      name: user.name || "Guest",
      role: user.role,
      anonymous: !!user.anonymous
    }));

  room.users.add(client.id);

  send(client.ws, {
    type: "roomJoined",
    room: roomCode,
    self: {
      id: client.id,
      name: client.name || "Guest"
    },
    users: existingUsers
  });

  for (const id of room.users) {
    if (id === client.id) continue;

    const other = clients.get(id);

    send(other?.ws, {
      type: "userJoined",
      user: {
        id: client.id,
        name: client.name || "Guest",
        role: client.role,
        anonymous: !!client.anonymous
      }
    });
  }

  broadcastRoomList();
}

function broadcastSignal(client, targetId, data) {
  const target = clients.get(targetId);

  if (!target) return;

  send(target.ws, {
    type: "signal",
    from: client.id,
    data
  });
}

const server = http.createServer((req, res) => {
  let file;

  if (req.url === "/" || req.url === "/index.html") {
    file = "index.html";
  } else if (
    req.url === "/moderator" ||
    req.url === "/moderator.html"
  ) {
    file = "moderator.html";
  } else if (req.url === "/health") {
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

  const filePath = path.join(__dirname, file);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end("Server error");
      return;
    }

    const contentType =
      file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "text/plain";

    res.writeHead(200, {
      "Content-Type": contentType
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
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "register": {
        client.id = String(msg.id || makeId());
        client.name =
          String(msg.name || "Guest").trim().slice(0, 30) ||
          "Guest";

        client.role =
          msg.role === "moderator"
            ? "moderator"
            : "user";

        if (bannedUsers.has(client.id)) {
          send(ws, {
            type: "banned",
            message: "You are banned."
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
        }

        broadcastRoomList();
        break;
      }

      case "createRoom": {
        const code = createRoom();

        send(ws, {
          type: "roomCreated",
          code
        });

        break;
      }

      case "moderatorCreateRoom": {
        if (client.role !== "moderator") return;

        const code = createRoom();

        send(ws, {
          type: "roomCreated",
          code
        });

        broadcastRoomList();
        break;
      }

      case "joinRoom": {
        if (!client.id) return;

        const code = String(msg.code || "")
          .trim()
          .toUpperCase();

        addToRoom(client, code, false);
        break;
      }

      case "moderatorJoinRoom": {
        if (client.role !== "moderator") return;

        const code = String(msg.code || "")
          .trim()
          .toUpperCase();

        addToRoom(
          client,
          code,
          !!msg.anonymous
        );

        break;
      }

      case "leaveRoom": {
        removeFromRoom(client);
        break;
      }

      case "signal": {
        if (!client.id) return;

        broadcastSignal(
          client,
          msg.target,
          msg.data
        );

        break;
      }

      case "kick": {
        if (client.role !== "moderator") return;

        const target = clients.get(msg.userId);

        if (!target) return;

        send(target.ws, {
          type: "kicked",
          message: "You were kicked by a moderator."
        });

        removeFromRoom(target);
        break;
      }

      case "ban": {
        if (client.role !== "moderator") return;

        const target = clients.get(msg.userId);

        if (!target) return;

        bannedUsers.add(target.id);

        send(target.ws, {
          type: "banned",
          message: "You were banned by a moderator."
        });

        removeFromRoom(target);

        break;
      }
    }
  });

  ws.on("close", () => {
    removeFromRoom(client);

    if (client.id) {
      clients.delete(client.id);
    }

    broadcastRoomList();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
```

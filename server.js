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
  let requestedPath = req.url.split("?")[0];

  if (requestedPath === "/") {
    requestedPath = "/index.html";
  }

  if (requestedPath === "/blueberry") {
    requestedPath = "/blueberry.html";
  }

  if (requestedPath === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      users: clients.size
    }));

    return;
  }

  const safePath = path.normalize(
    requestedPath.replace(/^\/+/, "")
  );

  const filePath = path.join(
    __dirname,
    safePath
  );

  if (
    !filePath.startsWith(__dirname) ||
    !fs.existsSync(filePath)
  ) {
    res.writeHead(404, {
      "Content-Type": "text/plain"
    });

    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);

  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  res.writeHead(200, {
    "Content-Type":
      contentTypes[ext] ||
      "application/octet-stream"
  });

  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocket.Server({
  noServer: true
});

server.on("upgrade", (request, socket, head) => {
  const pathname =
    request.url.split("?")[0];

  if (pathname !== "/ws") {
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
});


/* ----------------------------- */
/* HELPERS                       */
/* ----------------------------- */

function makeId(prefix = "id") {
  return (
    prefix +
    "_" +
    crypto.randomBytes(9).toString("hex")
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
    .replace(/\s+/g, " ")
    .slice(0, 30) || "Guest";
}


function cleanRoomName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40) || "Blueberry Room";
}


function cleanRoomCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}


function cleanPin(pin) {
  return String(pin || "")
    .trim()
    .slice(0, 100);
}


function cleanChatMessage(message) {
  return String(message || "")
    .trim()
    .slice(0, 1000);
}


function send(ws, data) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(
      JSON.stringify(data)
    );
  }
}


function broadcastToRoom(
  room,
  data,
  options = {}
) {
  if (!room) return;

  for (const userId of room.users) {
    const client =
      clients.get(userId);

    if (!client) continue;

    if (
      options.excludeId &&
      client.id === options.excludeId
    ) {
      continue;
    }

    send(client.ws, data);
  }

  /*
   * Anonymous moderators are not in
   * room.users, so they are separately
   * notified below.
   */
  if (options.includeModerators !== false) {
    for (const client of clients.values()) {
      if (
        client.role === "moderator" &&
        client.moderatorRoomCode === room.code
      ) {
        send(client.ws, data);
      }
    }
  }
}


function addLog(action, moderator, target, extra = {}) {
  moderationLog.unshift({
    id: makeId("log"),
    action,
    moderator:
      moderator?.name ||
      "Unknown Moderator",
    moderatorId:
      moderator?.id || null,
    target:
      target?.name ||
      target?.id ||
      "Unknown",
    targetId:
      target?.id || null,
    ...extra,
    createdAt: Date.now()
  });

  if (moderationLog.length > 500) {
    moderationLog.length = 500;
  }

  broadcastModeratorData();
}


function formatDuration(
  amount,
  unit,
  permanent
) {
  if (permanent) {
    return "Permanent";
  }

  const n = Number(amount);

  const names = {
    seconds: "second",
    minutes: "minute",
    hours: "hour",
    days: "day",
    weeks: "week",
    months: "month",
    years: "year"
  };

  const name =
    names[unit] || "minute";

  return `${n} ${name}${n === 1 ? "" : "s"}`;
}


function calculateDuration(
  amount,
  unit,
  permanent
) {
  if (permanent) {
    return null;
  }

  let multiplier;

  switch (unit) {
    case "seconds":
      multiplier = 1000;
      break;

    case "minutes":
      multiplier = 60 * 1000;
      break;

    case "hours":
      multiplier = 60 * 60 * 1000;
      break;

    case "days":
      multiplier = 24 * 60 * 60 * 1000;
      break;

    case "weeks":
      multiplier = 7 * 24 * 60 * 60 * 1000;
      break;

    case "months":
      multiplier = 30 * 24 * 60 * 60 * 1000;
      break;

    case "years":
      multiplier = 365 * 24 * 60 * 60 * 1000;
      break;

    default:
      multiplier = 60 * 1000;
  }

  const n =
    Math.max(
      1,
      Math.min(
        999999,
        Number(amount) || 1
      )
    );

  return Date.now() + n * multiplier;
}


function cleanExpiredBans() {
  const now = Date.now();

  for (const [id, ban] of bannedUsers) {
    if (
      ban.expiresAt &&
      ban.expiresAt <= now
    ) {
      bannedUsers.delete(id);
    }
  }
}


function cleanExpiredModeratorAccess() {
  const now = Date.now();

  for (
    const [id, access] of moderatorAccess
  ) {
    if (
      access.expiresAt &&
      access.expiresAt <= now
    ) {
      moderatorAccess.delete(id);

      for (const client of clients.values()) {
        if (
          client.role === "moderator" &&
          client.moderatorAccessId === id
        ) {
          send(client.ws, {
            type: "moderatorAccessRevoked",
            message:
              "Your moderator access has expired."
          });

          client.moderatorRoomCode = null;

          send(client.ws, {
            type: "moderatorData",
            rooms: getRoomList(),
            bans: getBanList(),
            moderatorAccess:
              getModeratorAccessList(),
            logs: getModeratorLog()
          });
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

  const hash =
    hashPin(pin);

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
    creatorId: room.creatorId,
    participantCount:
      room.users.size
  };
}


function getRoomList() {
  return Array.from(
    rooms.values()
  ).map(room => ({
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    creatorId: room.creatorId,
    participants:
      Array.from(room.users)
        .map(id => {
          const client =
            clients.get(id);

          if (!client) {
            return null;
          }

          return {
            id: client.id,
            name: client.name,
            role: client.role
          };
        })
        .filter(Boolean)
  }));
}


function getBanList() {
  cleanExpiredBans();

  return Array.from(
    bannedUsers.values()
  ).map(ban => ({
    id: ban.id,
    userId: ban.userId,
    name: ban.name,
    moderatorName:
      ban.moderatorName,
    createdAt: ban.createdAt,
    expiresAt: ban.expiresAt,
    durationText:
      ban.durationText
  }));
}


function getModeratorAccessList() {
  cleanExpiredModeratorAccess();

  return Array.from(
    moderatorAccess.values()
  ).map(access => ({
    id: access.id,
    name: access.name,
    targetUserId:
      access.targetUserId,
    createdBy:
      access.createdBy,
    createdAt:
      access.createdAt,
    expiresAt:
      access.expiresAt,
    durationText:
      access.durationText
  }));
}


function getModeratorLog() {
  return moderationLog.slice(0, 500);
}


function broadcastRoomList() {
  const data = {
    type: "roomList",
    rooms: getRoomList()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, data);
    }
  }
}


function broadcastModeratorData() {
  const data = {
    type: "moderatorData",
    rooms: getRoomList(),
    bans: getBanList(),
    moderatorAccess:
      getModeratorAccessList(),
    logs: getModeratorLog()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, data);
    }
  }
}


function createRoom(
  name,
  creatorId
) {
  let code;

  do {
    code =
      crypto
        .randomBytes(4)
        .toString("hex")
        .toUpperCase();
  } while (rooms.has(code));

  const room = {
    code,
    name:
      cleanRoomName(name),
    creatorId,
    createdAt: Date.now(),
    users: new Set(),
    messages: []
  };

  rooms.set(
    code,
    room
  );

  return room;
}


function removeEmptyRoom(room) {
  if (
    room &&
    room.users.size === 0
  ) {
    rooms.delete(
      room.code
    );

    /*
     * Also disconnect any anonymous
     * moderators watching this room.
     */
    for (const client of clients.values()) {
      if (
        client.role === "moderator" &&
        client.moderatorRoomCode === room.code
      ) {
        client.moderatorRoomCode = null;

        send(client.ws, {
          type: "moderatorRoomClosed",
          code: room.code
        });
      }
    }

    broadcastRoomList();
  }
}


function removeFromRoom(client) {
  if (!client.roomCode) {
    return;
  }

  const room =
    rooms.get(
      client.roomCode
    );

  if (!room) {
    client.roomCode = null;
    client.moderatorRoomCode = null;
    return;
  }

  room.users.delete(
    client.id
  );

  broadcastToRoom(
    room,
    {
      type: "userLeft",
      userId: client.id
    },
    {
      excludeId: client.id
    }
  );

  client.roomCode = null;

  removeEmptyRoom(
    room
  );

  broadcastRoomList();
}


function joinRoom(
  client,
  room
) {
  if (!room) {
    send(client.ws, {
      type: "error",
      message:
        "Room not found."
    });

    return false;
  }

  const ban =
    getBan(client.id);

  if (ban) {
    send(client.ws, {
      type: "banned",
      message:
        ban.expiresAt
          ? `You are banned until ${new Date(
              ban.expiresAt
            ).toLocaleString()}.`
          : "You are permanently banned."
    });

    return false;
  }

  if (client.roomCode) {
    removeFromRoom(client);
  }

  const existingUsers =
    Array.from(room.users)
      .map(id => {
        const user =
          clients.get(id);

        if (!user) return null;

        return {
          id: user.id,
          name: user.name,
          role: user.role
        };
      })
      .filter(Boolean);

  room.users.add(
    client.id
  );

  client.roomCode =
    room.code;

  send(client.ws, {
    type: "roomJoined",
    room: getRoomInfo(room),
    self: {
      id: client.id,
      name: client.name,
      role: client.role
    },
    users: existingUsers,
    messages: room.messages
  });

  broadcastToRoom(
    room,
    {
      type: "userJoined",
      user: {
        id: client.id,
        name: client.name,
        role: client.role
      }
    },
    {
      excludeId: client.id
    }
  );

  /*
   * Send the new user to anonymous
   * moderators watching the room.
   */
  for (const moderator of clients.values()) {
    if (
      moderator.role === "moderator" &&
      moderator.moderatorRoomCode === room.code
    ) {
      send(moderator.ws, {
        type: "userJoined",
        user: {
          id: client.id,
          name: client.name,
          role: client.role
        }
      });
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
  return (
    client.role === "moderator" &&
    (
      client.moderatorLevel === "master" ||
      moderatorAccess.has(
        client.moderatorAccessId
      )
    )
  );
}


function canControlTarget(
  moderator,
  target
) {
  if (!target) {
    return false;
  }

  /*
   * Delegated moderators cannot
   * control another moderator.
   */
  if (
    moderator.moderatorLevel !== "master" &&
    target.role === "moderator"
  ) {
    return false;
  }

  return true;
}


/* ----------------------------- */
/* WEBSOCKET                     */
/* ----------------------------- */

wss.on(
  "connection",
  ws => {

    let client = null;

    ws.on(
      "message",
      raw => {

        let message;

        try {
          message =
            JSON.parse(
              raw.toString()
            );
        }

        catch {
          send(ws, {
            type: "error",
            message:
              "Invalid message."
          });

          return;
        }

        const type =
          message.type;


        /* ----------------------- */
        /* REGISTER NORMAL USER     */
        /* ----------------------- */

        if (type === "register") {

          if (client) {
            return;
          }

          const requestedId =
            String(
              message.id || ""
            ).slice(0, 100);

          if (!requestedId) {
            send(ws, {
              type: "error",
              message:
                "Missing client ID."
            });

            return;
          }

          const ban =
            getBan(requestedId);

          if (ban) {

            send(ws, {
              type: "banned",
              message:
                ban.expiresAt
                  ? `You are banned until ${new Date(
                      ban.expiresAt
                    ).toLocaleString()}.`
                  : "You are permanently banned."
            });

            ws.close();
            return;
          }

          client = {
            id: requestedId,
            name:
              cleanName(
                message.name
              ),
            role: "user",
            moderatorLevel: null,
            moderatorAccessId: null,
            roomCode: null,
            moderatorRoomCode: null,
            ws
          };

          clients.set(
            client.id,
            client
          );

          send(ws, {
            type: "registered",
            userId:
              client.id,
            name:
              client.name
          });

          broadcastRoomList();

          return;
        }


        /* ----------------------- */
        /* MODERATOR LOGIN          */
        /* ----------------------- */

        if (
          type ===
          "moderatorAuth"
        ) {

          if (client) {
            return;
          }

          const pin =
            cleanPin(
              message.pin
            );

          const name =
            cleanName(
              message.name ||
              "Moderator"
            );

          let level = null;
          let access = null;

          if (
            pin === MASTER_PIN
          ) {
            level = "master";
          }

          else {
            access =
              getModeratorAccessByPin(
                pin
              );

            if (access) {
              level = "delegated";
            }
          }

          if (!level) {
            send(ws, {
              type: "error",
              message:
                "Invalid moderator PIN."
            });

            return;
          }

          const requestedId =
            String(
              message.id ||
              makeId("mod")
            ).slice(0, 100);

          client = {
            id: requestedId,
            name,
            role: "moderator",
            moderatorLevel: level,
            moderatorAccessId:
              access?.id || null,
            roomCode: null,
            moderatorRoomCode: null,
            ws
          };

          clients.set(
            client.id,
            client
          );

          send(ws, {
            type:
              "moderatorAuthSuccess",
            userId:
              client.id,
            level,
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


        if (!client) {
          send(ws, {
            type: "error",
            message:
              "You are not registered."
          });

          return;
        }


        /* ----------------------- */
        /* SET NAME                 */
        /* ----------------------- */

        if (
          type ===
          "setName"
        ) {

          client.name =
            cleanName(
              message.name
            );

          if (
            client.roomCode
          ) {

            const room =
              rooms.get(
                client.roomCode
              );

            if (room) {

              broadcastToRoom(
                room,
                {
                  type:
                    "userNameChanged",
                  userId:
                    client.id,
                  name:
                    client.name
                }
              );
            }
          }

          return;
        }


        /* ----------------------- */
        /* CREATE ROOM              */
        /* ----------------------- */

        if (
          type ===
          "createRoom"
        ) {

          if (
            client.role !== "user"
          ) {
            send(ws, {
              type: "error",
              message:
                "Only normal users can create rooms here."
            });

            return;
          }

          const room =
            createRoom(
              message.name,
              client.id
            );

          joinRoom(
            client,
            room
          );

          return;
        }


        /* ----------------------- */
        /* MODERATOR CREATE ROOM    */
        /* ----------------------- */

        if (
          type ===
          "moderatorCreateRoom"
        ) {

          if (
            !canModerate(client)
          ) {
            return;
          }

          const room =
            createRoom(
              message.name,
              client.id
            );

          send(ws, {
            type:
              "moderatorRoomCreated",
            room:
              getRoomInfo(room)
          });

          broadcastRoomList();

          return;
        }


        /* ----------------------- */
        /* JOIN NORMAL ROOM         */
        /* ----------------------- */

        if (
          type ===
          "joinRoom"
        ) {

          if (
            client.role !== "user"
          ) {
            return;
          }

          const code =
            cleanRoomCode(
              message.code
            );

          const room =
            rooms.get(code);

          joinRoom(
            client,
            room
          );

          return;
        }


        /* ----------------------- */
        /* MODERATOR WATCH ROOM     */
        /* ----------------------- */

        if (
          type ===
          "moderatorJoinRoom"
        ) {

          if (
            !canModerate(client)
          ) {
            send(ws, {
              type: "error",
              message:
                "You are not authorized as a moderator."
            });

            return;
          }

          const code =
            cleanRoomCode(
              message.code
            );

          const room =
            rooms.get(code);

          if (!room) {
            send(ws, {
              type: "error",
              message:
                "Room not found."
            });

            return;
          }

          client.moderatorRoomCode =
            room.code;

          /*
           * IMPORTANT:
           *
           * We do NOT add the moderator
           * to room.users.
           *
           * This means they are invisible
           * to normal users and publish
           * no camera/microphone.
           */
          const users =
            Array.from(room.users)
              .map(id => {
                const user =
                  clients.get(id);

                if (!user) return null;

                return {
                  id: user.id,
                  name: user.name,
                  role: user.role
                };
              })
              .filter(Boolean);

          send(ws, {
            type:
              "moderatorRoomJoined",
            room:
              getRoomInfo(room),
            users,
            messages:
              room.messages
          });

          return;
        }


        /* ----------------------- */
        /* LEAVE ROOM               */
        /* ----------------------- */

        if (
          type ===
          "leaveRoom"
        ) {

          if (
            client.role ===
            "moderator"
          ) {

            client.moderatorRoomCode =
              null;

            send(ws, {
              type: "roomLeft"
            });

          }

          else {

            removeFromRoom(
              client
            );

            send(ws, {
              type: "roomLeft"
            });
          }

          return;
        }


        /* ----------------------- */
        /* WEBRTC SIGNAL            */
        /* ----------------------- */

        if (
          type ===
          "signal"
        ) {

          const targetId =
            String(
              message.target || ""
            );

          const target =
            clients.get(
              targetId
            );

          if (!target) {
            return;
          }

          /*
           * Normal user -> normal user
           */
          if (
            client.role === "user" &&
            target.role === "user"
          ) {

            if (
              !client.roomCode ||
              client.roomCode !==
                target.roomCode
            ) {
              return;
            }

            send(
              target.ws,
              {
                type: "signal",
                from:
                  client.id,
                data:
                  message.data
              }
            );

            return;
          }

          /*
           * Moderator -> normal user
           *
           * Used so anonymous moderators
           * can receive WebRTC media.
           */
          if (
            client.role === "moderator" &&
            target.role === "user"
          ) {

            if (
              client.moderatorRoomCode !==
                target.roomCode
            ) {
              return;
            }

            send(
              target.ws,
              {
                type: "signal",
                from:
                  client.id,
                data:
                  message.data
              }
            );

            return;
          }

          /*
           * Normal user -> moderator
           *
           * This is what allows the moderator
           * to receive camera/microphone media.
           */
          if (
            client.role === "user" &&
            target.role === "moderator"
          ) {

            if (
              target.moderatorRoomCode !==
                client.roomCode
            ) {
              return;
            }

            send(
              target.ws,
              {
                type: "signal",
                from:
                  client.id,
                data:
                  message.data
              }
            );

            return;
          }

          return;
        }


        /* ----------------------- */
        /* CHAT                     */
        /* ----------------------- */

        if (
          type ===
          "chat"
        ) {

          if (
            client.role !== "user"
          ) {
            return;
          }

          if (
            !client.roomCode
          ) {
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
            cleanChatMessage(
              message.message
            );

          if (!text) {
            return;
          }

          const chatMessage = {
            id:
              makeId("msg"),
            userId:
              client.id,
            name:
              client.name,
            message:
              text,
            createdAt:
              Date.now()
          };

          room.messages.push(
            chatMessage
          );

          /*
           * Keep the room chat temporary
           * and reasonably small.
           */
          if (
            room.messages.length >
            200
          ) {
            room.messages.shift();
          }

          /*
           * Send chat to all normal users
           * AND all moderators watching
           * this room.
           */
          broadcastToRoom(
            room,
            {
              type:
                "chatMessage",
              message:
                chatMessage
            }
          );

          return;
        }


        /* ----------------------- */
        /* MODERATOR CHAT MESSAGE   */
        /* ----------------------- */

        if (
          type ===
          "moderatorChat"
        ) {

          if (
            !canModerate(client)
          ) {
            return;
          }

          if (
            !client.moderatorRoomCode
          ) {
            return;
          }

          const room =
            rooms.get(
              client.moderatorRoomCode
            );

          if (!room) {
            return;
          }

          const text =
            cleanChatMessage(
              message.message
            );

          if (!text) {
            return;
          }

          /*
           * Moderator chat messages are
           * intentionally not sent to normal
           * users in this version.
           *
           * They are sent to other moderators
           * watching the same room.
           */
          const chatMessage = {
            id:
              makeId("modmsg"),
            userId:
              client.id,
            name:
              client.name,
            moderator: true,
            message:
              text,
            createdAt:
              Date.now()
          };

          for (
            const other of
            clients.values()
          ) {

            if (
              other.role === "moderator" &&
              other.moderatorRoomCode ===
                room.code
            ) {

              send(
                other.ws,
                {
                  type:
                    "moderatorChatMessage",
                  message:
                    chatMessage
                }
              );
            }
          }

          return;
        }


        /* ----------------------- */
        /* KICK                     */
        /* ----------------------- */

        if (
          type ===
          "kick"
        ) {

          if (
            !canModerate(client)
          ) {
            return;
          }

          const target =
            clients.get(
              String(
                message.userId || ""
              )
            );

          if (
            !canControlTarget(
              client,
              target
            )
          ) {
            return;
          }

          if (
            !target.roomCode
          ) {
            return;
          }

          const room =
            rooms.get(
              target.roomCode
            );

          if (!room) {
            return;
          }

          addLog(
            "Kick",
            client,
            target
          );

          send(
            target.ws,
            {
              type: "kicked",
              message:
                "You were kicked from the room by a moderator."
            }
          );

          removeFromRoom(
            target
          );

          return;
        }


        /* ----------------------- */
        /* BAN                      */
        /* ----------------------- */

        if (
          type ===
          "ban"
        ) {

          if (
            !canModerate(client)
          ) {
            return;
          }

          const target =
            clients.get(
              String(
                message.userId || ""
              )
            );

          if (
            !canControlTarget(
              client,
              target
            )
          ) {
            return;
          }

          const permanent =
            Boolean(
              message.permanent
            );

          const expiresAt =
            calculateDuration(
              message.amount,
              message.unit,
              permanent
            );

          const durationText =
            formatDuration(
              message.amount,
              message.unit,
              permanent
            );

          const ban = {
            id:
              makeId("ban"),
            userId:
              target.id,
            name:
              target.name,
            moderatorId:
              client.id,
            moderatorName:
              client.name,
            createdAt:
              Date.now(),
            expiresAt,
            durationText
          };

          bannedUsers.set(
            ban.id,
            ban
          );

          addLog(
            "Ban",
            client,
            target,
            {
              durationText
            }
          );

          send(
            target.ws,
            {
              type: "banned",
              message:
                permanent
                  ? "You were permanently banned."
                  : `You were banned for ${durationText}.`
            }
          );

          removeFromRoom(
            target
          );

          try {
            target.ws.close();
          }

          catch {}

          broadcastModeratorData();

          return;
        }


        /* ----------------------- */
        /* UNBAN                    */
        /* ----------------------- */

        if (
          type ===
          "unban"
        ) {

          if (
            !canModerate(client)
          ) {
            return;
          }

          const ban =
            bannedUsers.get(
              String(
                message.banId || ""
              )
            );

          if (!ban) {
            return;
          }

          bannedUsers.delete(
            ban.id
          );

          addLog(
            "Unban",
            client,
            {
              id:
                ban.userId,
              name:
                ban.name
            }
          );

          broadcastModeratorData();

          return;
        }


        /* ----------------------- */
        /* GIVE MODERATOR           */
        /* ----------------------- */

        if (
          type ===
          "giveModerator"
        ) {

          if (
            !isMasterModerator(client)
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
              String(
                message.userId || ""
              )
            );

          if (!target) {
            return;
          }

          if (
            target.role !== "user"
          ) {
            return;
          }

          const pin =
            cleanPin(
              message.pin
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

          /*
           * Do not allow duplicate PINs.
           */
          if (
            pin === MASTER_PIN ||
            getModeratorAccessByPin(pin)
          ) {
            send(ws, {
              type: "error",
              message:
                "That PIN is already in use."
            });

            return;
          }

          const permanent =
            Boolean(
              message.permanent
            );

          const expiresAt =
            calculateDuration(
              message.amount,
              message.unit,
              permanent
            );

          const durationText =
            formatDuration(
              message.amount,
              message.unit,
              permanent
            );

          const access = {
            id:
              makeId("modaccess"),
            pinHash:
              hashPin(pin),
            name:
              target.name,
            targetUserId:
              target.id,
            createdBy:
              client.name,
            createdAt:
              Date.now(),
            expiresAt,
            durationText
          };

          moderatorAccess.set(
            access.id,
            access
          );

          /*
           * Tell the master the PIN was
           * successfully created.
           */
          send(ws, {
            type:
              "moderatorAccessCreated",
            access: {
              id:
                access.id,
              name:
                access.name,
              targetUserId:
                access.targetUserId,
              createdBy:
                access.createdBy,
              createdAt:
                access.createdAt,
              expiresAt:
                access.expiresAt,
              durationText:
                access.durationText,
              pin
            }
          });

          /*
           * Tell the target they have been
           * granted moderator access.
           */
          send(
            target.ws,
            {
              type:
                "moderatorAccessGranted",
              pin,
              durationText,
              expiresAt
            }
          );

          addLog(
            "Give Moderator",
            client,
            target,
            {
              durationText
            }
          );

          broadcastModeratorData();

          return;
        }


        /* ----------------------- */
        /* REVOKE MODERATOR         */
        /* ----------------------- */

        if (
          type ===
          "revokeModerator"
        ) {

          if (
            !isMasterModerator(client)
          ) {
            return;
          }

          const access =
            moderatorAccess.get(
              String(
                message.accessId || ""
              )
            );

          if (!access) {
            return;
          }

          moderatorAccess.delete(
            access.id
          );

          for (
            const moderator of
            clients.values()
          ) {

            if (
              moderator.role ===
                "moderator" &&
              moderator.moderatorAccessId ===
                access.id
            ) {

              send(
                moderator.ws,
                {
                  type:
                    "moderatorAccessRevoked",
                  message:
                    "Your moderator access has been revoked."
                }
              );

              moderator.moderatorRoomCode =
                null;

              try {
                moderator.ws.close();
              }

              catch {}
            }
          }

          addLog(
            "Revoke Moderator",
            client,
            {
              id:
                access.targetUserId,
              name:
                access.name
            }
          );

          broadcastModeratorData();

          return;
        }


        /* ----------------------- */
        /* MODERATOR DATA           */
        /* ----------------------- */

        if (
          type ===
          "getModeratorData"
        ) {

          if (
            !canModerate(client)
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

        if (!client) {
          return;
        }

        if (
          client.role ===
          "moderator"
        ) {

          clients.delete(
            client.id
          );

          broadcastModeratorData();

          return;
        }

        removeFromRoom(
          client
        );

        clients.delete(
          client.id
        );

        broadcastRoomList();
      }
    );

  }
);


/* ----------------------------- */
/* CLEANUP                       */
/* ----------------------------- */

setInterval(
  () => {

    cleanExpiredBans();
    cleanExpiredModeratorAccess();

    /*
     * Remove empty rooms.
     */
    for (const room of rooms.values()) {
      if (
        room.users.size === 0
      ) {
        rooms.delete(
          room.code
        );
      }
    }

    broadcastRoomList();

  },
  5000
);


server.listen(
  PORT,
  () => {
    console.log(
      `Blueberry Video Chat running on port ${PORT}`
    );
  }
);

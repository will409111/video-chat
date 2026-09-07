const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

/*
 * MASTER MODERATOR PIN
 * Keep this only in server.js.
 */
const MASTER_PIN = "230323038227";

const rooms = new Map();
const clients = new Map();
const bannedUsers = new Map();
const moderatorAccess = new Map();
const moderationLog = [];

const BAN_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const BAN_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function makeId() {
  return crypto.randomBytes(16).toString("hex");
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
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
    .slice(0, 40) || "Untitled Room";
}

function cleanRoomCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 12);
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

function addLog(action, moderator, target, details = {}) {
  moderationLog.unshift({
    id: makeId(),
    action,
    moderatorId: moderator?.id || null,
    moderatorName: moderator?.name || "Unknown Moderator",
    targetId: target?.id || details.targetId || null,
    targetName: target?.name || details.targetName || "Unknown User",
    durationMs: details.durationMs ?? null,
    durationText: details.durationText || null,
    createdAt: Date.now()
  });

  if (moderationLog.length > 500) {
    moderationLog.length = 500;
  }

  broadcastModeratorData();
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) {
    return "Permanent";
  }

  if (ms <= 0) {
    return "Permanent";
  }

  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  const days = Math.floor(hours / 24);

  if (days < 7) {
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  const weeks = Math.floor(days / 7);

  if (days < 30) {
    return `${weeks} week${weeks === 1 ? "" : "s"}`;
  }

  const months = Math.floor(days / 30);

  if (days < 365) {
    return `${months} month${months === 1 ? "" : "s"}`;
  }

  const years = Math.floor(days / 365);

  return `${years} year${years === 1 ? "" : "s"}`;
}

function calculateDuration(message) {
  const seconds = Math.max(
    0,
    Number(message.seconds) || 0
  );

  const minutes = Math.max(
    0,
    Number(message.minutes) || 0
  );

  const hours = Math.max(
    0,
    Number(message.hours) || 0
  );

  const days = Math.max(
    0,
    Number(message.days) || 0
  );

  const weeks = Math.max(
    0,
    Number(message.weeks) || 0
  );

  const months = Math.max(
    0,
    Number(message.months) || 0
  );

  const years = Math.max(
    0,
    Number(message.years) || 0
  );

  const total =
    seconds * 1000 +
    minutes * 60 * 1000 +
    hours * 60 * 60 * 1000 +
    days * 24 * 60 * 60 * 1000 +
    weeks * 7 * 24 * 60 * 60 * 1000 +
    months * BAN_MONTH_MS +
    years * BAN_YEAR_MS;

  return total;
}

function cleanExpiredModeratorAccess() {
  const now = Date.now();

  for (const [id, access] of moderatorAccess) {
    if (
      access.expiresAt !== null &&
      access.expiresAt <= now
    ) {
      moderatorAccess.delete(id);
    }
  }
}

function cleanExpiredBans() {
  const now = Date.now();

  for (const [userId, ban] of bannedUsers) {
    if (
      ban.expiresAt !== null &&
      ban.expiresAt <= now
    ) {
      bannedUsers.delete(userId);
    }
  }
}

function getBan(userId) {
  cleanExpiredBans();
  return bannedUsers.get(userId) || null;
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
  return Array.from(rooms.values())
    .map(getRoomInfo);
}

function getBanList() {
  cleanExpiredBans();

  return Array.from(bannedUsers.values())
    .map(ban => ({
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

  return Array.from(moderatorAccess.values())
    .map(access => ({
      id: access.id,
      name: access.name,
      createdBy: access.createdBy,
      createdAt: access.createdAt,
      expiresAt: access.expiresAt,
      durationText: access.durationText,
      active: true
    }));
}

function getModeratorLog() {
  return moderationLog.map(item => ({
    ...item
  }));
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

function broadcastModeratorData() {
  cleanExpiredModeratorAccess();
  cleanExpiredBans();

  const data = {
    type: "moderatorData",
    rooms: getRoomList(),
    bans: getBanList(),
    moderatorAccess: getModeratorAccessList(),
    logs: getModeratorLog()
  };

  for (const client of clients.values()) {
    if (client.role === "moderator") {
      send(client.ws, data);
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

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code;

  do {
    code = "";

    for (let i = 0; i < 5; i++) {
      code += chars[
        Math.floor(Math.random() * chars.length)
      ];
    }
  } while (rooms.has(code));

  return code;
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
  broadcastModeratorData();
}

function joinRoom(client, roomCode, anonymous = false) {
  const ban = getBan(client.id);

  if (ban) {
    send(client.ws, {
      type: "banned",
      message: `You are banned${ban.expiresAt ? ` for ${ban.durationText}` : ""}.`
    });

    return false;
  }

  const room = rooms.get(roomCode);

  if (!room) {
    send(client.ws, {
      type: "error",
      message: "That room does not exist."
    });

    return false;
  }

  if (client.room) {
    removeFromRoom(client);
  }

  const existingUsers =
    Array.from(room.users)
      .map(id => clients.get(id))
      .filter(Boolean)
      .filter(user => user.id !== client.id)
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
  broadcastModeratorData();

  return true;
}

function canModerate(client) {
  return (
    client &&
    client.id &&
    client.role === "moderator"
  );
}

function isMasterModerator(client) {
  return (
    client &&
    client.role === "moderator" &&
    client.moderatorLevel === "master"
  );
}

function canControlTarget(client, target) {
  if (!target) {
    return false;
  }

  if (target.id === client.id) {
    return false;
  }

  /*
   * Delegated moderators cannot kick or ban
   * other moderators.
   */
  if (
    client.moderatorLevel !== "master" &&
    target.role === "moderator"
  ) {
    return false;
  }

  return true;
}

const server = http.createServer(
  (req, res) => {
    let fileName;

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
  }
);

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

wss.on(
  "connection",
  ws => {
    const client = {
      ws,
      id: null,
      name: "Guest",
      role: "user",
      moderatorLevel: null,
      moderatorAccessId: null,
      room: null,
      anonymous: false,
      authenticated: false
    };

    ws.on(
      "message",
      raw => {
        let message;

        try {
          message = JSON.parse(
            raw.toString()
          );
        }

        catch {
          return;
        }

        switch (message.type) {

          /*
           * NORMAL USER REGISTRATION
           */
          case "register": {
            const newId = String(
              message.id || makeId()
            );

            const ban = getBan(newId);

            if (ban) {
              send(ws, {
                type: "banned",
                message: `You are banned${ban.expiresAt ? ` for ${ban.durationText}` : ""}.`
              });

              ws.close();
              return;
            }

            const oldClient =
              clients.get(newId);

            if (
              oldClient &&
              oldClient.ws !== ws
            ) {
              removeFromRoom(oldClient);

              try {
                oldClient.ws.close();
              }

              catch {}

              clients.delete(newId);
            }

            client.id = newId;
            client.name = cleanName(
              message.name
            );
            client.role = "user";
            client.moderatorLevel = null;
            client.authenticated = true;

            clients.set(
              client.id,
              client
            );

            send(ws, {
              type: "registered",
              userId: client.id
            });

            broadcastRoomList();

            break;
          }

          /*
           * MODERATOR LOGIN
           *
           * Master PIN:
           * 230323038227
           *
           * Or a temporary delegated PIN.
           */
          case "moderatorAuth": {
            const pin = cleanPin(
              message.pin
            );

            if (!pin) {
              send(ws, {
                type: "moderatorAuthFailed",
                message: "Enter a moderator PIN."
              });

              return;
            }

            let level = null;
            let access = null;

            if (pin === MASTER_PIN) {
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
                type: "moderatorAuthFailed",
                message: "Invalid or expired moderator PIN."
              });

              return;
            }

            const requestedId =
              String(
                message.id ||
                makeId()
              );

            const oldClient =
              clients.get(requestedId);

            if (
              oldClient &&
              oldClient.ws !== ws
            ) {
              removeFromRoom(oldClient);

              try {
                oldClient.ws.close();
              }

              catch {}

              clients.delete(
                requestedId
              );
            }

            client.id = requestedId;

            client.name = cleanName(
              message.name ||
              access?.name ||
              "Moderator"
            );

            client.role = "moderator";
            client.moderatorLevel = level;
            client.moderatorAccessId =
              access?.id || null;
            client.authenticated = true;

            clients.set(
              client.id,
              client
            );

            send(ws, {
              type: "moderatorAuthSuccess",

              moderator: {
                id: client.id,
                name: client.name,
                level,
                accessId:
                  client.moderatorAccessId
              },

              rooms: getRoomList(),
              bans: getBanList(),
              moderatorAccess:
                getModeratorAccessList(),
              logs: getModeratorLog()
            });

            broadcastModeratorData();

            break;
          }

          case "setName": {
            if (!client.id) {
              return;
            }

            client.name = cleanName(
              message.name
            );

            if (client.room) {
              const room =
                rooms.get(
                  client.room
                );

              if (room) {
                for (
                  const id of room.users
                ) {
                  if (
                    id === client.id
                  ) {
                    continue;
                  }

                  const other =
                    clients.get(id);

                  if (other) {
                    send(
                      other.ws,
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
              }
            }

            broadcastRoomList();
            broadcastModeratorData();

            break;
          }

          /*
           * NORMAL USER CREATE ROOM
           */
          case "createRoom": {
            if (!client.id) {
              return;
            }

            const room =
              createRoom(
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

            joinRoom(
              client,
              room.code,
              false
            );

            break;
          }

          /*
           * MODERATOR CREATE ROOM
           */
          case "moderatorCreateRoom": {
            if (!canModerate(client)) {
              return;
            }

            const room =
              createRoom(
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

            if (message.join !== false) {
              joinRoom(
                client,
                room.code,
                !!message.anonymous
              );
            }

            else {
              broadcastRoomList();
              broadcastModeratorData();
            }

            break;
          }

          case "joinRoom": {
            if (!client.id) {
              return;
            }

            joinRoom(
              client,
              cleanRoomCode(
                message.code
              ),
              false
            );

            break;
          }

          case "moderatorJoinRoom": {
            if (!canModerate(client)) {
              return;
            }

            joinRoom(
              client,
              cleanRoomCode(
                message.code
              ),
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

          /*
           * WEBRTC SIGNALING
           */
          case "signal": {
            if (!client.id) {
              return;
            }

            const target =
              clients.get(
                message.target
              );

            if (!target) {
              return;
            }

            if (
              !client.room ||
              client.room !==
                target.room
            ) {
              return;
            }

            send(
              target.ws,
              {
                type: "signal",
                from: client.id,
                data: message.data
              }
            );

            break;
          }

          /*
           * KICK
           */
          case "kick": {
            if (!canModerate(client)) {
              return;
            }

            const target =
              clients.get(
                message.userId
              );

            if (!canControlTarget(
              client,
              target
            )) {
              return;
            }

            if (
              !client.room ||
              target.room !== client.room
            ) {
              return;
            }

            addLog(
              "kick",
              client,
              target
            );

            send(
              target.ws,
              {
                type: "kicked",
                message:
                  `You were kicked by ${client.name}.`
              }
            );

            removeFromRoom(target);

            break;
          }

          /*
           * BAN
           */
          case "ban": {
            if (!canModerate(client)) {
              return;
            }

            const target =
              clients.get(
                message.userId
              );

            if (!canControlTarget(
              client,
              target
            )) {
              return;
            }

            const duration =
              calculateDuration(
                message
              );

            const permanent =
              !!message.permanent ||
              duration <= 0;

            const expiresAt =
              permanent
                ? null
                : Date.now() + duration;

            const durationText =
              permanent
                ? "Permanent"
                : formatDuration(duration);

            const ban = {
              id: makeId(),
              userId: target.id,
              name: target.name,
              moderatorId: client.id,
              moderatorName: client.name,
              createdAt: Date.now(),
              expiresAt,
              durationText
            };

            bannedUsers.set(
              target.id,
              ban
            );

            addLog(
              "ban",
              client,
              target,
              {
                durationMs:
                  permanent
                    ? null
                    : duration,

                durationText
              }
            );

            send(
              target.ws,
              {
                type: "banned",
                message:
                  `You were banned by ${client.name}. Ban duration: ${durationText}.`
              }
            );

            removeFromRoom(target);

            /*
             * A ban immediately disconnects
             * the target so they cannot simply
             * join another room.
             */
            try {
              target.ws.close();
            }

            catch {}

            break;
          }

          /*
           * UNBAN
           */
          case "unban": {
            if (!canModerate(client)) {
              return;
            }

            const banId =
              String(
                message.banId || ""
              );

            let removed = null;

            for (
              const [userId, ban]
              of bannedUsers
            ) {
              if (
                ban.id === banId
              ) {
                removed = ban;
                bannedUsers.delete(
                  userId
                );
                break;
              }
            }

            if (!removed) {
              send(ws, {
                type: "error",
                message:
                  "That ban no longer exists."
              });

              return;
            }

            addLog(
              "unban",
              client,
              null,
              {
                targetId:
                  removed.userId,
                targetName:
                  removed.name,
                durationText:
                  removed.durationText
              }
            );

            broadcastModeratorData();

            break;
          }

          /*
           * GIVE MODERATOR ACCESS
           *
           * ONLY THE MASTER MODERATOR
           * CAN DO THIS.
           */
          case "giveModerator": {
            if (!isMasterModerator(client)) {
              send(ws, {
                type: "error",
                message:
                  "Only the master moderator can give moderator access."
              });

              return;
            }

            const target =
              clients.get(
                message.userId
              );

            if (!target) {
              send(ws, {
                type: "error",
                message:
                  "That user is no longer connected."
              });

              return;
            }

            if (
              target.role === "moderator"
            ) {
              send(ws, {
                type: "error",
                message:
                  "That person is already a moderator."
              });

              return;
            }

            const pin =
              cleanPin(
                message.pin
              );

            if (
              !pin ||
              pin.length < 4
            ) {
              send(ws, {
                type: "error",
                message:
                  "The moderator PIN must be at least 4 characters."
              });

              return;
            }

            const duration =
              calculateDuration(
                message
              );

            const permanent =
              !!message.permanent ||
              duration <= 0;

            const expiresAt =
              permanent
                ? null
                : Date.now() + duration;

            /*
             * Do not store the actual PIN.
             */
            const access = {
              id: makeId(),
              pinHash: hashPin(pin),
              name: target.name,
              targetUserId: target.id,
              createdBy:
                client.name,
              createdAt: Date.now(),
              expiresAt,
              durationText:
                permanent
                  ? "Permanent"
                  : formatDuration(duration)
            };

            /*
             * If this PIN is already in use,
             * reject it.
             */
            if (
              getModeratorAccessByPin(pin)
            ) {
              send(ws, {
                type: "error",
                message:
                  "That moderator PIN is already being used. Choose another PIN."
              });

              return;
            }

            moderatorAccess.set(
              access.id,
              access
            );

            send(ws, {
              type: "moderatorAccessCreated",
              name: target.name,
              durationText:
                access.durationText
            });

            /*
             * Tell the selected user that
             * the moderator PIN has been
             * created for them.
             */
            send(
              target.ws,
              {
                type:
                  "moderatorAccessGranted",

                message:
                  `You have been given moderator access for ${access.durationText}. The person who gave you access must give you your moderator PIN.`
              }
            );

            addLog(
              "moderator_granted",
              client,
              target,
              {
                durationMs:
                  permanent
                    ? null
                    : duration,

                durationText:
                  access.durationText
              }
            );

            break;
          }

          /*
           * REVOKE TEMPORARY MODERATOR ACCESS
           */
          case "revokeModerator": {
            if (!isMasterModerator(client)) {
              send(ws, {
                type: "error",
                message:
                  "Only the master moderator can revoke moderator access."
              });

              return;
            }

            const accessId =
              String(
                message.accessId || ""
              );

            const access =
              moderatorAccess.get(
                accessId
              );

            if (!access) {
              send(ws, {
                type: "error",
                message:
                  "That moderator access no longer exists."
              });

              return;
            }

            moderatorAccess.delete(
              accessId
            );

            /*
             * If they are currently connected
             * as a delegated moderator, disconnect
             * their moderator session.
             */
            for (const connected
              of clients.values()) {

              if (
                connected.moderatorAccessId ===
                accessId
              ) {
                send(
                  connected.ws,
                  {
                    type:
                      "moderatorAccessRevoked",
                    message:
                      "Your moderator access has been revoked."
                  }
                );

                try {
                  connected.ws.close();
                }

                catch {}
              }
            }

            addLog(
              "moderator_revoked",
              client,
              null,
              {
                targetId:
                  access.targetUserId,
                targetName:
                  access.name,
                durationText:
                  access.durationText
              }
            );

            broadcastModeratorData();

            break;
          }

          /*
           * REQUEST ALL MODERATOR DATA
           */
          case "getModeratorData": {
            if (!canModerate(client)) {
              return;
            }

            send(ws, {
              type: "moderatorData",
              rooms: getRoomList(),
              bans: getBanList(),
              moderatorAccess:
                getModeratorAccessList(),
              logs: getModeratorLog()
            });

            break;
          }

          default:
            break;
        }
      }
    );

    ws.on(
      "close",
      () => {
        if (
          client.id &&
          clients.get(client.id)?.ws === ws
        ) {
          removeFromRoom(client);

          clients.delete(
            client.id
          );

          broadcastRoomList();
          broadcastModeratorData();
        }
      }
    );

    ws.on(
      "error",
      error => {
        console.error(
          "WebSocket error:",
          error
        );
      }
    );
  }
);

/*
 * Periodically remove expired bans
 * and expired moderator access.
 */
setInterval(
  () => {
    cleanExpiredBans();
    cleanExpiredModeratorAccess();

    broadcastModeratorData();
  },
  5000
);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Server running on port " +
      PORT
    );
  }
);

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

// Active rooms
const rooms = new Map();

// Connected clients
const clients = new Map();

// Temporary bans
const bannedUsers = new Set();


// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer((req, res) => {

    // Health check
    if (req.url === "/health") {

        res.writeHead(200, {
            "Content-Type": "text/plain"
        });

        res.end("Video chat server is running.");

        return;
    }


    let fileName = "index.html";


    if (
        req.url === "/moderator" ||
        req.url === "/moderator.html"
    ) {

        fileName = "moderator.html";
    }


    if (
        req.url === "/" ||
        req.url === "/index.html"
    ) {

        fileName = "index.html";
    }


    const filePath =
        path.join(
            __dirname,
            fileName
        );


    fs.readFile(
        filePath,
        (error, data) => {

            if (error) {

                res.writeHead(404, {
                    "Content-Type":
                        "text/plain"
                });

                res.end("File not found.");

                return;
            }


            res.writeHead(200, {
                "Content-Type":
                    "text/html; charset=utf-8",

                "Cache-Control":
                    "no-cache"
            });


            res.end(data);
        }
    );
});


// ======================================================
// WEBSOCKET SERVER
// ======================================================

const wss =
    new WebSocket.Server({
        server: server,
        path: "/ws"
    });


// ======================================================
// SEND MESSAGE
// ======================================================

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


// ======================================================
// GENERATE ID
// ======================================================

function generateId() {

    return crypto.randomUUID();
}


// ======================================================
// GENERATE ROOM CODE
// ======================================================

function generateRoomCode() {

    const characters =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;


    do {

        code = "";

        for (
            let i = 0;
            i < 5;
            i++
        ) {

            code +=
                characters[
                    Math.floor(
                        Math.random() *
                        characters.length
                    )
                ];
        }

    } while (
        rooms.has(code)
    );


    return code;
}


// ======================================================
// CREATE ROOM
// ======================================================

function createRoom() {

    const code =
        generateRoomCode();


    rooms.set(
        code,
        {
            code: code,

            users: new Map(),

            createdAt: Date.now()
        }
    );


    console.log(
        "Room created:",
        code
    );


    return code;
}


// ======================================================
// GET ROOM LIST
// ======================================================

function getRoomList() {

    const list = [];


    for (
        const [code, room]
        of rooms
    ) {

        const users = [];


        for (
            const client
            of room.users.values()
        ) {

            users.push({

                id: client.id,

                role: client.role,

                anonymous:
                    client.anonymous ||
                    false
            });
        }


        list.push({

            code: code,

            users: users,

            userCount:
                users.length,

            createdAt:
                room.createdAt
        });
    }


    return list;
}


// ======================================================
// SEND ROOM LIST TO EVERY MODERATOR
// ======================================================

function broadcastRooms() {

    const roomList =
        getRoomList();


    for (
        const client
        of clients.values()
    ) {

        if (
            client.role ===
            "moderator"
        ) {

            send(
                client.ws,
                {
                    type:
                        "roomsUpdated",

                    rooms:
                        roomList
                }
            );
        }
    }
}


// ======================================================
// REMOVE CLIENT FROM ROOM
// ======================================================

function removeFromRoom(client) {

    if (!client.room) {
        return;
    }


    const room =
        rooms.get(
            client.room
        );


    if (!room) {

        client.room = null;

        return;
    }


    room.users.delete(
        client.id
    );


    // Tell everybody remaining
    // that this user left.

    for (
        const other
        of room.users.values()
    ) {

        send(
            other.ws,
            {
                type:
                    "userLeft",

                id:
                    client.id
            }
        );
    }


    console.log(
        client.id,
        "left room",
        room.code
    );


    client.room = null;


    /*
        IMPORTANT:

        If nobody is left,
        completely delete the room.
    */

    if (
        room.users.size === 0
    ) {

        console.log(
            "Deleting empty room:",
            room.code
        );

        rooms.delete(
            room.code
        );
    }


    broadcastRooms();
}


// ======================================================
// ADD CLIENT TO ROOM
// ======================================================

function addToRoom(
    client,
    roomCode
) {

    if (
        bannedUsers.has(
            client.id
        )
    ) {

        send(
            client.ws,
            {
                type:
                    "banned"
            }
        );

        return false;
    }


    const room =
        rooms.get(
            roomCode
        );


    if (!room) {

        send(
            client.ws,
            {
                type:
                    "error",

                message:
                    "That room does not exist."
            }
        );

        return false;
    }


    // Leave old room first.
    removeFromRoom(client);


    /*
        Get everybody who was already
        in the room.
    */

    const existingUsers =
        Array.from(
            room.users.keys()
        );


    room.users.set(
        client.id,
        client
    );


    client.room =
        roomCode;


    send(
        client.ws,
        {
            type:
                "roomJoined",

            room:
                roomCode,

            users:
                existingUsers
        }
    );


    /*
        Tell existing users about
        the new person.
    */

    for (
        const other
        of room.users.values()
    ) {

        if (
            other.id !==
            client.id
        ) {

            send(
                other.ws,
                {
                    type:
                        "userJoined",

                    id:
                        client.id,

                    role:
                        client.role,

                    anonymous:
                        client.anonymous ||
                        false
                }
            );
        }
    }


    broadcastRooms();

    return true;
}


// ======================================================
// WEBSOCKET CONNECTION
// ======================================================

wss.on(
    "connection",
    (ws) => {

        const client = {

            ws: ws,

            id: null,

            role: "user",

            room: null,

            anonymous: false,

            connectedAt:
                Date.now()
        };


        // ==============================================
        // MESSAGE
        // ==============================================

        ws.on(
            "message",
            (raw) => {

                let message;


                try {

                    message =
                        JSON.parse(
                            raw.toString()
                        );

                } catch {

                    return;
                }


                // ==========================================
                // REGISTER
                // ==========================================

                if (
                    message.type ===
                    "register"
                ) {

                    client.id =
                        String(
                            message.id ||
                            generateId()
                        );


                    client.role =
                        message.role ===
                        "moderator"
                            ? "moderator"
                            : "user";


                    clients.set(
                        client.id,
                        client
                    );


                    console.log(
                        "Connected:",
                        client.id,
                        client.role
                    );


                    /*
                        THIS IS THE IMPORTANT PART.

                        When the moderator opens their
                        HTML, the server sends ALL rooms
                        currently existing.

                        It doesn't matter whether those
                        rooms were created before the
                        moderator opened the page.
                    */

                    if (
                        client.role ===
                        "moderator"
                    ) {

                        send(
                            ws,
                            {
                                type:
                                    "roomList",

                                rooms:
                                    getRoomList()
                            }
                        );
                    }


                    return;
                }


                // ==========================================
                // NORMAL USER CREATE ROOM
                // ==========================================

                if (
                    message.type ===
                    "createRoom"
                ) {

                    const code =
                        createRoom();


                    send(
                        ws,
                        {
                            type:
                                "roomCreated",

                            room:
                                code
                        }
                    );


                    broadcastRooms();

                    return;
                }


                // ==========================================
                // NORMAL USER JOIN
                // ==========================================

                if (
                    message.type ===
                    "joinRoom"
                ) {

                    if (!client.id) {
                        return;
                    }


                    addToRoom(
                        client,
                        String(
                            message.room
                        ).toUpperCase()
                    );


                    return;
                }


                // ==========================================
                // MODERATOR CREATE ROOM
                // ==========================================

                if (
                    message.type ===
                    "moderatorCreateRoom"
                ) {

                    if (
                        client.role !==
                        "moderator"
                    ) {

                        return;
                    }


                    const code =
                        createRoom();


                    send(
                        ws,
                        {
                            type:
                                "roomCreated",

                            room:
                                code
                        }
                    );


                    broadcastRooms();

                    return;
                }


                // ==========================================
                // MODERATOR JOIN
                // ==========================================

                if (
                    message.type ===
                    "moderatorJoinRoom"
                ) {

                    if (
                        client.role !==
                        "moderator"
                    ) {

                        return;
                    }


                    client.anonymous =
                        Boolean(
                            message.anonymous
                        );


                    addToRoom(
                        client,
                        String(
                            message.room
                        ).toUpperCase()
                    );


                    return;
                }


                // ==========================================
                // LEAVE
                // ==========================================

                if (
                    message.type ===
                    "leaveRoom"
                ) {

                    removeFromRoom(
                        client
                    );

                    return;
                }


                // ==========================================
                // WEBRTC SIGNALING
                // ==========================================

                if (
                    message.type ===
                    "signal"
                ) {

                    const target =
                        clients.get(
                            String(
                                message.to
                            )
                        );


                    if (!target) {
                        return;
                    }


                    /*
                        The server does NOT handle
                        the video.

                        It only forwards WebRTC
                        signaling information.
                    */

                    send(
                        target.ws,
                        {
                            type:
                                "signal",

                            from:
                                client.id,

                            to:
                                target.id,

                            signal:
                                message.signal
                        }
                    );


                    return;
                }


                // ==========================================
                // KICK
                // ==========================================

                if (
                    message.type ===
                    "kick"
                ) {

                    if (
                        client.role !==
                        "moderator"
                    ) {

                        return;
                    }


                    const target =
                        clients.get(
                            String(
                                message.userId
                            )
                        );


                    if (!target) {
                        return;
                    }


                    send(
                        target.ws,
                        {
                            type:
                                "kicked"
                        }
                    );


                    removeFromRoom(
                        target
                    );


                    return;
                }


                // ==========================================
                // BAN
                // ==========================================

                if (
                    message.type ===
                    "ban"
                ) {

                    if (
                        client.role !==
                        "moderator"
                    ) {

                        return;
                    }


                    const target =
                        clients.get(
                            String(
                                message.userId
                            )
                        );


                    if (!target) {
                        return;
                    }


                    bannedUsers.add(
                        target.id
                    );


                    send(
                        target.ws,
                        {
                            type:
                                "banned"
                        }
                    );


                    removeFromRoom(
                        target
                    );


                    return;
                }
            }
        );


        // ==============================================
        // DISCONNECTED
        // ==============================================

        ws.on(
            "close",
            () => {

                console.log(
                    "Disconnected:",
                    client.id
                );


                removeFromRoom(
                    client
                );


                if (
                    client.id
                ) {

                    clients.delete(
                        client.id
                    );
                }


                broadcastRooms();
            }
        );
    }
);


// ======================================================
// START
// ======================================================

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "================================="
        );

        console.log(
            "Video Chat Server Started"
        );

        console.log(
            "Port:",
            PORT
        );

        console.log(
            "================================="
        );
    }
);

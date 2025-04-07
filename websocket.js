const socketIO = require("socket.io");
const randomstring = require("randomstring");
const jwt = require("jsonwebtoken");
const { processWs } = require("./helpers/ws/ws");

// Store all Socket.IO connections in a Map
const connections = new Map();

/**
 * Initialize Socket.IO server
 * @param {Object} server - HTTP server instance
 */
function initializeWebSocket(server) {
  const io = socketIO(server, {
    cors: {
      origin: process.env.FRONTENDURI,
      methods: ["GET", "POST"],
    },
  });

  const jwtSecret = process.env.JWTKEY;

  // Middleware for authentication
  io.use((socket, next) => {
    const { token, agent } = socket.handshake.query;
    console.log({ agent });

    if (!token) return next(new Error("Unauthorized"));

    try {
      let user = jwt.verify(token, jwtSecret);
      if (agent === "true") {
        user = { ...user, uid: user?.owner_uid, agent_uid: user?.uid };
      }
      socket.user = user;
      next();
    } catch (error) {
      return next(new Error("Forbidden"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.user;
    const id = randomstring.generate(12);

    // Initialize inboxContent with default values
    const inboxContent = {
      chatList: [],
      conversation: [],
      socket: null,
      connected: true,
      connectionId: id,
      openedChatData: {},
      inboxState: { max: 20, maxCon: 79 },
      userData: {},
    };

    connections.set(id, { socket, ...user, inboxContent });

    console.log(`New connection initialized with ID: ${id}, UID: ${user.uid}`);

    // Emit connection ID to the client
    socket.emit("connection_id", {
      message: "Connected successfully",
      id,
      ...user,
    });

    // Handle incoming messages
    socket.on("message", (data) => {
      const { action, payload } = data;

      if (action === "update_inbox_content") {
        const connection = connections.get(id);
        if (connection) {
          connection.inboxContent = { ...connection.inboxContent, ...payload };
        }
      }

      if (events[action]) {
        events[action](id, user.uid, payload, socket, user);
      }
    });

    // Handle disconnection
    socket.on("disconnect", () => {
      connections.delete(id);
      console.log(`Connection closed with ID: ${id}, UID: ${user.uid}`);
    });
  });

  return io;
}

/**
 * Parse a message and return an object
 * @param {string} message - Raw Socket.IO message
 * @returns {Object|null} - Parsed message object
 */
function parseMessage(message) {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

// Object to store event handlers
const events = {};

/**
 * Register an event handler
 * @param {string} action - Action name
 * @param {Function} handler - Event handler function (id, uid, payload, socket, user)
 */
function on(action, handler) {
  events[action] = handler;
}

/**
 * Send a message to a specific client by ID
 * @param {string} id - Client ID
 * @param {Object} data - Data to send
 */
function sendToClientById(id, data = {}) {
  const connection = connections.get(id);
  if (connection) {
    connection.socket.emit("message", data);
  } else {
    console.error(`Connection with ID ${id} not found.`);
  }
}

/**
 * Send a message to all clients associated with a specific UID
 * @param {string} uid - Client UID
 * @param {Object} data - Data to send
 */
function sendToClientByUid(uid, data = {}) {
  connections.forEach((connection) => {
    if (connection.uid === uid) {
      connection.socket.emit("message", data);
    }
  });
}

/**
 * Broadcast a message to all connected clients
 * @param {Object} data - Data to send
 */
function broadcast(data = {}) {
  connections.forEach(({ socket }) => {
    socket.emit("message", data);
  });
}

/**
 * Get all connected clients
 * @returns {Array} - Array of connected client info
 */
function getConnectedClients() {
  return Array.from(connections.entries()).map(([id, connection]) => ({
    id,
    ...connection,
  }));
}

/**
 * Get connections by UID
 * @param {string} uid - User ID
 * @returns {Array} - Array of connection info
 */
function getConnectionsByUid(uid) {
  return getConnectedClients()?.filter((x) => x.uid === uid);
}

// Hook in processWs handlers
processWs({
  on,
  sendToClientById,
  sendToClientByUid,
  getConnectionsByUid,
});

module.exports = {
  initializeWebSocket,
  on,
  sendToClientById,
  sendToClientByUid,
  broadcast,
  getConnectedClients,
  getConnectionsByUid,
};

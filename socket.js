// socket.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken"); // Make sure to install this package (npm install jsonwebtoken)
const { processSocketEvent } = require("./helper/socket");

// Module-level variable to store the io instance.
let ioInstance = null;

/**
 * Initialize the Socket.IO server and attach event handlers.
 * @param {http.Server} server - Your HTTP server instance.
 * @returns {Server} The initialized Socket.IO server instance.
 */
function initializeSocket(server) {
  // Create a new Socket.IO server with basic CORS settings.
  ioInstance = new Server(server, {
    cors: {
      origin: "*", // In production, restrict this to your client URL.
      methods: ["GET", "POST"],
    },
  });

  // When a client connects...
  ioInstance.on("connection", (socket) => {
    // Retrieve uid, agent, and userToken from query parameters.
    const { uid, agent, userToken } = socket.handshake.query;

    // Decode userToken using jwt.decode (for verification, you might use jwt.verify with a secret)
    let decodedValue = {};
    if (userToken) {
      try {
        decodedValue = jwt.decode(userToken);
      } catch (error) {
        console.error("Error decoding token:", error);
      }
    }

    // Save connection info on the socket with the desired structure.
    socket.connectionInfo = {
      uid: uid || null, // The user identifier (may be common among multiple sockets).
      id: socket.id, // The unique Socket.IO id.
      data: {}, // Additional data if needed.
      agent: agent === "true", // Convert agent to Boolean.
      decodedValue: decodedValue, // The decoded token payload.
      owner_uid: decodedValue?.owner_uid,
    };

    console.log("New connection established:");
    console.dir({ socket: socket.connectionInfo.id });

    // Immediately send an acknowledgement containing connection info.
    socket.emit("connection_ack", socket.connectionInfo);

    // Listen for generic "message" events.
    socket.on("message", (message) => {
      // Log the message along with the connectionInfo from the socket.
      console.log(`Received message from ${socket.id}:`, message);
      console.log("Connection Info:", socket.connectionInfo);
    });

    // Listen for custom events from the client.
    // This will catch any event that is not specifically handled.
    socket.onAny((event, ...args) => {
      // Optionally, filter out events that you want to ignore.
      if (event !== "connection_ack" && event !== "message") {
        // console.log(`Received event "${event}" from ${socket.id}:`, ...args);
      }
    });

    // Process additional socket events (defined in a helper module).
    processSocketEvent({
      socket,
      connectionInfo: socket.connectionInfo,
      sendToSocketId,
      sendToUid,
      sendToAll,
      updateConnectionDataBySocketId,
      getConnectionsByUid,
    });

    // Handle disconnects.
    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  return ioInstance;
}

/**
 * Send a message to all connected sockets with a matching uid.
 * @param {string} targetUid - The uid to match.
 * @param {*} data - The data to send.
 * @param {string} [eventName="message"] - The event name to emit.
 */
function sendToUid(targetUid, data, eventName = "message") {
  if (!ioInstance) {
    console.error("Socket.IO instance is not initialized");
    return;
  }
  ioInstance.sockets.sockets.forEach((socket) => {
    if (socket.connectionInfo && socket.connectionInfo.uid === targetUid) {
      console.log(
        `Emitting ${eventName} to socket ${socket.id} for uid ${targetUid}`
      );
      socket.emit(eventName, data);
    }
  });
}

/**
 * Send a message to a specific socket by its id.
 * @param {string} socketId - The unique socket id.
 * @param {*} data - The data to send.
 * @param {string} [eventName="message"] - The event name to emit.
 */
function sendToSocketId(socketId, data, eventName = "message") {
  if (!ioInstance) {
    console.error("Socket.IO instance is not initialized");
    return;
  }
  const targetSocket = ioInstance.sockets.sockets.get(socketId);
  if (targetSocket) {
    console.log(`Emitting ${eventName} to socket ${socketId}`);
    targetSocket.emit(eventName, data);
  } else {
    console.error(`Socket with id ${socketId} not found.`);
  }
}

/**
 * Send a message to all connected sockets.
 * @param {*} data - The data to send.
 * @param {string} [eventName="message"] - The event name to emit.
 */
function sendToAll(data, eventName = "message") {
  if (!ioInstance) {
    console.error("Socket.IO instance is not initialized");
    return;
  }
  ioInstance.sockets.sockets.forEach((socket) => {
    console.log(`Emitting ${eventName} to socket ${socket.id}`);
    socket.emit(eventName, data);
  });
}

/**
 * Example: Send a "ring" event to all sockets with a matching uid.
 * @param {string} targetUid - The uid to match.
 * @param {*} data - The data to send (default: { ring: true }).
 * @param {string} [eventName="ring"] - The event name to emit.
 */
function sendRingToUid(targetUid, data = { ring: true }, eventName = "ring") {
  if (!ioInstance) {
    console.error("Socket.IO instance is not initialized");
    return;
  }
  ioInstance.sockets.sockets.forEach((socket) => {
    if (socket.connectionInfo && socket.connectionInfo.uid === targetUid) {
      console.log(
        `Emitting ${eventName} to socket ${socket.id} for uid ${targetUid}`
      );
      socket.emit(eventName, data);
    }
  });
}

/**
 * Return an array of connection info objects for all sockets matching the given uid.
 * @param {string} targetUid - The uid to match.
 * @returns {Array} Array of connection info objects.
 */
function getConnectionsByUid(targetUid) {
  if (!ioInstance) {
    console.error("Socket.IO instance is not initialized");
    return [];
  }

  const connections = new Set(); // Using Set to avoid duplicate entries

  ioInstance.sockets.sockets.forEach((socket) => {
    const connectionInfo = socket.connectionInfo;

    if (connectionInfo) {
      const { uid, owner_uid } = connectionInfo;

      if (uid === targetUid || owner_uid === targetUid) {
        connections.add(connectionInfo); // Set will handle duplicates
      }
    }
  });

  return Array.from(connections); // Convert Set back to Array before returning
}

/**
 * Update the connectionInfo.data object for a specific socket by its id.
 * @param {string} socketId - The unique socket id.
 * @param {object} newData - The new data to merge into connectionInfo.data.
 * @returns {object|null} The updated connectionInfo.data, or null if the socket wasn't found.
 */
function updateConnectionDataBySocketId(socketId, newData) {
  if (!ioInstance) {
    console.error("Socket.IO instance is not initialized");
    return null;
  }
  const targetSocket = ioInstance.sockets.sockets.get(socketId);
  if (!targetSocket) {
    console.error(`Socket with id ${socketId} not found.`);
    return null;
  }
  // Merge newData into the existing connectionInfo.data.
  targetSocket.connectionInfo.data = {
    ...targetSocket.connectionInfo.data,
    ...newData,
  };
  // console.log(
  //   `Updated connection data for socket ${socketId}:`,
  //   targetSocket.connectionInfo.data
  // );
  return targetSocket.connectionInfo.data;
}

/**
 * Getter for the current Socket.IO instance.
 * @returns {Server} The Socket.IO server instance.
 */
function getSocketIo() {
  return ioInstance;
}

module.exports = {
  initializeSocket,
  sendToUid,
  sendToSocketId,
  sendToAll,
  getConnectionsByUid,
  getSocketIo,
  sendRingToUid,
  updateConnectionDataBySocketId,
};

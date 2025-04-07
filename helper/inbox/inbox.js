const { query } = require("../../database/dbpromise");
const {
  getConnectionsByUid,
  sendToUid,
  sendRingToUid,
  sendToSocketId,
} = require("../../socket");
const { mergeArraysWithPhonebook } = require("../socket/function");
const { processMetaMessage } = require("./meta");
const { metaChatbotInit } = require("../chatbot/meta");
const { processMessageQr } = require("../addon/qr/processThings");

async function updateChatListSocket({ connectionInfo }) {
  try {
    const limit = 10;
    const { uid, agent } = connectionInfo;
    let chats = [];

    if (agent) {
      const assignedChats = await query(
        `SELECT chat_id FROM agent_chats WHERE uid = ?`,
        [uid]
      );
      if (assignedChats.length) {
        const chatIds = assignedChats.map(({ chat_id }) => chat_id);
        chats = await query(
          `SELECT * FROM chats 
           WHERE chat_id IN (?) AND uid = ? 
           ORDER BY last_message_came DESC 
           LIMIT ?`,
          [
            chatIds,
            agent ? connectionInfo?.decodedValue?.owner_uid : uid,
            limit,
          ]
        );
      }
    } else {
      chats = await query(
        `SELECT * FROM chats 
         WHERE uid = ? 
         ORDER BY last_message_came DESC 
         LIMIT ?`,
        [uid, limit]
      );
    }

    const contacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
      agent ? connectionInfo?.decodedValue?.owner_uid : uid,
    ]);
    const chatData = mergeArraysWithPhonebook(chats, contacts);

    return chatData || [];
  } catch (err) {
    console.log(err);
  }
}

async function processMessage({
  body,
  uid,
  origin,
  getSession,
  sessionId,
  qrType,
}) {
  try {
    // getting user data
    const [userData] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
    if (!userData) return;

    let latestConversation = [];

    // console.dir({ body }, { depth: null });

    switch (origin) {
      case "meta":
        const metaMsg = await processMetaMessage({
          body,
          uid,
          origin,
          userData,
        });
        latestConversation = metaMsg;
        break;
      case "qr":
        console.log("QR MESSAGE");
        const qrMsg = await processMessageQr({
          getSession,
          message: body,
          sessionId,
          type: qrType,
          uid,
          userData,
        });
        latestConversation = qrMsg;
        console.log("QR MESSAGE");
        break;
      default:
        break;
    }

    // Send the latest chat list to all sockets of the user.
    const socketConnections = getConnectionsByUid(uid) || [];

    socketConnections.forEach(async (socket) => {
      const updateChatSocketData = await updateChatListSocket({
        connectionInfo: socket,
      });

      sendToSocketId(socket?.id, updateChatSocketData, "update_chat_list");
      console.log("Chat update sent to socket");
    });

    // console.log({ latestConversation: latestConversation });

    sendRingToUid(uid);
    // Send the latest chat list to all sockets of the user. end

    // sending conversation update
    socketConnections.forEach(async (socket) => {
      const opendedChat = socket?.data?.selectedChat || null;
      // console.log({
      //   mob: opendedChat?.sender_mobile,
      //   lMob: latestConversation?.newMessage?.senderMobile,
      // });

      if (
        opendedChat?.sender_mobile ===
          latestConversation?.newMessage?.senderMobile ||
        opendedChat?.sender_mobile ===
          latestConversation?.latestMessages?.[0]?.senderMobile
      ) {
        const socketId = socket?.id;
        sendToSocketId(
          socketId,
          { conversation: latestConversation },
          "update_conversation"
        );
      }
    });
    // console.dir({ latestConversation }, { depth: null });

    // chatbot init
    // console.log({ latestConversation });
    if (latestConversation?.newMessage && uid) {
      metaChatbotInit({ latestConversation, uid, origin });
    }
  } catch (err) {
    console.log(err);
  }
}

module.exports = { processMessage };

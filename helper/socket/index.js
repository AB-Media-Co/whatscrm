const { query } = require("../../database/dbpromise");
const {
  mergeArraysWithPhonebook,
  deleteMediaFromConversation,
  returnMsgObjAfterAddingKey,
  sendMetaMsg,
  sendQrMsg,
} = require("./function");
const { readJSONFile } = require("../../functions/function.js");
const { addObjectToFile } = require("../../functions/function.js");
const moment = require("moment-timezone");

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

function getCurrentTimestampInTimeZone(timezone) {
  const currentTimeInZone = moment.tz(timezone);
  const currentTimestampInSeconds = Math.round(
    currentTimeInZone.valueOf() / 1000
  );

  return currentTimestampInSeconds;
}

function processSocketEvent({
  socket,
  connectionInfo,
  sendToUid,
  sendToSocketId,
  updateConnectionDataBySocketId,
  getConnectionsByUid,
}) {
  // Register a specific handler for the "get_chat" event.
  socket.on("get_chat", async (payload) => {
    try {
      const limit = payload?.data?.limit || 10;
      const { uid, agent } = connectionInfo;
      let chats = [];

      if (agent) {
        const assignedChats = await query(
          `SELECT chat_id FROM agent_chats WHERE uid = ?`,
          [uid]
        );
        if (assignedChats.length) {
          const chatIds = assignedChats.map(({ chat_id }) => chat_id);
          console.dir(
            {
              connectionInfo,
            },
            { depth: null }
          );
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

      // console.log({ chats });

      const contacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
        agent ? connectionInfo?.decodedValue?.owner_uid : uid,
      ]);
      const chatData = mergeArraysWithPhonebook(chats, contacts);

      sendToUid(uid, chatData, "get_chat");
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("get_chat_filter", async (payload) => {
    try {
      const { search = "", filterType = "all" } = payload?.data || {};
      const { uid, agent } = connectionInfo;

      // Build extra condition based on filterType
      let extraCondition = "";
      if (filterType === "read") {
        extraCondition = " AND is_opened = 1 ";
      } else if (filterType === "unread") {
        extraCondition = " AND is_opened = 0 ";
      }

      // Build search condition if a search string is provided
      let searchCondition = "";
      let searchParams = [];
      if (search.trim() !== "") {
        searchCondition = ` AND (
          sender_name LIKE ?
          OR sender_mobile LIKE ?
          OR last_message LIKE ?
          OR chat_note LIKE ?
          OR JSON_UNQUOTE(JSON_EXTRACT(chat_tags, '$.title')) LIKE ?
        )`;
        const likeSearch = `%${search}%`;
        searchParams = [
          likeSearch,
          likeSearch,
          likeSearch,
          likeSearch,
          likeSearch,
        ];
      }

      let chats = [];
      if (agent) {
        const assignedChats = await query(
          "SELECT chat_id FROM agent_chats WHERE uid = ?",
          [uid]
        );

        if (assignedChats.length) {
          const chatIds = assignedChats.map(({ chat_id }) => chat_id);
          chats = await query(
            `SELECT * FROM chats 
             WHERE chat_id IN (?)
             AND uid = ? 
             ${extraCondition}
             ${searchCondition}
             ORDER BY last_message_came DESC 
             LIMIT 20`,
            [
              chatIds,
              agent ? connectionInfo?.decodedValue?.owner_uid : uid,
              ...searchParams,
            ]
          );
        }
      } else {
        chats = await query(
          `SELECT * FROM chats 
           WHERE uid = ?
           ${extraCondition}
           ${searchCondition}
           ORDER BY last_message_came DESC 
           LIMIT 20`,
          [uid, ...searchParams]
        );
      }

      console.log("Filtered Chats:", chats);

      const contacts = await query("SELECT * FROM contact WHERE uid = ?", [
        agent ? connectionInfo?.decodedValue?.owner_uid : uid,
      ]);

      const chatData = mergeArraysWithPhonebook(chats, contacts);
      sendToUid(uid, chatData, "get_chat");
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("delete_chat", async (payload) => {
    try {
      const { chatId, type } = payload?.data;
      if (chatId && type) {
        const { uid, agent } = connectionInfo;
        await query(`DELETE FROM chats WHERE chat_id = ?`, [chatId]);

        const convoPath = `${__dirname}/../../conversations/inbox/${
          agent ? connectionInfo?.decodedValue?.owner_uid : uid
        }/${chatId}.json`;
        const metaMediaFolder = `${__dirname}/../../client/public/meta-media`;

        deleteMediaFromConversation(convoPath, metaMediaFolder, type);
        if (type === "delete") {
          await query(`DELETE FROM chats WHERE chat_id = ? AND uid = ?`, [
            chatId,
            uid,
          ]);
        }
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("on_open_chat", async (payload) => {
    try {
      const { chatId, limit, chat } = payload?.data;
      const { uid, id, agent } = connectionInfo;
      if (chatId && limit) {
        const conversationPath = `${__dirname}/../../conversations/inbox/${
          agent ? connectionInfo?.decodedValue?.owner_uid : uid
        }/${chatId}.json`;
        const conversation = readJSONFile(conversationPath, limit);

        await query(`UPDATE chats SET is_opened = ? WHERE id = ?`, [
          1,
          chat?.id,
        ]);

        const [chatData] = await query(`SELECT * FROM chats Where id = ?`, [
          chat?.id,
        ]);

        const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [
          agent ? connectionInfo?.decodedValue?.owner_uid : uid,
        ]);
        const labelAdded = await query(
          `SELECT * FROM chat_tags WHERE uid = ?`,
          [agent ? connectionInfo?.decodedValue?.owner_uid : uid]
        );
        const agents = await query(`SELECT * FROM agents WHERE owner_uid = ?`, [
          uid,
        ]);

        const [chatAssignAgent] = await query(
          `SELECT * FROM agent_chats WHERE chat_id = ? AND owner_uid = ?`,
          [chat?.chat_id, uid]
        );

        const onChatSelectData = {
          conversation: conversation || [],
          chatinfo: chat,
          chatnote: chatData?.chat_note,
          countDownTimer: {
            timestamp: chatData?.last_message_came,
            timezone: user?.timezone || "Asia/Kolkata",
          },
          labelsAdded: labelAdded || [],
          agentData: agents || [],
          chatAssignAgent: chatAssignAgent || {},
        };

        sendToSocketId(id, onChatSelectData, "on_open_chat");
        updateConnectionDataBySocketId(connectionInfo.id, {
          selectedChat: chat,
        });
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("assign_agent_to_chat", async (payload) => {
    try {
      const { uid, id } = connectionInfo;
      const { chatId, agentUid, unAssign } = payload.data;

      console.log({ chatId, agentUid, unAssign });
      // return;

      if (unAssign) {
        await query(
          `DELETE FROM agent_chats WHERE chat_id = ? AND owner_uid = ?`,
          [chatId, uid]
        );
      }

      if (chatId && agentUid) {
        // checking if there is already assigned
        const getOnce = await query(
          `SELECT * FROM agent_chats WHERE chat_id = ? AND owner_uid = ? AND uid = ?`,
          [chatId, uid, agentUid]
        );

        if (getOnce?.length < 1) {
          await query(
            `INSERT INTO agent_chats (owner_uid, uid, chat_id) VALUES (?,?,?)`,
            [uid, agentUid, chatId]
          );
        }
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("save_chat_note", async (payload) => {
    try {
      const { id, chatNote } = payload?.data;

      if (id) {
        await query(`UPDATE chats SET chat_note = ? WHERE id = ?`, [
          chatNote,
          id,
        ]);
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("add_label", async (payload) => {
    try {
      const { label, hex } = payload?.data;
      const { uid, id } = connectionInfo;
      if (!label || !hex) {
        sendToSocketId(id, { msg: "Please provide Label" }, "error");
        return;
      }

      const labelsData = await query(`SELECT * FROM chat_tags WHERE uid = ?`, [
        uid,
      ]);

      const allLablesTitles = labelsData?.map((x) => x.title);
      if (allLablesTitles?.includes(label)) {
        sendToSocketId(id, { msg: "Duplicate label is not allowed" }, "error");
        return;
      }

      await query(`INSERT INTO chat_tags (uid, hex, title) VALUES (?,?,?)`, [
        uid,
        hex,
        label,
      ]);

      const labelsDataNew = await query(
        `SELECT * FROM chat_tags WHERE uid = ?`,
        [uid]
      );

      // updating labels to client
      sendToSocketId(id, labelsDataNew, "update_labels");
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("on_label_delete", async (payload) => {
    try {
      const { labelId } = payload?.data;
      const { uid, id } = connectionInfo;
      await query(`DELETE FROM chat_tags WHERE id = ?`, [labelId]);

      // updating label
      const labelsDataNew = await query(
        `SELECT * FROM chat_tags WHERE uid = ?`,
        [uid]
      );

      // updating labels to client
      sendToSocketId(id, labelsDataNew, "update_labels");
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("set_chat_label", async (payload) => {
    try {
      const { labelData, chatIdRow } = payload?.data;
      const { uid, id } = connectionInfo;

      if (!labelData || !chatIdRow) {
        return sendToSocketId(id, { msg: "Invalid request" }, "error");
      }

      await query(`UPDATE chats SET chat_tags = ? WHERE id = ?`, [
        JSON.stringify(labelData),
        chatIdRow,
      ]);

      // updating chat info
      const [updatedChatData] = await query(
        `SELECT * FROM chats WHERE id = ?`,
        [chatIdRow]
      );

      if (updatedChatData?.chat_tags) {
        sendToSocketId(id, updatedChatData?.chat_tags, "update_chat_info");
      }

      // updating chat list
      // Send the latest chat list to all sockets of the user.
      const socketConnections = getConnectionsByUid(uid) || [];

      socketConnections.forEach(async (socket) => {
        const updateChatSocketData = await updateChatListSocket({
          connectionInfo: socket,
        });

        sendToUid(uid, updateChatSocketData, "update_chat_list");
        console.log("Chat update sent to socket");
      });

      // Send the latest chat list to all sockets of the user. end
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("send_chat_message", async (payload) => {
    try {
      const { type, msgCon, chatInfo } = payload.data;
      const { uid, id, agent } = connectionInfo;
      const { selectedChat } = connectionInfo?.data;

      if (!msgCon || !type) {
        return sendToSocketId(id, { msg: "Please add a message" }, "error");
      }

      if (!selectedChat?.id) {
        return sendToSocketId(
          id,
          { msg: "Please open the chat again you server faced socket issue" },
          "error"
        );
      }

      const senderName = selectedChat?.sender_name;
      const senderMobile = selectedChat?.sender_mobile;

      const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [
        agent ? connectionInfo?.decodedValue?.owner_uid : uid,
      ]);
      const userTimezone = getCurrentTimestampInTimeZone(
        user?.timezone || "Asia/Kolkata"
      );

      // Prepare the message
      const msgObj = returnMsgObjAfterAddingKey({
        msgContext: msgCon,
        type,
        timestamp: userTimezone || "NA",
        senderName: senderName || "NA",
        senderMobile: senderMobile || "NA",
      });

      let sendMsg;

      if (chatInfo?.origin === "qr") {
        sendMsg = await sendQrMsg({
          msgObj: msgCon,
          to: senderMobile,
          uid: agent ? connectionInfo?.decodedValue?.owner_uid : uid,
          chatInfo,
        });
      } else {
        sendMsg = await sendMetaMsg({
          msgObj: msgCon,
          to: senderMobile,
          uid: agent ? connectionInfo?.decodedValue?.owner_uid : uid,
        });
      }

      if (!sendMsg?.success) {
        console.log(sendMsg);
        return sendToSocketId(id, { msg: sendMsg?.msg }, "error");
      }

      if (sendMsg?.id) {
        const chatPath = `${__dirname}/../../conversations/inbox/${
          agent ? connectionInfo?.decodedValue?.owner_uid : uid
        }/${selectedChat?.chat_id}.json`;
        const msgObjNew = { ...msgObj, metaChatId: sendMsg?.id };
        addObjectToFile(msgObjNew, chatPath);
      }

      console.dir({ sendMsg }, { depth: null });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("add", async (payload) => {
    updateConnectionDataBySocketId(connectionInfo.id, payload);
  });
}

module.exports = { processSocketEvent };

const { query } = require("../../database/dbpromise");
const {
  readJSONFile,
  getCurrentTimestampInTimeZone,
  addObjectToFile,
} = require("../../functions/function");
const {
  mergeArraysWithPhonebook,
  sendMessageMeta,
  returnMsgObjAfterAddingKey,
  sendMetaMsg,
  deleteMediaFromConversation,
  gettimeZone,
} = require("./function");
const fs = require("fs");
const path = require("path");

function delay(ms) {
  return new Promise(() => {
    setInterval((resolve) => {
      resolve();
    }, ms);
  });
}

async function returnChatList(data, updatedMax) {
  if (data?.role === "agent") {
    const assignedChats = await query(
      `SELECT * FROM agent_chats WHERE uid = ?`,
      [data?.agent_uid]
    );
    if (assignedChats?.length < 1) {
      return [];
    } else {
      const chatIds = assignedChats.map((i) => i?.chat_id);
      const chatData = await query(
        `SELECT * FROM chats 
         WHERE chat_id IN (?) AND uid = ? 
         ORDER BY last_message_came DESC 
         LIMIT ?`,
        [chatIds, data?.uid, updatedMax]
      );

      return chatData;
    }
  } else {
    const chats = await query(
      `SELECT * FROM chats WHERE uid = ? ORDER BY last_message_came DESC LIMIT ?`,
      [data?.uid, updatedMax]
    );
    return chats;
  }
}

function processWs({
  on,
  sendToClientByUid,
  sendToClientById,
  getConnectionsByUid,
}) {
  on("chat_list", async (id, uid, payload, ws, user) => {
    console.log("asked for chat_list");
    const connetions = getConnectionsByUid(uid);
    const loadMore = payload?.loadMore || null;

    connetions.map(async (i) => {
      const max = loadMore
        ? i?.inboxContent?.chatList?.length + i?.inboxContent?.inboxState?.max
        : i?.inboxContent?.chatList?.length;
      const updatedMax = max < 20 ? 20 : max;

      const chats = await returnChatList(i, updatedMax);

      // const chats = await query(
      //   `SELECT * FROM chats WHERE uid = ? ORDER BY last_message_came DESC LIMIT ?`,
      //   [uid, updatedMax]
      // );
      const contacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
        uid,
      ]);
      const chatData = mergeArraysWithPhonebook(chats, contacts);
      sendToClientById(i?.id, {
        action: "chat_list",
        payload: chatData,
      });
    });
  });

  on("chat_conversation", async (id, uid, payload, ws, user) => {
    const { chatId, max } = payload;
    if (chatId && max) {
      const conversationPath = `${__dirname}/../../conversations/inbox/${uid}/${chatId}.json`;
      const chats = readJSONFile(conversationPath, max);
      sendToClientById(id, {
        action: "chat_conversation",
        payload: chats,
      });
    }
  });

  on("send_attachement_message", async (id, uid, payload, ws, user) => {
    const { msgContext, type, to } = payload;
    const connections = getConnectionsByUid(uid);

    // console.dir({ payload }, { depth: null });

    try {
      if (!msgContext || !type || !to) {
        return sendToClientByUid(uid, {
          action: "error",
          payload: {
            msg: "Please add message",
          },
        });
      }

      // Fetch the common timezone from the first connection
      const tZone =
        connections.length > 0 ? await gettimeZone(connections[0]) : null;

      if (!tZone) {
        return sendToClientByUid(uid, {
          action: "error",
          payload: {
            msg: `Please refresh your page or add your timezone in your profile.`,
          },
        });
      }

      const userTimezone = tZone;

      // Prepare the message object (common for all connections)
      const msgObj = returnMsgObjAfterAddingKey({
        msgContext,
        type,
        timestamp: userTimezone || "NA",
        senderName: payload?.senderName || "NA",
        senderMobile: payload?.senderMobile || "NA",
      });

      // Send the message only once
      const sendMsg = await sendMetaMsg({
        msgObj: msgContext,
        to,
        uid,
      });
      console.log("Meta msg sent");

      // console.dir({ sendMsg }, { depth: null });

      if (!sendMsg?.success || !sendMsg?.id) {
        return sendToClientByUid(uid, {
          action: "error",
          payload: {
            msg: sendMsg?.msg || "Unknown error",
          },
        });
      }

      // Add metaChatId to the message object
      const msgObjNew = { ...msgObj, metaChatId: sendMsg?.id };

      // Loop through each connection to update individually
      await Promise.all(
        connections.map(async (x) => {
          const openedChatData = x?.inboxContent?.openedChatData;
          const chatId = openedChatData?.chat_id;

          // console.dir({ openedChatData }, { depth: null });

          if (chatId) {
            const chatPath = `${__dirname}/../../conversations/inbox/${uid}/${chatId}.json`;
            // Add the updated message object to the respective chat file
            addObjectToFile(msgObjNew, chatPath);

            // Send updated chat to the specific client
            sendToClientByUid(x.uid, {
              action: "update_chat",
              payload: { chatId, newMessage: msgObjNew },
            });
          }
        })
      );

      console.log("Message sent successfully and updates dispatched.");
    } catch (err) {
      console.error("Error sending attachment message:", err);
      sendToClientByUid(uid, {
        action: "error",
        payload: {
          msg: err?.toString() || "An unexpected error occurred.",
        },
      });
    }
  });

  on("update_opened_chat", async (id, uid, payload, ws, user) => {
    const { chatId } = payload;
    console.log({ chatId });
    if (chatId) {
      const [chatData] = await query(
        `SELECT * FROM chats WHERE chat_id = ? AND uid = ?`,
        [chatId, uid]
      );

      if (chatData) {
        const [mobile] = await query(
          `SELECT * FROM contact WHERE uid = ? AND mobile = ?`,
          [uid, chatData?.sender_mobile]
        );

        if (mobile) {
          sendToClientById(id, {
            action: "update_opened_chat",
            payload: { ...chatData, phonebook: mobile },
          });
        } else {
          sendToClientById(id, {
            action: "update_opened_chat",
            payload: chatData,
          });
        }
      } else {
        sendToClientById(id, {
          action: "update_opened_chat",
          payload: {},
        });
      }
    }
  });

  on("delete_media_files", async (id, uid, payload, ws, user) => {
    const { chatId, type } = payload;

    if (chatId && type) {
      const convoPath = `${__dirname}/../../conversations/inbox/${uid}/${chatId}.json`;
      const metaMediaFolder = `${__dirname}/../../client/public/meta-media`;

      deleteMediaFromConversation(convoPath, metaMediaFolder, type);
      if (type === "delete") {
        await query(`DELETE FROM chats WHERE chat_id = ? AND uid = ?`, [
          chatId,
          uid,
        ]);
      }
    }

    sendToClientByUid(uid, {
      action: "delete_media_files",
      payload: {},
    });
  });

  on("mark_chat_read", async (id, uid, payload, ws, user) => {
    const { chatId } = payload;
    if (chatId) {
      await query(
        `UPDATE chats SET is_opened = ? WHERE chat_id = ? AND uid = ?`,
        [1, chatId, uid]
      );

      const connetions = getConnectionsByUid(uid);
      const loadMore = payload?.loadMore || null;

      connetions.map(async (i) => {
        const max = loadMore
          ? i?.inboxContent?.chatList?.length + i?.inboxContent?.inboxState?.max
          : i?.inboxContent?.chatList?.length;
        const updatedMax = max < 20 ? 20 : max;
        // const chats = await query(
        //   `SELECT * FROM chats WHERE uid = ? ORDER BY last_message_came DESC LIMIT ?`,
        //   [uid, updatedMax]
        // );
        const chats = await returnChatList(i, updatedMax);
        const contacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
          uid,
        ]);
        const chatData = mergeArraysWithPhonebook(chats, contacts);
        sendToClientById(i?.id, {
          action: "chat_list",
          payload: chatData,
        });
      });
    }
  });
}

module.exports = { processWs };

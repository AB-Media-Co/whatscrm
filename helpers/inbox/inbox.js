const { query } = require("../../database/dbpromise");
const {
  convertNumberToRandomString,
  getCurrentTimestampInTimeZone,
  botWebhook,
  readJSONFile,
} = require("../../functions/function");
const {
  sendToClientByUid,
  getConnectionsByUid,
  sendToClientById,
} = require("../../websocket");
const metaChatBotInit = require("./meta/chatbot");
const { processMetaMsg, extractMessageContent } = require("./meta/meta");

function getChatId(body) {
  try {
    let chatId = convertNumberToRandomString(
      body?.entry[0]?.changes[0]?.value?.statuses?.[0]?.recipient_id ||
        body?.entry[0]?.changes[0]?.value?.contacts?.[0]?.wa_id
    );
    return chatId;
  } catch (error) {
    return null;
  }
}

async function updateChatInMysql({
  chatId,
  uid,
  senderName,
  senderMobile,
  actualMsg,
}) {
  // Allowed message types
  const allowedMessageTypes = ["text", "image", "document", "video", "audio"];

  // Fetch user details
  const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
  if (!user) {
    return; // If user not found, exit
  }

  const userTimezone = getCurrentTimestampInTimeZone(
    user?.timezone || Date.now() / 1000
  );

  // Check if chat already exists
  const [chat] = await query(`SELECT * FROM chats WHERE chat_id = ?`, [chatId]);

  // Condition to update last_message_came
  const shouldUpdateTimestamp =
    allowedMessageTypes.includes(actualMsg?.type) &&
    actualMsg?.route === "INCOMING";

  if (chat) {
    // If chat exists, update it
    const queryFields = [];
    const queryValues = [];

    if (shouldUpdateTimestamp) {
      queryFields.push("last_message_came = ?");
      queryValues.push(userTimezone);
    }

    queryFields.push("last_message = ?");
    queryFields.push("is_opened = ?");
    queryValues.push(JSON.stringify(actualMsg), 0);

    queryValues.push(chatId, uid); // Where clause values

    await query(
      `UPDATE chats SET ${queryFields.join(
        ", "
      )} WHERE chat_id = ? AND uid = ?`,
      queryValues
    );
  } else {
    // If chat does not exist, insert it
    await query(
      `INSERT INTO chats (chat_id, uid, last_message_came, sender_name, sender_mobile, last_message, is_opened) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        chatId,
        uid,
        shouldUpdateTimestamp ? userTimezone : null, // Insert timestamp only if allowed
        senderName || "NA",
        senderMobile || "NA",
        JSON.stringify(actualMsg),
        0,
      ]
    );
  }
}

async function processMessage({ body, uid, origin }) {
  try {
    // console.log(`Body webhook came`);
    if (origin === "meta") {
      const chatId = getChatId(body);
      const conversationPath = `${__dirname}/../../conversations/inbox/${uid}/${chatId}.json`;
      const [userDataMysql] = await query(`SELECT * FROM user WHERE uid = ?`, [
        uid,
      ]);

      // console.dir(body, { depth: null });

      if (conversationPath && userDataMysql && chatId) {
        const { newMessage, latestMessages, statuses } = await processMetaMsg({
          body,
          uid,
          userFromMysql: userDataMysql,
          conversationPathNew: conversationPath,
        });

        if (latestMessages?.length > 0) {
          const connections = getConnectionsByUid(uid);
          const lastObj = latestMessages[latestMessages?.length - 1];

          await updateChatInMysql({
            chatId,
            uid,
            senderName: lastObj?.senderName,
            senderMobile: lastObj?.senderMobile,
            actualMsg: lastObj,
          });

          // Build the WebSocket message object
          connections?.map((i) => {
            const wsMessage = {
              action: "push_new_msg",
              payload: latestMessages, // The new message object
              updateConversation:
                chatId === i?.inboxContent?.openedChatData?.chat_id
                  ? true
                  : false,
              ring: statuses?.length < 1 ? true : false,
            };

            sendToClientById(i?.id, wsMessage);
          });

          if (newMessage) {
            const chatBotData = await query(
              `SELECT * FROM chatbot WHERE uid = ? AND active = ?`,
              [uid, 1]
            );

            if (chatBotData?.length > 0) {
              for (const chatbot of chatBotData) {
                const flowDta = chatbot?.flow
                  ? JSON.parse(chatbot?.flow)
                  : null;
                if (flowDta) {
                  const nodePath = `${__dirname}/../../flow-json/nodes/${uid}/${flowDta?.flow_id}.json`;
                  const edgePath = `${__dirname}/../../flow-json/edges/${uid}/${flowDta?.flow_id}.json`;
                  const uniqueId = `${uid}-${chatId}`;

                  metaChatBotInit({
                    nodes: readJSONFile(nodePath),
                    edges: readJSONFile(edgePath),
                    incomingMessage: newMessage,
                    chatId: chatId,
                    uid: uid,
                    uniqueId: uniqueId,
                    userDataMysql,
                  });
                }
              }
            }
          }
        }
      }
    }

    return;
  } catch (err) {
    console.error("Error processing message:", err);
    throw err;
  }
}

module.exports = { processMessage };

const fetch = require("node-fetch");
const {
  getCurrentTimestampInTimeZone,
  addObjectToFile,
} = require("../../functions/function");
const { query } = require("../../database/dbpromise");
const node = require("node-fetch");
const fs = require("fs");
const path = require("path");

function mergeArraysWithPhonebook(chatArray, phonebookArray) {
  // Iterate through the chat array and enrich with phonebook data
  return chatArray.map((chat) => {
    // Find matching phonebook entry where sender_mobile matches mobile
    const phonebookEntry = phonebookArray.find(
      (phonebook) => phonebook.mobile === chat.sender_mobile
    );

    // Add phonebook data if a match is found
    return {
      ...chat,
      phonebook: phonebookEntry || null, // Add phonebook data or null if no match
    };
  });
}

function saveInChat({ uid, chatId, obj }) {
  const chatPath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
  addObjectToFile(obj, chatPath);
}

async function updateLastMsg({ obj, userTimezone, chatId }) {
  await query(
    `UPDATE chats SET last_message_came = ?, last_message = ?, is_opened = ? WHERE chat_id = ?`,
    [userTimezone, JSON.stringify(obj), 1, chatId]
  );
}

async function sendMessageMeta({
  uid,
  chatId,
  message,
  toNumber,
  toName,
  savObj,
  msgObj,
}) {
  try {
    const [metaKeys] = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      uid,
    ]);

    if (!metaKeys) {
      return { success: false, msg: "Please add your API keys" };
    }

    const [userData] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const waToken = metaKeys?.access_token;
    const waNumId = metaKeys?.business_phone_number_id;

    if (!waToken || !waNumId) {
      return {
        success: false,
        msg: "Please add your meta token and phone number ID",
      };
    }

    const url = `https://graph.facebook.com/v17.0/${waNumId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toNumber,
      ...msgObj,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${waToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (data?.error) {
      return { success: false, msg: data?.error?.message };
    }

    if (data?.messages[0]?.id) {
      const userTimezone = getCurrentTimestampInTimeZone(
        userData?.timezone || Date.now() / 1000
      );

      const finalSaveMsg = {
        ...savObj,
        metaChatId: data?.messages[0]?.id,
        timestamp: userTimezone,
      };

      saveInChat({
        uid,
        chatId,
        obj: finalSaveMsg,
      });

      await updateLastMsg({
        obj: finalSaveMsg,
        chatId,
        userTimezone,
      });
    }

    return { success: true };
  } catch (err) {
    console.log(err);
    return { success: false, msg: err?.message };
  }
}

function returnMsgObjAfterAddingKey(overrides = {}) {
  const defaultObj = {
    type: "text",
    metaChatId: "",
    msgContext: { type: "text", text: { preview_url: true, body: "hey yo" } },
    reaction: "",
    timestamp: "",
    senderName: "codeyon.com",
    senderMobile: "918430088300",
    status: "",
    star: false,
    route: "OUTGOING",
    context: "",
    origin: "meta",
    err: "",
  };

  // Merge overrides with the default object
  return { ...defaultObj, ...overrides };
}

function formatNumber(number) {
  return number?.replace("+", "");
}

async function sendMetaMsg({ uid, to, msgObj }) {
  try {
    const [api] = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    if (!api || !api?.access_token || !api?.business_phone_number_id) {
      return { success: false, msg: "Please add your meta API keys" };
    }

    const waToken = api?.access_token;
    const waNumId = api?.business_phone_number_id;

    const url = `https://graph.facebook.com/v17.0/${waNumId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatNumber(to),
      ...msgObj,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${waToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (data?.error) {
      return { success: false, msg: data?.error?.message };
    }

    if (data?.messages[0]?.id) {
      const metaMsgId = data?.messages[0]?.id;
      return { success: true, id: metaMsgId };
    } else {
      return { success: false, msg: JSON.stringify(data) };
    }
  } catch (err) {
    return { success: false, msg: err?.toString() };
  }
}

function deleteMediaFromConversation(jsonFilePath, mediaFolderPath, type) {
  try {
    if (!fs.existsSync(jsonFilePath)) {
      console.error("JSON file does not exist:", jsonFilePath);
      return;
    }

    switch (type) {
      case "media":
        // Handle "media" type: Remove media-related messages and their files
        const conversationData = JSON.parse(
          fs.readFileSync(jsonFilePath, "utf8")
        );

        const filteredConversation = conversationData.filter((msg) => {
          if (["image", "video", "document", "audio"].includes(msg.type)) {
            // Collect file link to delete
            const mediaLink = msg.msgContext[msg.type]?.link;
            if (mediaLink) {
              const filePath = path.join(
                mediaFolderPath,
                mediaLink.split("/").pop()
              );
              // Delete the file
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Deleted file: ${filePath}`);
              } else {
                console.warn(`File not found: ${filePath}`);
              }
            }
            return false; // Exclude this message from the updated conversation
          }
          return true; // Include non-media messages
        });

        // Write updated conversation back to the JSON file
        fs.writeFileSync(
          jsonFilePath,
          JSON.stringify(filteredConversation, null, 2),
          "utf8"
        );
        console.log("Media messages removed, and JSON updated successfully.");
        break;

      case "clear":
        // Handle "clear" type: Clear the entire conversation JSON
        fs.writeFileSync(jsonFilePath, JSON.stringify([], null, 2), "utf8");
        console.log("Conversation JSON cleared successfully.");
        break;

      case "delete":
        // Handle "delete" type: Delete the JSON file
        fs.unlinkSync(jsonFilePath);
        console.log("Conversation JSON file deleted successfully.");
        break;

      default:
        console.error(
          "Invalid type provided. Use 'media', 'clear', or 'delete'."
        );
    }
  } catch (error) {
    console.error("Error processing conversation JSON:", error.message);
  }
}

async function gettimeZone(data) {
  if (data.role === "agent") {
    const tz = getCurrentTimestampInTimeZone(data?.timezone || "Asia/Kolkata");
    return tz;
  } else {
    const tz = getCurrentTimestampInTimeZone(
      data?.inboxContent?.userData?.timezone || "Asia/Kolkata"
    );
    return tz;
  }
}

module.exports = {
  mergeArraysWithPhonebook,
  sendMessageMeta,
  returnMsgObjAfterAddingKey,
  sendMetaMsg,
  deleteMediaFromConversation,
  gettimeZone,
};

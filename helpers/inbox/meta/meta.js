const { query } = require("../../../database/dbpromise");
const axios = require("axios");
const randomstring = require("randomstring");
const fs = require("fs");
const path = require("path");
const moment = require("moment");
const {
  convertNumberToRandomString,
  updateMessageObjectInFile,
  addObjectToFile,
} = require("../../../functions/function");

function getCurrentTimestampInTimeZone(timezone) {
  const currentTimeInZone = moment.tz(timezone);
  const currentTimestampInSeconds = Math.round(
    currentTimeInZone.valueOf() / 1000
  );

  return currentTimestampInSeconds;
}

async function downloadAndSaveMedia(token, mediaId) {
  try {
    const { data: mediaData } = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}/`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!mediaData.url) throw new Error("Media URL not found.");

    const response = await axios.get(mediaData.url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "arraybuffer",
    });

    const ext = response.headers["content-type"]?.split("/")[1];
    if (!ext) throw new Error("Unable to determine file extension.");

    const fileName = `${randomstring.generate()}.${ext}`;
    const savePath = path.resolve(
      __dirname,
      "../../../client/public/meta-media",
      fileName
    );
    fs.writeFileSync(savePath, response.data);

    return fileName;
  } catch (err) {
    console.error("Error downloading media:", err.message);
    return null;
  }
}

function formatMessage(type, content) {
  return { type, [type]: content };
}

async function processMediaMsg(type, messages, uid) {
  try {
    const [{ access_token: token }] = await query(
      `SELECT * FROM meta_api WHERE uid = ?`,
      [uid]
    );
    if (!token) return null;

    const mediaId = messages[0]?.[type]?.id;
    const fileName = await downloadAndSaveMedia(token, mediaId);
    if (!fileName) return null;

    const content = {
      link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
    };
    if (messages[0]?.[type]?.caption)
      content.caption = messages[0][type].caption;

    return formatMessage(type, content);
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function processMetaMsg({
  body,
  uid,
  userFromMysql,
  conversationPathNew, // File path for the conversation JSON
}) {
  try {
    // Validate webhook body
    if (!body?.entry?.[0]?.changes?.[0]?.value) return null;

    const value = body.entry[0].changes[0].value;
    const messages = value.messages || [];
    const statuses = value.statuses || [];

    // If no messages or statuses exist, return null
    if (!messages.length && !statuses.length) return null;

    const message = messages[0] || null;

    // Ensure the conversation path exists
    if (!conversationPathNew) {
      throw new Error("Conversation path is undefined.");
    }

    const directoryPath = path.dirname(conversationPathNew);

    // Create directory if it doesn't exist
    if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
    }

    // Initialize the conversation file if it doesn't exist
    let conversationPath = [];
    if (fs.existsSync(conversationPathNew)) {
      const fileContent = fs.readFileSync(conversationPathNew, "utf-8");
      conversationPath = JSON.parse(fileContent);
    } else {
      fs.writeFileSync(conversationPathNew, JSON.stringify([], null, 2));
    }

    // Determine message type and context
    let msgContext = null;
    let statusType = ""; // Default status type
    let newMessage = null; // Initialize newMessage

    if (message) {
      const msgType = message.type;
      const interactive = message.interactive;
      const button = message?.button?.text;

      switch (msgType) {
        case "text":
          msgContext = formatMessage("text", {
            preview_url: true,
            body: message.text.body,
          });
          break;
        case "image":
        case "video":
        case "document":
        case "audio":
          msgContext = await processMediaMsg(msgType, messages, uid);
          break;
        case "sticker":
          msgContext = formatMessage("sticker", { body: "Sticker received" });
          break;
        case "reaction":
          msgContext = formatMessage("reaction", {
            emoji: message.reaction?.emoji,
            message_id: message.reaction?.message_id,
          });

          // Update the reaction on the referenced message
          const targetMessageIndex = conversationPath.findIndex(
            (msg) => msg.metaChatId === message.reaction?.message_id
          );
          if (targetMessageIndex !== -1) {
            conversationPath[targetMessageIndex].reaction =
              message.reaction?.emoji || "";
          }
          break;
        case "contacts":
          msgContext = formatMessage("contact", {
            contacts: message.contacts,
          });
          break;
        case "location":
          msgContext = formatMessage("location", {
            latitude: message.location?.latitude,
            longitude: message.location?.longitude,
            name: message.location?.name,
            address: message.location?.address,
          });
          break;
        case "order":
          msgContext = formatMessage("order", {
            catalog_id: message.order?.catalog_id,
            product_items: message.order?.product_items,
            text: message.order?.text,
          });
          break;
        default:
          // Handle interactive messages like button replies or list replies
          if (button) {
            msgContext = formatMessage("text", {
              preview_url: true,
              body: button,
            });
          } else if (interactive?.button_reply) {
            const referencedMessageId = interactive.button_reply.id;
            const referencedMessage = conversationPath.find(
              (msg) => msg.metaChatId === referencedMessageId
            );

            msgContext = formatMessage("text", {
              preview_url: true,
              body: interactive.button_reply.title,
            });

            if (referencedMessage) {
              msgContext.context = referencedMessage;
            }
          } else if (interactive?.list_reply) {
            const referencedMessageId = interactive.list_reply.id;
            const referencedMessage = conversationPath.find(
              (msg) => msg.metaChatId === referencedMessageId
            );

            msgContext = formatMessage("text", {
              preview_url: true,
              body: interactive.list_reply.title,
            });

            if (referencedMessage) {
              msgContext.context = referencedMessage;
            }
          } else {
            console.warn(`Unsupported message type: ${msgType}`);
            return null;
          }
      }
    }

    // Process statuses if present
    if (statuses.length) {
      const status = statuses[0]; // Assuming the latest status
      switch (status.status) {
        case "sent":
          statusType = "sent";
          break;
        case "delivered":
          statusType = "delivered";
          break;
        case "read":
          statusType = "read";
          break;
        case "failed":
          statusType = "failed";
          break;
        case "deleted":
          statusType = "deleted";
          break;
        default:
          console.warn(`Unsupported status type: ${status.status}`);
      }

      // Update the status in the conversation file if metaChatId matches
      const metaChatId = status.id;
      const messageIndex = conversationPath.findIndex(
        (msg) => msg.metaChatId === metaChatId
      );
      if (messageIndex !== -1) {
        if (
          statusType === "read" ||
          (statusType === "delivered" &&
            conversationPath[messageIndex].status !== "read")
        ) {
          conversationPath[messageIndex].status = statusType;
        }
      }
    }

    // Process context message if context information is present
    if (message?.context) {
      const referencedMessageId = message.context.id;
      const referencedMessage = conversationPath.find(
        (msg) => msg.metaChatId === referencedMessageId
      );

      if (referencedMessage) {
        newMessage = {
          type: msgContext.type,
          metaChatId: message.id,
          msgContext,
          reaction: "",
          timestamp: getCurrentTimestampInTimeZone(
            userFromMysql?.timezone || Date.now() / 1000
          ),
          senderName: value?.contacts?.[0]?.profile?.name || "NA",
          senderMobile: value?.contacts?.[0]?.wa_id || "NA",
          status: statusType,
          star: false,
          route: "INCOMING",
          context: referencedMessage, // Embed the entire referenced message object
          origin: "meta",
        };

        conversationPath.push(newMessage);
      }
    } else if (message && msgContext && !message?.reaction) {
      // Add new messages to the conversation array if a valid message exists
      newMessage = {
        type: msgContext.type,
        metaChatId: message.id,
        msgContext,
        reaction: "",
        timestamp: getCurrentTimestampInTimeZone(
          userFromMysql?.timezone || Date.now() / 1000
        ),
        senderName: value?.contacts?.[0]?.profile?.name || "NA",
        senderMobile: value?.contacts?.[0]?.wa_id || "NA",
        status: statusType,
        star: false,
        route: "INCOMING",
        context: "",
        origin: "meta",
      };

      conversationPath.push(newMessage);
    }

    // Write the updated conversation array back to the file
    fs.writeFileSync(
      conversationPathNew,
      JSON.stringify(conversationPath, null, 2)
    );

    // Get the latest 10 messages
    const latestMessages = conversationPath.slice(-10);

    // Return the new message and the latest 10 messages
    return { newMessage, latestMessages, statuses };
  } catch (err) {
    console.error("Error normalizing meta object:", err.message);
    return null;
  }
}

function extractMessageContent(webhookBody) {
  const { type, msgContext, senderName, senderMobile } = webhookBody;

  let text = null;

  if (msgContext) {
    switch (type) {
      case "text":
        text = msgContext.text?.body || null;
        break;

      case "image":
        text = msgContext.image?.caption || null;
        break;

      case "video":
        text = msgContext.video?.caption || null;
        break;

      case "document":
        text = msgContext.document?.caption || null;
        break;

      case "reaction":
        text = msgContext.reaction?.emoji || null;
        break;

      case "status":
        text = msgContext.status?.status || null;
        break;

      case "sticker":
        text = msgContext.sticker?.body || null;
        break;

      case "location":
        const { latitude, longitude } = msgContext.location || {};
        text =
          latitude && longitude
            ? `Location: Lat ${latitude}, Long ${longitude}`
            : null;
        break;

      case "contact":
        const contacts = msgContext.contact?.contacts || [];
        if (contacts.length > 0) {
          const firstContact = contacts[0];
          text = firstContact.name?.formatted_name || null;
        }
        break;

      case "context":
        text = msgContext.text?.body || null;
        break;

      default:
        text = null;
    }
  }

  return {
    text,
    senderName: senderName || null,
    senderMobile: senderMobile || null,
  };
}

module.exports = {
  processMetaMsg,
  extractMessageContent,
};

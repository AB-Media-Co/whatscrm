const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { query } = require("../database/dbpromise");
const { default: axios } = require("axios");
const randomstring = require("randomstring");
const { getIOInstance } = () => {};
const fetch = require("node-fetch");
const mime = require("mime-types");
const nodemailer = require("nodemailer");
const unzipper = require("unzipper");
const { destributeTaskFlow } = require("./chatbot");

function executeQueries(queries, connection) {
  return new Promise(async (resolve) => {
    try {
      for (const query of queries) {
        await connection.query(query);
      }
      resolve({
        success: true,
      });
    } catch (err) {
      resolve({
        success: false,
        err,
      });
    }
  });
}

function findTargetNodes(nodes, edges, incomingWord) {
  const matchingEdges = edges.filter(
    (edge) => edge.sourceHandle === incomingWord
  );
  const targetNodeIds = matchingEdges.map((edge) => edge.target);
  const targetNodes = nodes.filter((node) => targetNodeIds.includes(node.id));
  return targetNodes;
}

function checkAssignAi(nodes) {
  try {
    const check = nodes.filter((x) => x?.data?.msgContent?.assignAi === true);
    return check?.length > 0 ? check : [];
  } catch (err) {
    console.log(err);
    return [];
  }
}

function getReply(nodes, edges, incomingWord) {
  const getNormal = findTargetNodes(nodes, edges, incomingWord);
  if (getNormal.length > 0) {
    return getNormal;
  } else if (checkAssignAi(nodes)?.length > 0) {
    const findAiNodes = checkAssignAi(nodes);
    return findAiNodes;
  } else {
    const getOther = findTargetNodes(nodes, edges, "{{OTHER_MSG}}");
    return getOther;
  }
}

async function runChatbot(i, incomingMsg, uid, senderNumber, toName) {
  const chatbot = i;
  const forAll = i?.for_all > 0 ? true : false;

  if (!forAll) {
    // checking if number is there
    const numberArr = JSON.parse(chatbot?.chats);
    const chatId = convertNumberToRandomString(senderNumber || "");
    const flow = JSON.parse(i?.flow);

    if (numberArr.includes(senderNumber)) {
      const nodePath = `${__dirname}/../flow-json/nodes/${uid}/${flow?.flow_id}.json`;
      const edgePath = `${__dirname}/../flow-json/edges/${uid}/${flow?.flow_id}.json`;

      const nodes = readJsonFromFile(nodePath);
      const edges = readJsonFromFile(edgePath);

      if (nodes.length > 0 && edges.length > 0) {
        const answer = getReply(nodes, edges, incomingMsg);

        if (answer.length > 0) {
          for (const k of answer) {
            await destributeTaskFlow({
              uid: uid,
              k: k,
              chatbotFromMysq: chatbot,
              toName: toName,
              senderNumber,
              sendMetaMsg,
              chatId,
              nodes,
              edges,
              incomingMsg,
              flowData: flow,
            });
          }
        }
      }
    }
  } else {
    const chatId = convertNumberToRandomString(senderNumber || "");
    const flow = JSON.parse(i?.flow);

    const nodePath = `${__dirname}/../flow-json/nodes/${uid}/${flow?.flow_id}.json`;
    const edgePath = `${__dirname}/../flow-json/edges/${uid}/${flow?.flow_id}.json`;

    const nodes = readJsonFromFile(nodePath);
    const edges = readJsonFromFile(edgePath);

    if (nodes.length > 0 && edges.length > 0) {
      const answer = getReply(nodes, edges, incomingMsg);

      console.log({ answer2: JSON.stringify(answer) });

      if (answer.length > 0) {
        for (const k of answer) {
          await destributeTaskFlow({
            uid: uid,
            k: k,
            chatbotFromMysq: chatbot,
            toName: toName,
            senderNumber,
            sendMetaMsg,
            chatId,
            nodes,
            edges,
            incomingMsg,
            flowData: flow,
          });
        }
      }
    }
  }
}

async function botWebhook(incomingMsg, uid, senderNumber, toName) {
  console.log("botWebhook RAN");

  const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
  if (getUser[0]?.plan) {
    const plan = JSON.parse(getUser[0]?.plan);
    if (plan.allow_chatbot > 0) {
      const chatbots = await query(
        `SELECT * FROM chatbot WHERE uid = ? AND active = ?`,
        [uid, 1]
      );

      if (chatbots.length > 0) {
        await Promise.all(
          chatbots.map((i) =>
            runChatbot(i, incomingMsg, uid, senderNumber, toName)
          )
        );
      }
    } else {
      await query(`UPDATE chatbot SET active = ? WHERE uid = ?`, [0, uid]);
    }
  }
}

async function saveMessage(body, uid, type, msgContext) {
  try {
    console.log("CAME HERE");

    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
    const userTimezone = getCurrentTimestampInTimeZone(
      getUser[0]?.timezone || Date.now() / 1000
    );

    const chatId = convertNumberToRandomString(
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );

    const actualMsg = {
      type: type,
      metaChatId: body?.entry[0]?.changes[0]?.value?.messages[0]?.id,
      msgContext: msgContext,
      reaction: "",
      timestamp: userTimezone,
      senderName: body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA",
      senderMobile: body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id
        : "NA",
      status: "",
      star: false,
      route: "INCOMING",
      context: body?.entry[0]?.changes[0]?.value?.messages[0]
        ? body?.entry[0]?.changes[0]?.value?.messages[0]?.context
        : "",
    };

    // find chat
    const chat = await query(
      `SELECT * FROM chats WHERE chat_id = ? AND uid = ?`,
      [chatId, uid]
    );

    if (chat.length < 1) {
      await query(
        `INSERT INTO chats (chat_id, uid, last_message_came, sender_name, sender_mobile, last_message, is_opened) VALUES (
            ?,?,?,?,?,?,?
        )`,
        [
          chatId,
          uid,
          userTimezone,
          body?.entry[0]?.changes
            ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
            : "NA",
          body?.entry[0]?.changes
            ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id
            : "NA",
          JSON.stringify(actualMsg),
          0,
        ]
      );
    } else {
      await query(
        `UPDATE chats SET last_message_came = ?, last_message = ?, is_opened = ? WHERE chat_id = ? AND uid = ?`,
        [userTimezone, JSON.stringify(actualMsg), 0, chatId, uid]
      );
    }

    const chatPath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
    addObjectToFile(actualMsg, chatPath);

    const io = getIOInstance();

    const getId = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

    const chats = await query(`SELECT * FROM chats WHERE uid = ?`, [uid]);

    io.to(getId[0]?.socket_id).emit("update_conversations", { chats: chats });

    io.to(getId[0]?.socket_id).emit("push_new_msg", {
      msg: actualMsg,
      chatId: chatId,
    });

    // checking if the agent has this chat
    const getAgentChat = await query(
      `SELECT * FROM agent_chats WHERE owner_uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (getAgentChat.length > 0) {
      const getMyChatsId = await query(
        `SELECT * FROM agent_chats WHERE uid = ?`,
        [getAgentChat[0]?.uid]
      );

      const chatIds = getMyChatsId.map((i) => i?.chat_id);

      const chatsNew = await query(
        `SELECT * FROM chats WHERE chat_id IN (?) AND uid = ?`,
        [chatIds, uid]
      );

      const getAgentSocket = await query(`SELECT * FROM rooms WHERE uid = ?`, [
        getAgentChat[0]?.uid,
      ]);
      io.to(getAgentSocket[0]?.socket_id).emit("update_conversations", {
        chats: chatsNew || [],
      });

      io.to(getAgentSocket[0]?.socket_id).emit("push_new_msg", {
        msg: actualMsg,
        chatId: chatId,
      });
    }
  } catch (err) {
    console.log(`error in saveMessage in function `, err);
  }
}

async function saveWebhookConversation(body, uid) {
  //  saving simple text
  if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.type === "text"
  ) {
    saveMessage(body, uid, "text", {
      type: "text",
      text: {
        preview_url: true,
        body: body?.entry[0]?.changes[0]?.value?.messages[0]?.text?.body,
      },
    });

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.text?.body,
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // images
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.image
  ) {
    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const metAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    const metaToken = metAPI[0]?.access_token;

    if (metaToken) {
      console.log({ metaToken });
      const fileName = await downloadAndSaveMedia(
        metaToken,
        body?.entry[0]?.changes[0]?.value?.messages[0]?.image?.id
      );
      console.log({ fileName });
      saveMessage(body, uid, "image", {
        type: "image",
        image: {
          link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
          caption:
            body?.entry[0]?.changes[0]?.value?.messages[0]?.image?.caption ||
            "",
        },
      });
    }
    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.image?.caption ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // video
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.video
  ) {
    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const metAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    const metaToken = metAPI[0]?.access_token;

    if (metaToken) {
      const fileName = await downloadAndSaveMedia(
        metaToken,
        body?.entry[0]?.changes[0]?.value?.messages[0]?.video?.id
      );
      saveMessage(body, uid, "video", {
        type: "video",
        video: {
          link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
          caption:
            body?.entry[0]?.changes[0]?.value?.messages[0]?.video?.caption,
        },
      });
    }

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.video?.caption ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // document
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.document
  ) {
    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const metAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    const metaToken = metAPI[0]?.access_token;

    if (metaToken) {
      const fileName = await downloadAndSaveMedia(
        metaToken,
        body?.entry[0]?.changes[0]?.value?.messages[0]?.document?.id
      );
      saveMessage(body, uid, "document", {
        type: "document",
        document: {
          link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
          caption:
            body?.entry[0]?.changes[0]?.value?.messages[0]?.document?.caption,
        },
      });
    }
    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.document?.caption ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // audio
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.audio
  ) {
    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const metAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    const metaToken = metAPI[0]?.access_token;

    if (metaToken) {
      const fileName = await downloadAndSaveMedia(
        metaToken,
        body?.entry[0]?.changes[0]?.value?.messages[0]?.audio?.id
      );
      saveMessage(body, uid, "audio", {
        type: "audio",
        audio: {
          link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
        },
      });
    }

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.document?.caption ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // adding reactions
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction
  ) {
    const chatId = convertNumberToRandomString(
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
    const filePath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
    updateMessageObjectInFile(
      filePath,
      body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.message_id,
      "reaction",
      body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.emoji
    );

    const io = getIOInstance();

    const getId = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

    io.to(getId[0]?.socket_id).emit("push_new_reaction", {
      reaction: body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.emoji,
      chatId: chatId,
      msgId:
        body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.message_id,
    });

    // setting up for agent
    const getAgentChat = await query(
      `SELECT * FROM agent_chats WHERE owner_uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (getAgentChat.length > 0) {
      const getAgentSocket = await query(`SELECT * FROM rooms WHERE uid = ?`, [
        getAgentChat[0]?.uid,
      ]);

      io.to(getAgentSocket[0]?.socket_id).emit("push_new_reaction", {
        reaction:
          body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.emoji,
        chatId: chatId,
        msgId:
          body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.message_id,
      });
    }
  }

  // for button reply in tempelt message
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.button?.text
  ) {
    saveMessage(body, uid, "text", {
      type: "text",
      text: {
        preview_url: true,
        body: body?.entry[0]?.changes[0]?.value?.messages[0]?.button?.text,
      },
    });

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.button?.text ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // quick reply button
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive?.button_reply
  ) {
    saveMessage(body, uid, "text", {
      type: "text",
      text: {
        preview_url: true,
        body: body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive
          ?.button_reply?.title,
      },
    });

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive?.button_reply
        ?.title || "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // updating delivery status
  else if (
    body?.entry[0]?.changes[0]?.value?.statuses &&
    body?.entry[0]?.changes[0]?.value?.statuses[0]?.id
  ) {
    const metaMsgId = body?.entry[0]?.changes[0]?.value?.statuses[0]?.id;

    // console.log(`update msg:-`, JSON.stringify(body))

    const chatId = convertNumberToRandomString(
      body?.entry[0]?.changes[0]?.value?.statuses[0]?.recipient_id,
      body?.entry[0]?.changes || "NA"
    );

    const filePath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
    updateMessageObjectInFile(
      filePath,
      metaMsgId,
      "status",
      body?.entry[0]?.changes[0]?.value?.statuses[0]?.status
    );

    const io = getIOInstance();

    const getId = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

    io.to(getId[0]?.socket_id).emit("update_delivery_status", {
      chatId: chatId,
      status: body?.entry[0]?.changes[0]?.value?.statuses[0]?.status,
      msgId: body?.entry[0]?.changes[0]?.value?.statuses[0]?.id,
    });

    // setting up for agent
    const getAgentChat = await query(
      `SELECT * FROM agent_chats WHERE owner_uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (getAgentChat.length > 0) {
      const getAgentSocket = await query(`SELECT * FROM rooms WHERE uid = ?`, [
        getAgentChat[0]?.uid,
      ]);

      io.to(getAgentSocket[0]?.socket_id).emit("update_delivery_status", {
        chatId: chatId,
        status: body?.entry[0]?.changes[0]?.value?.statuses[0]?.status,
        msgId: body?.entry[0]?.changes[0]?.value?.statuses[0]?.id,
      });
    }

    if (body?.entry[0]?.changes[0]?.value?.statuses[0]?.status === "failed") {
      console.log({
        hey: JSON.stringify(
          body?.entry[0]?.changes[0]?.value?.statuses[0]?.errors[0]?.message
        ),
      });

      await query(
        `UPDATE broadcast_log SET delivery_status = ?, err = ? WHERE meta_msg_id = ?`,
        [
          body?.entry[0]?.changes[0]?.value?.statuses[0]?.status,
          JSON.stringify(body),
          metaMsgId,
        ]
      );
    } else {
      await query(
        `UPDATE broadcast_log SET delivery_status = ? WHERE meta_msg_id = ?`,
        [body?.entry[0]?.changes[0]?.value?.statuses[0]?.status, metaMsgId]
      );
    }
  }

  // list reply button
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive?.list_reply
  ) {
    saveMessage(body, uid, "text", {
      type: "text",
      text: {
        preview_url: true,
        body: body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive
          ?.list_reply?.title,
      },
    });
    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive?.list_reply
        ?.title || "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }
}

function updateMessageObjectInFile(filePath, metaChatId, key, value) {
  // Read JSON data from the file
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading file:", err);
      return;
    }

    try {
      // Parse JSON data
      const dataArray = JSON.parse(data);

      // Find the message object with the given metaChatId
      const message = dataArray.find((obj) => obj.metaChatId === metaChatId);

      // If the message is found, update the key with the new value
      if (message) {
        message[key] = value;
        console.log(
          `Updated message with metaChatId ${metaChatId}: ${key} set to ${value}`
        );

        // Write the modified JSON data back to the file
        fs.writeFile(
          filePath,
          JSON.stringify(dataArray, null, 2),
          "utf8",
          (err) => {
            if (err) {
              console.error("Error writing file:", err);
              return;
            }
            console.log("File updated successfully");
          }
        );
      } else {
        console.error(`Message with metaChatId ${metaChatId} not found`);
      }
    } catch (error) {
      console.error("Error parsing JSON:", error);
    }
  });
}

async function downloadAndSaveMedia(token, mediaId) {
  try {
    const url = `https://graph.facebook.com/v19.0/${mediaId}/`;
    // retriving url
    const getUrl = await axios(url, {
      headers: {
        Authorization: "Bearer " + token,
      },
    });

    const config = {
      method: "get",
      url: getUrl?.data?.url, //PASS THE URL HERE, WHICH YOU RECEIVED WITH THE HELP OF MEDIA ID
      headers: {
        Authorization: `Bearer ${token}`,
      },
      responseType: "arraybuffer",
    };

    const response = await axios(config);
    const ext = response.headers["content-type"].split("/")[1];

    const randomSt = randomstring.generate();
    const savingPath = `${__dirname}/../client/public/meta-media/${randomSt}`;
    fs.writeFileSync(`${savingPath}.${ext}`, response.data);
    return `${randomSt}.${ext}`;
  } catch (error) {
    console.error("Error downloading media:", error);
  }
}

function getCurrentTimestampInTimeZone(timezone) {
  const currentTimeInZone = moment.tz(timezone);
  const currentTimestampInSeconds = Math.round(
    currentTimeInZone.valueOf() / 1000
  );

  return currentTimestampInSeconds;
}

function addObjectToFile(object, filePath) {
  const parentDir = path.dirname(filePath);

  // Check if the parent directory exists
  if (!fs.existsSync(parentDir)) {
    // Create the parent directory if it doesn't exist
    fs.mkdirSync(parentDir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    const existingData = JSON.parse(fs.readFileSync(filePath));
    if (Array.isArray(existingData)) {
      existingData.push(object);
      fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));
    } else {
      console.error("File does not contain an array.");
    }
  } else {
    fs.writeFileSync(filePath, JSON.stringify([object], null, 2));
  }
}

function convertNumberToRandomString(number) {
  const mapping = {
    0: "i",
    1: "j",
    2: "I",
    3: "u",
    4: "I",
    5: "U",
    6: "S",
    7: "D",
    8: "B",
    9: "j",
  };

  const numStr = number.toString();
  let result = "";
  for (let i = 0; i < numStr.length; i++) {
    const digit = numStr[i];
    result += mapping[digit];
  }
  return result;
}

function saveJsonToFile(jsonData, dir) {
  const timestamp = Date.now();
  const filename = `${timestamp}.json`;
  const jsonString = JSON.stringify(jsonData, null, 2); // null and 2 for pretty formatting
  const directory = dir; // Change this to your desired directory
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory);
  }
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, jsonString);
  console.log(`JSON data saved to ${filePath}`);
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function areMobileNumbersFilled(array) {
  for (const item of array) {
    if (!item.mobile) {
      return false;
    }
  }

  return true;
}

function getFileExtension(fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex !== -1 && dotIndex !== 0) {
    const extension = fileName.substring(dotIndex + 1);
    return extension.toLowerCase();
  }
  return "";
}

function writeJsonToFile(filepath, jsonData, callback) {
  return new Promise((resolve, reject) => {
    // Ensure directory structure exists
    const directory = path.dirname(filepath);
    fs.mkdir(directory, { recursive: true }, function (err) {
      if (err) {
        if (callback) {
          callback(err);
        }
        reject(err);
        return;
      }

      // Convert JSON data to string
      const jsonString = JSON.stringify(jsonData, null, 2); // 2 spaces indentation for readability

      // Write JSON data to file, with 'w' flag to overwrite existing file
      fs.writeFile(filepath, jsonString, { flag: "w" }, function (err) {
        if (err) {
          if (callback) {
            callback(err);
          }
          reject(err);
          return;
        }
        const message = `JSON data has been written to '${filepath}'.`;
        if (callback) {
          callback(null, message);
        }
        resolve(message);
      });
    });
  });
}

function deleteFileIfExists(filePath) {
  // Check if the file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      // File does not exist, do nothing
      console.error(`File ${filePath} does not exist.`);
      return;
    }

    // File exists, delete it
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(`Error deleting file ${filePath}:`, err);
        return;
      }
      console.log(`File ${filePath} has been deleted.`);
    });
  });
}

function readJsonFromFile(filePath) {
  try {
    // Read the file synchronously
    const jsonData = fs.readFileSync(filePath, "utf8");
    // Parse JSON data
    const parsedData = JSON.parse(jsonData);
    // If parsed data is an array, return it, otherwise return an empty array
    return Array.isArray(parsedData) ? parsedData : [];
  } catch (err) {
    // If any error occurs (e.g., file not found or invalid JSON), return an empty array
    console.error(`Error reading JSON file ${filePath}:`, err);
    return [];
  }
}

function readJSONFile(filePath, length) {
  try {
    console.log("HEY");
    // Check if the file exists
    if (!fs.existsSync(filePath)) {
      console.error("File not found:", filePath);
      return []; // Return empty array if file does not exist
    }

    // Read the file content
    let fileContent = fs.readFileSync(filePath, "utf8");

    // }\n]  }\n]

    if (fileContent?.endsWith("}\n]  }\n]")) {
      console.log("FOUND ENDS");
      console.log("Invalid JSON found, making it correct");
      fileContent = fileContent.replace("}\n]  }\n]", "\n}\n]");
      console.log("Correction done!");

      // Write the corrected JSON back to the file
      fs.writeFileSync(filePath, fileContent, "utf8");
      console.log("Corrected JSON has been written to the file");
    }

    // Remove invalid trailing characters if they exist
    if (fileContent?.endsWith("}\n]\n}\n]")) {
      console.log("FOUND ENDS");
      console.log("Invalid JSON found, making it correct");
      fileContent = fileContent.replace("}\n]\n}\n]", "\n}\n]");
      console.log("Correction done!");

      // Write the corrected JSON back to the file
      fs.writeFileSync(filePath, fileContent, "utf8");
      console.log("Corrected JSON has been written to the file");
    }

    // Try to parse the JSON
    let jsonArray;
    try {
      jsonArray = JSON.parse(fileContent);
    } catch (error) {
      console.error("Initial JSON parse error:", error.message);
      return []; // Return empty array if JSON is not valid
    }

    // Check if the parsed content is an array
    if (!Array.isArray(jsonArray)) {
      console.error("Invalid JSON format: not an array");
      return []; // Return empty array if JSON is not an array
    }

    // If length is provided, return only specified number of latest objects
    if (typeof length === "number" && length > 0) {
      return jsonArray.slice(-length);
    }

    return jsonArray; // Return all objects if length is not provided or invalid
  } catch (error) {
    console.error("Error reading JSON file:", error);
    return []; // Return empty array if there's an error
  }
}

function updateMetaTempletInMsg(uid, savObj, chatId, msgId) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log({ thisss: uid });
      const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

      if (getUser.length < 1) {
        return resolve({ success: false, msg: "user not found" });
      }

      const userTimezone = getCurrentTimestampInTimeZone(
        getUser[0]?.timezone || Date.now() / 1000
      );
      const finalSaveMsg = {
        ...savObj,
        metaChatId: msgId,
        timestamp: userTimezone,
      };

      const chatPath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
      addObjectToFile(finalSaveMsg, chatPath);

      const io = getIOInstance();

      await query(
        `UPDATE chats SET last_message_came = ?, last_message = ?, is_opened = ? WHERE chat_id = ?`,
        [userTimezone, JSON.stringify(savObj), 0, chatId]
      );

      const getId = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

      await query(`UPDATE chats SET is_opened = ? WHERE chat_id = ?`, [
        1,
        chatId,
      ]);

      const chats = await query(`SELECT * FROM chats WHERE uid = ?`, [uid]);

      io.to(getId[0]?.socket_id).emit("update_conversations", {
        chats: chats,
        notificationOff: true,
      });

      io.to(getId[0]?.socket_id).emit("push_new_msg", {
        msg: finalSaveMsg,
        chatId: chatId,
      });

      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function sendAPIMessage(obj, waNumId, waToken) {
  return new Promise(async (resolve) => {
    try {
      const url = `https://graph.facebook.com/v17.0/${waNumId}/messages`;

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...obj,
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
        return resolve({ success: false, message: data?.error?.message });
      }

      resolve({
        success: true,
        message: "Message sent successfully!",
        data: data?.messages[0],
      });
    } catch (err) {
      resolve({ success: false, msg: err.toString(), err });
      console.log(err);
    }
  });
}

function sendMetaMsg(uid, msgObj, toNumber, savObj, chatId) {
  return new Promise(async (resolve) => {
    try {
      const getMeta = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
        uid,
      ]);
      const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

      if (getMeta.length < 1) {
        return resolve({ success: false, msg: "Unable to to find API " });
      }

      const waToken = getMeta[0]?.access_token;
      const waNumId = getMeta[0]?.business_phone_number_id;

      if (!waToken || !waNumId) {
        return resolve({
          success: false,
          msg: "Please add your meta token and phone number ID",
        });
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
        return resolve({ success: false, msg: data?.error?.message });
      }

      if (data?.messages[0]?.id) {
        const userTimezone = getCurrentTimestampInTimeZone(
          getUser[0]?.timezone || Date.now() / 1000
        );
        const finalSaveMsg = {
          ...savObj,
          metaChatId: data?.messages[0]?.id,
          timestamp: userTimezone,
        };

        const chatPath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
        addObjectToFile(finalSaveMsg, chatPath);

        await query(
          `UPDATE chats SET last_message_came = ?, last_message = ?, is_opened = ? WHERE chat_id = ?`,
          [userTimezone, JSON.stringify(finalSaveMsg), 1, chatId]
        );

        await query(`UPDATE chats SET is_opened = ? WHERE chat_id = ?`, [
          1,
          chatId,
        ]);
      }

      resolve({ success: true });
    } catch (err) {
      resolve({ success: false, msg: err.toString(), err });
      console.log(err);
    }
  });
}

function mergeArrays(arrA, arrB) {
  const mergedArray = arrB.map((objB) => {
    const matchingObject = arrA.find(
      (objA) => objA.mobile === objB.sender_mobile
    );
    if (matchingObject) {
      return { ...objB, contact: matchingObject };
    }
    return objB;
  });

  return mergedArray;
}

async function getBusinessPhoneNumber(
  apiVersion,
  businessPhoneNumberId,
  bearerToken
) {
  const url = `https://graph.facebook.com/${apiVersion}/${businessPhoneNumberId}`;
  const options = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function createMetaTemplet(apiVersion, waba_id, bearerToken, body) {
  const url = `https://graph.facebook.com/${apiVersion}/${waba_id}/message_templates`;
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body), // Include the request body here
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function getAllTempletsMeta(apiVersion, waba_id, bearerToken) {
  const url = `https://graph.facebook.com/${apiVersion}/${waba_id}/message_templates`;
  const options = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function delMetaTemplet(apiVersion, waba_id, bearerToken, name) {
  const url = `https://graph.facebook.com/${apiVersion}/${waba_id}/message_templates?name=${name}`;
  const options = {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function sendMetatemplet(
  toNumber,
  business_phone_number_id,
  token,
  template,
  example,
  dynamicMedia
) {
  const checkBody = template?.components?.filter((i) => i.type === "BODY");
  const getHeader = template?.components?.filter((i) => i.type === "HEADER");
  const headerFormat = getHeader.length > 0 ? getHeader[0]?.format : "";

  let templ = {
    name: template?.name,
    language: {
      code: template?.language,
    },
    components: [],
  };

  if (checkBody.length > 0) {
    const comp = checkBody[0]?.example?.body_text[0]?.map((i, key) => ({
      type: "text",
      text: example[key] || i,
    }));
    if (comp) {
      templ.components.push({
        type: "body",
        parameters: comp,
      });
    }
  }

  if (headerFormat === "IMAGE" && getHeader.length > 0) {
    const getMedia = await query(
      `SELECT * FROM meta_templet_media WHERE templet_name = ?`,
      [template?.name]
    );

    templ.components.unshift({
      type: "header",
      parameters: [
        {
          type: "image",
          image: {
            link: dynamicMedia
              ? dynamicMedia
              : getMedia.length > 0
              ? `${process.env.FRONTENDURI}/media/${getMedia[0]?.file_name}`
              : getHeader[0].example?.header_handle[0],
          },
        },
      ],
    });
  }

  if (headerFormat === "VIDEO" && getHeader.length > 0) {
    const getMedia = await query(
      `SELECT * FROM meta_templet_media WHERE templet_name = ?`,
      [template?.name]
    );

    templ.components.unshift({
      type: "header",
      parameters: [
        {
          type: "video",
          video: {
            link: dynamicMedia
              ? dynamicMedia
              : getMedia.length > 0
              ? `${process.env.FRONTENDURI}/media/${getMedia[0]?.file_name}`
              : getHeader[0].example?.header_handle[0],
          },
        },
      ],
    });
  }

  if (headerFormat === "DOCUMENT" && getHeader.length > 0) {
    const getMedia = await query(
      `SELECT * FROM meta_templet_media WHERE templet_name = ?`,
      [template?.name]
    );

    templ.components.unshift({
      type: "header",
      parameters: [
        {
          type: "document",
          document: {
            link: dynamicMedia
              ? dynamicMedia
              : getMedia.length > 0
              ? `${process.env.FRONTENDURI}/media/${getMedia[0]?.file_name}`
              : getHeader[0].example?.header_handle[0],
            filename: "document",
          },
        },
      ],
    });
  }

  const url = `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`;

  // console.log({ templ: JSON.stringify(templ) })

  const body = {
    messaging_product: "whatsapp",
    to: toNumber,
    type: "template",
    template: templ,
  };

  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    // console.log({ data: JSON.stringify(data) });
    // console.log({ body: JSON.stringify(body) });
    // console.log({ data })
    return data;
  } catch (error) {
    console.error("Error sending message:", error);
    throw error;
  }
}

function getFileInfo(filePath) {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stats) => {
      if (err) {
        reject(err);
      } else {
        const fileSizeInBytes = stats.size;
        const mimeType = mime.lookup(filePath) || "application/octet-stream";
        resolve({ fileSizeInBytes, mimeType });
      }
    });
  });
}

async function getSessionUploadMediaMeta(
  apiVersion,
  app_id,
  bearerToken,
  fileSize,
  mimeType
) {
  const url = `https://graph.facebook.com/${apiVersion}/${app_id}/uploads?file_length=${fileSize}&file_type=${mimeType}`;
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function uploadFileMeta(sessionId, filePath, apiVersion, accessToken) {
  return new Promise(async (resolve) => {
    try {
      // Read the file as binary data
      const fileData = fs.readFileSync(filePath);

      // Prepare URL
      const url = `https://graph.facebook.com/${apiVersion}/${sessionId}`;

      // Prepare options for fetch
      const options = {
        method: "POST",
        headers: {
          Authorization: `OAuth ${accessToken}`,
          "Content-Type": "application/pdf",
          Cookie: "ps_l=0; ps_n=0",
        },
        body: fileData,
      };

      // Make fetch request
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorResponse = await response.json(); // Parse error response as JSON
        console.error("Error response:", errorResponse);
        return resolve({ success: false, data: errorResponse });
      }
      const data = await response.json();
      return resolve({ success: true, data });
    } catch (error) {
      return resolve({ success: false, data: error });
    }
  });
}

async function getMetaNumberDetail(
  apiVersion,
  budiness_phone_number_id,
  bearerToken
) {
  const url = `https://graph.facebook.com/${apiVersion}/${budiness_phone_number_id}`;
  const options = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

function addDaysToCurrentTimestamp(days) {
  // Get the current timestamp
  let currentTimestamp = Date.now();

  // Calculate the milliseconds for the given number of days
  let millisecondsToAdd = days * 24 * 60 * 60 * 1000;

  // Add the milliseconds to the current timestamp
  let newTimestamp = currentTimestamp + millisecondsToAdd;

  // Return the new timestamp
  return newTimestamp;
}

// update user plan
async function updateUserPlan(plan, uid) {
  console.log({ plan });
  const planDays = parseInt(plan?.plan_duration_in_days || 0);
  const timeStamp = addDaysToCurrentTimestamp(planDays);
  await query(`UPDATE user SET plan = ?, plan_expire = ? WHERE uid = ?`, [
    JSON.stringify(plan),
    timeStamp,
    uid,
  ]);
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

function sendEmail(host, port, email, pass, html, subject, from, to) {
  return new Promise(async (resolve) => {
    try {
      let transporter = nodemailer.createTransport({
        host: host,
        port: port,
        secure: port === "465" ? true : false, // true for 465, false for other ports
        auth: {
          user: email, // generated ethereal user
          pass: pass, // generated ethereal password
        },
      });

      let info = await transporter.sendMail({
        from: `${from || "Email From"} <${email}>`, // sender address
        to: to, // list of receivers
        subject: subject || "Email", // Subject line
        html: html, // html body
      });

      resolve({ success: true, info });
    } catch (err) {
      resolve({ success: false, err: err.toString() || "Invalid Email" });
    }
  });
}

function getUserSignupsByMonth(users) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();

  // Filter users into paid and unpaid arrays
  const { paidUsers, unpaidUsers } = users.reduce(
    (acc, user) => {
      const planExpire = user.plan_expire
        ? new Date(parseInt(user.plan_expire))
        : null;
      const isPaid = planExpire ? planExpire > currentDate : false;
      if (isPaid) {
        acc.paidUsers.push(user);
      } else {
        acc.unpaidUsers.push(user);
      }
      return acc;
    },
    { paidUsers: [], unpaidUsers: [] }
  );

  // Create signups by month for paid users
  const paidSignupsByMonth = months.map((month, monthIndex) => {
    const usersInMonth = paidUsers.filter((user) => {
      const userDate = new Date(user.createdAt);
      return (
        userDate.getMonth() === monthIndex &&
        userDate.getFullYear() === currentYear
      );
    });
    const numberOfSignups = usersInMonth.length;
    const userEmails = usersInMonth.map((user) => user.email);
    return { month, numberOfSignups, userEmails, paid: true };
  });

  // Create signups by month for unpaid users
  const unpaidSignupsByMonth = months.map((month, monthIndex) => {
    const usersInMonth = unpaidUsers.filter((user) => {
      const userDate = new Date(user.createdAt);
      return (
        userDate.getMonth() === monthIndex &&
        userDate.getFullYear() === currentYear
      );
    });
    const numberOfSignups = usersInMonth.length;
    const userEmails = usersInMonth.map((user) => user.email);
    return { month, numberOfSignups, userEmails, paid: false };
  });

  return { paidSignupsByMonth, unpaidSignupsByMonth };
}

function getUserOrderssByMonth(orders) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const signupsByMonth = Array.from({ length: 12 }, (_, monthIndex) => {
    const month = months[monthIndex];
    const ordersInMonth = orders.filter((user) => {
      const userDate = new Date(user.createdAt);
      return (
        userDate.getMonth() === monthIndex &&
        userDate.getFullYear() === currentYear
      );
    });
    const numberOfOders = ordersInMonth.length;
    return { month, numberOfOders };
  });
  return signupsByMonth;
}

function getNumberOfDaysFromTimestamp(timestamp) {
  if (!timestamp || isNaN(timestamp)) {
    return 0; // Invalid timestamp
  }

  const currentTimestamp = Date.now();
  if (timestamp <= currentTimestamp) {
    return 0; // Timestamp is in the past or current time
  }

  const millisecondsInADay = 1000 * 60 * 60 * 24;
  const differenceInDays = Math.ceil(
    (timestamp - currentTimestamp) / millisecondsInADay
  );
  return differenceInDays;
}

async function getUserPlayDays(uid) {
  const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
  if (getUser.length < 1) {
    return 0;
  }
  if (!getUser[0].plan_expire) {
    return 0;
  } else {
    const days = getNumberOfDaysFromTimestamp(getUser[0]?.plan_expire);
    return days;
  }
}

function folderExists(folderPath) {
  try {
    // Check if the folder exists/Users/hamidsaifi/Desktop/projects/wa-crm-doc/client/public/logo192.png /Users/hamidsaifi/Desktop/projects/wa-crm-doc/client/public/logo512.png
    fs.accessSync(folderPath, fs.constants.F_OK);
    return true;
  } catch (error) {
    // Folder does not exist or inaccessible
    return false;
  }
}

async function downloadAndExtractFile(filesObject, outputFolderPath) {
  try {
    // Access the uploaded file from req.files
    const uploadedFile = filesObject.file;
    if (!uploadedFile) {
      return { success: false, msg: "No file data found in FormData" };
    }

    // Create a writable stream to save the file
    const outputPath = path.join(outputFolderPath, uploadedFile.name);

    // Move the file to the desired location
    await new Promise((resolve, reject) => {
      uploadedFile.mv(outputPath, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Extract the downloaded file
    await fs
      .createReadStream(outputPath)
      .pipe(unzipper.Extract({ path: outputFolderPath })) // Specify the output folder path for extraction
      .promise();

    // Delete the downloaded zip file after extraction
    fs.unlinkSync(outputPath);

    return { success: true, msg: "App was successfully installed/updated" };
  } catch (error) {
    console.error("Error downloading and extracting file:", error);
    return { success: false, msg: error.message };
  }
}

function fetchProfileFun(mobileId, token) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await fetch(
        `https://graph.facebook.com/v17.0/${mobileId}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          // body: JSON.stringify(payload)
        }
      );

      const data = await response.json();

      if (data.error) {
        return resolve({ success: false, msg: data.error?.message });
      } else {
        return resolve({ success: true, data: data });
      }
    } catch (error) {
      console.log({ error });
      reject(error);
    }
  });
}

function returnWidget(image, imageSize, url, position) {
  let style = "";
  switch (position) {
    case "TOP_RIGHT":
      style = "position: fixed; top: 15px; right: 15px;";
      break;
    case "TOP_CENTER":
      style =
        "position: fixed; top: 15px; right: 50%; transform: translateX(-50%);";
      break;
    case "TOP_LEFT":
      style = "position: fixed; top: 15px; left: 15px;";
      break;
    case "BOTTOM_RIGHT":
      style = "position: fixed; bottom: 15px; right: 15px;";
      break;
    case "BOTTOM_CENTER":
      style =
        "position: fixed; bottom: 15px; right: 50%; transform: translateX(-50%);";
      break;
    case "BOTTOM_LEFT":
      style = "position: fixed; bottom: 15px; left: 15px;";
      break;
    case "ALL_CENTER":
      style =
        "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);";
      break;
    default:
      // Default position is top right
      style = "position: fixed; top: 15px; right: 15px;";
      break;
  }

  return `
    <a href="${url}">
      <img  src="${image}" alt="Widget" id="widget-image"
        style="${style} width: ${imageSize}px; height: auto; cursor: pointer; z-index: 9999;">
        </a>
      <!-- Widget content -->

      <div  class="widget-container" id="widget-container"
        style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background-color: #fff; border: 1px solid #ccc; border-radius: 5px; padding: 10px; box-shadow: 0px 2px 5px rgba(0, 0, 0, 0.1); display: none; z-index: 9999;">
        <span class="close-btn" id="close-btn"
          style="position: absolute; top: 5px; right: 5px; cursor: pointer;">&times;</span>
      </div>

      
  
      <script>
        // Get references to the image and widget container
        const widgetImage = document.getElementById('widget-image');
        const widgetContainer = document.getElementById('widget-container');
  
        // Redirect to a URL when the image is clicked
        widgetImage.addEventListener('click', function () {
          // Replace '${url} with the desired URL
          window.location.href = '${url}';
        });
  
        // Close widget when close button is clicked
        const closeBtn = document.getElementById('close-btn');
        closeBtn.addEventListener('click', function (event) {
          event.stopPropagation(); // Prevents the click event from propagating to the widget image
          widgetContainer.style.display = 'none';
        });
      </script>
    `;
}

function generateWhatsAppURL(phoneNumber, text) {
  const baseUrl = "https://wa.me/";
  const formattedPhoneNumber = phoneNumber.replace(/\D/g, ""); // Remove non-numeric characters
  const encodedText = encodeURIComponent(text);
  return `${baseUrl}${formattedPhoneNumber}?text=${encodedText}`;
}

async function makeRequest({ method, url, body = null, headers = [] }) {
  try {
    // Create an AbortController to handle the timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 seconds

    // Convert headers array to an object
    const headersObject = headers.reduce((acc, { key, value }) => {
      acc[key] = value;
      return acc;
    }, {});

    // Convert body array to an object if it's not GET or DELETE
    const requestBody =
      method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify(
            body.reduce((acc, { key, value }) => {
              acc[key] = value;
              return acc;
            }, {})
          );

    // Set up the request configuration
    const config = {
      method,
      headers: headersObject,
      body: requestBody,
      signal: controller.signal,
    };

    console.log({
      config,
    });

    // Perform the request
    const response = await fetch(url, config);

    // Clear the timeout
    clearTimeout(timeoutId);

    // Check if the response status is OK
    if (!response.ok) {
      return { success: false, msg: `HTTP error ${response.status}` };
    }

    // Parse the response
    const data = await response.json();

    // Validate the response
    if (typeof data === "object" || Array.isArray(data)) {
      return { success: true, data };
    } else {
      return { success: false, msg: "Invalid response format" };
    }
  } catch (error) {
    // Handle errors (e.g., timeout, network issues)
    return { success: false, msg: error.message };
  }
}

function replacePlaceholders(template, data) {
  return template.replace(/{{{([^}]+)}}}/g, (match, key) => {
    // Remove any whitespace and parse the key
    key = key.trim();

    // Handle array indexing
    const arrayMatch = key.match(/^\[(\d+)]\.(.+)$/);
    if (arrayMatch) {
      const index = parseInt(arrayMatch[1], 10);
      const property = arrayMatch[2];

      if (Array.isArray(data) && index >= 0 && index < data.length) {
        let value = data[index];
        // Split the property string for nested properties
        const nestedKeys = property.split(".");
        for (const k of nestedKeys) {
          if (value && Object.prototype.hasOwnProperty.call(value, k)) {
            value = value[k];
          } else {
            return "NA";
          }
        }
        return value !== undefined ? value : "NA";
      } else {
        return "NA";
      }
    }

    // Handle object properties
    const keys = key.split("."); // Support for nested keys
    let value = data;

    for (const k of keys) {
      if (value && Object.prototype.hasOwnProperty.call(value, k)) {
        value = value[k];
      } else {
        return "NA"; // Return 'NA' if key is not found in the object
      }
    }

    return value !== undefined ? value : "NA"; // Return 'NA' if value is undefined
  });
}

const rzCapturePayment = (paymentId, amount, razorpayKey, razorpaySecret) => {
  // Disable SSL certificate validation
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const auth =
    "Basic " +
    Buffer.from(razorpayKey + ":" + razorpaySecret).toString("base64");

  return new Promise((resolve, reject) => {
    fetch(`https://api.razorpay.com/v1/payments/${paymentId}/capture`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: amount }), // Replace with the actual amount to capture
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.error) {
          console.error("Error capturing payment:", data.error);
          reject(data.error);
        } else {
          console.log("Payment captured successfully:", data);
          resolve(data);
        }
      })
      .catch((error) => {
        console.error("Error capturing payment:", error);
        reject(error);
      });
  });
};

async function validateFacebookToken(userAccessToken, appId, appSecret) {
  // Construct the app access token by combining App ID and App Secret
  const appAccessToken = `${appId}|${appSecret}`;

  // Define the Facebook Graph API URL for debugging tokens
  const url = `https://graph.facebook.com/debug_token?input_token=${userAccessToken}&access_token=${appAccessToken}`;

  try {
    // Fetch the response from the Facebook Graph API
    const response = await fetch(url);

    // Parse the JSON response
    const data = await response.json();

    // Check if the token is valid
    if (data.data && data.data.is_valid) {
      // Token is valid
      return { success: true, response: data };
    } else {
      // Token is not valid
      return { success: false, response: data };
    }
  } catch (error) {
    // Handle any errors that occur during the fetch operation
    console.error("Error validating Facebook token:", error);
    return { success: false, response: error };
  }
}

module.exports = {
  isValidEmail,
  downloadAndExtractFile,
  folderExists,
  sendAPIMessage,
  sendEmail,
  getUserPlayDays,
  getNumberOfDaysFromTimestamp,
  getUserOrderssByMonth,
  getUserSignupsByMonth,
  validateEmail,
  updateUserPlan,
  getFileInfo,
  uploadFileMeta,
  getMetaNumberDetail,
  getSessionUploadMediaMeta,
  sendMetaMsg,
  updateMetaTempletInMsg,
  sendMetatemplet,
  delMetaTemplet,
  getAllTempletsMeta,
  createMetaTemplet,
  getBusinessPhoneNumber,
  botWebhook,
  mergeArrays,
  readJSONFile,
  writeJsonToFile,
  getCurrentTimestampInTimeZone,
  saveWebhookConversation,
  saveJsonToFile,
  readJsonFromFile,
  deleteFileIfExists,
  areMobileNumbersFilled,
  getFileExtension,
  executeQueries,
  fetchProfileFun,
  returnWidget,
  generateWhatsAppURL,
  makeRequest,
  replacePlaceholders,
  runChatbot,
  rzCapturePayment,
  validateFacebookToken,
  addObjectToFile,
};

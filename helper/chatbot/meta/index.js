const { query } = require("../../../database/dbpromise");
const { destributeTaskFlow } = require("../../../functions/chatbot");
const { readJsonFromFile } = require("../../../functions/function");
const {
  getReply,
  convertNumberToRandomString,
  sendMetaMsg,
} = require("./function");

function extractBodyText(newMessage) {
  const messageBody =
    newMessage?.msgContext?.text?.body ||
    newMessage?.msgContext?.interactive?.body?.text ||
    newMessage?.msgContext?.image?.caption ||
    newMessage?.msgContext?.image?.link ||
    newMessage?.msgContext?.video?.caption ||
    newMessage?.msgContext?.video?.link ||
    newMessage?.msgContext?.document?.caption ||
    newMessage?.msgContext?.reaction?.emoji ||
    newMessage?.msgContext?.location ||
    newMessage?.msgContext?.contact?.contacts?.[0]?.name?.formatted_name;

  return messageBody;
}

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

async function runChatbot(i, incomingMsg, uid, senderNumber, toName) {
  try {
    const chatbot = i;
    const forAll = i?.for_all > 0 ? true : false;

    if (!forAll) {
      // checking if number is there
      const numberArr = JSON.parse(chatbot?.chats);

      const chatId = convertNumberToRandomString(senderNumber || "");

      const flow = JSON.parse(i?.flow);

      if (numberArr.includes(senderNumber)) {
        const nodePath = `${__dirname}/../../../flow-json/nodes/${uid}/${flow?.flow_id}.json`;
        const edgePath = `${__dirname}/../../../flow-json/edges/${uid}/${flow?.flow_id}.json`;

        const nodes = readJsonFromFile(nodePath);
        const edges = readJsonFromFile(edgePath);

        if (nodes.length > 0 && edges.length > 0) {
          const answer = getReply(nodes, edges, incomingMsg);

          console.log({
            answer: JSON.stringify(answer),
            incomingMsg,
          });

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

      const nodePath = `${__dirname}/../../../flow-json/nodes/${uid}/${flow?.flow_id}.json`;
      const edgePath = `${__dirname}/../../../flow-json/edges/${uid}/${flow?.flow_id}.json`;

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
  } catch (err) {
    console.log(err);
  }
}

async function metaChatbotInit({ latestConversation, uid, origin }) {
  try {
    const { newMessage } = latestConversation;

    const incomingMsg = extractBodyText(newMessage);
    const senderNumber = newMessage?.senderMobile;
    const toName = newMessage?.senderName;

    if (!incomingMsg || !senderNumber || !toName) {
      console.log("returned metaChatbotInit since all required vars not found");
      return;
    }

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
  } catch (err) {
    console.log(err);
  }
}

module.exports = { metaChatbotInit };

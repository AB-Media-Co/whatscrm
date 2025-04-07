const { query } = require("../../../database/dbpromise");
const {
  getCurrentTimestampInTimeZone,
  addObjectToFile,
  makeRequest,
  convertNumberToRandomString,
} = require("../../../functions/function");
const { sendToClientByUid } = require("../../../websocket");
const { processOpenAi } = require("../../addon/ai");
const {
  returnMsgObjAfterAddingKey,
  sendMetaMsg,
} = require("../../ws/function");
const moment = require("moment");

function extractValue(key, sentence, regex = null) {
  try {
    // Convert regex string to RegExp object if regex is provided as a string
    if (typeof regex === "string") {
      const regexParts = regex.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexParts) {
        regex = new RegExp(regexParts[1], regexParts[2]); // Extract pattern and flags
      } else {
        throw new Error("Invalid regex string format.");
      }
    }

    if (regex) {
      // If regex is provided, extract the value
      const match = sentence.match(regex);
      return { [key]: match ? match[0] : "" };
    } else {
      // If no regex is provided, return the entire sentence
      return { [key]: sentence };
    }
  } catch (err) {
    console.error("Error in extractValue:", err);
    return { [key]: "" }; // Return blank value in case of any error
  }
}

function hasDatePassedInTimezone(timezone, date) {
  const momentDate = moment.tz(date, timezone);
  const currentMoment = moment.tz(timezone);
  return momentDate.isBefore(currentMoment);
}

function getConnectedNodes(incomingMessage, edges, nodes) {
  const messageBody =
    incomingMessage.msgContext?.text?.body ||
    incomingMessage.msgContext?.interactive?.body?.text ||
    incomingMessage.msgContext?.image?.caption ||
    incomingMessage.msgContext?.video?.caption ||
    incomingMessage.msgContext?.document?.caption ||
    incomingMessage.msgContext?.reaction?.emoji ||
    incomingMessage.msgContext?.location ||
    incomingMessage.msgContext?.contact?.contacts?.[0]?.name?.formatted_name;

  // console.log("Message Body to Match:", messageBody);

  // Match edges based on the sourceHandle (message body)
  let matchingEdges = edges.filter((edge) => edge.sourceHandle === messageBody);

  // console.log({ matchingEdges });

  if (matchingEdges.length === 0) {
    // Fallback to "{{OTHER_MSG}}" if no specific match is found
    matchingEdges = edges.filter(
      (edge) => edge.sourceHandle === "{{OTHER_MSG}}"
    );
  }

  if (matchingEdges.length === 0) {
    console.warn("No matching edges found");
    return []; // Return an empty array if no matching edges are found
  }

  // Find the target nodes based on the edges' target IDs
  const connectedNodes = matchingEdges
    .map((edge) => {
      const targetNode = nodes.find((node) => node.id === edge.target);
      if (!targetNode) {
        console.warn(`Node not found for edge target ID: ${edge.target}`);
      }
      return targetNode;
    })
    .filter(Boolean); // Filter out any undefined nodes

  // console.log("Connected Nodes:", connectedNodes);
  return { connectedNodes, messageBody }; // Return an array of connected nodes
}

function getConnectedNodesForNode(node, edges, nodes) {
  if (!node || !node.id) {
    console.warn("Invalid node passed to the function.");
    return { connectedNodes: [], matchingEdges: [] };
  }

  // Find edges where the given node is the source
  const matchingEdges = edges.filter((edge) => edge.source === node.id);

  if (matchingEdges.length === 0) {
    console.warn(`No outgoing edges found for node ID: ${node.id}`);
    return { connectedNodes: [], matchingEdges: [] };
  }

  // Find the target nodes based on the edges' target IDs
  const connectedNodes = matchingEdges
    .map((edge) => {
      const targetNode = nodes.find((n) => n.id === edge.target);
      if (!targetNode) {
        console.warn(`Node not found for edge target ID: ${edge.target}`);
      }
      return targetNode;
    })
    .filter(Boolean); // Filter out undefined nodes

  return { connectedNodes };
}

function replacePlaceholdersInMsgContext(msgContext, replacements) {
  try {
    const replacePlaceholders = (obj) => {
      for (const key in obj) {
        if (typeof obj[key] === "string") {
          // Replace placeholders in string values
          obj[key] = obj[key].replace(
            /\{\{\{(.*?)\}\}\}/g,
            (_, placeholderKey) => {
              if (
                placeholderKey.startsWith("JSON.stringify(") &&
                placeholderKey.endsWith(")")
              ) {
                const nestedKey = placeholderKey.slice(15, -1); // Extract key inside JSON.stringify()
                const nestedValue = getValueFromReplacements(
                  replacements,
                  nestedKey.trim()
                );
                return nestedValue ? JSON.stringify(nestedValue) : "";
              }
              // Correctly retrieve the placeholder value from replacements
              return (
                replacements[`{{{${placeholderKey}}}}`] ||
                getValueFromReplacements(replacements, placeholderKey) ||
                ""
              );
            }
          );
        } else if (typeof obj[key] === "object" && obj[key] !== null) {
          // Recursively process nested objects
          replacePlaceholders(obj[key]);
        }
      }
    };

    // Helper function to retrieve nested values
    const getValueFromReplacements = (replacements, key) => {
      // Support nested keys using dot notation (e.g., "data.data.avatar")
      return key
        .split(".")
        .reduce(
          (acc, part) => (acc && acc[part] !== undefined ? acc[part] : ""),
          replacements
        );
    };

    // Clone the msgContext object to avoid mutating the original
    const clonedMsgContext = JSON.parse(JSON.stringify(msgContext));
    replacePlaceholders(clonedMsgContext);
    return clonedMsgContext;
  } catch (error) {
    console.error("Error in replacePlaceholdersInMsgContext:", error);
    return msgContext; // Return the original object in case of error
  }
}

function checkIfKeyHasValue(obj) {
  try {
    return obj[Object.keys(obj)[0]] ? true : false;
  } catch (error) {
    return false;
  }
}

async function getVariablesObj({ uniqueId, mysqlFlowData, sentence }) {
  try {
    // const [mysqlFlowData] = await query(
    //   `SELECT * FROM flow_data WHERE uniqueId = ?`,
    //   [uniqueId]
    // );

    // console.log({ other: mysqlFlowData?.other, mysqlFlowData });

    let variables = mysqlFlowData?.inputs
      ? JSON.parse(mysqlFlowData?.inputs)
      : {};
    if (mysqlFlowData?.other === "take_input") {
      const inputNodeData = JSON.parse(mysqlFlowData?.last_node);
      const keyValue = inputNodeData?.data?.variableName;
      const regxData = inputNodeData?.data?.useRegEx
        ? inputNodeData?.data?.regex
        : null;

      // Use the extractValue function to extract the value
      const newVarible = extractValue(keyValue, sentence, regxData);

      // console.log({ newVariblee: newVarible });

      variables = checkIfKeyHasValue(newVarible)
        ? { ...variables, ...newVarible }
        : variables;

      // console.log({ variables: variables });

      await query(
        `UPDATE flow_data SET other = ?, inputs = ? WHERE uniqueId = ?`,
        [null, JSON.stringify(variables), uniqueId]
      );
    }

    return variables;
  } catch (err) {
    console.log(`Error found in getVariablesObj chatbot.js`, err);
  }
}

async function sendMessageMeta({
  userData,
  msgContent,
  nodeType,
  incomingMessage,
  uid,
  chatId,
  mysqlFlowData,
}) {
  try {
    const { disabled } = mysqlFlowData;

    if (disabled) {
      if (!hasDatePassedInTimezone(disabled)) {
        console.log(
          `Chat is disabled for mobile:`,
          incomingMessage?.senderMobile
        );
        return;
      }
    }

    const timeZone = userData?.timezone || "Asia/Kolkata";
    const userTimezone = getCurrentTimestampInTimeZone(timeZone);
    const { senderMobile, senderName } = incomingMessage;

    const msgObj = returnMsgObjAfterAddingKey({
      msgContext: msgContent,
      type: nodeType,
      timestamp: userTimezone || "NA",
      senderName: senderName || "NA",
      senderMobile: senderMobile || "NA",
    });

    // Send the message only once
    const sendMsg = await sendMetaMsg({
      msgObj: msgContent,
      to: senderMobile,
      uid,
    });

    if (!sendMsg?.success || !sendMsg?.id) {
      return console.log(`Unable to send chatbot reply`, sendMsg);
    }

    const msgObjNew = { ...msgObj, metaChatId: sendMsg?.id };

    const chatPath = `${__dirname}/../../../conversations/inbox/${uid}/${chatId}.json`;

    // Add the updated message object to the respective chat file
    addObjectToFile(msgObjNew, chatPath);

    sendToClientByUid(uid, {
      action: "update_chat",
      payload: { chatId, newMessage: msgObjNew },
    });
  } catch (err) {
    console.log(`Error found in sendMessageMeta chatbot.js`, err);
  }
}

async function processTakeInput({
  userData,
  msgContent,
  nodeType,
  chatId,
  incomingMessage,
  uid,
  mysqlFlowData,
  connectedNode,
  uniqueId,
  nodes,
  edges,
  variables,
}) {
  try {
    await query(
      `UPDATE flow_data SET other = ?, last_node = ? WHERE uniqueId = ?`,
      ["take_input", JSON.stringify(connectedNode), uniqueId]
    );
    await sendMessageMeta({
      userData,
      msgContent: connectedNode?.data?.msgContent,
      nodeType: "text",
      chatId,
      incomingMessage,
      uid,
      mysqlFlowData,
      connectedNode,
      uniqueId,
      nodes,
      edges,
    });
  } catch (err) {
    console.log(`Error found in processTakeInput chatbot.js`, err);
  }
}

async function processMakeRequest({
  userData,
  msgContent,
  nodeType,
  chatId,
  incomingMessage,
  uid,
  mysqlFlowData,
  connectedNode,
  uniqueId,
  nodes,
  edges,
  variables,
}) {
  try {
    const response = await makeRequest({
      method: msgContent?.type,
      url: msgContent?.url,
      body: msgContent?.body,
      headers: msgContent?.headers,
    });

    const objData = typeof response === "object" ? response : {};
    const allVariables = { ...variables, ...objData };

    console.log({ allVariables: allVariables });

    // adding new variables to the flow_data table
    await query(`UPDATE flow_data SET inputs = ? WHERE uniqueId = ?`, [
      JSON.stringify(allVariables),
      uniqueId,
    ]);

    await forwardToNextNode({
      userData,
      msgContent,
      nodeType,
      chatId,
      incomingMessage,
      uid,
      mysqlFlowData,
      connectedNode,
      uniqueId,
      nodes,
      edges,
      variables,
    });
  } catch (error) {
    console.log(`Error found in processMakeRequest chatbot.js`, error);
  }
}

async function processAssignAgent({
  userData,
  msgContent,
  nodeType,
  chatId,
  incomingMessage,
  uid,
  mysqlFlowData,
  connectedNode,
  uniqueId,
  nodes,
  edges,
  variables,
}) {
  try {
    // checking if the chat was already assigned
    const checkIfAlreadyChatAsssigned = await query(
      `SELECT * FROM agent_chats WHERE owner_uid = ? AND uid = ? AND chat_id = ?`,
      [uid, msgContent?.agentObj?.uid, chatId]
    );
    if (checkIfAlreadyChatAsssigned?.length < 1) {
      await query(
        `INSERT INTO agent_chats (owner_uid, uid, chat_id) VALUES (?,?,?)`,
        [uid, msgContent?.agentObj?.uid, chatId]
      );
    }

    await forwardToNextNode({
      userData,
      msgContent,
      nodeType,
      chatId,
      incomingMessage,
      uid,
      mysqlFlowData,
      connectedNode,
      uniqueId,
      nodes,
      edges,
      variables,
    });
  } catch (error) {
    console.log(`Error found in processMakeRequest chatbot.js`, error);
  }
}

async function processDisableChat({
  userData,
  msgContent,
  nodeType,
  chatId,
  incomingMessage,
  uid,
  mysqlFlowData,
  connectedNode,
  uniqueId,
  nodes,
  edges,
  variables,
}) {
  try {
    if (msgContent?.timezone) {
      const newObj = {
        timestamp: msgContent?.timestamp,
        timezone: msgContent?.timezone,
        senderName: incomingMessage?.senderName,
        senderMobile: incomingMessage?.senderMobile,
      };

      await query(`UPDATE flow_data SET disabled = ? WHERE uniqueId = ?`, [
        JSON.stringify(newObj),
        uniqueId,
      ]);
    }

    await forwardToNextNode({
      userData,
      msgContent,
      nodeType,
      chatId,
      incomingMessage,
      uid,
      mysqlFlowData,
      connectedNode,
      uniqueId,
      nodes,
      edges,
      variables,
    });
  } catch (error) {
    console.log(`Error found in processMakeRequest chatbot.js`, error);
  }
}

async function processCondition({
  userData,
  msgContent,
  nodeType,
  chatId,
  incomingMessage,
  uid,
  mysqlFlowData,
  connectedNode,
  uniqueId,
  nodes,
  edges,
  variables,
}) {
  try {
    const eqCode = "eq9083648421";
    const notEqCode = "neq9083648421";

    const getConnectedNodes = getConnectedNodesForNode(
      connectedNode,
      edges,
      nodes
    );

    const forEqual = getConnectedNodes?.connectedNodes[0];
    const forNotEqual = getConnectedNodes?.connectedNodes[1];

    const sentence =
      incomingMessage.msgContext?.text?.body ||
      incomingMessage.msgContext?.interactive?.body?.text ||
      incomingMessage.msgContext?.image?.caption ||
      incomingMessage.msgContext?.video?.caption ||
      incomingMessage.msgContext?.document?.caption ||
      incomingMessage.msgContext?.reaction?.emoji ||
      incomingMessage.msgContext?.location ||
      incomingMessage.msgContext?.contact?.contacts?.[0]?.name?.formatted_name;

    if (sentence?.includes(msgContent?.value)) {
      await forwardToNextNode({
        userData,
        msgContent: forEqual?.data?.msgContent,
        nodeType: forEqual?.nodeType,
        chatId,
        incomingMessage: {
          ...incomingMessage,
          msgContext: { text: { body: eqCode } },
        },
        uid,
        mysqlFlowData,
        connectedNode: forEqual,
        uniqueId,
        nodes,
        edges,
        variables,
        conditionCode: [forEqual],
      });
      console.log("Value matched");
    } else {
      await forwardToNextNode({
        userData,
        msgContent: forNotEqual?.data?.msgContent,
        nodeType: forNotEqual?.nodeType,
        chatId,
        incomingMessage: {
          ...incomingMessage,
          msgContext: { text: { body: notEqCode } },
        },
        uid,
        mysqlFlowData,
        connectedNode: forNotEqual,
        uniqueId,
        nodes,
        edges,
        variables,
        conditionCode: [forNotEqual],
      });
      console.log("Value not matched");
    }

    // // Use the extractValue function to extract the value
    // const newVarible = extractValue(keyValue, sentence, regxData);

    // // const { [eqCode]: eqValue, [notEqCode]: notEqValue } = extractValue(
    // //   "eq9083648421",
    // //   sentence,
    // //   connectedNode?.data?.useRegEx ? connectedNode?.data?.regex : null
    // // );

    // // const condition = connectedNode?.data?.condition;

    // console.dir(
    //   {
    //     // getConnectedNodes,
    //     connectedNode,
    //     newVarible,
    //   },
    //   { depth: null }
    // );
  } catch (error) {
    console.log(`Error found in processCondition chatbot.js`, error);
  }
}

async function processFlow({
  connectedNode,
  incomingMessage,
  userData,
  chatId,
  uid,
  uniqueId,
  nodes,
  edges,
  sentence,
  mysqlFlowData,
}) {
  const { disabled } = mysqlFlowData;

  console.log("Process flow ran");

  if (disabled) {
    const timeSt = JSON.parse(disabled)?.timestamp;
    if (!hasDatePassedInTimezone(timeSt)) {
      console.log(
        `Chat is disabled for mobile:`,
        incomingMessage?.senderMobile
      );
      return;
    }
  }

  const { nodeType } = connectedNode;
  const msgContent = connectedNode?.data?.msgContent;

  const [result] = await query(`SELECT * FROM flow_data WHERE id = ?`, [
    mysqlFlowData.id,
  ]);

  console.log({ nodeType });

  mysqlFlowData = result || mysqlFlowData;

  const variables = await getVariablesObj({
    uniqueId,
    mysqlFlowData,
    sentence,
  });

  console.log({ variabless: variables });

  switch (nodeType) {
    case "TEXT":
    case "IMAGE":
    case "AUDIO":
    case "VIDEO":
    case "DOCUMENT":
    case "BUTTON":
    case "LIST":
      await sendMessageMeta({
        userData,
        msgContent: replacePlaceholdersInMsgContext(msgContent, variables),
        nodeType: nodeType?.toLowerCase(),
        chatId,
        incomingMessage,
        uid,
        mysqlFlowData,
        connectedNode,
        uniqueId,
        nodes,
        edges,
        variables,
      });
      break;

    case "TAKE_INPUT":
      await processTakeInput({
        userData,
        msgContent: replacePlaceholdersInMsgContext(msgContent, variables),
        nodeType: nodeType?.toLowerCase(),
        chatId,
        incomingMessage,
        uid,
        mysqlFlowData,
        connectedNode,
        uniqueId,
        nodes,
        edges,
        variables,
      });
      break;

    case "MAKE_REQUEST":
      await processMakeRequest({
        userData,
        msgContent: replacePlaceholdersInMsgContext(msgContent, variables),
        nodeType: nodeType?.toLowerCase(),
        chatId,
        incomingMessage,
        uid,
        mysqlFlowData,
        connectedNode,
        uniqueId,
        nodes,
        edges,
        variables,
      });
      break;

    case "ASSIGN_AGENT":
      await processAssignAgent({
        userData,
        msgContent: replacePlaceholdersInMsgContext(msgContent, variables),
        nodeType: nodeType?.toLowerCase(),
        chatId,
        incomingMessage,
        uid,
        mysqlFlowData,
        connectedNode,
        uniqueId,
        nodes,
        edges,
        variables,
      });
      break;

    case "DISABLE_CHAT":
      await processDisableChat({
        userData,
        msgContent: replacePlaceholdersInMsgContext(msgContent, variables),
        nodeType: nodeType?.toLowerCase(),
        chatId,
        incomingMessage,
        uid,
        mysqlFlowData,
        connectedNode,
        uniqueId,
        nodes,
        edges,
        variables,
      });
      break;

    case "CONDITION":
      await processCondition({
        userData,
        msgContent: replacePlaceholdersInMsgContext(msgContent, variables),
        nodeType: nodeType?.toLowerCase(),
        chatId,
        incomingMessage,
        uid,
        mysqlFlowData,
        connectedNode,
        uniqueId,
        nodes,
        edges,
        variables,
      });
      break;

    case "AI_BOT":
      await processOpenAi({
        userData,
        msgContent: replacePlaceholdersInMsgContext(msgContent, variables),
        nodeType: nodeType?.toLowerCase(),
        chatId,
        incomingMessage,
        uid,
        mysqlFlowData,
        connectedNode,
        uniqueId,
        nodes,
        edges,
        variables,
        sendMessageMeta,
        forwardToNextNode,
        processFlow,
      });
      break;

    default:
      break;
  }
}

async function forwardToNextNode({
  userData,
  msgContent,
  nodeType,
  chatId,
  incomingMessage,
  uid,
  mysqlFlowData,
  connectedNode,
  uniqueId,
  nodes,
  edges,
  variables,
  conditionCode = null,
}) {
  try {
    const getConnectedNodes = getConnectedNodesForNode(
      connectedNode,
      edges,
      nodes
    );

    const newNode = conditionCode || getConnectedNodes?.connectedNodes;

    if (newNode.length > 0) {
      const sentence =
        incomingMessage.msgContext?.text?.body ||
        incomingMessage.msgContext?.interactive?.body?.text ||
        incomingMessage.msgContext?.image?.caption ||
        incomingMessage.msgContext?.video?.caption ||
        incomingMessage.msgContext?.document?.caption ||
        incomingMessage.msgContext?.reaction?.emoji ||
        incomingMessage.msgContext?.location ||
        incomingMessage.msgContext?.contact?.contacts?.[0]?.name
          ?.formatted_name;

      // sending function back to processFlow
      await processFlow({
        connectedNode: newNode[0],
        incomingMessage,
        userData,
        chatId,
        uid,
        uniqueId,
        nodes,
        edges,
        sentence,
        mysqlFlowData,
      });
    } else {
      console.log("No newNode found");
    }
  } catch (error) {
    console.log(`Error found in forwardToNextNode chatbot.js`, error);
  }
}

async function metaChatBotInit({
  nodes,
  edges,
  incomingMessage,
  chatId,
  uid,
  uniqueId,
  userDataMysql,
}) {
  const userData = userDataMysql;

  let [mysqlFlowData] = await query(
    `SELECT * FROM flow_data WHERE uniqueId = ?`,
    [uniqueId]
  );

  if (!mysqlFlowData) {
    await query(
      `INSERT INTO flow_data (chatId, uid, uniqueId) VALUES (?,?,?)`,
      [chatId, uid, uniqueId]
    );
    mysqlFlowData = {};
  }

  let connectedNodes;
  let messageBody;

  // Get messageBody from getConnectedNodes
  ({ messageBody } = getConnectedNodes(incomingMessage, edges, nodes));

  if (mysqlFlowData?.other === "take_input") {
    // Assign connectedNodes from getConnectedNodesForNode
    const lastNode = JSON.parse(mysqlFlowData?.last_node);
    ({ connectedNodes } = getConnectedNodesForNode(lastNode, edges, nodes));

    // await query(`UPDATE flow_data SET other = ? WHERE uniqueId = ?`, [
    //   null,
    //   uniqueId,
    // ]);
  } else if (mysqlFlowData?.ai_data) {
    console.log("Chat was transferred to AI agent");

    const parsedAIData = JSON.parse(mysqlFlowData?.ai_data);
    connectedNodes = parsedAIData ? [parsedAIData] : [];
  } else {
    // Assign connectedNodes from getConnectedNodes
    ({ connectedNodes } = getConnectedNodes(incomingMessage, edges, nodes));
  }

  const connectedNode = connectedNodes?.length > 0 ? connectedNodes[0] : null;

  if (userData && connectedNode) {
    await processFlow({
      connectedNode,
      incomingMessage,
      userData,
      chatId,
      uid,
      uniqueId,
      nodes,
      edges,
      sentence: messageBody,
      mysqlFlowData,
    });

    await query(`UPDATE flow_data SET last_node = ? WHERE uniqueId = ?`, [
      JSON.stringify(connectedNode),
      uniqueId,
    ]);
  }
}

module.exports = metaChatBotInit;

const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const {
  isValidEmail,
  getFileExtension,
  writeJsonToFile,
  deleteFileIfExists,
  readJsonFromFile,
} = require("../functions/function.js");
const { sign } = require("jsonwebtoken");
const validateUser = require("../middlewares/user.js");
const { checkPlan } = require("../middlewares/plan.js");

router.post("/add_new", validateUser, checkPlan, async (req, res) => {
  try {
    const { title, nodes, edges, flowId } = req.body;
    if (!title) {
      return req.json({
        success: false,
        msg: "Please give a title to the flow",
      });
    }

    if (!nodes || !edges || !flowId) {
      return res.json({ success: false, msg: "Nodes and Edges are required" });
    }

    // checking existing
    const checkExisted = await query(`SELECT * FROM flow WHERE flow_id = ?`, [
      flowId,
    ]);

    const nodepath = `${__dirname}/../flow-json/nodes/${req.decode.uid}/${flowId}.json`;
    const edgepath = `${__dirname}/../flow-json/edges/${req.decode.uid}/${flowId}.json`;

    await writeJsonToFile(nodepath, nodes);
    await writeJsonToFile(edgepath, edges);

    if (checkExisted.length > 0) {
      await query(`UPDATE flow SEt title = ? WHERE flow_id = ?`, [
        title,
        flowId,
      ]);
    } else {
      await query(`INSERT INTO flow (uid, flow_id, title) VALUES (?,?,?)`, [
        req.decode.uid,
        flowId,
        title,
      ]);
    }

    res.json({ success: true, msg: "Flow was saved" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// get my flows
router.get("/get_mine", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM flow WHERE uid = ?`, [
      req.decode.uid,
    ]);
    res.json({ data, success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// del a flow
router.post("/del_flow", validateUser, async (req, res) => {
  try {
    const { id, flowId } = req.body;

    await query(`DELETE FROM flow WHERE uid = ? AND id = ?`, [
      req.decode.uid,
      id,
    ]);

    const nodePath = `${__dirname}/../flow-json/nodes/${req.decode.uid}/${flowId}.json`;
    const edgePath = `${__dirname}/../flow-json/edges/${req.decode.uid}/${flowId}.json`;

    deleteFileIfExists(nodePath);
    deleteFileIfExists(edgePath);

    res.json({ success: true, msg: "Flow was deleted" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// get flow using flow id
router.post("/get_by_flow_id", validateUser, async (req, res) => {
  try {
    const { flowId } = req.body;

    if (!flowId) {
      return res.json({ success: false, msg: "Flow id missing" });
    }

    const nodePath = `${__dirname}/../flow-json/nodes/${req.decode.uid}/${flowId}.json`;
    const edgePath = `${__dirname}/../flow-json/edges/${req.decode.uid}/${flowId}.json`;

    const nodes = readJsonFromFile(nodePath);
    const edges = readJsonFromFile(edgePath);

    res.json({ nodes, edges, success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});
// get chats activity
router.post("/get_activity", validateUser, checkPlan, async (req, res) => {
  try {
    const { flowId } = req.body;

    const getFlow = await query(
      `SELECT * FROM flow WHERE uid = ? AND flow_id = ?`,
      [req.decode.uid, flowId]
    );

    // Parse prevent and ai lists from the database
    const prevent = getFlow[0]?.prevent_list
      ? JSON.parse(getFlow[0]?.prevent_list)
      : [];
    const ai = getFlow[0]?.ai_list ? JSON.parse(getFlow[0]?.ai_list) : [];

    // Assign unique IDs to each item in the prevent and ai lists
    const preventWithIds = prevent.map((item, index) => ({
      ...item,
      id: `prevent-${index}`, // Assign a unique ID using the index
    }));
    const aiWithIds = ai.map((item, index) => ({
      ...item,
      id: `ai-${index}`, // Assign a unique ID using the index
    }));

    // Log the data with unique IDs
    console.log({
      prevent: preventWithIds,
      ai: aiWithIds,
    });

    // Send the response with lists that have unique IDs
    res.json({ success: true, prevent: preventWithIds, ai: aiWithIds });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// remove number from flow activiy
router.post("/remove_number_from_activity", validateUser, async (req, res) => {
  try {
    const { type, number, flowId } = req.body;

    const [flow] = await query(`SELECT * FROM flow WHERE flow_id = ?`, [
      flowId,
    ]);

    if (type == "AI") {
      // removing from ai arr
      const aiArr = flow?.ai_list ? JSON.parse(flow?.ai_list) : [];
      const updatedArr = aiArr?.filter((x) => x.senderNumber !== number);

      await query(`UPDATE flow SET ai_list = ? WHERE flow_id = ?`, [
        JSON.stringify(updatedArr),
        flowId,
      ]);
    } else if (type == "DISABLED") {
      // removing from prevent arr
      const preventArr = flow?.prevent_list
        ? JSON.parse(flow?.prevent_list)
        : [];
      const updatedPreventArr = preventArr?.filter(
        (x) => x.senderNumber !== number
      );

      await query(`UPDATE flow SET prevent_list = ? WHERE flow_id = ?`, [
        JSON.stringify(updatedPreventArr),
        flowId,
      ]);
    }

    res.json({ msg: "Number was removed", success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

module.exports = router;

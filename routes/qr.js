const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const {
  createSession,
  sendMessage,
  getSession,
  deleteSession,
} = require("../helper/addon/qr/index.js");
const { checkPlan } = require("../middlewares/plan.js");
const validateUser = require("../middlewares/user.js");

router.get("/create", async (req, res) => {
  try {
    const { id } = req.query;
    // Kick off session creation (which returns immediately)
    await createSession(id || "ID");
    res.json({
      success: true,
      msg: "Session generated",
    });
  } catch (err) {
    console.error(err);
    res.json({
      success: false,
      msg: "Something went wrong",
      err: err.message,
    });
  }
});

router.get("/send", async (req, res) => {
  try {
    const number = req.query;
    const session = await getSession("chullii");
    console.log(session);

    if (session) {
      const esn = await session.sendMessage("918430088300@s.whatsapp.net", {
        text: "Hello",
      });
      console.log({ esn });
    } else {
      console.log("Session not found");
    }

    res.json("DONE");
  } catch (err) {
    console.error(err);
    res.json({
      success: false,
      msg: "Something went wrong",
      err: err.message,
    });
  }
});

router.post("/gen_qr", validateUser, checkPlan, async (req, res) => {
  try {
    const { title, uniqueId } = req.body;
    if (!title || !uniqueId) {
      return res.json({
        success: false,
        msg: "Please provide the all fields! title is required",
      });
    }

    await query(
      `INSERT INTO instance (uid, title, uniqueId, status) VALUES (?,?,?,?)`,
      [req.decode.uid, title, uniqueId, "GENERATING"]
    );

    await createSession(
      uniqueId,
      title?.length > 20 ? title.slice(0, 20) : title
    );

    res.json({
      success: true,
      msg: "Qr code is generating",
    });
  } catch (err) {
    console.error(err);
    res.json({
      success: false,
      msg: "Something went wrong",
      err: err.message,
    });
  }
});

// get all instances
router.get("/get_all", validateUser, async (req, res) => {
  try {
    const instances = await query(`SELECT * FROM instance WHERE uid = ?`, [
      req.decode.uid,
    ]);

    if (!instances.length) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Process each instance
    for (let instance of instances) {
      const check = getSession(instance.uniqueId);

      if (!check) {
        // If no session, update status to "INACTIVE"
        await query(`UPDATE instance SET status = ? WHERE uniqueId = ?`, [
          "INACTIVE",
          instance.uniqueId,
        ]);
        instance.status = "INACTIVE"; // Update status in response as well
      }
    }

    res.json({
      success: true,
      data: instances,
    });
  } catch (err) {
    console.error(err);
    res.json({
      success: false,
      msg: "Something went wrong",
      err: err.message,
    });
  }
});

// del an instance
router.post("/del_instance", validateUser, async (req, res) => {
  try {
    const { uniqueId } = req.body;
    if (!uniqueId) {
      return res.json({
        success: false,
        msg: "Please provide the all fields! uniqueId is required",
      });
    }

    const session = getSession(uniqueId);

    if (session) {
      try {
        await session.logout();
      } catch {
      } finally {
        deleteSession(uniqueId);
      }
    }

    await query(`DELETE FROM instance WHERE uniqueId = ? AND uid = ?`, [
      uniqueId,
      req.decode.uid,
    ]);
  } catch (err) {
    console.error(err);
    res.json({
      success: false,
      msg: "Something went wrong",
      err: err.message,
    });
  }
});

// change instance status
router.post("/change_instance_status", validateUser, async (req, res) => {
  try {
    const statuses = [
      "unavailable",
      "available",
      // "composing",
      // "recording",
      // "paused",
    ];

    const { insId, status, jid } = req.body;

    const session = await getSession(insId);

    if (!session) {
      return res.json({
        msg: "Unable to change status right now WA is busy",
      });
    }

    if (!statuses.includes(status)) {
      return res.json({
        msg: "Invalid status found",
      });
    }

    const finalUpdate = { onlineStatus: status };

    await session.sendPresenceUpdate(status);
    await query(`UPDATE instance SET other = ? WHERE uniqueId = ?`, [
      JSON.stringify(finalUpdate),
      insId,
    ]);

    res.json({
      success: true,
      msg: "Online status update request sent",
    });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

module.exports = router;

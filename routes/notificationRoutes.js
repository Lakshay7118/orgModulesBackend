const express = require("express");

const router = express.Router();

const Notification = require("../models/Notification");

const protect = require("../middleware/authMiddleware");

const notificationScope = (req, extra = {}) => {
  const base = { userId: req.user.id, ...extra };
  if (req.user.role === "super_to_super_admin") return base;
  if (!req.user.organization) return { ...base, organization: null };
  return {
    ...base,
    $or: [
      { organization: req.user.organization },
      { organization: null },
    ],
  };
};

// GET ALL
router.get("/", protect, async (req, res) => {

  try {

    const notifications =
      await Notification.find(notificationScope(req)).sort({
        createdAt: -1,
      });

    res.json({
      success: true,
      data: notifications,
    });

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });

  }

});


// READ SINGLE
router.patch("/:id/read", protect, async (req, res) => {

  try {

    const notif = await Notification.findOne(notificationScope(req, { _id: req.params.id }));

    if (!notif) {

      return res.status(404).json({
        error: "Notification not found",
      });

    }

    notif.read = true;

    await notif.save();

    res.json({
      success: true,
    });

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });

  }

});


// READ ALL
router.patch("/read-all/all", protect, async (req, res) => {

  try {

    await Notification.updateMany(
      notificationScope(req, { read: false }),
      {
        $set: {
          read: true,
        },
      }
    );

    res.json({
      success: true,
    });

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });

  }

});

module.exports = router;

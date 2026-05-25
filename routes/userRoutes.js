const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");
const User = require("../models/Users");
const Contact = require("../models/Contact");
const Notification = require("../models/Notification");
const ProfileChangeRequest = require("../models/ProfileChangeRequest");
const SupportTicket = require("../models/SupportTicket");
const generateToken = require("../utils/generateToken");
const { getIO } = require("../sockets/socket");

const PUBLIC_USER_FIELDS = "name phone email role isActive createdAt updatedAt";

const emitNotification = (phone, notification) => {
  try {
    getIO().to(phone).emit("newNotification", notification);
  } catch {}
};

const notifyAdmins = async (payload) => {
  const admins = await User.find({ role: "super_admin" }).select("_id phone").lean();
  const notifications = await Promise.all(
    admins.map((admin) =>
      Notification.create({
        userId: admin._id,
        ...payload,
      }).then((notification) => {
        if (admin.phone) emitNotification(admin.phone, notification);
        return notification;
      })
    )
  );
  return notifications;
};

const notifySupportStaff = async (payload) => {
  const staff = await User.find({ role: { $in: ["super_admin", "manager"] } }).select("_id phone").lean();
  const notifications = await Promise.all(
    staff.map((member) =>
      Notification.create({
        userId: member._id,
        ...payload,
      }).then((notification) => {
        if (member.phone) emitNotification(member.phone, notification);
        return notification;
      })
    )
  );
  return notifications;
};

const buildProfileChanges = (currentUser, body) => {
  const allowedFields = ["name", "email", "phone"];
  return allowedFields
    .filter((field) => Object.prototype.hasOwnProperty.call(body, field))
    .map((field) => ({
      field,
      from: currentUser[field] || "",
      to: typeof body[field] === "string" ? body[field].trim() : body[field],
    }))
    .filter((change) => String(change.from || "") !== String(change.to || ""));
};


// =======================
// ✅ LOGIN BY EMAIL + PASSWORD
// =======================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!password) return res.status(400).json({ error: "Password is required" });

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    if (user.isActive === false) {
      return res.status(403).json({ error: "Your account is inactive. Please contact admin." });
    }

    // Check password
    if (!user.password) {
      return res.status(401).json({ error: "No password set. Contact admin." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isActive: user.isActive !== false,
      },
    });

  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ error: err.message });
  }
});


// =======================
// ✅ GET ALL USERS (for assignment dropdown)
// =======================
router.get("/", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const users = await User.find().select("name phone email role isActive").lean();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ CURRENT USER PROFILE
// =======================
router.get("/me", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(PUBLIC_USER_FIELDS).lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ UPDATE PROFILE
// super_admin updates immediately.
// manager/user creates an approval request for admin.
// =======================
router.patch("/me", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const changes = buildProfileChanges(user, req.body);
    if (changes.length === 0) {
      return res.json({ success: true, status: "unchanged", data: user });
    }

    const duplicateEmail = changes.find((c) => c.field === "email" && c.to);
    if (duplicateEmail) {
      const existing = await User.findOne({
        email: String(duplicateEmail.to).toLowerCase(),
        _id: { $ne: user._id },
      });
      if (existing) return res.status(400).json({ error: "Email already in use" });
    }

    const duplicatePhone = changes.find((c) => c.field === "phone" && c.to);
    if (duplicatePhone) {
      const existing = await User.findOne({
        phone: duplicatePhone.to,
        _id: { $ne: user._id },
      });
      if (existing) return res.status(400).json({ error: "Phone already in use" });
    }

    if (user.role === "super_admin") {
      changes.forEach((change) => {
        user[change.field] = change.field === "email" && change.to
          ? String(change.to).toLowerCase()
          : change.to;
      });
      await user.save();
      const safeUser = await User.findById(user._id).select(PUBLIC_USER_FIELDS).lean();
      return res.json({ success: true, status: "approved", data: safeUser });
    }

    const request = await ProfileChangeRequest.create({
      requester: user._id,
      requesterRole: user.role,
      changes,
    });

    await notifyAdmins({
      type: "profile_approval_requested",
      message: `${user.name || user.phone || "A user"} requested profile changes`,
    });

    res.status(202).json({ success: true, status: "pending", data: request });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ CHANGE PASSWORD
// Password changes are direct and require current password.
// New passwords are never sent through the admin approval queue.
// =======================
router.patch("/me/password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required" });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password) return res.status(400).json({ error: "No password is set for this account" });

    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) return res.status(400).json({ error: "Current password is incorrect" });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ success: true, message: "Password updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ PROFILE CHANGE REQUESTS
// =======================
router.get("/profile-change-requests", protect, async (req, res) => {
  try {
    const query = req.user.role === "super_admin"
      ? {}
      : { requester: req.user.id };

    const requests = await ProfileChangeRequest.find(query)
      .populate("requester", "name phone email role")
      .populate("reviewedBy", "name phone email role")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: requests });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch(
  "/profile-change-requests/:id",
  protect,
  allowRoles("super_admin"),
  async (req, res) => {
    try {
      const { status, note } = req.body;
      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Status must be approved or rejected" });
      }

      const request = await ProfileChangeRequest.findById(req.params.id).populate("requester");
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already reviewed" });
      }

      if (status === "approved") {
        request.changes.forEach((change) => {
          request.requester[change.field] = change.field === "email" && change.to
            ? String(change.to).toLowerCase()
            : change.to;
        });
        await request.requester.save();
      }

      request.status = status;
      request.note = note || "";
      request.reviewedBy = req.user.id;
      request.reviewedAt = new Date();
      await request.save();

      const notification = await Notification.create({
        userId: request.requester._id,
        type: status === "approved" ? "profile_approved" : "profile_rejected",
        message: `Your profile change request was ${status}`,
      });
      if (request.requester.phone) emitNotification(request.requester.phone, notification);

      const data = await ProfileChangeRequest.findById(request._id)
        .populate("requester", "name phone email role")
        .populate("reviewedBy", "name phone email role")
        .lean();

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// =======================
// ✅ SUPPORT TICKETS
// =======================
router.post("/support-tickets", protect, async (req, res) => {
  try {
    const { category, subject, message, priority } = req.body;
    if (!category || !subject || !message) {
      return res.status(400).json({ error: "Category, subject and message are required" });
    }

    const activeTicket = await SupportTicket.findOne({
      user: req.user.id,
      status: { $ne: "ended" },
    })
      .populate("user", "name phone email role")
      .populate("replies.sender", "name phone email role")
      .populate("endedBy", "name phone email role")
      .lean();

    if (activeTicket) {
      return res.status(409).json({
        error: "You already have an active support ticket. Reply in the current chat.",
        activeTicket,
      });
    }

    const ticket = await SupportTicket.create({
      user: req.user.id,
      category,
      subject,
      message,
      priority: priority || "medium",
    });

    const requester = await User.findById(req.user.id).select("name phone").lean();
    await notifySupportStaff({
      type: "support_ticket_created",
      message: `${requester?.name || requester?.phone || "A user"} raised a support ticket: ${subject}`,
    });

    res.status(201).json({ success: true, data: ticket });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/support-tickets", protect, async (req, res) => {
  try {
    const canViewAll = ["super_admin", "manager"].includes(req.user.role);
    const query = canViewAll ? {} : { user: req.user.id, status: { $ne: "ended" } };
    const tickets = await SupportTicket.find(query)
      .populate("user", "name phone email role")
      .populate("replies.sender", "name phone email role")
      .populate("endedBy", "name phone email role")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: tickets });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post(
  "/support-tickets/:id/replies",
  protect,
  allowRoles("super_admin", "manager"),
  async (req, res) => {
    try {
      const { message, status } = req.body;
      if (!message) return res.status(400).json({ error: "Reply message is required" });

      const ticket = await SupportTicket.findById(req.params.id).populate("user", "name phone email role");
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      if (ticket.status === "ended") {
        return res.status(400).json({ error: "This chat has ended" });
      }

      ticket.replies.push({
        message,
        sender: req.user.id,
        senderRole: req.user.role,
      });

      if (status && ["open", "in_progress", "resolved", "ended"].includes(status)) {
        ticket.status = status;
        if (status === "ended") {
          ticket.endedAt = new Date();
          ticket.endedBy = req.user.id;
        }
      } else if (ticket.status === "open") {
        ticket.status = "in_progress";
      }

      await ticket.save();

      const notification = await Notification.create({
        userId: ticket.user._id,
        type: "support_ticket_replied",
        message: `Support replied to your ticket: ${ticket.subject}`,
      });
      if (ticket.user.phone) emitNotification(ticket.user.phone, notification);

      const data = await SupportTicket.findById(ticket._id)
        .populate("user", "name phone email role")
        .populate("replies.sender", "name phone email role")
        .populate("endedBy", "name phone email role")
        .lean();

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.post("/support-tickets/:id/user-replies", protect, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Reply message is required" });

    const ticket = await SupportTicket.findById(req.params.id).populate("user", "name phone email role");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (ticket.user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: "Not authorized for this ticket" });
    }
    if (ticket.status === "ended") {
      return res.status(400).json({ error: "This chat has ended. Please create a new ticket." });
    }

    ticket.replies.push({
      message,
      sender: req.user.id,
      senderRole: req.user.role,
    });

    if (ticket.status === "open") ticket.status = "in_progress";
    await ticket.save();

    const requester = await User.findById(req.user.id).select("name phone").lean();
    await notifySupportStaff({
      type: "support_ticket_created",
      message: `${requester?.name || requester?.phone || "A user"} replied to support ticket: ${ticket.subject}`,
    });

    const data = await SupportTicket.findById(ticket._id)
      .populate("user", "name phone email role")
      .populate("replies.sender", "name phone email role")
      .populate("endedBy", "name phone email role")
      .lean();

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post(
  "/support-tickets/:id/reset-password",
  protect,
  allowRoles("super_admin", "manager"),
  async (req, res) => {
    try {
      const { temporaryPassword, reply } = req.body;
      if (!temporaryPassword || String(temporaryPassword).length < 6) {
        return res.status(400).json({ error: "Temporary password must be at least 6 characters" });
      }

      const ticket = await SupportTicket.findById(req.params.id).populate("user", "name phone email role password");
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      if (ticket.status === "ended") {
        return res.status(400).json({ error: "This chat has ended" });
      }

      ticket.user.password = await bcrypt.hash(temporaryPassword, 10);
      await ticket.user.save();

      ticket.status = "in_progress";
      ticket.replies.push({
        message: reply || "Your password reset request has been processed. Please use the temporary password shared through the approved secure channel and change it after login.",
        sender: req.user.id,
        senderRole: req.user.role,
      });
      await ticket.save();

      const notification = await Notification.create({
        userId: ticket.user._id,
        type: "support_ticket_replied",
        message: `Your password reset request was updated: ${ticket.subject}`,
      });
      if (ticket.user.phone) emitNotification(ticket.user.phone, notification);

      const data = await SupportTicket.findById(ticket._id)
        .populate("user", "name phone email role")
        .populate("replies.sender", "name phone email role")
        .populate("endedBy", "name phone email role")
        .lean();

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.patch(
  "/support-tickets/:id/end",
  protect,
  allowRoles("super_admin", "manager"),
  async (req, res) => {
    try {
      const ticket = await SupportTicket.findById(req.params.id).populate("user", "name phone email role");
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });

      ticket.status = "ended";
      ticket.endedAt = new Date();
      ticket.endedBy = req.user.id;
      await ticket.save();

      const data = await SupportTicket.findById(ticket._id)
        .populate("user", "name phone email role")
        .populate("replies.sender", "name phone email role")
        .populate("endedBy", "name phone email role")
        .lean();

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);


// =======================
// ✅ CREATE USER (super_admin → manager/user | manager → user only)
// =======================
router.post(
  "/users/create",
  protect,
  allowRoles("super_admin", "manager"),
  async (req, res) => {
    try {
      const { name, phone, email, password, role } = req.body;

      if (!email) return res.status(400).json({ error: "Email required" });
      if (!password) return res.status(400).json({ error: "Password required" });

      // manager can only create users, not managers or admins
      if (req.user.role === "manager" && role !== "user") {
        return res.status(403).json({ error: "Manager can only create users" });
      }

      let user = await User.findOne({ email: email.toLowerCase() });
      if (user) return res.status(400).json({ error: "User already exists" });

      const hashedPassword = await bcrypt.hash(password, 10);

      user = await User.create({
        name: name || "UNKNOWN",
        phone,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: role || "user",
        createdBy: req.user.id,
      });

      res.status(201).json({ success: true, user });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


module.exports = router;

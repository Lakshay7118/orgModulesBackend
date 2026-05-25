const express = require("express");
const bcrypt = require("bcryptjs");
const Contact = require("../models/Contact");
const User = require("../models/Users");
const Notification = require("../models/Notification");
const { getIO } = require("../sockets/socket");
const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");
const router = express.Router();

const attachLoginUsers = async (contacts = []) => {
  const plainContacts = contacts.map((contact) =>
    typeof contact.toObject === "function" ? contact.toObject() : contact
  );
  const phones = plainContacts.map((contact) => contact.mobile).filter(Boolean);
  const users = await User.find({ phone: { $in: phones } })
    .select("_id name phone email role isActive")
    .lean();
  const usersByPhone = new Map(users.map((user) => [String(user.phone), user]));

  return plainContacts.map((contact) => {
    const user = usersByPhone.get(String(contact.mobile));
    return {
      ...contact,
      loginUser: user
        ? {
            _id: user._id,
            name: user.name,
            phone: user.phone,
            email: user.email,
            role: user.role,
            isActive: user.isActive !== false,
          }
        : null,
    };
  });
};

// ── Shared helpers ───────────────────────────────────────────────
async function notifyAdmins({ type, message, contactId }) {
  const io = getIO();
  const admins = await User.find({ role: "super_admin" }).select("_id").lean();
  for (const admin of admins) {
    const notif = await Notification.create({ userId: admin._id, type, message, contactId });
    io.to(admin._id.toString()).emit("newNotification", notif);
  }
}

async function notifyUser({ userId, type, message, contactId }) {
  const io = getIO();
  const notif = await Notification.create({ userId, type, message, contactId });
  io.to(userId.toString()).emit("newNotification", notif);
}

// GET ALL CONTACTS
router.get("/contacts", protect, allowRoles("super_admin", "manager", "user"), async (req, res) => {
  try {
    const { tag, managerId } = req.query;
    let filter = {};
    if (req.user.role === "super_admin") { if (managerId) filter.createdBy = managerId; }
    else filter.status = "approved";
    if (tag) filter.tags = tag;
    const contacts = await Contact.find(filter).populate("tags").populate("createdBy", "name phone role");
    res.json(req.user.role === "super_admin" ? await attachLoginUsers(contacts) : contacts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET ALL MANAGERS
router.get("/contacts/managers", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const managers = await User.find({ role: "manager" }).select("name phone role createdAt");
    res.json(managers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET PENDING CONTACTS
router.get("/contacts/pending", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const contacts = await Contact.find({ status: "pending" }).populate("tags").populate("createdBy", "name phone role");
    res.json(await attachLoginUsers(contacts));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CREATE CONTACT
router.post("/contacts", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const { name, mobile, email, password, tags, source, role } = req.body;
    if (!mobile) return res.status(400).json({ error: "Mobile number required" });

    const existing = await Contact.findOne({ mobile });
    if (existing) return res.status(400).json({ error: "Contact already exists" });

    const status = req.user.role === "super_admin" ? "approved" : "pending";

    const contact = new Contact({
      name: name || "UNKNOWN", mobile, email: email || null,
      tags: tags || [], source: source || "MANUAL",
      role: role || "user", status, createdBy: req.user.id,
    });

    await contact.save();

    if (email && password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      let user = await User.findOne({ phone: mobile });
      if (user) {
        user.email = email.toLowerCase(); user.password = hashedPassword;
        user.name = name || user.name; user.role = role || user.role;
        await user.save();
      } else {
        await User.create({ name: name || "UNKNOWN", phone: mobile, email: email.toLowerCase(), password: hashedPassword, role: role || "user", createdBy: req.user.id });
      }
    }

    // ✅ Notify all admins when manager creates a contact pending approval
    if (status === "pending") {
      const manager = await User.findById(req.user.id).select("name").lean();
      const managerName = manager?.name || "A manager";
      await notifyAdmins({
        type: "contact_approval_requested",
        message: `${managerName} added a new contact pending approval: "${name || mobile}"`,
        contactId: contact._id,
      });
    }

    const populated = await contact.populate("tags");
    if (req.user.role === "super_admin") {
      const [enriched] = await attachLoginUsers([populated]);
      return res.status(201).json(enriched);
    }
    res.status(201).json(populated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// APPROVE CONTACT
router.put("/contacts/:id/approve", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const contact = await Contact.findByIdAndUpdate(
      req.params.id, { status: "approved" }, { new: true }
    ).populate("tags").populate("createdBy", "name phone role");

    if (!contact) return res.status(404).json({ error: "Contact not found" });

    // ✅ Notify the manager who created this contact
    if (contact.createdBy?._id) {
      await notifyUser({
        userId: contact.createdBy._id,
        type: "contact_approved",
        message: `Your contact "${contact.name || contact.mobile}" was approved`,
        contactId: contact._id,
      });
    }

    res.json(contact);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// REJECT CONTACT
router.put("/contacts/:id/reject", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const contact = await Contact.findByIdAndUpdate(
      req.params.id, { status: "rejected" }, { new: true }
    ).populate("tags").populate("createdBy", "name phone role");

    if (!contact) return res.status(404).json({ error: "Contact not found" });

    // ✅ Notify the manager who created this contact
    if (contact.createdBy?._id) {
      await notifyUser({
        userId: contact.createdBy._id,
        type: "contact_rejected",
        message: `Your contact "${contact.name || contact.mobile}" was rejected`,
        contactId: contact._id,
      });
    }

    res.json(contact);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// UPDATE CONTACT
router.put("/contacts/:id", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const { name, mobile, email, password, tags, source, role } = req.body;
    const contactId = req.params.id;
    const contact = await Contact.findById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    if (req.user.role === "manager" && contact.createdBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });

    const wasApproved = contact.status === "approved";
    if (req.user.role !== "super_admin") contact.status = "pending";

    if (mobile && mobile !== contact.mobile) {
      const existing = await Contact.findOne({ mobile, _id: { $ne: contactId } });
      if (existing) return res.status(400).json({ error: "Mobile number already exists" });
      contact.mobile = mobile;
    }

    if (name     !== undefined) contact.name   = name || "UNKNOWN";
    if (email    !== undefined) contact.email  = email || null;
    if (tags     !== undefined) contact.tags   = tags;
    if (source   !== undefined) contact.source = source;
    if (role !== undefined) {
      if (req.user.role !== "super_admin") return res.status(403).json({ error: "Only super_admin can change roles" });
      contact.role = role;
    }

    await contact.save();

    // ✅ Notify admins if manager edited and contact went back to pending
    if (req.user.role === "manager" && wasApproved) {
      const manager = await User.findById(req.user.id).select("name").lean();
      const managerName = manager?.name || "A manager";
      await notifyAdmins({
        type: "contact_approval_requested",
        message: `${managerName} updated a contact pending re-approval: "${contact.name || contact.mobile}"`,
        contactId: contact._id,
      });
    }

    if (req.user.role === "super_admin" && (email || password)) {
      const phoneLookup = mobile || contact.mobile;
      let user = await User.findOne({ phone: phoneLookup });
      if (user) {
        if (email) user.email = email.toLowerCase();
        if (password) user.password = await bcrypt.hash(password, 10);
        if (name) user.name = name;
        if (role) user.role = role;
        await user.save();
      } else if (email && password) {
        await User.create({ name: name || contact.name, phone: phoneLookup, email: email.toLowerCase(), password: await bcrypt.hash(password, 10), role: role || contact.role, createdBy: req.user.id });
      }
    }

    const populated = await contact.populate("tags");
    if (req.user.role === "super_admin") {
      const [enriched] = await attachLoginUsers([populated]);
      return res.json(enriched);
    }
    res.json(populated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// UPDATE LOGIN ACCESS
router.patch("/contacts/:id/login-status", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id)
      .populate("tags")
      .populate("createdBy", "name phone role");
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const lookup = [{ phone: contact.mobile }];
    if (contact.email) lookup.push({ email: String(contact.email).toLowerCase() });

    const user = await User.findOne({ $or: lookup });
    if (!user) {
      return res.status(404).json({ error: "This contact does not have a login account" });
    }

    const nextActive = req.body.isActive !== false;
    if (!nextActive && String(user._id) === String(req.user.id)) {
      return res.status(400).json({ error: "You cannot deactivate your own account" });
    }

    user.isActive = nextActive;
    await user.save();

    const [enriched] = await attachLoginUsers([contact]);
    res.json(enriched);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE CONTACT
router.delete("/contacts/:id", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const deleted = await Contact.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Contact not found" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

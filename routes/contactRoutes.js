const express = require("express");
const bcrypt = require("bcryptjs");
const Contact = require("../models/Contact");
const Tag = require("../models/Tag");
const User = require("../models/Users");
const Notification = require("../models/Notification");
const { getIO } = require("../sockets/socket");
const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");
const { normalizeHrPermissions } = require("../utils/hrPermissions");
const router = express.Router();

const TOP_ADMIN_ROLES = ["super_to_super_admin", "super_admin"];
const HIDDEN_CONTACT_ROLES = ["super_to_super_admin"];

const sameId = (left, right) =>
  left && right && String(left) === String(right);

const isTopAdmin = (role) => TOP_ADMIN_ROLES.includes(role);
const hasHrModule = (req) => req.user.role === "super_to_super_admin" || (req.user.allowedModules || []).includes("hr");
const canAssignHrPermissions = (req, targetRole) =>
  hasHrModule(req) && isTopAdmin(req.user.role) && ["manager", "hr"].includes(targetRole);

const creatableRolesByRole = {
  super_to_super_admin: ["super_admin", "manager", "hr", "user"],
  super_admin: ["manager", "hr", "user"],
  manager: ["hr", "user"],
  hr: ["user"],
};

const resolveCreatableRole = (req, requestedRole) => {
  const role = requestedRole || "user";
  const allowedRoles = creatableRolesByRole[req.user.role] || [];
  if (!allowedRoles.includes(role)) {
    const error = new Error(`${req.user.role} cannot create ${role}`);
    error.statusCode = 403;
    throw error;
  }
  if (role === "hr" && !hasHrModule(req)) {
    const error = new Error("Your organization does not have access to HR.");
    error.statusCode = 403;
    throw error;
  }
  return role;
};

const getOrganizationContactScope = async (req) => {
  if (req.user.role === "super_to_super_admin") return {};

  if (!req.user.organization) {
    return { createdBy: req.user.id };
  }

  const orgUsers = await User.find({ organization: req.user.organization }).select("_id").lean();
  const orgUserIds = orgUsers.map((user) => user._id);

  return {
    $or: [
      { organization: req.user.organization },
      { organization: null, createdBy: { $in: orgUserIds } },
    ],
  };
};

const mergeContactFilter = async (req, filter = {}) => {
  const scope = await getOrganizationContactScope(req);
  return Object.keys(scope).length ? { $and: [scope, filter] } : filter;
};

const canAccessContact = async (req, contact) => {
  if (req.user.role === "super_to_super_admin") return true;
  if (!contact) return false;

  if (sameId(contact.organization, req.user.organization)) return true;

  if (!contact.organization && contact.createdBy) {
    const creatorId = contact.createdBy._id || contact.createdBy;
    const creator = await User.findById(creatorId).select("organization").lean();
    return sameId(creator?.organization, req.user.organization);
  }

  return false;
};

const validateTagsInOrganization = async (req, tags = []) => {
  if (!Array.isArray(tags) || tags.length === 0 || req.user.role === "super_to_super_admin") return true;
  if (!req.user.organization) {
    const count = await Tag.countDocuments({ _id: { $in: tags }, createdBy: req.user.id });
    return count === new Set(tags.map(String)).size;
  }
  const orgUsers = await User.find({ organization: req.user.organization }).select("_id").lean();
  const orgUserIds = orgUsers.map((user) => user._id.toString());
  const count = await Tag.countDocuments({
    _id: { $in: tags },
    $or: [
      { organization: req.user.organization },
      { organization: null, createdBy: { $in: orgUserIds } },
    ],
  });
  return count === new Set(tags.map(String)).size;
};

const filterContactTagsForOrganization = async (req, contacts = []) => {
  if (req.user.role === "super_to_super_admin") return contacts;
  const tagScope = req.user.organization
    ? {
        $or: [
          { organization: req.user.organization },
          {
            organization: null,
            createdBy: {
              $in: (await User.find({ organization: req.user.organization }).select("_id").lean())
                .map((user) => user._id.toString()),
            },
          },
        ],
      }
    : { createdBy: req.user.id };
  const allowedTagIds = new Set((await Tag.find(tagScope).select("_id").lean()).map((tag) => tag._id.toString()));
  return contacts.map((contact) => {
    const plain = typeof contact.toObject === "function" ? contact.toObject() : contact;
    return {
      ...plain,
      tags: (plain.tags || []).filter((tag) => allowedTagIds.has(String(tag?._id || tag))),
    };
  });
};

const hideSystemContacts = (contacts = []) =>
  contacts.filter((contact) => {
    const role = contact.loginUser?.role || contact.role || contact.createdBy?.role || "";
    return !HIDDEN_CONTACT_ROLES.includes(role);
  });

const attachLoginUsers = async (contacts = []) => {
  const plainContacts = contacts.map((contact) =>
    typeof contact.toObject === "function" ? contact.toObject() : contact
  );
  const phones = plainContacts.map((contact) => contact.mobile).filter(Boolean);
  const users = await User.find({ phone: { $in: phones } })
    .select("_id name phone email role isActive hrPermissions")
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
            hrPermissions: normalizeHrPermissions(user.hrPermissions),
            isActive: user.isActive !== false,
          }
        : null,
    };
  });
};

// ── Shared helpers ───────────────────────────────────────────────
async function notifyAdmins({ type, message, contactId, organization }) {
  const io = getIO();
  const query = organization
    ? {
        $or: [
          { role: "super_to_super_admin" },
          { role: "super_admin", organization },
        ],
      }
    : { role: { $in: TOP_ADMIN_ROLES } };
  const admins = await User.find(query).select("_id").lean();
  for (const admin of admins) {
    const notif = await Notification.create({ userId: admin._id, organization: organization || null, type, message, contactId });
    io.to(admin._id.toString()).emit("newNotification", notif);
  }
}

async function notifyUser({ userId, type, message, contactId, organization }) {
  const io = getIO();
  const notif = await Notification.create({ userId, organization: organization || null, type, message, contactId });
  io.to(userId.toString()).emit("newNotification", notif);
}

// GET ALL CONTACTS
router.get("/contacts", protect, allowRoles("super_admin", "manager", "hr", "user"), async (req, res) => {
  try {
    const { tag, managerId } = req.query;
    if (tag && !(await validateTagsInOrganization(req, [tag]))) return res.json([]);
    let filter = {};
    if (isTopAdmin(req.user.role)) { if (managerId) filter.createdBy = managerId; }
    else filter.status = "approved";
    if (tag) filter.tags = tag;
    filter.role = { $nin: HIDDEN_CONTACT_ROLES };
    filter = await mergeContactFilter(req, filter);
    const contacts = await Contact.find(filter).populate("tags").populate("createdBy", "name phone role");
    const scopedContacts = await filterContactTagsForOrganization(req, contacts);
    const data = isTopAdmin(req.user.role) ? await attachLoginUsers(scopedContacts) : scopedContacts;
    res.json(hideSystemContacts(data));
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// GET ALL MANAGERS
router.get("/contacts/managers", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const query = req.user.role === "super_to_super_admin"
      ? { role: "manager" }
      : { role: "manager", organization: req.user.organization };
    const managers = await User.find(query).select("name phone role createdAt organization");
    res.json(managers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET PENDING CONTACTS
router.get("/contacts/pending", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const filter = await mergeContactFilter(req, { status: "pending", role: { $nin: HIDDEN_CONTACT_ROLES } });
    const contacts = await Contact.find(filter).populate("tags").populate("createdBy", "name phone role");
    res.json(hideSystemContacts(await attachLoginUsers(contacts)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CREATE CONTACT
router.post("/contacts", protect, allowRoles("super_admin", "manager", "hr"), async (req, res) => {
  try {
    const { name, mobile, email, password, tags, source, role, hrPermissions } = req.body;
    if (!mobile) return res.status(400).json({ error: "Mobile number required" });
    const targetRole = resolveCreatableRole(req, role);

    const existing = await Contact.findOne({ mobile });
    if (existing) return res.status(400).json({ error: "Contact already exists" });
    if (!(await validateTagsInOrganization(req, tags))) {
      return res.status(403).json({ error: "Tags must belong to your organization" });
    }

    const status = isTopAdmin(req.user.role) ? "approved" : "pending";

    const contact = new Contact({
      name: name || "UNKNOWN", mobile, email: email || null,
      tags: tags || [], source: source || "MANUAL",
      role: targetRole,
      status,
      organization: req.user.organization,
      createdBy: req.user.id,
    });

    await contact.save();

    if (email && password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      let user = await User.findOne({ phone: mobile });
      if (user) {
        user.email = email.toLowerCase(); user.password = hashedPassword;
        user.name = name || user.name; user.role = targetRole;
        if (canAssignHrPermissions(req, targetRole)) {
          user.hrPermissions = normalizeHrPermissions(hrPermissions);
        }
        await user.save();
      } else {
        await User.create({
          name: name || "UNKNOWN",
          phone: mobile,
          email: email.toLowerCase(),
          password: hashedPassword,
          role: targetRole,
          organization: req.user.organization,
          allowedModules: req.user.allowedModules || [],
          hrPermissions: canAssignHrPermissions(req, targetRole)
            ? normalizeHrPermissions(hrPermissions)
            : undefined,
          createdBy: req.user.id,
        });
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
        organization: req.user.organization,
      });
    }

    const populated = await contact.populate("tags");
    if (isTopAdmin(req.user.role)) {
      const [enriched] = await attachLoginUsers([populated]);
      return res.status(201).json(enriched);
    }
    res.status(201).json(populated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// APPROVE CONTACT
router.put("/contacts/:id/approve", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const existing = await Contact.findById(req.params.id).populate("createdBy", "name phone role organization");
    if (!existing) return res.status(404).json({ error: "Contact not found" });
    if (!(await canAccessContact(req, existing))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }

    existing.status = "approved";
    if (!existing.organization && req.user.organization) existing.organization = req.user.organization;
    await existing.save();

    const contact = await Contact.findById(existing._id).populate("tags").populate("createdBy", "name phone role organization");

    if (!contact) return res.status(404).json({ error: "Contact not found" });

    // ✅ Notify the manager who created this contact
    if (contact.createdBy?._id) {
      await notifyUser({
        userId: contact.createdBy._id,
        type: "contact_approved",
        message: `Your contact "${contact.name || contact.mobile}" was approved`,
        contactId: contact._id,
        organization: contact.organization || req.user.organization || null,
      });
    }

    res.json(contact);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// REJECT CONTACT
router.put("/contacts/:id/reject", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const existing = await Contact.findById(req.params.id).populate("createdBy", "name phone role organization");
    if (!existing) return res.status(404).json({ error: "Contact not found" });
    if (!(await canAccessContact(req, existing))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }

    existing.status = "rejected";
    if (!existing.organization && req.user.organization) existing.organization = req.user.organization;
    await existing.save();

    const contact = await Contact.findById(existing._id).populate("tags").populate("createdBy", "name phone role organization");

    if (!contact) return res.status(404).json({ error: "Contact not found" });

    // ✅ Notify the manager who created this contact
    if (contact.createdBy?._id) {
      await notifyUser({
        userId: contact.createdBy._id,
        type: "contact_rejected",
        message: `Your contact "${contact.name || contact.mobile}" was rejected`,
        contactId: contact._id,
        organization: contact.organization || req.user.organization || null,
      });
    }

    res.json(contact);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// UPDATE CONTACT
router.put("/contacts/:id", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const { name, mobile, email, password, tags, source, role, hrPermissions } = req.body;
    const contactId = req.params.id;
    const contact = await Contact.findById(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    if (!(await canAccessContact(req, contact))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }
    if (req.user.role === "manager" && contact.createdBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    if (tags !== undefined && !(await validateTagsInOrganization(req, tags))) {
      return res.status(403).json({ error: "Tags must belong to your organization" });
    }

    const wasApproved = contact.status === "approved";
    if (!isTopAdmin(req.user.role)) contact.status = "pending";

    if (mobile && mobile !== contact.mobile) {
      const existing = await Contact.findOne({ mobile, _id: { $ne: contactId } });
      if (existing) return res.status(400).json({ error: "Mobile number already exists" });
      contact.mobile = mobile;
    }

    if (name     !== undefined) contact.name   = name || "UNKNOWN";
    if (email    !== undefined) contact.email  = email || null;
    if (tags     !== undefined) contact.tags   = tags;
    if (source   !== undefined) contact.source = source;
    if (!contact.organization && req.user.organization) contact.organization = req.user.organization;
    if (role !== undefined) {
      if (!isTopAdmin(req.user.role)) return res.status(403).json({ error: "Only admins can change roles" });
      if (role === "hr" && !hasHrModule(req)) {
        return res.status(403).json({ error: "Your organization does not have access to HR." });
      }
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
        organization: req.user.organization,
      });
    }

    if (isTopAdmin(req.user.role) && (email || password || hrPermissions !== undefined)) {
      const phoneLookup = mobile || contact.mobile;
      let user = await User.findOne({ phone: phoneLookup });
      if (user) {
        if (email) user.email = email.toLowerCase();
        if (password) user.password = await bcrypt.hash(password, 10);
        if (name) user.name = name;
        if (role) user.role = role;
        const effectiveRole = role || user.role || contact.role;
        if (canAssignHrPermissions(req, effectiveRole)) {
          user.hrPermissions = normalizeHrPermissions(hrPermissions);
        }
        await user.save();
      } else if (email && password) {
        await User.create({
          name: name || contact.name,
          phone: phoneLookup,
          email: email.toLowerCase(),
          password: await bcrypt.hash(password, 10),
          role: role || contact.role,
          organization: req.user.organization,
          allowedModules: req.user.allowedModules || [],
          hrPermissions: canAssignHrPermissions(req, role || contact.role)
            ? normalizeHrPermissions(hrPermissions)
            : undefined,
          createdBy: req.user.id,
        });
      }
    }

    const populated = await contact.populate("tags");
    if (isTopAdmin(req.user.role)) {
      const [enriched] = await attachLoginUsers([populated]);
      return res.json(enriched);
    }
    res.json(populated);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// UPDATE LOGIN ACCESS
router.patch("/contacts/:id/login-status", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id)
      .populate("tags")
      .populate("createdBy", "name phone role organization");
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    if (!(await canAccessContact(req, contact))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }

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
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    if (!(await canAccessContact(req, contact))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }
    await contact.deleteOne();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

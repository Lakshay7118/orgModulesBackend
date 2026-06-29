const express = require("express");
const multer = require("multer");
const Template = require("../models/Template");
const cloudinary = require("../config/cloudinary");
const { getIO } = require("../sockets/socket");
const User = require("../models/Users");
const Notification = require("../models/Notification"); // ✅ was missing

const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");

const router = express.Router();

const TOP_ADMIN_ROLES = ["super_to_super_admin", "super_admin"];
const isTopAdmin = (role) => TOP_ADMIN_ROLES.includes(role);
const sameId = (left, right) => left && right && String(left) === String(right);

const organizationUserIds = async (organization) => {
  if (!organization) return [];
  const users = await User.find({ organization }).select("_id").lean();
  return users.map((user) => user._id);
};

const scopedTemplateFilter = async (req, filter = {}) => {
  if (req.user.role === "super_to_super_admin") return filter;

  if (!req.user.organization) {
    return { $and: [{ createdBy: req.user.id }, filter] };
  }

  const orgUsers = await organizationUserIds(req.user.organization);
  return {
    $and: [
      {
        $or: [
          { organization: req.user.organization },
          { organization: null, createdBy: { $in: orgUsers } },
        ],
      },
      filter,
    ],
  };
};

const canAccessTemplate = async (req, template) => {
  if (req.user.role === "super_to_super_admin") return true;
  if (!template) return false;
  if (sameId(template.organization, req.user.organization)) return true;
  if (!template.organization && template.createdBy) {
    const creatorId = template.createdBy._id || template.createdBy;
    const creator = await User.findById(creatorId).select("organization").lean();
    return sameId(creator?.organization, req.user.organization);
  }
  return false;
};

const storage = multer.memoryStorage();
const upload = multer({ storage });

const safeParse = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return value; }
};

const uploadToCloudinary = (buffer) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "auto" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
};

// ── Shared helper: notify all admins ────────────────────────────
async function notifyAdmins({ type, message, templateId, organization }) {
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
    const notif = await Notification.create({
      userId: admin._id,
      organization: organization || null,
      type,
      message,
      templateId,
    });
    io.to(admin._id.toString()).emit("newNotification", notif);
  }
}

// ── Shared helper: notify a single user ─────────────────────────
async function notifyUser({ userId, type, message, templateId, organization }) {
  const io = getIO();
  const notif = await Notification.create({
    userId,
    organization: organization || null,
    type,
    message,
    templateId,
  });
  io.to(userId.toString()).emit("newNotification", notif);
}


// =======================
// ✅ GET PENDING APPROVALS (super_admin only)
// =======================
router.get(
  "/templates/pending",
  protect,
  allowRoles("super_admin"),
  async (req, res) => {
    try {
      const filter = await scopedTemplateFilter(req, { approvalStatus: "pending_approval" });
      const templates = await Template.find(filter)
        .populate("createdBy", "name phone role")
        .sort({ createdAt: -1 });
      res.json({ success: true, templates });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);


// =======================
// ✅ APPROVE TEMPLATE (super_admin only)
// =======================
router.put(
  "/templates/:id/approve",
  protect,
  allowRoles("super_admin"),
  async (req, res) => {
    try {
      const existing = await Template.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: "Template not found" });
      if (!(await canAccessTemplate(req, existing))) {
        return res.status(403).json({ error: "Not authorized for this organization" });
      }

      const template = await Template.findByIdAndUpdate(
        req.params.id,
        { approvalStatus: "approved", status: "APPROVED", organization: existing.organization || req.user.organization || null },
        { new: true }
      ).populate("createdBy", "name phone role");

      // ✅ Notify the manager their template was approved
      await notifyUser({
        userId: template.createdBy._id,
        type: "template_approved",
        message: `Your template "${template.name}" was approved`,
        templateId: template._id,
        organization: template.organization || req.user.organization || null,
      });

      res.json({ success: true, template });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);


// =======================
// ✅ REJECT TEMPLATE (super_admin only)
// =======================
router.put(
  "/templates/:id/reject",
  protect,
  allowRoles("super_admin"),
  async (req, res) => {
    try {
      const existing = await Template.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: "Template not found" });
      if (!(await canAccessTemplate(req, existing))) {
        return res.status(403).json({ error: "Not authorized for this organization" });
      }

      const template = await Template.findByIdAndUpdate(
        req.params.id,
        { approvalStatus: "rejected", status: "REJECTED", organization: existing.organization || req.user.organization || null },
        { new: true }
      ).populate("createdBy", "name phone role");

      // ✅ Notify the manager their template was rejected
      await notifyUser({
        userId: template.createdBy._id,
        type: "template_rejected",
        message: `Your template "${template.name}" was rejected`,
        templateId: template._id,
        organization: template.organization || req.user.organization || null,
      });

      res.json({ success: true, template });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);


// =======================
// ✅ GET ALL TEMPLATES
// =======================
router.get(
  "/templates",
  protect,
  allowRoles("super_admin", "manager", "user"),
  async (req, res) => {
    try {
      let filter = {};
      if (req.user.role === "manager") filter.createdBy = req.user.id;
      else if (req.user.role === "user") filter.approvalStatus = "approved";
      filter = await scopedTemplateFilter(req, filter);

      const templates = await Template.find(filter)
        .populate("createdBy", "name phone role")
        .sort({ createdAt: -1 });

      res.json({ success: true, templates });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);


// =======================
// ✅ CREATE TEMPLATE
// =======================
router.post(
  "/templates",
  protect,
  allowRoles("super_admin", "manager"),
  upload.single("mediaFile"),
  async (req, res) => {
    try {
      const { name, category, language, type, format, footer, actionType, mediaType } = req.body;

      if (!name || !category || !format) {
        return res.status(400).json({ error: "Missing required fields: name, category, format" });
      }

      let imageFile = safeParse(req.body.imageFile);
      let videoFile = safeParse(req.body.videoFile);
      let carouselItems = safeParse(req.body.carouselItems) || [];
      let ctaButtons = safeParse(req.body.ctaButtons) || [];
      let quickReplies = safeParse(req.body.quickReplies) || [];
      let copyCodeButtons = safeParse(req.body.copyCodeButtons) || [];
      let dropdownButtons = safeParse(req.body.dropdownButtons) || [];
      let inputFields = safeParse(req.body.inputFields) || [];
      let variables = safeParse(req.body.variables) || {};

      if (imageFile?.type) { imageFile.mimeType = imageFile.type; delete imageFile.type; }
      if (videoFile?.type) { videoFile.mimeType = videoFile.type; delete videoFile.type; }
      carouselItems = carouselItems.map((item) => {
        if (item.mediaType) { item.mimeType = item.mediaType; delete item.mediaType; }
        return item;
      });
      ctaButtons = ctaButtons.map((btn) => ({ ...btn, btnType: btn.type, type: undefined }));

      if (req.file) {
        const result = await uploadToCloudinary(req.file.buffer);
        if (mediaType === "Image") imageFile = { name: req.file.originalname, mimeType: req.file.mimetype, url: result.secure_url };
        else if (mediaType === "Video") videoFile = { name: req.file.originalname, mimeType: req.file.mimetype, url: result.secure_url };
      }

      const approvalStatus = isTopAdmin(req.user.role) ? "approved" : "pending_approval";

      const template = new Template({
        name, category,
        language: language || "English",
        type: type || "Text",
        format,
        footer: footer || "",
        actionType: actionType || "none",
        mediaType: mediaType || "None",
        imageFile: imageFile || null,
        videoFile: videoFile || null,
        carouselItems,
        ctaButtons,
        quickReplies,
        copyCodeButtons,
        dropdownButtons,
        inputFields,
        variables,
        status: "DRAFT",
        approvalStatus,
        createdBy: req.user.id,
        organization: req.user.organization || null,
      });

      await template.save();

      // ✅ Notify all admins when manager submits a new template
      if (approvalStatus === "pending_approval") {
        const manager = await User.findById(req.user.id).select("name").lean();
        const managerName = manager?.name || "A manager";

        await notifyAdmins({
          type: "template_approval_requested",
          message: `${managerName} submitted a new template for approval: "${template.name}"`,
          templateId: template._id,
          organization: req.user.organization,
        });
      }

      res.status(201).json({
        success: true,
        message: req.user.role === "manager"
          ? "Template submitted for admin approval"
          : "Template created successfully",
        template,
        pendingApproval: approvalStatus === "pending_approval",
      });
    } catch (error) {
      console.error("Template creation error:", error);
      res.status(500).json({ error: error.message });
    }
  }
);


// =======================
// ✅ GET SINGLE TEMPLATE
// =======================
router.get(
  "/templates/:id",
  protect,
  allowRoles("super_admin", "manager", "user"),
  async (req, res) => {
    try {
      const template = await Template.findById(req.params.id)
        .populate("createdBy", "name phone role");

      if (!template) return res.status(404).json({ error: "Template not found" });
      if (!(await canAccessTemplate(req, template))) {
        return res.status(403).json({ error: "Not authorized for this organization" });
      }

      if (req.user.role === "manager" && template.createdBy._id.toString() !== req.user.id) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (req.user.role === "user" && template.approvalStatus !== "approved") {
        return res.status(403).json({ error: "Not authorized" });
      }

      res.json({ success: true, template });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);


// =======================
// ✅ UPDATE TEMPLATE
// =======================
router.put(
  "/templates/:id",
  protect,
  allowRoles("super_admin", "manager"),
  upload.single("mediaFile"),
  async (req, res) => {
    try {
      const templateId = req.params.id;
      const existing = await Template.findById(templateId);

      if (!existing) return res.status(404).json({ error: "Template not found" });
      if (!(await canAccessTemplate(req, existing))) {
        return res.status(403).json({ error: "Not authorized for this organization" });
      }

      if (req.user.role === "manager" && existing.createdBy.toString() !== req.user.id) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const { name, category, language, type, format, footer, actionType, mediaType } = req.body;

      let imageFile = safeParse(req.body.imageFile);
      let videoFile = safeParse(req.body.videoFile);
      let carouselItems = safeParse(req.body.carouselItems) || [];
      let ctaButtons = safeParse(req.body.ctaButtons) || [];
      let quickReplies = safeParse(req.body.quickReplies) || [];
      let copyCodeButtons = safeParse(req.body.copyCodeButtons) || [];
      let dropdownButtons = safeParse(req.body.dropdownButtons) || [];
      let inputFields = safeParse(req.body.inputFields) || [];
      let variables = safeParse(req.body.variables) || {};

      if (imageFile?.type) { imageFile.mimeType = imageFile.type; delete imageFile.type; }
      if (videoFile?.type) { videoFile.mimeType = videoFile.type; delete videoFile.type; }
      carouselItems = carouselItems.map((item) => {
        if (item.mediaType) { item.mimeType = item.mediaType; delete item.mediaType; }
        return item;
      });
      ctaButtons = ctaButtons.map((btn) => ({ ...btn, btnType: btn.type, type: undefined }));

      if (req.file) {
        const result = await uploadToCloudinary(req.file.buffer);
        if (mediaType === "Image") imageFile = { name: req.file.originalname, mimeType: req.file.mimetype, url: result.secure_url };
        else if (mediaType === "Video") videoFile = { name: req.file.originalname, mimeType: req.file.mimetype, url: result.secure_url };
      } else {
        if (mediaType === "Image") imageFile = existing.imageFile;
        if (mediaType === "Video") videoFile = existing.videoFile;
      }

      const approvalStatus = req.user.role === "manager" ? "pending_approval" : existing.approvalStatus;

      const updated = await Template.findByIdAndUpdate(
        templateId,
        {
          name, category,
          language: language || "English",
          type: type || "Text",
          format,
          footer: footer || "",
          actionType: actionType || "none",
          mediaType: mediaType || "None",
          imageFile,
          videoFile,
          carouselItems,
          ctaButtons,
          quickReplies,
          copyCodeButtons,
          dropdownButtons,
          inputFields,
          variables,
          approvalStatus,
          organization: existing.organization || req.user.organization || null,
          updatedAt: Date.now(),
        },
        { new: true }
      ).populate("createdBy", "name phone role");

      // ✅ Notify admins when manager re-submits an edited template
      if (approvalStatus === "pending_approval") {
        const manager = await User.findById(req.user.id).select("name").lean();
        const managerName = manager?.name || "A manager";

        await notifyAdmins({
          type: "template_approval_requested",
          message: `${managerName} re-submitted an updated template for approval: "${updated.name}"`,
          templateId: updated._id,
          organization: req.user.organization,
        });
      }

      res.json({
        success: true,
        template: updated,
        pendingApproval: approvalStatus === "pending_approval",
      });
    } catch (error) {
      console.error("Template update error:", error);
      res.status(500).json({ error: error.message });
    }
  }
);


// =======================
// ✅ DELETE TEMPLATE (super_admin only)
// =======================
router.delete(
  "/templates/:id",
  protect,
  allowRoles("super_admin"),
  async (req, res) => {
    try {
      const existing = await Template.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: "Template not found" });
      if (!(await canAccessTemplate(req, existing))) {
        return res.status(403).json({ error: "Not authorized for this organization" });
      }
      await existing.deleteOne();
      res.json({ success: true, message: "Template deleted" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);


module.exports = router;

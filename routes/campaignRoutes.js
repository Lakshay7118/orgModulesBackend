const express = require("express");
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const Tag = require("../models/Tag");
const Notification = require("../models/Notification");
const User = require("../models/Users");
const { getIO } = require("../sockets/socket");

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

const scopedCampaignFilter = async (req, filter = {}) => {
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

const canAccessCampaign = async (req, campaign) => {
  if (req.user.role === "super_to_super_admin") return true;
  if (!campaign) return false;
  if (sameId(campaign.organization, req.user.organization)) return true;
  if (!campaign.organization && campaign.createdBy) {
    const creatorId = campaign.createdBy._id || campaign.createdBy;
    const creator = await User.findById(creatorId).select("organization").lean();
    return sameId(creator?.organization, req.user.organization);
  }
  return false;
};

const canAccessTemplate = async (req, template) => {
  if (req.user.role === "super_to_super_admin") return true;
  if (!template) return false;
  if (sameId(template.organization, req.user.organization)) return true;
  if (!template.organization && template.createdBy) {
    const creator = await User.findById(template.createdBy).select("organization").lean();
    return sameId(creator?.organization, req.user.organization);
  }
  return false;
};

const validateTagsInOrganization = async (req, tagIds = []) => {
  if (!Array.isArray(tagIds) || tagIds.length === 0 || req.user.role === "super_to_super_admin") return true;
  if (!req.user.organization) {
    const count = await Tag.countDocuments({ _id: { $in: tagIds }, createdBy: req.user.id });
    return count === new Set(tagIds.map(String)).size;
  }
  const orgUsers = await organizationUserIds(req.user.organization);
  const count = await Tag.countDocuments({
    _id: { $in: tagIds },
    $or: [
      { organization: req.user.organization },
      { organization: null, createdBy: { $in: orgUsers.map((id) => id.toString()) } },
    ],
  });
  return count === new Set(tagIds.map(String)).size;
};

// ── Shared helpers ───────────────────────────────────────────────
async function notifyAdmins({ type, message, campaignId, organization }) {
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
    const notif = await Notification.create({ userId: admin._id, type, message, campaignId });
    io.to(admin._id.toString()).emit("newNotification", notif);
  }
}

async function notifyUser({ userId, type, message, campaignId }) {
  const io = getIO();
  const notif = await Notification.create({ userId, type, message, campaignId });
  io.to(userId.toString()).emit("newNotification", notif);
}

function computeNextRun(recurrence, baseDate = new Date()) {
  const interval = recurrence.interval || 1;
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const utcMs = new Date(baseDate).getTime();
  const istDate = new Date(utcMs + IST_OFFSET);
  switch (recurrence.type) {
    case "daily":   istDate.setDate(istDate.getDate() + interval); break;
    case "weekly":
      istDate.setDate(istDate.getDate() + 7 * interval);
      if (recurrence.dayOfWeek !== undefined) {
        const diff = (recurrence.dayOfWeek - istDate.getDay() + 7) % 7;
        istDate.setDate(istDate.getDate() + diff);
      }
      break;
    case "monthly":
      istDate.setMonth(istDate.getMonth() + interval);
      if (recurrence.dayOfMonth) istDate.setDate(recurrence.dayOfMonth);
      break;
    case "hourly":  istDate.setHours(istDate.getHours() + interval); break;
    default: return null;
  }
  return new Date(istDate.getTime() - IST_OFFSET);
}

// GET PENDING APPROVALS
router.get("/campaigns/pending", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const filter = await scopedCampaignFilter(req, { approvalStatus: "pending_approval" });
    const campaigns = await Campaign.find(filter)
      .populate("createdBy", "name phone role")
      .populate("templateId", "name")
      .sort({ createdAt: -1 });
    res.json({ success: true, campaigns });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// APPROVE CAMPAIGN
router.put("/campaigns/:id/approve", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const existing = await Campaign.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Campaign not found" });
    if (!(await canAccessCampaign(req, existing))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }

    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      { approvalStatus: "approved", status: "scheduled", organization: existing.organization || req.user.organization || null },
      { new: true }
    ).populate("createdBy", "name phone role");

    // ✅ Notify manager
    await notifyUser({
      userId: campaign.createdBy._id,
      type: "campaign_approved",
      message: `Your campaign "${campaign.campaignName}" was approved and is now scheduled`,
      campaignId: campaign._id,
    });

    res.json({ success: true, campaign });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// REJECT CAMPAIGN
router.put("/campaigns/:id/reject", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const existing = await Campaign.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Campaign not found" });
    if (!(await canAccessCampaign(req, existing))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }

    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      { approvalStatus: "rejected", status: "cancelled", organization: existing.organization || req.user.organization || null },
      { new: true }
    ).populate("createdBy", "name phone role");

    // ✅ Notify manager
    await notifyUser({
      userId: campaign.createdBy._id,
      type: "campaign_rejected",
      message: `Your campaign "${campaign.campaignName}" was rejected`,
      campaignId: campaign._id,
    });

    res.json({ success: true, campaign });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET ALL CAMPAIGNS
router.get("/campaigns", protect, allowRoles("super_admin", "manager", "user"), async (req, res) => {
  try {
    let filter = {};
    if (req.user.role === "manager") filter.createdBy = req.user.id;
    filter = await scopedCampaignFilter(req, filter);
    const campaigns = await Campaign.find(filter)
      .populate("createdBy", "name phone role")
      .populate("templateId", "name")
      .sort({ createdAt: -1 });
    res.json({ success: true, campaigns });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET SINGLE CAMPAIGN
router.get("/campaigns/:id", protect, allowRoles("super_admin", "manager", "user"), async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id)
      .populate("createdBy", "name phone role")
      .populate("templateId", "name");
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (!(await canAccessCampaign(req, campaign))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }
    if (req.user.role === "manager" && campaign.createdBy._id.toString() !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    res.json({ success: true, campaign });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// CREATE CAMPAIGN
router.post("/campaigns", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const {
      campaignName, messageType, audienceType, tagIds, contactIds,
      groupIds, manualNumbers, templateId, scheduledDateTime,
      recurrence, variableValues: requestVariableValues, messagePreview, launchKey,
    } = req.body;
    const launchKeyValue =
      typeof launchKey === "string" && launchKey.trim() ? launchKey.trim() : null;

    if (!campaignName) return res.status(400).json({ error: "campaignName is required" });
    if (!["tags", "contact", "group", "manual"].includes(audienceType))
      return res.status(400).json({ error: "Invalid audienceType" });
    if (audienceType === "tags"    && (!tagIds        || tagIds.length === 0))   return res.status(400).json({ error: "Select at least one tag" });
    if (audienceType === "contact" && (!contactIds    || contactIds.length === 0)) return res.status(400).json({ error: "Select at least one contact" });
    if (audienceType === "group"   && (!groupIds      || groupIds.length === 0))   return res.status(400).json({ error: "Select at least one group" });
    if (audienceType === "manual"  && (!manualNumbers || manualNumbers.length === 0)) return res.status(400).json({ error: "Enter manual numbers" });
    if (!scheduledDateTime) return res.status(400).json({ error: "scheduledDateTime is required" });
    if (audienceType === "tags" && !(await validateTagsInOrganization(req, tagIds))) {
      return res.status(403).json({ error: "Tags must belong to your organization" });
    }

    const scheduledDate = new Date(scheduledDateTime);
    if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: "Invalid scheduledDateTime" });

    const nextRun = scheduledDate;
    let finalVariableValues = requestVariableValues || {};

    if (templateId) {
      const Template = require("../models/Template");
      const template = await Template.findById(templateId).lean();
      if (!template || !(await canAccessTemplate(req, template))) {
        return res.status(403).json({ error: "Template belongs to another organization" });
      }
      if (template?.variables) {
        for (const [key, varDef] of Object.entries(template.variables)) {
          if (!finalVariableValues[key]) finalVariableValues[key] = { type: varDef.type, value: varDef.value || "" };
          else { finalVariableValues[key].type = varDef.type; if (!finalVariableValues[key].value) finalVariableValues[key].value = varDef.value || ""; }
        }
      }
    }

    const approvalStatus = isTopAdmin(req.user.role) ? "approved" : "pending_approval";

    if (launchKeyValue) {
      const existingCampaign = await Campaign.findOne({
        createdBy: req.user.id,
        launchKey: launchKeyValue,
      }).sort({ createdAt: 1 });

      if (existingCampaign) {
        return res.status(200).json({
          success: true,
          message: "Campaign already created",
          campaign: existingCampaign,
          pendingApproval: existingCampaign.approvalStatus === "pending_approval",
          duplicate: true,
        });
      }
    }

    const campaign = new Campaign({
      launchKey: launchKeyValue,
      campaignName, messageType, audienceType,
      tagIds: tagIds || [], contactIds: contactIds || [],
      groupIds: groupIds || [], manualNumbers: manualNumbers || [],
      templateId, scheduledDateTime: nextRun,
      recurrence: recurrence || { type: "one-time" },
      variableValues: finalVariableValues, messagePreview,
      createdBy: req.user.id,
      organization: req.user.organization || null,
      status: isTopAdmin(req.user.role) ? "scheduled" : "draft",
      approvalStatus, nextRun,
    });

    await campaign.save();

    // ✅ Notify all admins when manager submits
    if (approvalStatus === "pending_approval") {
      const manager = await User.findById(req.user.id).select("name").lean();
      const managerName = manager?.name || "A manager";
      await notifyAdmins({
        type: "campaign_approval_requested",
        message: `${managerName} submitted a campaign for approval: "${campaign.campaignName}"`,
        campaignId: campaign._id,
        organization: req.user.organization,
      });
    }

    res.status(201).json({
      success: true,
      message: req.user.role === "manager" ? "Campaign submitted for admin approval" : "Campaign created successfully",
      campaign,
      pendingApproval: approvalStatus === "pending_approval",
    });
  } catch (error) {
    console.error("Campaign creation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATE CAMPAIGN
router.put("/campaigns/:id", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const campaignId = req.params.id;
    const existing = await Campaign.findById(campaignId);
    if (!existing) return res.status(404).json({ error: "Campaign not found" });
    if (!(await canAccessCampaign(req, existing))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }
    if (req.user.role === "manager" && existing.createdBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });

    const {
      campaignName, messageType, audienceType, tagIds, contactIds,
      groupIds, manualNumbers, templateId, scheduledDateTime,
      recurrence, variableValues: requestVariableValues, messagePreview,
    } = req.body;

    if (audienceType === "tags"    && (!tagIds        || tagIds.length === 0))   return res.status(400).json({ error: "Select at least one tag" });
    if (audienceType === "contact" && (!contactIds    || contactIds.length === 0)) return res.status(400).json({ error: "Select at least one contact" });
    if (audienceType === "group"   && (!groupIds      || groupIds.length === 0))   return res.status(400).json({ error: "Select at least one group" });
    if (audienceType === "manual"  && (!manualNumbers || manualNumbers.length === 0)) return res.status(400).json({ error: "Enter manual numbers" });
    if (audienceType === "tags" && !(await validateTagsInOrganization(req, tagIds))) {
      return res.status(403).json({ error: "Tags must belong to your organization" });
    }

    let nextRun = existing.nextRun;
    if (scheduledDateTime) {
      const scheduledDate = new Date(scheduledDateTime);
      if (!isNaN(scheduledDate.getTime())) nextRun = scheduledDate;
    }

    let finalVariableValues = requestVariableValues || existing.variableValues || {};
    if (templateId) {
      const Template = require("../models/Template");
      const template = await Template.findById(templateId).lean();
      if (!template || !(await canAccessTemplate(req, template))) {
        return res.status(403).json({ error: "Template belongs to another organization" });
      }
      if (template?.variables) {
        for (const [key, varDef] of Object.entries(template.variables)) {
          if (!finalVariableValues[key]) finalVariableValues[key] = { type: varDef.type, value: varDef.value || "" };
          else finalVariableValues[key].type = varDef.type;
        }
      }
    }

    const approvalStatus = req.user.role === "manager" ? "pending_approval" : existing.approvalStatus;

    const updated = await Campaign.findByIdAndUpdate(
      campaignId,
      {
        campaignName: campaignName || existing.campaignName,
        messageType:  messageType  || existing.messageType,
        audienceType: audienceType || existing.audienceType,
        tagIds:       tagIds       || existing.tagIds,
        contactIds:   contactIds   || existing.contactIds,
        groupIds:     groupIds     || existing.groupIds,
        manualNumbers: manualNumbers || existing.manualNumbers,
        templateId:   templateId   || existing.templateId,
        scheduledDateTime: nextRun,
        recurrence:   recurrence   || existing.recurrence || { type: "one-time" },
        variableValues: finalVariableValues,
        messagePreview: messagePreview || existing.messagePreview,
        approvalStatus,
        organization: existing.organization || req.user.organization || null,
        status: req.user.role === "manager" ? "draft" : existing.status,
        nextRun,
      },
      { new: true }
    ).populate("createdBy", "name phone role");

    // ✅ Notify admins when manager re-submits
    if (approvalStatus === "pending_approval") {
      const manager = await User.findById(req.user.id).select("name").lean();
      const managerName = manager?.name || "A manager";
      await notifyAdmins({
        type: "campaign_approval_requested",
        message: `${managerName} re-submitted an updated campaign for approval: "${updated.campaignName}"`,
        campaignId: updated._id,
        organization: req.user.organization,
      });
    }

    res.json({ success: true, campaign: updated, pendingApproval: approvalStatus === "pending_approval" });
  } catch (error) {
    console.error("Campaign update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE CAMPAIGN
router.delete("/campaigns/:id", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (!(await canAccessCampaign(req, campaign))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }
    if (req.user.role === "manager" && campaign.createdBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    await Campaign.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Campaign deleted" });
  } catch (error) {
    console.error("Delete campaign error:", error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATE STATUS
router.patch("/campaigns/:id/status", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["active", "paused", "scheduled", "sent", "cancelled"];
    if (!status || !validStatuses.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (!(await canAccessCampaign(req, campaign))) {
      return res.status(403).json({ error: "Not authorized for this organization" });
    }
    if (req.user.role === "manager" && campaign.createdBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    campaign.status = status;
    if ((status === "scheduled" || status === "active") && campaign.recurrence?.type !== "one-time" && (!campaign.nextRun || new Date(campaign.nextRun) < new Date()))
      campaign.nextRun = computeNextRun(campaign.recurrence, new Date());
    await campaign.save();
    res.json({ success: true, campaign });
  } catch (error) {
    console.error("Update campaign status error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

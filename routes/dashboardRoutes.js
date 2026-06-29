const express = require("express");
const router = express.Router();

const Campaign = require("../models/Campaign");
const Chat = require("../models/chat");
const Contact = require("../models/Contact");
const HRBank = require("../models/HRBank");
const HRDepartment = require("../models/HRDepartment");
const HRLoan = require("../models/HRLoan");
const HRPayroll = require("../models/HRPayroll");
const HRStaff = require("../models/HRStaff");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const Organization = require("../models/Organization");
const Task = require("../models/Task");
const Template = require("../models/Template");
const User = require("../models/Users");

const fullDashboardRoles = ["super_to_super_admin", "super_admin", "manager"];
const money = (value) => Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
const hasFullDashboardAccess = (role) => fullDashboardRoles.includes(role);

const organizationUserIds = async (organization) => {
  if (!organization) return [];
  const users = await User.find({ organization }).select("_id").lean();
  return users.map((user) => user._id);
};

const orgOwnedScope = (organization, orgUserIds) => ({
  $or: [
    { organization },
    { organization: null, createdBy: { $in: orgUserIds } },
  ],
});

const scopedUserFilter = (req) => {
  if (req.user.role === "super_to_super_admin") return {};
  if (!hasFullDashboardAccess(req.user.role)) return { _id: req.user.id };
  if (req.user.organization) return { organization: req.user.organization };
  return { createdBy: req.user.id };
};

const scopedCreatedFilter = async (req, filter = {}) => {
  if (req.user.role === "super_to_super_admin") return filter;
  if (!hasFullDashboardAccess(req.user.role)) return { $and: [{ createdBy: req.user.id }, filter] };
  if (!req.user.organization) return { $and: [{ createdBy: req.user.id }, filter] };
  const orgUserIds = await organizationUserIds(req.user.organization);
  return { $and: [orgOwnedScope(req.user.organization, orgUserIds), filter] };
};

const scopedTaskFilter = async (req, filter = {}) => {
  if (req.user.role === "super_to_super_admin") return filter;

  if (req.user.role === "super_admin" && req.user.organization) {
    const orgUserIds = await organizationUserIds(req.user.organization);
    return {
      $and: [
        {
          $or: [
            { createdBy: { $in: orgUserIds } },
            { assignedTo: { $in: orgUserIds } },
          ],
        },
        filter,
      ],
    };
  }

  if (req.user.role === "manager") {
    return { $and: [{ $or: [{ createdBy: req.user.id }, { assignedTo: req.user.id }] }, filter] };
  }

  return { $and: [{ assignedTo: req.user.id }, filter] };
};

const scopedHrFilter = async (req, filter = {}) => {
  if (req.user.role === "super_to_super_admin") return filter;
  if (!hasFullDashboardAccess(req.user.role)) return { $and: [{ createdBy: req.user.id }, filter] };
  if (!req.user.organization) return { $and: [{ createdBy: req.user.id }, filter] };
  const orgUserIds = await organizationUserIds(req.user.organization);
  return { $and: [orgOwnedScope(req.user.organization, orgUserIds), filter] };
};

const scopedStaffFilter = async (req, filter = {}) => {
  if (hasFullDashboardAccess(req.user.role)) return scopedHrFilter(req, filter);

  const selfFilters = [{ createdBy: req.user.id }];
  if (req.user.email) selfFilters.push({ email: req.user.email });
  if (req.user.phone) selfFilters.push({ phone: req.user.phone });

  return { $and: [{ $or: selfFilters }, filter] };
};

const scopedStaffLinkedFilter = async (req, field, filter = {}) => {
  if (hasFullDashboardAccess(req.user.role)) return scopedCreatorFilter(req, field, filter);

  const staffScope = await scopedStaffFilter(req);
  const staffIds = (await HRStaff.find(staffScope).select("_id").lean()).map((staff) => staff._id);
  if (!staffIds.length) return { _id: null };

  return { $and: [{ staff: { $in: staffIds } }, filter] };
};

const scopedCreatorFilter = async (req, field, filter = {}) => {
  if (req.user.role === "super_to_super_admin") return filter;
  if (!hasFullDashboardAccess(req.user.role)) return { $and: [{ [field]: req.user.id }, filter] };
  if (!req.user.organization) return { $and: [{ [field]: req.user.id }, filter] };
  const orgUserIds = await organizationUserIds(req.user.organization);
  return { $and: [{ [field]: { $in: orgUserIds } }, filter] };
};

const addActivity = (items, type, title, description, date, href) => {
  if (!date) return;
  items.push({
    type,
    title,
    description,
    date,
    href,
  });
};

const taskActivityTypes = [
  "task_assigned",
  "response_received",
  "approval_requested",
  "task_approved",
  "task_rejected",
];

const taskActivityMeta = {
  task_assigned: { type: "task", title: "Task assigned" },
  response_received: { type: "message", title: "Task reply received" },
  approval_requested: { type: "task", title: "Task approval requested" },
  task_approved: { type: "task", title: "Task approved" },
  task_rejected: { type: "task", title: "Task rejected" },
};

router.get("/summary", async (req, res) => {
  try {
    const now = new Date();
    const [taskScope, approvedTaskScope, templateScope, campaignScope, contactScope, staffScope, departmentScope, bankScope, loanScope, payrollScope] = await Promise.all([
      scopedTaskFilter(req),
      scopedTaskFilter(req, { approvalStatus: "approved" }),
      scopedCreatedFilter(req),
      scopedCreatedFilter(req),
      scopedCreatedFilter(req),
      scopedStaffFilter(req, { status: "active" }),
      scopedHrFilter(req),
      scopedCreatorFilter(req, "createdBy"),
      scopedStaffLinkedFilter(req, "createdBy", { category: "advance", status: "active", outstanding: { $gt: 0 } }),
      scopedStaffLinkedFilter(req, "generatedBy", { status: { $in: ["draft", "partial"] } }),
    ]);

    const userFilter = scopedUserFilter(req);
    const activeTemplateScope = { $and: [templateScope, { approvalStatus: "approved" }] };
    const activeCampaignScope = { $and: [campaignScope, { status: { $in: ["scheduled", "active", "processing"] } }] };
    const openTaskScope = { $and: [approvedTaskScope, { status: { $in: ["pending", "in_progress"] } }] };
    const overdueTaskScope = { $and: [approvedTaskScope, { status: { $ne: "completed" }, dueDate: { $lt: now } }] };
    const chatScope = req.user.role === "super_to_super_admin"
      ? {}
      : req.user.phone
        ? { participants: req.user.phone }
        : { _id: null };
    const messageScope = req.user.role === "super_to_super_admin"
      ? { isDeleted: { $ne: true } }
      : req.user.phone
        ? { sender: req.user.phone, isDeleted: { $ne: true } }
        : { _id: null };

    const [
      userCount,
      contactCount,
      taskCount,
      openTaskCount,
      pendingTaskCount,
      inProgressTaskCount,
      completedTaskCount,
      overdueTaskCount,
      templateCount,
      campaignCount,
      activeCampaignCount,
      chatCount,
      messageCount,
      organizationCount,
      staffCount,
      departmentCount,
      banks,
      activeLoans,
      unpaidPayrolls,
      recentTaskNotifications,
      recentAssignedTasks,
    ] = await Promise.all([
      User.countDocuments(userFilter),
      Contact.countDocuments(contactScope),
      Task.countDocuments(taskScope),
      Task.countDocuments(openTaskScope),
      Task.countDocuments({ $and: [approvedTaskScope, { status: "pending" }] }),
      Task.countDocuments({ $and: [approvedTaskScope, { status: "in_progress" }] }),
      Task.countDocuments({ $and: [approvedTaskScope, { status: "completed" }] }),
      Task.countDocuments(overdueTaskScope),
      Template.countDocuments(activeTemplateScope),
      Campaign.countDocuments(campaignScope),
      Campaign.countDocuments(activeCampaignScope),
      Chat.countDocuments(chatScope),
      Message.countDocuments(messageScope),
      req.user.role === "super_to_super_admin" ? Organization.countDocuments() : Promise.resolve(0),
      HRStaff.countDocuments(staffScope),
      HRDepartment.countDocuments(departmentScope),
      HRBank.find(bankScope).select("balance").lean(),
      HRLoan.find(loanScope).select("outstanding").lean(),
      HRPayroll.find(payrollScope).select("balanceDue netPay").lean(),
      Notification.find({ userId: req.user.id, type: { $in: taskActivityTypes } })
        .select("type message taskId createdAt")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Task.find({ $and: [taskScope, { assignedTo: req.user.id }] })
        .select("title createdAt")
        .sort({ createdAt: -1 })
        .limit(4)
        .lean(),
    ]);

    const bankBalance = money(banks.reduce((sum, bank) => sum + Number(bank.balance || 0), 0));
    const loanOutstanding = money(activeLoans.reduce((sum, loan) => sum + Number(loan.outstanding || 0), 0));
    const salaryDues = money(unpaidPayrolls.reduce((sum, payroll) => sum + Number(payroll.balanceDue ?? payroll.netPay ?? 0), 0));
    const activities = [];
    const recentCampaigns = [];
    const recentContacts = [];
    const recentMessages = [];

    recentTaskNotifications.forEach((notification) => {
      const meta = taskActivityMeta[notification.type] || { type: "task", title: "Task activity" };
      addActivity(
        activities,
        meta.type,
        meta.title,
        notification.message || "Task activity",
        notification.createdAt,
        notification.taskId ? `/task?taskId=${notification.taskId}` : "/task"
      );
    });

    recentAssignedTasks.forEach((task) => addActivity(
      activities,
      "task",
      "Task assigned",
      task.title || "A task was assigned",
      task.createdAt,
      "/task"
    ));
    recentCampaigns.forEach((campaign) => addActivity(
      activities,
      "campaign",
      campaign.campaignName || "Campaign updated",
      `${campaign.status || "updated"}${campaign.sentCount ? ` • ${campaign.sentCount} sent` : ""}`,
      campaign.updatedAt || campaign.createdAt,
      "/Campaigns"
    ));
    recentContacts.forEach((contact) => addActivity(
      activities,
      "contact",
      contact.name || contact.mobile || "Contact added",
      contact.mobile ? `Contact ${contact.mobile}` : "Contact added",
      contact.createdAt || contact.updatedAt,
      "/contacts"
    ));
    recentMessages.forEach((message) => addActivity(
      activities,
      "message",
      message.messageType === "text" ? (message.text || "Message sent") : `${message.messageType} message`,
      message.sender ? `From ${message.sender}` : "Chat activity",
      message.createdAt,
      "/live-chat"
    ));

    activities.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const organizationProfile = req.user.organization
      ? await Organization.findById(req.user.organization).select("name logoUrl").lean()
      : null;

    res.json({
      success: true,
      data: {
        user: {
          name: req.user.name || "",
          email: req.user.email || "",
          phone: req.user.phone || "",
          role: req.user.role || "",
          allowedModules: req.user.allowedModules || [],
          organization: organizationProfile
            ? {
                id: organizationProfile._id,
                name: organizationProfile.name || "",
                logoUrl: organizationProfile.logoUrl || "",
              }
            : null,
        },
        metrics: {
          users: userCount,
          contacts: contactCount,
          tasks: taskCount,
          openTasks: openTaskCount,
          templates: templateCount,
          campaigns: campaignCount,
          activeCampaigns: activeCampaignCount,
          chats: chatCount,
          messages: messageCount,
          organizations: organizationCount,
          activeStaff: staffCount,
          departments: departmentCount,
          bankBalance,
          loanOutstanding,
          salaryDues,
        },
        taskStatus: {
          pending: pendingTaskCount,
          inProgress: inProgressTaskCount,
          completed: completedTaskCount,
          overdue: overdueTaskCount,
        },
        recentActivity: activities.slice(0, 6),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not load dashboard." });
  }
});

module.exports = router;

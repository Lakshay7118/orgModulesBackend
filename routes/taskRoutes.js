const express = require("express");
const router = express.Router();
const Task = require("../models/Task");
const Notification = require("../models/Notification");
const User = require("../models/Users");
const { getIO } = require("../sockets/socket");
const UserTaskStatus = require("../models/UserTaskStatus");
const TaskResponseSeen = require("../models/TaskResponseSeen");
const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");

const TOP_ADMIN_ROLES = ["super_to_super_admin", "super_admin"];
const isTopAdmin = (role) => TOP_ADMIN_ROLES.includes(role);
const sameId = (left, right) => left && right && left.toString() === right.toString();

const TASK_UPDATE_FIELDS = [
  "title", "description", "dueDate", "reminderAt", "reminders", "priority",
  "attachments", "inputFields", "dropdownButtons", "quickReplies",
  "ctaButtons", "checkboxes", "assignedTo", "isPersonal",
];

const pickTaskUpdates = (body) => {
  const updates = {};
  TASK_UPDATE_FIELDS.forEach((field) => {
    if (body[field] !== undefined) updates[field] = body[field];
  });
  if (updates.reminders !== undefined || updates.reminderAt !== undefined) {
    const reminderData = normalizeReminders(updates.reminders, updates.reminderAt);
    updates.reminders = reminderData.reminders;
    updates.reminderAt = reminderData.reminderAt;
  }
  return updates;
};

const normalizeReminders = (reminders, reminderAt) => {
  const raw = Array.isArray(reminders) ? reminders : (reminderAt ? [reminderAt] : []);
  const seen = new Set();
  const normalized = raw
    .map((item) => {
      const value = item?.remindAt || item;
      const date = value ? new Date(value) : null;
      if (!date || Number.isNaN(date.getTime())) return null;
      const key = date.toISOString();
      if (seen.has(key)) return null;
      seen.add(key);
      return { remindAt: date, sentAt: item?.sentAt || null };
    })
    .filter(Boolean)
    .sort((a, b) => a.remindAt - b.remindAt);
  const now = new Date();
  const next = normalized.find((reminder) => !reminder.sentAt && reminder.remindAt > now);
  return { reminders: normalized, reminderAt: next?.remindAt || normalized[0]?.remindAt || null };
};

const organizationUserIds = async (organization) => {
  if (!organization) return [];
  const users = await User.find({ organization }).select("_id").lean();
  return users.map((user) => user._id);
};

const taskOrganizationScope = async (req) => {
  if (req.user.role === "super_to_super_admin") return {};
  if (!req.user.organization) return { createdBy: req.user.id };
  const orgUsers = await organizationUserIds(req.user.organization);
  return {
    $or: [
      { organization: req.user.organization },
      { organization: null, createdBy: { $in: orgUsers } },
    ],
  };
};

const andFilters = (...filters) => {
  const active = filters.filter((filter) => filter && Object.keys(filter).length > 0);
  if (active.length === 0) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
};

const canAccessTaskOrganization = async (req, task) => {
  if (!task) return false;
  if (req.user.role === "super_to_super_admin") return true;
  if (sameId(task.organization, req.user.organization)) return true;
  if (!task.organization && task.createdBy) {
    const creatorId = task.createdBy._id || task.createdBy;
    const creator = await User.findById(creatorId).select("organization").lean();
    return sameId(creator?.organization, req.user.organization);
  }
  return false;
};

const ensureTaskOrganizationAccess = async (req, task, res) => {
  const allowed = await canAccessTaskOrganization(req, task);
  if (!allowed) {
    res.status(404).json({ error: "Task not found" });
    return false;
  }
  return true;
};

const sameOrganizationAdmins = async (req) => {
  if (req.user.role === "super_to_super_admin") {
    return User.find({ role: { $in: TOP_ADMIN_ROLES } }).select("_id").lean();
  }
  if (!req.user.organization) return [];
  return User.find({ role: "super_admin", organization: req.user.organization }).select("_id").lean();
};

const validateAssignedUsersInOrganization = async (req, assignedUserIds = []) => {
  if (req.user.role === "super_to_super_admin" || assignedUserIds.length === 0) return true;
  if (!req.user.organization) return assignedUserIds.every((id) => id.toString() === req.user.id);
  const count = await User.countDocuments({
    _id: { $in: assignedUserIds },
    organization: req.user.organization,
  });
  return count === new Set(assignedUserIds.map((id) => id.toString())).size;
};

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

const broadcastTaskAssignmentChanges = async (task, previousAssigneeIds, io) => {
  const newAssigneeIds = task.assignedTo.map((user) => user._id.toString());
  const removedAssigneeIds = previousAssigneeIds.filter((uid) => !newAssigneeIds.includes(uid));
  const addedAssignees = task.assignedTo.filter((user) => !previousAssigneeIds.includes(user._id.toString()));

  removedAssigneeIds.forEach((uid) => {
    io.to(uid).emit("taskDeleted", { taskId: task._id });
  });

  if (removedAssigneeIds.length > 0) {
    await UserTaskStatus.deleteMany({
      taskId: task._id,
      userId: { $in: removedAssigneeIds },
    });
    await TaskResponseSeen.deleteMany({
      taskId: task._id,
      userId: { $in: removedAssigneeIds },
    });
  }

  [...new Set([task.createdBy._id.toString(), ...newAssigneeIds])].forEach((uid) => {
    io.to(uid).emit("taskUpdated", task);
  });

  for (const user of addedAssignees) {
    const notif = await Notification.create({
      userId: user._id,
      type: "task_assigned",
      message: `New task assigned: ${task.title}`,
      taskId: task._id,
      organization: task.organization || null,
    });
    io.to(user._id.toString()).emit("newNotification", notif);
  }
};

// =======================
// ✅ GET ALL USERS (for assign dropdown)
// =======================
router.get("/users", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const query = req.user.role === "super_to_super_admin"
      ? {}
      : { organization: req.user.organization };
    const users = await User.find(query).select("name phone role organization").lean();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ GET TASKS (filtered by role)
// =======================
router.get("/", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let roleFilter = {};

    if (isTopAdmin(userRole)) {
      roleFilter = {};
    } else if (userRole === "manager") {
      roleFilter = {
        $or: [{ createdBy: userId }, { assignedTo: userId }],
      };
    } else {
      roleFilter = { assignedTo: userId };
    }
    const filter = andFilters(await taskOrganizationScope(req), roleFilter);

    const tasks = await Task.find(filter)
      .populate("createdBy", "name phone role")
      .populate("assignedTo", "name phone role")
      .populate("responses.userId", "name phone role")
      .populate("pendingUpdate.requestedBy", "name phone role")
      .sort({ createdAt: -1 });

    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ CREATE TASK
// — super_admin: creates approved immediately
// — manager + personal: creates approved immediately
// — manager + assigned to others: creates with approvalStatus "pending"
// — user: personal tasks only, always approved
// =======================
router.post("/", protect, allowRoles("super_admin", "manager", "user"), async (req, res) => {
  try {
    const {
      title,
      description,
      assignedTo,
      dueDate,
      reminderAt,
      reminders,
      priority,
      attachments,
      isPersonal,
      inputFields,
      dropdownButtons,
      quickReplies,
      ctaButtons,
      checkboxes,
      approvalStatus, // sent by frontend — "pending" or "approved"
    } = req.body;

    if (!title || !dueDate) {
      return res.status(400).json({ error: "Title and dueDate are required" });
    }

    const userRole = req.user.role;

    // ── Role-based assignment rules ──────────────────────────────
    // Users can only create personal tasks
    if (userRole === "user" && !isPersonal) {
      return res.status(403).json({ error: "Users can only create personal tasks" });
    }

    let assignedUserIds = assignedTo || [];
    if (isPersonal) {
      // Personal task → assigned only to creator, always approved
      assignedUserIds = [req.user.id];
    }
    if (!(await validateAssignedUsersInOrganization(req, assignedUserIds))) {
      return res.status(403).json({ error: "Assigned users must belong to your organization" });
    }

    // ── Determine approval status ────────────────────────────────
    // Admin tasks are always approved.
    // Manager personal tasks are always approved.
    // Manager tasks assigned to others → pending (frontend sends "pending").
    // User personal tasks are always approved.
    let resolvedApprovalStatus = "approved";
    if (
      userRole === "manager" &&
      !isPersonal &&
      assignedUserIds.length > 0
    ) {
      resolvedApprovalStatus = "pending";
    }
    // Allow frontend to explicitly override only toward "pending" (not approved)
    // so a manager can't self-approve by sending "approved" in the body.
    if (approvalStatus === "pending" && userRole === "manager") {
      resolvedApprovalStatus = "pending";
    }

    const reminderData = normalizeReminders(reminders, reminderAt);

    const task = new Task({
      title,
      description,
      createdBy: req.user.id,
      organization: req.user.organization || null,
      assignedTo: assignedUserIds,
      isPersonal: isPersonal || false,
      dueDate,
      reminderAt: reminderData.reminderAt,
      reminders: reminderData.reminders,
      priority: priority || "medium",
      attachments: attachments || [],
      inputFields: inputFields || [],
      dropdownButtons: dropdownButtons || [],
      quickReplies: quickReplies || [],
      ctaButtons: ctaButtons || [],
      checkboxes: checkboxes || [],
      approvalStatus: resolvedApprovalStatus, // ✅ NEW field on Task model
    });

    await task.save();
    await task.populate("createdBy", "name phone role");
    await task.populate("assignedTo", "name phone role");

    const io = getIO();

    if (resolvedApprovalStatus === "approved") {
      // Notify assigned users only if task is live
      for (const uid of assignedUserIds) {
        // Skip notifying the creator if they assigned to themselves (personal)
        if (uid.toString() === req.user.id && isPersonal) continue;

        const notif = await Notification.create({
          userId: uid,
          type: "task_assigned",
          message: `New task assigned: ${task.title}`,
          taskId: task._id,
          organization: task.organization || null,
        });
        io.to(uid.toString()).emit("newNotification", notif);
        io.to(uid.toString()).emit("newTask", task);
      }
    } else {
      // Notify all admins that a task is pending their approval
      const admins = await sameOrganizationAdmins(req);
      for (const admin of admins) {
        const creator = await User.findById(req.user.id).select("name").lean();
        const notif = await Notification.create({
          userId: admin._id,
          type: "approval_requested",
          message: `${creator.name} submitted a task for approval: "${task.title}"`,

          taskId: task._id,
          organization: task.organization || req.user.organization || null,
        });
        io.to(admin._id.toString()).emit("newNotification", notif);
        io.to(admin._id.toString()).emit("newTask", task);
      }
    }

    res.status(201).json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ APPROVE / REJECT TASK (super_admin only)
// PATCH /:id/approve  { approvalStatus: "approved" | "rejected" }
// =======================
router.patch("/:id/approve", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const { approvalStatus } = req.body;

    if (!["approved", "rejected"].includes(approvalStatus)) {
      return res.status(400).json({ error: "approvalStatus must be 'approved' or 'rejected'" });
    }

    const task = await Task.findById(req.params.id)
      .populate("createdBy", "name phone role")
      .populate("assignedTo", "name phone role")
      .populate("responses.userId", "name phone role")
      .populate("pendingUpdate.requestedBy", "name phone role");

    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await ensureTaskOrganizationAccess(req, task, res))) return;
    if (task.approvalStatus !== "pending") {
      return res.status(400).json({ error: "Task is not pending approval" });
    }

    const isUpdateRequest = !!task.pendingUpdate?.changes;

    if (approvalStatus === "rejected" && isUpdateRequest) {
      const io = getIO();
      const requesterId = task.pendingUpdate.requestedBy || task.createdBy._id;

      task.pendingUpdate = { requestedBy: null, changes: null, requestedAt: null };
      task.approvalStatus = "approved";
      await task.save();

      const populatedTask = await Task.findById(task._id)
        .populate("createdBy", "name phone role")
        .populate("assignedTo", "name phone role")
        .populate("responses.userId", "name phone role")
        .populate("pendingUpdate.requestedBy", "name phone role");

      const notif = await Notification.create({
        userId: requesterId,
        type: "task_rejected",
        message: `Your edit request for "${task.title}" was rejected by admin`,
        taskId: task._id,
        organization: task.organization || req.user.organization || null,
      });
      io.to(requesterId.toString()).emit("newNotification", notif);
      io.to(requesterId.toString()).emit("taskUpdated", populatedTask);

      return res.json({ success: true, data: populatedTask, message: "Task edit rejected" });
    }

    if (approvalStatus === "rejected") {
      // Delete the task and notify the manager who created it
      const io = getIO();
      const notif = await Notification.create({
        userId: task.createdBy._id,
        type: "task_rejected",
        message: `Your task "${task.title}" was rejected by admin`,
        taskId: task._id,
        organization: task.organization || req.user.organization || null,
      });
      io.to(task.createdBy._id.toString()).emit("newNotification", notif);
      io.to(task.createdBy._id.toString()).emit("taskDeleted", { taskId: task._id });

      await Notification.deleteMany({ taskId: task._id });
      await Task.findByIdAndDelete(task._id);

      return res.json({ success: true, message: "Task rejected and deleted" });
    }

    // ── Approved ─────────────────────────────────────────────────
    const previousAssigneeIds = task.assignedTo.map((id) => id.toString());
    if (isUpdateRequest) {
      if (task.pendingUpdate.changes?.assignedTo && !(await validateAssignedUsersInOrganization(req, task.pendingUpdate.changes.assignedTo))) {
        return res.status(403).json({ error: "Assigned users must belong to your organization" });
      }
      Object.assign(task, task.pendingUpdate.changes);
      task.pendingUpdate = { requestedBy: null, changes: null, requestedAt: null };
    }
    task.approvalStatus = "approved";
    await task.save();

    const populatedTask = await Task.findById(task._id)
      .populate("createdBy", "name phone role")
      .populate("assignedTo", "name phone role")
      .populate("responses.userId", "name phone role")
      .populate("pendingUpdate.requestedBy", "name phone role");

    const io = getIO();

    // Notify the manager their task was approved
    const approvedNotif = await Notification.create({
      userId: task.createdBy._id,
      type: "task_approved",
      message: isUpdateRequest ? `Your edit request for "${task.title}" was approved` : `Your task "${task.title}" was approved`,
      taskId: task._id,
      organization: task.organization || req.user.organization || null,
    });
    io.to(task.createdBy._id.toString()).emit("newNotification", approvedNotif);
    io.to(task.createdBy._id.toString()).emit("taskUpdated", populatedTask);

    if (isUpdateRequest) {
      await broadcastTaskAssignmentChanges(populatedTask, previousAssigneeIds, io);
      return res.json({ success: true, data: populatedTask });
    }

    // Now notify assignees — task is live
    for (const assignee of populatedTask.assignedTo) {
      const uid = assignee._id.toString();
      // Don't notify the creator if they're also an assignee
      if (uid === task.createdBy._id.toString()) continue;

      const notif = await Notification.create({
        userId: uid,
        type: "task_assigned",
        message: `New task assigned: ${task.title}`,
        taskId: task._id,
        organization: task.organization || req.user.organization || null,
      });
      io.to(uid).emit("newNotification", notif);
      io.to(uid).emit("newTask", populatedTask);
    }

    res.json({ success: true, data: populatedTask });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ UPDATE TASK (super_admin or creator)
// =======================
router.put("/:id", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await ensureTaskOrganizationAccess(req, task, res))) return;

    const isCreator = task.createdBy.toString() === req.user.id;
    const isAdmin = isTopAdmin(req.user.role);
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const updates = pickTaskUpdates(req.body);
    if (updates.assignedTo && !(await validateAssignedUsersInOrganization(req, updates.assignedTo))) {
      return res.status(403).json({ error: "Assigned users must belong to your organization" });
    }
    const previousAssigneeIds = task.assignedTo.map((id) => id.toString());

    if (!isAdmin && task.approvalStatus === "pending" && !task.pendingUpdate?.changes) {
      Object.assign(task, updates);
      await task.save();

      const populatedTask = await Task.findById(task._id)
        .populate("createdBy", "name phone role")
        .populate("assignedTo", "name phone role")
        .populate("responses.userId", "name phone role")
        .populate("pendingUpdate.requestedBy", "name phone role");

      const io = getIO();
      const admins = await sameOrganizationAdmins(req);
      admins.forEach((admin) => {
        io.to(admin._id.toString()).emit("taskUpdated", populatedTask);
      });
      io.to(req.user.id).emit("taskUpdated", populatedTask);

      return res.json({
        success: true,
        data: populatedTask,
        pendingApproval: true,
        message: "Pending task request updated",
      });
    }

    if (!isAdmin) {
      task.pendingUpdate = {
        requestedBy: req.user.id,
        changes: updates,
        requestedAt: new Date(),
      };
      task.approvalStatus = "pending";
      await task.save();

      const populatedTask = await Task.findById(task._id)
        .populate("createdBy", "name phone role")
        .populate("assignedTo", "name phone role")
        .populate("responses.userId", "name phone role")
        .populate("pendingUpdate.requestedBy", "name phone role");

      const io = getIO();
      const admins = await sameOrganizationAdmins(req);
      const creator = await User.findById(req.user.id).select("name").lean();
      for (const admin of admins) {
        const notif = await Notification.create({
          userId: admin._id,
          type: "approval_requested",
          message: `${creator.name} submitted a task edit for approval: "${task.title}"`,
          taskId: task._id,
          organization: task.organization || req.user.organization || null,
        });
        io.to(admin._id.toString()).emit("newNotification", notif);
        io.to(admin._id.toString()).emit("taskUpdated", populatedTask);
      }
      io.to(req.user.id).emit("taskUpdated", populatedTask);

      return res.json({
        success: true,
        data: populatedTask,
        pendingApproval: true,
        message: "Task edit sent for admin approval",
      });
    }

    if (task.pendingUpdate?.changes) {
      updates.pendingUpdate = { requestedBy: null, changes: null, requestedAt: null };
      updates.approvalStatus = "approved";
    }

    const updatedTask = await Task.findByIdAndUpdate(req.params.id, updates, { new: true })
      .populate("createdBy", "name phone role")
      .populate("assignedTo", "name phone role")
      .populate("responses.userId", "name phone role")
      .populate("pendingUpdate.requestedBy", "name phone role");

    const io = getIO();
    await broadcastTaskAssignmentChanges(updatedTask, previousAssigneeIds, io);

    res.json({ success: true, data: updatedTask });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ DELETE TASK
// — super_admin: can delete any task
// — manager: can only delete their own pending tasks (rejected flow)
// =======================
router.delete("/:id", protect, allowRoles("super_admin", "manager"), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await ensureTaskOrganizationAccess(req, task, res))) return;

    const isAdmin = isTopAdmin(req.user.role);
    const isCreator = task.createdBy.toString() === req.user.id;

    // Managers can only delete their own tasks (e.g. after rejection)
    if (!isAdmin && !isCreator) {
      return res.status(403).json({ error: "Not authorized to delete this task" });
    }

    await Task.findByIdAndDelete(req.params.id);
    await Notification.deleteMany({ taskId: req.params.id });

    const io = getIO();
    [...task.assignedTo, task.createdBy].forEach((uid) => {
      if (uid) io.to(uid.toString()).emit("taskDeleted", { taskId: task._id });
    });

    res.json({ success: true, message: "Task deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ SUBMIT RESPONSE (assigned users)
// =======================
router.post("/:id/response", protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await ensureTaskOrganizationAccess(req, task, res))) return;

    const isAssignee = task.assignedTo.some((id) => id.toString() === req.user.id);
    const isCreator = task.createdBy.toString() === req.user.id;
    const isAdmin = isTopAdmin(req.user.role);
    if (!isAssignee && !isCreator && !isAdmin) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // Block responses on pending-approval tasks for non-admins
    if (task.approvalStatus === "pending" && !isAdmin) {
      return res.status(403).json({ error: "Task is pending approval — responses locked" });
    }

    const { message, formData, attachments } = req.body;

    const safeFormData = {
      inputFields: Array.isArray(formData?.inputFields) ? formData.inputFields : [],
      dropdownSelections: Array.isArray(formData?.dropdownSelections) ? formData.dropdownSelections : [],
      quickReplySelected: formData?.quickReplySelected || "",
      checkboxSelections: Array.isArray(formData?.checkboxSelections) ? formData.checkboxSelections : [],
    };

    const response = {
      userId: req.user.id,
      message: message || "",
      attachments: Array.isArray(attachments) ? attachments : [],
      formData: safeFormData,
      createdAt: new Date(),
    };

    task.responses.push(response);
    await task.save();

    const populatedTask = await Task.findById(task._id)
      .populate("createdBy", "name phone role")
      .populate("assignedTo", "name phone role")
      .populate("responses.userId", "name phone role");

    try {
       const sender = populatedTask.responses[populatedTask.responses.length - 1].userId;
    const senderName = sender?.name || "Someone";

    const io = getIO();

    const notif = await Notification.create({
      userId: task.createdBy,
      type: "response_received",
      message: `${senderName} responded to task "${task.title}"`,  // ✅ fixed
      taskId: task._id,
      organization: task.organization || req.user.organization || null,
    });
     io.to(task.createdBy.toString()).emit("newNotification", notif);
    io.to(task.createdBy.toString()).emit("taskResponse", populatedTask);


   task.assignedTo.forEach((uid) => {
      if (uid.toString() !== req.user.id) {
        io.to(uid.toString()).emit("taskUpdated", populatedTask);
      }
    });
    } catch (notifyError) {
      console.error("Task response notification error:", notifyError.message);
    }

    res.json({ success: true, data: populatedTask });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ UPDATE TASK STATUS
// — Admin: real update, broadcasted to all
// — Non-admin: 200 OK but status is NOT saved (frontend handles locally)
// =======================
// =======================
// DELETE OWN RESPONSE
// =======================
router.delete("/:id/response/:responseId", protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await ensureTaskOrganizationAccess(req, task, res))) return;

    const response = task.responses.id(req.params.responseId);
    if (!response) return res.status(404).json({ error: "Response not found" });

    if (response.userId.toString() !== req.user.id) {
      return res.status(403).json({ error: "You can only delete your own message" });
    }

    response.deleteOne();
    await task.save();

    const populatedTask = await Task.findById(task._id)
      .populate("createdBy", "name phone role")
      .populate("assignedTo", "name phone role")
      .populate("responses.userId", "name phone role");

    const io = getIO();
    const recipients = [task.createdBy.toString(), ...task.assignedTo.map((id) => id.toString())];
    [...new Set(recipients)].forEach((uid) => {
      io.to(uid).emit("taskUpdated", populatedTask);
    });

    res.json({ success: true, data: populatedTask });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// TASK RESPONSE SEEN STATE
// =======================
router.get("/response-seens", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let roleFilter = {};
    if (!isTopAdmin(userRole)) {
      roleFilter = userRole === "manager"
        ? { $or: [{ createdBy: userId }, { assignedTo: userId }] }
        : { assignedTo: userId };
    }

    const taskFilter = andFilters(await taskOrganizationScope(req), roleFilter);
    const visibleTaskIds = (await Task.find(taskFilter).select("_id").lean()).map((task) => task._id);
    const seens = await TaskResponseSeen.find({
      userId,
      taskId: { $in: visibleTaskIds },
    }).lean();

    res.json({ success: true, data: seens });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/:id/responses/seen", protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await ensureTaskOrganizationAccess(req, task, res))) return;

    const isAssignee = task.assignedTo.some((id) => id.toString() === req.user.id);
    const isCreator = task.createdBy.toString() === req.user.id;
    const isAdmin = isTopAdmin(req.user.role);
    if (!isAssignee && !isCreator && !isAdmin) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const record = await TaskResponseSeen.findOneAndUpdate(
      { userId: req.user.id, taskId: task._id },
      { seenAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({ success: true, data: record });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/:id/status", protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await ensureTaskOrganizationAccess(req, task, res))) return;

    const isAssignee = task.assignedTo.some((id) => id.toString() === req.user.id);
    const isCreator = task.createdBy.toString() === req.user.id;
    const isAdmin = isTopAdmin(req.user.role);
    if (!isAssignee && !isCreator && !isAdmin) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const { status } = req.body;
    const validStatuses = ["pending", "in_progress", "completed", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    if (isAdmin) {
      // ── Admin: persist to DB + broadcast ──────────────────────
      task.status = status;
      await task.save();

      const populatedTask = await Task.findById(task._id)
        .populate("createdBy", "name phone role")
        .populate("assignedTo", "name phone role")
        .populate("responses.userId", "name phone role");

      const io = getIO();
      const recipients = [task.createdBy.toString(), ...task.assignedTo.map((id) => id.toString())];
      recipients.forEach((uid) => {
        if (uid !== req.user.id) {
          io.to(uid).emit("taskUpdated", populatedTask);
        }
      });

      return res.json({ success: true, data: populatedTask });
    } else {
      // ── Non-admin: personal progress only — do NOT save to DB ──
      // Return the task as-is so the frontend can apply its local override.
      // The frontend (localStorage) is the source of truth for this user's status.
      const populatedTask = await Task.findById(task._id)
        .populate("createdBy", "name phone role")
        .populate("assignedTo", "name phone role")
        .populate("responses.userId", "name phone role");

      return res.json({ success: true, data: populatedTask, localOnly: true });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ GET NOTIFICATIONS
// =======================
router.get("/notifications", protect, async (req, res) => {
  try {
    const notifications = await Notification.find(notificationScope(req))
      .populate("taskId", "title")
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, data: notifications });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ MARK NOTIFICATION READ
// =======================
router.patch("/notifications/:id/read", protect, async (req, res) => {
  try {
    await Notification.findOneAndUpdate(
      notificationScope(req, { _id: req.params.id }),
      { read: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ MARK ALL NOTIFICATIONS READ
// =======================
router.patch("/notifications/read-all", protect, async (req, res) => {
  try {
    await Notification.updateMany(notificationScope(req), { read: true });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// GET all per-user statuses (for tasks the current user can see)
router.get("/user-statuses", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let roleFilter = {};
    if (!isTopAdmin(userRole)) {
      roleFilter = { assignedTo: userId };
    }
    const taskFilter = andFilters(await taskOrganizationScope(req), roleFilter);
    const visibleTaskIds = (await Task.find(taskFilter).select("_id").lean())
      .map(t => t._id.toString());
    const statusUserFilter = isTopAdmin(userRole)
      ? (req.user.role === "super_to_super_admin"
        ? { role: { $nin: TOP_ADMIN_ROLES } }
        : { role: { $nin: TOP_ADMIN_ROLES }, organization: req.user.organization })
      : { _id: userId };
    const statusUserIds = (await User.find(statusUserFilter).select("_id").lean()).map((user) => user._id);

    const statuses = await UserTaskStatus.find({
      userId: { $in: statusUserIds },
      taskId: { $in: visibleTaskIds },
    }).lean();

    res.json({ success: true, data: statuses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upsert per-user status (used by non-admins)
router.patch("/:id/user-status", protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await ensureTaskOrganizationAccess(req, task, res))) return;

    const isAssignee = task.assignedTo.some(a => a.toString() === req.user.id);
    if (!isAssignee && !isTopAdmin(req.user.role))
      return res.status(403).json({ error: "Not assigned" });

    const { status } = req.body;
    const valid = ["pending", "in_progress", "completed", "cancelled"];
    if (!valid.includes(status))
      return res.status(400).json({ error: "Invalid status" });

    const record = await UserTaskStatus.findOneAndUpdate(
      { userId: req.user.id, taskId: task._id },
      { status },
      { upsert: true, new: true }
    );

    // For personal progress, also notify the task creator? optional.

    res.json({ success: true, data: record });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



module.exports = router;

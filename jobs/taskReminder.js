const cron = require("node-cron");
const Task = require("../models/Task");
const Notification = require("../models/Notification");
const { getIO } = require("../sockets/socket");

async function sendReminders() {
  const now = new Date();
  const tasks = await Task.find({
    $or: [
      { reminderAt: { $lte: now } },
      { reminders: { $elemMatch: { remindAt: { $lte: now }, sentAt: null } } },
    ],
    status: { $nin: ["completed", "cancelled"] },
  })
    .populate("createdBy", "_id")
    .populate("assignedTo", "_id");

  if (tasks.length === 0) return;

  const io = getIO();

  for (const task of tasks) {
    const dueReminders = Array.isArray(task.reminders)
      ? task.reminders.filter((reminder) => reminder.remindAt && !reminder.sentAt && reminder.remindAt <= now)
      : [];
    const shouldSendLegacyReminder = task.reminderAt && task.reminderAt <= now && dueReminders.length === 0;

    if (dueReminders.length > 0 || shouldSendLegacyReminder) {
      const recipientIds = [
        task.createdBy?._id,
        ...(task.assignedTo || []).map((user) => user?._id),
      ].filter(Boolean);

      for (const userId of [...new Set(recipientIds.map((id) => id.toString()))]) {
        const notif = await Notification.create({
          userId,
          type: "task_reminder",
          message: `Reminder: Task "${task.title}" is due soon.`,
          taskId: task._id,
          organization: task.organization || null,
        });
        io.to(userId).emit("newNotification", notif);
        io.to(userId).emit("taskReminder", {
          taskId: task._id,
          title: task.title,
          dueDate: task.dueDate,
        });
      }
    }

    if (dueReminders.length > 0) {
      task.reminders = task.reminders.map((reminder) => {
        if (reminder.remindAt && !reminder.sentAt && reminder.remindAt <= now) {
          reminder.sentAt = now;
        }
        return reminder;
      });
    }

    const nextReminder = (task.reminders || [])
      .filter((reminder) => reminder.remindAt && !reminder.sentAt && reminder.remindAt > now)
      .sort((a, b) => a.remindAt - b.remindAt)[0];

    task.reminderAt = nextReminder?.remindAt || null;
    await task.save();
  }
}

cron.schedule("* * * * *", () => {
  sendReminders().catch(console.error);
});

module.exports = { sendReminders };

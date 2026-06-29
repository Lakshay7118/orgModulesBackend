const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: [
        // Task
        "task_assigned", "response_received", "task_reminder",
        "status_changed", "approval_requested", "task_approved", "task_rejected",
        // Template
        "template_approval_requested", "template_approved", "template_rejected",
        // Campaign
        "campaign_approval_requested", "campaign_approved", "campaign_rejected",
        // Contact
        "contact_approval_requested", "contact_approved", "contact_rejected",
        // Settings
        "profile_approval_requested", "profile_approved", "profile_rejected",
        "support_ticket_created", "support_ticket_replied",
      ],
      required: true,
    },
    message:    { type: String, required: true },
    taskId:     { type: mongoose.Schema.Types.ObjectId, ref: "Task",     default: null },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null },
    contactId:  { type: mongoose.Schema.Types.ObjectId, ref: "Contact",  default: null },
    read:       { type: Boolean, default: false },
  },
  { timestamps: true }
);

NotificationSchema.pre("validate", async function assignRecipientOrganization(next) {
  try {
    if (!this.organization && this.userId) {
      const User = require("./Users");
      const user = await User.findById(this.userId).select("organization").lean();
      this.organization = user?.organization || null;
    }
    next();
  } catch (error) {
    next(error);
  }
});

NotificationSchema.index({ userId: 1, organization: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);

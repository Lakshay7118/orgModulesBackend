const mongoose = require("mongoose");
const CampaignSchema = new mongoose.Schema(
  {
    campaignName: { type: String, required: true, trim: true },
    launchKey: { type: String, default: null },

    messageType: {
      type: String,
      enum: ["Pre-approved template message", "Custom message"],
      default: "Pre-approved template message",
    },

    audienceType: {
      type: String,
      enum: ["tags", "contact", "group", "manual"],
      required: true,
      default: "tags",
    },

    tagIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Tag" }],
    contactIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Contact" }],
    groupIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Chat" }],
    manualNumbers: [{ type: String, trim: true }],

    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Template",
      default: null,
    },

    scheduledDateTime: { type: Date },

    recurrence: {
      type: {
        type: String,
        enum: ["one-time", "daily", "weekly", "monthly", "hourly"],
        default: "one-time",
      },
      interval: { type: Number, default: 1 },
      dayOfWeek: { type: Number, min: 0, max: 6 },
      dayOfMonth: { type: Number, min: 1, max: 31 },
      hour: { type: Number, min: 0, max: 23 },
    },

    variableValues: { type: Object, default: {} },

    messagePreview: { type: String, default: "" },

    status: {
      type: String,
      enum: [
        "draft",
        "scheduled",
        "active",
        "paused",
        "processing",
        "sent",
        "completed",
        "failed",
        "cancelled",
      ],
      default: "scheduled",
    },

    approvalStatus: {
      type: String,
      enum: ["pending_approval", "approved", "rejected"],
      default: "approved",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    nextRun: { type: Date },
    sentCount: { type: Number, default: 0 },
    processingStartedAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },

    // ✅ ADD THESE TWO:
    runCount:      { type: Number, default: 0 },   // how many times this recurring campaign has fired
    lastSentCount: { type: Number, default: 0 },   // sent count of the most recent run

    errorLog: { type: String, default: "" },
  },
  { timestamps: true }
);

CampaignSchema.index(
  { createdBy: 1, launchKey: 1 },
  { partialFilterExpression: { launchKey: { $type: "string" } } }
);
CampaignSchema.index({ status: 1, approvalStatus: 1, nextRun: 1 });

module.exports = mongoose.model("Campaign", CampaignSchema);

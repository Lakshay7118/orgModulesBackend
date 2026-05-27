const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
    },

    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },

    deletedBy: [{ type: String, default: [] }],

    sender: {
      type: String,
      required: true,
    },

    clientTempId: { type: String, default: null },

    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
    },
    campaignRunKey: { type: String, default: null },
    recipientPhone: { type: String, default: null },
    campaignDeliveryKey: { type: String, default: null },

    messageType: {
      type: String,
      enum: ["text", "image", "video", "audio", "file", "template", "contact", "call"],
      default: "text",
    },

    text: { type: String, default: "" },

    status: {
      type: String,
      enum: ["sent", "delivered", "seen"],
      default: "sent",
    },
contactName:  { type: String, default: null },
contactPhone: { type: String, default: null },
contactEmail: { type: String, default: null },
callStatus: {
  type: String,
  enum: ["ended", "missed", "rejected", "busy", "cancelled", "failed", null],
  default: null,
},
callDuration: { type: Number, default: 0 },
callType: { type: String, enum: ["audio", "video", null], default: null },

fileUrl:  { type: String, default: null },
    fileType: {
      type: String,
      enum: ["image", "video", "audio", "file", null],
      default: null,
    },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: null },

    deliveredAt: { type: Date },
    seenAt:      { type: Date },

    readBy: [
      {
        user:   { type: String },
        readAt: { type: Date, default: Date.now },
      },
    ],

    templateMeta: {
      // ── Identity ──────────────────────────────
      templateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Template",
        default: null,
      },

      // ── Display fields ────────────────────────
      header:       { type: String, default: "" },
      body:         { type: String, default: "" },
      footer:       { type: String, default: "" },
      resolvedText: { type: String, default: null },

      // ── Media ─────────────────────────────────
      mediaType: { type: String, default: "None" },
      mediaUrl:  { type: String, default: null },

      // ── Variables map  e.g. { "1": { type: "name" }, "2": { type: "number" } }
      variables: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },

      // ── Interactive actions ───────────────────
      actions: {
        ctaButtons: {
          type: mongoose.Schema.Types.Mixed,
          default: [],
        },
        quickReplies: {
          type: mongoose.Schema.Types.Mixed,
          default: [],
        },
        copyCodeButtons: {
          type: mongoose.Schema.Types.Mixed,
          default: [],
        },
        dropdownButtons: {
          type: mongoose.Schema.Types.Mixed,
          default: [],
        },
        inputFields: {
          type: mongoose.Schema.Types.Mixed,
          default: [],
        },
      },

      // ── Carousel items ────────────────────────
      carouselItems: {
        type: mongoose.Schema.Types.Mixed,
        default: [],
      },

      // ── Legacy structured fields (keep for back-compat) ──
      fields: [
        {
          label:   { type: String },
          type:    { type: String },
          options: [{ type: String }],
        },
      ],
    },
  },
  {
    timestamps: true,
    strict: true, // Mongoose default — explicit here for clarity
  }
);

MessageSchema.index(
  { campaignDeliveryKey: 1 },
  {
    unique: true,
    partialFilterExpression: { campaignDeliveryKey: { $type: "string" } },
  }
);

module.exports = mongoose.models.Message || mongoose.model("Message", MessageSchema);

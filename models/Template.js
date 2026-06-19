const mongoose = require("mongoose");

const TemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    category: {
      type: String,
      enum: ["Marketing", "Utility", "Authentication"],
      required: true,
    },

    language: { type: String, default: "English" },

    type: {
      type: String, 
      enum: ["Text", "Media", "Interactive"],
      default: "Text",
    },

    format: { type: String, required: true },
    footer: { type: String, default: "" },

    actionType: {
      type: String,
      enum: ["none", "callToActions", "quickReplies", "all"],
      default: "none",
    },

    mediaType: {
      type: String,
      enum: ["None", "Image", "Video", "Carousel"],
      default: "None",
    },

    imageFile: {
      name: { type: String },
      mimeType: { type: String },
      url: { type: String },
      _id: false,
    },

    videoFile: {
      name: { type: String },
      mimeType: { type: String },
      url: { type: String },
      _id: false,
    },

    carouselItems: [
      {
        id: { type: String },
        title: { type: String },
        description: { type: String },
        button: { type: String },
        mediaUrl: { type: String },
        mimeType: { type: String },
        _id: false,
      },
    ],

    ctaButtons: [
      {
        id: { type: String },
        btnType: { type: String, enum: ["URL", "Phone Number"] },
        title: { type: String },
        value: { type: String },
        _id: false,
      },
    ],

    quickReplies: [
      {
        id: { type: String },
        title: { type: String },
        _id: false,
      },
    ],

    copyCodeButtons: [
      {
        id: { type: String },
        title: { type: String },
        _id: false,
      },
    ],

    dropdownButtons: [
      {
        id: { type: String },
        title: { type: String },
        placeholder: { type: String },
        options: { type: String },
        parsedOptions: [{ type: String }],
        selected: { type: String },
        _id: false,
      },
    ],

    inputFields: [
      {
        id: { type: String },
        label: { type: String },
        placeholder: { type: String },
        value: { type: String },
        _id: false,
      },
    ],

    variables: {
      type: Map,
      of: new mongoose.Schema(
        {
          type: { type: String, enum: ["name", "number", "manual"], default: "manual" },
          value: { type: String, default: "" },
        },
        { _id: false }
      ),
      default: {},
    },

    // ✅ WhatsApp status (DRAFT, PENDING, APPROVED, REJECTED)
    status: {
      type: String,
      enum: ["DRAFT", "PENDING", "APPROVED", "REJECTED"],
      default: "DRAFT",
    },

    // ✅ NEW — Internal approval status for manager submissions
    approvalStatus: {
      type: String,
      enum: ["pending_approval", "approved", "rejected"],
      default: "approved", // admin templates auto-approved
    },

    // ✅ FIXED — ObjectId ref so we can populate name/role
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
    },
  },
  { timestamps: true }
);

TemplateSchema.index({ organization: 1, createdAt: -1 });
TemplateSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model("Template", TemplateSchema);

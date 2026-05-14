const mongoose = require("mongoose");

const TaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    assignedTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    isPersonal: { type: Boolean, default: false },

    dueDate: { type: Date, required: true },
    reminderAt: { type: Date },

    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },

    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "cancelled"],
      default: "pending",
    },

    attachments: [
      {
        url: String,
        filename: String,
        mimetype: String,
        _id: false,
      },
    ],

    // Form elements
    inputFields: [
      {
        id: String,
        label: String,
        placeholder: String,
        required: Boolean,
        _id: false,
      },
    ],

    dropdownButtons: [
      {
        id: String,
        title: String,
        placeholder: String,
        options: [String],
        _id: false,
      },
    ],

    quickReplies: [
      {
        id: String,
        title: String,
        _id: false,
      },
    ],

    ctaButtons: [
      {
        id: String,
        btnType: { type: String, enum: ["URL", "Phone Number"] },
        title: String,
        value: String,
        _id: false,
      },
    ],
    approvalStatus: {
  type: String,
  enum: ["pending", "approved", "rejected"],
  default: "approved",
},
    pendingUpdate: {
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      changes: { type: mongoose.Schema.Types.Mixed, default: null },
      requestedAt: { type: Date, default: null },
    },
    checkboxes: [
      {
        id: String,
        label: String,
        options: [String],      // array of checkbox labels
        _id: false,
      },
    ],

    // Embedded responses — correct: _id is true by default, no need to specify
    // In your Task model, replace the responses.formData block with this:

responses: [
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    message: { type: String, default: "" },
    formData: {
      inputFields: [
        { id: String, value: String, _id: false },
      ],
      dropdownSelections: [
        { id: String, selected: String, _id: false },
      ],
      quickReplySelected: { type: String, default: "" },

      // ← ADD THIS — was missing, causing silent data loss
      checkboxSelections: [
        { id: String, selected: [String], _id: false },
      ],
    },
    createdAt: { type: Date, default: Date.now },
  },
],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Task", TaskSchema);

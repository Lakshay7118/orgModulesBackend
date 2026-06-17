const mongoose = require("mongoose");

const ContactSchema = new mongoose.Schema(
  {
    name: { type: String, default: "UNKNOWN" },

    mobile: { type: String, required: true, unique: true },

    email: { type: String, default: null }, // ✅ ADD THIS — OTP will be sent here

    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: "Tag" }],

    source: {
      type: String,
      enum: ["ORGANIC", "IMPORTED", "MANUAL"],
      default: "MANUAL",
    },

    role: {
      type: String,
      enum: ["super_to_super_admin", "super_admin", "manager", "hr", "user"],
      default: "user",
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Contact", ContactSchema);

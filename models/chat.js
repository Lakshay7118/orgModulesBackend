const mongoose = require("mongoose");

const ChatSchema = new mongoose.Schema(
  {
    participants: [
      {
        type: String, // phone numbers of all members (including admin)
        required: true,
      },
    ],

    // Group-specific fields
    isGroup: { type: Boolean, default: false },
    groupName: { type: String, default: null },
    groupAvatar: { type: String, default: null },
    admin: { type: String, default: null }, // phone number of group creator

lastMessage: {
  text:        { type: String, default: "" },
  messageType: { type: String, default: "text" },
  fileName:    { type: String, default: null },
  contactName: { type: String, default: null },
  createdAt:   { type: Date, default: null },
  sender:      { type: String, default: null },
  isDeleted:   { type: Boolean, default: false },
  status:      { type: String, default: null },
  callStatus:  { type: String, default: null },
  callDuration: { type: Number, default: 0 },
  callType:    { type: String, default: null },
},

    status: {
      type: String,
      enum: ["active", "requesting", "intervened"],
      default: "active",
    },

    lastSeen: {
      type: String,
      default: "online",
    },
    deletedBy: [{ type: String, default: [] }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Chat", ChatSchema);

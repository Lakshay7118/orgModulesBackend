const mongoose = require("mongoose");

const taskResponseSeenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },
    seenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

taskResponseSeenSchema.index({ userId: 1, taskId: 1 }, { unique: true });

module.exports = mongoose.model("TaskResponseSeen", taskResponseSeenSchema);

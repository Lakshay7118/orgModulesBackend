const mongoose = require("mongoose");

const HRPayrollSettingSchema = new mongoose.Schema(
  {
    cycleStartDay: {
      type: Number,
      default: 1,
      enum: [1, 7, 15],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HRPayrollSetting", HRPayrollSettingSchema);

const mongoose = require("mongoose");

const HRShiftSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "General" },
    start: { type: String, default: "09:00" },
    end: { type: String, default: "18:00" },
    breakMinutes: { type: Number, default: 60, min: 0 },
  },
  { _id: true }
);

const HRDepartmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    weeklyOffDays: {
      type: [Number],
      default: [0],
      validate: {
        validator(days) {
          return days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6);
        },
        message: "Weekly off days must be between 0 and 6",
      },
    },
    shift: {
      name: { type: String, trim: true, default: "General" },
      start: { type: String, default: "09:00" },
      end: { type: String, default: "18:00" },
      breakMinutes: { type: Number, default: 60, min: 0 },
    },
    shifts: {
      type: [HRShiftSchema],
      default: [],
    },
    leavePolicy: {
      paidLeaves: { type: Number, default: 0, min: 0 },
      shortLeaves: { type: Number, default: 0, min: 0 },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
    },
  },
  { timestamps: true }
);

HRDepartmentSchema.index(
  { organization: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: {
      organization: { $type: "objectId" },
      name: { $type: "string" },
    },
  }
);

module.exports = mongoose.model("HRDepartment", HRDepartmentSchema);

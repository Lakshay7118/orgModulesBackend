const mongoose = require("mongoose");
const { DEFAULT_HR_PERMISSIONS } = require("../utils/hrPermissions");

const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, sparse: true },
  password: String,
  phone: { type: String, unique: true, sparse: true },
  role: {
    type: String,
    enum: ["super_to_super_admin", "super_admin", "manager", "hr", "user"],
    default: "user",
  },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
  },
  allowedModules: {
    type: [String],
    enum: ["hr", "task", "chat"],
    default: [],
  },
  hrPermissions: {
    type: {
      canViewBanks: { type: Boolean, default: true },
      canManageBanks: { type: Boolean, default: true },
      canMakePayments: { type: Boolean, default: true },
      canManageAdvances: { type: Boolean, default: true },
      canAddStaff: { type: Boolean, default: true },
      canEditStaff: { type: Boolean, default: true },
      canDeleteStaff: { type: Boolean, default: true },
      canMarkAttendance: { type: Boolean, default: true },
      canGenerateSalarySlip: { type: Boolean, default: true },
    },
    default: DEFAULT_HR_PERMISSIONS,
  },
  isActive: { type: Boolean, default: true },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
}, { timestamps: true });

module.exports = mongoose.model("User", UserSchema);

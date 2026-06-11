const mongoose = require("mongoose");

const HRStaffSchema = new mongoose.Schema(
  {
    employeeCode: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      countryCode: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      countryName: {
        type: String,
        trim: true,
        default: "",
      },
      stateCode: {
        type: String,
        trim: true,
        default: "",
      },
      stateName: {
        type: String,
        trim: true,
        default: "",
      },
      cityName: {
        type: String,
        trim: true,
        default: "",
      },
      houseAddress: {
        type: String,
        trim: true,
        default: "",
      },
    },
    bankName: {
      type: String,
      trim: true,
      default: "",
    },
    accountHolderName: {
      type: String,
      trim: true,
      default: "",
    },
    accountNumber: {
      type: String,
      trim: true,
      default: "",
    },
    ifscCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    branch: {
      type: String,
      trim: true,
      default: "",
    },
    upiId: {
      type: String,
      trim: true,
      default: "",
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
    },
    designation: {
      type: String,
      trim: true,
      default: "",
    },
    monthlySalary: {
      type: Number,
      default: 0,
      min: 0,
    },
    salaryBasis: {
      type: String,
      enum: ["monthly", "daily", "hourly"],
      default: "monthly",
    },
    expectedHoursPerDay: {
      type: Number,
      default: 8,
      min: 0,
    },
    payrollCycleDay: {
      type: Number,
      default: 1,
      enum: [1, 7, 15],
    },
    joinDate: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "resigned"],
      default: "active",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HRStaff", HRStaffSchema);

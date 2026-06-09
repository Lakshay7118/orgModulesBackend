const mongoose = require("mongoose");

const HRLoanSchema = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRStaff",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    outstanding: {
      type: Number,
      required: true,
      min: 0,
    },
    emi: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      enum: ["loan", "advance"],
      default: "advance",
    },
    issueDate: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["active", "closed"],
      default: "active",
    },
    note: {
      type: String,
      trim: true,
      default: "",
    },
    repayments: [
      {
        payroll: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "HRPayroll",
        },
        amount: {
          type: Number,
          default: 0,
          min: 0,
        },
        paidAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HRLoan", HRLoanSchema);

const mongoose = require("mongoose");

const HRBankTransactionSchema = new mongoose.Schema(
  {
    bank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRBank",
      required: true,
    },
    type: {
      type: String,
      enum: ["salary", "manual_out"],
      default: "manual_out",
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRStaff",
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
    },
    payroll: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRPayroll",
    },
    paymentHistoryId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    beneficiaryName: {
      type: String,
      trim: true,
      default: "",
    },
    beneficiaryAccount: {
      type: String,
      trim: true,
      default: "",
    },
    note: {
      type: String,
      trim: true,
      default: "",
    },
    paidAt: {
      type: Date,
      default: Date.now,
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

HRBankTransactionSchema.index({ bank: 1, paidAt: -1 });
HRBankTransactionSchema.index({ payroll: 1, paymentHistoryId: 1 }, { sparse: true });

module.exports = mongoose.model("HRBankTransaction", HRBankTransactionSchema);

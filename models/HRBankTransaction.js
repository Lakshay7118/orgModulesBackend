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
      enum: ["salary", "manual_out", "manual_in", "loan_out", "loan_repayment", "advance_out"],
      default: "manual_out",
    },
    direction: {
      type: String,
      enum: ["in", "out"],
      default: "out",
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
    loan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRLoan",
    },
    paymentHistoryId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    payrollPeriodLabel: {
      type: String,
      trim: true,
      default: "",
    },
    grossSalary: {
      type: Number,
      default: 0,
      min: 0,
    },
    netPay: {
      type: Number,
      default: 0,
      min: 0,
    },
    loanDeduction: {
      type: Number,
      default: 0,
      min: 0,
    },
    loanOutstandingAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
    bankBalanceAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
    loanDeductions: [
      {
        loan: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "HRLoan",
        },
        amount: {
          type: Number,
          default: 0,
          min: 0,
        },
      },
    ],
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

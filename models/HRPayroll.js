const mongoose = require("mongoose");

const HRPayrollSchema = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRStaff",
      required: true,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
    },
    shift: {
      name: { type: String, trim: true, default: "" },
      start: { type: String, default: "" },
      end: { type: String, default: "" },
      breakMinutes: { type: Number, default: 0, min: 0 },
    },
    month: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}$/,
    },
    cycleStartDay: { type: Number, default: 1, min: 1, max: 28 },
    periodStart: {
      type: String,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    periodEnd: {
      type: String,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    periodLabel: { type: String, default: "" },
    salaryBasis: { type: String, enum: ["monthly", "daily", "hourly"], default: "monthly" },
    salaryAmount: { type: Number, default: 0, min: 0 },
    baseSalary: { type: Number, default: 0, min: 0 },
    workingDays: { type: Number, default: 0, min: 0 },
    paidOffDays: { type: Number, default: 0, min: 0 },
    dailyRate: { type: Number, default: 0, min: 0 },
    cameDays: { type: Number, default: 0, min: 0 },
    presentDays: { type: Number, default: 0, min: 0 },
    halfDays: { type: Number, default: 0, min: 0 },
    paidLeaveDays: { type: Number, default: 0, min: 0 },
    shortLeaveDays: { type: Number, default: 0, min: 0 },
    leaveDays: { type: Number, default: 0, min: 0 },
    unpaidLeaveDays: { type: Number, default: 0, min: 0 },
    absentDays: { type: Number, default: 0, min: 0 },
    payableDays: { type: Number, default: 0, min: 0 },
    totalWorkHours: { type: Number, default: 0, min: 0 },
    expectedWorkHours: { type: Number, default: 0, min: 0 },
    hourlyRate: { type: Number, default: 0, min: 0 },
    grossSalary: { type: Number, default: 0, min: 0 },
    attendanceDeduction: { type: Number, default: 0, min: 0 },
    overtimeHours: { type: Number, default: 0, min: 0 },
    overtimeAmount: { type: Number, default: 0, min: 0 },
    fineHours: { type: Number, default: 0, min: 0 },
    fineAmount: { type: Number, default: 0, min: 0 },
    loanDeduction: { type: Number, default: 0, min: 0 },
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
    loanRepaymentApplied: { type: Boolean, default: false },
    netPay: { type: Number, default: 0, min: 0 },
    totalPaid: { type: Number, default: 0, min: 0 },
    balanceDue: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["draft", "partial", "paid"],
      default: "draft",
    },
    bank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRBank",
    },
    paidAt: Date,
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    paymentHistory: [
      {
        bank: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "HRBank",
        },
        amount: { type: Number, default: 0, min: 0 },
        paidAt: { type: Date, default: Date.now },
        paidBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        note: { type: String, trim: true, default: "" },
      },
    ],
  },
  { timestamps: true }
);

HRPayrollSchema.index(
  { staff: 1, periodEnd: 1 },
  {
    unique: true,
    partialFilterExpression: { periodEnd: { $type: "string" } },
  }
);

module.exports = mongoose.model("HRPayroll", HRPayrollSchema);

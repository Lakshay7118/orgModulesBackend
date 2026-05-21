const express = require("express");
const router = express.Router();

const HRDepartment = require("../models/HRDepartment");
const HRStaff = require("../models/HRStaff");
const HRBank = require("../models/HRBank");
const HRBankTransaction = require("../models/HRBankTransaction");
const HRAttendance = require("../models/HRAttendance");
const HRLoan = require("../models/HRLoan");
const HRPayroll = require("../models/HRPayroll");
const HRPayrollSetting = require("../models/HRPayrollSetting");
const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");

router.use(protect, allowRoles("super_admin", "manager"));

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALLOWED_PAYROLL_CYCLE_DAYS = [1, 7, 15];
const ATTENDANCE_STATUSES = ["present", "absent", "half_day", "paid_leave", "short_leave"];
let payrollIndexSyncPromise = null;

const money = (value) => Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
const idOfDoc = (item) => (item?._id || item || "").toString();
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeOffDays = (days) => {
  if (!Array.isArray(days)) return [];
  return [...new Set(days.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
};
const normalizeLeavePolicy = (policy = {}) => ({
  paidLeaves: Math.max(0, toNumber(policy.paidLeaves, 0)),
  shortLeaves: Math.max(0, toNumber(policy.shortLeaves, 0)),
});
const normalizeSalaryBasis = (basis) => {
  if (basis === "weekly") return "daily";
  return ["monthly", "daily", "hourly"].includes(basis) ? basis : "monthly";
};
const salaryBasisQueryValue = (basis) => {
  const normalized = normalizeSalaryBasis(basis);
  return normalized === "daily" ? { $in: ["daily", "weekly"] } : normalized;
};
const validMonth = (month) => /^\d{4}-\d{2}$/.test(month || "");
const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date || "");
const monthParts = (month) => {
  const [year, monthNumber] = month.split("-").map(Number);
  return { year, monthIndex: monthNumber - 1 };
};
const daysInMonth = (month) => {
  const { year, monthIndex } = monthParts(month);
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
};
const dateForMonthDay = (month, day) => `${month}-${String(day).padStart(2, "0")}`;
const dayOfWeek = (month, day) => {
  const { year, monthIndex } = monthParts(month);
  return new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
};
const parseUTCDate = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};
const formatUTCDate = (date) => date.toISOString().slice(0, 10);
const addDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};
const daysBetween = (startDate, endDate) => Math.floor((parseUTCDate(endDate) - parseUTCDate(startDate)) / 86400000);
const isAllowedCycleDay = (day) => ALLOWED_PAYROLL_CYCLE_DAYS.includes(Number(day));
const normalizeCycleDay = (day, fallback = 1) => {
  const parsed = Number(day);
  return Number.isInteger(parsed) && isAllowedCycleDay(parsed) ? parsed : fallback;
};
const cycleDayFromDate = (date, fallback = 1) => {
  const parsed = dateOnly(date);
  if (!parsed) return fallback;
  const day = Number(parsed.slice(8, 10));
  return normalizeCycleDay(day, fallback);
};
const staffPayrollCycleDay = (staff) => normalizeCycleDay(staff?.payrollCycleDay, 1);
const monthDateWithCycleDay = (year, monthIndex, day) =>
  new Date(Date.UTC(year, monthIndex, normalizeCycleDay(day)));
const dateOnly = (date) => {
  if (!date) return "";
  const parsed = date instanceof Date ? date : new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : formatUTCDate(parsed);
};
const buildPeriodFromDueDate = (dueDate, cycleStartDay = 1) => {
  const safeCycleDay = normalizeCycleDay(cycleStartDay);
  const due = parseUTCDate(dueDate);
  const dueDay = due.getUTCDate();
  const periodEnd = dueDay === safeCycleDay
    ? due
    : monthDateWithCycleDay(due.getUTCFullYear(), due.getUTCMonth(), safeCycleDay);
  const periodStart = monthDateWithCycleDay(
    periodEnd.getUTCFullYear(),
    periodEnd.getUTCMonth() - 1,
    safeCycleDay
  );
  return {
    cycleStartDay: safeCycleDay,
    periodStart: formatUTCDate(periodStart),
    periodEnd: formatUTCDate(periodEnd),
    month: formatUTCDate(periodEnd).slice(0, 7),
  };
};
const isStaffPayrollDueOnDate = (staff, dueDate) => {
  const basis = normalizeSalaryBasis(staff.salaryBasis);
  const joinDate = dateOnly(staff.joinDate);
  if (joinDate && dueDate < joinDate) return false;
  if (basis === "hourly" || basis === "daily") return true;
  return isAllowedCycleDay(Number(dueDate.slice(8, 10))) && staffPayrollCycleDay(staff) === Number(dueDate.slice(8, 10));
};
const buildPeriodForStaff = (staff, dueDate) => {
  const basis = normalizeSalaryBasis(staff.salaryBasis);
  if (basis === "hourly" || basis === "daily") {
    return {
      cycleStartDay: staffPayrollCycleDay(staff),
      periodStart: dueDate,
      periodEnd: dueDate,
      attendanceStart: dueDate,
      attendanceEnd: formatUTCDate(addDays(parseUTCDate(dueDate), 1)),
      periodLabel: dueDate,
      month: dueDate.slice(0, 7),
    };
  }
  return buildPeriodFromDueDate(dueDate, Number(dueDate.slice(8, 10)));
};
const monthWindowForDate = (date) => {
  const parsed = parseUTCDate(date);
  const start = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1));
  const end = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 1));
  return { start: formatUTCDate(start), end: formatUTCDate(end) };
};
const eachDateInPeriod = (periodStart, periodEnd) => {
  const dates = [];
  for (let cursor = parseUTCDate(periodStart); cursor < parseUTCDate(periodEnd); cursor = addDays(cursor, 1)) {
    const date = formatUTCDate(cursor);
    dates.push({
      date,
      weekday: cursor.getUTCDay(),
    });
  }
  return dates;
};
const periodLabel = (periodStart, periodEnd) => {
  const start = parseUTCDate(periodStart);
  const lastSalaryDate = addDays(parseUTCDate(periodEnd), -1);
  return `${start.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })} - ${lastSalaryDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
};
const timeToMinutes = (time) => {
  if (!time || typeof time !== "string") return null;
  const [hours, minutes] = time.split(":").map(Number);
  if (![hours, minutes].every(Number.isFinite)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
};
const calcWorkHours = (checkIn, checkOut) => {
  const start = timeToMinutes(checkIn);
  let end = timeToMinutes(checkOut);
  if (start === null || end === null) return 0;
  if (end < start) end += 24 * 60;
  return Math.round(((end - start) / 60) * 100) / 100;
};
const hasPayrollSettlement = (payroll) => (
  Number(payroll?.totalPaid || 0) > 0
  || Boolean(payroll?.paidAt)
  || Boolean(payroll?.loanRepaymentApplied)
  || (Array.isArray(payroll?.paymentHistory) && payroll.paymentHistory.length > 0)
);

const populateStaff = (query) => query.populate("department").sort({ createdAt: -1 });
const populatePayroll = (query) =>
  query
    .populate("staff")
    .populate("department")
    .populate("bank")
    .populate("loanDeductions.loan")
    .populate("paymentHistory.bank")
    .sort({ createdAt: -1 });

const loanDeductionsSnapshot = (payroll) =>
  (payroll?.loanDeductions || [])
    .map((item) => ({
      loan: item.loan?._id || item.loan || null,
      amount: money(item.amount),
    }))
    .filter((item) => item.loan && item.amount > 0);

const isFirstPayrollPayment = (payroll, paymentHistoryId) => {
  const history = Array.isArray(payroll?.paymentHistory) ? payroll.paymentHistory : [];
  if (history.length <= 1) return true;
  if (!paymentHistoryId) return false;
  return idOfDoc(history[0]?._id) === idOfDoc(paymentHistoryId);
};

const attachSalaryTransactionDetails = (payment) => {
  const payroll = payment.payroll && typeof payment.payroll === "object" ? payment.payroll : null;
  const hasLoanSnapshot = payment.loanDeduction !== undefined && payment.loanDeduction !== null;
  const inferredLoanDeduction = payroll && isFirstPayrollPayment(payroll, payment.paymentHistoryId)
    ? Number(payroll.loanDeduction || 0)
    : 0;
  const loanDeduction = money(hasLoanSnapshot ? payment.loanDeduction : inferredLoanDeduction);
  const loanDeductions = (payment.loanDeductions || []).length
    ? payment.loanDeductions
    : loanDeduction > 0 ? loanDeductionsSnapshot(payroll) : [];

  return {
    ...payment,
    periodLabel: payment.periodLabel || payment.payrollPeriodLabel || payroll?.periodLabel || payroll?.periodEnd || "",
    payrollPeriodLabel: payment.payrollPeriodLabel || payroll?.periodLabel || payroll?.periodEnd || "",
    grossSalary: money(payment.grossSalary ?? payroll?.grossSalary ?? 0),
    netPay: money(payment.netPay ?? payroll?.netPay ?? 0),
    loanDeduction,
    loanDeductions,
  };
};

const getPayrollSetting = async () => {
  let setting = await HRPayrollSetting.findOne().sort({ createdAt: 1 });
  if (!setting) setting = await HRPayrollSetting.create({ cycleStartDay: 1 });
  if (!isAllowedCycleDay(setting.cycleStartDay)) {
    setting.cycleStartDay = 1;
    await setting.save();
  }
  return setting;
};

const syncPayrollIndexes = async () => {
  if (!payrollIndexSyncPromise) {
    payrollIndexSyncPromise = (async () => {
      let indexes = [];
      try {
        indexes = await HRPayroll.collection.indexes();
      } catch (error) {
        if (error.code !== 26 && error.codeName !== "NamespaceNotFound") throw error;
      }
      const legacyMonthIndex = indexes.find((index) => index.name === "staff_1_month_1" && index.unique);
      const oldPeriodIndex = indexes.find((index) => {
        if (index.name !== "staff_1_periodEnd_1") return false;
        return !index.unique || !index.partialFilterExpression;
      });

      if (legacyMonthIndex) await HRPayroll.collection.dropIndex("staff_1_month_1");
      if (oldPeriodIndex) await HRPayroll.collection.dropIndex("staff_1_periodEnd_1");

      await HRPayroll.collection.createIndex(
        { staff: 1, periodEnd: 1 },
        {
          name: "staff_1_periodEnd_1",
          unique: true,
          partialFilterExpression: { periodEnd: { $type: "string" } },
        }
      );
    })().catch((error) => {
      payrollIndexSyncPromise = null;
      throw error;
    });
  }
  return payrollIndexSyncPromise;
};

async function buildPayrollForStaff(staff, period, generatedBy, existingPayroll = null) {
  const department = staff.department || {};
  const offDays = normalizeOffDays(department.weeklyOffDays || []);
  const leavePolicy = normalizeLeavePolicy(department.leavePolicy);
  const salaryBasis = normalizeSalaryBasis(staff.salaryBasis);
  const expectedHoursPerDay = Math.max(0, Number(staff.expectedHoursPerDay || 0)) || 8;
  const joinDate = dateOnly(staff.joinDate);
  const attendanceStart = period.attendanceStart || period.periodStart;
  const attendanceEnd = period.attendanceEnd || period.periodEnd;
  const effectiveStart = joinDate && joinDate > attendanceStart ? joinDate : attendanceStart;
  if (effectiveStart >= attendanceEnd) return null;

  const periodDates = eachDateInPeriod(attendanceStart, attendanceEnd).map((dateMeta) => ({
    ...dateMeta,
    isOff: offDays.includes(dateMeta.weekday),
  })).filter((dateMeta) => dateMeta.date >= effectiveStart);

  const workingDays = salaryBasis === "hourly" ? periodDates.length : periodDates.filter((date) => !date.isOff).length;
  const paidOffDays = periodDates.length - workingDays;
  const attendance = await HRAttendance.find({
    staff: staff._id,
    date: { $gte: effectiveStart, $lt: attendanceEnd },
  }).lean();
  const attendanceByDate = new Map(attendance.map((item) => [item.date, item]));

  let presentDays = 0;
  let halfDays = 0;
  let paidLeaveRequests = 0;
  let shortLeaveDays = 0;
  let absentMarkedDays = 0;
  let unpaidLeaveDays = 0;
  let totalWorkHours = 0;
  let markedWorkingDays = 0;
  let attendanceOvertimeHours = 0;
  let attendanceFineHours = 0;
  const shortLeaveRecords = [];

  periodDates.forEach((dateMeta) => {
    if (dateMeta.isOff && salaryBasis !== "hourly") return;
    const record = attendanceByDate.get(dateMeta.date);
    if (!record) return;
    const recordWorkHours = Number(record.workHours || 0);
    markedWorkingDays += 1;
    totalWorkHours += recordWorkHours;
    attendanceOvertimeHours += Number(record.overtimeHours || 0);
    attendanceFineHours += Number(record.fineHours || 0);
    if (record.status === "present") presentDays += 1;
    if (record.status === "absent") absentMarkedDays += 1;
    if (record.status === "half_day") halfDays += 1;
    if (record.status === "paid_leave") paidLeaveRequests += 1;
    if (record.status === "short_leave") {
      shortLeaveDays += 1;
      shortLeaveRecords.push({ workHours: recordWorkHours });
    }
    // Legacy records may still exist from before the plain Leave option was removed.
    if (record.status === "leave") unpaidLeaveDays += 1;
  });

  const paidLeaveDays = Math.min(paidLeaveRequests, leavePolicy.paidLeaves);
  const extraPaidLeaveRequests = Math.max(0, paidLeaveRequests - paidLeaveDays);
  unpaidLeaveDays += extraPaidLeaveRequests;

  const fullyPaidShortLeaves = Math.min(shortLeaveDays, leavePolicy.shortLeaves);
  const unpaidShortLeaveDays = Math.max(0, shortLeaveDays - fullyPaidShortLeaves);
  const roundedWorkHours = Math.round(totalWorkHours * 100) / 100;
  const paidLeaveHours = salaryBasis === "hourly" ? paidLeaveDays * expectedHoursPerDay : 0;
  const paidShortLeaveHours = salaryBasis === "hourly"
    ? shortLeaveRecords
      .slice(0, fullyPaidShortLeaves)
      .reduce((sum, record) => sum + Math.max(0, expectedHoursPerDay - Number(record.workHours || 0)), 0)
    : 0;
  const payableWorkHours = salaryBasis === "hourly"
    ? Math.round((roundedWorkHours + paidLeaveHours + paidShortLeaveHours) * 100) / 100
    : roundedWorkHours;
  const missingDays = Math.max(0, workingDays - markedWorkingDays);
  const absentDays = absentMarkedDays + missingDays;
  const salaryAmount = money(staff.monthlySalary);
  const expectedWorkHours = money(
    salaryBasis === "hourly"
      ? payableWorkHours
      : workingDays * expectedHoursPerDay
  );
  const baseSalary = money(
    salaryBasis === "hourly"
      ? salaryAmount * payableWorkHours
      : salaryBasis === "daily"
        ? salaryAmount * workingDays
        : salaryAmount
  );
  const dailyRate = workingDays > 0 ? money(baseSalary / workingDays) : 0;
  const hourlyRate = money(
    salaryBasis === "hourly"
      ? salaryAmount
      : expectedWorkHours > 0 ? baseSalary / expectedWorkHours : 0
  );
  const fullDayDeduction = dailyRate * (absentDays + unpaidLeaveDays);
  const halfDayDeduction = dailyRate * 0.5 * halfDays;
  const shortLeaveDeduction = hourlyRate * 2 * unpaidShortLeaveDays;
  const attendanceDeduction = salaryBasis === "hourly"
    ? 0
    : money(fullDayDeduction + halfDayDeduction + shortLeaveDeduction);
  const grossSalary = money(Math.max(0, baseSalary - attendanceDeduction));
  const payableDays = dailyRate > 0 ? Math.round((grossSalary / dailyRate) * 100) / 100 : 0;

  const loans = await HRLoan.find({
    staff: staff._id,
    status: "active",
    outstanding: { $gt: 0 },
  }).sort({ issueDate: 1 });

  let remainingForLoans = grossSalary;
  const loanDeductions = existingPayroll?.loanRepaymentApplied && existingPayroll.loanDeductions?.length
    ? existingPayroll.loanDeductions.map((item) => ({ loan: item.loan, amount: money(item.amount) }))
    : [];
  if (loanDeductions.length === 0) {
    const monthlyLoanDeductions = new Map();
    if (salaryBasis === "daily" || salaryBasis === "hourly") {
      const window = monthWindowForDate(period.periodStart || period.periodEnd);
      const payrollFilter = {
        staff: staff._id,
        periodEnd: { $gte: window.start, $lt: window.end },
        "loanDeductions.0": { $exists: true },
      };
      if (existingPayroll?._id) payrollFilter._id = { $ne: existingPayroll._id };

      const monthPayrolls = await HRPayroll.find(payrollFilter).select("loanDeductions").lean();
      monthPayrolls.forEach((payroll) => {
        (payroll.loanDeductions || []).forEach((deduction) => {
          const loanId = idOfDoc(deduction.loan);
          monthlyLoanDeductions.set(
            loanId,
            money((monthlyLoanDeductions.get(loanId) || 0) + Number(deduction.amount || 0))
          );
        });
      });
    }

    loans.forEach((loan) => {
      if (remainingForLoans <= 0) return;
      const alreadyCutThisMonth = salaryBasis === "daily" || salaryBasis === "hourly"
        ? monthlyLoanDeductions.get(idOfDoc(loan)) || 0
        : 0;
      const emiBalanceForThisPayroll = Math.max(0, Number(loan.emi || 0) - alreadyCutThisMonth);
      const amount = money(Math.min(emiBalanceForThisPayroll, Number(loan.outstanding || 0), remainingForLoans));
      if (amount <= 0) return;
      loanDeductions.push({ loan: loan._id, amount });
      remainingForLoans = money(remainingForLoans - amount);
    });
  }
  const loanDeduction = money(loanDeductions.reduce((sum, item) => sum + item.amount, 0));
  const overtimeHours = Math.round(attendanceOvertimeHours * 100) / 100;
  const fineHours = Math.round(attendanceFineHours * 100) / 100;
  const overtimeAmount = money(overtimeHours * hourlyRate);
  const fineAmount = money(fineHours * hourlyRate);
  const totalPaid = money(existingPayroll?.totalPaid || 0);
  const netPay = money(Math.max(0, grossSalary + overtimeAmount - fineAmount - loanDeduction));
  const balanceDue = money(Math.max(0, netPay - totalPaid));

  return {
    staff: staff._id,
    department: staff.department?._id || staff.department || null,
    month: period.month,
    cycleStartDay: period.cycleStartDay,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    periodLabel: period.periodLabel || periodLabel(period.periodStart, period.periodEnd),
    salaryBasis,
    salaryAmount,
    baseSalary,
    workingDays,
    paidOffDays,
    dailyRate,
    presentDays,
    halfDays,
    paidLeaveDays,
    shortLeaveDays,
    leaveDays: paidLeaveDays,
    unpaidLeaveDays,
    absentDays,
    payableDays,
    totalWorkHours: roundedWorkHours,
    expectedWorkHours,
    hourlyRate,
    grossSalary,
    attendanceDeduction,
    overtimeHours,
    overtimeAmount,
    fineHours,
    fineAmount,
    loanDeduction,
    loanDeductions,
    loanRepaymentApplied: existingPayroll?.loanRepaymentApplied || false,
    netPay,
    totalPaid,
    balanceDue,
    status: balanceDue <= 0 ? "paid" : totalPaid > 0 ? "partial" : "draft",
    generatedBy,
  };
}

async function recalculateUnsettledPayrollsForStaff(staffId, userId) {
  const staff = await HRStaff.findById(staffId).populate("department");
  if (!staff) return [];
  const payrolls = await HRPayroll.find({ staff: staffId, status: "draft" });
  const updatedIds = [];

  for (const payroll of payrolls) {
    if (hasPayrollSettlement(payroll)) continue;
    payroll.salaryBasis = normalizeSalaryBasis(payroll.salaryBasis || staff.salaryBasis);
    const periodStart = payroll.periodStart || payroll.periodEnd;
    const period = ["daily", "hourly"].includes(payroll.salaryBasis)
      ? {
        cycleStartDay: payroll.cycleStartDay || staffPayrollCycleDay(staff),
        periodStart,
        periodEnd: payroll.periodEnd,
        attendanceStart: periodStart,
        attendanceEnd: formatUTCDate(addDays(parseUTCDate(periodStart), 1)),
        periodLabel: payroll.periodLabel || payroll.periodEnd,
        month: payroll.month || payroll.periodEnd?.slice(0, 7),
      }
      : {
        cycleStartDay: payroll.cycleStartDay || cycleDayFromDate(payroll.periodEnd),
        periodStart,
        periodEnd: payroll.periodEnd,
        periodLabel: payroll.periodLabel || periodLabel(periodStart, payroll.periodEnd),
        month: payroll.month || payroll.periodEnd?.slice(0, 7),
      };
    const refreshed = await buildPayrollForStaff(staff, period, userId, payroll);
    if (!refreshed) continue;
    Object.assign(payroll, refreshed);
    await payroll.save();
    updatedIds.push(payroll._id);
  }

  return updatedIds.length ? populatePayroll(HRPayroll.find({ _id: { $in: updatedIds } })) : [];
}

router.get("/summary", async (req, res) => {
  try {
    const [departmentCount, activeStaffCount, banks, loans, unpaidPayrolls] = await Promise.all([
      HRDepartment.countDocuments(),
      HRStaff.countDocuments({ status: "active" }),
      HRBank.find().lean(),
      HRLoan.find({ status: "active", outstanding: { $gt: 0 } }).lean(),
      HRPayroll.find({ status: { $in: ["draft", "partial"] } }).lean(),
    ]);

    const bankBalance = banks.reduce((sum, bank) => sum + Number(bank.balance || 0), 0);
    const loanOutstanding = loans.reduce((sum, loan) => sum + Number(loan.outstanding || 0), 0);
    const dues = unpaidPayrolls.reduce((sum, payroll) => sum + Number(payroll.balanceDue ?? payroll.netPay ?? 0), 0);

    res.json({
      success: true,
      data: {
        departmentCount,
        activeStaffCount,
        bankBalance: money(bankBalance),
        loanOutstanding: money(loanOutstanding),
        dues: money(dues),
        pendingPayrolls: unpaidPayrolls.length,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/payroll/settings", async (req, res) => {
  try {
    const setting = await getPayrollSetting();
    res.json({ success: true, data: setting });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/payroll/settings", async (req, res) => {
  try {
    if (!isAllowedCycleDay(req.body.cycleStartDay)) {
      return res.status(400).json({ error: "Payroll cycle must be 1 to 1, 7 to 7, or 15 to 15." });
    }

    const setting = await getPayrollSetting();
    setting.cycleStartDay = normalizeCycleDay(req.body.cycleStartDay);
    setting.updatedBy = req.user.id;
    await setting.save();
    res.json({ success: true, data: setting });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/departments", async (req, res) => {
  try {
    const departments = await HRDepartment.find().sort({ name: 1 });
    res.json({ success: true, data: departments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/departments", async (req, res) => {
  try {
    const department = await HRDepartment.create({
      name: req.body.name,
      description: req.body.description || "",
      weeklyOffDays: normalizeOffDays(req.body.weeklyOffDays),
      shift: {
        name: req.body.shift?.name || "General",
        start: req.body.shift?.start || "09:00",
        end: req.body.shift?.end || "18:00",
        breakMinutes: toNumber(req.body.shift?.breakMinutes, 60),
      },
      leavePolicy: normalizeLeavePolicy(req.body.leavePolicy),
      createdBy: req.user.id,
    });
    res.status(201).json({ success: true, data: department });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/departments/:id", async (req, res) => {
  try {
    const updates = {};
    ["name", "description"].forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });
    if (req.body.weeklyOffDays !== undefined) updates.weeklyOffDays = normalizeOffDays(req.body.weeklyOffDays);
    if (req.body.leavePolicy !== undefined) updates.leavePolicy = normalizeLeavePolicy(req.body.leavePolicy);
    if (req.body.shift) {
      updates.shift = {
        name: req.body.shift.name || "General",
        start: req.body.shift.start || "09:00",
        end: req.body.shift.end || "18:00",
        breakMinutes: toNumber(req.body.shift.breakMinutes, 60),
      };
    }

    const department = await HRDepartment.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    if (!department) return res.status(404).json({ error: "Department not found" });
    res.json({ success: true, data: department });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/departments/:id", async (req, res) => {
  try {
    const staffCount = await HRStaff.countDocuments({ department: req.params.id });
    if (staffCount > 0) {
      return res.status(400).json({ error: "Move staff out of this department before deleting it" });
    }
    await HRDepartment.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Department deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/staff", async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const staff = await populateStaff(HRStaff.find(filter));
    res.json({ success: true, data: staff });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/staff", async (req, res) => {
  try {
    const staff = await HRStaff.create({
      employeeCode: req.body.employeeCode || undefined,
      name: req.body.name,
      email: req.body.email || "",
      phone: req.body.phone || "",
      department: req.body.department || null,
      designation: req.body.designation || "",
      monthlySalary: money(req.body.monthlySalary),
      salaryBasis: normalizeSalaryBasis(req.body.salaryBasis),
      expectedHoursPerDay: toNumber(req.body.expectedHoursPerDay, 8),
      payrollCycleDay: normalizeCycleDay(
        req.body.payrollCycleDay,
        cycleDayFromDate(req.body.joinDate, 1)
      ),
      joinDate: req.body.joinDate || Date.now(),
      status: req.body.status || "active",
      createdBy: req.user.id,
    });
    await staff.populate("department");
    res.status(201).json({ success: true, data: staff });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/staff/:id", async (req, res) => {
  try {
    const updates = {};
    [
      "employeeCode",
      "name",
      "email",
      "phone",
      "department",
      "designation",
      "salaryBasis",
      "payrollCycleDay",
      "joinDate",
      "status",
    ].forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field] || (field === "department" ? null : req.body[field]);
    });
    if (req.body.salaryBasis !== undefined) updates.salaryBasis = normalizeSalaryBasis(req.body.salaryBasis);
    if (req.body.payrollCycleDay !== undefined) updates.payrollCycleDay = normalizeCycleDay(req.body.payrollCycleDay);
    if (req.body.monthlySalary !== undefined) updates.monthlySalary = money(req.body.monthlySalary);
    if (req.body.expectedHoursPerDay !== undefined) updates.expectedHoursPerDay = toNumber(req.body.expectedHoursPerDay, 8);

    const staff = await HRStaff.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    }).populate("department");
    if (!staff) return res.status(404).json({ error: "Staff not found" });
    res.json({ success: true, data: staff });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/staff/:id", async (req, res) => {
  try {
    const staff = await HRStaff.findById(req.params.id);
    if (!staff) return res.status(404).json({ error: "Staff not found" });

    const [attendanceResult, payrollResult, loanResult] = await Promise.all([
      HRAttendance.deleteMany({ staff: staff._id }),
      HRPayroll.deleteMany({ staff: staff._id }),
      HRLoan.deleteMany({ staff: staff._id }),
    ]);

    await staff.deleteOne();
    res.json({
      success: true,
      message: "Staff deleted",
      deleted: {
        attendance: attendanceResult.deletedCount || 0,
        payrolls: payrollResult.deletedCount || 0,
        loans: loanResult.deletedCount || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/attendance", async (req, res) => {
  try {
    const filter = {};
    if (req.query.date) filter.date = req.query.date;
    if (req.query.month && validMonth(req.query.month)) {
      const days = daysInMonth(req.query.month);
      filter.date = {
        $gte: `${req.query.month}-01`,
        $lte: `${req.query.month}-${String(days).padStart(2, "0")}`,
      };
    }
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from && validDate(req.query.from)) filter.date.$gte = req.query.from;
      if (req.query.to && validDate(req.query.to)) filter.date.$lt = req.query.to;
      if (Object.keys(filter.date).length === 0) delete filter.date;
    }
    if (req.query.staff) filter.staff = req.query.staff;

    const attendance = await HRAttendance.find(filter)
      .populate({ path: "staff", populate: { path: "department" } })
      .sort({ date: -1, createdAt: -1 });
    res.json({ success: true, data: attendance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/attendance", async (req, res) => {
  try {
    const status = req.body.status;
    if (!ATTENDANCE_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Select attendance status before saving." });
    }
    if (!req.body.staff || !validDate(req.body.date)) {
      return res.status(400).json({ error: "Staff and valid attendance date are required." });
    }

    const staff = await HRStaff.findById(req.body.staff).select("salaryBasis");
    if (!staff) return res.status(404).json({ error: "Staff not found" });

    const checkIn = req.body.checkIn || "";
    const checkOut = req.body.checkOut || "";
    const isHourly = normalizeSalaryBasis(staff.salaryBasis) === "hourly";
    let workHours = req.body.workHours !== undefined
      ? toNumber(req.body.workHours, 0)
      : calcWorkHours(checkIn, checkOut);

    if (isHourly && checkIn && checkOut) {
      workHours = calcWorkHours(checkIn, checkOut);
    }
    if (isHourly && status === "present" && (!checkIn || !checkOut)) {
      return res.status(400).json({ error: "Check-in and check-out are required for hourly staff." });
    }
    if (workHours < 0) {
      return res.status(400).json({ error: "Work hours cannot be negative." });
    }

    const attendance = await HRAttendance.findOneAndUpdate(
      { staff: req.body.staff, date: req.body.date },
      {
        status,
        checkIn,
        checkOut,
        workHours,
        overtimeHours: Math.max(0, toNumber(req.body.overtimeHours, 0)),
        fineHours: Math.max(0, toNumber(req.body.fineHours, 0)),
        note: req.body.note || "",
        markedBy: req.user.id,
      },
      { upsert: true, new: true, runValidators: true }
    ).populate({ path: "staff", populate: { path: "department" } });

    res.json({ success: true, data: attendance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/banks", async (req, res) => {
  try {
    const banks = await HRBank.find().sort({ createdAt: -1 });
    res.json({ success: true, data: banks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/banks/transactions", async (req, res) => {
  try {
    const filter = {};
    if (req.query.bank) filter.bank = req.query.bank;

    const storedTransactions = await HRBankTransaction.find(filter)
      .populate("bank")
      .populate("staff")
      .populate("department")
      .populate("loan")
      .populate({ path: "payroll", populate: [{ path: "loanDeductions.loan" }] })
      .populate("loanDeductions.loan")
      .sort({ paidAt: -1, createdAt: -1 })
      .lean();

    const storedPaymentIds = new Set(
      storedTransactions
        .map((transaction) => transaction.paymentHistoryId?.toString())
        .filter(Boolean)
    );

    const payrolls = await HRPayroll.find({ "paymentHistory.0": { $exists: true } })
      .populate("staff")
      .populate("department")
      .populate("loanDeductions.loan")
      .populate("paymentHistory.bank")
      .sort({ updatedAt: -1 })
      .lean();

    const legacyTransactions = payrolls.flatMap((payroll) =>
      (payroll.paymentHistory || [])
        .map((payment, index) => ({ payment, index }))
        .filter(({ payment }) => !storedPaymentIds.has(payment._id?.toString()))
        .map(({ payment, index }) => {
          const loanDeduction = index === 0 ? money(payroll.loanDeduction) : 0;
          return {
            _id: `${payroll._id}-${payment._id || payment.paidAt}`,
            type: "salary",
            payroll,
            staff: payroll.staff,
            department: payroll.department,
            bank: payment.bank,
            amount: payment.amount || 0,
            paidAt: payment.paidAt,
            beneficiaryName: payroll.staff?.name || "",
            beneficiaryAccount: "",
            note: payment.note || "",
            payrollPeriodLabel: payroll.periodLabel || payroll.periodEnd || payroll.month,
            grossSalary: money(payroll.grossSalary),
            netPay: money(payroll.netPay),
            loanDeduction,
            loanDeductions: loanDeduction > 0 ? loanDeductionsSnapshot(payroll) : [],
            status: payroll.status,
          };
        })
    );

    const transactions = [...storedTransactions, ...legacyTransactions]
      .filter((payment) => !req.query.bank || idOfDoc(payment.bank) === req.query.bank)
      .map(attachSalaryTransactionDetails)
      .sort((a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0));

    res.json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/banks", async (req, res) => {
  try {
    const bank = await HRBank.create({
      name: req.body.name,
      accountName: req.body.accountName || "",
      accountNumber: req.body.accountNumber || "",
      balance: money(req.body.balance),
      createdBy: req.user.id,
    });
    res.status(201).json({ success: true, data: bank });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/banks/:id", async (req, res) => {
  try {
    const updates = {};
    ["name", "accountName", "accountNumber"].forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });
    if (req.body.balance !== undefined) updates.balance = money(req.body.balance);
    const bank = await HRBank.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!bank) return res.status(404).json({ error: "Bank not found" });
    res.json({ success: true, data: bank });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/banks/:id/add-money", async (req, res) => {
  try {
    const amount = money(req.body.amount);
    if (amount <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });
    const bank = await HRBank.findById(req.params.id);
    if (!bank) return res.status(404).json({ error: "Bank not found" });

    bank.balance = money(Number(bank.balance || 0) + amount);
    await bank.save();

    const transaction = await HRBankTransaction.create({
      bank: bank._id,
      type: "manual_in",
      direction: "in",
      amount,
      beneficiaryName: (req.body.sourceName || "Bank deposit").trim(),
      note: req.body.note || "",
      paidAt: new Date(),
      paidBy: req.user.id,
      bankBalanceAfter: bank.balance,
    });
    await transaction.populate("bank");

    res.json({ success: true, data: bank, transaction });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/banks/:id/pay-now", async (req, res) => {
  try {
    const amount = money(req.body.amount);
    if (amount <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });

    const beneficiaryName = (req.body.beneficiaryName || "").trim();
    const beneficiaryAccount = (req.body.beneficiaryAccount || "").trim();
    if (!beneficiaryName) return res.status(400).json({ error: "Receiver name is required" });
    if (!beneficiaryAccount) return res.status(400).json({ error: "Receiver account number is required" });

    const bank = await HRBank.findById(req.params.id);
    if (!bank) return res.status(404).json({ error: "Bank not found" });
    if (Number(bank.balance || 0) < amount) {
      return res.status(400).json({ error: "Selected bank does not have enough balance" });
    }

    bank.balance = money(Number(bank.balance || 0) - amount);
    await bank.save();

    const transaction = await HRBankTransaction.create({
      bank: bank._id,
      type: "manual_out",
      direction: "out",
      amount,
      beneficiaryName,
      beneficiaryAccount,
      note: req.body.note || "",
      paidAt: new Date(),
      paidBy: req.user.id,
      bankBalanceAfter: bank.balance,
    });
    await transaction.populate("bank");

    res.json({ success: true, data: transaction, bank });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/banks/:id/payment", async (req, res) => {
  try {
    const amount = money(req.body.amount);
    if (amount <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });

    const direction = req.body.direction === "in" ? "in" : "out";
    const partyType = req.body.partyType === "other" ? "other" : "employee";
    const note = (req.body.note || "").trim();
    const beneficiaryAccount = (req.body.beneficiaryAccount || "").trim();

    const bank = await HRBank.findById(req.params.id);
    if (!bank) return res.status(404).json({ error: "Bank not found" });
    if (direction === "out" && Number(bank.balance || 0) < amount) {
      return res.status(400).json({ error: "Selected bank does not have enough balance" });
    }

    let staff = null;
    let department = null;
    let loan = null;
    let transactionType = direction === "in" ? "manual_in" : "manual_out";
    let beneficiaryName = (req.body.beneficiaryName || "").trim();
    let loanOutstandingAfter = 0;

    if (partyType === "employee") {
      if (!req.body.staff) return res.status(400).json({ error: "Select an employee" });
      staff = await HRStaff.findById(req.body.staff).populate("department");
      if (!staff) return res.status(404).json({ error: "Employee not found" });
      department = staff.department?._id || staff.department || null;
      beneficiaryName = staff.name || beneficiaryName || "Employee";

      if (direction === "out" && ["loan", "advance"].includes(req.body.purpose)) {
        const emi = money(req.body.emi);
        if (emi <= 0) return res.status(400).json({ error: "Salary deduction amount must be greater than 0" });
        if (emi > amount) return res.status(400).json({ error: "Deduction amount cannot be greater than the payment amount" });

        loan = await HRLoan.create({
          staff: staff._id,
          amount,
          outstanding: amount,
          emi,
          category: req.body.purpose === "advance" ? "advance" : "loan",
          issueDate: req.body.issueDate || Date.now(),
          note,
          status: "active",
          createdBy: req.user.id,
        });
        transactionType = req.body.purpose === "advance" ? "advance_out" : "loan_out";
        loanOutstandingAfter = money(loan.outstanding);
      } else if (req.body.loan) {
        loan = await HRLoan.findById(req.body.loan);
        if (!loan) return res.status(404).json({ error: "Loan not found" });
        if (idOfDoc(loan.staff) !== idOfDoc(staff._id)) {
          return res.status(400).json({ error: "Selected loan does not belong to this employee" });
        }
        if (loan.status !== "active" || Number(loan.outstanding || 0) <= 0) {
          return res.status(400).json({ error: "Selected loan is already closed" });
        }
        const repayment = money(Math.min(amount, Number(loan.outstanding || 0)));
        loan.outstanding = money(Math.max(0, Number(loan.outstanding || 0) - repayment));
        loan.repayments.push({ amount: repayment, paidAt: new Date() });
        if (loan.outstanding <= 0) loan.status = "closed";
        await loan.save();
        transactionType = "loan_repayment";
        loanOutstandingAfter = money(loan.outstanding);
      }
    } else {
      if (!beneficiaryName) {
        return res.status(400).json({ error: direction === "in" ? "Sender name is required" : "Receiver name is required" });
      }
    }

    bank.balance = money(Number(bank.balance || 0) + (direction === "in" ? amount : -amount));
    await bank.save();

    const transaction = await HRBankTransaction.create({
      bank: bank._id,
      type: transactionType,
      direction,
      amount,
      staff: staff?._id,
      department,
      loan: loan?._id,
      beneficiaryName,
      beneficiaryAccount,
      note,
      paidAt: new Date(),
      paidBy: req.user.id,
      loanOutstandingAfter,
      bankBalanceAfter: bank.balance,
    });
    await transaction.populate([
      { path: "bank" },
      { path: "staff" },
      { path: "department" },
      { path: "loan" },
    ]);
    if (loan) await loan.populate({ path: "staff", populate: { path: "department" } });
    const recalculatedPayrolls = loan && direction === "out"
      ? await recalculateUnsettledPayrollsForStaff(staff._id, req.user.id)
      : [];

    res.json({
      success: true,
      data: attachSalaryTransactionDetails(transaction.toObject()),
      bank,
      loan,
      payrolls: recalculatedPayrolls,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/loans", async (req, res) => {
  try {
    const filter = {};
    if (req.query.staff) filter.staff = req.query.staff;
    const loans = await HRLoan.find(filter)
      .populate({ path: "staff", populate: { path: "department" } })
      .sort({ createdAt: -1 });
    res.json({ success: true, data: loans });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/loans", async (req, res) => {
  try {
    const amount = money(req.body.amount);
    const emi = money(req.body.emi);
    if (amount <= 0 || emi <= 0) {
      return res.status(400).json({ error: "Amount and deduction must be greater than 0" });
    }
    const loan = await HRLoan.create({
      staff: req.body.staff,
      amount,
      outstanding: req.body.outstanding !== undefined ? money(req.body.outstanding) : amount,
      emi,
      category: req.body.category === "advance" ? "advance" : "loan",
      issueDate: req.body.issueDate || Date.now(),
      note: req.body.note || "",
      status: "active",
      createdBy: req.user.id,
    });
    await loan.populate({ path: "staff", populate: { path: "department" } });
    res.status(201).json({ success: true, data: loan });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/loans/:id", async (req, res) => {
  try {
    const updates = {};
    ["note", "status"].forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });
    if (req.body.category !== undefined) updates.category = req.body.category === "advance" ? "advance" : "loan";
    if (req.body.emi !== undefined) updates.emi = money(req.body.emi);
    if (req.body.outstanding !== undefined) updates.outstanding = money(req.body.outstanding);
    const loan = await HRLoan.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    }).populate({ path: "staff", populate: { path: "department" } });
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    res.json({ success: true, data: loan });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/payroll", async (req, res) => {
  try {
    const filter = {};
    if (req.query.month) filter.month = req.query.month;
    if (req.query.periodEnd) filter.periodEnd = req.query.periodEnd;
    if (req.query.staff) filter.staff = req.query.staff;
    if (req.query.salaryBasis) filter.salaryBasis = salaryBasisQueryValue(req.query.salaryBasis);
    if (req.query.open === "1") filter.status = { $in: ["draft", "partial"] };
    else if (req.query.status) filter.status = req.query.status;
    const requestedCycleDay = req.query.cycleStartDay !== undefined
      ? normalizeCycleDay(req.query.cycleStartDay)
      : null;
    if (requestedCycleDay) filter.cycleStartDay = requestedCycleDay;

    let payrolls = await populatePayroll(HRPayroll.find(filter));
    if (requestedCycleDay) {
      payrolls = payrolls.filter((payroll) => staffPayrollCycleDay(payroll.staff) === requestedCycleDay);
    }
    res.json({ success: true, data: payrolls });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/payroll/generate", async (req, res) => {
  try {
    await syncPayrollIndexes();

    const setting = await getPayrollSetting();
    const fallbackCycleStartDay = normalizeCycleDay(req.body.cycleStartDay || setting.cycleStartDay);
    const dueDate = req.body.dueDate || (
      req.body.month && validMonth(req.body.month)
        ? `${req.body.month}-${String(fallbackCycleStartDay).padStart(2, "0")}`
        : ""
    );
    if (!validDate(dueDate)) return res.status(400).json({ error: "dueDate must be in YYYY-MM-DD format" });

    const requestedSalaryBasis = req.body.salaryBasis ? normalizeSalaryBasis(req.body.salaryBasis) : null;
    const filter = { status: "active" };
    if (requestedSalaryBasis) filter.salaryBasis = salaryBasisQueryValue(requestedSalaryBasis);
    if (req.body.staff) filter._id = req.body.staff;

    const staffList = await HRStaff.find(filter).populate("department");
    if (req.body.staff && staffList[0] && !isStaffPayrollDueOnDate(staffList[0], dueDate)) {
      return res.status(400).json({
        error: "This staff does not have payroll due on the selected date.",
      });
    }
    const results = [];

    for (const staff of staffList) {
      if (!isStaffPayrollDueOnDate(staff, dueDate)) continue;
      const period = buildPeriodForStaff(staff, dueDate);
      const existing = await HRPayroll.findOne({ staff: staff._id, periodEnd: period.periodEnd });
      if (existing?.status === "paid" && hasPayrollSettlement(existing)) {
        results.push(existing);
        continue;
      }

      const payrollData = await buildPayrollForStaff(staff, period, req.user.id, existing);
      if (!payrollData) continue;

      const payroll = await HRPayroll.findOneAndUpdate(
        { staff: staff._id, periodEnd: period.periodEnd },
        payrollData,
        { upsert: true, new: true, runValidators: true }
      );
      results.push(payroll);
    }

    const ids = results.map((item) => item._id);
    const payrolls = await populatePayroll(HRPayroll.find({ _id: { $in: ids } }));
    res.json({ success: true, data: payrolls });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/payroll/:id/pay", async (req, res) => {
  try {
    const payroll = await HRPayroll.findById(req.params.id);
    if (!payroll) return res.status(404).json({ error: "Payroll not found" });
    if (payroll.status === "paid") return res.status(400).json({ error: "Payroll is already paid" });
    payroll.salaryBasis = normalizeSalaryBasis(payroll.salaryBasis);

    if (!hasPayrollSettlement(payroll)) {
      const staff = await HRStaff.findById(payroll.staff).populate("department");
      if (staff) {
        const periodStart = payroll.periodStart || payroll.periodEnd;
        const period = ["daily", "hourly"].includes(payroll.salaryBasis)
          ? {
            cycleStartDay: payroll.cycleStartDay || staffPayrollCycleDay(staff),
            periodStart,
            periodEnd: payroll.periodEnd,
            attendanceStart: periodStart,
            attendanceEnd: formatUTCDate(addDays(parseUTCDate(periodStart), 1)),
            periodLabel: payroll.periodLabel || payroll.periodEnd,
            month: payroll.month || payroll.periodEnd?.slice(0, 7),
          }
          : {
            cycleStartDay: payroll.cycleStartDay || cycleDayFromDate(payroll.periodEnd),
            periodStart,
            periodEnd: payroll.periodEnd,
            periodLabel: payroll.periodLabel || periodLabel(periodStart, payroll.periodEnd),
            month: payroll.month || payroll.periodEnd?.slice(0, 7),
          };
        const refreshed = await buildPayrollForStaff(staff, period, payroll.generatedBy || req.user.id, payroll);
        if (refreshed) {
          Object.assign(payroll, refreshed);
          await payroll.save();
        }
      }
    }
    if (payroll.status === "paid") return res.status(400).json({ error: "Payroll is already paid" });

    const payAmount = money(req.body.amount === undefined ? payroll.balanceDue : req.body.amount);
    if (payAmount <= 0) return res.status(400).json({ error: "Payment amount must be greater than 0" });
    if (payAmount > Number(payroll.balanceDue || 0)) {
      return res.status(400).json({ error: "Payment amount cannot be greater than current due" });
    }

    const bank = await HRBank.findById(req.body.bankId);
    if (!bank) return res.status(404).json({ error: "Bank not found" });
    if (Number(bank.balance || 0) < payAmount) {
      return res.status(400).json({ error: "Selected bank does not have enough balance" });
    }

    bank.balance = money(Number(bank.balance || 0) - payAmount);
    await bank.save();

    const paymentLoanDeductions = !payroll.loanRepaymentApplied ? loanDeductionsSnapshot(payroll) : [];
    const paymentLoanDeduction = money(paymentLoanDeductions.reduce((sum, item) => sum + item.amount, 0));

    if (!payroll.loanRepaymentApplied) {
      for (const item of payroll.loanDeductions || []) {
        if (!item.loan || Number(item.amount || 0) <= 0) continue;
        const loan = await HRLoan.findById(item.loan);
        if (!loan || loan.status !== "active") continue;
        loan.outstanding = money(Math.max(0, Number(loan.outstanding || 0) - Number(item.amount || 0)));
        loan.repayments.push({ payroll: payroll._id, amount: item.amount, paidAt: new Date() });
        if (loan.outstanding <= 0) loan.status = "closed";
        await loan.save();
      }
      payroll.loanRepaymentApplied = true;
    }

    payroll.totalPaid = money(Number(payroll.totalPaid || 0) + payAmount);
    payroll.balanceDue = money(Math.max(0, Number(payroll.netPay || 0) - Number(payroll.totalPaid || 0)));
    payroll.status = payroll.balanceDue <= 0 ? "paid" : "partial";
    payroll.bank = bank._id;
    if (payroll.status === "paid") payroll.paidAt = new Date();
    payroll.paidBy = req.user.id;
    const paymentEntry = {
      bank: bank._id,
      amount: payAmount,
      paidAt: new Date(),
      paidBy: req.user.id,
      note: req.body.note || "",
    };
    payroll.paymentHistory.push(paymentEntry);
    await payroll.save();

    const savedPayment = payroll.paymentHistory[payroll.paymentHistory.length - 1];
    const staff = await HRStaff.findById(payroll.staff).populate("department").lean();
    const transaction = await HRBankTransaction.create({
      bank: bank._id,
      type: "salary",
      direction: "out",
      amount: payAmount,
      staff: payroll.staff,
      department: payroll.department || staff?.department?._id || staff?.department || null,
      payroll: payroll._id,
      paymentHistoryId: savedPayment?._id,
      payrollPeriodLabel: payroll.periodLabel || payroll.periodEnd || payroll.month || "",
      grossSalary: money(payroll.grossSalary),
      netPay: money(payroll.netPay),
      loanDeduction: paymentLoanDeduction,
      loanDeductions: paymentLoanDeductions,
      beneficiaryName: staff?.name || "Staff",
      beneficiaryAccount: "",
      note: req.body.note || "",
      paidAt: savedPayment?.paidAt || new Date(),
      paidBy: req.user.id,
      bankBalanceAfter: bank.balance,
    });
    await transaction.populate([
      { path: "bank" },
      { path: "staff" },
      { path: "department" },
      { path: "payroll", populate: [{ path: "loanDeductions.loan" }] },
      { path: "loanDeductions.loan" },
    ]);

    const populated = await populatePayroll(HRPayroll.findById(payroll._id));
    res.json({ success: true, data: populated, bank, transaction: attachSalaryTransactionDetails(transaction.toObject()) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/meta/days", (req, res) => {
  res.json({ success: true, data: DAY_NAMES });
});

module.exports = router;

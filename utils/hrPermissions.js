const HR_PERMISSION_KEYS = [
  "canViewBanks",
  "canManageBanks",
  "canMakePayments",
  "canManageAdvances",
  "canAddStaff",
  "canEditStaff",
  "canDeleteStaff",
  "canMarkAttendance",
  "canGenerateSalarySlip",
];

const DEFAULT_HR_PERMISSIONS = HR_PERMISSION_KEYS.reduce((acc, key) => {
  acc[key] = true;
  return acc;
}, {});

const normalizeHrPermissions = (permissions = {}) => {
  const source = permissions && typeof permissions === "object" ? permissions : {};
  return HR_PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = source[key] !== undefined ? Boolean(source[key]) : true;
    return acc;
  }, {});
};

const hasAllHrPermissions = (role) => ["super_to_super_admin", "super_admin"].includes(role);

const userHasHrPermission = (user, permission) => {
  if (!permission || hasAllHrPermissions(user?.role)) return true;
  const permissions = normalizeHrPermissions(user?.hrPermissions);
  return permissions[permission] === true;
};

module.exports = {
  HR_PERMISSION_KEYS,
  DEFAULT_HR_PERMISSIONS,
  normalizeHrPermissions,
  hasAllHrPermissions,
  userHasHrPermission,
};

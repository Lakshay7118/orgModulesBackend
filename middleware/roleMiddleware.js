const allowRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user?.role) {
      return res.status(403).json({
        message: "Role not found in token",
      });
    }

    if (req.user.role === "super_to_super_admin") {
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Access denied for role: ${req.user.role}`,
      });
    }

    next();
  };
};

module.exports = allowRoles;

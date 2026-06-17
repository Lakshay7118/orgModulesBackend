const moduleNames = ["hr", "task", "chat"];

const requireModule = (moduleName) => {
  if (!moduleNames.includes(moduleName)) {
    throw new Error(`Unknown module permission: ${moduleName}`);
  }

  return (req, res, next) => {
    if (req.user?.role === "super_to_super_admin") return next();

    const allowedModules = Array.isArray(req.user?.allowedModules)
      ? req.user.allowedModules
      : [];

    if (!allowedModules.includes(moduleName)) {
      return res.status(403).json({
        error: `Your organization does not have access to the ${moduleName} module`,
      });
    }

    next();
  };
};

module.exports = requireModule;

const jwt = require("jsonwebtoken");
const User = require("../models/Users");

const protect = async (req, res, next) => {
  try {
    if (req.headers.authorization?.startsWith("Bearer")) {
      const token = req.headers.authorization.split(" ")[1];

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id)
        .select("name phone email role isActive organization allowedModules")
        .lean();

      if (!user) {
        return res.status(401).json({ message: "Invalid token" });
      }

      if (user.isActive === false) {
        return res.status(403).json({ message: "Account inactive. Contact admin." });
      }

      req.user = {
        ...decoded,
        id: user._id.toString(),
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        organization: user.organization,
        allowedModules: user.allowedModules || [],
        isActive: user.isActive !== false,
      };
      return next();
    }

    return res.status(401).json({ message: "No token provided" });
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

module.exports = protect;

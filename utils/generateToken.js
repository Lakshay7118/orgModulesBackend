const jwt = require("jsonwebtoken");

const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      phone: user.phone,
      email: user.email,
      role: user.role,
      organization: user.organization,
      allowedModules: user.allowedModules || [],
      isActive: user.isActive !== false,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

module.exports = generateToken;

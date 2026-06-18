const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const Contact = require("./models/Contact");
const User = require("./models/Users");
require("dotenv").config();

async function makeAdmin() {
  await mongoose.connect(process.env.MONGO_URI);

  const phone = process.env.MAKE_ADMIN_PHONE || "6376245999";
  const email = (process.env.MAKE_ADMIN_EMAIL || "lakshyamehra321@gmail.com").trim().toLowerCase();
  const password = process.env.MAKE_ADMIN_PASSWORD || "123456";
  const name = process.env.MAKE_ADMIN_NAME || "lakshya";

  if (!email) throw new Error("MAKE_ADMIN_EMAIL is required");
  if (!password || password.length < 6) {
    throw new Error("MAKE_ADMIN_PASSWORD must be at least 6 characters");
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await Contact.updateOne(
    { mobile: phone },
    {
      $set: {
        name,
        mobile: phone,
        email,
        role: "super_to_super_admin",
        status: "approved",
        createdBy: null,
      },
    },
    { upsert: true }
  );

  await User.updateOne(
    { email },
    {
      $set: {
        name,
        email,
        phone,
        password: hashedPassword,
        role: "super_to_super_admin",
        allowedModules: ["hr", "task", "chat"],
        isActive: true,
        organization: null,
      },
    },
    { upsert: true }
  );

  console.log("Super to super admin created/updated");
  console.log("Email:", email);
  console.log("Phone:", phone);
  process.exit(0);
}

makeAdmin().catch((error) => {
  console.error("Failed to create super to super admin:", error.message);
  process.exit(1);
});

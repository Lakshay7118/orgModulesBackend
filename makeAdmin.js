const mongoose = require("mongoose");
const Contact = require("./models/Contact");
const User = require("./models/Users");
require("dotenv").config();

async function makeAdmin() {
  await mongoose.connect(process.env.MONGO_URI);

  const phone = "6376245999";
  const name  = "lakshya"; // change if needed

  // ✅ upsert = update if exists, CREATE if not
  await Contact.updateOne(
    { mobile: phone },
    {
      $set: {
        name,
        mobile: phone,
        role: "super_to_super_admin",
        status: "approved",
        createdBy: null,
      }
    },
    { upsert: true } // ← KEY FIX
  );

  await User.updateOne(
    { phone },
    {
      $set: {
        name,
        phone,
        role: "super_to_super_admin",
        allowedModules: ["hr", "task", "chat"],
      }
    },
    { upsert: true } // ← KEY FIX
  );

  console.log("✅ Super admin created/updated for", phone);
  process.exit(0);
}

makeAdmin();

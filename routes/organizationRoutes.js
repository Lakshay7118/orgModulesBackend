const express = require("express");
const bcrypt = require("bcryptjs");
const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");
const Organization = require("../models/Organization");
const User = require("../models/Users");
const Contact = require("../models/Contact");
const HRDepartment = require("../models/HRDepartment");
const HRStaff = require("../models/HRStaff");
const Task = require("../models/Task");
const UserTaskStatus = require("../models/UserTaskStatus");
const generateToken = require("../utils/generateToken");

const router = express.Router();

const MODULES = ["hr", "task", "chat"];
const SUPER_ADMIN_SELECT = "name phone email role allowedModules isActive";

const cleanModules = (modules = []) => {
  if (!Array.isArray(modules)) return [];
  return [...new Set(modules.filter((moduleName) => MODULES.includes(moduleName)))];
};

const populateOrganization = (query) =>
  query.populate("superAdmin", SUPER_ADMIN_SELECT).lean();

router.get("/", protect, allowRoles("super_to_super_admin"), async (req, res) => {
  try {
    const organizations = await Organization.find()
      .populate("superAdmin", SUPER_ADMIN_SELECT)
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: organizations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/", protect, allowRoles("super_to_super_admin"), async (req, res) => {
  try {
    const {
      organizationName,
      superAdminName,
      superAdminPhone,
      superAdminEmail,
      superAdminPassword,
      allowedModules,
    } = req.body;

    if (!organizationName?.trim()) {
      return res.status(400).json({ error: "Organization name is required" });
    }
    if (!superAdminEmail?.trim()) {
      return res.status(400).json({ error: "Super admin email is required" });
    }
    if (!superAdminPassword || String(superAdminPassword).length < 6) {
      return res.status(400).json({ error: "Super admin password must be at least 6 characters" });
    }

    const modules = cleanModules(allowedModules);
    if (modules.length === 0) {
      return res.status(400).json({ error: "Select at least one module" });
    }

    const email = superAdminEmail.trim().toLowerCase();
    const existingEmail = await User.findOne({ email });
    if (existingEmail) return res.status(400).json({ error: "Super admin email already exists" });

    if (superAdminPhone) {
      const existingPhone = await User.findOne({ phone: superAdminPhone });
      if (existingPhone) return res.status(400).json({ error: "Super admin phone already exists" });
    }

    const organization = await Organization.create({
      name: organizationName.trim(),
      allowedModules: modules,
      createdBy: req.user.id,
    });

    const superAdmin = await User.create({
      name: superAdminName?.trim() || organizationName.trim(),
      phone: superAdminPhone || undefined,
      email,
      password: await bcrypt.hash(superAdminPassword, 10),
      role: "super_admin",
      organization: organization._id,
      allowedModules: modules,
      createdBy: req.user.id,
    });

    organization.superAdmin = superAdmin._id;
    await organization.save();

    const populatedOrganization = await populateOrganization(Organization.findById(organization._id));

    res.status(201).json({
      success: true,
      data: {
        organization: populatedOrganization,
        superAdmin: {
          id: superAdmin._id,
          name: superAdmin.name,
          phone: superAdmin.phone,
          email: superAdmin.email,
          role: superAdmin.role,
          organization: superAdmin.organization,
          allowedModules: superAdmin.allowedModules,
          isActive: superAdmin.isActive !== false,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/:id", protect, allowRoles("super_to_super_admin"), async (req, res) => {
  try {
    const { organizationName, superAdminName, superAdminPhone, allowedModules, isActive } = req.body;

    if (!organizationName?.trim()) {
      return res.status(400).json({ error: "Organization name is required" });
    }
    if (superAdminPhone && !/^\d{6,15}$/.test(String(superAdminPhone).trim())) {
      return res.status(400).json({ error: "Enter a valid super admin phone number" });
    }

    const modules = cleanModules(allowedModules);
    if (modules.length === 0) {
      return res.status(400).json({ error: "Select at least one module" });
    }

    const organization = await Organization.findById(req.params.id);
    if (!organization) return res.status(404).json({ error: "Organization not found" });

    organization.name = organizationName.trim();
    organization.allowedModules = modules;
    if (typeof isActive === "boolean") organization.isActive = isActive;
    await organization.save();

    if (organization.superAdmin && (superAdminName !== undefined || superAdminPhone !== undefined)) {
      const superAdminUpdates = {};
      if (superAdminName !== undefined) {
        superAdminUpdates.name = String(superAdminName || "").trim() || organization.name;
      }
      if (superAdminPhone !== undefined) {
        const phone = String(superAdminPhone || "").trim();
        if (phone) {
          const existingPhone = await User.findOne({ phone, _id: { $ne: organization.superAdmin } });
          if (existingPhone) return res.status(400).json({ error: "Super admin phone already exists" });
          superAdminUpdates.phone = phone;
        } else {
          superAdminUpdates.$unset = { phone: "" };
        }
      }
      if (Object.keys(superAdminUpdates).length) {
        await User.findByIdAndUpdate(organization.superAdmin, superAdminUpdates, { runValidators: true });
      }
    }

    await User.updateMany(
      { organization: organization._id },
      { $set: { allowedModules: modules } }
    );

    const updatedOrganization = await populateOrganization(Organization.findById(organization._id));
    res.json({ success: true, data: updatedOrganization });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/:id/super-admin/email", protect, allowRoles("super_to_super_admin"), async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }

    const organization = await Organization.findById(req.params.id);
    if (!organization) return res.status(404).json({ error: "Organization not found" });
    if (!organization.superAdmin) return res.status(404).json({ error: "Super admin not found" });

    const existingEmail = await User.findOne({ email, _id: { $ne: organization.superAdmin } });
    if (existingEmail) return res.status(400).json({ error: "Email already exists" });

    await User.findByIdAndUpdate(organization.superAdmin, { email }, { runValidators: true });

    const updatedOrganization = await populateOrganization(Organization.findById(organization._id));
    res.json({ success: true, data: updatedOrganization });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/:id/super-admin/password", protect, allowRoles("super_to_super_admin"), async (req, res) => {
  try {
    const password = String(req.body.password || "");
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const organization = await Organization.findById(req.params.id);
    if (!organization) return res.status(404).json({ error: "Organization not found" });
    if (!organization.superAdmin) return res.status(404).json({ error: "Super admin not found" });

    await User.findByIdAndUpdate(organization.superAdmin, {
      password: await bcrypt.hash(password, 10),
    });

    const updatedOrganization = await populateOrganization(Organization.findById(organization._id));
    res.json({ success: true, message: "Password updated", data: updatedOrganization });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/login-as", protect, allowRoles("super_to_super_admin"), async (req, res) => {
  try {
    const organization = await Organization.findById(req.params.id).populate("superAdmin");
    if (!organization) return res.status(404).json({ error: "Organization not found" });
    const superAdmin = organization.superAdmin;
    if (!superAdmin) return res.status(404).json({ error: "Super admin not found" });
    if (superAdmin.isActive === false || organization.isActive === false) {
      return res.status(403).json({ error: "Organization or super admin is inactive" });
    }

    const token = generateToken(superAdmin);
    res.json({
      success: true,
      token,
      user: {
        id: superAdmin._id,
        name: superAdmin.name,
        email: superAdmin.email,
        phone: superAdmin.phone,
        role: superAdmin.role,
        organization: superAdmin.organization,
        organizationName: organization.name || "",
        allowedModules: superAdmin.allowedModules || [],
        isActive: superAdmin.isActive !== false,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/:id", protect, allowRoles("super_to_super_admin"), async (req, res) => {
  try {
    const organization = await Organization.findById(req.params.id);
    if (!organization) return res.status(404).json({ error: "Organization not found" });

    const orgUsers = await User.find({ organization: organization._id }).select("_id").lean();
    const orgUserIds = orgUsers.map((user) => user._id);
    const orgOwnedQuery = {
      $or: [
        { organization: organization._id },
        { organization: null, createdBy: { $in: orgUserIds } },
      ],
    };
    const orgTaskIds = await Task.find(orgOwnedQuery).select("_id").lean();

    await Promise.all([
      User.deleteMany({ organization: organization._id }),
      Contact.deleteMany(orgOwnedQuery),
      HRDepartment.deleteMany(orgOwnedQuery),
      HRStaff.deleteMany(orgOwnedQuery),
      Task.deleteMany(orgOwnedQuery),
      UserTaskStatus.deleteMany({ taskId: { $in: orgTaskIds.map((task) => task._id) } }),
    ]);

    await Organization.deleteOne({ _id: organization._id });

    res.json({ success: true, data: { id: req.params.id } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

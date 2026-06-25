const express = require("express");
const Tag = require("../models/Tag");
const User = require("../models/Users");
const mongoose = require("mongoose");

const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware"); // 🔥 ADD

const router = express.Router();

const sameId = (left, right) => left && right && left.toString() === right.toString();

const organizationUserIds = async (organization) => {
  if (!organization) return [];
  const users = await User.find({ organization }).select("_id").lean();
  return users.map((user) => user._id);
};

const tagOrganizationScope = async (req) => {
  if (req.user.role === "super_to_super_admin") return {};
  if (!req.user.organization) return { createdBy: req.user.id };
  const orgUsers = await organizationUserIds(req.user.organization);
  return {
    $or: [
      { organization: req.user.organization },
      { organization: null, createdBy: { $in: orgUsers.map((id) => id.toString()) } },
    ],
  };
};

const canAccessTag = async (req, tag) => {
  if (!tag) return false;
  if (req.user.role === "super_to_super_admin") return true;
  if (sameId(tag.organization, req.user.organization)) return true;
  if (!tag.organization && tag.createdBy) {
    const creator = await User.findById(tag.createdBy).select("organization").lean();
    return sameId(creator?.organization, req.user.organization);
  }
  return false;
};

const enrichTagsWithCreators = async (tags = []) => {
  const plainTags = tags.map((tag) =>
    typeof tag.toObject === "function" ? tag.toObject() : tag
  );
  const creatorIds = [
    ...new Set(
      plainTags
        .map((tag) => String(tag.createdBy || ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];

  const users = await User.find({ _id: { $in: creatorIds } })
    .select("_id name phone email role")
    .lean();
  const usersById = new Map(users.map((user) => [String(user._id), user]));

  return plainTags.map((tag) => {
    const creator = usersById.get(String(tag.createdBy));
    return {
      ...tag,
      createdByUser: creator
        ? {
            _id: creator._id,
            name: creator.name,
            phone: creator.phone,
            email: creator.email,
            role: creator.role,
          }
        : null,
    };
  });
};


// =======================
// ✅ GET ALL TAGS (ALL ROLES)
// =======================
router.get(
  "/tags",
  protect,
  allowRoles("super_admin", "manager", "user"),
  async (req, res) => {
    try {
      const filter = await tagOrganizationScope(req);

      // ❌ REMOVE this restriction
      // if (req.user.role === "manager") {
      //   filter.createdBy = req.user.id;
      // }

      const tags = await Tag.find(filter)
        .sort({ createdAt: -1 });

      res.json({ success: true, tags: await enrichTagsWithCreators(tags) });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


// =======================
// ✅ CREATE TAG (ADMIN + MANAGER)
// =======================
router.post(
  "/tags",
  protect,
  allowRoles("super_admin", "manager"),
  async (req, res) => {
    try {
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Tag name required" });
      }

      // 🔥 prevent duplicate tags
      const organization = req.user.organization || null;
      const orgUsers = organization ? await organizationUserIds(organization) : [];
      const existing = await Tag.findOne(
        organization
          ? {
              name,
              $or: [
                { organization },
                { organization: null, createdBy: { $in: orgUsers.map((id) => id.toString()) } },
              ],
            }
          : { name, createdBy: req.user.id }
      );

      if (existing) {
        return res.status(400).json({ error: "Tag already exists" });
      }

      const tag = new Tag({
        name,
        organization,
        createdBy: req.user.id, // 🔐 secure
      });

      await tag.save();

      const [enrichedTag] = await enrichTagsWithCreators([tag]);
      res.status(201).json({ success: true, tag: enrichedTag });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


// =======================
// ✅ UPDATE TAG (ADMIN + MANAGER)
// =======================
router.put(
  "/tags/:id",
  protect,
  allowRoles("super_admin", "manager"),
  async (req, res) => {
    try {
      const { status, name } = req.body;

      const tag = await Tag.findById(req.params.id);

      if (!tag) {
        return res.status(404).json({ error: "Tag not found" });
      }
      if (!(await canAccessTag(req, tag))) {
        return res.status(404).json({ error: "Tag not found" });
      }

      // 🔥 manager can update only own tags
      if (
        req.user.role === "manager" &&
        tag.createdBy.toString() !== req.user.id
      ) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (name !== undefined) {
        const orgUsers = tag.organization ? await organizationUserIds(tag.organization) : [];
        const existing = await Tag.findOne(
          tag.organization
            ? {
                name,
                _id: { $ne: tag._id },
                $or: [
                  { organization: tag.organization },
                  { organization: null, createdBy: { $in: orgUsers.map((id) => id.toString()) } },
                ],
              }
            : { name, createdBy: tag.createdBy, _id: { $ne: tag._id } }
        );
        if (existing) return res.status(400).json({ error: "Tag already exists" });
        tag.name = name;
      }
      if (status !== undefined) tag.status = status;
      if (!tag.organization && req.user.organization) tag.organization = req.user.organization;

      await tag.save();

      const [enrichedTag] = await enrichTagsWithCreators([tag]);
      res.json({ success: true, tag: enrichedTag });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


// =======================
// ✅ DELETE TAG (ONLY SUPER ADMIN)
// =======================
router.delete(
  "/tags/:id",
  protect,
  allowRoles("super_admin"),
  async (req, res) => {
    try {
      const tag = await Tag.findById(req.params.id);

      if (!tag) {
        return res.status(404).json({ error: "Tag not found" });
      }
      if (!(await canAccessTag(req, tag))) {
        return res.status(404).json({ error: "Tag not found" });
      }

      await tag.deleteOne();

      res.json({ success: true });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


module.exports = router;

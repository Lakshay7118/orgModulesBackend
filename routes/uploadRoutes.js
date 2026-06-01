const express = require("express");
const multer = require("multer");
const router = express.Router();
const path = require("path");

const cloudinary = require("../config/cloudinary");
const protect = require("../middleware/authMiddleware");

// =======================
// ✅ MULTER CONFIG
// =======================
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

// =======================
// 🔥 ALLOWED TYPES
// =======================
const allowedTypes = [
  "image/",
  "video/",
  "audio/",          // ✅ ADD THIS LINE
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "text/plain",
  "application/zip",
  "application/json",
  "application/xml",
  "text/xml",
];

router.post("/download", protect, async (req, res) => {
  try {
    const { url, fileName } = req.body || {};
    if (!url) return res.status(400).json({ error: "File URL is required" });

    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("cloudinary.com")) {
      return res.status(400).json({ error: "Unsupported file host" });
    }

    const upstream = await fetch(parsed.toString());
    if (!upstream.ok) {
      return res.status(502).json({ error: "Could not fetch file" });
    }

    const safeName = path.basename(fileName || "attachment").replace(/[\r\n"]/g, "_");
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    return res.send(buffer);
  } catch (err) {
    console.error("Download Error:", err);
    return res.status(500).json({ error: "Download failed" });
  }
});

// =======================
// 🔥 UPLOAD FILE
// =======================
router.post("/", protect, upload.single("file"), async (req, res) => {
  try {
    const userPhone = req.user.phone;
    const userRole = req.user.role;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.file;

    // ================= TYPE VALIDATION =================
    const isAllowed = allowedTypes.some(type =>
      type.endsWith("/")
        ? file.mimetype.startsWith(type)
        : file.mimetype === type
    );

    if (!isAllowed) {
      return res.status(400).json({ error: "File type not allowed" });
    }

    // ================= DETERMINE TYPE =================
// ================= DETERMINE TYPE =================
const isImage = file.mimetype.startsWith("image/");
const isVideo = file.mimetype.startsWith("video/");
const isAudio = file.mimetype.startsWith("audio/");   // ✅ ADD

// Cloudinary uses "video" resource_type for audio files too
const resource_type = isVideo || isAudio ? "video" : isImage ? "image" : "raw";  // ✅ CHANGE

const messageType = isImage ? "image" : isVideo ? "video" : isAudio ? "audio" : "file";  // ✅ CHANGE

    // ================= SIZE VALIDATION =================
    const safeStem = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-z0-9_-]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "file";
    const originalExt = path.extname(file.originalname).toLowerCase();
    const publicId = `${userRole}_${userPhone}_${Date.now()}_${safeStem}${resource_type === "raw" ? originalExt : ""}`;

    if (file.size > 50 * 1024 * 1024) {
      return res.status(400).json({ error: "File too large. Max 50MB allowed." });
    }

    // ================= CLOUDINARY UPLOAD =================
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type, // ✅ "raw" for PDFs/docs, "image" for images, "video" for videos
        folder: "chat_uploads",
        public_id: publicId,
        use_filename: true,
      },
      (error, result) => {
        if (error) {
          console.error("Cloudinary Error:", error);
          return res.status(error.http_code || 500).json({
            error: error.http_code === 413 ? "File too large for upload" : "Upload failed",
            details: error.message,
          });
        }

        return res.json({
          fileUrl: result.secure_url,
          fileName: file.originalname,
          fileSize: file.size,
          messageType, // ✅ "image" | "video" | "file"
          uploadedBy: userPhone,
          role: userRole,
        });
      }
    );

    stream.end(file.buffer);

  } catch (err) {
    console.error("Upload Error:", err);
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// =======================
// ✅ MULTER ERROR HANDLER
// =======================
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Max 50MB allowed." });
    }
  }
  next(err);
});

module.exports = router;

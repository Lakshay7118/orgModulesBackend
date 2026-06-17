// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const connectDB = require("./config/db");
const { initSocket } = require("./sockets/socket");

// Routes
const messageRoutes = require("./routes/messageRoutes");
const chatRoutes = require("./routes/chatRoutes");
const userRoutes = require("./routes/userRoutes");
const contactRoutes = require("./routes/contactRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const groupRoutes = require("./routes/groupRoutes");
const templateRoutes = require("./routes/templateRoutes");
const campaignRoutes = require("./routes/campaignRoutes");
const tagRoutes = require("./routes/tagRoutes");
const taskRoutes = require("./routes/taskRoutes");
const hrRoutes = require("./routes/hrRoutes");
const organizationRoutes = require("./routes/organizationRoutes");
const protect = require("./middleware/authMiddleware");
const requireModule = require("./middleware/moduleMiddleware");
const notificationRoutes =
require("./routes/notificationRoutes");
const rtcRoutes = require("./routes/rtcRoutes");
require("./jobs/taskReminder");


const app = express();
const server = http.createServer(app);

console.log("BOOTING SERVER FILE:", __filename);
console.log("DEPLOY VERSION:", "2026-06-10-hr-deploy-check-v2");

app.use((req, res, next) => {
  console.log("REQ HIT:", req.method, req.originalUrl);
  next();
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend working",
  });
}); 

app.get("/api/deploy-check", (req, res) => {
  res.json({
    success: true,
    service: "whatsapp-backend",
    serverFile: "backend/server.js",
    hrRoutesMountedAt: "/api/hr",
    deployedAt: "2026-06-10-hr-routes-check",
  });
});

// 🔥 CORS
app.use(cors({ origin: "*" }));

// 🔥 IMPORTANT: Increase body size limit (FIX 413 ERROR)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Serve uploaded files statically
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Database connection
connectDB();

// Initialize Socket.io
const io = initSocket(server);
app.set("io", io);

// Routes
app.use("/api/messages", protect, requireModule("chat"), messageRoutes);
app.use("/api/chats", protect, requireModule("chat"), chatRoutes);
app.use("/api/users", userRoutes);
app.use("/api", contactRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api", tagRoutes);
app.use("/api/groups", protect, requireModule("chat"), groupRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/tasks", protect, requireModule("task"), taskRoutes);
app.use("/api/hr", protect, hrRoutes);
app.use(
  "/api/notifications",
  notificationRoutes
);
app.use("/api/rtc", rtcRoutes);
app.use("/api", protect, requireModule("chat"), templateRoutes);
app.use("/api", protect, requireModule("chat"), campaignRoutes);

// Test route
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// Start cron jobs
require("./jobs/campaignScheduler");

const PORT = process.env.PORT || 5000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

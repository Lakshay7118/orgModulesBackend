const crypto = require("crypto");
const express = require("express");

const protect = require("../middleware/authMiddleware");

const router = express.Router();

const DEFAULT_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

const parseUrls = (value = "") =>
  String(value)
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

const createCoturnCredential = ({ userId, secret, ttlSeconds }) => {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${userId || "user"}`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");

  return { username, credential, expiresAt: new Date(expiry * 1000).toISOString() };
};

router.get("/ice-servers", protect, (req, res) => {
  const stunUrls = parseUrls(process.env.STUN_URLS);
  const turnUrls = parseUrls(process.env.TURN_URLS || process.env.TURN_URL);
  const ttlSeconds = Number(process.env.TURN_TTL_SECONDS || 3600);
  const iceServers = [
    {
      urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS,
    },
  ];

  let expiresAt = null;

  if (turnUrls.length > 0) {
    let username = process.env.TURN_USERNAME;
    let credential = process.env.TURN_CREDENTIAL;

    if (process.env.TURN_SECRET) {
      const generated = createCoturnCredential({
        userId: req.user?.phone || req.user?.id || req.user?._id,
        secret: process.env.TURN_SECRET,
        ttlSeconds,
      });
      username = generated.username;
      credential = generated.credential;
      expiresAt = generated.expiresAt;
    }

    iceServers.push({
      urls: turnUrls,
      username,
      credential,
    });
  }

  res.json({
    success: true,
    iceServers,
    iceTransportPolicy: "all",
    ttlSeconds,
    expiresAt,
  });
});

module.exports = router;

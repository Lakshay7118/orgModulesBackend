const express = require("express");
const router = express.Router();

const Chat = require("../models/chat");
const Message = require("../models/Message");
const enrichChat = require("../utils/enrichChat");
const { findLastMessagePreview } = require("../utils/chatPreview");
const { getIO } = require("../sockets/socket");

const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");


// =======================
// ✅ CREATE CHAT (ALL ROLES)
// =======================
router.post("/", protect, async (req, res) => {
  try {
    const senderPhone = req.user?.phone;
    const { receiverPhone } = req.body;
    console.log("test from chatroute");

    if (!senderPhone) throw new Error("senderPhone missing from JWT");
    if (!receiverPhone) return res.status(400).json({ error: "receiverPhone is required" });

    let chat = await Chat.findOne({
      participants: { $all: [senderPhone, receiverPhone] },
    });

    if (!chat) {
      chat = await Chat.create({ participants: [senderPhone, receiverPhone] });
    } else {
      chat = await Chat.findByIdAndUpdate(
        chat._id,
        { $pull: { deletedBy: senderPhone } },
        { new: true }
      );
    }

    return res.json(chat);
  } catch (err) {
    console.error("CREATE CHAT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


// =======================
// ✅ GET USER CHATS (ALL ROLES)
// =======================
router.get("/", protect, async (req, res) => {
  try {
    const userPhone = req.user.phone;

    const chats = await Chat.find({
      participants: { $in: [userPhone] },
      deletedBy: { $ne: userPhone },
    }).sort({ updatedAt: -1 });

    const enrichedChats = await Promise.all(
      chats.map(async (chat) => {
        const enriched = await enrichChat(chat, userPhone);

        const visibleLastMessage = await findLastMessagePreview(chat._id, {
          excludeDeletedBy: userPhone,
        });

        return { ...enriched, lastMessage: visibleLastMessage };
      })
    );

    res.json(enrichedChats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// =======================
// ✅ CLEAR CHAT MESSAGES (ALL ROLES — clears for self only)
// =======================
router.delete("/clear/:chatId", protect, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userPhone = req.user.phone;
    const userRole = req.user.role;

    const chat = await Chat.findById(chatId);
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    const isParticipant = chat.participants.some(p => String(p) === String(userPhone));
    const isAdmin = ["super_admin", "manager"].includes(userRole);

    if (!isParticipant && !isAdmin) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // Mark all messages as deleted for this user only
    await Message.updateMany(
      { chatId },
      { $addToSet: { deletedBy: userPhone } }
    );

    res.json({ message: "Chat cleared successfully" });
  } catch (err) {
    console.error("CLEAR CHAT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


// =======================
// ✅ SOFT DELETE CHAT — Delete for me (ALL ROLES)
// =======================
router.delete("/:chatId", protect, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userPhone = req.user.phone;
    const userRole = req.user.role;

    const chat = await Chat.findById(chatId);
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    const isParticipant = chat.participants.some(p => String(p) === String(userPhone));
    const isAdmin = ["super_admin", "manager"].includes(userRole);

    if (!isParticipant && !isAdmin) {
      return res.status(403).json({ error: "Not authorized to delete this chat" });
    }

    await Chat.findByIdAndUpdate(
      chatId,
      { $addToSet: { deletedBy: userPhone } },
      { new: true }
    );

    const io = getIO();
    io.to(userPhone).emit("chatDeleted", { chatId, userPhone });

    res.json({ message: "Chat deleted for you successfully" });
  } catch (err) {
    console.error("DELETE CHAT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


// =======================
// ✅ PERMANENT DELETE CHAT — Hard delete from DB (super_admin ONLY)
// =======================
router.delete("/:chatId/permanent", protect, allowRoles("super_admin"), async (req, res) => {
  try {
    const { chatId } = req.params;

    const chat = await Chat.findById(chatId);
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    // Delete all messages in this chat
    await Message.deleteMany({ chatId });

    // Delete the chat itself
    await Chat.findByIdAndDelete(chatId);

    const io = getIO();
    // Notify ALL participants that this chat is gone permanently
    chat.participants.forEach(phone => {
      io.to(phone).emit("chatDeletedPermanently", { chatId });
    });

    res.json({ message: "Chat permanently deleted from database" });
  } catch (err) {
    console.error("PERMANENT DELETE CHAT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;

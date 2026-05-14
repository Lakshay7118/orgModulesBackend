const express = require("express");
const router = express.Router();

const Message = require("../models/Message");
const Chat = require("../models/chat");
const Contact = require("../models/Contact");
const Template = require("../models/Template");

const resolveTemplate = require("../utils/resolveTemplate");
const { getIO } = require("../sockets/socket");

const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware"); // 🔥 ADD
// =======================
// ✅ GET MESSAGES (SECURE)
// =======================
router.get("/", protect, async (req, res) => {
  try {
    const { chatId } = req.query;
    const userPhone = req.user.phone;

    if (!chatId) {
      return res.status(400).json({ error: "chatId required" });
    }

    // 🔐 CHECK ACCESS TO CHAT
    const chat = await Chat.findById(chatId);

    if (!chat || !chat.participants.includes(userPhone)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const msgs = await Message.find({
      chatId,
      deletedBy: { $ne: userPhone },
    }).sort({ createdAt: 1 });

    res.json(msgs);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// =======================
// ✅ SEND MESSAGE (ALL ROLES)
// =======================
router.post("/", protect, async (req, res) => {
  try {
    const sender = req.user.phone;
    const userRole = req.user.role;

 const {
  chatId,
  text,
  messageType,
  fileUrl,
  fileName,
  fileSize,
  templateMeta,
  receiverPhone,
  contactName,
  contactPhone,
  contactEmail,
  clientTempId,
} = req.body;

    let resolvedTemplateMeta = null;

    // ================= TEMPLATE =================
    if (messageType === "template" && templateMeta) {
      resolvedTemplateMeta = {
        header: templateMeta.header || "",
        body: templateMeta.body || "",
        footer: templateMeta.footer || "",
        mediaType: templateMeta.mediaType || "None",
        mediaUrl: templateMeta.mediaUrl || null,
        templateId: templateMeta.templateId || null,
        variables: templateMeta.variables || {},
        carouselItems: templateMeta.carouselItems || [],
        resolvedText: null,
        actions: {
          ctaButtons: templateMeta.actions?.ctaButtons || [],
          quickReplies: templateMeta.actions?.quickReplies || [],
          copyCodeButtons: templateMeta.actions?.copyCodeButtons || [],
          dropdownButtons: templateMeta.actions?.dropdownButtons || [],
          inputFields: templateMeta.actions?.inputFields || [],
        },
      };

      try {
        let contact = null;

        if (receiverPhone) {
          contact = await Contact.findOne({ mobile: receiverPhone });
        }

        if (!contact) {
          const chat = await Chat.findById(chatId);
          const otherPhone = chat?.participants.find(p => p !== sender);
          if (otherPhone) {
            contact = await Contact.findOne({ mobile: otherPhone });
          }
        }

        if (templateMeta.templateId) {
          const template = await Template.findById(templateMeta.templateId);

          if (template) {
            const vars = Object.fromEntries(
              Object.entries(template.variables || {})
            );

            const resolved = resolveTemplate(template.format, vars, contact);
            resolvedTemplateMeta.body = resolved;
            resolvedTemplateMeta.resolvedText = resolved;
          }
        }

      } catch (err) {
        console.error("Template resolve error:", err.message);
      }
    }

    // 🔐 CHAT ACCESS CHECK
    const chat = await Chat.findById(chatId);

    const isAdmin = ["super_admin", "manager"].includes(userRole);

    if (!chat || (!chat.participants.includes(sender) && !isAdmin)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // ================= CREATE MESSAGE =================
   const msg = await Message.create({
  chatId,
  sender,
  clientTempId: clientTempId || null,
  text: text || "",
  messageType: messageType || "text",
  fileUrl,
  fileName,
  fileSize,
  templateMeta: messageType === "template" ? resolvedTemplateMeta : null,
  contactName: contactName || null,
  contactPhone: contactPhone || null,
  contactEmail: contactEmail || null,
  status: "delivered",
  deliveredAt: new Date(),
  readBy: [],
});

    // ================= UPDATE CHAT =================
    let lastMessageText = text;
    if (messageType === "video") lastMessageText = "Video";
    if (messageType === "audio") lastMessageText = "Audio";
    if (messageType === "image") lastMessageText = "📷 Photo";
    if (messageType === "file") lastMessageText = `📎 ${fileName || "File"}`;
    if (messageType === "template") lastMessageText = "📋 Template";

   await Chat.findByIdAndUpdate(chatId, {
  lastMessage: {
    text: lastMessageText || "",
    messageType: messageType || "text",
    fileName: fileName || null,
    createdAt: msg.createdAt,
    sender: sender,
    isDeleted: false,
    status: msg.status,
  },
  updatedAt: new Date(),
  $set: { deletedBy: [] },
});

    // ================= SOCKET =================
    const io = getIO();
    io.to(chatId).emit("newMessage", msg);
    io.to(sender).emit("messageDelivered", {
      messageId: msg._id,
      chatId,
    });

    res.json(msg);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// =======================
// ✅ MARK READ
// =======================
router.post("/mark-read", protect, async (req, res) => {
  try {
    const { chatId } = req.body;
    const userPhone = req.user.phone;

    await Message.updateMany(
      {
        chatId,
        sender: { $ne: userPhone },
        "readBy.user": { $ne: userPhone },
      },
      {
        $push: { readBy: { user: userPhone, readAt: new Date() } },
        status: "seen",
      }
    );

    getIO().to(chatId).emit("messagesSeen", { chatId, user: userPhone });

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// =======================
// ✅ DELETE MESSAGE
// =======================
router.delete("/:messageId", protect, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { mode } = req.body;

    const userPhone = req.user.phone;
    const userRole = req.user.role;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    const isAdmin = userRole === "super_admin";

    // 🔥 DELETE FOR EVERYONE
    if (mode === "everyone") {
      if (message.sender !== userPhone && !isAdmin) {
        return res.status(403).json({ error: "Not authorized" });
      }

      message.isDeleted = true;
      message.text = "This message was deleted";
      message.fileUrl = null;
      message.fileName = null;
      message.fileSize = null;
      message.templateMeta = null;

      await message.save();

      getIO().to(message.chatId.toString()).emit(
        "messageDeletedForEveryone",
        {
          messageId,
          chatId: message.chatId,
        }
      );

    }

    // 🔥 DELETE FOR ME
    else if (mode === "me") {
      if (!message.deletedBy.includes(userPhone)) {
        message.deletedBy.push(userPhone);
        await message.save();
      }

      getIO().to(userPhone).emit("messageDeletedForMe", {
        messageId,
        chatId: message.chatId,
        userPhone,
      });
    }

    res.json({ message: "Message deleted" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;

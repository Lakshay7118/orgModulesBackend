const express = require("express");
const router = express.Router();

const Message = require("../models/Message");
const Chat = require("../models/chat");
const Contact = require("../models/Contact");
const Template = require("../models/Template");

const resolveTemplate = require("../utils/resolveTemplate");
const {
  buildMessagePreview,
  findLastMessagePreview,
  recomputeChatLastMessage,
  updateChatLastMessage,
} = require("../utils/chatPreview");
const { getIO } = require("../sockets/socket");

const protect = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware"); // 🔥 ADD
function normalizeTemplateText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function getTemplateBody(message = {}) {
  return (
    message.templateMeta?.resolvedText ||
    message.templateMeta?.body ||
    message.text ||
    ""
  );
}

function getTemplateActionSignature(message = {}) {
  const actions = message.templateMeta?.actions || {};
  return ["ctaButtons", "quickReplies", "copyCodeButtons", "dropdownButtons", "inputFields"]
    .map((key) => `${key}:${JSON.stringify(actions[key] || [])}`)
    .join("|");
}

function getTemplateTimeBucket(message = {}, bucketMs = 2 * 60 * 1000) {
  const time = new Date(message.createdAt || message.deliveredAt || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return "";
  return String(Math.floor(time / bucketMs));
}

function getTemplateDedupeKeys(message = {}) {
  if (message.messageType !== "template") return [];

  const templateId = message.templateMeta?.templateId
    ? String(message.templateMeta.templateId)
    : "";
  const body = normalizeTemplateText(getTemplateBody(message));
  const footer = normalizeTemplateText(message.templateMeta?.footer || "");
  const keys = [];

  if (message.campaignRunKey || message.recipientPhone || message.campaignDeliveryKey) {
    keys.push([
      "campaign-template",
      String(message.chatId || ""),
      String(message.sender || ""),
      String(message.campaignRunKey || ""),
      String(message.recipientPhone || ""),
      templateId,
      body,
    ].join(":"));
  }

  const bucket = getTemplateTimeBucket(message);
  if (body && bucket) {
    keys.push([
      "visual-template",
      String(message.chatId || ""),
      String(message.sender || ""),
      templateId,
      body,
      footer,
      getTemplateActionSignature(message),
      bucket,
    ].join(":"));
  }

  return keys;
}

function getTemplateRichness(message = {}) {
  const template = message.templateMeta || {};
  const actions = template.actions || {};
  let score = 0;

  if (template.mediaUrl) score += 100;
  if (template.mediaType && template.mediaType !== "None") score += 20;
  if (template.header) score += 5;
  if (template.footer) score += 5;
  if (getTemplateBody(message)) score += 5;
  if (Array.isArray(template.carouselItems) && template.carouselItems.length) score += 20;
  ["ctaButtons", "quickReplies", "copyCodeButtons", "dropdownButtons", "inputFields"].forEach((key) => {
    if (Array.isArray(actions[key])) score += actions[key].length;
  });

  return score;
}

function dedupeCampaignTemplateMessages(messages = []) {
  const result = [];
  const seen = new Map();

  messages.forEach((message) => {
    const keys = getTemplateDedupeKeys(message);
    const duplicateKey = keys.find((key) => seen.has(key));

    if (!keys.length) {
      result.push(message);
      return;
    }

    if (!duplicateKey) {
      keys.forEach((key) => seen.set(key, result.length));
      result.push(message);
      return;
    }

    const existingIndex = seen.get(duplicateKey);
    const existing = result[existingIndex];

    if (getTemplateRichness(message) > getTemplateRichness(existing)) {
      result[existingIndex] = message;
      keys.forEach((key) => seen.set(key, existingIndex));
    }
  });

  return result;
}

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
    }).sort({ createdAt: 1 }).lean();

    res.json(dedupeCampaignTemplateMessages(msgs));

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
    await updateChatLastMessage(chatId, buildMessagePreview(msg));
    await Chat.findByIdAndUpdate(chatId, { $set: { deletedBy: [] } });

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
    const readAt = new Date();

    await Message.updateMany(
      {
        chatId,
        sender: { $ne: userPhone },
        "readBy.user": { $ne: userPhone },
      },
      {
        $push: { readBy: { user: userPhone, readAt } },
        $set: { status: "seen", seenAt: readAt },
      }
    );

    getIO().to(chatId).emit("messagesSeen", { chatId, user: userPhone, seenAt: readAt });

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
      const lastMessage = await recomputeChatLastMessage(message.chatId, { touch: false });

      getIO().to(message.chatId.toString()).emit(
        "messageDeletedForEveryone",
        {
          messageId,
          chatId: message.chatId,
          lastMessage,
        }
      );

      return res.json({ message: "Message deleted", lastMessage });
    }

    // 🔥 DELETE FOR ME
    else if (mode === "me") {
      if (!message.deletedBy.includes(userPhone)) {
        message.deletedBy.push(userPhone);
        await message.save();
      }
      const lastMessage = await findLastMessagePreview(message.chatId, {
        excludeDeletedBy: userPhone,
      });

      getIO().to(userPhone).emit("messageDeletedForMe", {
        messageId,
        chatId: message.chatId,
        userPhone,
        lastMessage,
      });

      return res.json({ message: "Message deleted", lastMessage });
    }

    res.status(400).json({ error: "Invalid delete mode" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;

// utils/enrichChat.js
const Message = require("../models/Message");
const User = require("../models/Users");
const Contact = require("../models/Contact");

async function enrichChat(chat, currentUserPhone) {
  try {
    // ── GROUP CHAT ──────────────────────────────────
    if (chat.isGroup) {

      // ✅ FIXED: Don't count messages sent BY the current user
      // Only count messages not yet read by current user
     const unreadCount = await Message.countDocuments({
  chatId: chat._id,
  sender: { $ne: currentUserPhone },
  deletedBy: { $ne: currentUserPhone },
  "readBy.user": { $ne: currentUserPhone }, // ✅ simple — readBy: [] always exists now
});

      const lastMsg = await Message.findOne({
        chatId: chat._id,
        deletedBy: { $ne: currentUserPhone },
      })
        .sort({ createdAt: -1 });

      const lastMessageText =
        lastMsg?.text ||
        (lastMsg?.messageType === "image"
          ? "📷 Photo"
          : lastMsg?.messageType === "file"
          ? "📎 File"
          : lastMsg?.messageType === "template"
          ? "📋 Template"                        // ✅ added template type
          : "");

      const lastMessageTimeRaw = lastMsg?.createdAt || chat.updatedAt || new Date();

      return {
        _id: chat._id,
        name: chat.groupName,
        phone: null,
        email: "",
        city: "",
        tag: "",
        notes: "",
        status: chat.status,
        lastSeen: chat.lastSeen,
        unread: unreadCount,
        lastMessage: lastMessageText,
        lastMessageTime: new Date(lastMessageTimeRaw).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        participants: chat.participants,
        isGroup: true,
        admin: chat.admin,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      };
    }

    // ── INDIVIDUAL CHAT ────────────────────────────
    const otherPhone = chat.participants.find(
      (p) => String(p) !== String(currentUserPhone)
    );

    let otherUser = await User.findOne({ phone: otherPhone });
    let otherContact = await Contact.findOne({ mobile: otherPhone });

    const name =
      otherUser?.name || otherContact?.name || otherPhone || "Unknown";

    const unreadCount = await Message.countDocuments({
  chatId: chat._id,
  sender: otherPhone,
  deletedBy: { $ne: currentUserPhone },
  "readBy.user": { $ne: currentUserPhone }, // ✅ simple
});

    const lastMsg = await Message.findOne({
      chatId: chat._id,
      deletedBy: { $ne: currentUserPhone },
    }).sort({
      createdAt: -1,
    });

    const lastMessageText =
      lastMsg?.text ||
      (lastMsg?.messageType === "image"
        ? "📷 Photo"
        : lastMsg?.messageType === "file"
        ? "📎 File"
        : lastMsg?.messageType === "template"
        ? "📋 Template"                          // ✅ added template type
        : "");

    const lastMessageTimeRaw =
      lastMsg?.createdAt || chat.updatedAt || new Date();

    return {
      _id: chat._id,
      name,
      phone: otherPhone || null,
      email: otherUser?.email || "",
      city: "",
      tag: otherContact?.tags?.[0] || "",
      notes: "",
      status: chat.status,
      lastSeen: chat.lastSeen,
      unread: unreadCount,
      lastMessage: lastMessageText,
      lastMessageTime: new Date(lastMessageTimeRaw).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      participants: chat.participants,
      isGroup: false,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
  } catch (err) {
    console.error("ENRICH CHAT ERROR:", err);
    return chat;
  }
}

module.exports = enrichChat;

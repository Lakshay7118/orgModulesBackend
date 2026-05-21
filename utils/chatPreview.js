const Chat = require("../models/chat");
const Message = require("../models/Message");

const EMPTY_LAST_MESSAGE = {
  text: "",
  messageType: "text",
  fileName: null,
  contactName: null,
  createdAt: null,
  sender: null,
  isDeleted: false,
  status: null,
  callStatus: null,
  callDuration: 0,
  callType: null,
};

const getCallPreviewText = (message = {}) => {
  const status = message.callStatus || "ended";
  const label = message.callType === "video" ? "Video call" : "Voice call";

  if (status === "missed") return `Missed ${label.toLowerCase()}`;
  if (status === "cancelled") return `Cancelled ${label.toLowerCase()}`;
  if (status === "rejected") return "Call declined";
  if (status === "busy") return "Call busy";
  if (status === "failed") return "Call failed";

  return label;
};

const getMessagePreviewText = (message = {}) => {
  if (message.isDeleted) return "This message was deleted";

  switch (message.messageType) {
    case "image":
      return "Photo";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "file":
      return message.fileName || "File";
    case "template":
      return "Template";
    case "contact":
      return message.contactName || message.text || "Contact";
    case "call":
      return getCallPreviewText(message);
    default:
      return message.text || "";
  }
};

const buildMessagePreview = (message) => {
  if (!message) return null;

  return {
    text: getMessagePreviewText(message),
    messageType: message.messageType || "text",
    fileName: message.fileName || null,
    contactName: message.contactName || null,
    createdAt: message.createdAt || null,
    sender: message.sender || null,
    isDeleted: Boolean(message.isDeleted),
    status: message.status || null,
    callStatus: message.callStatus || null,
    callDuration: message.callDuration || 0,
    callType: message.callType || null,
  };
};

const findLastMessagePreview = async (chatId, { excludeDeletedBy } = {}) => {
  const query = { chatId };
  if (excludeDeletedBy) query.deletedBy = { $ne: excludeDeletedBy };

  const lastMessage = await Message.findOne(query).sort({ createdAt: -1 }).lean();
  return buildMessagePreview(lastMessage);
};

const updateChatLastMessage = async (chatId, preview, { touch = true } = {}) => {
  const lastMessage = preview || EMPTY_LAST_MESSAGE;
  const update = { $set: { lastMessage } };

  if (touch) {
    update.$set.updatedAt = lastMessage.createdAt || new Date();
  }

  await Chat.findByIdAndUpdate(chatId, update, { timestamps: touch });
  return lastMessage;
};

const recomputeChatLastMessage = async (chatId, options = {}) => {
  const preview = await findLastMessagePreview(chatId, options);
  if (!options.excludeDeletedBy) {
    await updateChatLastMessage(chatId, preview, { touch: options.touch !== false });
  }
  return preview;
};

module.exports = {
  EMPTY_LAST_MESSAGE,
  buildMessagePreview,
  findLastMessagePreview,
  recomputeChatLastMessage,
  updateChatLastMessage,
};

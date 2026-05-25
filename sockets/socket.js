// sockets/socket.js
const { Server } = require("socket.io");
const Chat = require("../models/chat");
const Message = require("../models/Message");
const { buildMessagePreview, updateChatLastMessage } = require("../utils/chatPreview");

let io;

// phone → Set of socketIds (BEST approach instead of count)
const onlineUsers = new Map();
const lastSeenMap = {};

const getPhoneRooms = (phone) => {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  const last10 = digits.length > 10 ? digits.slice(-10) : digits;

  return Array.from(new Set([raw, digits, last10].filter(Boolean)));
};

const normalizeCallStatus = ({ reason, wasConnected, durationSeconds }) => {
  if (wasConnected || durationSeconds > 0) return "ended";
  if (reason === "busy") return "busy";
  if (reason === "rejected") return "rejected";
  if (reason === "connection-timeout" || reason === "remote-ended") return "missed";
  if (reason === "setup-failed" || reason === "connection-failed" || reason === "ice-failed" || reason === "answer-failed") return "failed";
  return "cancelled";
};

const getCallLogText = ({ callStatus, callDuration = 0, callType = "audio" }) => {
  const label = callType === "video" ? "Video call" : "Voice call";

  if (callStatus === "missed") return `Missed ${label.toLowerCase()}`;
  if (callStatus === "rejected") return "Call declined";
  if (callStatus === "busy") return "Call busy";
  if (callStatus === "failed") return "Call failed";
  if (callStatus === "cancelled") return `Cancelled ${label.toLowerCase()}`;
  if (callDuration > 0) return label;

  return label;
};

const logCallMessage = async ({ chatId, sender, callStatus, callDuration = 0, callType = "audio" }) => {
  if (!chatId || !sender) return null;

  const chat = await Chat.findById(chatId);
  if (!chat || !chat.participants.some((phone) => String(phone) === String(sender))) {
    return null;
  }

  const msg = await Message.create({
    chatId,
    sender,
    text: getCallLogText({ callStatus, callDuration, callType }),
    messageType: "call",
    callStatus,
    callDuration,
    callType,
    status: "delivered",
    deliveredAt: new Date(),
    readBy: [],
  });

  await updateChatLastMessage(chatId, buildMessagePreview(msg));
  io.to(chatId).emit("newMessage", msg);
  return msg;
};

const initSocket = (server) => {
  io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 5000,
    pingInterval: 10000,
  });

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // ================= CHAT ROOM =================
    socket.on("joinChat", (chatId) => {
      socket.join(chatId);
    });

    // ================= USER ONLINE =================
    socket.on("joinUserRoom", (userPhone) => {
      if (!userPhone) return;

      // ❌ prevent duplicate join from same socket
      if (socket.userPhone === userPhone) return;

      socket.userPhone = userPhone;
      getPhoneRooms(userPhone).forEach(room => socket.join(room));

      let userSockets = onlineUsers.get(userPhone);

      if (!userSockets) {
        userSockets = new Set();
        onlineUsers.set(userPhone, userSockets);
      }

      userSockets.add(socket.id);

      delete lastSeenMap[userPhone];

      emitPresence();
    });

    // ================= USER LEAVE =================
    socket.on("leaveUserRoom", (userPhone) => {
      if (!userPhone) return;

      const userSockets = onlineUsers.get(userPhone);
      if (!userSockets) return;

      getPhoneRooms(userPhone).forEach(room => socket.leave(room));
      userSockets.delete(socket.id);

      if (userSockets.size === 0) {
        onlineUsers.delete(userPhone);
        lastSeenMap[userPhone] = new Date().toISOString();
      }

      emitPresence();
    });

    // ================= DISCONNECT =================
    socket.on("disconnect", () => {
      const userPhone = socket.userPhone;
      if (!userPhone) return;

      const userSockets = onlineUsers.get(userPhone);
      if (!userSockets) return;

      userSockets.delete(socket.id);

      if (userSockets.size === 0) {
        onlineUsers.delete(userPhone);
        lastSeenMap[userPhone] = new Date().toISOString();
      }

      emitPresence();
    });

    // ================= OTHER EVENTS =================
    socket.on("typing", ({ chatId, user }) => {
      socket.to(chatId).emit("userTyping", { chatId, user });
    });

    socket.on("markRead", ({ chatId }) => {
      socket.to(chatId).emit("messagesSeen", { chatId });
    });

    // ================= CALL SIGNALING =================
    socket.on("call:offer", ({ to, from, fromName, callId, chatId, offer, callType }) => {
      if (!to || !from || !offer) return;

      console.log("[call:offer]", {
        from,
        to,
        callId,
        chatId,
        recipientSockets: onlineUsers.get(to)?.size || 0,
      });

      io.to(getPhoneRooms(to)).emit("call:incoming", {
        from,
        fromName,
        callId,
        chatId,
        offer,
        callType: callType || "audio",
      });
    });

    socket.on("call:answer", ({ to, from, callId, chatId, answer }) => {
      if (!to || !from || !answer) return;

      console.log("[call:answer]", {
        from,
        to,
        callId,
        chatId,
        recipientSockets: onlineUsers.get(to)?.size || 0,
      });

      io.to(getPhoneRooms(to)).emit("call:answered", {
        from,
        callId,
        chatId,
        answer,
      });

      io.to(getPhoneRooms(from)).emit("call:handled", {
        peerPhone: to,
        callId,
        chatId,
        action: "answered",
      });
    });

    socket.on("call:ice-candidate", ({ to, from, callId, chatId, candidate }) => {
      if (!to || !from || !candidate) return;

      console.log("[call:ice-candidate]", {
        from,
        to,
        callId,
        chatId,
        type: candidate.type,
        protocol: candidate.protocol,
        recipientSockets: onlineUsers.get(to)?.size || 0,
      });

      io.to(getPhoneRooms(to)).emit("call:ice-candidate", {
        from,
        callId,
        chatId,
        candidate,
      });
    });

    socket.on("call:reject", async ({ to, from, callId, chatId, reason, callType }) => {
      if (!to || !from) return;

      io.to(getPhoneRooms(to)).emit("call:rejected", {
        from,
        callId,
        chatId,
        reason: reason || "rejected",
        callType: callType || "audio",
      });

      io.to(getPhoneRooms(from)).emit("call:handled", {
        peerPhone: to,
        callId,
        chatId,
        action: "rejected",
      });

      try {
        await logCallMessage({
          chatId,
          sender: to,
          callStatus: "rejected",
          callType: callType || "audio",
        });
      } catch (err) {
        console.error("[call:reject] log failed:", err.message);
      }
    });

    socket.on("call:busy", async ({ to, from, callId, chatId, callType }) => {
      if (!to || !from) return;

      io.to(getPhoneRooms(to)).emit("call:busy", {
        from,
        callId,
        chatId,
        callType: callType || "audio",
      });

      try {
        await logCallMessage({
          chatId,
          sender: to,
          callStatus: "busy",
          callType: callType || "audio",
        });
      } catch (err) {
        console.error("[call:busy] log failed:", err.message);
      }
    });

    socket.on("call:end", async ({ to, from, callId, chatId, reason, initiator, durationSeconds, wasConnected, callType }) => {
      if (!to || !from) return;

      io.to(getPhoneRooms(to)).emit("call:ended", {
        from,
        callId,
        chatId,
        reason: reason || "ended",
        callType: callType || "audio",
      });

      io.to(getPhoneRooms(from)).emit("call:handled", {
        peerPhone: to,
        callId,
        chatId,
        action: "ended",
      });

      try {
        await logCallMessage({
          chatId,
          sender: initiator || from,
          callStatus: normalizeCallStatus({
            reason: reason || "ended",
            wasConnected: Boolean(wasConnected),
            durationSeconds: Number(durationSeconds) || 0,
          }),
          callDuration: Number(durationSeconds) || 0,
          callType: callType || "audio",
        });
      } catch (err) {
        console.error("[call:end] log failed:", err.message);
      }
    });

    socket.on("chatDeleted", ({ chatId, userPhone }) => {
      io.to(userPhone).emit("chatDeleted", { chatId, userPhone });
    });

    socket.on("chatDeletedPermanently", ({ chatId }) => {
      io.to(chatId).emit("chatDeletedPermanently", { chatId });
    });

    socket.on("pinChat", ({ chatId, userPhone, pinned }) => {
      io.to(userPhone).emit("chatPinned", { chatId, pinned });
    });

    socket.on("clearChat", ({ chatId, userPhone }) => {
      io.to(userPhone).emit("chatCleared", { chatId });
    });
  });

  // ================= EMIT PRESENCE =================
const emitPresence = () => {
  // ✅ clean stale lastSeen for any user who is currently online
  onlineUsers.forEach((_, phone) => { delete lastSeenMap[phone]; });
  
  io.emit("onlineUsers", {
    users: Array.from(onlineUsers.keys()),
    lastSeen: lastSeenMap,
  });
};
  return io;
};

const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

module.exports = { initSocket, getIO };

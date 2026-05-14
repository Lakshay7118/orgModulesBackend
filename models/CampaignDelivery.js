const mongoose = require("mongoose");

const CampaignDeliverySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
    },
    campaignRunKey: { type: String, required: true },
    recipientPhone: { type: String, required: true },
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      default: null,
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    status: {
      type: String,
      enum: ["processing", "sent", "failed"],
      default: "processing",
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.CampaignDelivery ||
  mongoose.model("CampaignDelivery", CampaignDeliverySchema);

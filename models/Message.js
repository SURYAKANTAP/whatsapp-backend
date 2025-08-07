const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
  // The message ID from the webhook payload
  id: { type: String, required: true, unique: true },

  // The user's WhatsApp ID (e.g., "919xxxxxxxxx")
  wa_id: { type: String, required: true },
  from: { type: String, required: true },
  // The user's name
  name: { type: String, required: true },

  // The message content
  text: { type: String, required: true },

  // The timestamp of the message
  timestamp: { type: Number, required: true },

  // The status of the message: 'sent', 'delivered', or 'read'
  status: { type: String, default: "sent" },
});

// Create an index on wa_id and timestamp for faster querying
MessageSchema.index({ wa_id: 1, timestamp: -1 });

const Message = mongoose.model("processed_message", MessageSchema);

module.exports = Message;

const mongoose = require('mongoose')

const SessionSchema = new mongoose.Schema({
  instanceKey: { type: String, unique: true, required: true },
  createdAt: { type: Date, default: Date.now },
  connected: { type: Boolean, default: false },
  qr: { type: String }, // Base64 QR
  qrGeneratedAt: { type: Date }
})

module.exports = mongoose.model('Session', SessionSchema)

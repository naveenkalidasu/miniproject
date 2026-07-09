const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, default: null },
    authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
    googleId: { type: String, default: null },
    googleProfilePic: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    lastLogin: { type: Date, default: null },
    isActive: { type: Boolean, default: true }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);

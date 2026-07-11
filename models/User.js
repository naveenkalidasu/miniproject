const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    // Local auth
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String
    },
    
    // Google OAuth fields
    googleId: {
        type: String,
        sparse: true,
        unique: true
    },
    photo: {
        type: String,
        default: ''
    },
    
    // Common fields
    authProvider: {
        type: String,
        enum: ['local', 'google'],
        default: 'local'
    },
    loginCount: {
        type: Number,
        default: 0
    },
    lastLogin: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    resumeData: String,
    savedJobs: [String]
});

module.exports = mongoose.model('User', UserSchema);
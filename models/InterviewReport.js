const mongoose = require('mongoose');

const InterviewReportSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    targetJob: { type: String, required: true },
    resumeSnapshot: { type: String, default: '' },

    technical: {
        questions: [{ question: String, answer: String }],
        score: { type: Number, default: 0 },
        feedback: { type: String, default: '' }
    },
    coding: {
        problem: { type: String, default: '' },
        code: { type: String, default: '' },
        language: { type: String, default: 'javascript' },
        score: { type: Number, default: 0 },
        feedback: { type: String, default: '' }
    },
    hr: {
        questions: [{ question: String, answer: String }],
        score: { type: Number, default: 0 },
        feedback: { type: String, default: '' }
    },

    finalReport: {
        overallScore: { type: Number, default: 0 },
        decision: { type: String, default: '' },
        summary: { type: String, default: '' },
        strengths: [String],
        weaknesses: [String],
        recommendations: [String]
    },

    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.InterviewReport || mongoose.model('InterviewReport', InterviewReportSchema);

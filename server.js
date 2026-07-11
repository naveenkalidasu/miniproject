require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const flash = require('connect-flash');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');

const User = require('./models/User');
const InterviewReport = require('./models/InterviewReport');
const { extractText } = require('./utils/textExtractor');
const { analyzeResume, getJobSuggestions, searchJobs } = require('./utils/resumeAI');
const {
    generateTechnicalQuestions, evaluateTechnical,
    generateCodingProblem, evaluateCoding,
    generateHRQuestions, evaluateHR,
    generateFinalReport
} = require('./utils/interviewAI');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MONGODB CONNECTION
// ============================================================
console.log('Attempting to connect to MongoDB...');
mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
})
    .then(() => console.log('MongoDB connected:', mongoose.connection.db.databaseName))
    .catch(err => {
        console.error('MongoDB connection error:', err.message);
        console.log('Continuing without DB — auth/report persistence will fail until this is fixed.');
    });

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'propai_secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (error) {
        done(error, null);
    }
});

const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    req.flash('error_msg', 'Please login first');
    res.redirect('/login');
};

// Multer: keep uploads in memory, no disk writes needed since we extract text immediately
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
    fileFilter: (req, file, cb) => {
        const ok = ['.pdf', '.docx', '.txt'].includes(path.extname(file.originalname).toLowerCase());
        cb(ok ? null : new Error('Only PDF, DOCX, and TXT files are supported'), ok);
    }
});

// ============================================================
// AUTH ROUTES
// ============================================================
app.get('/', (req, res) => {
    res.redirect(req.isAuthenticated() ? '/dashboard' : '/login');
});

app.get('/login', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.render('login', { messages: req.flash() });
});

app.get('/register', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.render('register', { messages: req.flash() });
});

app.post('/register', async (req, res) => {
    try {
        const { name, email, password, confirmPassword } = req.body;

        if (!name || !email || !password || !confirmPassword) {
            req.flash('error_msg', 'All fields are required');
            return res.redirect('/register');
        }
        if (password !== confirmPassword) {
            req.flash('error_msg', 'Passwords do not match');
            return res.redirect('/register');
        }
        if (password.length < 6) {
            req.flash('error_msg', 'Password must be at least 6 characters');
            return res.redirect('/register');
        }

        const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
        if (existingUser) {
            req.flash('error_msg', 'Email already registered');
            return res.redirect('/register');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            authProvider: 'local'
        });
        await user.save();

        req.flash('success_msg', 'Registration successful! Please login.');
        res.redirect('/login');
    } catch (error) {
        console.error('Registration error:', error);
        req.flash('error_msg', 'Registration failed. Please try again.');
        res.redirect('/register');
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            req.flash('error_msg', 'All fields are required');
            return res.redirect('/login');
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user || !user.password) {
            req.flash('error_msg', 'Invalid credentials');
            return res.redirect('/login');
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            req.flash('error_msg', 'Invalid credentials');
            return res.redirect('/login');
        }

        user.lastLogin = new Date();
        await user.save();

        req.logIn(user, (err) => {
            if (err) {
                req.flash('error_msg', 'Login failed');
                return res.redirect('/login');
            }
            req.flash('success_msg', 'Welcome back!');
            res.redirect('/dashboard');
        });
    } catch (error) {
        console.error('Login error:', error);
        req.flash('error_msg', 'Login failed');
        res.redirect('/login');
    }
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            req.flash('error_msg', 'User not found');
            return res.redirect('/login');
        }
        res.render('dashboard', { user, messages: req.flash() });
    } catch (error) {
        console.error('Dashboard error:', error);
        req.flash('error_msg', 'Something went wrong');
        res.redirect('/login');
    }
});

app.get('/logout', (req, res) => {
    req.logout((err) => {
        req.session.destroy(() => res.redirect('/login'));
    });
});

// ============================================================
// RESUME ANALYZER ROUTES
// ============================================================
app.get('/resume', isAuthenticated, (req, res) => {
    res.render('resume', { messages: req.flash() });
});

app.post('/upload', isAuthenticated, (req, res, next) => {
    upload.single('resume')(req, res, (err) => {
        if (err) {
            // Previously, multer errors (wrong file type, >8MB, etc.) skipped this route's
            // own try/catch and fell through to the app-wide error handler, which redirects
            // to /login with a generic "Something went wrong" — confusing on the resume page.
            console.error('Upload middleware error:', err.message);
            const message = err.code === 'LIMIT_FILE_SIZE'
                ? 'File is too large. Max size is 8MB.'
                : (err.message || 'Could not process the uploaded file.');
            return res.status(400).json({ success: false, message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }
        const { text, method, charCount } = await extractText(req.file.buffer, req.file.originalname);

        if (!text || text.length < 20) {
            // Shouldn't normally get here — extractText throws a specific reason first —
            // but keep this as a last-resort guard.
            return res.status(422).json({
                success: false,
                message: 'Could not extract readable text from this file. Try a different file or paste the text directly.'
            });
        }

        res.json({ success: true, text, fileName: req.file.originalname, method, charCount });
    } catch (error) {
        // extractText() now throws specific, actionable messages (scanned PDF + no OCR,
        // corrupted docx, pdf-parse failure, etc.) — pass those through to the UI instead
        // of masking everything as the same generic message.
        console.error('Upload error:', error);
        res.status(422).json({ success: false, message: error.message || 'Failed to process file' });
    }
});

app.post('/get-suggestions', isAuthenticated, async (req, res) => {
    try {
        const { resumeText } = req.body;
        if (!resumeText || resumeText.length < 20) {
            return res.status(400).json({ success: false, message: 'resumeText is required' });
        }
        const suggestions = await getJobSuggestions(resumeText);
        res.json({ success: true, suggestions });
    } catch (error) {
        console.error('Suggestions error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/search-job', isAuthenticated, async (req, res) => {
    try {
        const { query, resumeText } = req.body;
        if (!query || !resumeText) {
            return res.status(400).json({ success: false, message: 'query and resumeText are required' });
        }
        const suggestions = await searchJobs(query, resumeText);
        res.json({ success: true, suggestions });
    } catch (error) {
        console.error('Search-job error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/analyze', isAuthenticated, async (req, res) => {
    try {
        const { resumeText, targetJob } = req.body;
        if (!resumeText || resumeText.length < 20 || !targetJob) {
            return res.status(400).json({ success: false, message: 'resumeText and targetJob are required' });
        }

        const analysis = await analyzeResume(resumeText, targetJob);

        // Stash in session so the interview flow can reuse it
        req.session.resumeData = { text: resumeText, targetJob, analysis };
        // Reset any previous interview progress for a fresh resume/job
        req.session.interview = null;

        res.json({ success: true, analysis });
    } catch (error) {
        console.error('Analyze error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// INTERVIEW ROUTES
// ============================================================
const requireResumeAnalysis = (req, res, next) => {
    if (!req.session.resumeData || !req.session.resumeData.text) {
        req.flash('error_msg', 'Please analyze your resume for a target job before starting the interview.');
        return res.redirect('/resume');
    }
    next();
};

app.get('/interview', isAuthenticated, requireResumeAnalysis, (req, res) => {
    res.render('interview-start', {
        targetJob: req.session.resumeData.targetJob,
        inProgress: !!req.session.interview,
        messages: req.flash()
    });
});

app.post('/interview/start', isAuthenticated, requireResumeAnalysis, (req, res) => {
    req.session.interview = {
        stage: 'technical',
        technical: { questions: [], answers: {}, result: null },
        coding: { problem: null, code: '', language: 'javascript', result: null },
        hr: { questions: [], answers: {}, result: null }
    };
    res.redirect('/interview/technical');
});

// ---- Technical round ----
app.get('/interview/technical', isAuthenticated, requireResumeAnalysis, async (req, res) => {
    if (!req.session.interview) return res.redirect('/interview');
    const t = req.session.interview.technical;
    try {
        if (!t.questions || t.questions.length === 0) {
            t.questions = await generateTechnicalQuestions(req.session.resumeData.text, req.session.resumeData.targetJob);
        }
        res.render('interview-technical', {
            targetJob: req.session.resumeData.targetJob,
            questions: t.questions,
            messages: req.flash()
        });
    } catch (error) {
        console.error('Technical question generation error:', error);
        req.flash('error_msg', 'Could not generate technical questions: ' + error.message);
        res.redirect('/interview');
    }
});

app.post('/interview/technical', isAuthenticated, requireResumeAnalysis, async (req, res) => {
    if (!req.session.interview) return res.redirect('/interview');
    const t = req.session.interview.technical;
    t.answers = req.body; // { t1: "...", t2: "...", ... }

    try {
        t.result = await evaluateTechnical(t.questions, t.answers, req.session.resumeData.targetJob);
        req.session.interview.stage = 'coding';
        res.redirect('/interview/coding');
    } catch (error) {
        console.error('Technical evaluation error:', error);
        req.flash('error_msg', 'Could not evaluate technical answers: ' + error.message);
        res.redirect('/interview/technical');
    }
});

// ---- Coding round ----
app.get('/interview/coding', isAuthenticated, requireResumeAnalysis, async (req, res) => {
    if (!req.session.interview) return res.redirect('/interview');
    const c = req.session.interview.coding;
    try {
        if (!c.problem) {
            c.problem = await generateCodingProblem(req.session.resumeData.targetJob, req.session.resumeData.text);
        }
        res.render('interview-coding', {
            targetJob: req.session.resumeData.targetJob,
            problem: c.problem,
            messages: req.flash()
        });
    } catch (error) {
        console.error('Coding problem generation error:', error);
        req.flash('error_msg', 'Could not generate coding problem: ' + error.message);
        res.redirect('/interview');
    }
});

app.post('/interview/coding', isAuthenticated, requireResumeAnalysis, async (req, res) => {
    if (!req.session.interview) return res.redirect('/interview');
    const c = req.session.interview.coding;
    c.code = req.body.code || '';
    c.language = req.body.language || 'javascript';

    try {
        c.result = await evaluateCoding(c.problem, c.code, c.language);
        req.session.interview.stage = 'hr';
        res.redirect('/interview/hr');
    } catch (error) {
        console.error('Coding evaluation error:', error);
        req.flash('error_msg', 'Could not evaluate code submission: ' + error.message);
        res.redirect('/interview/coding');
    }
});

// ---- HR round ----
app.get('/interview/hr', isAuthenticated, requireResumeAnalysis, async (req, res) => {
    if (!req.session.interview) return res.redirect('/interview');
    const h = req.session.interview.hr;
    try {
        if (!h.questions || h.questions.length === 0) {
            h.questions = await generateHRQuestions(req.session.resumeData.targetJob);
        }
        res.render('interview-hr', {
            targetJob: req.session.resumeData.targetJob,
            questions: h.questions,
            messages: req.flash()
        });
    } catch (error) {
        console.error('HR question generation error:', error);
        req.flash('error_msg', 'Could not generate HR questions: ' + error.message);
        res.redirect('/interview');
    }
});

app.post('/interview/hr', isAuthenticated, requireResumeAnalysis, async (req, res) => {
    if (!req.session.interview) return res.redirect('/interview');
    const h = req.session.interview.hr;
    h.answers = req.body;

    try {
        h.result = await evaluateHR(h.questions, h.answers, req.session.resumeData.targetJob);
        req.session.interview.stage = 'report';
        res.redirect('/interview/report');
    } catch (error) {
        console.error('HR evaluation error:', error);
        req.flash('error_msg', 'Could not evaluate HR answers: ' + error.message);
        res.redirect('/interview/hr');
    }
});

// ---- Final report ----
app.get('/interview/report', isAuthenticated, requireResumeAnalysis, async (req, res) => {
    const interview = req.session.interview;
    if (!interview || !interview.technical.result || !interview.coding.result || !interview.hr.result) {
        req.flash('error_msg', 'Please complete all interview rounds first.');
        return res.redirect('/interview');
    }

    try {
        if (!interview.finalReport) {
            const finalReport = await generateFinalReport({
                targetJob: req.session.resumeData.targetJob,
                technical: interview.technical.result,
                coding: interview.coding.result,
                hr: interview.hr.result
            });
            interview.finalReport = finalReport;

            // Persist to DB (best-effort; don't block the report page if this fails)
            try {
                await InterviewReport.create({
                    user: req.user.id,
                    targetJob: req.session.resumeData.targetJob,
                    resumeSnapshot: req.session.resumeData.text.slice(0, 2000),
                    technical: {
                        questions: interview.technical.questions.map(q => ({
                            question: q.question,
                            answer: interview.technical.answers[q.id] || ''
                        })),
                        score: interview.technical.result.overallScore,
                        feedback: interview.technical.result.feedback
                    },
                    coding: {
                        problem: interview.coding.problem.title,
                        code: interview.coding.code,
                        language: interview.coding.language,
                        score: interview.coding.result.score,
                        feedback: interview.coding.result.feedback
                    },
                    hr: {
                        questions: interview.hr.questions.map(q => ({
                            question: q.question,
                            answer: interview.hr.answers[q.id] || ''
                        })),
                        score: interview.hr.result.overallScore,
                        feedback: interview.hr.result.feedback
                    },
                    finalReport
                });
            } catch (dbErr) {
                console.error('Could not persist interview report:', dbErr.message);
            }
        }

        res.render('interview-report', {
            targetJob: req.session.resumeData.targetJob,
            technical: interview.technical,
            coding: interview.coding,
            hr: interview.hr,
            finalReport: interview.finalReport,
            messages: req.flash()
        });
    } catch (error) {
        console.error('Final report generation error:', error);
        req.flash('error_msg', 'Could not generate final report: ' + error.message);
        res.redirect('/interview/hr');
    }
});

app.get('/interview/restart', isAuthenticated, (req, res) => {
    req.session.interview = null;
    res.redirect('/interview');
});

// ============================================================
// DEBUG + ERROR HANDLING
// ============================================================
app.get('/debug/db', (req, res) => {
    const state = mongoose.connection.readyState;
    const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
    res.json({ connected: state === 1, state: states[state] || 'unknown' });
});

app.use((req, res) => {
    res.status(404).send('Page not found');
});

app.use((err, req, res, next) => {
    console.error('Unhandled error on', req.method, req.originalUrl, ':', err);

    // JSON/API routes (fetch calls from the front-end) should get a JSON error,
    // not an HTML redirect — the front-end JS expects response.json().
    if (req.path.startsWith('/upload') || req.path.startsWith('/analyze') ||
        req.path.startsWith('/get-suggestions') || req.path.startsWith('/search-job')) {
        return res.status(500).json({ success: false, message: err.message || 'Something went wrong' });
    }

    // For page routes, send the user back to where they were rather than always to
    // /login — being redirected to the login page from, say, the resume page after
    // an unrelated error looked like a broken auth system even though auth was fine.
    req.flash('error_msg', 'Something went wrong: ' + (err.message || 'unknown error'));
    const fallback = req.isAuthenticated && req.isAuthenticated() ? '/dashboard' : '/login';
    res.redirect(fallback);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

# PropAI — Auth + Resume Analyzer + Mock Interview

Single Express app (`server.js`), EJS views, MongoDB (Mongoose), Mistral AI for all
AI features. Run with `npm start`.

## ⚠️ First: rotate your credentials

Any Mistral API key or MongoDB connection string that's ever been pasted into chat,
committed, or shared should be treated as exposed:
- Mistral: regenerate the key in the Mistral console.
- MongoDB Atlas: change the DB user's password (Database Access tab).

This zip ships only `.env.example` (placeholder values) — no live secrets are bundled.
Copy it to `.env` and fill in your real (rotated) credentials before running.

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, MISTRAL_API_KEY, SESSION_SECRET
npm start
```

Server runs on `http://localhost:3000` (or `PORT` from `.env`).

Requires **Node 18+** (uses the built-in `fetch` for Mistral calls — Node 22 is what
this was built/tested against).

## What changed vs. what you sent me

**Auth** (`server.js`, `models/User.js`) — same login/register/dashboard/logout flow
you had, lightly cleaned up (removed duplicated User schema, moved session secret to
`.env` via `SESSION_SECRET`).

**Resume analyzer** — your `index.html` frontend called `/upload`, `/analyze`,
`/get-suggestions`, `/search-job`, but none of those routes existed anywhere in what
you gave me. I built the backend for all four (`utils/resumeAI.js`, `utils/textExtractor.js`),
and the page is now `views/resume.ejs` (session-protected, served at `/resume`).

**Extraction accuracy fixes** (`utils/textExtractor.js`):
- DOCX: `mammoth.extractRawText`, with an HTML-strip fallback if raw extraction comes
  back too short (some DOCX structures confuse raw-text mode).
- PDF: `pdf-parse` first; text is cleaned (de-hyphenation across line wraps, whitespace
  normalization). If the result looks like a scanned/image-only PDF (too few characters
  per page, or high junk-character ratio), it **automatically falls back to OCR**,
  capped at 6 pages for latency.
- This is the main fix for "extraction not working correctly" — plain `pdf-parse` alone
  silently returns empty/garbage text for scanned resumes with no signal that it failed.

**OCR backend swap (this pass)** — the OCR fallback previously rendered pages with
`pdf2pic`, which shells out to GraphicsMagick/ImageMagick. That's exactly the
"needs manual installation on Windows" problem from your original workflow notes, and
it's why OCR silently produced nothing on hosts without those tools on PATH. It's been
replaced with `pdfjs-dist` (renders each PDF page) + `@napi-rs/canvas` (provides the
canvas `pdfjs-dist` renders into) + `tesseract.js` (reads the rendered page image) — a
pure-JS/native-binding pipeline with no GraphicsMagick/ImageMagick step. `npm install`
alone is now enough on Windows, Mac, Linux, or a managed host.

**Resume page UI (this pass)** — `views/resume.ejs` was rebuilt with a distinct visual
identity (dark "desk" background, paper-toned analyzer card, ink-stamp decision badge,
serif/mono type pairing) and two correctness fixes:
- Every AI-generated or user-entered string (target job, summary, skill tags,
  recommendations) is now escaped (or inserted via `textContent`) before touching the
  DOM — the previous version built HTML via template strings with those values
  interpolated straight into `innerHTML`, which is an XSS hole (the target-job field is
  literally free-text input).
- Switched from `.onclick =` assignment to `addEventListener` throughout.

**Interview section** (new: `utils/interviewAI.js`, `models/InterviewReport.js`,
`views/interview-*.ejs`) — a full loop gated behind having analyzed a resume first:

```
/interview              → start / resume-in-progress screen
/interview/start (POST) → resets interview state
/interview/technical    → 5 AI-generated concept questions (GET renders, POST grades)
/interview/coding       → 1 AI-generated coding problem (GET renders, POST reviews code)
/interview/hr           → 5 AI-generated behavioral questions (GET renders, POST grades)
/interview/report       → weighted final score (Technical 40% / Coding 35% / HR 25%)
                           + AI narrative summary, strengths, weaknesses, recommendations
                           — persisted to MongoDB via InterviewReport
/interview/restart      → clears in-progress state
```

Interview state lives in the Express session (`req.session.interview`) as you move
through rounds, and the completed report is saved to Mongo (`InterviewReport` model)
tied to the logged-in user.

## Notes / things worth knowing

- The coding round is reviewed by the model reading the code, not by executing it —
  there's no sandboxed code runner here. Feedback covers logic, edge cases, and
  complexity, but won't catch a syntax typo the way a real compiler would. Say if you
  want an execution-based judge added (adds real complexity: sandboxing untrusted
  code safely).
- Session-based storage means interview progress resets if the server restarts or the
  session cookie is cleared. Fine for a single run/demo; for production you'd want to
  persist in-progress state to Mongo too, not just the final report.
- Model used for all Mistral calls: `mistral-large-latest`. Change `MODEL` in
  `utils/mistralClient.js` if you want a cheaper/faster model for suggestions.
- `multer` uses memory storage (no temp files written to disk for uploads).

const { mistralJSON, MODEL_SMALL } = require('./mistralClient');
const crypto = require('crypto');

// Simple in-memory cache so identical resume text / search queries within a server's
// lifetime don't re-hit the API. Keeps job suggestions feeling instant on repeat use.
// (Per-process only — fine for this use case, no need for Redis here.)
const suggestionCache = new Map();
const searchCache = new Map();
const CACHE_MAX_ENTRIES = 200;

function cacheGet(map, key) {
    return map.has(key) ? map.get(key) : null;
}
function cacheSet(map, key, value) {
    if (map.size >= CACHE_MAX_ENTRIES) {
        map.delete(map.keys().next().value); // drop oldest
    }
    map.set(key, value);
}
function hash(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

async function analyzeResume(resumeText, targetJob) {
    const system = `You are a strict, expert technical recruiter and ATS (Applicant Tracking System) simulator.
You evaluate resumes against a specific target job with realistic, well-calibrated scoring — do not inflate scores.
Always respond with ONLY a valid JSON object matching the exact schema requested. No markdown, no commentary.`;

    const user = `Analyze this resume against the target job title: "${targetJob}".

RESUME TEXT:
"""
${resumeText.slice(0, 6000)}
"""

Return a JSON object with exactly these fields:
{
  "targetJob": string,
  "matchScore": number (0-100, how well the resume matches this specific job),
  "atsScore": number (0-100, how well an ATS would parse/rank this resume: formatting, keywords, structure),
  "decision": "SUITABLE" or "NOT SUITABLE",
  "confidence": number (0-100, your confidence in this decision),
  "summary": string (3-4 sentences, honest assessment),
  "strengths": array of 3-6 short strings (skills/experience that match well),
  "missingSkills": array of 2-6 short strings (important skills/keywords missing for this role),
  "recommendations": array of 3-5 short actionable strings to improve the resume for this role,
  "estimatedAfterImprovement": number (0-100, realistic matchScore if recommendations are applied)
}`;

    return mistralJSON(system, user, { temperature: 0.3, maxTokens: 1200 });
}

async function getJobSuggestions(resumeText) {
    const excerpt = resumeText.slice(0, 1500);
    const cacheKey = hash(excerpt);
    const cached = cacheGet(suggestionCache, cacheKey);
    if (cached) return cached;

    const system = `You are a career advisor. Based on a resume, suggest realistic job titles the candidate is qualified for.
Respond with ONLY valid JSON: {"suggestions": ["Job Title 1", "Job Title 2", ...]}. Provide 8-12 concise, real-world job titles.`;

    const user = `Resume excerpt:\n"""\n${excerpt}\n"""\n\nSuggest matching job titles.`;

    // Small model: this is a short, low-stakes list of job titles, not a scored
    // evaluation — mistral-small-latest returns it in a fraction of the time
    // mistral-large-latest takes, which is what was making this step feel slow.
    const result = await mistralJSON(system, user, { temperature: 0.5, maxTokens: 400, model: MODEL_SMALL });
    const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
    cacheSet(suggestionCache, cacheKey, suggestions);
    return suggestions;
}

async function searchJobs(query, resumeText) {
    const cacheKey = hash(query.toLowerCase().trim() + '|' + resumeText.slice(0, 800));
    const cached = cacheGet(searchCache, cacheKey);
    if (cached) return cached;

    const system = `You are a career advisor helping search/filter job titles based on a user's partial search query and their resume background.
Respond with ONLY valid JSON: {"suggestions": ["Job Title 1", "Job Title 2", ...]}. Provide up to 8 relevant job titles that relate to the query, informed by the resume.`;

    const user = `Search query: "${query}"\n\nResume excerpt:\n"""\n${resumeText.slice(0, 800)}\n"""\n\nSuggest job titles matching this search, considering both the query and the candidate's background.`;

    const result = await mistralJSON(system, user, { temperature: 0.5, maxTokens: 300, model: MODEL_SMALL });
    const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
    cacheSet(searchCache, cacheKey, suggestions);
    return suggestions;
}

module.exports = { analyzeResume, getJobSuggestions, searchJobs };

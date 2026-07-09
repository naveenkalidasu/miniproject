const { mistralJSON } = require('./mistralClient');

const JSON_ONLY = 'Always respond with ONLY a valid JSON object matching the exact schema requested. No markdown, no commentary, no code fences.';

// ---------- TECHNICAL ROUND ----------

async function generateTechnicalQuestions(resumeText, targetJob) {
    const system = `You are a senior technical interviewer conducting a technical concepts round for the role of "${targetJob}". ${JSON_ONLY}`;
    const user = `Candidate resume excerpt:\n"""\n${resumeText.slice(0, 3000)}\n"""\n\nGenerate 5 technical interview questions (concepts, not coding problems) tailored to this candidate's background and the target role "${targetJob}". Mix difficulty: 2 easy, 2 medium, 1 hard.

Return JSON:
{
  "questions": [
    { "id": "t1", "question": string, "difficulty": "easy"|"medium"|"hard" },
    ...
  ]
}`;
    const result = await mistralJSON(system, user, { temperature: 0.6, maxTokens: 900 });
    return Array.isArray(result.questions) ? result.questions : [];
}

async function evaluateTechnical(questions, answers, targetJob) {
    const system = `You are a strict senior technical interviewer grading a candidate's answers for the role of "${targetJob}". Be realistic, not lenient. ${JSON_ONLY}`;
    const pairs = questions.map(q => ({
        question: q.question,
        difficulty: q.difficulty,
        answer: answers[q.id] || '(no answer provided)'
    }));
    const user = `Grade each Q&A pair on correctness and depth (0-10 each). Then give an overall score (0-100) and brief feedback.

Q&A pairs:
${JSON.stringify(pairs, null, 2)}

Return JSON:
{
  "perQuestion": [ { "question": string, "score": number (0-10), "comment": string } ],
  "overallScore": number (0-100),
  "feedback": string (2-4 sentences, overall assessment of technical depth)
}`;
    return mistralJSON(system, user, { temperature: 0.3, maxTokens: 1000 });
}

// ---------- CODING ROUND ----------

async function generateCodingProblem(targetJob, resumeText) {
    const system = `You are a technical interviewer designing ONE coding challenge appropriate for a candidate applying for "${targetJob}". ${JSON_ONLY}`;
    const user = `Candidate background excerpt:\n"""\n${resumeText.slice(0, 1500)}\n"""\n\nDesign one coding problem of medium difficulty, solvable in 20-30 minutes, relevant to the role "${targetJob}" (use general programming/algorithm concepts if the role isn't purely technical).

Return JSON:
{
  "title": string,
  "difficulty": "easy"|"medium"|"hard",
  "description": string (clear problem statement),
  "sampleInput": string,
  "sampleOutput": string,
  "constraints": string
}`;
    return mistralJSON(system, user, { temperature: 0.6, maxTokens: 700 });
}

async function evaluateCoding(problem, code, language) {
    const system = `You are a senior software engineer reviewing a candidate's code submission during an interview. You cannot execute the code, so review it by careful reading for correctness, edge cases, complexity, and code quality. Be realistic and specific. ${JSON_ONLY}`;
    const user = `Problem:
Title: ${problem.title}
Description: ${problem.description}
Sample Input: ${problem.sampleInput}
Sample Output: ${problem.sampleOutput}
Constraints: ${problem.constraints || 'n/a'}

Candidate's solution (language: ${language}):
"""
${(code || '').slice(0, 4000)}
"""

Evaluate the submission. Return JSON:
{
  "score": number (0-100),
  "correctness": string (does the logic solve the problem? note any bugs or missed edge cases),
  "codeQuality": string (readability, structure, naming),
  "complexity": string (estimated time/space complexity if determinable),
  "feedback": string (2-4 sentences, overall assessment)
}`;
    return mistralJSON(system, user, { temperature: 0.3, maxTokens: 900 });
}

// ---------- HR ROUND ----------

async function generateHRQuestions(targetJob) {
    const system = `You are an HR interviewer for the role of "${targetJob}". ${JSON_ONLY}`;
    const user = `Generate 5 behavioral/HR interview questions appropriate for this role (motivation, teamwork, conflict resolution, career goals, culture fit).

Return JSON:
{
  "questions": [ { "id": "h1", "question": string }, ... ]
}`;
    const result = await mistralJSON(system, user, { temperature: 0.6, maxTokens: 600 });
    return Array.isArray(result.questions) ? result.questions : [];
}

async function evaluateHR(questions, answers, targetJob) {
    const system = `You are an experienced HR interviewer assessing culture fit and communication for the role of "${targetJob}". ${JSON_ONLY}`;
    const pairs = questions.map(q => ({
        question: q.question,
        answer: answers[q.id] || '(no answer provided)'
    }));
    const user = `Assess these HR Q&A pairs for communication clarity, self-awareness, and role fit.

Q&A pairs:
${JSON.stringify(pairs, null, 2)}

Return JSON:
{
  "overallScore": number (0-100),
  "feedback": string (2-4 sentences)
}`;
    return mistralJSON(system, user, { temperature: 0.3, maxTokens: 700 });
}

// ---------- FINAL REPORT ----------

async function generateFinalReport({ targetJob, technical, coding, hr }) {
    const weighted = Math.round(
        (technical.overallScore || 0) * 0.4 +
        (coding.score || 0) * 0.35 +
        (hr.overallScore || 0) * 0.25
    );

    const system = `You are the hiring panel lead compiling a final interview report for the role of "${targetJob}", based on scores and feedback from technical, coding, and HR rounds. Be honest and calibrated. ${JSON_ONLY}`;
    const user = `Round results:
- Technical round score: ${technical.overallScore}/100. Feedback: ${technical.feedback}
- Coding round score: ${coding.score}/100. Feedback: ${coding.feedback}
- HR round score: ${hr.overallScore}/100. Feedback: ${hr.feedback}

Weighted overall score (already computed): ${weighted}/100

Return JSON:
{
  "decision": "STRONG HIRE" | "HIRE" | "BORDERLINE" | "NO HIRE",
  "summary": string (4-6 sentences, holistic narrative across all three rounds),
  "strengths": array of 3-5 short strings,
  "weaknesses": array of 2-5 short strings,
  "recommendations": array of 3-5 short actionable strings for the candidate to improve
}`;
    const narrative = await mistralJSON(system, user, { temperature: 0.4, maxTokens: 900 });

    return {
        overallScore: weighted,
        decision: narrative.decision,
        summary: narrative.summary,
        strengths: narrative.strengths || [],
        weaknesses: narrative.weaknesses || [],
        recommendations: narrative.recommendations || []
    };
}

module.exports = {
    generateTechnicalQuestions,
    evaluateTechnical,
    generateCodingProblem,
    evaluateCoding,
    generateHRQuestions,
    evaluateHR,
    generateFinalReport
};

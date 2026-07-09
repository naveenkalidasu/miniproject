const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL_LARGE = 'mistral-large-latest';
const MODEL_SMALL = 'mistral-small-latest';
const REQUEST_TIMEOUT_MS = 20000;

async function callMistral(messages, { jsonMode = false, temperature = 0.4, maxTokens = 1800, model = MODEL_LARGE } = {}) {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
        throw new Error('MISTRAL_API_KEY is not set in environment variables.');
    }

    const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens
    };
    if (jsonMode) {
        body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(MISTRAL_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Mistral API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The service may be slow or unreachable right now.`);
        }
        throw new Error(`Could not reach Mistral API: ${err.message}`);
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        if (response.status === 401) {
            throw new Error('Mistral API rejected the request (401 Unauthorized) — check that MISTRAL_API_KEY is correct and active.');
        }
        throw new Error(`Mistral API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('Mistral API returned an empty response.');
    }
    return content;
}

/**
 * Strip markdown code fences if the model wraps JSON in ```json ... ```
 */
function stripFences(text) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

/**
 * Ask Mistral for a JSON response and parse it, with one retry if parsing fails.
 */
async function mistralJSON(systemPrompt, userPrompt, opts = {}) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    let raw = await callMistral(messages, { ...opts, jsonMode: true });
    try {
        return JSON.parse(stripFences(raw));
    } catch (err) {
        // Retry once, being extra explicit about the JSON requirement
        const retryMessages = [
            ...messages,
            { role: 'assistant', content: raw },
            { role: 'user', content: 'That was not valid JSON. Respond again with ONLY a valid JSON object, no markdown, no commentary.' }
        ];
        raw = await callMistral(retryMessages, { ...opts, jsonMode: true });
        return JSON.parse(stripFences(raw));
    }
}

module.exports = { callMistral, mistralJSON, MODEL_LARGE, MODEL_SMALL };

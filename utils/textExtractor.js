// NOTE: requiring 'pdf-parse' directly can throw a spurious ENOENT for
// './test/data/05-versions-space.pdf' — a known bug where the package's
// index.js runs debug/self-test code whenever `module.parent` looks falsy
// (common under some bundlers/runtimes). Requiring the inner lib file
// skips that debug wrapper entirely and calls the same parser.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const mammoth = require('mammoth');
const path = require('path');

/**
 * Clean up extracted text: collapse excess whitespace/blank lines,
 * fix hyphenation breaks, normalize bullets — without mangling structure.
 */
function cleanText(raw) {
    if (!raw) return '';
    return raw
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        // join words that were hyphen-broken across a line wrap: "develop-\nment" -> "development"
        .replace(/([a-zA-Z])-\n([a-zA-Z])/g, '$1$2')
        // collapse 3+ blank lines to a max of 2
        .replace(/\n{3,}/g, '\n\n')
        // collapse runs of spaces/tabs
        .replace(/[ \t]{2,}/g, ' ')
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .trim();
}

/**
 * Heuristic: does this look like real extracted text, or garbage/empty
 * output from a scanned (image-only) PDF?
 */
function looksLikeScannedOrEmpty(text, numPages) {
    const trimmed = (text || '').trim();
    if (trimmed.length === 0) return true;
    const charsPerPage = trimmed.length / Math.max(numPages, 1);
    if (charsPerPage < 40) return true; // very little text per page -> likely scanned
    // Too many replacement/control characters is also a sign of bad extraction
    const junkRatio = (trimmed.match(/[^\x09\x0A\x0D\x20-\x7E]/g) || []).length / trimmed.length;
    if (junkRatio > 0.15) return true;
    return false;
}

/**
 * OCR fallback for scanned/image-based PDFs using pdfjs-dist + @napi-rs/canvas + tesseract.js.
 * Renders each page to an in-memory PNG, then OCRs it. Unlike pdf2pic, this needs no
 * GraphicsMagick/ImageMagick install — `npm install` alone is enough, which matters on
 * Windows/managed hosting where those tools are a pain to get on PATH.
 */
async function ocrPdfBuffer(buffer) {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const { createCanvas } = require('@napi-rs/canvas');
    const Tesseract = require('tesseract.js');

    let doc;
    const MAX_OCR_PAGES = 6; // safety cap - OCR is slow, keep this bounded

    try {
        doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    } catch (err) {
        return { text: '', renderFailedReason: `OCR could not open this PDF for page rendering: ${err.message}` };
    }

    let combinedText = '';
    let renderFailedReason = null;
    const worker = await Tesseract.createWorker('eng');

    try {
        const maxPages = Math.min(doc.numPages, MAX_OCR_PAGES);
        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
            try {
                const page = await doc.getPage(pageNum);
                const viewport = page.getViewport({ scale: 2 });
                const canvas = createCanvas(viewport.width, viewport.height);
                const ctx = canvas.getContext('2d');

                await page.render({ canvasContext: ctx, viewport }).promise;
                const pngBuffer = canvas.toBuffer('image/png');

                const { data } = await worker.recognize(pngBuffer);
                combinedText += '\n' + (data.text || '');
            } catch (pageErr) {
                console.error(`OCR page ${pageNum} error:`, pageErr.message);
                if (pageNum === 1) renderFailedReason = `OCR page rendering failed: ${pageErr.message}`;
            }
        }
    } finally {
        await worker.terminate();
    }

    return { text: combinedText, renderFailedReason };
}

/**
 * Main entry point: extract text from an uploaded file buffer.
 * Returns { text, method, charCount, ocrUsed }
 */
async function extractText(buffer, originalName) {
    const ext = path.extname(originalName).toLowerCase();

    if (ext === '.txt') {
        const text = cleanText(buffer.toString('utf-8'));
        return { text, method: 'TXT', charCount: text.length, ocrUsed: false };
    }

    if (ext === '.docx') {
        // mammoth.extractRawText preserves paragraph text well; convertToHtml is used
        // only as a fallback if raw text extraction comes back too short (e.g. odd docx structure)
        let rawText;
        try {
            ({ value: rawText } = await mammoth.extractRawText({ buffer }));
        } catch (err) {
            throw new Error(`Could not read this .docx file (it may be corrupted or password-protected): ${err.message}`);
        }
        let text = cleanText(rawText);

        if (text.length < 40) {
            const { value: html } = await mammoth.convertToHtml({ buffer });
            const fallbackText = cleanText(html.replace(/<[^>]+>/g, '\n'));
            if (fallbackText.length > text.length) text = fallbackText;
        }
        if (text.length < 20) {
            throw new Error('This .docx file appears to have no extractable text content (it may be empty, image-only, or unusually formatted).');
        }
        return { text, method: 'DOCX', charCount: text.length, ocrUsed: false };
    }

    if (ext === '.pdf') {
        let parsed;
        let pdfParseError = null;
        try {
            parsed = await pdfParse(buffer);
        } catch (err) {
            pdfParseError = err.message;
            console.error('pdf-parse failed:', err.message);
            parsed = { text: '', numpages: 1 };
        }
        let text = cleanText(parsed.text);
        const numPages = parsed.numpages || 1;

        if (looksLikeScannedOrEmpty(text, numPages)) {
            // Fall back to OCR for scanned / image-only PDFs
            let ocrResult;
            try {
                ocrResult = await ocrPdfBuffer(buffer);
            } catch (err) {
                ocrResult = { text: '', renderFailedReason: err.message };
            }
            const ocrText = cleanText(ocrResult.text);

            if (ocrText.length > text.length && ocrText.length >= 20) {
                return { text: ocrText, method: 'PDF (OCR)', charCount: ocrText.length, ocrUsed: true };
            }

            // Both direct extraction and OCR came up empty — give a specific, actionable reason
            // instead of a generic "could not extract" message every time.
            if (ocrResult.renderFailedReason) {
                throw new Error(
                    'This PDF looks like a scanned/image-based document, and the OCR step failed ' +
                    `(${ocrResult.renderFailedReason}). Please try the "Paste Text" tab instead, ` +
                    'or upload a text-based PDF/DOCX.'
                );
            }
            if (pdfParseError) {
                throw new Error(`Could not parse this PDF: ${pdfParseError}. Try re-saving/exporting it, or use "Paste Text" instead.`);
            }
        }
        return { text, method: 'PDF', charCount: text.length, ocrUsed: false };
    }

    throw new Error('Unsupported file type. Please upload PDF, DOCX, or TXT.');
}

module.exports = { extractText, cleanText };

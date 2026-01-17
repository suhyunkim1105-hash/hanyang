// netlify/functions/solve.js
// ------------------------------------------------------------
// HUFS Transfer English (T2 / T2-1) solver - Answers only
// - Fixed: model = openai/gpt-4.1, temperature = 0.1
// - Removed: stop token usage entirely
// Input: { ocrText: string, page?: number } OR { pages: [{page:number, text:string}] }
// Output: { ok:true, text:"1: A\n2: D\n... (1..50)", debug:{...} }
//
// Required env:
// - OPENROUTER_API_KEY
// ------------------------------------------------------------

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStr(x) {
  return typeof x === "string" ? x : String(x ?? "");
}

// ========== OCR NORMALIZATION (your rules) ==========
// 1) Choices: always A) B) C) D)
//    OCR variants: A. A> A: ① etc -> normalize
// 2) Underline marker: wrap only underlined token as <...> (we accept OCR-bracket noise)
// 3) Blank: always BLANK (no underscores)
// 4) Separators: ——
// 5) Use only <> (avoid mixing (), [])
function normalizeOcr(text) {
  let t = safeStr(text);

  // unify newlines
  t = t.replace(/\r\n?/g, "\n");

  // normalize long dashes to "——" if 4+ dash-like chars
  t = t.replace(/[—–\-＿_]{4,}/g, "——");
  t = t.replace(/(\s*-\s*){4,}/g, "——");

  // blank normalization
  t = t.replace(/[_]{2,}/g, "BLANK");
  t = t.replace(/[□■▢▣]+/g, "BLANK");
  t = t.replace(/\(\s*\)/g, "BLANK");
  t = t.replace(/\[\s*\]/g, "BLANK");
  t = t.replace(/<\s*>/g, "BLANK");

  // normalize circled choices to A)B)C)D)
  t = t
    .replace(/①/g, "A)")
    .replace(/②/g, "B)")
    .replace(/③/g, "C)")
    .replace(/④/g, "D)");

  // normalize choice markers like A. A> A: A -  (only when it looks like a choice marker)
  t = t.replace(/(^|\n|\s)([A-D])\s*[\.\:\>\-]\s+/g, "$1$2) ");
  t = t.replace(/(^|\n|\s)([A-D])\s+\.\s+/g, "$1$2) ");
  t = t.replace(/(^|\n|\s)([A-D])\s*\)\s+/g, "$1$2) ");

  // bracket noise -> angle brackets (LIMITED heuristic)
  // Convert [token], (token), {token} -> <token> when token is short and no spaces.
  t = t.replace(/[\[\(\{]([A-Za-z0-9_\-]{1,30})[\]\)\}]/g, "<$1>");
  // Also cleanup "< token >"
  t = t.replace(/<\s*([A-Za-z0-9_\-]{1,50})\s*>/g, "<$1>");

  // inline (A)(B)(C)(D) references -> <A><B><C><D>
  t = t.replace(/\(([A-D])\)/g, "<$1>");
  t = t.replace(/\[([A-D])\]/g, "<$1>");

  // compress whitespace
  t = t.replace(/[ \t]{2,}/g, " ");

  return t.trim();
}

// Collect question numbers (1..50) to debug “what OCR contained”
function collectQuestionNumbers(text) {
  const seen = new Set();
  const t = "\n" + safeStr(text) + "\n";

  // strong: line-start "14." "14)" "14:"
  const re = /(?:\n|\r)\s*(\d{1,2})\s*[\.\)\:]\s+/g;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 50) seen.add(n);
  }

  // weak fallback: " 14. "
  const re2 = /(^|[^\d])(\d{1,2})\s*\./g;
  while ((m = re2.exec(t))) {
    const n = Number(m[2]);
    if (n >= 1 && n <= 50) seen.add(n);
  }

  return Array.from(seen).sort((a, b) => a - b);
}

// ========== PROMPT ==========
// We embed TWO things:
// (A) verified paper-structure (by question number ranges)
// (B) your trend analysis as PRIOR (9/8/4/29) to bias type inference, not to hardcode answers
function buildPrompt(normalizedText, seenNums) {
  const verifiedStructure = `
[VERIFIED HUFS T2/T2-1 PAPER STRUCTURE (by question ranges)]
- Q1-4  : sentence completion (short, usually vocab/usage)
- Q5-9  : replace the underlined word/phrase (synonym replacement)
- Q10-13: contextual meaning of the underlined word/phrase
- Q14-15: closest in meaning (paraphrase / restatement)
- Q16-17: sentence completion (grammar/word order/structure)
- Q18-19: choose the underlined segment (A/B/C/D) that makes the sentence grammatically incorrect
- Q20-21: choose the option sentence (A/B/C/D) that is grammatically incorrect
- Q22-50: reading passages (all 4-choice A/B/C/D)
`;

  const trendPrior = `
[TREND PRIOR (your analysis)]
- Total 50 questions, 4 choices only (A/B/C/D).
- Category counts are stable across years in your analysis: Vocabulary 9, Grammar+Restatement 8, Logic 4, Reading 29.
- IMPORTANT: Use this as a PRIOR to recognize the likely type, but NEVER force any fixed answer by number.
- Practical mapping hint (soft): Reading is overwhelmingly Q22-50. Many grammar/error items cluster around Q18-21.
`;

  const yourRules = `
[YOUR INPUT RULES (already normalized)]
- Choices use A) B) C) D)
- Underlined tokens appear as <...>
- Blanks appear as BLANK
- Separators may appear as —— between blocks/pages
- Brackets may be noisy; treat <> as the only underline/marker format
`;

  const outputRules = `
[OUTPUT RULES - ABSOLUTE]
- Output EXACTLY 50 lines, from 1 to 50.
- Each line format: "n: A" or "n: B" or "n: C" or "n: D"
- If OCR is missing/garbled for that question, still pick one but add "?" like "n: B?"
- No explanations, no extra text, no blank lines.
`;

  const seenLine = `Seen question numbers detected from OCR (may be incomplete): ${seenNums.length ? seenNums.join(", ") : "(none)"}`;

  return `
You are a specialized solver for HUFS (Korea University of Foreign Studies) transfer English T2/T2-1.
Your ONLY goal is maximizing answer accuracy from noisy OCR text.

${verifiedStructure}
${trendPrior}
${yourRules}
${outputRules}

${seenLine}

[OCR TEXT START]
${normalizedText}
[OCR TEXT END]
`.trim();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// Parse model output and FORCE 1..50 lines even if model misses some.
function extractAnswers(modelText) {
  const lines = safeStr(modelText)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const map = new Map();

  for (const line of lines) {
    const m = line.match(/^(\d{1,2})\s*:\s*([ABCD])(\?)?$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > 50) continue;
    const letter = m[2];
    const unsure = !!m[3];
    map.set(n, letter + (unsure ? "?" : ""));
  }

  const out = [];
  const unsureNums = [];

  for (let n = 1; n <= 50; n++) {
    let v = map.get(n);
    if (!v) v = "A?"; // missing line fallback (keeps "no missing numbers" rule)
    if (v.endsWith("?")) unsureNums.push(n);
    out.push(`${n}: ${v}`);
  }

  return { text: out.join("\n"), unsureNums };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });

    // FIXED per your request
    const model = "openai/gpt-4.1";
    const temperature = 0.1;
    const maxTokens = 900;

    // Parse body
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    // Accept combined or multi-page bundle
    let ocrText = "";
    if (Array.isArray(body.pages)) {
      const parts = body.pages
        .map((p) => {
          const pg = Number(p?.page ?? "");
          const tx = safeStr(p?.text ?? p?.ocrText ?? "");
          if (!tx.trim()) return "";
          return `\n—— PAGE ${Number.isFinite(pg) ? pg : ""} ——\n${tx}\n`;
        })
        .filter(Boolean);
      ocrText = parts.join("\n");
    } else {
      ocrText = safeStr(body.ocrText || body.text || "");
      const page = body.page ?? "";
      if (page !== "" && ocrText.trim()) ocrText = `—— PAGE ${page} ——\n` + ocrText;
    }

    if (!ocrText.trim()) return json(400, { ok: false, error: "Empty ocrText" });

    const normalized = normalizeOcr(ocrText);

    // Prevent overload / mobile huge OCR (avoid server lag)
    // Keep head+tail which usually preserves stems+choices across pages.
    const MAX_CHARS = 45000;
    let clipped = normalized;
    let clippedInfo = null;
    if (normalized.length > MAX_CHARS) {
      const head = normalized.slice(0, 26000);
      const tail = normalized.slice(-16000);
      clipped = head + "\n—— CLIPPED MIDDLE ——\n" + tail;
      clippedInfo = { originalChars: normalized.length, usedChars: clipped.length };
    }

    const seenNums = collectQuestionNumbers(clipped);
    const prompt = buildPrompt(clipped, seenNums);

    const url = "https://openrouter.ai/api/v1/chat/completions";

    const payload = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content:
            "Return only the 50 answer lines. No explanations. If uncertain, add '?' after the letter.",
        },
        { role: "user", content: prompt },
      ],
    };

    // Retry (network hiccups)
    let lastErr = null;
    const attempts = 3;

    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
          25000
        );

        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`OpenRouter HTTP ${res.status}: ${t.slice(0, 300)}`);
        }

        const data = await res.json();
        const raw =
          data?.choices?.[0]?.message?.content ??
          data?.choices?.[0]?.text ??
          "";

        if (!raw.trim()) throw new Error("Empty model output");

        const { text, unsureNums } = extractAnswers(raw);

        return json(200, {
          ok: true,
          text,
          debug: {
            model,
            temperature,
            maxTokens,
            seenNums,
            unsureNums,
            clippedInfo,
          },
        });
      } catch (e) {
        lastErr = e;
        await sleep(400 + i * i * 500);
      }
    }

    return json(502, {
      ok: false,
      error: "Model call failed",
      detail: String(lastErr?.message || lastErr || "unknown"),
    });
  } catch (e) {
    return json(500, { ok: false, error: "Server error", detail: String(e?.message || e) });
  }
};


// netlify/functions/solve.js
// ------------------------------------------------------------
// HUFS(한국외대) 편입영어 T2 전용: "지금 OCR에서 감지된 문항번호만" 정답 생성
// - 모델: openai/gpt-4.1 고정
// - temperature: 0.1 고정
// - stop token 사용/설정/전달: 전부 제거
// - 보기: 4지선다(1~4)만
// - 핵심: 지문/구간표/숫자 잡음 때문에 "이상한 문항번호"가 섞이는 문제를 강하게 차단
//
// 입력(JSON):
// { ocrText: string, page?: number }
// 출력(JSON):
// { ok: true, text: "8: 2\n9: 4\n...", debug: {...} }

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(input) {
  let t = String(input || "");

  // Normalize newlines
  t = t.replace(/\r\n?/g, "\n");

  // Normalize common OCR chevrons/angle quotes used to indicate underlines
  // ‹word›, 〈word〉, «word», 《word》 -> <word>
  t = t
    .replace(/[‹〈«《]/g, "<")
    .replace(/[›〉»》]/g, ">");

  // Fix cases like "<precipitous)" -> "<precipitous>"
  t = t.replace(/<([^>\n]{1,40})\)/g, "<$1>");

  // Normalize blanks: ____ -> BLANK
  t = t.replace(/_{2,}/g, "BLANK");

  // Normalize passage markers: (A), （A）, (A/when) -> <A>
  t = t.replace(/[（(]\s*([ABCD])\s*[）)]/g, "<$1>");
  t = t.replace(/[（(]\s*([ABCD])\s*[/|:]\s*/g, "<$1> ");
  // Also handle "A/when" without parentheses (rare)
  t = t.replace(/\b([ABCD])\s*\/\s*/g, "<$1> ");

  // Normalize option labels:
  // Circled digits (①②③④ etc.) -> A)B)C)D)
  const circledMap = [
    [/[\u2460\u2776]/g, "A)"], // ① ❶
    [/[\u2461\u2777]/g, "B)"], // ② ❷
    [/[\u2462\u2778]/g, "C)"], // ③ ❸
    [/[\u2463\u2779]/g, "D)"], // ④ ❹
  ];
  for (const [re, rep] of circledMap) t = t.replace(re, rep);

  // If OCR breaks A) as "A." "A:" "A>" etc at line starts, normalize to A)
  t = t.replace(/(^|\n)\s*([ABCD])\s*[\.\:\>\)]\s+/g, "$1$2) ");

  // Reduce some noisy double spaces
  t = t.replace(/[ \t]{2,}/g, " ");

  return t.trim();
}

// Strictly detect question numbers as line-start "n." or "n)"
function detectQuestionNumbersStrict(text) {
  const nums = new Set();
  const lines = text.split("\n");
  for (const line of lines) {
    const s = line.trimStart();
    // skip bracketed range lines like "[18-30: ...]"
    if (s.startsWith("[") || s.startsWith("]")) continue;
    const m = s.match(/^(\d{1,2})\s*[\.\)]\s+/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 50) nums.add(n);
    }
  }
  return Array.from(nums).sort((a, b) => a - b);
}

// Fallback detection: if strict finds none, try looser but still guarded
function detectQuestionNumbersFallback(text) {
  const nums = new Set();
  // Find patterns like "\n 18 " where near it there is "A)" / "Choose" / "Which"
  const re = /(^|\n)\s*(\d{1,2})\s+(?=.{0,60}(A\)|B\)|C\)|D\)|Choose|Which))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[2]);
    if (n >= 1 && n <= 50) nums.add(n);
  }
  return Array.from(nums).sort((a, b) => a - b);
}

function detectQuestionNumbers(text) {
  const strict = detectQuestionNumbersStrict(text);
  if (strict.length > 0) return strict;
  return detectQuestionNumbersFallback(text);
}

function buildRelevantExcerpt(text, qnums) {
  // We want to include enough context BEFORE each question
  // (especially reading passages), but avoid sending whole OCR trash.
  // Strategy: make windows around each detected question start index.
  const indices = [];

  for (const n of qnums) {
    const re = new RegExp(`(^|\\n)\\s*${n}\\s*[\\.|\\)]\\s+`, "g");
    const m = re.exec(text);
    if (m && typeof m.index === "number") {
      indices.push({ n, idx: m.index });
    }
  }
  indices.sort((a, b) => a.idx - b.idx);

  if (indices.length === 0) {
    // As a last resort, return head
    return text.slice(0, 12000);
  }

  const windows = [];
  const len = text.length;

  for (let i = 0; i < indices.length; i++) {
    const { n, idx } = indices[i];
    const before = n >= 22 ? 3200 : 1400; // 독해는 지문이 필요하므로 더 크게
    const after = 2600;

    const start = Math.max(0, idx - before);
    const end = Math.min(len, idx + after);
    windows.push([start, end]);
  }

  // Merge overlapping windows
  windows.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (!last || w[0] > last[1]) merged.push(w);
    else last[1] = Math.max(last[1], w[1]);
  }

  let excerpt = merged.map(([s, e]) => text.slice(s, e)).join("\n\n---\n\n");

  // Hard cap to avoid model overload / latency
  if (excerpt.length > 14000) excerpt = excerpt.slice(0, 14000);

  return excerpt;
}

function mapChoiceToDigit(x) {
  const s = String(x || "").trim().toUpperCase();
  if (s === "A") return "1";
  if (s === "B") return "2";
  if (s === "C") return "3";
  if (s === "D") return "4";
  if (["1", "2", "3", "4"].includes(s)) return s;
  return null;
}

function parseAnswers(modelText, targetNums) {
  const answers = new Map();
  const text = String(modelText || "");

  // Accept:
  // "18: 4" , "18 - 4" , "18: D"
  const re = /(^|\n)\s*(\d{1,2})\s*[:\-]\s*([1-4ABCD])\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[2]);
    if (!targetNums.includes(n)) continue;
    const digit = mapChoiceToDigit(m[3]);
    if (digit) answers.set(n, digit);
  }

  return answers;
}

async function callOpenRouter({ apiKey, model, temperature, prompt, maxTokens }) {
  const url = "https://openrouter.ai/api/v1/chat/completions";

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      {
        role: "system",
        content:
          "You are a precise test-solver for HUFS transfer English (50 questions, 4 choices).\n" +
          "You MUST output ONLY the requested question numbers, each as: n: 1|2|3|4\n" +
          "No explanations, no extra lines, no missing numbers.\n" +
          "If choices are labeled A/B/C/D, map A=1, B=2, C=3, D=4.\n" +
          "If choices are labeled ①②③④, treat them as 1..4 in that order.\n" +
          "Markers: BLANK means a blank. Underlined words may be wrapped in <...>. Passage markers may be <A><B><C><D>.\n" +
          "HUFS typical structure hint (do NOT assume answers):\n" +
          "- 1-13 Vocabulary (1 point): 1-4 sentence completion; 5-9 replace underlined; 10-13 contextual meaning.\n" +
          "- 14-17 Grammar/Paraphrase (2 points): 14-15 closest meaning; 16-17 sentence completion.\n" +
          "- 18-19 choose the underlined segment that makes the sentence grammatically INCORRECT.\n" +
          "- 20-21 choose the grammatically INCORRECT sentence among four.\n" +
          "- 22-50 Reading comprehension.",
      },
      { role: "user", content: prompt },
    ],
  };

  // retries (network/5xx)
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // Optional OpenRouter headers (safe to omit, but ok to keep)
          "HTTP-Referer": "https://example.com",
          "X-Title": "HUFS-T2-Solver",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`OpenRouter HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }

      const data = await res.json();
      const out = data?.choices?.[0]?.message?.content ?? "";
      return String(out);
    } catch (e) {
      lastErr = e;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr || new Error("OpenRouter failed");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const raw = String(body.ocrText || body.text || "");
    const page = body.page ?? null;

    const normalized = normalizeText(raw);
    const qnums = detectQuestionNumbers(normalized);

    // 렉 방지: 문항번호 감지 0이면 모델 호출 자체를 하지 않는다.
    if (qnums.length === 0) {
      return json(200, {
        ok: true,
        text: "",
        debug: {
          model: "openai/gpt-4.1",
          temperature: 0.1,
          page,
          detectedNums: [],
          note: "No question numbers detected (line-start n. / n) pattern).",
        },
      });
    }

    // "지금 페이지에서 감지된 번호만" 풀기
    const excerpt = buildRelevantExcerpt(normalized, qnums);

    const prompt =
      `QUESTION NUMBERS TO ANSWER (ONLY THESE): ${qnums.join(", ")}\n` +
      `Return EXACTLY one line per number, format: n: 1|2|3|4\n` +
      `\n=== OCR (normalized excerpt) ===\n` +
      excerpt;

    const model = "openai/gpt-4.1";
    const temperature = 0.1;

    const modelText = await callOpenRouter({
      apiKey,
      model,
      temperature,
      prompt,
      maxTokens: 850,
    });

    const parsed = parseAnswers(modelText, qnums);

    // Fill missing to guarantee "누락 0"
    // (정답 강제 X. 단지 출력 누락 방지용. 모르면 1? 로 표시)
    const lines = [];
    const missing = [];
    const unsure = [];

    for (const n of qnums) {
      const a = parsed.get(n);
      if (a) {
        lines.push(`${n}: ${a}`);
      } else {
        // fallback: mark unsure
        lines.push(`${n}: 1?`);
        missing.push(n);
        unsure.push(n);
      }
    }

    return json(200, {
      ok: true,
      text: lines.join("\n"),
      debug: {
        model,
        temperature,
        page,
        detectedNums: qnums,
        missingFilledWith: missing,
        unsureNums: unsure,
        // for debugging only (trimmed)
        excerptPreview: excerpt.slice(0, 500),
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
};



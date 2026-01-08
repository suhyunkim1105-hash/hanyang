// netlify/functions/solve_debug.js

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_ID = "openai/gpt-4o-mini";
const STOP_TOKEN = "XURTH";

function jsonResponse(statusCode, body) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

// 번호 추출 함수 (0101. 같은 패턴까지 잡는 패치 버전)
function extractQuestionNumbers(text) {
  if (!text) return { rawNumbers: [], normalizedNumbers: [] };

  const rawNumbers = [];

  // 1) 기본 패턴: "01.", "1.", "01 01.", "09.09." 등
  const re1 = /\b(\d{1,2})\s*[\.\)]/g;
  let m;
  while ((m = re1.exec(text)) !== null) {
    rawNumbers.push(m[1]);
  }

  // 2) 특수 패턴: "0101.", "0202.", "0505." 처럼 두 자리 숫자 반복
  //    -> 두 번째 숫자를 문항 번호로 본다 (01, 02, 05 등)
  const re2 = /\b(\d{2})(\1)\s*\./g;
  while ((m = re2.exec(text)) !== null) {
    // m[1]과 m[2]는 같은 문자열이므로 아무거나 파싱해도 됨
    rawNumbers.push(m[2]);
  }

  const normalizedNumbers = Array.from(
    new Set(
      rawNumbers
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 50)
    )
  ).sort((a, b) => a - b);

  return { rawNumbers, normalizedNumbers };
}

exports.handler = async (event, context) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      ok: false,
      errorType: "MethodNotAllowed",
      errorMessage: "Use POST",
    });
  }

  if (!OPENROUTER_API_KEY) {
    return jsonResponse(500, {
      ok: false,
      errorType: "ConfigError",
      errorMessage: "OPENROUTER_API_KEY is not set",
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, {
      ok: false,
      errorType: "BadRequest",
      errorMessage: "Invalid JSON body",
    });
  }

  const text = typeof body.text === "string" ? body.text : "";
  const page = Number.isFinite(body.page) ? body.page : 1;

  if (!text.trim()) {
    return jsonResponse(400, {
      ok: false,
      errorType: "BadRequest",
      errorMessage: "Missing 'text' field in body",
    });
  }

  const { rawNumbers, normalizedNumbers } = extractQuestionNumbers(text);

  if (!normalizedNumbers.length) {
    return jsonResponse(200, {
      ok: false,
      errorType: "NoQuestionsFound",
      errorMessage: "No question numbers detected in text",
      debug: {
        page,
        rawNumbers,
        normalizedNumbers,
      },
    });
  }

  const numbersForPrompt = normalizedNumbers;
  const numberListStr = numbersForPrompt.join(", ");

  const userPrompt = [
    "You are an extremely careful solver for multiple-choice English exam questions.",
    "You will be given OCR text from an exam page.",
    "",
    "OCR_TEXT:",
    '"""',
    text,
    '"""',
    "",
    `The question numbers present on this page are: ${numberListStr}`,
    "",
    "For EACH question number above, output EXACTLY ONE line in this format:",
    "N: <OPTION_LETTER>",
    "where N is the question number, and <OPTION_LETTER> is one of A, B, C, D, or E.",
    "",
    "- Always use CAPITAL letters for options.",
    "- If you truly cannot determine the answer for a number, output `n/a` instead of a letter.",
    "",
    "After listing all answers, add a final line:",
    "UNSURE: <comma-separated list of question numbers you are least confident about, or '-' if you are confident for all>",
    "",
    `Finally, end your output with the token ${STOP_TOKEN} on the same line as the last content (do not add extra text after it).`,
  ].join("\n");

  const payload = {
    model: MODEL_ID,
    temperature: 0,
    max_tokens: 512,
    messages: [
      {
        role: "system",
        content:
          "You are a careful answer generator for multiple-choice English exams. You must follow the output format exactly.",
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
  };

  let apiRes;
  try {
    apiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-debug",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return jsonResponse(500, {
      ok: false,
      errorType: "NetworkError",
      errorMessage: String(e && e.message ? e.message : e),
    });
  }

  if (!apiRes.ok) {
    let errText = "";
    try {
      errText = await apiRes.text();
    } catch (_) {
      errText = "";
    }
    return jsonResponse(apiRes.status, {
      ok: false,
      errorType: "OpenRouterHTTPError",
      errorMessage: `status=${apiRes.status}`,
      detail: errText,
    });
  }

  let data;
  try {
    data = await apiRes.json();
  } catch (e) {
    return jsonResponse(500, {
      ok: false,
      errorType: "OpenRouterParseError",
      errorMessage: "Failed to parse OpenRouter response JSON",
    });
  }

  const choice = data.choices && data.choices[0];
  const completionText =
    choice && choice.message && typeof choice.message.content === "string"
      ? choice.message.content.trim()
      : "";

  const finishReason = choice && choice.finish_reason ? choice.finish_reason : null;

  return jsonResponse(200, {
    ok: true,
    text: completionText,
    debug: {
      page,
      rawNumbers,
      normalizedNumbers,
      numbersForPrompt,
      stopToken: STOP_TOKEN,
      model: MODEL_ID,
      finishReason,
    },
  });
};

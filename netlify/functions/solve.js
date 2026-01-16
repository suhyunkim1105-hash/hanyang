// netlify/functions/solve.js
// ----------------------------------------
// 역할: 외대 편입 영어(T2) 객관식 "정답만" 생성
// 입력: { ocrText?: string, text?: string, page?: number }
// 출력: { ok: true, text: "1: C\n2: B\n...", debug: {...} } 또는 { ok: false, error: "..." }
//
// 환경변수:
// - OPENROUTER_API_KEY (필수)
// - MODEL_NAME        (선택, 기본: "openai/gpt-4.1")
// - TEMPERATURE       (선택, 기본: 0.1)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

// ---------- 유틸 ----------

function safeNumber(x, fallback) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// OCR 텍스트에서 "문제 번호 후보" 추출
// 예: "1. ..." "2)" "10." 등 → 1~50 범위 숫자만 뽑음
function extractVisibleQuestionNumbers(ocrText) {
  const text = String(ocrText || "");
  const nums = new Set();

  // 패턴 1: "12." 또는 "12)"
  const re1 = /(\d{1,2})\s*[\.\)]/g;
  let m;
  while ((m = re1.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 50) {
      nums.add(n);
    }
  }

  // 패턴 2(보조): 줄 시작에 있는 번호 "12 " (마침표 누락 케이스)
  const re2 = /(^|\n)\s*(\d{1,2})\s+(?=[A-Za-z(])/g;
  while ((m = re2.exec(text)) !== null) {
    const n = parseInt(m[2], 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 50) {
      nums.add(n);
    }
  }

  const arr = Array.from(nums).sort((a, b) => a - b);
  return arr;
}

// 가장 긴 연속 구간만 "진짜 문제 번호"로 사용
// 예: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,37] → 1~14만 사용
function getMainQuestionBlock(visible) {
  if (!Array.isArray(visible) || visible.length === 0) return [];

  const nums = Array.from(new Set(visible)).sort((a, b) => a - b);

  const blocks = [];
  let start = nums[0];
  let prev = nums[0];

  for (let i = 1; i < nums.length; i++) {
    const n = nums[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    // 블록 종료
    blocks.push({ start, end: prev, length: prev - start + 1 });
    start = n;
    prev = n;
  }
  blocks.push({ start, end: prev, length: prev - start + 1 });

  // 가장 긴 연속 구간 선택
  let main = null;
  for (const b of blocks) {
    if (!main || b.length > main.length) {
      main = b;
    }
  }

  // 길이가 2 미만이면(번호 1개만 잡힌 경우) 신뢰도 낮으므로 빈 배열 반환
  if (!main || main.length < 2) return [];

  const result = [];
  for (let q = main.start; q <= main.end; q++) {
    result.push(q);
  }
  return result;
}

// 모델에게 줄 프롬프트 구성
function buildPrompt(ocrText, questionNumbers) {
  const qsList = questionNumbers.join(", ");

  const instructions = `
You are an expert exam solver for HUFS (Hankuk University of Foreign Studies) transfer English test (T2).
You will receive OCR text for one or more multiple-choice questions.

Your job:
1. Solve ONLY the questions whose numbers are in this list: [${qsList}].
2. Each question has exactly FOUR choices. The correct answer must be one of: A, B, C, D.
3. For each question number, output exactly one line in this format:
   "<number>: <choice>"
   Example: "1: C"
4. After all question lines, output ONE final line:
   "UNSURE: <comma-separated question numbers>"
   If you are reasonably confident (≥80%) about all answers, write:
   "UNSURE: (none)"

Very important constraints:
- Do NOT answer for any question numbers that are not in [${qsList}].
- Never invent new question numbers.
- Never output explanations, reasoning, summaries, or any extra text.
- Only output the lines of answers and the final UNSURE line.

Answering strategy (must follow):
- Read the OCR text carefully; fix obvious OCR typos mentally (e.g., "hackneved" → "hackneyed", "company" → "companion").
- For vocabulary/synonym questions:
  * Focus on the contextual meaning, not just dictionary definitions.
  * Eliminate options that conflict with tone (positive/negative) or part of speech.
- For grammar questions:
  * Check subject–verb agreement, relative pronouns, word order, and idiomatic usage.
- For paraphrase / closest-in-meaning questions:
  * Pay very careful attention to:
    - Polarity (negation): not, never, hardly, scarcely, no longer, etc.
    - Modality: can, must, may, should, have to, etc.
    - Temporal expressions: now, still, already, yet, so far, any more, any longer.
    - Degree/quantity: too, enough, hardly any, no longer afford, so much, only, just.
  * Do NOT choose an option that flips or weakens these aspects.
  * Example: "can no longer afford to be indifferent" implies:
      (1) Until now, the system HAS BEEN indifferent (too indifferent so far),
      (2) From now on, it cannot remain indifferent.
    The correct paraphrase must preserve BOTH "past excessive indifference" AND "change required now".
- For reading comprehension questions:
  * Prefer the option that matches BOTH local sentence meaning and passage's main idea.
  * Reject options that add strong claims not in the text or that contradict the passage.

Confidence handling:
- If you are forced to guess with very low confidence, still choose the single most likely option (A/B/C/D),
  but include that question number in the UNSURE list.
- If you are clearly confident (≥80%) for a question, do NOT include it in UNSURE.

Now, here is the OCR text for the page:

---------------- OCR TEXT START ----------------
${ocrText}
---------------- OCR TEXT END ----------------

Remember:
- Only answer for question numbers in [${qsList}].
- Output lines like "14: C" and then exactly one line "UNSURE: ...".
`;

  return instructions.trim();
}

// 모델 응답에서 "N: X" 형식 파싱
function parseModelAnswer(rawText, expectedQuestionNumbers) {
  const text = String(rawText || "");
  const lines = text.split(/\r?\n/);

  const answers = {};
  const expectedSet = new Set(expectedQuestionNumbers);

  // 1) 정답 라인 파싱
  const lineRe = /^(\d{1,2})\s*:\s*([A-D1-4])\b/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(lineRe);
    if (!m) continue;

    const qNum = parseInt(m[1], 10);
    let ch = m[2].toUpperCase();

    if (!expectedSet.has(qNum)) {
      // 기대하지 않는 번호는 무시
      continue;
    }

    // 만약 모델이 1~4 숫자로 답하면 A~D로 변환
    if (/[1-4]/.test(ch)) {
      const mapNumToLetter = { "1": "A", "2": "B", "3": "C", "4": "D" };
      ch = mapNumToLetter[ch] || ch;
    }

    if (!/[A-D]/.test(ch)) continue;

    answers[qNum] = ch;
  }

  // 2) UNSURE 라인 파싱
  let unsure = [];
  const unsureRe = /^UNSURE\s*:\s*(.*)$/i;
  for (const rawLine of lines) {
    const m = rawLine.trim().match(unsureRe);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || /^(\(none\)|none)$/i.test(payload)) {
      unsure = [];
      break;
    }
    const parts = payload.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    unsure = parts
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n) && expectedSet.has(n));
    break;
  }

  return { answers, unsure };
}

// ---------- OpenRouter 호출 ----------

async function callOpenRouter({ apiKey, model, temperature, prompt }) {
  const url = "https://openrouter.ai/api/v1/chat/completions";

  const body = {
    model,
    temperature,
    messages: [
      {
        role: "system",
        content:
          "You are a highly accurate multiple-choice exam solver. Return only the requested answer lines. No explanations.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data) {
    return {
      ok: false,
      error: "OpenRouter HTTP error",
      status: res.status,
      data,
    };
  }

  const choice = data.choices && data.choices[0];
  const content =
    choice && choice.message && typeof choice.message.content === "string"
      ? choice.message.content
      : "";

  if (!content) {
    return {
      ok: false,
      error: "Empty response from model",
      status: res.status,
      data,
    };
  }

  return {
    ok: true,
    text: content,
    raw: data,
  };
}

// ---------- Netlify handler ----------

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, {
        ok: false,
        error: "OPENROUTER_API_KEY is not set",
      });
    }

    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const temperature = safeNumber(process.env.TEMPERATURE, 0.1);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrTextRaw = body.ocrText || body.text || "";
    const ocrText = String(ocrTextRaw || "").trim();

    if (!ocrText) {
      return json(400, {
        ok: false,
        error: "Missing ocrText/text in body",
      });
    }

    // 1) OCR 텍스트에서 보이는 번호 후보 추출
    const visibleQuestionNumbers = extractVisibleQuestionNumbers(ocrText);

    // 2) 가장 긴 연속 구간만 실제 문제 번호로 사용
    let questionNumbers = getMainQuestionBlock(visibleQuestionNumbers);

    // 백업: 만약 연속 블록이 안 잡혔는데 숫자는 있으면, 있는 숫자 그대로라도 사용
    if (!questionNumbers.length && visibleQuestionNumbers.length) {
      questionNumbers = visibleQuestionNumbers.slice();
    }

    if (!questionNumbers.length) {
      // 번호를 전혀 못 잡았으면, 억지로 추측하지 말고 에러 반환
      return json(200, {
        ok: false,
        error: "Could not detect question numbers from OCR text",
        page,
        visibleQuestionNumbers,
      });
    }

    // 3) 프롬프트 생성
    const prompt = buildPrompt(ocrText, questionNumbers);

    // 4) OpenRouter 호출
    const modelRes = await callOpenRouter({
      apiKey,
      model,
      temperature,
      prompt,
    });

    if (!modelRes.ok) {
      return json(200, {
        ok: false,
        error: modelRes.error || "Model call failed",
        page,
        model,
        temperature,
        visibleQuestionNumbers,
        questionNumbers,
        raw: modelRes.data || null,
      });
    }

    // 5) 모델 출력 파싱
    const parsed = parseModelAnswer(modelRes.text, questionNumbers);
    const answers = parsed.answers;
    let unsure = parsed.unsure || [];

    // 누락된 문항이 있다면: 일단 채워 넣고 UNSURE에 추가
    const missing = [];
    for (const q of questionNumbers) {
      if (!answers[q]) {
        missing.push(q);
      }
    }
    if (missing.length > 0) {
      const fallbackChoices = ["A", "B", "C", "D"];
      for (const q of missing) {
        // 간단한 fallback: 항상 B로 채워도 되지만, 조금 섞어서 채움
        const idx = q % fallbackChoices.length;
        answers[q] = fallbackChoices[idx];
      }
      // UNSURE 목록에 누락 문항 추가
      const unsureSet = new Set(unsure);
      for (const q of missing) unsureSet.add(q);
      unsure = Array.from(unsureSet).sort((a, b) => a - b);
    }

    // 6) 최종 텍스트 구성
    const lines = [];
    for (const q of questionNumbers) {
      lines.push(`${q}: ${answers[q]}`);
    }
    if (unsure.length > 0) {
      lines.push(`UNSURE: ${unsure.join(", ")}`);
    } else {
      lines.push("UNSURE: (none)");
    }

    const finalText = lines.join("\n");

    return json(200, {
      ok: true,
      text: finalText,
      debug: {
        model,
        temperature,
        page,
        visibleQuestionNumbers,
        questionNumbers,
      },
    });
  } catch (e) {
    return json(200, {
      ok: false,
      error: "Unhandled error in solve function",
      detail: String(e && e.message ? e.message : e),
    });
  }
};

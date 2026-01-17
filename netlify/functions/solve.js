// netlify/functions/solve.js
// ----------------------------------------------------
// 목적: OCR 텍스트(한 페이지/한 컷)에서 "실제로 보이는 문항"만 골라
//      OpenRouter(openai/gpt-4.1)로 정답(1~4)만 받아 반환.
// 핵심: 번호추출을 '줄 시작 + n.' 형태로만 허용해서
//      14-17 / 8% / 3 in four 같은 잡숫자 오인을 차단.
// ----------------------------------------------------

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

function normalizeOcrText(raw) {
  let t = String(raw || "");

  // 흔한 OCR 잡기호/깨짐 정리 (의미 없는 것 위주로)
  t = t
    .replace(/[‹›«»]/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[<>]/g, " ")
    .replace(/[•·]/g, " ")
    .replace(/\u00A0/g, " ");

  // BLANK 표기 통일 (BLANk 같은 경우)
  t = t.replace(/BLANk/gi, "BLANK");

  // 과도한 공백/줄바꿈 정리 (문항 구조는 유지해야 해서 줄바꿈은 남김)
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

function extractQuestionStarts(text) {
  // "문항 시작"은 반드시 줄 시작에서만 인정
  // 예: "14. ..." / "14) ..." 모두 허용
  // (중요) 14-17 같은 구간표기, 8% 같은 건 절대 안 잡힘
  const re = /^\s*(\d{1,2})\s*[.)]\s+/gm;

  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 50) {
      hits.push({ n, idx: m.index });
    }
  }

  // 중복 제거(같은 번호가 여러 번 잡히면 최초만)
  const seen = new Set();
  const uniq = [];
  for (const h of hits) {
    if (!seen.has(h.n)) {
      seen.add(h.n);
      uniq.push(h);
    }
  }

  // idx 기준 정렬
  uniq.sort((a, b) => a.idx - b.idx);

  return uniq;
}

function sliceQuestionBlocks(text, starts) {
  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i];
    const next = starts[i + 1];
    const end = next ? next.idx : text.length;
    const chunk = text.slice(cur.idx, end).trim();

    // 너무 짧으면(번호만 있고 내용이 거의 없으면) 불확실 처리 대상
    blocks.push({
      n: cur.n,
      text: chunk,
    });
  }
  return blocks;
}

function looksLikeReferenceQuestion(blockText) {
  // (A)(B)(C)(D) 지칭/참조형 문항 감지 (느슨하게)
  const t = blockText;
  const hasRefs = /\(A\)|\(B\)|\(C\)|\(D\)/.test(t);
  const asksRef = /refers to|different from the others|closest to what\s*\(A\)\s*refers to/i.test(t);
  return hasRefs && asksRef;
}

function hasEnoughReferenceContext(fullText) {
  // 지칭형은 (A)(B)(C)(D) 마커가 "문항"에만 있고
  // 정작 지문 내 근거가 없으면 위험.
  // 최소한 (A)(B)(C)(D)가 지문에서도 1회 이상 등장하는지 체크.
  // (완벽하진 않지만 '찍기'를 크게 줄임)
  const count = (s) => (fullText.match(new RegExp(`\\(${s}\\)`, "g")) || []).length;
  const cA = count("A"), cB = count("B"), cC = count("C"), cD = count("D");
  return (cA + cB + cC + cD) >= 6; // 문항 옵션(4개) 말고 지문에도 좀 있어야 함
}

async function callOpenRouter({ apiKey, prompt, maxTokens, temperature }) {
  const url = "https://openrouter.ai/api/v1/chat/completions";

  const payload = {
    model: "openai/gpt-4.1",
    temperature,
    max_tokens: maxTokens,
    messages: [
      {
        role: "system",
        content:
          "You answer multiple-choice questions. Output ONLY a JSON object mapping question numbers to choices 1-4, or '?' if unsure. No extra text.",
      },
      { role: "user", content: prompt },
    ],
    // stop 사용 금지(요구사항)
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter 권장 헤더(선택)
      "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
      "X-Title": "answer-site",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `OpenRouter error: ${res.status}`);
  }

  const content = data?.choices?.[0]?.message?.content ?? "";
  return { content, raw: data };
}

function safeParseJsonObject(s) {
  const t = String(s || "").trim();

  // 1) 그대로 JSON 파싱 시도
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === "object") return obj;
  } catch {}

  // 2) 코드블록 같은 게 끼면 JSON 부분만 추출
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && typeof obj === "object") return obj;
    } catch {}
  }
  return null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(200, { ok: true });
    }
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });

    const temperature = Number(process.env.TEMPERATURE ?? 0.0);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const rawText = String(body.ocrText || body.text || "");
    const text = normalizeOcrText(rawText);

    if (!text) {
      return json(400, { ok: false, error: "Empty ocrText" });
    }

    const starts = extractQuestionStarts(text);
    if (starts.length === 0) {
      // 문항번호를 아예 못 잡으면(사진 잘림/흔들림) 여기로 옴
      return json(200, {
        ok: true,
        text: "",
        debug: {
          model: "openai/gpt-4.1",
          page,
          detectedNums: [],
          note: "No question starts detected. (Need clearer capture / include question numbers like '14.' at line start)",
          excerptPreview: text.slice(0, 700),
        },
      });
    }

    const blocks = sliceQuestionBlocks(text, starts);

    // 지칭형 문항인데 근거가 부족하면 '?'로 처리하도록 모델에게 강제
    const refContextOk = hasEnoughReferenceContext(text);

    // 모델 프롬프트 구성: 문항 블록만 주고 JSON만 요구
    const promptLines = [];
    promptLines.push("Given the following OCR text blocks, answer each question.");
    promptLines.push("Rules:");
    promptLines.push("- Return ONLY a JSON object: {\"14\":4, \"18\":4, ...}");
    promptLines.push("- Each value must be 1,2,3,4 or \"?\" if unsure.");
    promptLines.push("- If a question's options or key context are missing/garbled, use \"?\" (do NOT guess).");
    promptLines.push("- Ignore OCR garbage symbols; focus on grammar/meaning.");
    if (!refContextOk) {
      promptLines.push("- IMPORTANT: If a question asks what (A)/(B)/(C)/(D) refers to (reference question), you MUST output \"?\" because the passage context is insufficient in this OCR.");
    }
    promptLines.push("");
    promptLines.push("QUESTIONS (each block is one question):");

    for (const b of blocks) {
      // ref문항인데 전체 문맥 부족이면, 모델이 안 찍게 주석 추가
      let blockText = b.text;
      if (!refContextOk && looksLikeReferenceQuestion(blockText)) {
        blockText += "\n[NOTE: Reference context for (A)(B)(C)(D) is insufficient in this OCR. Output '?' for this question.]";
      }
      promptLines.push("");
      promptLines.push(`--- Q${b.n} ---`);
      promptLines.push(blockText);
    }

    const prompt = promptLines.join("\n");

    const { content, raw } = await callOpenRouter({
      apiKey,
      prompt,
      maxTokens: 900,
      temperature,
    });

    const obj = safeParseJsonObject(content);

    // 파싱 실패 시: 안전하게 빈 결과 + debug
    if (!obj) {
      return json(200, {
        ok: true,
        text: "",
        debug: {
          model: "openai/gpt-4.1",
          page,
          detectedNums: blocks.map((b) => b.n),
          parseFailed: true,
          modelRawText: content.slice(0, 1200),
        },
      });
    }

    // 정리: 이번 OCR에서 감지된 문항만, 오름차순으로 출력
    const nums = blocks.map((b) => b.n).sort((a, b) => a - b);
    const lines = [];
    for (const n of nums) {
      const v = obj[String(n)];
      const out =
        v === 1 || v === 2 || v === 3 || v === 4
          ? String(v)
          : v === "?" ? "?" : "?";
      lines.push(`${n}: ${out}`);
    }

    return json(200, {
      ok: true,
      text: lines.join("\n"),
      debug: {
        model: "openai/gpt-4.1",
        temperature,
        page,
        detectedNums: blocks.map((b) => b.n),
        refContextOk,
        excerptPreview: text.slice(0, 700),
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
};

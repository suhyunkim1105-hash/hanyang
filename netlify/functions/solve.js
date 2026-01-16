// netlify/functions/solve.js
// ------------------------------------------------------------
// HUFS(한국외대) 편입영어 T2 전용 "정답만(1~4)" 생성기 (연도 무관)
// - 모델: openai/gpt-4.1 고정
// - temperature: 0.1 고정
// - 입력: { ocrText: string, page?: number }
// - 출력: { ok: true, text: "1: 3\n2: 1\n...\nUNSURE: 18,23", debug: {...} }
//
// 핵심 설계
// 1) OCR 텍스트 정규화: 선지 A/B/C/D 변형 -> 1)/2)/3)/4) 보조 표기, 괄호류 통일, <A> 마커 통일
// 2) 문항 블록 추출: "줄 시작의 (숫자. / 숫자) )"만 문항 시작으로 인정 + 헤더/배점/범위표 오탐 필터
// 3) 모델 3회 호출(서로 다른 시스템 지침) + 다수결로 안정화
// 4) 문항 누락 0: 답이 빠지면 1로 채우고 UNSURE에 추가
//
// 옵션(선택):
// - STOP_TOKEN 환경변수 있으면 모델에게 끝에 붙이게 유도하고 그 이후는 잘라 파싱 안정화 (기본 XURTH)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

function toStr(x) {
  return x == null ? "" : String(x);
}

function normalizeOcrText(raw) {
  let t = toStr(raw);

  // 줄바꿈/공백 표준화
  t = t.replace(/\r\n?/g, "\n");
  t = t.replace(/\u00A0/g, " ");
  t = t.replace(/[ \t]+/g, " ");

  // 다양한 대시/구분선 표기 통일: ---- 로
  // (—, –, _, = 등이 OCR에서 섞일 수 있음)
  t = t.replace(/^[\s\-—–_=]{3,}$/gm, "----");

  // 따옴표 표준화
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // 원형 숫자 보기(①②③④) → 1 2 3 4 (혹시 남아있을 때 대비)
  const circledMap = { "①": "1", "②": "2", "③": "3", "④": "4" };
  t = t.replace(/[①②③④]/g, (m) => circledMap[m] || m);

  // 괄호/대괄호/특수꺾쇠가 섞여도 "마커"는 <>로 통일하기 위해 1차 정리
  // (사용자가 수기로 <>를 쓰더라도 OCR이 ()나 []로 깨질 수 있음)
  //  - 단, 여기서 모든 괄호를 <>로 바꾸면 문장 괄호까지 망가질 수 있으니
  //    "A/B/C/D 한 글자 마커"에만 적용한다.
  // 예: (A)those / [B]their / <C>their / {D}their → <A>those ...
  t = t.replace(/[\(\[\{<]\s*([ABCD])\s*[\)\]\}>]/g, "<$1>");

  // 사용자가 밑줄을 <>로 표기했는데 OCR이 << >> 혹은 ‹ › 로 깨지는 경우 보정
  t = t.replace(/[‹«]/g, "<").replace(/[›»]/g, ">");

  // 선지 라벨 정규화:
  // 줄 시작 또는 줄바꿈 뒤에 오는 A) / A. / A> / A: / A - 등을 "1) "로 보조 표기
  // (원문 A/B/C/D 유지보다, 모델이 보기 순서를 숫자로 안정적으로 잡게 하는 게 목적)
  const opt = [
    { re: /(^|\n)\s*A\s*[\)\.\>\:\-]\s+/g, rep: "$11) " },
    { re: /(^|\n)\s*B\s*[\)\.\>\:\-]\s+/g, rep: "$12) " },
    { re: /(^|\n)\s*C\s*[\)\.\>\:\-]\s+/g, rep: "$13) " },
    { re: /(^|\n)\s*D\s*[\)\.\>\:\-]\s+/g, rep: "$14) " },
  ];
  for (const { re, rep } of opt) t = t.replace(re, rep);

  // (드물게) "A "만 있고 구두점이 날아간 경우: 줄 시작 "A " + 단어로 시작하면 보기로 추정
  // 너무 공격적이면 지문 첫 글자 A를 망가뜨릴 수 있으므로, 다음 토큰이 소문자/숫자면 제외하고 짧게만 허용
  t = t.replace(/(^|\n)\s*A\s+(?=[A-Z][a-z]{1,15}\b)/g, "$11) ");
  t = t.replace(/(^|\n)\s*B\s+(?=[A-Z][a-z]{1,15}\b)/g, "$12) ");
  t = t.replace(/(^|\n)\s*C\s+(?=[A-Z][a-z]{1,15}\b)/g, "$13) ");
  t = t.replace(/(^|\n)\s*D\s+(?=[A-Z][a-z]{1,15}\b)/g, "$14) ");

  // 제어문자 제거
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");

  // 과도한 빈줄 정리
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

function looksLikeHeaderOrScore(block) {
  const s = block.trim();
  if (!s) return true;

  // 너무 짧고 점수/범위/헤더 냄새
  const short = s.length < 120;
  const headerish =
    /202\d학년도|한국외대|편입학|필답고사|문제지|T2|A형|배점|point each|총\s*100|합계|[［\[]\s*\d+\s*-\s*\d+\s*[］\]]/i.test(s);

  // 선지/BLANK/Choose/Read 등이 없으면 헤더로 처리
  const hasChoice = /\b[1-4]\)\s+\S/.test(s) || /\bBLANK\b/i.test(s);
  const hasQuestionCue = /\bChoose\b|\bclosest\b|\bmeaning\b|\bINCORRECT\b|\bRead the following\b|\bpassage\b/i.test(s);
  if (short && headerish && !hasChoice && !hasQuestionCue) return true;

  return false;
}

function looksLikeQuestionBlock(block) {
  const s = block;

  // 보기(1)~(4) 혹은 BLANK 혹은 전형적 지시문/독해 표기
  const hasChoices = /\b1\)\s+\S/.test(s) && /\b2\)\s+\S/.test(s) && /\b3\)\s+\S/.test(s) && /\b4\)\s+\S/.test(s);
  const hasBlank = /\bBLANK\b/i.test(s);
  const hasCue = /\bChoose\b|\bclosest\b|\bmeaning\b|\bINCORRECT\b|\bRead the following\b|\bpassage\b|\bquestions\b/i.test(s);
  const hasMarker = /<\s*[ABCD]\s*>/.test(s); // 지문 표식

  return hasChoices || hasBlank || hasCue || hasMarker;
}

function extractQuestionBlocks(text) {
  // 문항 시작: 줄 시작 "숫자." 또는 "숫자)"
  // (중요) 반드시 줄 시작만 인정 → [14-17], 7-1 같은 것 배제
  const src = "\n" + text + "\n";
  const re = /(^|\n)\s*(\d{1,2})\s*[\.\)]\s+/g;

  const starts = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const num = Number(m[2]);
    if (!Number.isFinite(num) || num < 1 || num > 60) continue;
    const idx = m.index + (m[1] ? m[1].length : 0);
    starts.push({ num, idx });
  }

  if (starts.length === 0) return [];

  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].idx;
    const end = i + 1 < starts.length ? starts[i + 1].idx : src.length;
    const block = src.slice(start, end).trim();

    if (looksLikeHeaderOrScore(block)) continue;
    if (!looksLikeQuestionBlock(block)) continue;

    blocks.push({ num: starts[i].num, block });
  }

  // 같은 번호 중복이면 더 긴 블록을 채택
  const byNum = new Map();
  for (const b of blocks) {
    const prev = byNum.get(b.num);
    if (!prev || b.block.length > prev.block.length) byNum.set(b.num, b);
  }

  return Array.from(byNum.values()).sort((a, b) => a.num - b.num);
}

function buildPrompt(questionBlocks, stopToken) {
  const items = questionBlocks
    .map((q) => `Q${q.num}:\n${q.block}\n`)
    .join("\n");

  const stopLine = stopToken ? `\nEnd every output with the token: ${stopToken}\n` : "";

  return (
    "You are solving HUFS (Hankuk University of Foreign Studies) transfer English exam T2.\n" +
    "Output ONLY answers.\n\n" +
    "Strict rules:\n" +
    "- Solve ONLY the questions listed below (Q numbers provided). Never invent new question numbers.\n" +
    "- Each question has exactly FOUR choices in order. Output MUST be a number 1,2,3,4 (NOT A/B/C/D).\n" +
    "- Output one line per question: `n: 1` (example: `14: 4`).\n" +
    "- After all answers, output exactly one final line: `UNSURE: ...` (comma-separated numbers) or `UNSURE: (none)`.\n" +
    "- No explanations, no extra text.\n\n" +
    "How to interpret OCR conventions:\n" +
    "- Choices may appear as 1) 2) 3) 4). (They can originate from A)/B)/C)/D) OCR normalization.\n" +
    "- `<...>` marks an underlined word/phrase in the original.\n" +
    "- `<A> <B> <C> <D>` inside a passage are NOT choices; they are in-text markers (referents/underlines).\n" +
    "- `BLANK` indicates a blank to be filled.\n" +
    "- Fix obvious OCR typos mentally.\n\n" +
    "Accuracy priorities (HUFS T2):\n" +
    "- Reading comprehension is heavily weighted. Do NOT rush: track main idea, details, inference, and referents carefully.\n" +
    "- For grammar-incorrect questions: choose the segment (1..4) that is grammatically wrong.\n" +
    "- For referent questions with <A><B><C><D>: determine antecedent for each marker; pick the one that differs.\n\n" +
    "Questions:\n" +
    items +
    stopLine
  ).trim();
}

function cutByStopToken(s, stopToken) {
  if (!stopToken) return s;
  const idx = s.indexOf(stopToken);
  if (idx === -1) return s;
  return s.slice(0, idx);
}

function parseModelAnswers(modelText, stopToken) {
  const out = new Map();
  const unsure = new Set();

  let text = toStr(modelText);
  text = cutByStopToken(text, stopToken);
  text = text.replace(/\r\n?/g, "\n");

  const lines = text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  for (const line of lines) {
    const um = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (um) {
      const tail = um[1] || "";
      if (/^\(none\)$/i.test(tail) || /^none$/i.test(tail)) continue;
      const nums = tail.match(/\d{1,2}/g);
      if (nums) nums.forEach((n) => unsure.add(Number(n)));
      continue;
    }

    // "18: 4" / "18-4" / "18 : D" 등 허용
    const m = line.match(/^(\d{1,2})\s*[:\-]\s*([1-4ABCD])\b/i);
    if (!m) continue;

    const q = Number(m[1]);
    let a = String(m[2]).toUpperCase();

    // A-D -> 1-4 변환
    if (a === "A") a = "1";
    else if (a === "B") a = "2";
    else if (a === "C") a = "3";
    else if (a === "D") a = "4";

    if (!/^[1-4]$/.test(a)) continue;
    out.set(q, a);
  }

  return { answers: out, unsure };
}

function majorityVote(questionNumbers, parsedList) {
  const finalAnswers = new Map();
  const finalUnsure = new Set();

  for (const q of questionNumbers) {
    const counts = { "1": 0, "2": 0, "3": 0, "4": 0 };
    let seen = false;

    for (const p of parsedList) {
      if (p.unsure && p.unsure.has(q)) finalUnsure.add(q);
      const v = p.answers.get(q);
      if (v) {
        counts[v] += 1;
        seen = true;
      }
    }
    if (!seen) continue;

    let best = "1";
    let bestCount = -1;
    for (const k of ["1", "2", "3", "4"]) {
      if (counts[k] > bestCount) {
        best = k;
        bestCount = counts[k];
      }
    }

    const tied = ["1", "2", "3", "4"].filter((k) => counts[k] === bestCount);
    // 동률이면 2번째 호출(문법/참조 강화)을 타이브레이커로 사용
    if (tied.length > 1 && parsedList[1]) {
      const t = parsedList[1].answers.get(q);
      if (t && tied.includes(t)) best = t;
    }

    finalAnswers.set(q, best);
  }

  return { finalAnswers, finalUnsure };
}

async function callOpenRouter({ apiKey, model, temperature, messages }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://example.com",
      "X-Title": "HUFS-T2-Solver",
    },
    body: JSON.stringify({
      model,
      temperature,
      messages,
    }),
  });

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("OpenRouter response JSON parse failed");
  }

  const content = data?.choices?.[0]?.message?.content;
  return toStr(content);
}

async function callWithRetry(payload, retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await callOpenRouter(payload);
    } catch (e) {
      lastErr = e;
      // 짧은 지연(Netlify 제한 고려해서 아주 짧게)
      await new Promise((r) => setTimeout(r, 150 + i * 150));
    }
  }
  throw lastErr || new Error("Unknown OpenRouter error");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });

    // 요청사항 고정
    const model = "openai/gpt-4.1";
    const temperature = 0.1;

    const stopToken = (process.env.STOP_TOKEN || "XURTH").trim(); // optional-but-helpful
    const useStop = stopToken.length > 0;

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const rawOcrText = toStr(body.ocrText || body.text || "");
    if (!rawOcrText.trim()) return json(400, { ok: false, error: "ocrText is empty" });

    const ocrText = normalizeOcrText(rawOcrText);

    // 문항 블록 추출
    const questionBlocks = extractQuestionBlocks(ocrText);
    const questionNumbers = questionBlocks.map((q) => q.num);

    if (!questionBlocks.length) {
      return json(200, {
        ok: true,
        text: "UNSURE: (all)",
        debug: { model, temperature, page, questionNumbers: [], reason: "No question blocks detected" },
      });
    }

    // 3개 프롬프트(역할 분리)로 안정화
    const basePrompt = buildPrompt(questionBlocks, useStop ? stopToken : "");
    const qList = questionNumbers.join(", ");

    const messages1 = [
      { role: "system", content: "Solve accurately. Output strictly in the requested format. No extra text." },
      { role: "user", content: basePrompt + `\n\nVisible Q list: ${qList}\n` },
    ];

    const messages2 = [
      {
        role: "system",
        content:
          "Be extremely strict about grammar, referents, and logical consistency. Reading questions are critical. Output strictly.",
      },
      { role: "user", content: basePrompt + `\n\nVisible Q list: ${qList}\n` },
    ];

    const messages3 = [
      {
        role: "system",
        content:
          "Focus on OCR robustness: fix typos mentally, keep option order stable, avoid being misled by noise. Output strictly.",
      },
      { role: "user", content: basePrompt + `\n\nVisible Q list: ${qList}\n` },
    ];

    // 병렬 호출
    const [r1, r2, r3] = await Promise.all([
      callWithRetry({ apiKey, model, temperature, messages: messages1 }),
      callWithRetry({ apiKey, model, temperature, messages: messages2 }),
      callWithRetry({ apiKey, model, temperature, messages: messages3 }),
    ]);

    const p1 = parseModelAnswers(r1, useStop ? stopToken : "");
    const p2 = parseModelAnswers(r2, useStop ? stopToken : "");
    const p3 = parseModelAnswers(r3, useStop ? stopToken : "");

    const { finalAnswers, finalUnsure } = majorityVote(questionNumbers, [p1, p2, p3]);

    // 누락 0 보장
    for (const q of questionNumbers) {
      if (!finalAnswers.has(q)) {
        finalAnswers.set(q, "1");
        finalUnsure.add(q);
      }
    }

    const lines = questionNumbers.map((q) => `${q}: ${finalAnswers.get(q)}`);

    const unsureList = Array.from(finalUnsure).sort((a, b) => a - b);
    lines.push(`UNSURE: ${unsureList.length ? unsureList.join(",") : "(none)"}`);

    return json(200, {
      ok: true,
      text: lines.join("\n"),
      debug: {
        model,
        temperature,
        page,
        extractedCount: questionBlocks.length,
        questionNumbers,
        usedStopToken: useStop ? stopToken : "(disabled)",
      },
    });
  } catch (err) {
    return json(500, { ok: false, error: err?.message || String(err) });
  }
};

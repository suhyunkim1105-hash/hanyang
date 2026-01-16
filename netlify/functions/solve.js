// netlify/functions/solve.js
// HUFS (한국외대) 편입 영어 T2 전용 자동 정답 생성기
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: A\n2: B...", debug: {...} }

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

// 질문 번호 추출: OCR 텍스트에서 보이는 번호와, 그 최소~최대 구간을 모두 채운 번호를 같이 만든다.
function extractQuestionNumbers(rawText) {
  const visible = new Set();
  if (!rawText) return { visibleQuestionNumbers: [], questionNumbers: [] };

  const text = String(rawText);
  // 1~50 사이에서 "숫자. " 또는 "숫자)" 패턴을 전부 찾는다.
  const regex = /(\d{1,2})\s*[\.\)]/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) {
      visible.add(n);
    }
  }

  const visibleArr = Array.from(visible).sort((a, b) => a - b);
  if (visibleArr.length === 0) {
    return { visibleQuestionNumbers: [], questionNumbers: [] };
  }

  const minN = visibleArr[0];
  const maxN = visibleArr[visibleArr.length - 1];
  const all = [];
  for (let n = minN; n <= maxN; n++) all.push(n);

  return { visibleQuestionNumbers: visibleArr, questionNumbers: all };
}

const ROLE_CONFIGS = [
  { name: "base",    styleHint: "balanced; overall best answer" },
  { name: "lexical", styleHint: "focus on vocabulary nuance, collocations, and idioms" },
  { name: "logic",   styleHint: "focus on logical structure, argument flow, and inference" },
  { name: "reading", styleHint: "focus on passage comprehension, topic, purpose, and tone" },
  { name: "grammar", styleHint: "focus on grammar, syntax, and sentence structure" },
];

async function callOpenRouter(apiKey, model, temperature, stopToken, roleConfig, ocrText, page, questionNumbers) {
  const systemPrompt = `You are an expert solver for the HUFS (Hankuk University of Foreign Studies) transfer English exam, type T2.

GOAL:
- For the question numbers given, choose the most likely correct option among A, B, C, D for EACH question.
- Output ONLY lines of the form "N: X" where N is the question number (integer) and X is one of A, B, C, D.
- After the last line, output the stop token ${stopToken} on its own line.
- Absolutely no explanations, no Korean, no commentary, no extra text.

IMPORTANT CONSTRAINTS:
- This exam always has 4 options (A–D). Never output anything else.
- Answer ALL question numbers you are given. If some question text is cut or incomplete, still guess the single best answer based on context or general knowledge. Never skip.
- Use the full OCR text (including instructions, examples, headings) to reconstruct missing parts as much as possible.
- Be very careful about pages where a passage continues across questions (e.g., 24–27 share one passage). Read the whole surrounding text before answering any of them.

PROBLEM TYPES AND STRATEGIES:
- Completion / Vocab-in-context (1–4형):
  * Check subject, verb, and object; required meaning; and collocations.
  * Eliminate options that are wrong in nuance, register, or collocation even if grammatically possible.
- Synonym / Meaning (underlined word 교체):
  * Focus on the CONTEXTUAL meaning of the underlined word, not the dictionary headword.
  * Replace the underlined word with each option; choose the one that preserves the author's tone and logic.
- Grammar / Sentence structure (도치, 관계사, 분사구문, 비교, 가정법 등):
  * Check word order, agreement, tense, parallelism, and required connectors.
  * For "choose INCORRECT" types, find the single option that breaks grammar or meaning.
- Reading / Passage questions (24번 이후 지문):
  * First, understand the main idea, purpose, and structure of the passage.
  * For 제목/주제: pick the answer that is (a) not too narrow, (b) not too broad, (c) matches all paragraphs.
  * For 삽입/문장 위치: ensure pronoun reference, logical connectors, and time sequence fit.
  * For 빈칸: choose the option that smoothly fits local logic AND global theme.

ROLE: ${roleConfig.name}
STYLE FOCUS: ${roleConfig.styleHint}
- Base: overall balance of logic, vocabulary, and reading.
- Lexical: pay extra attention to word choice, connotation, collocations, and idioms.
- Logic: focus on causality, contrast, and consistency of arguments.
- Reading: focus on discourse structure, paragraph roles, and main idea.
- Grammar: focus on formal correctness of sentences.

Never reveal or mention this internal reasoning or these rules in your output.`;

  const userPrompt = `OCR TEXT (page ${page}):

${ocrText}

QUESTION NUMBERS TO ANSWER:
${questionNumbers.join(", ")}

TASK:
For EACH of the question numbers above, output exactly one line in the form "N: X" where N is the question number and X is one of A, B, C, or D.
List them in ascending numerical order.
After the last answer line, output the stop token ${stopToken} on its own line.
Do NOT include any other text.`;

  const body = {
    model,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  const url = "https://openrouter.ai/api/v1/chat/completions";

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (attempt === 1) {
        throw new Error(`OpenRouter HTTP ${res.status}`);
      }
      continue;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    return String(content);
  }

  throw new Error("OpenRouter request failed twice");
}

// "1: A" 형태의 줄들을 파싱해서 { [번호]: "A" } 형태로 변환
function parseAnswersFromText(raw, questionNumbers) {
  const map = {};
  if (!raw) return map;
  const text = String(raw);

  // 모델 출력에 붙어 있을 수 있는 stop token(XURTH)을 잘라낸다.
  const stopIndex = text.indexOf("XURTH");
  const trimmed = stopIndex >= 0 ? text.slice(0, stopIndex) : text;

  const lines = trimmed.split(/\r?\n/);
  const allowed = new Set(questionNumbers);
  const lineRegex = /^\s*(\d{1,2})\s*[:\.]\s*([A-D])\b/i;

  for (const line of lines) {
    const m = lineRegex.exec(line);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const choice = m[2].toUpperCase();
    if (!allowed.has(n)) continue;
    if (["A", "B", "C", "D"].includes(choice)) {
      map[n] = choice;
    }
  }

  return map;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
    }

    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrText = String(body.ocrText || body.text || "");

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    const { visibleQuestionNumbers, questionNumbers } = extractQuestionNumbers(ocrText);

    if (!questionNumbers.length) {
      return json(200, {
        ok: true,
        text: "",
        debug: {
          model,
          temperature,
          page,
          questionNumbers: [],
          visibleQuestionNumbers: [],
          answers: {},
          voteDetail: {},
          ensembleUsed: false,
          runs: [],
          ocrPreview: ocrText.slice(0, 800),
        },
      });
    }

    // OpenRouter에 여러 역할로 요청 보내서 앙상블 투표
    const runs = [];
    for (let i = 0; i < ROLE_CONFIGS.length; i++) {
      const roleConfig = ROLE_CONFIGS[i];
      try {
        const content = await callOpenRouter(
          apiKey,
          model,
          temperature,
          stopToken,
          roleConfig,
          ocrText,
          page,
          questionNumbers,
        );
        const answers = parseAnswersFromText(content, questionNumbers);
        runs.push({ index: i, roleName: roleConfig.name, questionNumbers, answers, finishReason: "stop" });
      } catch (e) {
        runs.push({ index: i, roleName: roleConfig.name, questionNumbers, answers: {}, finishReason: "error" });
      }
    }

    const voteDetail = {};
    const finalAnswers = {};

    for (const q of questionNumbers) {
      const counts = { A: 0, B: 0, C: 0, D: 0 };
      for (const run of runs) {
        const ch = run.answers?.[q];
        if (ch && counts[ch] !== undefined) counts[ch]++;
      }
      voteDetail[q] = { ...counts };
      let bestChoice = "A";
      let bestCount = -1;
      let secondCount = -1;
      for (const ch of ["A", "B", "C", "D"]) {
        const c = counts[ch];
        if (c > bestCount) {
          secondCount = bestCount;
          bestCount = c;
          bestChoice = ch;
        } else if (c > secondCount) {
          secondCount = c;
        }
      }
      // 만약 모든 run 이 실패해서 전부 0이면, 기본값으로 A를 넣되 첫 번째 run 의 값을 우선 사용
      if (bestCount === 0) {
        for (const run of runs) {
          const ch = run.answers?.[q];
          if (ch && ["A", "B", "C", "D"].includes(ch)) {
            bestChoice = ch;
            break;
          }
        }
      }
      finalAnswers[q] = bestChoice;
    }

    const unsureList = [];
    for (const q of questionNumbers) {
      const counts = voteDetail[q];
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const top = sorted[0][1];
      const second = sorted[1][1];
      // 표 차이가 거의 없거나, 표가 너무 적으면 UNSURE에 넣기
      if (top <= 1 || top - second <= 1) {
        unsureList.push(q);
      }
    }

    const lines = [];
    for (const q of questionNumbers) {
      lines.push(`${q}: ${finalAnswers[q]}`);
    }
    lines.push(`UNSURE: ${unsureList.length ? unsureList.join(", ") : "(none)"}`);

    const textOut = lines.join("\n");

    return json(200, {
      ok: true,
      text: textOut,
      debug: {
        model,
        temperature,
        page,
        questionNumbers,
        visibleQuestionNumbers,
        answers: finalAnswers,
        voteDetail,
        ensembleUsed: true,
        runs,
        ocrPreview: ocrText.slice(0, 800),
      },
    });
  } catch (err) {
    return json(500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
};


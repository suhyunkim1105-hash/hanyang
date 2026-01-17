// netlify/functions/solve.js
// HUFS(외대) 편입영어 T2 전용: "보이는 문항번호만" 정답 생성 (4지선다, 1~50)
// - 모델: openai/gpt-4.1 고정
// - temperature: 0.1 고정
// - stop token: 사용 안 함
// - 특정 연도/번호 정답 강제: 절대 없음
// - OCR 깨짐(A. A> A: / (A) [A] {A}) 정규화 + 문항번호 오탐(범위표기) 방지
//
// 입력: { ocrText: string, page?: number }
// 출력: { ok:true, text:"15: 2\n16: 1\n...", debug:{...} }

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// 1) OCR 텍스트 정규화: 보기/표식/BLANK/특수괄호
function normalizeOcr(raw) {
  let t = String(raw || "");

  // 통일된 줄바꿈
  t = t.replace(/\r\n?/g, "\n");

  // OCR에서 나오는 특수 괄호/따옴표를 일반 문자로
  t = t
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‹«]/g, "<")
    .replace(/[›»]/g, ">");

  // BLANK 통일 (____, ___, _ _ 등)
  t = t.replace(/_{2,}/g, "BLANK");
  t = t.replace(/\bBLANK\b/gi, "BLANK");

  // (A) [A] {A}  -> <A>  (a,b,c,d도 동일)
  t = t.replace(/[\(\[\{]\s*([A-Da-d])\s*[\)\]\}]/g, "<$1>");
  // 혹시 < a > 같이 띄어쓰기 들어가면 정리
  t = t.replace(/<\s*([A-Da-d])\s*>/g, "<$1>");

  // 보기 라벨(A. A: A> 등) -> A)
  // "줄 시작" 또는 "줄 중간에서 보기 나열" 둘 다 커버하려고 약하게 2번 처리
  t = t.replace(/(^|\n)\s*([A-Da-d])\s*[\.\:\>]\s+/g, "$1$2) ");
  t = t.replace(/\s([A-Da-d])\s*[\.\:\>]\s+/g, " $1) ");

  // 보기 라벨이 "A "만 있고 점이 누락되는 케이스: "A unflappable" 형태
  // 단, 너무 과하면 본문 A(약어)도 바꿀 수 있어서 "보기 4개가 근처에 있을 때"가 아니라면 위험.
  // 여기서는 안전하게: "A " 다음에 소문자 단어가 오고, 같은 줄에 B/C/D가 같이 있는 패턴만 최소 변환
  t = t.replace(
    /(^|\n)(.*?)(\bA\s+[a-z][^\n]*\bB\s+[a-z][^\n]*\bC\s+[a-z][^\n]*\bD\s+[a-z][^\n]*)/g,
    (m, p1, p2, p3) => {
      let s = p3;
      s = s.replace(/\bA\s+/g, "A) ");
      s = s.replace(/\bB\s+/g, "B) ");
      s = s.replace(/\bC\s+/g, "C) ");
      s = s.replace(/\bD\s+/g, "D) ");
      return p1 + (p2 || "") + s;
    }
  );

  // <a> <b> <c> <d>는 <A> <B> <C> <D>로 통일 (네 규칙)
  t = t.replace(/<a>/g, "<A>").replace(/<b>/g, "<B>").replace(/<c>/g, "<C>").replace(/<d>/g, "<D>");

  // 너무 많은 공백 정리
  t = t.replace(/[ \t]+/g, " ");
  return t.trim();
}

// 2) 문항번호 탐지(오탐 방지 핵심)
// - "줄 시작"에서 "숫자 + '.' or ')'"만 문항 시작으로 인정
// - 1~50만
function detectQuestionNumbers(text) {
  const lines = String(text || "").split("\n");
  const nums = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d{1,2})\s*([.)])\s+/);
    if (!m) continue;
    const n = Number(m[1]);
    if (!(n >= 1 && n <= 50)) continue;
    nums.push(n);
  }
  return uniq(nums);
}

// 3) "연속 구간 스캔"인데 OCR이 중간을 누락했을 때도 번호 누락 0을 맞추기
//    - 예: 15,16,17,18,19,22,23이 들어오면 20,21을 ?로라도 출력해야 함
function expandExpectedGaps(detected) {
  const nums = [...detected].sort((a, b) => a - b);
  if (nums.length < 3) return detected;

  const min = nums[0];
  const max = nums[nums.length - 1];
  const span = max - min;

  // 너무 넓으면(예: 1~50) 억지 확장 X
  if (span > 15) return detected;

  const set = new Set(nums);

  // 기본: min..max 사이 결손 보완
  for (let n = min; n <= max; n++) set.add(n);

  // 추가 규칙(외대 구조 반영):
  // 18~19가 있고 22/23이 있으면 20~21은 그 사이에 있어야 함
  if (set.has(18) && set.has(19) && (set.has(22) || set.has(23))) {
    set.add(20);
    set.add(21);
  }

  return [...set].sort((a, b) => a - b);
}

// 4) 너무 긴 OCR 텍스트(독해 구간)로 렉/토큰 폭발 방지: "필요한 구간만" 잘라서 모델에 전달
function clipToRelevant(text, targetNums) {
  const t = String(text || "");
  if (t.length <= 14000) return { clipped: t, clippedInfo: null };

  const lines = t.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(\d{1,2})\s*([.)])\s+/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 50) starts.push({ idx: i, n });
    }
  }
  if (starts.length === 0) {
    return { clipped: t.slice(0, 14000), clippedInfo: { mode: "hard", keptChars: 14000 } };
  }

  // 문항 시작점 기준으로 블록 만들기
  const blocks = [];
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k];
    const b = starts[k + 1];
    const from = a.idx;
    const to = b ? b.idx : lines.length;
    blocks.push({ n: a.n, from, to });
  }

  // 타겟 문항 + 인접 문항(±1) 블록을 모아 붙임 (지문 이어짐 방지용)
  const want = new Set(targetNums);
  for (const n of targetNums) {
    want.add(n - 1);
    want.add(n + 1);
  }

  const kept = [];
  for (const blk of blocks) {
    if (want.has(blk.n)) kept.push(...lines.slice(blk.from, blk.to));
  }

  // 그래도 너무 짧거나 비면: 앞 200줄 + 뒤 200줄 안전망
  let out = kept.join("\n").trim();
  if (!out) {
    out = lines.slice(0, 200).join("\n") + "\n...\n" + lines.slice(-200).join("\n");
  }

  // 최종 길이 제한
  if (out.length > 14000) out = out.slice(0, 14000);

  return { clipped: out, clippedInfo: { mode: "blocks", originalChars: t.length, keptChars: out.length } };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
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

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? null;
    const raw = String(body.ocrText || body.text || "");
    if (!raw.trim()) return json(400, { ok: false, error: "ocrText is empty" });

    const normalized = normalizeOcr(raw);

    // 문항번호 탐지 + (필요시) 누락 번호 보정
    const detectedNums = detectQuestionNumbers(normalized);
    const finalNums = expandExpectedGaps(detectedNums);

    if (finalNums.length === 0) {
      return json(200, {
        ok: true,
        text: "",
        debug: { model: "openai/gpt-4.1", temperature: 0.1, page, detectedNums, finalNums, note: "no question numbers detected" },
      });
    }

    // 긴 텍스트는 필요한 블록만 잘라서 렉/토큰 폭발 방지
    const { clipped, clippedInfo } = clipToRelevant(normalized, finalNums);

    // 모델 출력 토큰: 문항 수에 비례 (독해가 길수록 커짐)
    const maxTokens = Math.min(1800, Math.max(600, finalNums.length * 80));

    const prompt = `
너의 역할: "한국외대(외대) 편입영어 T2 객관식 정답 생성기"다.

[시험 고정 정보]
- 문항: 1~50
- 선지: 4개(정답은 1~4로 표현)
- 자주 나오는 구조(외대 기출 공통):
  * 1~9: 어휘(동의/문맥 등)
  * 10~13: 논리완성(짧은 문장/단락의 의미·논리)
  * 14~21: 문법/재진술(의미 동일, 문장 완성, 문법 오류 찾기)
  * 18~19: "문법적으로 틀린 부분" 찾기 (<A>/<B>/<C>/<D>로 표시됨)
  * 20~21: "문법적으로 틀린 문장" 고르기 (A)~D) 중 1개가 오류)
  * 22~50: 독해(지문 + 문제)
  * 23(또는 유사 유형): <A>/<B>/<C>/<D>가 가리키는 지시대상이 서로 다른 것을 고르는 문제

[입력 텍스트 규칙]
- 보기 라벨은 A) B) C) D) 로 정규화되어 들어온다.
- 밑줄/표식은 <...> 형태로 들어올 수 있다.
- 빈칸은 BLANK 로 들어온다.
- <A> <B> <C> <D>는 지문/문장 안에서 표시된 위치 토큰이다.

[최우선 목표]
- 아래 [정답을 내야 하는 문항 번호]에 대해 "반드시 전부" 한 줄씩 답을 출력한다.
- 답을 확신 못하면 숫자 뒤에 ?를 붙인다. (예: 18: 4?)
- 절대로 목록에 없는 문항번호를 출력하지 마라.

[정답을 내야 하는 문항 번호]
${finalNums.join(", ")}

[출력 형식]
- 딱 아래 형식만 반복:
  n: k
  또는 확신 없으면
  n: k?
- 줄바꿈은 허용. 다른 설명 금지.
`;

    const reqBody = {
      model: "openai/gpt-4.1",
      temperature: 0.1,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: "You solve HUFS transfer English T2 multiple-choice and output only answers in the specified format." },
        { role: "user", content: prompt + "\n\n[OCR TEXT]\n" + clipped },
      ],
    };

    const res = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reqBody),
      },
      25000
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return json(500, { ok: false, error: `OpenRouter error ${res.status}`, detail: errText.slice(0, 3000) });
    }

    const data = await res.json();
    const out = String(data?.choices?.[0]?.message?.content || "").trim();

    // 모델 출력 파싱: finalNums에 있는 번호만 남기고 정렬
    const lineMap = new Map();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d{1,2})\s*:\s*([1-4])(\?)?\s*$/);
      if (!m) continue;
      const n = Number(m[1]);
      if (!finalNums.includes(n)) continue;
      lineMap.set(n, `${n}: ${m[2]}${m[3] || ""}`);
    }

    // finalNums 전체를 반드시 출력(누락되면 1?로 채움)
    const missingFilledWith = [];
    const finalLines = [];
    for (const n of finalNums) {
      if (lineMap.has(n)) {
        finalLines.push(lineMap.get(n));
      } else {
        missingFilledWith.push(n);
        finalLines.push(`${n}: 1?`);
      }
    }

    const unsureNums = finalLines
      .filter((s) => s.endsWith("?"))
      .map((s) => Number(s.split(":")[0].trim()));

    return json(200, {
      ok: true,
      text: finalLines.join("\n"),
      debug: {
        model: "openai/gpt-4.1",
        temperature: 0.1,
        page,
        maxTokens,
        detectedNums,
        finalNums,
        missingFilledWith,
        unsureNums,
        clippedInfo,
        excerptPreview: clipped.slice(0, 800),
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
};

// netlify/functions/ocr.js
// OCR.Space PRO 호출 (apipro1/apipro2). JSON(dataURL base64) 받아서 base64Image로 전달.
// - env: OCR_SPACE_API_KEY (필수)
// - env: OCR_SPACE_API_ENDPOINT (권장: https://apipro1.ocr.space/parse/image)
// - env: OCR_SPACE_API_ENDPOINT_BACKUP (권장: https://apipro2.ocr.space/parse/image)
// - env: OCR_SPACE_TIMEOUT_MS (옵션, 기본 30000)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function normalizeEndpoint(url) {
  if (!url) return "";
  let s = String(url).trim();

  // 흔한 실수 자동 수정:
  // api-pro1.ocr.space -> apipro1.ocr.space
  // api-pro2.ocr.space -> apipro2.ocr.space
  s = s.replace("://api-pro1.ocr.space", "://apipro1.ocr.space");
  s = s.replace("://api-pro2.ocr.space", "://apipro2.ocr.space");

  // 혹시 api.ocr.space(무료)로 들어오면 그대로 두되, PRO키면 403 날 수 있으니 디버그에 노출
  return s;
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

// 대충 문항번호 패턴 카운트(너가 쓰던 hits 느낌 유지)
function countQuestionPatterns(text) {
  if (!text) return 0;
  const m = String(text).match(/\b(\d{1,2})\b[.)\s]/g);
  return m ? m.length : 0;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = (process.env.OCR_SPACE_API_KEY || "").trim();
    if (!apiKey) {
      return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set on the server" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page !== undefined ? body.page : 1;
    const image = (body.image || body.dataUrl || "").toString();

    if (!image || !image.startsWith("data:image/")) {
      return json(400, {
        ok: false,
        error: "Missing image (expected data URL in JSON body: { image: 'data:image/...base64,...' })",
      });
    }

    const timeoutMs = Math.max(5000, Number(process.env.OCR_SPACE_TIMEOUT_MS || 30000));

    const primary = normalizeEndpoint(process.env.OCR_SPACE_API_ENDPOINT || "https://apipro1.ocr.space/parse/image");
    const backup = normalizeEndpoint(process.env.OCR_SPACE_API_ENDPOINT_BACKUP || "https://apipro2.ocr.space/parse/image");

    const endpoints = [primary, backup].filter(Boolean);

    const payload = new URLSearchParams();
    payload.set("apikey", apiKey);
    payload.set("language", "eng");
    payload.set("isOverlayRequired", "false");
    payload.set("scale", "true");
    payload.set("detectOrientation", "true");
    payload.set("OCREngine", "2"); // 필요하면 3으로 바꿔 테스트 가능
    payload.set("base64Image", image);

    const maxTries = 3;
    let lastErr = null;
    let lastRaw = "";
    let endpointUsed = "";

    for (let epIdx = 0; epIdx < endpoints.length; epIdx++) {
      const endpoint = endpoints[epIdx];
      endpointUsed = endpoint;

      for (let i = 0; i < maxTries; i++) {
        try {
          const res = await fetchWithTimeout(
            endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: payload.toString(),
            },
            timeoutMs
          );

          lastRaw = await res.text().catch(() => "");
          let data = null;
          try { data = JSON.parse(lastRaw); } catch { /* ignore */ }

          if (!res.ok) {
            // 가장 흔한 원인: PRO키를 무료 endpoint에 쏨 => "The API key is invalid"
            lastErr = `OCR.Space HTTP ${res.status}${data ? " / " + (data.ErrorMessage?.join(" | ") || data.ErrorDetails || "") : ""}`;
            if (i < maxTries - 1) await sleep(350 * (i + 1));
            continue;
          }

          if (!data) {
            lastErr = "OCR.Space returned non-JSON";
            if (i < maxTries - 1) await sleep(350 * (i + 1));
            continue;
          }

          if (data.IsErroredOnProcessing) {
            const msg = (data.ErrorMessage && data.ErrorMessage.join(" | ")) || data.ErrorDetails || "OCR.Space processing error";
            lastErr = msg;
            if (i < maxTries - 1) await sleep(350 * (i + 1));
            continue;
          }

          const parsed = (data.ParsedResults && data.ParsedResults[0]) || null;
          const text = (parsed && parsed.ParsedText) ? String(parsed.ParsedText) : "";

          return json(200, {
            ok: true,
            text,
            conf: 0,
            hits: countQuestionPatterns(text),
            debug: {
              page,
              endpointUsed,
              ocrSpace: {
                exitCode: data.OCRExitCode,
                processingTimeInMilliseconds: data.ProcessingTimeInMilliseconds,
              },
            },
          });
        } catch (e) {
          const msg = e?.message ? e.message : String(e);
          lastErr = msg;
          if (i < maxTries - 1) await sleep(350 * (i + 1));
        }
      }
      // primary 다 실패하면 backup으로 넘어감
    }

    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: lastErr || "Unknown",
      raw: (lastRaw || "").slice(0, 1500),
      debug: { endpointUsed },
      hint:
        "1) PRO 키면 엔드포인트는 https://apipro1.ocr.space/parse/image (하이픈 없음) 이어야 함. " +
        "2) Netlify env OCR_SPACE_API_KEY/OCR_SPACE_API_ENDPOINT 값을 확인 후 재배포.",
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Internal server error in ocr function",
      detail: String(err?.message || err),
    });
  }
};

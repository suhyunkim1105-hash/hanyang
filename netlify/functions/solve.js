// netlify/functions/ocr.js
// OCR.Space PRO 호출 (apipro1/apipro2). JSON(dataURL base64) 받아서 base64Image로 전달.
// - env: OCR_SPACE_API_KEY (필수)
// - env: OCR_SPACE_API_ENDPOINT (권장: https://apipro1.ocr.space/parse/image)
// - env: OCR_SPACE_API_ENDPOINT_BACKUP (권장: https://apipro2.ocr.space/parse/image)
// - env: OCR_SPACE_TIMEOUT_MS (옵션, 기본 30000)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}

// OCR.Space 응답에서 텍스트/메타 정보 뽑기
function extractOcrResult(parsedJson) {
  try {
    if (!parsedJson) return { ok: false, reason: "No JSON" };

    const exitCode = parsedJson.OCRExitCode;
    const isErrored = !!parsedJson.IsErroredOnProcessing;

    if (exitCode !== 1 || isErrored) {
      // OCR.Space가 에러라고 판단한 경우
      const msg =
        (parsedJson.ErrorMessage && parsedJson.ErrorMessage.join
          ? parsedJson.ErrorMessage.join("; ")
          : parsedJson.ErrorMessage) ||
        parsedJson.ErrorMessage ||
        parsedJson.ErrorDetails ||
        "OCR.Space reported an error";
      return {
        ok: false,
        reason: msg,
        exitCode,
        isErroredOnProcessing: isErrored,
      };
    }

    const results = parsedJson.ParsedResults || [];
    const texts = results
      .map((r) => (r.ParsedText != null ? String(r.ParsedText) : ""))
      .filter((t) => t.length > 0);

    const text = texts.join("\n").trim();

    // 신뢰도 평균 (없으면 0)
    let meanConfidence = 0;
    let count = 0;
    for (const r of results) {
      if (typeof r.ParsedText !== "string") continue;
      if (typeof r.Confidence === "number") {
        meanConfidence += r.Confidence;
        count++;
      }
    }
    if (count > 0) meanConfidence = meanConfidence / count;

    // 번호 패턴 개수 ( 1. / 2. / 11. 이런 것 세기 )
    let questionNumberCount = 0;
    try {
      const pattern = /(^|\n)\s*\d{1,2}\s*[\.\)]/g;
      const matches = text.match(pattern);
      if (matches) questionNumberCount = matches.length;
    } catch {
      questionNumberCount = 0;
    }

    return {
      ok: true,
      text,
      meta: {
        meanConfidence,
        questionNumberCount,
        ocrExitCode: exitCode,
        isErroredOnProcessing: isErrored,
      },
    };
  } catch (e) {
    return {
      ok: false,
      reason: "Failed to parse OCR result: " + String(e && e.message ? e.message : e),
    };
  }
}

async function callOcrSpaceOnce(endpoint, apiKey, base64Image, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const params = new URLSearchParams();
    // OCR.Space는 base64Image에 dataURL 전체("data:image/..;base64,...")를 기대함
    params.append("apikey", apiKey);
    params.append("base64Image", base64Image);

    // ✅ 영어 문제지 전용: 영어만 인식하도록 eng 사용
    params.append("language", "eng");

    params.append("OCREngine", "2");
    params.append("scale", "true");
    params.append("isTable", "false");

    const res = await fetch(endpoint, {
      method: "POST",
      body: params,
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      return {
        httpOk: false,
        status: res.status,
        raw,
      };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        httpOk: false,
        status: res.status,
        raw,
        parseError: "JSON parse error: " + String(e && e.message ? e.message : e),
      };
    }

    return {
      httpOk: true,
      status: res.status,
      raw,
      json: parsed,
    };
  } catch (e) {
    return {
      httpOk: false,
      status: null,
      raw: null,
      fetchError: String(e && e.message ? e.message : e),
    };
  } finally {
    clearTimeout(id);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set" });
    }

    const primaryEndpoint =
      process.env.OCR_SPACE_API_ENDPOINT ||
      "https://apipro1.ocr.space/parse/image";
    const backupEndpoint =
      process.env.OCR_SPACE_API_ENDPOINT_BACKUP ||
      "https://apipro2.ocr.space/parse/image";

    let timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || "30000");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timeoutMs = 30000;
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const image = body.image || body.base64Image || "";

    if (typeof image !== "string" || !image.trim()) {
      return json(400, { ok: false, error: "Missing image (dataURL base64)" });
    }

    const base64Image = image.trim(); // 이미 data:image/...;base64,... 형식이라고 가정

    // 1차: primary endpoint
    const primary = await callOcrSpaceOnce(
      primaryEndpoint,
      apiKey,
      base64Image,
      timeoutMs
    );

    let useResult = primary;
    let usedEndpoint = primaryEndpoint;
    let fromBackup = false;

    // primary가 http 에러/타임아웃/JSON에러/exitCode 에러 등일 때 backup 시도
    let extractedPrimary = null;
    if (primary.httpOk && primary.json) {
      extractedPrimary = extractOcrResult(primary.json);
      if (!extractedPrimary.ok) {
        // OCR.Space가 에러라고 판단한 경우만 backup 고려
        if (backupEndpoint && backupEndpoint !== primaryEndpoint) {
          await sleep(1000);
          const backup = await callOcrSpaceOnce(
            backupEndpoint,
            apiKey,
            base64Image,
            timeoutMs
          );
          if (backup.httpOk && backup.json) {
            const extractedBackup = extractOcrResult(backup.json);
            if (extractedBackup.ok) {
              useResult = backup;
              usedEndpoint = backupEndpoint;
              fromBackup = true;
              extractedPrimary = null;
            } else {
              // backup도 OCR 실패 → 그대로 primary 기준으로 에러 리턴
              useResult = primary;
            }
          } else {
            // backup도 HTTP/타임아웃 실패 → 그대로 primary 기준으로 에러 리턴
            useResult = primary;
          }
        }
      }
    }

    // 최종 useResult를 기반으로 응답 만들기
    if (!useResult.httpOk) {
      // HTTP 레벨 실패 / fetch 에러
      return json(200, {
        ok: false,
        error: "HTTP or fetch error when calling OCR.Space",
        page,
        endpoint: usedEndpoint,
        status: useResult.status ?? null,
        fetchError: useResult.fetchError ?? null,
        raw: useResult.raw ? String(useResult.raw).slice(0, 2000) : null,
      });
    }

    if (!useResult.json) {
      // JSON 파싱 실패
      return json(200, {
        ok: false,
        error: "Failed to parse OCR.Space JSON",
        page,
        endpoint: usedEndpoint,
        status: useResult.status ?? null,
        raw: useResult.raw ? String(useResult.raw).slice(0, 2000) : null,
        parseError: useResult.parseError ?? null,
      });
    }

    // 실제 OCR 결과 추출
    const extracted = extractOcrResult(useResult.json);
    if (!extracted.ok) {
      return json(200, {
        ok: false,
        error: "OCR.Space returned error",
        page,
        endpoint: usedEndpoint,
        exitCode: extracted.exitCode ?? null,
        isErroredOnProcessing: extracted.isErroredOnProcessing ?? null,
        reason: extracted.reason ?? null,
        raw: useResult.raw ? String(useResult.raw).slice(0, 2000) : null,
      });
    }

    // 성공: 기존처럼 ok:true + text. (meta/raw 는 추가 정보일 뿐)
    return json(200, {
      ok: true,
      text: extracted.text,
      page,
      endpoint: usedEndpoint,
      fromBackup,
      meta: extracted.meta,
      // raw 전체는 로그 길이 방지를 위해 조금만 보냄 (필요시 늘려도 됨)
      raw: useResult.raw ? String(useResult.raw).slice(0, 2000) : null,
    });
  } catch (e) {
    // 최상위 예외
    return json(200, {
      ok: false,
      error: "Unhandled error in ocr function",
      detail: String(e && e.message ? e.message : e),
    });
  }
};

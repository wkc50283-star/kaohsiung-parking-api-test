let cachedAccessToken = "";
let tokenExpiresAt = 0;

const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

const PARKING_AVAILABILITY_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?$format=JSON";

function sendJson(res, statusCode, payload, cacheControl = "no-store") {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.end(JSON.stringify(payload, null, 2));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getAccessToken() {
  const now = Date.now();

  // Token 尚未過期時，優先使用目前 Vercel Function 記憶體內的快取。
  if (cachedAccessToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return {
      accessToken: cachedAccessToken,
      tokenSource: "memory-cache",
    };
  }

  const clientId = process.env.TDX_CLIENT_ID;
  const clientSecret = process.env.TDX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const error = new Error(
      "Vercel 環境變數尚未設定完整，請確認 TDX_CLIENT_ID 與 TDX_CLIENT_SECRET。"
    );
    error.code = "MISSING_ENVIRONMENT_VARIABLES";
    throw error;
  }

  const tokenResponse = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
    15000
  );

  const tokenText = await tokenResponse.text();

  if (!tokenResponse.ok) {
    const error = new Error("TDX Access Token 取得失敗");
    error.code = "TDX_TOKEN_REQUEST_FAILED";
    error.upstreamStatus = tokenResponse.status;
    error.bodyPreview = tokenText.slice(0, 500);
    throw error;
  }

  let tokenData;

  try {
    tokenData = JSON.parse(tokenText);
  } catch (parseError) {
    const error = new Error("TDX Token 回傳內容不是有效 JSON");
    error.code = "TDX_TOKEN_PARSE_FAILED";
    error.bodyPreview = tokenText.slice(0, 500);
    throw error;
  }

  if (!tokenData.access_token) {
    const error = new Error("TDX Token 回傳內容缺少 access_token");
    error.code = "TDX_TOKEN_MISSING";
    error.bodyPreview = tokenText.slice(0, 500);
    throw error;
  }

  const expiresInSeconds = Number(tokenData.expires_in) || 3600;

  cachedAccessToken = tokenData.access_token;
  tokenExpiresAt = Date.now() + expiresInSeconds * 1000;

  return {
    accessToken: cachedAccessToken,
    tokenSource: "new-token",
  };
}

function extractRecords(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (data && Array.isArray(data.value)) {
    return data.value;
  }

  if (data && Array.isArray(data.ParkingAvailabilities)) {
    return data.ParkingAvailabilities;
  }

  return [];
}

function createDiagnostic(error) {
  return {
    name: error && error.name ? error.name : "UnknownError",
    code: error && error.code ? error.code : "",
    message: error && error.message ? error.message : "",
    upstreamStatus:
      error && error.upstreamStatus ? error.upstreamStatus : null,
    bodyPreview:
      error && error.bodyPreview ? error.bodyPreview : "",
    causeCode:
      error && error.cause && error.cause.code
        ? error.cause.code
        : "",
    causeMessage:
      error && error.cause && error.cause.message
        ? error.cause.message
        : "",
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, {
      ok: false,
      message: "僅支援 GET 請求",
    });
    return;
  }

  try {
    const { accessToken, tokenSource } = await getAccessToken();

    const parkingResponse = await fetchWithTimeout(
      PARKING_AVAILABILITY_URL,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      },
      20000
    );

    const rawText = await parkingResponse.text();
    const responseBytes = Buffer.byteLength(rawText, "utf8");

    if (!parkingResponse.ok) {
      sendJson(res, 502, {
        ok: false,
        message: "TDX 停車資料 API 有回應，但狀態不是成功",
        upstreamStatus: parkingResponse.status,
        bodyPreview: rawText.slice(0, 500),
      });
      return;
    }

    let data;

    try {
      data = JSON.parse(rawText);
    } catch (parseError) {
      sendJson(res, 502, {
        ok: false,
        message: "TDX 停車資料有回應，但內容無法解析為 JSON",
        contentType: parkingResponse.headers.get("content-type"),
        bodyPreview: rawText.slice(0, 500),
      });
      return;
    }

    const records = extractRecords(data);
    const firstRecord = records[0] || null;

    sendJson(
      res,
      200,
      {
        ok: true,
        testStage: "TDX 高雄市路外停車場即時剩餘位最小測試",
        source: "交通部 TDX 運輸資料流通服務平臺",
        city: "Kaohsiung",
        tokenSource,
        upstreamStatus: parkingResponse.status,
        fetchedAt: new Date().toISOString(),
        responseBytes,
        responseKilobytes: Number((responseBytes / 1024).toFixed(2)),
        topLevelType: Array.isArray(data) ? "array" : typeof data,
        recordCount: records.length,
        firstRecordKeys: firstRecord ? Object.keys(firstRecord) : [],
        sampleRecords: records.slice(0, 3),
      },
      "s-maxage=60, stale-while-revalidate=30"
    );
  } catch (error) {
    const diagnostic = createDiagnostic(error);

    console.error("TDX parking request failed:", diagnostic);

    sendJson(res, 500, {
      ok: false,
      message: "Vercel Function 呼叫 TDX 資料失敗",
      diagnostic,
    });
  }
};

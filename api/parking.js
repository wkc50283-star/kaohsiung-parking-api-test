let cachedAccessToken = "";
let tokenExpiresAt = 0;

const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

const PARKING_AVAILABILITY_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?$format=JSON";

const CAR_PARK_BASIC_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/CarPark/City/Kaohsiung?$format=JSON";

function sendJson(res, statusCode, payload, cacheControl = "no-store") {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.end(JSON.stringify(payload, null, 2));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
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

  // Token 未過期時，使用 Vercel Function 記憶體快取。
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

function extractRecords(data, possibleKeys = []) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== "object") {
    return [];
  }

  for (const key of possibleKeys) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data.value)) {
    return data.value;
  }

  return [];
}

function readLocalizedText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  return value.Zh_tw || value.ZhTW || value.En || value.Zh_cn || "";
}

function readPosition(carPark) {
  const position =
    carPark.CarParkPosition ||
    carPark.Position ||
    carPark.GeoPosition ||
    {};

  const latitude = Number(
    position.PositionLat ??
      position.Latitude ??
      carPark.PositionLat ??
      carPark.Latitude
  );

  const longitude = Number(
    position.PositionLon ??
      position.Longitude ??
      carPark.PositionLon ??
      carPark.Longitude
  );

  return {
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
  };
}

function createAvailabilityStats(records) {
  const stats = {
    total: records.length,
    positive: 0,
    zero: 0,
    negative: 0,
    invalid: 0,
    updatedWithin5Minutes: 0,
    updatedWithin15Minutes: 0,
    updatedWithin30Minutes: 0,
    olderThan30Minutes: 0,
    invalidDataCollectTime: 0,
  };

  const now = Date.now();

  for (const record of records) {
    const availableSpaces = Number(record.AvailableSpaces);

    if (!Number.isFinite(availableSpaces)) {
      stats.invalid += 1;
    } else if (availableSpaces > 0) {
      stats.positive += 1;
    } else if (availableSpaces === 0) {
      stats.zero += 1;
    } else {
      stats.negative += 1;
    }

    const collectTime = Date.parse(record.DataCollectTime);

    if (!Number.isFinite(collectTime)) {
      stats.invalidDataCollectTime += 1;
      continue;
    }

    const ageMinutes = (now - collectTime) / 1000 / 60;

    if (ageMinutes <= 5) {
      stats.updatedWithin5Minutes += 1;
    }

    if (ageMinutes <= 15) {
      stats.updatedWithin15Minutes += 1;
    }

    if (ageMinutes <= 30) {
      stats.updatedWithin30Minutes += 1;
    } else {
      stats.olderThan30Minutes += 1;
    }
  }

  return stats;
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

async function fetchTdxJson(url, accessToken, label) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    30000
  );

  const rawText = await response.text();
  const responseBytes = Buffer.byteLength(rawText, "utf8");

  if (!response.ok) {
    const error = new Error(`${label} API 回傳狀態不是成功`);
    error.code = "TDX_DATA_REQUEST_FAILED";
    error.upstreamStatus = response.status;
    error.bodyPreview = rawText.slice(0, 500);
    throw error;
  }

  try {
    return {
      data: JSON.parse(rawText),
      responseBytes,
    };
  } catch (parseError) {
    const error = new Error(`${label} API 回傳內容無法解析為 JSON`);
    error.code = "TDX_DATA_PARSE_FAILED";
    error.bodyPreview = rawText.slice(0, 500);
    throw error;
  }
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

    const [availabilityResult, basicResult] = await Promise.all([
      fetchTdxJson(
        PARKING_AVAILABILITY_URL,
        accessToken,
        "TDX 即時剩餘位"
      ),
      fetchTdxJson(
        CAR_PARK_BASIC_URL,
        accessToken,
        "TDX 停車場基本資料"
      ),
    ]);

    const availabilityRecords = extractRecords(
      availabilityResult.data,
      ["ParkingAvailabilities", "CarParkAvailabilities"]
    );

    const basicRecords = extractRecords(
      basicResult.data,
      ["CarParks"]
    );

    const basicMap = new Map();

    for (const carPark of basicRecords) {
      if (carPark.CarParkID) {
        basicMap.set(carPark.CarParkID, carPark);
      }
    }

    let matchedRecords = 0;
    let unmatchedAvailabilityRecords = 0;
    let recordsWithCoordinates = 0;
    let recordsWithAddress = 0;

    const joinedSamples = [];
    const negativeAvailabilitySamples = [];

    for (const availability of availabilityRecords) {
      const carPark = basicMap.get(availability.CarParkID);

      if (!carPark) {
        unmatchedAvailabilityRecords += 1;
        continue;
      }

      matchedRecords += 1;

      const position = readPosition(carPark);
      const address = readLocalizedText(carPark.Address);

      if (
        position.latitude !== null &&
        position.longitude !== null
      ) {
        recordsWithCoordinates += 1;
      }

      if (address) {
        recordsWithAddress += 1;
      }

      const joinedRecord = {
        CarParkID: availability.CarParkID,
        CarParkName:
          readLocalizedText(availability.CarParkName) ||
          readLocalizedText(carPark.CarParkName),
        Address: address,
        Latitude: position.latitude,
        Longitude: position.longitude,
        TotalSpaces: availability.TotalSpaces,
        AvailableSpaces: availability.AvailableSpaces,
        ServiceStatus: availability.ServiceStatus,
        FullStatus: availability.FullStatus,
        ChargeStatus: availability.ChargeStatus,
        DataCollectTime: availability.DataCollectTime,
      };

      if (joinedSamples.length < 5) {
        joinedSamples.push(joinedRecord);
      }

      if (
        Number(availability.AvailableSpaces) < 0 &&
        negativeAvailabilitySamples.length < 10
      ) {
        negativeAvailabilitySamples.push(joinedRecord);
      }
    }

    const combinedResponseBytes =
      availabilityResult.responseBytes + basicResult.responseBytes;

    sendJson(
      res,
      200,
      {
        ok: true,
        testStage: "TDX 高雄停車資料第二階段：動態與靜態資料配對測試",
        source: "交通部 TDX 運輸資料流通服務平臺",
        city: "Kaohsiung",
        tokenSource,
        fetchedAt: new Date().toISOString(),

        responseSize: {
          availabilityBytes: availabilityResult.responseBytes,
          availabilityKilobytes: Number(
            (availabilityResult.responseBytes / 1024).toFixed(2)
          ),
          basicBytes: basicResult.responseBytes,
          basicKilobytes: Number(
            (basicResult.responseBytes / 1024).toFixed(2)
          ),
          combinedBytes: combinedResponseBytes,
          combinedKilobytes: Number(
            (combinedResponseBytes / 1024).toFixed(2)
          ),
        },

        recordCounts: {
          availabilityRecords: availabilityRecords.length,
          basicRecords: basicRecords.length,
          matchedRecords,
          unmatchedAvailabilityRecords,
          recordsWithCoordinates,
          recordsWithAddress,
        },

        availabilityQuality:
          createAvailabilityStats(availabilityRecords),

        firstAvailabilityRecordKeys:
          availabilityRecords[0]
            ? Object.keys(availabilityRecords[0])
            : [],

        firstBasicRecordKeys:
          basicRecords[0]
            ? Object.keys(basicRecords[0])
            : [],

        joinedSamples,
        negativeAvailabilitySamples,
      },
      "s-maxage=60, stale-while-revalidate=30"
    );
  } catch (error) {
    const diagnostic = createDiagnostic(error);

    console.error("TDX parking test failed:", diagnostic);

    sendJson(res, 500, {
      ok: false,
      message: "Vercel Function 呼叫 TDX 資料失敗",
      diagnostic,
    });
  }
};

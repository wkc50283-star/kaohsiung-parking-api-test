let cachedAccessToken = "";
let tokenExpiresAt = 0;

const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

const AVAILABILITY_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?$format=JSON";

const BASIC_DATA_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/CarPark/City/Kaohsiung?$format=JSON";

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function setSuccessCacheHeaders(res) {
  // 瀏覽器端不要長時間保存，避免手機一直顯示舊資料。
  res.setHeader(
    "Cache-Control",
    "public, max-age=0, must-revalidate"
  );

  // Vercel CDN 快取 5 分鐘。
  // 快取剛過期時，可先回傳舊資料並在背景重新整理。
  res.setHeader(
    "CDN-Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=300"
  );

  res.setHeader(
    "Vercel-CDN-Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=300"
  );
}

function sendJson(
  res,
  statusCode,
  payload,
  useCdnCache = false
) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (useCdnCache) {
    setSuccessCacheHeaders(res);
  } else {
    res.setHeader("Cache-Control", "no-store");
  }

  res.end(JSON.stringify(payload, null, 2));
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 30000
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

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

  if (
    cachedAccessToken &&
    now < tokenExpiresAt - 5 * 60 * 1000
  ) {
    return cachedAccessToken;
  }

  const clientId = process.env.TDX_CLIENT_ID;
  const clientSecret = process.env.TDX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "缺少 TDX_CLIENT_ID 或 TDX_CLIENT_SECRET 環境變數"
    );
  }

  const response = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
    15000
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `TDX Token 取得失敗，狀態碼：${response.status}，內容：${text.slice(
        0,
        300
      )}`
    );
  }

  const data = JSON.parse(text);

  if (!data.access_token) {
    throw new Error(
      "TDX Token 回傳內容缺少 access_token"
    );
  }

  cachedAccessToken = data.access_token;

  tokenExpiresAt =
    Date.now() +
    (Number(data.expires_in) || 3600) * 1000;

  return cachedAccessToken;
}

async function fetchTdxJson(url, accessToken) {
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

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `TDX 資料取得失敗，狀態碼：${response.status}，內容：${text.slice(
        0,
        300
      )}`
    );
  }

  return JSON.parse(text);
}

function extractArray(data, possibleKeys = []) {
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

  return (
    value.Zh_tw ||
    value.ZhTW ||
    value.En ||
    value.Zh_cn ||
    ""
  );
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
    latitude: Number.isFinite(latitude)
      ? latitude
      : null,

    longitude: Number.isFinite(longitude)
      ? longitude
      : null,
  };
}

function calculateAgeMinutes(dataCollectTime) {
  const timestamp = Date.parse(dataCollectTime);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Number(
    ((Date.now() - timestamp) / 1000 / 60).toFixed(1)
  );
}

function toFiniteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function readPassengerCarAvailability(availability) {
  const records = Array.isArray(
    availability.Availabilities
  )
    ? availability.Availabilities
    : [];

  const matches = records.filter(
    (record) => Number(record.SpaceType) === 1
  );

  return {
    matches,
    record: matches.length === 1
      ? matches[0]
      : null,
  };
}

function isExcludedVehicleName(name) {
  // SpaceType = 1 是主要判斷依據。
  // 名稱檢查僅作第二層防呆：
  // 寧可少顯示，也不推薦用途明顯不符的停車場。
  return /機車|摩托車|二輪|重機|自行車|腳踏車|大型車|大客車|遊覽車|巴士|公車|貨車|卡車/i.test(
    name || ""
  );
}

function addReasonCount(reasonCounts, reason) {
  reasonCounts[reason] =
    (reasonCounts[reason] || 0) + 1;
}

function evaluateRecord(availability, basic) {
  const name =
    readLocalizedText(availability.CarParkName) ||
    readLocalizedText(basic.CarParkName);

  const address = readLocalizedText(basic.Address);

  const position = readPosition(basic);

  const passengerCarAvailability =
    readPassengerCarAvailability(availability);

  const passengerCarRecord =
    passengerCarAvailability.record;

  const totalSpaces = passengerCarRecord
    ? toFiniteNumber(
        passengerCarRecord.NumberOfSpaces
      )
    : null;

  const availableSpaces = passengerCarRecord
    ? toFiniteNumber(
        passengerCarRecord.AvailableSpaces
      )
    : null;

  const serviceStatus = toFiniteNumber(
    availability.ServiceStatus
  );

  const fullStatus = toFiniteNumber(
    availability.FullStatus
  );

  const dataAgeMinutes = calculateAgeMinutes(
    availability.DataCollectTime
  );

  const exclusionReasons = [];

  if (!name) {
    exclusionReasons.push("缺少停車場名稱");
  }

  if (passengerCarAvailability.matches.length === 0) {
    exclusionReasons.push(
      "缺少一般汽車車位資料（SpaceType = 1）"
    );
  }

  if (passengerCarAvailability.matches.length > 1) {
    exclusionReasons.push(
      "一般汽車車位資料重複（SpaceType = 1）"
    );
  }

  if (isExcludedVehicleName(name)) {
    exclusionReasons.push(
      "名稱顯示為非一般小客車專用停車場"
    );
  }

  if (
    position.latitude === null ||
    position.longitude === null
  ) {
    exclusionReasons.push("缺少有效經緯度");
  }

  if (
    totalSpaces === null ||
    !Number.isInteger(totalSpaces) ||
    totalSpaces <= 0
  ) {
    exclusionReasons.push(
      "一般汽車總格位不是有效正整數"
    );
  }

  if (
    availableSpaces === null ||
    !Number.isInteger(availableSpaces)
  ) {
    exclusionReasons.push(
      "一般汽車剩餘格位不是有效整數"
    );
  } else if (availableSpaces === -1) {
    exclusionReasons.push(
      "一般汽車剩餘格位未知（-1）"
    );
  } else if (availableSpaces < -1) {
    exclusionReasons.push(
      "一般汽車剩餘格位小於 -1"
    );
  } else if (availableSpaces === 0) {
    exclusionReasons.push(
      "一般汽車已無剩餘格位"
    );
  }

  if (
    totalSpaces !== null &&
    availableSpaces !== null &&
    availableSpaces > totalSpaces
  ) {
    exclusionReasons.push(
      "一般汽車剩餘格位大於總格位"
    );
  }

  if (serviceStatus !== 1) {
    exclusionReasons.push(
      "停車場服務狀態不是正常服務"
    );
  }

  if (![0, 1, 2, 3].includes(fullStatus)) {
    exclusionReasons.push(
      "格位狀態不是可採用的有效值"
    );
  } else if (fullStatus === 2 || fullStatus === 3) {
    exclusionReasons.push(
      "格位狀態為已滿或過度擁擠"
    );
  }

  if (dataAgeMinutes === null) {
    exclusionReasons.push(
      "資料更新時間無法解析"
    );
  } else if (dataAgeMinutes > 15) {
    exclusionReasons.push(
      "資料更新時間超過 15 分鐘"
    );
  } else if (dataAgeMinutes < -5) {
    exclusionReasons.push(
      "資料更新時間異常晚於目前時間"
    );
  }

  const isCleanRecord =
    exclusionReasons.length === 0;

  let parkingStatus = "unknown";

  if (isCleanRecord) {
    parkingStatus = "available";
  }

  return {
    name,
    address,
    latitude: position.latitude,
    longitude: position.longitude,
    totalSpaces,
    availableSpaces,
    sourceSpaceType: 1,
    serviceStatus,
    fullStatus,
    isAlmostFull: fullStatus === 1,
    dataAgeMinutes,
    dataCollectTime:
      availability.DataCollectTime || "",
    chargeStatus:
      availability.ChargeStatus ?? null,
    parkingStatus,
    isCleanRecord,
    exclusionReasons,
  };
}

function createParkingLot(
  availability,
  evaluation
) {
  return {
    carParkId: availability.CarParkID,
    name: evaluation.name,
    address: evaluation.address,
    latitude: evaluation.latitude,
    longitude: evaluation.longitude,
    totalSpaces: evaluation.totalSpaces,
    availableSpaces:
      evaluation.availableSpaces,
    sourceSpaceType:
      evaluation.sourceSpaceType,
    status: evaluation.parkingStatus,
    serviceStatus:
      evaluation.serviceStatus,
    fullStatus: evaluation.fullStatus,
    isAlmostFull:
      evaluation.isAlmostFull,
    chargeStatus:
      evaluation.chargeStatus,
    dataCollectTime:
      evaluation.dataCollectTime,
    dataAgeMinutes:
      evaluation.dataAgeMinutes,
  };
}

function findDataTimeRange(parkingLots) {
  const timestamps = parkingLots
    .map((parkingLot) =>
      Date.parse(parkingLot.dataCollectTime)
    )
    .filter((timestamp) =>
      Number.isFinite(timestamp)
    );

  if (timestamps.length === 0) {
    return {
      oldestDataCollectTime: null,
      newestDataCollectTime: null,
    };
  }

  return {
    oldestDataCollectTime: new Date(
      Math.min(...timestamps)
    ).toISOString(),

    newestDataCollectTime: new Date(
      Math.max(...timestamps)
    ).toISOString(),
  };
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

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
    const accessToken = await getAccessToken();

    const [
      availabilityData,
      basicData,
    ] = await Promise.all([
      fetchTdxJson(
        AVAILABILITY_URL,
        accessToken
      ),

      fetchTdxJson(
        BASIC_DATA_URL,
        accessToken
      ),
    ]);

    const availabilityRecords = extractArray(
      availabilityData,
      [
        "ParkingAvailabilities",
        "CarParkAvailabilities",
      ]
    );

    const basicRecords = extractArray(
      basicData,
      ["CarParks"]
    );

    const basicMap = new Map();

    for (const basic of basicRecords) {
      if (basic.CarParkID) {
        basicMap.set(
          basic.CarParkID,
          basic
        );
      }
    }

    const parkingLots = [];

    const reasonCounts = {};

    const stats = {
      availabilityRecords:
        availabilityRecords.length,

      basicRecords:
        basicRecords.length,

      matchedRecords: 0,
      unmatchedRecords: 0,
      excludedRecords: 0,
      cleanRecords: 0,
      availableRecords: 0,
      almostFullRecords: 0,
    };

    for (const availability of availabilityRecords) {
      const basic = basicMap.get(
        availability.CarParkID
      );

      if (!basic) {
        stats.unmatchedRecords += 1;
        continue;
      }

      stats.matchedRecords += 1;

      const evaluation = evaluateRecord(
        availability,
        basic
      );

      if (!evaluation.isCleanRecord) {
        stats.excludedRecords += 1;

        for (
          const reason of
          evaluation.exclusionReasons
        ) {
          addReasonCount(
            reasonCounts,
            reason
          );
        }

        continue;
      }

      const parkingLot = createParkingLot(
        availability,
        evaluation
      );

      parkingLots.push(parkingLot);

      stats.cleanRecords += 1;

      if (parkingLot.status === "available") {
        stats.availableRecords += 1;
      }

      if (parkingLot.isAlmostFull) {
        stats.almostFullRecords += 1;
      }
    }

    parkingLots.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "available"
          ? -1
          : 1;
      }

      return (
        b.availableSpaces -
        a.availableSpaces
      );
    });

    const dataTimeRange =
      findDataTimeRange(parkingLots);

    sendJson(
      res,
      200,
      {
        ok: true,

        testStage:
          "TDX 高雄停車資料：一般汽車清洗後附近搜尋資料源",

        source:
          "交通部 TDX 運輸資料流通服務平臺",

        generatedAt:
          new Date().toISOString(),

        cachePolicy:
          "Vercel CDN 快取 5 分鐘，過期後可在背景重新整理 5 分鐘。瀏覽器端不長時間保存。",

        fieldRule:
          "第一版只服務一般汽車。總格位與剩餘空位均採用 Availabilities 中 SpaceType = 1 的 NumberOfSpaces 與 AvailableSpaces；不使用可能混入機車或其他車位的最上層 TotalSpaces 與 AvailableSpaces。僅輸出資料新鮮、正常營業、格位狀態可採用且一般汽車剩餘空位大於 0 的停車場。",

        stats,

        excludedReasonCounts:
          reasonCounts,

        dataTimeRange,

        parkingLots,
      },
      true
    );
  } catch (error) {
    console.error(
      "nearby-data failed:",
      error
    );

    sendJson(res, 500, {
      ok: false,
      message:
        "清洗後停車資料取得失敗",

      diagnostic: {
        name:
          error && error.name
            ? error.name
            : "UnknownError",

        message:
          error && error.message
            ? error.message
            : "",
      },
    });
  }
};

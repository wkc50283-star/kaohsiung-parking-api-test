let cachedAccessToken = "";
let tokenExpiresAt = 0;

const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

const AVAILABILITY_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?$format=JSON";

const BASIC_DATA_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/CarPark/City/Kaohsiung?$format=JSON";

// 第一輪只測試 6 個高雄熱門地點。
// 座標目前作為初步測試中心點，正式上線前再逐一校正。
const HOTSPOTS = [
  {
    id: "pier2",
    name: "駁二藝術特區",
    latitude: 22.619889,
    longitude: 120.281722,
  },
  {
    id: "ruifeng-night-market",
    name: "瑞豐夜市",
    latitude: 22.666113,
    longitude: 120.29978,
  },
  {
    id: "kaohsiung-arena",
    name: "高雄巨蛋商圈",
    latitude: 22.66917,
    longitude: 120.30194,
  },
  {
    id: "xinkujiang",
    name: "新堀江商圈",
    latitude: 22.6235,
    longitude: 120.3015,
  },
  {
    id: "sanduo",
    name: "三多商圈",
    latitude: 22.6138,
    longitude: 120.3046,
  },
  {
    id: "yancheng",
    name: "鹽埕區",
    latitude: 22.62694,
    longitude: 120.28806,
  },
];

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
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

  if (cachedAccessToken && now < tokenExpiresAt - 5 * 60 * 1000) {
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
    throw new Error("TDX Token 回傳內容缺少 access_token");
  }

  cachedAccessToken = data.access_token;
  tokenExpiresAt =
    Date.now() + (Number(data.expires_in) || 3600) * 1000;

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

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadiusMeters = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;

  const latitudeDifference = toRadians(lat2 - lat1);
  const longitudeDifference = toRadians(lon2 - lon1);

  const a =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(longitudeDifference / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(earthRadiusMeters * c);
}

function calculateAgeMinutes(dataCollectTime) {
  const timestamp = Date.parse(dataCollectTime);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Number(((Date.now() - timestamp) / 1000 / 60).toFixed(1));
}

function isObviousMotorcycleName(name) {
  return /機車|摩托車|二輪/i.test(name || "");
}

function normalizeValue(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return String(value);
}

function collectSpaceTypeCounts(records) {
  const counts = {};

  for (const record of records) {
    const availabilities = Array.isArray(record.Availabilities)
      ? record.Availabilities
      : [];

    for (const item of availabilities) {
      const key =
        item && item.SpaceType !== undefined
          ? String(item.SpaceType)
          : "missing";

      counts[key] = (counts[key] || 0) + 1;
    }
  }

  return counts;
}

function collectMotorcycleFlagCounts(records) {
  const counts = {};

  for (const record of records) {
    const key = normalizeValue(record.IsMotorcycle);
    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function evaluateRecord(availability, basic) {
  const name =
    readLocalizedText(availability.CarParkName) ||
    readLocalizedText(basic.CarParkName);

  const totalSpaces = Number(availability.TotalSpaces);
  const availableSpaces = Number(availability.AvailableSpaces);
  const serviceStatus = Number(availability.ServiceStatus);
  const fullStatus = Number(availability.FullStatus);

  const dataAgeMinutes = calculateAgeMinutes(
    availability.DataCollectTime
  );

  const exclusionReasons = [];

  if (isObviousMotorcycleName(name)) {
    exclusionReasons.push("名稱顯示為機車停車場");
  }

  if (!Number.isFinite(totalSpaces) || totalSpaces <= 0) {
    exclusionReasons.push("總格位不是有效正數");
  }

  if (!Number.isFinite(availableSpaces)) {
    exclusionReasons.push("剩餘格位不是有效數字");
  }

  if (Number.isFinite(availableSpaces) && availableSpaces < 0) {
    exclusionReasons.push("剩餘格位小於 0");
  }

  if (
    Number.isFinite(totalSpaces) &&
    Number.isFinite(availableSpaces) &&
    availableSpaces > totalSpaces
  ) {
    exclusionReasons.push("剩餘格位大於總格位");
  }

  if (serviceStatus !== 1) {
    exclusionReasons.push("停車場服務狀態不是正常服務");
  }

  if (dataAgeMinutes === null) {
    exclusionReasons.push("資料更新時間無法解析");
  } else if (dataAgeMinutes > 15) {
    exclusionReasons.push("資料更新時間超過 15 分鐘");
  }

  const isCleanRecord = exclusionReasons.length === 0;

  const isReliableAvailable =
    isCleanRecord &&
    fullStatus !== 1 &&
    availableSpaces > 0;

  const isReliableFull =
    isCleanRecord &&
    (fullStatus === 1 || availableSpaces === 0);

  return {
    name,
    totalSpaces,
    availableSpaces,
    serviceStatus,
    fullStatus,
    dataAgeMinutes,
    isCleanRecord,
    isReliableAvailable,
    isReliableFull,
    exclusionReasons,
  };
}

function createCompactRecord(availability, basic, evaluation) {
  const position = readPosition(basic);

  return {
    CarParkID: availability.CarParkID,
    CarParkName: evaluation.name,
    Address: readLocalizedText(basic.Address),
    Latitude: position.latitude,
    Longitude: position.longitude,
    TotalSpaces: evaluation.totalSpaces,
    AvailableSpaces: evaluation.availableSpaces,
    ServiceStatus: evaluation.serviceStatus,
    FullStatus: evaluation.fullStatus,
    DataCollectTime: availability.DataCollectTime,
    DataAgeMinutes: evaluation.dataAgeMinutes,
    IsMotorcycle: basic.IsMotorcycle,
    ParkingTypes: basic.ParkingTypes,
    Availabilities: availability.Availabilities,
    IsCleanRecord: evaluation.isCleanRecord,
    IsReliableAvailable: evaluation.isReliableAvailable,
    IsReliableFull: evaluation.isReliableFull,
    ExclusionReasons: evaluation.exclusionReasons,
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
    const accessToken = await getAccessToken();

    const [availabilityData, basicData] = await Promise.all([
      fetchTdxJson(AVAILABILITY_URL, accessToken),
      fetchTdxJson(BASIC_DATA_URL, accessToken),
    ]);

    const availabilityRecords = extractArray(availabilityData, [
      "ParkingAvailabilities",
      "CarParkAvailabilities",
    ]);

    const basicRecords = extractArray(basicData, ["CarParks"]);

    const basicMap = new Map();

    for (const carPark of basicRecords) {
      if (carPark.CarParkID) {
        basicMap.set(carPark.CarParkID, carPark);
      }
    }

    const joinedRecords = [];

    const globalStats = {
      availabilityRecords: availabilityRecords.length,
      basicRecords: basicRecords.length,
      matchedRecords: 0,
      unmatchedRecords: 0,
      missingCoordinatesRecords: 0,
      obviousMotorcycleNameRecords: 0,
      negativeAvailabilityRecords: 0,
      availabilityGreaterThanTotalRecords: 0,
      zeroAvailabilityRecords: 0,
      staleRecords: 0,
      serviceUnavailableRecords: 0,
      cleanRecords: 0,
      reliableAvailableRecords: 0,
      reliableFullRecords: 0,
    };

    const samples = {
      obviousMotorcycleNameSamples: [],
      negativeAvailabilitySamples: [],
      availabilityGreaterThanTotalSamples: [],
      missingCoordinatesSamples: [],
      generalFieldInspectionSamples: [],
    };

    for (const availability of availabilityRecords) {
      const basic = basicMap.get(availability.CarParkID);

      if (!basic) {
        globalStats.unmatchedRecords += 1;
        continue;
      }

      globalStats.matchedRecords += 1;

      const evaluation = evaluateRecord(availability, basic);

      const compact = createCompactRecord(
        availability,
        basic,
        evaluation
      );

      joinedRecords.push(compact);

      if (
        compact.Latitude === null ||
        compact.Longitude === null
      ) {
        globalStats.missingCoordinatesRecords += 1;

        if (samples.missingCoordinatesSamples.length < 10) {
          samples.missingCoordinatesSamples.push(compact);
        }
      }

      if (isObviousMotorcycleName(evaluation.name)) {
        globalStats.obviousMotorcycleNameRecords += 1;

        if (samples.obviousMotorcycleNameSamples.length < 10) {
          samples.obviousMotorcycleNameSamples.push(compact);
        }
      }

      if (evaluation.availableSpaces < 0) {
        globalStats.negativeAvailabilityRecords += 1;

        if (samples.negativeAvailabilitySamples.length < 10) {
          samples.negativeAvailabilitySamples.push(compact);
        }
      }

      if (
        Number.isFinite(evaluation.totalSpaces) &&
        Number.isFinite(evaluation.availableSpaces) &&
        evaluation.availableSpaces > evaluation.totalSpaces
      ) {
        globalStats.availabilityGreaterThanTotalRecords += 1;

        if (
          samples.availabilityGreaterThanTotalSamples.length < 10
        ) {
          samples.availabilityGreaterThanTotalSamples.push(compact);
        }
      }

      if (evaluation.availableSpaces === 0) {
        globalStats.zeroAvailabilityRecords += 1;
      }

      if (
        evaluation.dataAgeMinutes === null ||
        evaluation.dataAgeMinutes > 15
      ) {
        globalStats.staleRecords += 1;
      }

      if (evaluation.serviceStatus !== 1) {
        globalStats.serviceUnavailableRecords += 1;
      }

      if (evaluation.isCleanRecord) {
        globalStats.cleanRecords += 1;
      }

      if (evaluation.isReliableAvailable) {
        globalStats.reliableAvailableRecords += 1;
      }

      if (evaluation.isReliableFull) {
        globalStats.reliableFullRecords += 1;
      }

      if (samples.generalFieldInspectionSamples.length < 10) {
        samples.generalFieldInspectionSamples.push(compact);
      }
    }

    const hotspotResults = HOTSPOTS.map((hotspot) => {
      const nearbyRecords = joinedRecords
        .filter(
          (parkingLot) =>
            parkingLot.Latitude !== null &&
            parkingLot.Longitude !== null
        )
        .map((parkingLot) => ({
          ...parkingLot,
          DistanceMeters: calculateDistanceMeters(
            hotspot.latitude,
            hotspot.longitude,
            parkingLot.Latitude,
            parkingLot.Longitude
          ),
        }))
        .filter((parkingLot) => parkingLot.DistanceMeters <= 1200);

      const reliableCandidates = nearbyRecords
        .filter((parkingLot) => parkingLot.IsReliableAvailable)
        .sort((a, b) => {
          if (a.DistanceMeters !== b.DistanceMeters) {
            return a.DistanceMeters - b.DistanceMeters;
          }

          return b.AvailableSpaces - a.AvailableSpaces;
        });

      const excludedNearbyRecords = nearbyRecords
        .filter((parkingLot) => !parkingLot.IsCleanRecord)
        .sort((a, b) => a.DistanceMeters - b.DistanceMeters);

      const countWithin = (records, meters) =>
        records.filter(
          (parkingLot) => parkingLot.DistanceMeters <= meters
        ).length;

      return {
        id: hotspot.id,
        name: hotspot.name,
        testCenter: {
          Latitude: hotspot.latitude,
          Longitude: hotspot.longitude,
        },
        rawNearbyLotsWithin800Meters: countWithin(
          nearbyRecords,
          800
        ),
        rawNearbyLotsWithin1200Meters: countWithin(
          nearbyRecords,
          1200
        ),
        reliableAutomobileCandidatesWithin500Meters: countWithin(
          reliableCandidates,
          500
        ),
        reliableAutomobileCandidatesWithin800Meters: countWithin(
          reliableCandidates,
          800
        ),
        reliableAutomobileCandidatesWithin1200Meters: countWithin(
          reliableCandidates,
          1200
        ),
        passesPrimaryScreen:
          countWithin(reliableCandidates, 800) >= 2,
        passesBackupScreen:
          countWithin(reliableCandidates, 1200) >= 2,
        topReliableCandidates: reliableCandidates.slice(0, 6),
        excludedNearbySamples: excludedNearbyRecords.slice(0, 6),
      };
    });

    const primaryPassCount = hotspotResults.filter(
      (hotspot) => hotspot.passesPrimaryScreen
    ).length;

    const backupPassCount = hotspotResults.filter(
      (hotspot) => hotspot.passesBackupScreen
    ).length;

    sendJson(res, 200, {
      ok: true,
      testStage:
        "TDX 高雄停車資料第三階段：汽車停車場資料清洗與熱門地點覆蓋測試",
      source: "交通部 TDX 運輸資料流通服務平臺",
      importantNote:
        "目前先排除名稱明確含有機車、摩托車或二輪的停車場。IsMotorcycle 與 ParkingTypes 欄位只輸出供檢查，尚未直接作為排除依據，避免誤刪同時支援汽車與機車的停車場。",
      cleaningRules: [
        "排除名稱明確含有機車、摩托車或二輪的停車場",
        "排除總格位不是有效正數的資料",
        "排除剩餘格位不是有效數字的資料",
        "排除剩餘格位小於 0 的資料",
        "排除剩餘格位大於總格位的資料",
        "排除服務狀態不是正常服務的資料",
        "排除更新時間無法解析或超過 15 分鐘的資料",
      ],
      screeningRule:
        "熱門地點半徑 800 公尺內至少有 2 個清洗後仍具可靠即時空位的候選停車場，視為主要範圍初步通過；1200 公尺僅作為第二層備案。",
      globalStats,
      fieldInspection: {
        observedSpaceTypeCounts:
          collectSpaceTypeCounts(availabilityRecords),
        observedIsMotorcycleFlagCounts:
          collectMotorcycleFlagCounts(basicRecords),
      },
      hotspotSummary: {
        testedHotspots: HOTSPOTS.length,
        primaryPassCount,
        primaryFailedCount:
          HOTSPOTS.length - primaryPassCount,
        backupPassCount,
        backupFailedCount:
          HOTSPOTS.length - backupPassCount,
        overallPrimaryPass:
          primaryPassCount === HOTSPOTS.length,
      },
      hotspotResults,
      samples,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: "TDX 停車資料清洗測試失敗",
      diagnostic: {
        name: error && error.name ? error.name : "UnknownError",
        message: error && error.message ? error.message : "",
      },
    });
  }
};

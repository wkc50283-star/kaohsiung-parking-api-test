const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

const AVAILABILITY_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?$format=JSON";

const BASIC_DATA_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/CarPark/City/Kaohsiung?$format=JSON";

// 目前只做初步涵蓋率測試。
// 部分商圈範圍較大，座標先作為測試中心點，正式上線前再逐一校正。
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

  return data.access_token;
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

function classifyParkingLot(record) {
  const availableSpaces = Number(record.AvailableSpaces);
  const serviceStatus = Number(record.ServiceStatus);
  const fullStatus = Number(record.FullStatus);
  const ageMinutes = calculateAgeMinutes(record.DataCollectTime);

  if (serviceStatus !== 1) {
    return "service-unavailable";
  }

  if (ageMinutes === null || ageMinutes > 15) {
    return "stale";
  }

  if (!Number.isFinite(availableSpaces)) {
    return "invalid";
  }

  if (availableSpaces < 0) {
    return "unreliable";
  }

  if (availableSpaces === 0 || fullStatus === 1) {
    return "full";
  }

  return "available";
}

function getStatusRank(status) {
  const ranking = {
    available: 1,
    full: 2,
    unreliable: 3,
    stale: 4,
    "service-unavailable": 5,
    invalid: 6,
  };

  return ranking[status] || 99;
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

    for (const availability of availabilityRecords) {
      const basic = basicMap.get(availability.CarParkID);

      if (!basic) {
        continue;
      }

      const position = readPosition(basic);

      if (
        position.latitude === null ||
        position.longitude === null
      ) {
        continue;
      }

      joinedRecords.push({
        CarParkID: availability.CarParkID,
        CarParkName:
          readLocalizedText(availability.CarParkName) ||
          readLocalizedText(basic.CarParkName),
        Address: readLocalizedText(basic.Address),
        Latitude: position.latitude,
        Longitude: position.longitude,
        TotalSpaces: Number(availability.TotalSpaces),
        AvailableSpaces: Number(availability.AvailableSpaces),
        ServiceStatus: Number(availability.ServiceStatus),
        FullStatus: Number(availability.FullStatus),
        DataCollectTime: availability.DataCollectTime,
        DataAgeMinutes: calculateAgeMinutes(
          availability.DataCollectTime
        ),
        DataStatus: classifyParkingLot(availability),
      });
    }

    const hotspotResults = HOTSPOTS.map((hotspot) => {
      const nearbyCandidates = joinedRecords
        .map((parkingLot) => ({
          ...parkingLot,
          DistanceMeters: calculateDistanceMeters(
            hotspot.latitude,
            hotspot.longitude,
            parkingLot.Latitude,
            parkingLot.Longitude
          ),
        }))
        .filter((parkingLot) => parkingLot.DistanceMeters <= 1200)
        .sort((a, b) => {
          const rankDifference =
            getStatusRank(a.DataStatus) -
            getStatusRank(b.DataStatus);

          if (rankDifference !== 0) {
            return rankDifference;
          }

          return a.DistanceMeters - b.DistanceMeters;
        });

      const countWithin = (distanceMeters) =>
        nearbyCandidates.filter(
          (parkingLot) =>
            parkingLot.DistanceMeters <= distanceMeters
        ).length;

      const countAvailableWithin = (distanceMeters) =>
        nearbyCandidates.filter(
          (parkingLot) =>
            parkingLot.DistanceMeters <= distanceMeters &&
            parkingLot.DataStatus === "available"
        ).length;

      return {
        id: hotspot.id,
        name: hotspot.name,
        testCenter: {
          Latitude: hotspot.latitude,
          Longitude: hotspot.longitude,
        },
        parkingLotsWithin500Meters: countWithin(500),
        parkingLotsWithin800Meters: countWithin(800),
        parkingLotsWithin1200Meters: countWithin(1200),
        reliableAvailableLotsWithin800Meters:
          countAvailableWithin(800),
        reliableAvailableLotsWithin1200Meters:
          countAvailableWithin(1200),
        passesInitialScreen:
          countAvailableWithin(1200) >= 2,
        topCandidates: nearbyCandidates.slice(0, 6),
      };
    });

    const passedHotspots = hotspotResults.filter(
      (hotspot) => hotspot.passesInitialScreen
    ).length;

    sendJson(res, 200, {
      ok: true,
      testStage: "TDX 高雄熱門地點即時停車涵蓋率初步測試",
      source: "交通部 TDX 運輸資料流通服務平臺",
      coordinateNote:
        "目前座標僅供初步涵蓋率測試，商圈範圍與正式搜尋中心點仍需後續校正。",
      screeningRule:
        "熱門地點半徑 1200 公尺內，至少有 2 個資料新鮮、空位數大於 0 的停車場，視為初步通過。",
      summary: {
        testedHotspots: HOTSPOTS.length,
        passedHotspots,
        failedHotspots: HOTSPOTS.length - passedHotspots,
        overallInitialPass:
          passedHotspots >= Math.ceil(HOTSPOTS.length * 0.6),
      },
      hotspotResults,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: "熱門地點涵蓋率測試失敗",
      diagnostic: {
        name: error && error.name ? error.name : "UnknownError",
        message: error && error.message ? error.message : "",
      },
    });
  }
};

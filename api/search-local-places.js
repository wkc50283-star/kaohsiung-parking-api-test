const GEOAPIFY_AUTOCOMPLETE_URL =
  "https://api.geoapify.com/v1/geocode/autocomplete";

const GEOAPIFY_SEARCH_URL =
  "https://api.geoapify.com/v1/geocode/search";

const GEOAPIFY_PLACES_URL =
  "https://api.geoapify.com/v2/places";

const KAOHSIUNG_BOUNDS = Object.freeze({
  minLongitude: 120.0,
  minLatitude: 22.45,
  maxLongitude: 120.95,
  maxLatitude: 23.55,
});

const REQUEST_TIMEOUT_MS = 8000;
const AUTOCOMPLETE_LIMIT = 20;
const GEOCODING_LIMIT = 40;
const PLACES_LIMIT = 20;
const PUBLIC_LIMIT = 40;
const MIN_RESULTS_BEFORE_PLACES = 5;
const PLACES_CATEGORIES =
  "catering,commercial.food_and_drink,commercial.marketplace,commercial.shopping_mall,commercial.department_store,entertainment,leisure,tourism,activity.events_venue,beach";
const ALLOWED_CATEGORY_PREFIXES = [
  "catering",
  "commercial.food_and_drink",
  "commercial.marketplace",
  "commercial.shopping_mall",
  "commercial.department_store",
  "entertainment",
  "leisure",
  "tourism",
  "activity.events_venue",
  "beach",
];
const KAOHSIUNG_FILTER =
  "countrycode:tw|rect:120.0,22.45,120.95,23.55";
const KAOHSIUNG_BIAS = "proximity:120.3014,22.6273";
const KAOHSIUNG_DISTRICTS = [
  "鹽埕區",
  "鼓山區",
  "左營區",
  "楠梓區",
  "三民區",
  "新興區",
  "前金區",
  "苓雅區",
  "前鎮區",
  "旗津區",
  "小港區",
  "鳳山區",
  "林園區",
  "大寮區",
  "大樹區",
  "大社區",
  "仁武區",
  "鳥松區",
  "岡山區",
  "橋頭區",
  "燕巢區",
  "田寮區",
  "阿蓮區",
  "路竹區",
  "湖內區",
  "茄萣區",
  "永安區",
  "彌陀區",
  "梓官區",
  "旗山區",
  "美濃區",
  "六龜區",
  "甲仙區",
  "杉林區",
  "內門區",
  "茂林區",
  "桃源區",
  "那瑪夏區",
];

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload, null, 2));
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = REQUEST_TIMEOUT_MS
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

function readQueryParam(req, key) {
  if (
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, key)
  ) {
    const value = req.query[key];

    if (Array.isArray(value)) {
      return value[0] || "";
    }

    return value || "";
  }

  const url = new URL(req.url || "", "http://localhost");

  return url.searchParams.get(key) || "";
}

function validateQuery(value) {
  const query = String(value || "").trim();

  if (query.length < 2 || query.length > 80) {
    return {
      ok: false,
      query,
    };
  }

  return {
    ok: true,
    query,
  };
}

function validateOffset(value) {
  const rawValue = String(value || "0").trim();

  if (!/^\d+$/.test(rawValue)) {
    return {
      ok: false,
      offset: 0,
    };
  }

  const offset = Number(rawValue);

  if (!Number.isSafeInteger(offset) || offset < 0) {
    return {
      ok: false,
      offset: 0,
    };
  }

  if (offset > 0) {
    return {
      ok: false,
      offset,
      unsupported: true,
    };
  }

  return {
    ok: true,
    offset,
  };
}

function buildAutocompleteUrl(query, apiKey) {
  const url = new URL(GEOAPIFY_AUTOCOMPLETE_URL);

  url.search = new URLSearchParams({
    text: query,
    type: "amenity",
    lang: "zh",
    format: "json",
    limit: String(AUTOCOMPLETE_LIMIT),
    filter: KAOHSIUNG_FILTER,
    bias: KAOHSIUNG_BIAS,
    apiKey,
  }).toString();

  return url;
}

function buildGeocodingUrl(query, apiKey) {
  const url = new URL(GEOAPIFY_SEARCH_URL);

  url.search = new URLSearchParams({
    text: query,
    type: "amenity",
    lang: "zh",
    format: "json",
    limit: String(GEOCODING_LIMIT),
    filter: KAOHSIUNG_FILTER,
    bias: KAOHSIUNG_BIAS,
    apiKey,
  }).toString();

  return url;
}

function buildPlacesUrl(query, apiKey) {
  const url = new URL(GEOAPIFY_PLACES_URL);

  url.search = new URLSearchParams({
    apiKey,
    name: query,
    categories: PLACES_CATEGORIES,
    filter: "rect:120.0,22.45,120.95,23.55",
    limit: String(PLACES_LIMIT),
    lang: "zh",
  }).toString();

  return url;
}

function toText(value) {
  return typeof value === "string" ? value : "";
}

function normalizeText(value) {
  return toText(value).normalize("NFKC").trim();
}

function normalizeDedupeText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[.,，。:：;；!！?？'"‘’“”`~、/\\|_\-－—()（）[\]【】{}<>《》]/g, "");
}

function toFiniteNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function readFeatureProperties(feature) {
  if (!feature || typeof feature !== "object") {
    return null;
  }

  if (
    feature.properties &&
    typeof feature.properties === "object"
  ) {
    return feature.properties;
  }

  return null;
}

function readLatitude(properties, feature) {
  const coordinates =
    feature &&
    feature.geometry &&
    Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates
      : [];

  return toFiniteNumber(
    properties.lat ?? coordinates[1]
  );
}

function readLongitude(properties, feature) {
  const coordinates =
    feature &&
    feature.geometry &&
    Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates
      : [];

  return toFiniteNumber(
    properties.lon ?? coordinates[0]
  );
}

function isInsideKaohsiungBounds(latitude, longitude) {
  return (
    latitude >= KAOHSIUNG_BOUNDS.minLatitude &&
    latitude <= KAOHSIUNG_BOUNDS.maxLatitude &&
    longitude >= KAOHSIUNG_BOUNDS.minLongitude &&
    longitude <= KAOHSIUNG_BOUNDS.maxLongitude
  );
}

function isKaohsiungResult(properties) {
  const latitude = toFiniteNumber(properties.lat);
  const longitude = toFiniteNumber(properties.lon);

  if (
    latitude === null ||
    longitude === null ||
    !isInsideKaohsiungBounds(latitude, longitude)
  ) {
    return false;
  }

  const fields = [
    properties.state,
    properties.county,
    properties.city,
    properties.formatted,
    properties.address_line2,
  ];

  return fields.some((value) =>
    normalizeText(value).includes("高雄市")
  );
}

function findKaohsiungDistrict(value) {
  const text = normalizeText(value);

  return (
    KAOHSIUNG_DISTRICTS.find((district) =>
      text.includes(district)
    ) || ""
  );
}

function resolveKaohsiungDistrict(properties) {
  const fields = [
    properties.district,
    properties.city,
    properties.county,
    properties.formatted,
    properties.address_line2,
  ];

  for (const field of fields) {
    const district = findKaohsiungDistrict(field);

    if (district) {
      return district;
    }
  }

  return "其他高雄地區";
}

function isAllowedCategory(category) {
  if (typeof category !== "string") {
    return false;
  }

  return ALLOWED_CATEGORY_PREFIXES.some((prefix) =>
    category === prefix ||
    category.startsWith(`${prefix}.`)
  );
}

function normalizeCategories(properties) {
  let categories = [];

  if (Array.isArray(properties.categories)) {
    categories = properties.categories.filter(
      (category) => typeof category === "string" &&
        isAllowedCategory(category)
    );
  } else if (typeof properties.category === "string") {
    categories = isAllowedCategory(properties.category)
      ? [properties.category]
      : [];
  }

  return categories;
}

function hasAllowedDestinationCategory(categories) {
  return (
    Array.isArray(categories) &&
    categories.some(isAllowedCategory)
  );
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function distanceMeters(a, b) {
  const earthRadiusMeters = 6371000;
  const deltaLatitude = toRadians(b.latitude - a.latitude);
  const deltaLongitude = toRadians(b.longitude - a.longitude);
  const latitude1 = toRadians(a.latitude);
  const latitude2 = toRadians(b.latitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(deltaLongitude / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.asin(Math.sqrt(haversine))
  );
}

function buildAddressKey(item) {
  return normalizeDedupeText(
    item.formatted ||
      `${item.addressLine1}${item.addressLine2}`
  );
}

function isDuplicate(item, accepted) {
  const placeId = normalizeText(item.placeId);
  const nameKey = normalizeDedupeText(item.name);
  const addressKey = buildAddressKey(item);

  return accepted.some((existing) => {
    if (
      placeId &&
      placeId === existing._placeIdKey
    ) {
      return true;
    }

    if (
      !nameKey ||
      nameKey !== existing._nameKey
    ) {
      return false;
    }

    if (
      addressKey &&
      addressKey === existing._addressKey
    ) {
      return true;
    }

    return distanceMeters(item, existing) <= 15;
  });
}

function mergeResults(existing, additions) {
  const accepted = existing.map((item) => ({
    ...item,
    _placeIdKey: normalizeText(item.placeId),
    _nameKey: normalizeDedupeText(item.name),
    _addressKey: buildAddressKey(item),
  }));

  for (const item of additions) {
    if (isDuplicate(item, accepted)) {
      continue;
    }

    accepted.push({
      ...item,
      _placeIdKey: normalizeText(item.placeId),
      _nameKey: normalizeDedupeText(item.name),
      _addressKey: buildAddressKey(item),
    });
  }

  return accepted
    .slice(0, PUBLIC_LIMIT)
    .map((item) => {
      const {
        _placeIdKey,
        _nameKey,
        _addressKey,
        ...publicItem
      } = item;

      return publicItem;
    });
}

function normalizeResult(properties, feature) {
  const latitude = readLatitude(properties, feature);
  const longitude = readLongitude(properties, feature);

  if (
    latitude === null ||
    longitude === null
  ) {
    return null;
  }

  const normalizedProperties = {
    ...properties,
    lat: latitude,
    lon: longitude,
  };

  if (!isKaohsiungResult(normalizedProperties)) {
    return null;
  }

  const categories = normalizeCategories(properties);

  if (!hasAllowedDestinationCategory(categories)) {
    return null;
  }

  return {
    placeId: toText(properties.place_id),
    name: toText(properties.name),
    formatted: toText(properties.formatted),
    addressLine1: toText(properties.address_line1),
    addressLine2: toText(properties.address_line2),
    district: resolveKaohsiungDistrict(properties),
    latitude,
    longitude,
    categories,
  };
}

function normalizeGeocodingResults(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.results)
  ) {
    return null;
  }

  return payload.results
    .map((item) =>
      item && typeof item === "object"
        ? normalizeResult(item, null)
        : null
    )
    .filter(Boolean);
}

function normalizePlacesResults(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.features)
  ) {
    return null;
  }

  return payload.features
    .map((feature) => {
      const properties = readFeatureProperties(feature);

      return properties
        ? normalizeResult(properties, feature)
        : null;
    })
    .filter(Boolean);
}

function logError(type, statusCode) {
  console.error("search-local-places failed", {
    type,
    statusCode: statusCode || null,
  });
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    logError("upstream_status", response.status);
    return {
      ok: false,
      statusCode: 502,
    };
  }

  try {
    return {
      ok: true,
      payload: await response.json(),
    };
  } catch (error) {
    logError("invalid_json");
    return {
      ok: false,
      statusCode: 502,
    };
  }
}

async function fetchGeocodingSource(url) {
  const response = await fetchJson(url);

  if (!response.ok) {
    return response;
  }

  const results = normalizeGeocodingResults(response.payload);

  if (results === null) {
    logError("invalid_payload");
    return {
      ok: false,
      statusCode: 502,
    };
  }

  return {
    ok: true,
    results,
  };
}

async function fetchPlacesSource(url) {
  const response = await fetchJson(url);

  if (!response.ok) {
    return response;
  }

  const results = normalizePlacesResults(response.payload);

  if (results === null) {
    logError("invalid_payload");
    return {
      ok: false,
      statusCode: 502,
    };
  }

  return {
    ok: true,
    results,
  };
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, {
      ok: false,
      message: "HTTP method not supported.",
    });
    return;
  }

  const queryValidation = validateQuery(
    readQueryParam(req, "q")
  );

  if (!queryValidation.ok) {
    sendJson(res, 400, {
      ok: false,
      message: "Invalid search query.",
    });
    return;
  }

  const offsetValidation = validateOffset(
    readQueryParam(req, "offset")
  );

  if (!offsetValidation.ok) {
    sendJson(res, 400, {
      ok: false,
      message: offsetValidation.unsupported
        ? "目前搜尋模式尚未支援載入更多結果。"
        : "Invalid search offset.",
    });
    return;
  }

  const apiKey = process.env.GEOAPIFY_API_KEY;

  if (!apiKey) {
    logError("missing_config");

    sendJson(res, 500, {
      ok: false,
      message: "Missing search configuration.",
    });
    return;
  }

  try {
    let results = [];

    const autocomplete = await fetchGeocodingSource(
      buildAutocompleteUrl(queryValidation.query, apiKey)
    );

    if (!autocomplete.ok) {
      sendJson(res, autocomplete.statusCode, {
        ok: false,
        message: "Local place search failed.",
      });
      return;
    }

    results = mergeResults(results, autocomplete.results);

    const geocoding = await fetchGeocodingSource(
      buildGeocodingUrl(queryValidation.query, apiKey)
    );

    if (!geocoding.ok) {
      sendJson(res, geocoding.statusCode, {
        ok: false,
        message: "Local place search failed.",
      });
      return;
    }

    results = mergeResults(results, geocoding.results);

    if (results.length < MIN_RESULTS_BEFORE_PLACES) {
      const places = await fetchPlacesSource(
        buildPlacesUrl(queryValidation.query, apiKey)
      );

      if (!places.ok) {
        sendJson(res, places.statusCode, {
          ok: false,
          message: "Local place search failed.",
        });
        return;
      }

      results = mergeResults(results, places.results);
    }

    sendJson(res, 200, {
      ok: true,
      query: queryValidation.query,
      offset: 0,
      limit: PUBLIC_LIMIT,
      results,
      hasMore: false,
      nextOffset: null,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      logError("timeout");

      sendJson(res, 504, {
        ok: false,
        message: "Local place search timed out.",
      });
      return;
    }

    logError("network_error");

    sendJson(res, 502, {
      ok: false,
      message: "Local place search failed.",
    });
  }
};

const GEOAPIFY_PLACES_URL =
  "https://api.geoapify.com/v2/places";

const KAOHSIUNG_BOUNDS = Object.freeze({
  minLongitude: 120.0,
  minLatitude: 22.45,
  maxLongitude: 120.95,
  maxLatitude: 23.55,
});

const REQUEST_TIMEOUT_MS = 8000;
const UPSTREAM_LIMIT = 20;
const MAX_OFFSET = 500;
const PLACES_CATEGORIES =
  "catering,commercial.food_and_drink,commercial.marketplace,commercial.shopping_mall,commercial.department_store,entertainment,leisure,tourism,activity.events_venue,beach";

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

  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_OFFSET
  ) {
    return {
      ok: false,
      offset: 0,
    };
  }

  return {
    ok: true,
    offset,
  };
}

function buildGeoapifyUrl(query, offset, apiKey) {
  const url = new URL(GEOAPIFY_PLACES_URL);

  url.search = new URLSearchParams({
    apiKey,
    name: query,
    categories: PLACES_CATEGORIES,
    filter: "rect:120.0,22.45,120.95,23.55",
    limit: String(UPSTREAM_LIMIT),
    offset: String(offset),
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

function dedupeResults(results) {
  const accepted = [];

  for (const item of results) {
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

  return accepted.map((item) => {
    const {
      _placeIdKey,
      _nameKey,
      _addressKey,
      ...publicItem
    } = item;

    return publicItem;
  });
}

function normalizeResult(feature) {
  const properties = readFeatureProperties(feature);

  if (!properties) {
    return null;
  }

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

  return {
    placeId: toText(properties.place_id),
    name: toText(properties.name),
    formatted: toText(properties.formatted),
    addressLine1: toText(properties.address_line1),
    addressLine2: toText(properties.address_line2),
    district:
      toText(properties.district) ||
      toText(properties.city),
    latitude,
    longitude,
    categories: Array.isArray(properties.categories)
      ? properties.categories.filter(
          (category) => typeof category === "string"
        )
      : [],
  };
}

function normalizeResults(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.features)
  ) {
    return null;
  }

  return dedupeResults(
    payload.features
      .map(normalizeResult)
      .filter(Boolean)
  );
}

function logError(type, statusCode) {
  console.error("search-local-places failed", {
    type,
    statusCode: statusCode || null,
  });
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
      message: "Invalid search offset.",
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
    const upstreamUrl = buildGeoapifyUrl(
      queryValidation.query,
      offsetValidation.offset,
      apiKey
    );

    const response = await fetchWithTimeout(
      upstreamUrl,
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

      sendJson(res, 502, {
        ok: false,
        message: "Local place search failed.",
      });
      return;
    }

    let payload;

    try {
      payload = await response.json();
    } catch (error) {
      logError("invalid_json");

      sendJson(res, 502, {
        ok: false,
        message: "Local place search failed.",
      });
      return;
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray(payload.features)
    ) {
      logError("invalid_payload");

      sendJson(res, 502, {
        ok: false,
        message: "Local place search failed.",
      });
      return;
    }

    const results = normalizeResults(payload);

    if (results === null) {
      logError("invalid_payload");

      sendJson(res, 502, {
        ok: false,
        message: "Local place search failed.",
      });
      return;
    }

    const hasMore =
      payload.features.length === UPSTREAM_LIMIT;

    sendJson(res, 200, {
      ok: true,
      query: queryValidation.query,
      offset: offsetValidation.offset,
      limit: UPSTREAM_LIMIT,
      results,
      hasMore,
      nextOffset: hasMore
        ? offsetValidation.offset + payload.features.length
        : null,
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

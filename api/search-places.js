const GEOAPIFY_AUTOCOMPLETE_URL =
  "https://api.geoapify.com/v1/geocode/autocomplete";

const KAOHSIUNG_BOUNDS = Object.freeze({
  minLongitude: 120.0,
  minLatitude: 22.45,
  maxLongitude: 120.95,
  maxLatitude: 23.55,
});

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;

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

function readQuery(req) {
  if (
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, "q")
  ) {
    const value = req.query.q;

    if (Array.isArray(value)) {
      return value[0] || "";
    }

    return value || "";
  }

  const url = new URL(req.url || "", "http://localhost");

  return url.searchParams.get("q") || "";
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

function buildGeoapifyUrl(query, apiKey) {
  const url = new URL(GEOAPIFY_AUTOCOMPLETE_URL);

  url.search = new URLSearchParams({
    text: query,
    apiKey,
    limit: String(MAX_RESULTS),
    lang: "zh",
    format: "json",
    filter: "countrycode:tw|rect:120.0,22.45,120.95,23.55",
    bias: "proximity:120.3014,22.6273",
  }).toString();

  return url;
}

function toText(value) {
  return typeof value === "string" ? value : "";
}

function toFiniteNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function isInsideKaohsiungBounds(latitude, longitude) {
  return (
    latitude >= KAOHSIUNG_BOUNDS.minLatitude &&
    latitude <= KAOHSIUNG_BOUNDS.maxLatitude &&
    longitude >= KAOHSIUNG_BOUNDS.minLongitude &&
    longitude <= KAOHSIUNG_BOUNDS.maxLongitude
  );
}

function normalizeResult(feature) {
  if (!feature || typeof feature !== "object") {
    return null;
  }

  const latitude = toFiniteNumber(feature.lat);
  const longitude = toFiniteNumber(feature.lon);
  const countryCode = toText(feature.country_code).toLowerCase();

  if (
    countryCode !== "tw" ||
    latitude === null ||
    longitude === null ||
    !isInsideKaohsiungBounds(latitude, longitude)
  ) {
    return null;
  }

  return {
    name: toText(feature.name),
    formatted: toText(feature.formatted),
    addressLine1: toText(feature.address_line1),
    addressLine2: toText(feature.address_line2),
    latitude,
    longitude,
    resultType: toText(feature.result_type),
  };
}

function normalizeResults(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.results)
  ) {
    return null;
  }

  return payload.results
    .map(normalizeResult)
    .filter(Boolean)
    .slice(0, MAX_RESULTS);
}

function logError(type, statusCode) {
  console.error("search-places failed", {
    type,
    statusCode: statusCode || null,
  });
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
      message: "HTTP method not supported.",
    });
    return;
  }

  const validation = validateQuery(readQuery(req));

  if (!validation.ok) {
    sendJson(res, 400, {
      ok: false,
      message: "Invalid search query.",
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
      validation.query,
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
        message: "Place search failed.",
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
        message: "Place search failed.",
      });
      return;
    }

    const results = normalizeResults(payload);

    if (results === null) {
      logError("invalid_payload");

      sendJson(res, 502, {
        ok: false,
        message: "Place search failed.",
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      query: validation.query,
      results,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      logError("timeout");

      sendJson(res, 504, {
        ok: false,
        message: "Place search timed out.",
      });
      return;
    }

    logError("network_error");

    sendJson(res, 502, {
      ok: false,
      message: "Place search failed.",
    });
  }
};

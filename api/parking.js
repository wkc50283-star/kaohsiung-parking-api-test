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
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        message: "僅支援 GET 請求",
      })
    );
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const upstream = await fetch(
      "https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLotPost",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "https://kpp.tbkc.gov.tw",
          Referer:
            "https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLocation",
          "User-Agent": "Mozilla/5.0",
        },
        body: new URLSearchParams(),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    const rawText = await upstream.text();

    if (!upstream.ok) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          message: "官方網站有回應，但回傳狀態不是成功",
          upstreamStatus: upstream.status,
          bodyPreview: rawText.slice(0, 300),
        })
      );
      return;
    }

    let data;

    try {
      data = JSON.parse(rawText);
    } catch (parseError) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          message: "官方網站有回應，但內容無法解析為 JSON",
          contentType: upstream.headers.get("content-type"),
          bodyPreview: rawText.slice(0, 300),
        })
      );
      return;
    }

    const parkingLots = Array.isArray(data.parkingLots)
      ? data.parkingLots
      : [];

    const chargingPiles = Array.isArray(data.chargingPiles)
      ? data.chargingPiles
      : [];

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

    res.end(
      JSON.stringify({
        ok: true,
        source: "高雄市政府交通局公有停車場服務資訊網",
        upstreamStatus: upstream.status,
        parkingLots: parkingLots.length,
        chargingPiles: chargingPiles.length,
        sampleParkingLot: parkingLots[0] || null,
      })
    );
  } catch (error) {
    clearTimeout(timeoutId);

    const diagnostic = {
      name: error && error.name ? error.name : "UnknownError",
      message: error && error.message ? error.message : "",
      causeCode:
        error && error.cause && error.cause.code
          ? error.cause.code
          : "",
      causeMessage:
        error && error.cause && error.cause.message
          ? error.cause.message
          : "",
    };

    console.error("Parking upstream request failed:", diagnostic);

    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        message: "Vercel Function 呼叫官方資料失敗",
        diagnostic,
      })
    );
  }
};

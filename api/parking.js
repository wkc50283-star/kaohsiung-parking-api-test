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
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const upstream = await fetch(
      "https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLotPost",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "https://kpp.tbkc.gov.tw",
          Referer:
            "https://kpp.tbkc.gov.tw/ParkingLocation/ParkingLocation",
        },
        body: "",
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!upstream.ok) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          upstreamStatus: upstream.status,
          message: "Vercel 已收到請求，但無法取得高雄市官方停車資料",
        })
      );
      return;
    }

    const data = await upstream.json();
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

    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        message: "Vercel Function 呼叫官方資料失敗",
        error: error && error.name ? error.name : "UnknownError",
      })
    );
  }
};

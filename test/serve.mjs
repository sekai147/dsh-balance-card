/**
 * 预览用的小服务器（仅测试，不随插件发布）。
 *
 * 它扮演 DSH 宿主：把 test/harness 的页面和 lib/client.js 发出去，并按 `?state=` 返回
 * 不同形态的 /api/dsh-balance 载荷，用来核对卡片在各种数据下的样子。
 *
 * 用法：node test/serve.mjs [port]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 7801);
const DAY_MS = 24 * 60 * 60 * 1000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** 北京时间的日历日键。 */
function beijingDay(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function spendDays(now, amounts) {
  return amounts.map((amount, i) => ({
    day: beijingDay(now - i * DAY_MS),
    amount,
    sampled: i !== 4,
  }));
}

const DAY_AMOUNTS = [0.12, 0.0, 0.34, 0.08, 1.2, 0.0, 0.05];

function payload(state, lang) {
  const now = Date.now();
  const dayStart = Date.parse(`${beijingDay(now)}T00:00:00Z`) - 8 * 3600 * 1000;
  const days = spendDays(now, DAY_AMOUNTS);
  const week = Math.round(days.reduce((sum, d) => sum + d.amount, 0) * 100) / 100;

  // 谷时：下一天 09:00 转峰（真实边界）；峰时：截图里想看到「几小时后转谷」，
  // 所以给一个 2 小时 13 分后的合成边界 —— 这个变体只用于看样式，不代表真实时钟。
  const isPeakState = state === "peak";
  const nextAt = isPeakState
    ? now + 2 * 3600 * 1000 + 13 * 60 * 1000
    : dayStart + DAY_MS + 9 * 3600 * 1000;

  const base = {
    ok: true,
    version: "0.1.0",
    now,
    account: {
      ok: true,
      currency: "CNY",
      total: isPeakState ? 46.2 : 48.51,
      granted: 0,
      toppedUp: isPeakState ? 46.2 : 48.51,
      available: true,
    },
    spend: {
      currency: "CNY",
      today: isPeakState ? 1.84 : 0.12,
      yesterday: 0.0,
      week,
      days,
      credits: 0,
      samples: 12,
      since: beijingDay(now - 6 * DAY_MS),
      partial: false,
    },
    window: {
      peak: isPeakState,
      next: { peak: !isPeakState, at: nextAt, ms: nextAt - now },
      windows: [[9, 12], [14, 18]],
      holidayCovered: true,
      coverageYear: 2026,
    },
    price: isPeakState
      ? { model: "deepseek-flash", requested: "deepseek-flash", window: "peak", input: 2, cacheRead: 0.04, output: 8, standardInput: 2, standardOutput: 8 }
      : { model: "deepseek-flash", requested: "deepseek-flash", window: "idle", input: 1, cacheRead: 0.02, output: 4, standardInput: 2, standardOutput: 8 },
  };

  if (state === "error") {
    base.account = {
      ok: false,
      code: "noKey",
      message: lang === "en" ? "DEEPSEEK_API_KEY is not configured" : "未配置 DEEPSEEK_API_KEY",
      currency: null,
      total: null,
    };
  }
  return base;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/api/dsh-balance") {
    const state = url.searchParams.get("state") || "ok";
    const lang = url.searchParams.get("lang") === "en" ? "en" : "zh";
    const body = JSON.stringify(payload(state, lang));
    res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
    res.end(body);
    return;
  }

  let file;
  if (url.pathname === "/" || url.pathname === "/index.html") file = path.join(ROOT, "harness", "index.html");
  else if (url.pathname === "/harness/shim.js" || url.pathname === "/harness/boot.js") file = path.join(ROOT, url.pathname);
  else if (url.pathname === "/lib/client.js") file = path.join(ROOT, "..", "lib", "client.js");
  else {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  try {
    const text = await readFile(file, "utf8");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`read failed: ${String(error)}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`preview: http://127.0.0.1:${PORT}/?state=ok`);
});

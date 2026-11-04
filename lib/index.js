/**
 * dsh-balance-card — 宿主半边。
 *
 * 职责只有一件：把"用户看得懂的三个数"准备好，交给浏览器半边去画。
 *   · DeepSeek 余额 —— 官方 `GET https://api.deepseek.com/user/balance`，API Key 走
 *     DSH 凭据服务（本文件不落盘、不打印任何密钥）；
 *   · 近日消耗 —— 余额快照账本：同一天内余额的每一次下降累加为消耗，上升记为充值
 *     （充值不算消耗）。账本落在 $DSH_HOME/dsh-balance-card.json，只保留 30 天日汇总，
 *     不做逐次采样堆积；
 *   · 峰谷时段与倒计时 —— 纯本地推算（北京时间工作日 09:00–12:00、14:00–18:00 为峰，
 *     周末与中国法定节假日全天为谷），不依赖网络。
 *
 * 路由：`GET /api/dsh-balance`，仅本机可读。
 */

import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export const name = "dsh-balance-card";
export const inject = ["credentials", "webServer"];

const VERSION = "0.1.0";
const ROUTE_PATH = "/api/dsh-balance";
const API_KEY_REF = "DEEPSEEK_API_KEY";
/** DSH 账号登录的 grant 记录键（宿主写入时用的字面量，逐字相同）。 */
const ACCOUNT_GRANT_KEY = "deepseek-account-platform/default";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;
/** 余额接口缓存：侧栏心跳 + 多标签页会重复打上游，10 秒内合并成一次。 */
const CACHE_MS = 10_000;
/** 账本采样间隔：余额变动很慢，一分钟一次足够，也让每日翻转的归属误差 < 1 分钟。 */
const SAMPLE_MS = 60_000;
/** 两次采样间隔超过它就不再归因（见 observeBalance 的 continuous 判定）。 */
const GAP_MS = 3 * 60 * 60 * 1000;
const KEEP_DAYS = 30;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

//#region 峰谷时刻表

/**
 * DeepSeek 官方分时计价口径（北京时间）：
 *   工作日 09:00–12:00、14:00–18:00 为高峰，其余时间为谷时；
 *   周末与中国法定节假日全天为谷时。
 */
const PEAK_WINDOWS = [
  [9, 12],
  [14, 18],
];

/** 中国法定节假日放假日期（闭区间，北京时间日历日，2026 年国务院办公厅安排）。 */
const HOLIDAY_RANGES = [
  ["2026-01-01", "2026-01-03"], // 元旦
  ["2026-02-15", "2026-02-23"], // 春节
  ["2026-04-04", "2026-04-06"], // 清明
  ["2026-05-01", "2026-05-05"], // 劳动节
  ["2026-06-19", "2026-06-21"], // 端午
  ["2026-09-25", "2026-09-27"], // 中秋
  ["2026-10-01", "2026-10-07"], // 国庆
];

/** 内置节假日表覆盖到的年份（含）；跨年时需要更新。 */
const HOLIDAY_TABLE_THROUGH_YEAR = 2026;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 把 [起, 止] 闭区间展开成日期键集合。
 * 先用回读校验日期合法性：`2027-02-30` 会被 Date.parse 滚到 03-02，不能让它变成假日。
 */
function expandHolidayRanges(ranges) {
  const set = new Set();
  for (const [from, to] of ranges) {
    if (typeof from !== "string" || typeof to !== "string") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    if (new Date(start).toISOString().slice(0, 10) !== from) continue;
    if (new Date(end).toISOString().slice(0, 10) !== to) continue;
    for (let t = start; t <= end; t += DAY_MS) set.add(new Date(t).toISOString().slice(0, 10));
  }
  return set;
}

const HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

/** 某时刻在北京时间下的钟点、星期、日期键与当日零点。 */
function scheduleParts(ms) {
  const local = new Date(ms + SHANGHAI_OFFSET_MS);
  const dateKey = local.toISOString().slice(0, 10);
  return {
    hour: local.getUTCHours(),
    dow: local.getUTCDay(),
    dateKey,
    dayStart: Date.parse(`${dateKey}T00:00:00Z`) - SHANGHAI_OFFSET_MS,
  };
}

/** 北京时间日历日键（账本按它分日）。 */
function beijingDay(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 某时刻是否处于高峰计价。 */
function isPeak(ms) {
  const { hour, dow, dateKey } = scheduleParts(ms);
  if (HOLIDAY_DAYS.has(dateKey)) return false;
  if (dow === 0 || dow === 6) return false;
  return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end);
}

/**
 * 距下一次峰谷翻转的剩余时间。
 *
 * 谷时的下一次切换**不是**下一个整点：12:00–14:00 午休要等到 14:00，周五 18:00 之后
 * 要等到下周一 09:00（春节这类长假期更久），所以这里逐日推进并给 32 天上限。
 * @returns {{ peak: boolean, at: number|null, ms: number }} peak = 切换后进入的一侧。
 */
function nextChange(ms) {
  const current = isPeak(ms);
  const hours = [...new Set(PEAK_WINDOWS.flat())].sort((a, b) => a - b);
  const { dayStart } = scheduleParts(ms);
  for (let day = 0; day < 32; day += 1) {
    for (const hour of hours) {
      const at = dayStart + day * DAY_MS + hour * 60 * 60 * 1000;
      if (at <= ms) continue;
      if (isPeak(at) !== current) return { peak: !current, at, ms: at - ms };
    }
  }
  return { peak: !current, at: null, ms: 0 };
}

//#endregion

//#region 单价表（仅用于展开面板的一行"此刻单价"，不影响余额与消耗）

const PRICES = {
  "deepseek-flash": {
    standard: { input: 2, cacheRead: 0.04, output: 8 },
    offPeak: { input: 1, cacheRead: 0.02, output: 4 },
  },
  "deepseek-v4-pro": {
    standard: { input: 9, cacheRead: 0.3, output: 27 },
    offPeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
  },
  "deepseek-chat": { standard: { input: 2, cacheRead: 0.5, output: 8 } },
  "deepseek-reasoner": { standard: { input: 4, cacheRead: 1, output: 16 } },
};

const MODEL_ALIASES = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

function priceQuote(model, peak) {
  const raw = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (raw === "") return null;
  const id = Object.prototype.hasOwnProperty.call(MODEL_ALIASES, raw) ? MODEL_ALIASES[raw] : raw;
  if (!Object.prototype.hasOwnProperty.call(PRICES, id)) return null;
  const entry = PRICES[id];
  const tier = !peak && entry.offPeak ? entry.offPeak : entry.standard;
  return {
    model: id,
    requested: raw,
    window: entry.offPeak ? (peak ? "peak" : "idle") : null,
    input: tier.input,
    cacheRead: tier.cacheRead ?? null,
    output: tier.output,
    standardInput: entry.standard.input,
    standardOutput: entry.standard.output,
  };
}

//#endregion

//#region 余额账本（近日消耗）

const SCALE = 1_000_000;

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return path.join(os.homedir(), ".dsh");
}

function ledgerPath() {
  return path.join(dshHome(), "dsh-balance-card.json");
}

function emptyLedger() {
  return { version: 1, books: {} };
}

function numberOrNull(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 读账本；文件缺失/损坏/形状不认识时回到空账本，不让插件因历史数据起不来。 */
async function loadLedger() {
  let raw;
  try {
    raw = await readFile(ledgerPath(), "utf8");
  } catch {
    return emptyLedger();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.books !== "object" || parsed.books === null) {
      return emptyLedger();
    }
    return parsed;
  } catch {
    return emptyLedger();
  }
}

let writeChain = Promise.resolve();

/** 原子写账本（tmp + rename），并串行化并发刷新，避免两个标签页互相覆盖。 */
function saveLedger(ledger) {
  writeChain = writeChain.then(async () => {
    const file = ledgerPath();
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  }).catch(() => { /* 账本写不进去不影响读数：本次内存态仍然有效 */ });
  return writeChain;
}

/** 账本里某币种的书；不存在时建一本。 */
function bookOf(ledger, currency) {
  ledger.books ||= {};
  let book = ledger.books[currency];
  if (!book || typeof book !== "object" || typeof book.days !== "object" || book.days === null) {
    book = { currency, lastAt: 0, lastUnits: null, days: {} };
    ledger.books[currency] = book;
  }
  return book;
}

function dayRowOf(book, day, openingUnits) {
  let row = book.days[day];
  if (!row || typeof row !== "object") {
    row = {
      day,
      openingUnits,
      lastUnits: openingUnits,
      spendUnits: 0,
      creditUnits: 0,
      samples: 0,
    };
    book.days[day] = row;
  }
  return row;
}

/** 只保留最近 KEEP_DAYS 天的日行，按日期键排序裁剪。 */
function pruneDays(book) {
  const keys = Object.keys(book.days).sort();
  if (keys.length <= KEEP_DAYS) return;
  for (const key of keys.slice(0, keys.length - KEEP_DAYS)) delete book.days[key];
}

/**
 * 记一次余额快照。
 *
 * 消耗 = 同一天内余额下降的累加；充值（余额上升）只记在 creditUnits 里，不抵扣消耗。
 * 乱序/重复采样直接丢弃（`at <= lastAt`），否则一次慢响应会把消耗算成负数。
 */
function observeBalance(ledger, snapshot) {
  const at = Number(snapshot.at);
  const units = Math.round(Number(snapshot.balance) * SCALE);
  const currency = typeof snapshot.currency === "string" && /^[A-Z]{3}$/.test(snapshot.currency) ? snapshot.currency : "CNY";
  if (!Number.isFinite(at) || !Number.isFinite(units)) return;
  const book = bookOf(ledger, currency);
  if (book.lastAt && at <= book.lastAt) return;

  const day = beijingDay(at);
  const previous = Number.isFinite(book.lastUnits) ? book.lastUnits : null;
  const previousAt = Number(book.lastAt) || 0;
  // 采样断了很久（关掉界面、机器睡眠）时，这段跌幅归不到任何一天：
  // 记到"今天"会把几天的消耗一次性堆上去，宁可丢掉也不误报。
  const continuous = previous !== null && previousAt > 0 && at - previousAt <= GAP_MS;
  const row = dayRowOf(book, day, previous === null ? units : previous);
  if (continuous) {
    const delta = previous - units;
    if (delta > 0) row.spendUnits += delta;
    else if (delta < 0) row.creditUnits += -delta;
  }
  row.lastUnits = units;
  row.samples += 1;
  book.lastAt = at;
  book.lastUnits = units;
  pruneDays(book);
}

/** 账本 → 界面用的"近日消耗"视图。 */
function spendView(ledger, now) {
  const currency = Object.keys(ledger.books || {}).find((key) => ledger.books[key]?.days && Object.keys(ledger.books[key].days).length > 0) ?? null;
  const book = currency ? ledger.books[currency] : null;
  const today = beijingDay(now);
  const yesterday = beijingDay(now - DAY_MS);
  const money = (units) => Math.round(Number(units) || 0) / SCALE;
  const rowOf = (day) => (book && book.days[day]) || null;

  const todayRow = rowOf(today);
  const yesterdayRow = rowOf(yesterday);

  // 近 7 天：从今天往回排，缺失的日子补 0（用户要的是"这几天花了多少"，不是"哪几天有采样"）。
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = beijingDay(now - i * DAY_MS);
    const row = rowOf(day);
    days.push({ day, amount: row ? money(row.spendUnits) : 0, sampled: row !== null });
  }

  const keys = book ? Object.keys(book.days).sort() : [];
  return {
    currency,
    today: todayRow ? money(todayRow.spendUnits) : 0,
    yesterday: yesterdayRow ? money(yesterdayRow.spendUnits) : 0,
    week: Math.round(days.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
    days,
    credits: todayRow ? money(todayRow.creditUnits) : 0,
    samples: todayRow ? todayRow.samples : 0,
    since: keys[0] ?? null,
    // 今天还没有第二次采样时，"今日消耗"只覆盖了已观测到的那一小段。
    partial: !!todayRow && todayRow.samples < 2,
  };
}

//#endregion

//#region 余额查询

const MESSAGES = {
  zh: {
    noKey: "未配置 DEEPSEEK_API_KEY",
    badKey: "DEEPSEEK_API_KEY 含有非法字符",
    http: (status) => `余额接口 HTTP ${status}`,
    timeout: "余额接口超时",
    network: "余额接口无法连接",
    payload: "余额接口返回了无法解析的内容",
    empty: "余额接口没有返回余额",
    unavailable: "账户当前不可用",
    forbidden: "仅允许本机访问",
    method: "仅支持 GET",
    internal: "插件内部错误",
  },
  en: {
    noKey: "DEEPSEEK_API_KEY is not configured",
    badKey: "DEEPSEEK_API_KEY contains invalid characters",
    http: (status) => `Balance API HTTP ${status}`,
    timeout: "Balance API timed out",
    network: "Balance API is unreachable",
    payload: "Balance API returned an unreadable response",
    empty: "Balance API returned no balance",
    unavailable: "The account is currently unavailable",
    forbidden: "Local access only",
    method: "GET only",
    internal: "Internal plugin error",
  },
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function sendJson(res, status, body) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** HTTP 头值只允许可见 ASCII；多行凭据值会被 undici 连消息一起塞进异常。 */
function isUsableKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (key === "") return false;
  return /^[\x21-\x7e]+$/.test(key);
}

async function resolveApiKey(ctx) {
  let hit;
  try {
    hit = await ctx.credentials.resolve(API_KEY_REF);
  } catch {
    return { ok: false, code: "noKey" };
  }
  const value = typeof hit?.value === "string" ? hit.value.trim() : "";
  if (value === "") return { ok: false, code: "noKey" };
  if (!isUsableKey(value)) return { ok: false, code: "badKey" };
  return { ok: true, value };
}

/**
 * DSH 账号登录（provider `deepseek-account`）留在凭据服务里的 grant 记录。
 *
 * 它和 API Key 查的是同一笔余额，但请求头不同：grant 用 `x-dsh-auth-token`
 * （Bearer 会被上游拒掉），令牌在 `record.payload.token`。用户只登录账号、没配
 * API Key 时，这是唯一的取数路径。
 */
async function resolveAccountGrant(ctx) {
  const readRecord = ctx.credentials?.readRecord;
  if (typeof readRecord !== "function") return null;
  let record;
  try {
    record = await readRecord.call(ctx.credentials, ACCOUNT_GRANT_KEY);
  } catch {
    return null;
  }
  const token = typeof record?.payload?.token === "string" ? record.payload.token.trim() : "";
  return isUsableKey(token) ? token : null;
}

/** 可用的凭据尝试序列：API Key 优先，其次账号 grant。 */
async function resolveAuth(ctx) {
  const attempts = [];
  const key = await resolveApiKey(ctx);
  if (key.ok) attempts.push({ via: "api-key", headers: { authorization: `Bearer ${key.value}` } });
  const grant = await resolveAccountGrant(ctx);
  if (grant !== null) attempts.push({ via: "account", headers: { "x-dsh-auth-token": grant } });
  return { attempts, keyCode: key.ok ? null : key.code };
}

/** 读响应体，超过上限视同"无法解析"。 */
async function readBoundedText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("payload");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("payload");
  return text;
}

/** 解析官方余额响应：`{ is_available, balance_infos: [{ currency, total_balance, ... }] }`。 */
function parseBalance(body) {
  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const first = infos.find((item) => item && numberOrNull(item.total_balance) !== null) ?? null;
  if (first === null) return null;
  const total = numberOrNull(first.total_balance);
  if (total === null) return null;
  return {
    available: body?.is_available !== false,
    currency: typeof first.currency === "string" && first.currency.trim() !== "" ? first.currency.trim().toUpperCase() : "CNY",
    total,
    granted: numberOrNull(first.granted_balance),
    toppedUp: numberOrNull(first.topped_up_balance),
  };
}

let balanceCache = { at: 0, result: null };
let balancePending = null;

/** 发一次余额请求；返回解析后的结果或失败分类。 */
async function fetchBalanceVia(attempt) {
  let response;
  try {
    response = await fetch(BALANCE_URL, {
      method: "GET",
      headers: { ...attempt.headers, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { ok: false, code: timedOut ? "timeout" : "network" };
  }
  if (!response.ok) return { ok: false, code: "http", status: response.status };
  let body;
  try {
    body = JSON.parse(await readBoundedText(response));
  } catch {
    return { ok: false, code: "payload" };
  }
  const parsed = parseBalance(body);
  if (parsed === null) return { ok: false, code: "empty" };
  if (!parsed.available) return { ok: false, code: "unavailable", ...parsed };
  return { ok: true, ...parsed };
}

/**
 * 查一次余额（带 10 秒合并缓存与单飞并发控制）。
 *
 * 两条凭据查的是同一笔余额：先用 API Key，被上游拒掉（401/403）再换账号 grant。
 * 网络错误不换凭据——换一条也一样连不上。
 */
function readBalance(ctx, now) {
  if (balanceCache.result && now - balanceCache.at < CACHE_MS) return Promise.resolve(balanceCache.result);
  if (balancePending) return balancePending;
  balancePending = (async () => {
    const { attempts, keyCode } = await resolveAuth(ctx);
    if (attempts.length === 0) return { ok: false, code: keyCode ?? "noKey" };
    let last = null;
    for (const attempt of attempts) {
      const result = await fetchBalanceVia(attempt);
      if (result.ok) return { ...result, auth: attempt.via };
      last = result;
      const rejected = result.code === "http" && (result.status === 401 || result.status === 403);
      if (!rejected) return result;
    }
    return last ?? { ok: false, code: "noKey" };
  })().then((result) => {
    balanceCache = { at: Date.now(), result };
    return result;
  }).finally(() => {
    balancePending = null;
  });
  return balancePending;
}

//#endregion

//#region 本机栅栏

function hostNameOf(authority) {
  let host = authority.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return null;
    return host.slice(1, end);
  }
  const idx = host.lastIndexOf(":");
  if (idx !== -1 && host.indexOf(":") === idx) host = host.slice(0, idx);
  return host === "" ? null : host;
}

/** Host 必须是本机（回环或监听器绑定地址），挡掉 DNS rebinding 与局域网直连。 */
function isLocalHost(req, bindHost) {
  const raw = req.headers.host;
  if (typeof raw !== "string" || raw === "") return false;
  const host = hostNameOf(raw);
  if (host === null) return false;
  if (host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (typeof bindHost === "string" && bindHost !== "") {
    const bind = hostNameOf(bindHost);
    if (bind !== null && bind !== "" && host === bind) return true;
  }
  return false;
}

/** 跨站读取一律拒绝；带 Origin 时必须与 Host 同 authority。 */
function isTrustedRequest(req, bindHost) {
  if (!isLocalHost(req, bindHost)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (originHost !== String(req.headers.host ?? "").toLowerCase()) return false;
  }
  return true;
}

/** 解析 `?lang=`（默认 zh）。 */
function resolveLang(req) {
  const url = typeof req.url === "string" ? req.url : "";
  const q = url.indexOf("?");
  if (q === -1) return "zh";
  return /(^|&)lang=en(-[A-Za-z]+)?(&|$)/.test(url.slice(q + 1)) ? "en" : "zh";
}

/** 把失败分类映射成用户能据以行动的一句话（不透出上游原文）。 */
function accountMessage(msg, result) {
  switch (result.code) {
    case "noKey": return msg.noKey;
    case "badKey": return msg.badKey;
    case "http": return msg.http(result.status ?? 0);
    case "timeout": return msg.timeout;
    case "network": return msg.network;
    case "payload": return msg.payload;
    case "empty": return msg.empty;
    case "unavailable": return msg.unavailable;
    default: return msg.internal;
  }
}

//#endregion

export function apply(ctx) {
  const bindHost = typeof ctx.webServer?.host === "string" ? ctx.webServer.host : "";
  const logger = ctx.logger;
  let lastSampleAt = 0;

  /** 组装一次完整快照：账户 + 消耗 + 峰谷。余额失败也要给峰谷，卡片不至于整块空掉。 */
  async function buildSnapshot(lang) {
    const msg = MESSAGES[lang] ?? MESSAGES.zh;
    // 时刻在余额请求之后再取：请求可能跨过峰谷边界，先取会让"峰谷灯"与"倒计时"打架。
    const requested = Date.now();
    const balance = await readBalance(ctx, requested);
    const now = Date.now();

    let ledger = await loadLedger();
    let account;
    if (balance.ok) {
      if (now - lastSampleAt >= SAMPLE_MS || lastSampleAt === 0) {
        lastSampleAt = now;
        observeBalance(ledger, { at: now, balance: balance.total, currency: balance.currency });
        await saveLedger(ledger);
        ledger = await loadLedger();
      }
      account = {
        ok: true,
        currency: balance.currency,
        total: balance.total,
        granted: balance.granted,
        toppedUp: balance.toppedUp,
        available: balance.available !== false,
        auth: balance.auth ?? null,
      };
    } else {
      account = {
        ok: false,
        code: balance.code,
        message: accountMessage(msg, balance),
        currency: balance.currency ?? null,
        total: numberOrNull(balance.total),
      };
    }

    const peak = isPeak(now);
    const next = nextChange(now);

    let model = "";
    try {
      const adm = ctx.get("agentDefaultModel");
      const selection = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
      if (selection && typeof selection.model === "string") model = selection.model;
    } catch { /* 取不到模型就不显示单价，不影响余额与倒计时 */ }

    const coverageYear = new Date(now + SHANGHAI_OFFSET_MS).getUTCFullYear();

    return {
      ok: true,
      version: VERSION,
      now,
      account,
      spend: spendView(ledger, now),
      window: {
        peak,
        next,
        windows: PEAK_WINDOWS,
        holidayCovered: coverageYear <= HOLIDAY_TABLE_THROUGH_YEAR,
        coverageYear,
      },
      price: priceQuote(model, peak),
    };
  }

  const register = () => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (req, res) => {
      const lang = resolveLang(req);
      const msg = MESSAGES[lang] ?? MESSAGES.zh;
      try {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "method", message: msg.method });
        }
        if (!isTrustedRequest(req, bindHost)) {
          return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
        }
        sendJson(res, 200, await buildSnapshot(lang));
      } catch (error) {
        try {
          logger?.warn?.(`dsh-balance-card: ${String(error?.stack ?? error)}`);
        } catch { /* 日志失败不影响响应 */ }
        sendJson(res, 500, { ok: false, error: "internal", message: msg.internal });
      }
    },
  });

  if (typeof ctx.effect === "function") ctx.effect(register, "dsh-balance-card: balance route");
  else register();
}

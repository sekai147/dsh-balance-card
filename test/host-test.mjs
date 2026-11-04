/**
 * 宿主半边的端到端测试：不碰 React、不碰真网络。
 *
 * 用一个假 ctx 把 apply() 跑起来，拿到它注册的 HTTP handler，然后像浏览器那样发请求。
 * 覆盖四件容易出错的事：
 *   1. 峰谷判定与倒计时（含午休、周末、节假日、跨天）；
 *   2. 余额快照账本（消耗累加、充值不计消耗、采样断档不归因、跨日归零）；
 *   3. 余额接口失败时仍然给出峰谷（卡片不能整块空掉）；
 *   4. 本机栅栏（Host / Origin / 方法）。
 *
 * 两个隐式约束，写用例时必须照顾：
 *   · 宿主内部的余额缓存按「时间差」判断新鲜度 → 用例时间必须单调递增，否则读到旧值；
 *   · 每次请求都会顺带记一笔余额快照 → 想测「采样断档」，就必须真的隔 3 小时以上没请求，
 *     所以账本用例单独用一个干净的 DSH_HOME，放在所有其它用例之后。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOMES = [];
async function freshHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-balance-card-test-"));
  HOMES.push(dir);
  process.env.DSH_HOME = dir;
  return dir;
}

await freshHome();
const { apply } = await import("../lib/index.js");

//#region 时间与网络的替身

let now = Date.parse("2026-10-02T10:00:00+08:00");
const realNow = Date.now;
Date.now = () => now;

/** 余额接口替身：队列多于 1 个就依次取，否则一直用最后一个。 */
let queue = [48.51];
let fetchMode = "ok";
let lastHeaders = null;
globalThis.fetch = async (url, options) => {
  lastHeaders = (options && options.headers) || null;
  if (fetchMode === "throw") throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
  if (fetchMode === "http401") return { ok: false, status: 401, headers: { get: () => null }, text: async () => "" };
  const total = queue.length > 1 ? queue.shift() : queue[0];
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: total.toFixed(2), granted_balance: "0.00", topped_up_balance: total.toFixed(2) }],
    }),
  };
};

//#endregion

//#region 假 ctx / 假 req-res

let handler = null;
const ctx = {
  credentials: { resolve: async () => ({ value: "sk-test-key" }) },
  webServer: {
    host: "127.0.0.1",
    register: (route) => {
      assert.equal(route.kind, "exact");
      assert.equal(route.path, "/api/dsh-balance");
      handler = route.handler;
      return () => {};
    },
  },
  effect: (fn) => { fn(); },
  get: () => undefined,
  logger: { warn: () => {} },
};

apply(ctx);
assert.equal(typeof handler, "function", "apply() 必须注册路由");

async function call({ method = "GET", host = "127.0.0.1:64096", origin, lang } = {}) {
  const headers = { host };
  if (origin) headers.origin = origin;
  const req = { method, url: lang ? `/api/dsh-balance?lang=${lang}` : "/api/dsh-balance", headers };
  let status = 0;
  let body = "";
  const res = {
    headersSent: false,
    writeHead(code) { status = code; res.headersSent = true; },
    end(chunk) { body = chunk || ""; },
  };
  await handler(req, res);
  return { status, body: body === "" ? null : JSON.parse(body) };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error && error.message) });
  }
}

function at(iso) { now = Date.parse(iso); }

/** 断言峰谷与下一次翻转时刻（都用北京时间字符串表达，读起来和人脑一致）。 */
async function expectWindow(label, iso, expectPeak, expectNextISO) {
  at(iso);
  queue = [48.51];
  fetchMode = "ok";
  const { status, body } = await call({ lang: "zh" });
  check(label, () => {
    assert.equal(status, 200);
    assert.equal(body.window.peak, expectPeak, "峰谷判错");
    assert.equal(new Date(body.window.next.at).toISOString(), new Date(expectNextISO).toISOString(), "翻转时刻判错");
    assert.equal(body.window.next.peak, !expectPeak, "next.peak 应为翻转后进入的一侧");
    assert.ok(body.window.next.ms > 0);
    assert.equal(body.window.next.ms, body.window.next.at - body.now, "ms 必须等于 at - now");
  });
}

//#endregion

//#region 1. 峰谷与倒计时（时间单调递增，余额恒定 48.51，不关心账本）

await expectWindow("国庆 10-02 10:00 谷 → 10-08 09:00 峰", "2026-10-02T10:00:00+08:00", false, "2026-10-08T09:00:00+08:00");
await expectWindow("周三 10:00 峰 → 12:00 谷", "2026-11-04T10:00:00+08:00", true, "2026-11-04T12:00:00+08:00");
await expectWindow("周三 12:30 午休谷 → 14:00 峰", "2026-11-04T12:30:00+08:00", false, "2026-11-04T14:00:00+08:00");
await expectWindow("周三 17:30 峰尾 → 18:00 谷", "2026-11-04T17:30:00+08:00", true, "2026-11-04T18:00:00+08:00");
await expectWindow("周三 19:36 谷 → 次日 09:00 峰", "2026-11-04T19:36:00+08:00", false, "2026-11-05T09:00:00+08:00");
await expectWindow("周五 20:00 谷 → 下周一 09:00 峰", "2026-11-06T20:00:00+08:00", false, "2026-11-09T09:00:00+08:00");
await expectWindow("周六 10:00 谷 → 下周一 09:00 峰", "2026-11-07T10:00:00+08:00", false, "2026-11-09T09:00:00+08:00");

const coverage = await call();
check("节假日表覆盖到 2026（holidayCovered=true）", () => {
  assert.equal(coverage.body.window.holidayCovered, true);
  assert.equal(coverage.body.window.coverageYear, 2026);
});

//#endregion

//#region 2. 余额接口失败

at("2026-11-07T11:00:00+08:00");
fetchMode = "throw";
const err1 = await call({ lang: "zh" });
check("网络失败：account.ok=false 但峰谷照旧", () => {
  assert.equal(err1.status, 200);
  assert.equal(err1.body.account.ok, false);
  assert.equal(err1.body.account.code, "network");
  assert.equal(err1.body.account.message, "余额接口无法连接");
  assert.equal(err1.body.window.peak, false);
  assert.ok(err1.body.window.next.at > 0);
  assert.equal(typeof err1.body.spend.today, "number");
});

at("2026-11-07T11:01:00+08:00");
fetchMode = "http401";
const err2 = await call({ lang: "en" });
check("HTTP 失败：按 lang 给英文文案", () => {
  assert.equal(err2.body.account.ok, false);
  assert.equal(err2.body.account.code, "http");
  assert.equal(err2.body.account.message, "Balance API HTTP 401");
});

//#endregion

//#region 3. 本机栅栏

at("2026-11-07T11:02:00+08:00");
fetchMode = "ok";
queue = [48.51];

const bad = await call({ host: "evil.example.com" });
check("非本机 Host → 403", () => {
  assert.equal(bad.status, 403);
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error, "forbidden");
});

const cross = await call({ origin: "http://localhost:1234" });
check("Origin 与 Host 不一致 → 403", () => {
  assert.equal(cross.status, 403);
});

const same = await call({ host: "localhost:64096", origin: "http://localhost:64096" });
check("同 authority 的 Origin → 200", () => {
  assert.equal(same.status, 200);
});

const post = await call({ method: "POST" });
check("POST → 405", () => {
  assert.equal(post.status, 405);
  assert.equal(post.body.error, "method");
});

const localhost = await call({ host: "localhost:64096" });
check("localhost Host → 200", () => {
  assert.equal(localhost.status, 200);
});

//#endregion

//#region 4. 载荷形状（客户端依赖的字段一个都不能少）

at("2026-11-07T11:03:00+08:00");
const shaped = await call({ lang: "zh" });
check("载荷字段齐全", () => {
  const b = shaped.body;
  assert.equal(b.ok, true);
  assert.equal(b.version, "0.1.0");
  assert.equal(typeof b.now, "number");
  assert.equal(typeof b.account.ok, "boolean");
  assert.equal(typeof b.account.currency, "string");
  assert.equal(typeof b.account.total, "number");
  assert.equal(typeof b.spend.today, "number");
  assert.equal(typeof b.spend.yesterday, "number");
  assert.equal(typeof b.spend.week, "number");
  assert.equal(b.spend.days.length, 7);
  for (const d of b.spend.days) {
    assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof d.amount, "number");
    assert.equal(typeof d.sampled, "boolean");
  }
  assert.equal(typeof b.window.peak, "boolean");
  assert.equal(typeof b.window.next.at, "number");
  assert.equal(typeof b.window.next.ms, "number");
  assert.equal(typeof b.window.next.peak, "boolean");
  assert.deepEqual(b.window.windows, [[9, 12], [14, 18]]);
  assert.equal(b.price, null, "取不到当前模型时 price 应为 null 而不是抛错");
});

//#endregion

//#region 4b. 双凭据：API Key 不在时回退账号 grant（provider deepseek-account 的常态）

at("2026-11-07T11:04:00+08:00");
const savedResolve = ctx.credentials.resolve;
ctx.credentials.resolve = async () => null;
ctx.credentials.readRecord = async () => ({ payload: { token: "grant-token-xyz" } });
queue = [48.51];
fetchMode = "ok";
const viaGrant = await call({ lang: "zh" });
check("没有 API Key 时回退账号 grant，并用 x-dsh-auth-token 头", () => {
  assert.equal(viaGrant.body.account.ok, true);
  assert.equal(viaGrant.body.account.auth, "account");
  assert.equal(lastHeaders["x-dsh-auth-token"], "grant-token-xyz");
  assert.equal(lastHeaders.authorization, undefined);
});

at("2026-11-07T11:05:00+08:00");
ctx.credentials.resolve = async () => ({ value: "" });
delete ctx.credentials.readRecord;
const noAuth = await call({ lang: "zh" });
check("两条凭据都没有 → noKey", () => {
  assert.equal(noAuth.body.account.ok, false);
  assert.equal(noAuth.body.account.code, "noKey");
  assert.equal(noAuth.body.account.message, "未配置 DEEPSEEK_API_KEY");
  assert.equal(typeof noAuth.body.window.next.ms, "number");
});

at("2026-11-07T11:06:00+08:00");
ctx.credentials.resolve = async () => ({ value: "sk-test-key" });
queue = [48.51];
const backToKey = await call({ lang: "zh" });
check("恢复 API Key 后重新走 api-key 分支", () => {
  assert.equal(backToKey.body.account.ok, true);
  assert.equal(backToKey.body.account.auth, "api-key");
  assert.equal(lastHeaders.authorization, "Bearer sk-test-key");
});

//#endregion

//#region 5. 余额快照账本（换一个干净的 DSH_HOME，时间接在最后）

await freshHome();
queue = [50.0];
fetchMode = "ok";

at("2026-11-07T12:00:00+08:00");
const res1 = await call();
check("首次采样：今日消耗 0，标记 partial", () => {
  assert.equal(res1.body.account.ok, true);
  assert.equal(res1.body.account.total, 50);
  assert.equal(res1.body.spend.today, 0);
  assert.equal(res1.body.spend.partial, true);
});

at("2026-11-07T12:01:05+08:00");
queue = [49.9];
const res2 = await call();
check("余额下降 0.10 记为今日消耗", () => {
  assert.equal(res2.body.spend.today, 0.1);
  assert.equal(res2.body.spend.partial, false);
});

at("2026-11-07T12:02:10+08:00");
queue = [49.8];
const res3 = await call();
check("再次下降累加到 0.20", () => {
  assert.equal(res3.body.spend.today, 0.2);
  assert.equal(res3.body.spend.days[0].day, "2026-11-07");
  assert.equal(res3.body.spend.days.length, 7, "近 7 日必须是 7 个点");
});

at("2026-11-07T12:03:15+08:00");
queue = [149.8];
const res4 = await call();
check("充值不算消耗（充值后消耗仍是 0.20）", () => {
  assert.equal(res4.body.account.total, 149.8);
  assert.equal(res4.body.spend.today, 0.2);
  assert.equal(res4.body.spend.credits, 100);
});

at("2026-11-07T12:04:20+08:00");
queue = [149.7];
const res5 = await call();
check("充值后再消耗按新水位计算", () => {
  assert.equal(res5.body.spend.today, 0.3);
});

// 10 小时没开界面（最后一次采样 12:04:20），余额掉 5 元不该算成今天的消耗
at("2026-11-07T22:00:00+08:00");
queue = [144.7];
const res6 = await call();
check("断档 >3h 的跌幅不归因", () => {
  assert.equal(res6.body.account.total, 144.7);
  assert.equal(res6.body.spend.today, 0.3, "断档跌幅被错误地记进了今天");
});

// 跨日：11-08 第一次采样从新水位起算，昨日保留 0.30
at("2026-11-08T09:00:00+08:00");
queue = [144.6];
const res7 = await call();
check("跨日消耗从 0 重新累计，昨日保留 0.30", () => {
  assert.equal(res7.body.spend.today, 0, "跨日时应以新一天的水位为基准");
  assert.equal(res7.body.spend.yesterday, 0.3);
  assert.equal(res7.body.spend.days[0].day, "2026-11-08");
  assert.equal(res7.body.spend.days[1].day, "2026-11-07");
  assert.equal(res7.body.spend.days[1].amount, 0.3);
});

at("2026-11-08T09:01:05+08:00");
queue = [144.5];
const res8 = await call();
check("第二天正常累加 0.10，周合计包含两天", () => {
  assert.equal(res8.body.spend.today, 0.1);
  assert.equal(res8.body.spend.week, 0.4);
  assert.ok(res8.body.spend.days[0].sampled && res8.body.spend.days[1].sampled);
  assert.equal(res8.body.spend.days[2].sampled, false, "没有采样的日子应标 sampled=false");
});

//#endregion

Date.now = realNow;
for (const dir of HOMES) await rm(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n        ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

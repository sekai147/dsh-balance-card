# dsh-balance-card

DSH 左侧边栏底部的余额卡片，一行看得完三个数：

```
┌──────────────────────────────┐
│ DeepSeek              ● 谷时 │
│ ¥48.51              今日 ¥0.12│
│ 距峰时 13:12:59              │
└──────────────────────────────┘
```

点一下展开：近 7 日消耗柱状图、昨日/本周合计、当前档位单价、更新时间。

## 卡片读什么

| 位置 | 含义 | 来源 |
| --- | --- | --- |
| 大字 | 账户余额（CNY） | DeepSeek 官方 `GET /user/balance` |
| 右上角药丸 | 此刻是峰时（橙）还是谷时（绿） | 北京时间本地推算，不联网 |
| 右下角 | 今日消耗 | 余额快照账本，见下 |
| 第三行 | 距下一次峰谷翻转的倒计时 | 本地时钟每秒走字 |

峰谷口径与官方一致：**工作日 09:00–12:00、14:00–18:00 为峰时**，其余时间为谷时；
**周末与中国法定节假日全天为谷时**。倒计时跨天、跨周末、跨长假都按真实边界算
（周五 18:00 之后会显示到「下周一 09:00」）。

## 消耗是怎么算的

宿主每次被卡片心跳（60 秒一次）就取一次余额，落到 `$DSH_HOME/dsh-balance-card.json`：

- 余额**下降** → 记进当天的「消耗」；
- 余额**上升** → 记为充值，**不抵扣**消耗（充值不该把你的花费抹掉）；
- 两次采样间隔超过 3 小时（关了界面、机器睡眠）→ 那段跌幅**不归因**，宁可少算也不把
  几天的钱一次性堆到今天；
- 每天只保留一条日汇总（今日/昨日/近 7 日），账本最多留 30 天。

因此「今日消耗」是从**本进程第一次拿到余额**那一刻开始累计的：刚装上的头一分钟里，
它显示 0 属于正常。余额接口失败时，卡片会显示错误原因，但峰谷灯与倒计时照旧工作
（它们不花钱也不用网络）。

## 动效

- 点卡片展开/收起明细：高度用 `grid-template-rows: 0fr → 1fr` 过渡（240ms，
  `cubic-bezier(.4,0,.2,1)`），内容同时做 180ms 的淡入 + 上移，卡片高度连续变化、不跳。
- 明细面板常驻 DOM（只改布局与透明度），所以展开时不会重新请求、也不会闪一下；
  收起时不占高度、`pointer-events: none`，不可误触。
- 侧栏在「宽栏 ⇄ 图标栏」之间切换时，卡片以 180ms 淡入替代硬切。
- 系统的「减少动态效果」（`prefers-reduced-motion: reduce`）生效时，以上过渡全部关闭。

## 安装

本包是一个标准 DSH bundle（`dsh.bundle.patch` + `dsh.client`），两半边同名同 id：

- `lib/index.js` —— 宿主半边。注册 `GET /api/dsh-balance`（**仅本机可读**），
  用 `ctx.credentials` 里的 `DEEPSEEK_API_KEY` 查官方余额，并维护余额账本。
- `lib/client.js` —— 浏览器半边。往 `sidebar.footer.action` 槽位注册卡片。

装进 profile（示例为 Desktop 的 `desktop` profile），一条命令：

```bash
node install.mjs                # 复制到 ~/.dsh/profiles/desktop/node_modules/ 并登记一行
node install.mjs --uninstall    # 撤掉那一行（包目录保留）
node install.mjs --profile web  # 装进别的 profile
```

装完**重启 DSH**（desktop profile 不做热重载）。手工装也可以：把本目录拷到
`<profile>/node_modules/dsh-balance-card`，再在 `<profile>/cordis.patch.yml` 里加

```yaml
- insert:
    - id: dsh-balance-card
      name: dsh-balance-card
```

卡片折叠成图标栏时退化成「峰谷灯 + 余额」两行，不占额外高度。

## 需要什么权限

- 凭据：先试 `DEEPSEEK_API_KEY`（走 DSH 凭据服务，插件不落盘、不打印）；没有或不被接受
  （401/403）时自动回退到 DSH 账号登录留下的 grant 记录
  `deepseek-account-platform/default`（请求头 `x-dsh-auth-token`）。所以**只登录账号、没配
  API Key 也能用**。响应里的 `account.auth` 会写明这次用的是 `api-key` 还是 `account`。
- 网络：只访问 `https://api.deepseek.com/user/balance`。
- 路由：`/api/dsh-balance` 只接受本机 Host（回环/监听地址），拒绝 `Sec-Fetch-Site: cross-site`
  与异源 `Origin`，所以别的网页读不到你的余额。

## 已知限制

- 「今日消耗」是余额差值口径：如果你在别的设备/别的客户端上也花同一个账户的钱，
  那部分会在下一次采样时体现为一次下降，可能落到当天。
- 法定节假日表内置到 2026 年（`HOLIDAY_TABLE_THROUGH_YEAR`）。跨年后需要按国务院办公厅
  通知补表，否则节假日白天会被当作峰时（响应里的 `window.holidayCovered` 会变成 `false`）。
- 单价行只认官方模型（`deepseek-flash` / `deepseek-v4-pro` / `deepseek-chat` / `deepseek-reasoner`）；
  表里没有的模型只显示余额与峰谷，不猜价。

## 自测

```bash
node test/host-test.mjs     # 宿主半边：24 个用例（峰谷边界、账本、栅栏、载荷形状）
node test/serve.mjs 7801    # 浏览器半边预览：http://127.0.0.1:7801/?state=ok
```

预览页用 `test/harness/` 里一个极简 React 替身渲染**真实的 `lib/client.js`**，
支持 `?state=ok|peak|error&wide=0|1&open=0|1&theme=light|dark` 看各种形态。

/**
 * dsh-balance-card — 浏览器半边。
 *
 * 在左侧边栏底部（`sidebar.footer.action` 槽位，位于 Settings 之上）画一张卡片：
 *   第一行 ·  DeepSeek + 峰/谷指示灯
 *   第二行 ·  余额（大号）+ 今日消耗
 *   第三行 ·  距下一次峰谷翻转的倒计时（每秒走字，不依赖网络）
 * 点一下展开：近 7 日条形图、昨日/本周合计、当前档位单价、数据时间。
 *
 * 数据全部来自宿主路由 `GET /api/dsh-balance`（见 lib/index.js），
 * 卡片自己做 60 秒心跳；倒计时用本地时钟走字，所以网断了也照常跳。
 */

window.__ModuleLoader__.load({
  id: "dsh-balance-card",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require("react");
    var h = react.createElement;

    var NS = "dsh-balance-card";
    var PATH = "/api/dsh-balance";
    /** 心跳：余额变动很慢，60 秒一次足够；真正走字的是本地倒计时。 */
    var POLL_MS = 60000;
    /** 失败重试阶梯：宿主刚起来/网络抖一下时几秒内自己收敛。 */
    var RETRY_MS = [5000, 10000, 20000, 45000];
    var CARD_MIN_HEIGHT = 70;
    /** 尊重系统「减少动态效果」：开了就只留瞬时切换，不做动画。 */
    var REDUCED = (function () {
      try {
        return typeof window !== "undefined" && typeof window.matchMedia === "function"
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch (e) {
        return false;
      }
    })();
    /** 展开/收起的动效参数，集中在这里，方便一处调手感。 */
    var MOTION = {
      rows: REDUCED ? "none" : "grid-template-rows .24s cubic-bezier(.4, 0, .2, 1)",
      inner: REDUCED ? "none" : "opacity .18s ease, transform .24s ease, padding-top .24s ease, border-color .18s ease",
    };

    // 只使用 DSH 主题变量（带兜底值），跟随明暗主题，不写死颜色。
    var C = {
      bg: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
      bgSoft: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.07))",
      border: "var(--dsw-alias-border-l3, rgba(127,127,127,.3))",
      track: "var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
      label: "var(--dsw-alias-label-primary, #111)",
      sub: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
      muted: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.38))",
      peak: "var(--dsw-alias-state-warn-primary, rgb(230,120,0))",
      idle: "var(--dsw-alias-state-success-primary, rgb(34,160,80))",
      err: "var(--dsw-alias-state-error-primary, rgb(200,40,40))",
    };

    var DICT = {
      zh: {
        title: "DeepSeek",
        peak: "峰时",
        idle: "谷时",
        today: "今日",
        toPeak: "距峰时",
        toIdle: "距谷时",
        balance: "余额",
        week7: "近 7 日",
        weekSum: "合计",
        yesterday: "昨日",
        price: "当前",
        priceIn: "入",
        priceOut: "出",
        unit: "百万 token",
        perM: "每百万",
        updated: "更新",
        collapse: "收起",
        expand: "展开明细",
        loading: "读取余额…",
        noData: "暂无数据",
        unavailable: "账户当前不可用",
        partial: "今日消耗仍在累计",
        placeholder: "—",
      },
      en: {
        title: "DeepSeek",
        peak: "Peak",
        idle: "Off-peak",
        today: "Today",
        toPeak: "Peak in",
        toIdle: "Off-peak in",
        balance: "Balance",
        week7: "Last 7 days",
        weekSum: "total",
        yesterday: "Yesterday",
        price: "Now",
        priceIn: "in",
        priceOut: "out",
        unit: "per M tokens",
        perM: "per M",
        updated: "Updated",
        collapse: "Collapse",
        expand: "Show details",
        loading: "Reading balance…",
        noData: "No data",
        unavailable: "Account unavailable",
        partial: "Still counting today",
        placeholder: "—",
      },
    };

    //#region 格式化

    function pad(n) {
      return n < 10 ? "0" + n : String(n);
    }

    /** 倒计时：>1 天显示「N天 hh:mm」，>1 小时「h:mm:ss」，否则「m:ss」。 */
    function fmtCountdown(ms) {
      if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return DICT.zh.placeholder;
      var total = Math.floor(ms / 1000);
      var d = Math.floor(total / 86400);
      var hh = Math.floor((total % 86400) / 3600);
      var mm = Math.floor((total % 3600) / 60);
      var ss = total % 60;
      if (d > 0) return d + "天 " + pad(hh) + ":" + pad(mm);
      if (hh > 0) return hh + ":" + pad(mm) + ":" + pad(ss);
      return mm + ":" + pad(ss);
    }

    /** 余额保留 2 位；小额消耗保留 3 位，避免「0.00」把真实花费抹平。 */
    function fmtBalance(value) {
      if (typeof value !== "number" || !isFinite(value)) return DICT.zh.placeholder;
      return value.toFixed(2);
    }

    /** 金额：≥1 元两位；<1 元能两位说清就两位，否则三位（0.004 不能显示成 0.00）。 */
    function fmtSpend(value) {
      if (typeof value !== "number" || !isFinite(value)) return DICT.zh.placeholder;
      var three = Math.round(value * 1000) / 1000;
      if (three === 0) return "0.00";
      if (Math.abs(three) >= 1) return three.toFixed(2);
      var two = Math.round(value * 100) / 100;
      if (two > 0 && Math.abs(two - three) < 1e-9) return two.toFixed(2);
      return three.toFixed(3);
    }

    /** 单价：整数不拖小数点（2 而不是 2.00），小数最多三位。 */
    function fmtPrice(value) {
      if (typeof value !== "number" || !isFinite(value)) return DICT.zh.placeholder;
      return String(Math.round(value * 1000) / 1000);
    }

    function fmtClock(ms) {
      if (typeof ms !== "number" || !isFinite(ms)) return "";
      var d = new Date(ms);
      return pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    /** 「11-04」这样的短日期（按本地时区，和用户对表）。 */
    function fmtDayShort(key) {
      if (typeof key !== "string" || key.length < 10) return "";
      return key.slice(5).replace("-", "/");
    }

    //#endregion

    function useLang(ctx) {
      var locale = ctx && ctx.locale;
      var read = function () {
        try {
          if (locale && typeof locale.getSnapshot === "function") {
            var snap = locale.getSnapshot();
            if (snap && snap.active === "en") return "en";
          }
        } catch (e) { /* 词典不可用就按中文走 */ }
        return "zh";
      };
      var state = react.useState(read);
      var setLang = state[1];
      react.useEffect(function () {
        if (!locale || typeof locale.subscribe !== "function") return undefined;
        var off = null;
        try {
          off = locale.subscribe(function () {
            setLang(read());
          });
        } catch (e) {
          return undefined;
        }
        return function () {
          try {
            if (typeof off === "function") off();
          } catch (e) { /* 卸载时的清理失败无需处理 */ }
        };
      }, []);
      return state[0];
    }

    function Dot(props) {
      return h("span", {
        style: {
          width: props.size || 7,
          height: props.size || 7,
          borderRadius: "50%",
          background: props.color,
          flex: "0 0 auto",
          display: "inline-block",
        },
      });
    }

    /** 近 7 日条形图：每根柱子有自己的固定高度轨道，日期标签因此永远对齐；今天高亮。 */
    function WeekBars(props) {
      var days = Array.isArray(props.days) ? props.days : [];
      var t = props.t;
      var max = 0;
      for (var i = 0; i < days.length; i += 1) if (days[i].amount > max) max = days[i].amount;
      var scale = max > 0 ? max : 1;
      var track = 30;
      var bars = [];
      for (var j = days.length - 1; j >= 0; j -= 1) {
        var day = days[j];
        var today = j === 0;
        var height = day.amount > 0 ? Math.max(4, Math.round((day.amount / scale) * track)) : 2;
        bars.push(h("div", {
          key: day.day,
          title: day.day + " · ¥" + fmtSpend(day.amount),
          style: {
            flex: "1 1 0",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 3,
          },
        },
          h("div", {
            style: {
              height: track,
              width: "100%",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
            },
          },
            h("div", {
              style: {
                width: "72%",
                maxWidth: 16,
                height: height,
                borderRadius: "2px 2px 1px 1px",
                background: today ? C.idle : C.sub,
                opacity: today ? 1 : (day.amount > 0 ? 0.45 : 0.16),
              },
            }),
          ),
          h("div", {
            style: {
              fontSize: 9,
              lineHeight: "11px",
              color: today ? C.sub : C.muted,
              fontVariantNumeric: "tabular-nums",
            },
          }, fmtDayShort(day.day)),
        ));
      }
      return h("div", {
        style: { display: "flex", gap: 3, alignItems: "flex-end" },
        "aria-label": t.week7,
      }, bars);
    }

    function BalanceCard(props) {
      var ctx = props.ctx;
      var wide = !!props.wide;
      var lang = useLang(ctx);
      var t = DICT[lang] || DICT.zh;

      var dataState = react.useState(null);
      var data = dataState[0];
      var setData = dataState[1];
      var errState = react.useState("");
      var error = errState[0];
      var setError = errState[1];
      var openState = react.useState(false);
      var expanded = openState[0];
      var setExpanded = openState[1];
      var tickState = react.useState(0);
      var setTick = tickState[1];

      var mounted = react.useRef(true);
      var timer = react.useRef(null);
      var retryStep = react.useRef(0);
      var seq = react.useRef(0);
      var loadRef = react.useRef(null);

      react.useEffect(function () {
        mounted.current = true;
        return function () {
          mounted.current = false;
          if (timer.current !== null) clearTimeout(timer.current);
        };
      }, []);

      // 每秒一次本地点亮倒计时；数据不到时也照常跑（不消耗流量）。
      react.useEffect(function () {
        var id = setInterval(function () {
          if (mounted.current) setTick(function (n) { return (n + 1) % 100000; });
        }, 1000);
        return function () { clearInterval(id); };
      }, []);

      var schedule = react.useCallback(function (delay) {
        if (!mounted.current) return;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(function () {
          timer.current = null;
          if (loadRef.current) loadRef.current();
        }, delay);
      }, []);

      var load = react.useCallback(function () {
        var mine = ++seq.current;
        var visible = typeof document === "undefined" || document.visibilityState !== "hidden";
        // 后台标签页不做心跳：每次心跳宿主都可能真打一次官方余额接口。
        if (!visible && dataState[0] !== null) {
          schedule(POLL_MS);
          return;
        }
        fetch(PATH + "?lang=" + (DICT[lang] ? lang : "zh"), { cache: "no-store" })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (body) {
            if (!mounted.current || mine !== seq.current) return;
            if (!body || body.ok !== true) throw new Error((body && body.message) || "bad payload");
            retryStep.current = 0;
            setError("");
            setData(body);
            schedule(POLL_MS);
          })
          .catch(function (e) {
            if (!mounted.current || mine !== seq.current) return;
            setError(String((e && e.message) || e));
            var delay = RETRY_MS[retryStep.current];
            if (delay === undefined) delay = POLL_MS;
            else retryStep.current += 1;
            schedule(delay);
          });
      }, [lang, schedule]);

      loadRef.current = load;

      react.useEffect(function () {
        load();
        return function () {
          if (timer.current !== null) clearTimeout(timer.current);
        };
      }, [load]);

      var next = data && data.window && data.window.next ? data.window.next : null;
      var peak = !!(data && data.window && data.window.peak);
      var peakColor = peak ? C.peak : C.idle;
      var remaining = next && typeof next.ms === "number" ? next.at - Date.now() : null;
      var account = data ? data.account : null;
      var hasBalance = !!(account && account.ok && typeof account.total === "number");
      var statusText = peak ? t.peak : t.idle;
      var countdownLabel = peak ? t.toIdle : t.toPeak;

      // ---- 折叠态（图标栏只有 36px 宽）：一颗峰谷灯 + 一个字号极小的余额 ----
      if (!wide) {
        return h("div", {
          key: "compact",
          className: "dsbc-enter",
          title: t.title + " · " + statusText + (hasBalance ? " · ¥" + fmtBalance(account.total) : ""),
          style: {
            width: "100%",
            minHeight: 40,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
            padding: "4px 0",
            borderRadius: 8,
            cursor: "pointer",
            userSelect: "none",
          },
          onClick: function () { setExpanded(false); },
          role: "img",
          "aria-label": t.title + " " + (hasBalance ? fmtBalance(account.total) : "") + " " + statusText,
        },
          h(Dot, { color: error ? C.err : peakColor, size: 8 }),
          h("div", {
            style: {
              fontSize: 9,
              lineHeight: "10px",
              color: hasBalance ? C.sub : C.muted,
              fontVariantNumeric: "tabular-nums",
            },
          }, hasBalance ? fmtBalance(account.total) : "—"),
        );
      }

      // ---- 读数取不到时：只陈述原因，峰谷灯与倒计时照旧（它们不花钱也不用网络） ----
      var accountNote = "";
      if (data && account && account.ok !== true) accountNote = account.message || t.unavailable;
      else if (error) accountNote = error;

      var rows = [];

      rows.push(h("div", {
        key: "head",
        style: { display: "flex", alignItems: "center", gap: 5, minWidth: 0 },
      },
        h("span", {
          style: {
            fontSize: 11,
            lineHeight: "13px",
            color: C.sub,
            letterSpacing: ".01em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: "1 1 auto",
            minWidth: 0,
          },
        }, t.title),
        h("span", {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            flex: "0 0 auto",
            padding: "1px 6px",
            borderRadius: 999,
            fontSize: 10,
            lineHeight: "14px",
            color: peakColor,
            background: peak ? "rgba(230,120,0,.12)" : "rgba(34,160,80,.12)",
            border: "0.5px solid " + peakColor,
            whiteSpace: "nowrap",
          },
          title: peak ? "09:00–12:00 / 14:00–18:00" : "谷时计价",
        }, h(Dot, { color: peakColor, size: 5 }), statusText),
      ));

      rows.push(h("div", {
        key: "figures",
        style: {
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 6,
          minWidth: 0,
        },
      },
        h("div", {
          style: {
            display: "flex",
            alignItems: "baseline",
            gap: 2,
            minWidth: 0,
            fontVariantNumeric: "tabular-nums",
          },
        },
          hasBalance ? h("span", { style: { fontSize: 11, color: C.muted, lineHeight: "18px" } }, "¥") : null,
          h("span", {
            style: {
              fontSize: 19,
              lineHeight: "21px",
              fontWeight: 600,
              color: hasBalance ? C.label : C.muted,
              letterSpacing: "-.01em",
            },
          }, hasBalance ? fmtBalance(account.total) : t.placeholder),
        ),
        h("div", {
          style: {
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 0,
            minWidth: 0,
            fontVariantNumeric: "tabular-nums",
          },
          title: data && data.spend && data.spend.partial ? t.partial : t.today,
        },
          h("span", { style: { fontSize: 9, lineHeight: "10px", color: C.muted } }, t.today),
          h("span", {
            style: {
              fontSize: 12,
              lineHeight: "14px",
              color: data && data.spend ? C.sub : C.muted,
              whiteSpace: "nowrap",
            },
          }, "¥" + fmtSpend(data && data.spend ? data.spend.today : null)),
        ),
      ));

      rows.push(h("div", {
        key: "countdown",
        style: {
          display: "flex",
          alignItems: "center",
          gap: 4,
          minWidth: 0,
          fontSize: 10.5,
          lineHeight: "13px",
          color: C.sub,
        },
      },
        h("span", { style: { color: C.muted, whiteSpace: "nowrap" } }, countdownLabel),
        h("span", {
          style: {
            fontVariantNumeric: "tabular-nums",
            color: peakColor,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        }, remaining === null ? t.placeholder : fmtCountdown(remaining)),
      ));

      if (accountNote) {
        rows.push(h("div", {
          key: "note",
          style: {
            fontSize: 10,
            lineHeight: "13px",
            color: account && account.ok === false ? C.err : C.muted,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          },
        }, accountNote));
      }

      // 明细面板常驻 DOM，只在展开时把高度从 0fr 拉到 1fr —— 这样收起是"缩回去"，
      // 而不是元素凭空消失的硬切。data 还没到时不挂面板，省得留一个空壳。
      if (data) {
        var detail = [];
        detail.push(h("div", {
          key: "bars",
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 4,
          },
        },
          h("div", {
            style: {
              display: "flex",
              justifyContent: "space-between",
              fontSize: 9.5,
              color: C.muted,
            },
          },
            h("span", null, t.week7),
            h("span", { style: { fontVariantNumeric: "tabular-nums" } },
              t.weekSum + " ¥" + fmtSpend(data.spend ? data.spend.week : null)),
          ),
          h(WeekBars, { days: data.spend ? data.spend.days : [], t: t }),
        ));

        var meta = [];
        if (data.spend) {
          meta.push(h("span", { key: "y", style: { fontVariantNumeric: "tabular-nums" } },
            t.yesterday + " ¥" + fmtSpend(data.spend.yesterday)));
        }
        if (data.price) {
          meta.push(h("span", {
            key: "p",
            style: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
            title: data.price.model,
          }, t.priceIn + " ¥" + fmtPrice(data.price.input) + " · " + t.priceOut + " ¥" + fmtPrice(data.price.output) + " · " + t.unit));
        }
        if (meta.length > 0) {
          detail.push(h("div", {
            key: "meta",
            style: {
              display: "flex",
              flexWrap: "wrap",
              gap: "2px 8px",
              fontSize: 9.5,
              lineHeight: "12px",
              color: C.muted,
            },
          }, meta));
        }
        detail.push(h("div", {
          key: "foot",
          style: { fontSize: 9, lineHeight: "11px", color: C.muted },
        }, t.updated + " " + fmtClock(data.now) + " · " + t.collapse));

        rows.push(h("div", {
          key: "detail",
          style: {
            display: "grid",
            gridTemplateRows: expanded ? "1fr" : "0fr",
            transition: MOTION.rows,
          },
        },
          h("div", {
            style: {
              overflow: "hidden",
              minHeight: 0,
              paddingTop: expanded ? 8 : 0,
              borderTop: "0.5px solid " + (expanded ? C.border : "transparent"),
              opacity: expanded ? 1 : 0,
              transform: expanded ? "none" : "translateY(-3px)",
              transition: MOTION.inner,
              pointerEvents: expanded ? "auto" : "none",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            },
            "data-dsbc": "detail",
            "aria-hidden": expanded ? undefined : "true",
          }, detail),
        ));
      }

      var card = h("div", {
        key: "card",
        className: "dsbc-enter",
        style: {
          boxSizing: "border-box",
          flex: "1 1 100%",
          minWidth: 0,
          minHeight: CARD_MIN_HEIGHT,
          // 内边距固定：展开时只让明细面板长高，卡片本身不跳。
          padding: "8px 10px",
          borderRadius: 10,
          border: "0.5px solid " + C.border,
          background: C.bg,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 3,
          cursor: "pointer",
          userSelect: "none",
          overflow: "hidden",
          transition: "background .15s ease",
        },
        role: "button",
        tabIndex: 0,
        title: expanded ? t.collapse : t.expand,
        "aria-label": t.title + " " + t.balance,
        "aria-expanded": expanded ? "true" : "false",
        onClick: function () { setExpanded(function (v) { return !v; }); },
        onKeyDown: function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(function (v) { return !v; });
          }
        },
      }, rows);

      // 首帧还没有数据：给一个等高占位，侧边栏不跳。
      if (!data && !error) {
        return h("div", {
          key: "loading",
          className: "dsbc-enter",
          style: {
            boxSizing: "border-box",
            flex: "1 1 100%",
            minHeight: CARD_MIN_HEIGHT,
            padding: "8px 10px",
            borderRadius: 10,
            border: "0.5px solid " + C.border,
            background: C.bgSoft,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 2,
            fontSize: 11,
            color: C.muted,
          },
        }, t.loading);
      }

      return card;
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots) return;

      // 文案登记进 DSH 的 locale 服务：卡片自己仍用本地词典兜底，所以词典服务不在时
      // 也照常显示中文。用 ctx.effect 管生命周期，插件卸载时词典随之撤销。
      try {
        if (ctx.locale && typeof ctx.locale.register === "function") {
          if (typeof ctx.effect === "function") {
            ctx.effect(function () { return ctx.locale.register(NS, DICT); }, NS + ": dictionaries");
          } else {
            ctx.locale.register(NS, DICT);
          }
        }
      } catch (e) { /* 词典注册失败不影响卡片 */ }

      // 卡片要独占一行：footerActions 默认是横向 flex，不换行会被挤成一条细缝。
      try {
        var style = document.createElement("style");
        style.dataset.plugin = NS;
        style.dataset.pluginCss = "footer-card";
        style.textContent = [
          'div[class*="footerActions"]{flex-wrap:wrap;row-gap:2px}',
          // 卡片首次出现、以及"宽栏 ↔ 图标栏"互换时淡入（换 key 会重新挂载，动画随之重播）。
          "@keyframes dsbc-enter{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}",
          ".dsbc-enter{animation:dsbc-enter .18s ease-out both}",
          "@media (prefers-reduced-motion: reduce){.dsbc-enter{animation:none}}",
        ].join("\n");
        document.head.appendChild(style);
        if (typeof ctx.effect === "function") {
          ctx.effect(function () {
            return function () {
              if (style.parentNode) style.parentNode.removeChild(style);
            };
          }, NS + ": style");
        }
      } catch (e) { /* 样式注入失败只影响换行，卡片照旧渲染 */ }

      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register({
          name: "sidebar.footer.action",
          id: NS,
          order: 40,
          label: "DeepSeek 余额",
        }, function (props) {
          return h(BalanceCard, { wide: props.wide, ctx: ctx });
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    exports.name = NS;

    return module.exports;
  },
});

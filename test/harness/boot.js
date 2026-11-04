/**
 * 预览页的引导：把 lib/client.js 当成 DSH 客户端插件加载进来。
 *
 * 它做的事和 DSH 宿主一模一样：
 *   1. 提供 window.__ModuleLoader__.load，收集插件工厂；
 *   2. 提供 require("react")（这里是 ReactShim）；
 *   3. 造一个只有 slots / locale 的 ctx，调 apply()；
 *   4. 把插件注册进 sidebar.footer.action 的那个渲染函数挂到假左栏里。
 *
 * URL 参数：state=ok|peak|error · wide=0|1 · open=0|1 · lang=zh|en
 */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var state = params.get("state") || "ok";
  var wide = params.get("wide") !== "0";
  var open = params.get("open") === "1";
  var lang = params.get("lang") === "en" ? "en" : "zh";

  function fail(error) {
    document.getElementById("error").textContent = "加载失败：\n" + (error && error.stack ? error.stack : String(error));
    throw error;
  }

  // ---- 1. 模块加载器 ----
  var factories = new Map();
  (window.__pendingMods || []).forEach(function (mod) {
    if (mod && mod.id && typeof mod.factory === "function") factories.set(mod.id, mod.factory);
  });
  window.__ModuleLoader__ = {
    load: function (mod) {
      factories.set(mod.id, mod.factory);
    },
  };

  var modules = { react: window.ReactShim };

  var factory = factories.get("dsh-balance-card");
  if (typeof factory !== "function") fail(new Error("lib/client.js 没有注册工厂函数"));

  var client;
  try {
    client = factory(function (id) {
      if (modules[id]) return modules[id];
      throw new Error("预览页没有提供模块：" + id);
    });
  } catch (error) {
    fail(error);
  }
  if (!client || typeof client.apply !== "function") fail(new Error("客户端半边没有导出 apply()"));

  // ---- 2. 让 fetch 带上变体参数（客户端只会请求 /api/dsh-balance?lang=xx）----
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, options) {
    var sep = String(url).indexOf("?") === -1 ? "?" : "&";
    return realFetch(String(url) + sep + "state=" + encodeURIComponent(state), options);
  };

  // ---- 3. 假宿主 ctx ----
  var listeners = [];
  var snapshot = { active: lang };
  var renderCard = null;

  var ctx = {
    slots: {
      inject: function (name, register) {
        register();
        return function () {};
      },
      register: function (meta, render) {
        renderCard = render;
        return function () {};
      },
    },
    locale: {
      register: function () {},
      bind: function () { return { subscribe: function () { return function () {}; } }; },
      subscribe: function (cb) {
        listeners.push(cb);
        return function () {
          listeners = listeners.filter(function (item) { return item !== cb; });
        };
      },
      getSnapshot: function () { return snapshot; },
    },
    effect: function (fn) { fn(); return function () {}; },
    get: function () { return undefined; },
    logger: { warn: function () { console.warn.apply(console, arguments); } },
  };

  window.__switchLang = function (next) {
    snapshot = { active: next };
    listeners.forEach(function (cb) { cb(); });
  };

  try {
    client.apply(ctx);
  } catch (error) {
    fail(error);
  }
  if (typeof renderCard !== "function") fail(new Error("卡片没有注册到 sidebar.footer.action"));

  // ---- 4. 按 DSH 左栏的结构挂载 ----
  if (!wide) {
    document.getElementById("sidebar").classList.add("collapsed");
    document.querySelector(".brand-name").style.display = "none";
    document.querySelector(".panel").style.display = "none";
    document.getElementById("settings-label").style.display = "none";
  }

  if (params.get("theme") === "light") document.body.dataset.theme = "light";

  var host = document.getElementById("footer-actions");
  window.ReactShim.mount(function () {
    return renderCard({ wide: wide });
  }, host);

  // ---- 5. 右侧说明区 ----
  var swatches = [
    ["ok", "谷时（正常）"],
    ["peak", "峰时 + 展开"],
    ["error", "余额读取失败"],
    ["ok&wide=0", "折叠成图标栏"],
  ];
  var box = document.getElementById("swatches");
  swatches.forEach(function (item) {
    var key = item[0];
    var label = item[1];
    var url = "?state=" + key + "&open=" + (key === "peak" ? "1" : "0");
    var link = document.createElement("a");
    link.className = "swatch";
    link.href = url;
    link.textContent = label;
    link.dataset.active = (state + (wide ? "" : "&wide=0")) === key ? "1" : "0";
    box.appendChild(link);
  });

  document.getElementById("caption").textContent =
    "dsh-balance-card · " + (wide ? "展开的左栏" : "折叠的图标栏") + " · 变体 " + state + (open ? " · 明细展开" : "");

  // 展开态：等第一帧数据到了再点一下卡片
  if (open) {
    setTimeout(function () {
      var card = host.querySelector('[role="button"]');
      if (card) card.click();
    }, 700);
  }

  // 把服务端返回的原始 JSON 摆在旁边，数字对不对一眼能看出来
  setTimeout(function () {
    var sep = "/api/dsh-balance?lang=" + lang + "&state=" + encodeURIComponent(state);
    realFetch(sep, { cache: "no-store" })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        document.getElementById("raw").textContent = JSON.stringify(body, null, 2);
      })
      .catch(function (error) {
        document.getElementById("raw").textContent = "读取 /api/dsh-balance 失败：" + String(error);
      });
  }, 300);
})();

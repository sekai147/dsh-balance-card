/**
 * 极简 React 替身（仅用于本地预览卡片；生产环境用的是 DSH 自带的 react）。
 *
 * 只实现 dsh-balance-card/lib/client.js 用到的那一小撮 API：
 *   createElement / useState / useEffect / useRef / useCallback / useMemo。
 *
 * 渲染是「按位置复用 DOM 节点 + 只改变化的属性」，不是整棵重建——这样 CSS transition
 * 才有机会真的跑起来（重建 DOM 时新元素没有"上一帧"，过渡永远看不到）。
 */
(function (global) {
  "use strict";

  var UNITLESS = {
    fontWeight: 1, opacity: 1, zIndex: 1, flex: 1, flexGrow: 1, flexShrink: 1,
    order: 1, lineHeight: 1, tabSize: 1, zoom: 1,
  };
  var EVENT_MAP = { onClick: "click", onKeyDown: "keydown", onChange: "change", onInput: "input" };

  var runtime = null;      // { instances: Map<path, {hooks}>, effects, container, root, factory }
  var instance = null;
  var hooks = null;
  var hookIndex = 0;
  var effects = [];

  //#region hooks

  function instanceFor(path) {
    var inst = runtime.instances.get(path);
    if (!inst) {
      inst = { path: path, hooks: [] };
      runtime.instances.set(path, inst);
    }
    return inst;
  }

  function enterComponent(path) {
    var prev = { instance: instance, hooks: hooks, hookIndex: hookIndex };
    instance = instanceFor(path);
    hooks = instance.hooks;
    hookIndex = 0;
    return prev;
  }

  function leaveComponent(prev) {
    instance = prev.instance;
    hooks = prev.hooks;
    hookIndex = prev.hookIndex;
  }

  function useSlot(factory) {
    var i = hookIndex;
    hookIndex += 1;
    if (hooks.length <= i) hooks.push({});
    var hook = hooks[i];
    if (!("value" in hook) && factory) hook.value = factory();
    return hook;
  }

  function depsChanged(a, b) {
    if (!a || !b || a.length !== b.length) return true;
    for (var i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return true;
    return false;
  }

  function useState(initial) {
    var hook = useSlot(null);
    if (!("value" in hook)) hook.value = typeof initial === "function" ? initial() : initial;
    if (!hook.setter) {
      hook.setter = function (next) {
        var value = typeof next === "function" ? next(hook.value) : next;
        if (Object.is(value, hook.value)) return;
        hook.value = value;
        scheduleRender();
      };
    }
    return [hook.value, hook.setter];
  }

  function useEffect(fn, deps) {
    var hook = useSlot(null);
    var isNew = !("effect" in hook);
    if (isNew || depsChanged(deps, hook.effect.deps)) {
      effects.push({ hook: hook, fn: fn, deps: deps });
      if (isNew) hook.effect = { deps: deps, cleanup: null };
    }
  }

  function useRef(initial) {
    var hook = useSlot(function () { return { current: initial }; });
    return hook.value;
  }

  function useCallback(fn, deps) {
    var hook = useSlot(null);
    if (!("value" in hook) || depsChanged(deps, hook.deps)) {
      hook.value = fn;
      hook.deps = deps;
    }
    return hook.value;
  }

  function useMemo(fn, deps) {
    var hook = useSlot(null);
    if (!("value" in hook) || depsChanged(deps, hook.deps)) {
      hook.value = fn();
      hook.deps = deps;
    }
    return hook.value;
  }

  //#endregion

  //#region vnode

  function createElement(type, props) {
    var children = [];
    for (var i = 2; i < arguments.length; i += 1) children.push(arguments[i]);
    return { type: type, props: props || {}, children: children };
  }

  function flatten(list, out) {
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (item === null || item === undefined || item === false || item === true) continue;
      if (Array.isArray(item)) flatten(item, out);
      else out.push(item);
    }
    return out;
  }

  function isTextLike(vnode) {
    return typeof vnode === "string" || typeof vnode === "number";
  }

  function isEmpty(vnode) {
    return vnode === null || vnode === undefined || vnode === false || vnode === true;
  }

  //#endregion

  //#region DOM 打补丁

  function setStyle(el, style, previous) {
    var prev = previous || {};
    Object.keys(prev).forEach(function (key) {
      if (style && Object.prototype.hasOwnProperty.call(style, key)) return;
      if (key.indexOf("--") === 0) el.style.removeProperty(key);
      else el.style.removeProperty(key.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); }));
    });
    Object.keys(style || {}).forEach(function (key) {
      var value = style[key];
      if (value === null || value === undefined) return;
      if (key.indexOf("--") === 0) {
        el.style.setProperty(key, String(value));
        return;
      }
      var cssKey = key.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
      var text = typeof value === "number" && !UNITLESS[key] ? value + "px" : String(value);
      el.style.setProperty(cssKey, text);
    });
  }

  function patchProps(el, props, previous) {
    var prev = previous || {};
    Object.keys(prev).forEach(function (key) {
      if (key === "children" || key === "key" || key === "ref") return;
      if (Object.prototype.hasOwnProperty.call(props, key)) return;
      if (key === "style") {
        setStyle(el, null, prev.style);
        return;
      }
      if (EVENT_MAP[key]) {
        if (typeof prev[key] === "function") el.removeEventListener(EVENT_MAP[key], prev[key]);
        return;
      }
      el.removeAttribute(key === "className" ? "class" : key.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); }));
    });

    Object.keys(props).forEach(function (key) {
      if (key === "children" || key === "key" || key === "ref") return;
      var value = props[key];
      if (key === "style") {
        setStyle(el, value, prev.style);
        return;
      }
      if (EVENT_MAP[key]) {
        var old = prev[key];
        if (old === value) return;
        if (typeof old === "function") el.removeEventListener(EVENT_MAP[key], old);
        if (typeof value === "function") el.addEventListener(EVENT_MAP[key], value);
        return;
      }
      if (value === null || value === undefined || value === false) return;
      if (key === "className") {
        if (el.getAttribute("class") !== String(value)) el.setAttribute("class", String(value));
        return;
      }
      var name = key === "tabIndex" ? "tabindex" : key.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
      if (el.getAttribute(name) !== String(value)) el.setAttribute(name, String(value));
    });
  }

  function patchChildren(el, children, path) {
    var vlist = flatten(children || [], []);
    var existing = Array.prototype.slice.call(el.childNodes);
    for (var i = 0; i < vlist.length; i += 1) {
      var current = existing[i] || null;
      var next = patchNode(current, vlist[i], path + "." + i);
      if (next !== current) {
        if (current) el.replaceChild(next, current);
        else el.appendChild(next);
      }
    }
    for (var j = vlist.length; j < existing.length; j += 1) el.removeChild(existing[j]);
  }

  function patchNode(node, vnode, path) {
    if (isEmpty(vnode)) {
      if (node && node.nodeType === 3 && node.nodeValue === "") return node;
      return document.createTextNode("");
    }
    if (isTextLike(vnode)) {
      var text = String(vnode);
      if (node && node.nodeType === 3) {
        if (node.nodeValue !== text) node.nodeValue = text;
        return node;
      }
      return document.createTextNode(text);
    }
    if (Array.isArray(vnode)) {
      // 本组件里数组只会作为 children 出现（由 patchChildren 展开），这里不该被单独调用。
      var frag = document.createDocumentFragment();
      vnode.forEach(function (child, i) { frag.appendChild(patchNode(null, child, path + "." + i)); });
      return frag;
    }
    if (typeof vnode.type === "function") {
      // 实例路径必须只由位置决定，不能用节点上记的路径拼——那样每渲染一次都会变长，
      // 组件实例被当成新的，state 归零（表现为卡片永远停在"读取余额…"）。
      var saved = enterComponent(path);
      var out = vnode.type(vnode.props);
      leaveComponent(saved);
      return patchNode(node, out, path + "/h");
    }

    var el = node && node.nodeType === 1 && node.__dsbcTag === vnode.type ? node : null;
    if (!el) {
      el = document.createElement(vnode.type);
      el.__dsbcTag = vnode.type;
      patchProps(el, vnode.props, null);
      patchChildren(el, vnode.children, path);
      return el;
    }
    patchProps(el, vnode.props, el.__dsbcProps || null);
    el.__dsbcProps = vnode.props;
    patchChildren(el, vnode.children, path);
    return el;
  }

  //#endregion

  function flushEffects() {
    var pending = effects;
    effects = [];
    pending.forEach(function (item) {
      var previous = item.hook.effect && item.hook.effect.cleanup;
      if (typeof previous === "function") {
        try { previous(); } catch (e) { console.error("[shim] cleanup failed", e); }
      }
      var cleanup = item.fn();
      item.hook.effect = { deps: item.deps, cleanup: typeof cleanup === "function" ? cleanup : null };
    });
  }

  var scheduled = false;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      if (runtime) runtime.render();
    }, 0);
  }

  /** 挂载一个返回 vnode 的工厂函数；返回 { rerender, unmount }。 */
  function mount(factory, container) {
    runtime = { instances: new Map(), factory: factory, container: container, root: null };
    function render() {
      effects = [];
      var vnode = factory();
      var dom = patchNode(runtime.root, vnode, 0);
      if (runtime.root !== dom) {
        if (runtime.root && runtime.root.parentNode === container) container.replaceChild(dom, runtime.root);
        else container.appendChild(dom);
        runtime.root = dom;
      }
      flushEffects();
    }
    runtime.render = render;
    render();
    return {
      rerender: render,
      unmount: function () {
        runtime.instances.forEach(function (inst) {
          inst.hooks.forEach(function (hook) {
            if (hook.effect && typeof hook.effect.cleanup === "function") hook.effect.cleanup();
          });
        });
        container.replaceChildren();
        runtime = null;
      },
    };
  }

  global.ReactShim = {
    createElement: createElement,
    useState: useState,
    useEffect: useEffect,
    useRef: useRef,
    useCallback: useCallback,
    useMemo: useMemo,
    mount: mount,
    version: "shim-0.2",
  };
})(window);

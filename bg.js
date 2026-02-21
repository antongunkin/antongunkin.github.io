/**
 * Forest background — OffscreenCanvas loader.
 * Reads theme colours from CSS custom properties, transfers canvas rendering
 * to a Web Worker for smooth, jank-free animation.
 * Falls back to main-thread rendering on older browsers.
 *
 * Theme updates: call window.updateBgTheme() after changing CSS variables,
 * or change the class/style on <html> — the MutationObserver picks it up.
 * Colour transitions animate smoothly over 5 seconds.
 */
(function () {
  var c = document.querySelector("canvas");

  /* ── Colour parsing ─────────────────────────────────────────────── */
  function parseHex(hex) {
    hex = hex.replace(/^\s*#/, "");
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  function readTheme() {
    var s = getComputedStyle(document.documentElement);
    var v = function (name) {
      return s.getPropertyValue(name).trim();
    };
    return {
      sky: [
        parseHex(v("--sky-1")),
        parseHex(v("--sky-2")),
        parseHex(v("--sky-3")),
        parseHex(v("--sky-4")),
        parseHex(v("--sky-5")),
        parseHex(v("--sky-6")),
      ],
      fog: [
        parseHex(v("--fog-1")).concat(parseFloat(v("--fog-1-a"))),
        parseHex(v("--fog-2")).concat(parseFloat(v("--fog-2-a"))),
        parseHex(v("--fog-3")).concat(parseFloat(v("--fog-3-a"))),
        parseHex(v("--fog-4")).concat(parseFloat(v("--fog-4-a"))),
      ],
      treeHueMin: parseFloat(v("--tree-hue-min")),
      treeHueMax: parseFloat(v("--tree-hue-max")),
      treeSat: parseFloat(v("--tree-sat")),
    };
  }

  /* ── Theme change detection ────────────────────────────────────── */
  var sendTheme;

  function onThemeChange() {
    if (sendTheme) sendTheme(readTheme());
  }

  window.updateBgTheme = onThemeChange;

  var observer = new MutationObserver(onThemeChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class"],
  });

  /* ── Worker or fallback ────────────────────────────────────────── */
  if (typeof c.transferControlToOffscreen === "function") {
    /* ── Worker path ───────────────────────────────────────────── */
    var oc = c.transferControlToOffscreen();
    var w = new Worker("bg-worker.js");

    w.postMessage(
      {
        type: "init",
        canvas: oc,
        w: innerWidth,
        h: innerHeight,
        dpr: devicePixelRatio || 1,
        theme: readTheme(),
      },
      [oc],
    );

    sendTheme = function (theme) {
      w.postMessage({ type: "theme", theme: theme });
    };

    var tid;
    addEventListener("resize", function () {
      clearTimeout(tid);
      tid = setTimeout(function () {
        w.postMessage({
          type: "resize",
          w: innerWidth,
          h: innerHeight,
          dpr: devicePixelRatio || 1,
        });
      }, 120);
    });
  } else {
    /* ── Fallback: load renderer on main thread ────────────────── */
    window.__bgTheme = readTheme();
    var s = document.createElement("script");
    s.src = "bg-worker.js";
    document.body.appendChild(s);

    sendTheme = function (theme) {
      if (window.__bgSetTheme) window.__bgSetTheme(theme);
    };
  }
})();

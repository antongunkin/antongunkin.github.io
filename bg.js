/**
 * Forest background — OffscreenCanvas loader.
 * Transfers canvas rendering to a Web Worker for smooth, jank-free animation.
 * Falls back to main-thread rendering on older browsers.
 */
(function () {
  var c = document.querySelector("canvas");

  if (typeof c.transferControlToOffscreen === "function") {
    /* ── Worker path ─────────────────────────────────────────────────── */
    var oc = c.transferControlToOffscreen();
    var w = new Worker("bg-worker.js");

    w.postMessage(
      {
        type: "init",
        canvas: oc,
        w: innerWidth,
        h: innerHeight,
        dpr: devicePixelRatio || 1,
      },
      [oc],
    );

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
    /* ── Fallback: load renderer on main thread ──────────────────────── */
    var s = document.createElement("script");
    s.src = "bg-worker.js";
    document.body.appendChild(s);
  }
})();

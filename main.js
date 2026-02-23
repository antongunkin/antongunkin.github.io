const COPY = {
  title: "Hi there 👋",
  description:
    "I’m Anton. I’m a Senior Frontend Engineer in New York building React/Next.js products with a focus on design systems, performance (Core Web Vitals), accessibility, and reliable delivery. I enjoy turning messy problems into clean component architecture, fast pages, and tooling that helps teams ship confidently.",
  links: [
    { name: "LinkedIn", url: "https://www.linkedin.com/in/gunkin" },
    { name: "Resume", url: "https://github.com/antongunkin/resume" },
  ],
  btnOpen: "Say 👋",
  btnClose: "Close",
};

function bg() {
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
      treeLightMin: parseFloat(v("--tree-light-min")),
      treeLightMax: parseFloat(v("--tree-light-max")),
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
        dpr: 1,
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
          dpr: 1,
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
}

function init() {
  var loaded = false;
  let activated = false;
  var toggle = document.getElementById("theme-switch");
  var html = document.documentElement;
  var main = document.querySelector("main");
  var footer = document.querySelector("footer");
  var btn = document.createElement("button");
  var title = document.createElement("h1");
  var desc = document.createElement("p");
  var links = document.createElement("div");

  function activate() {
    if (!activated) {
      activated = true;
      toggle.checked = mq.matches;
      toggle.disabled = false;
      applyTheme(mq.matches);
      btn.removeEventListener("click", activate);
      btn.addEventListener("click", deactivate);
      btn.textContent = COPY.btnClose;

      setTimeout(function () {
        html.classList.add("activated");
        window.scroll({ top: 0, behavior: "smooth" });
      }, 0);
    }
  }

  function deactivate() {
    if (activated) {
      activated = false;
      html.classList.remove("theme-dark", "theme-light", "activated");
      btn.removeEventListener("click", deactivate);
      btn.addEventListener("click", activate);
      btn.textContent = COPY.btnOpen;
    }
  }

  function applyTheme(dark) {
    html.classList.remove("theme-dark", "theme-light");
    html.classList.add(dark ? "theme-dark" : "theme-light");
  }

  function load() {
    if (!loaded) {
      loaded = true;
      btn.textContent = COPY.btnOpen;
      btn.classList.add("btn");
      btn.addEventListener("click", activate);
      footer.appendChild(btn);
      title.textContent = COPY.title;
      desc.textContent = COPY.description;
      main.appendChild(title);
      main.appendChild(desc);
      COPY.links.forEach(function (link) {
        var a = document.createElement("a");
        a.textContent = link.name;
        a.href = link.url;
        a.target = "_blank";
        links.appendChild(a);
      });
      main.appendChild(links);

      setTimeout(function () {
        html.classList.add("loaded");
      }, 400);
    }
  }

  /* OS preference */
  var mq = window.matchMedia("(prefers-color-scheme: dark)");

  /* Manual toggle */
  toggle.addEventListener("change", function () {
    applyTheme(toggle.checked);
  });

  /* React to OS preference changes in real time */
  mq.addEventListener("change", function (e) {
    toggle.checked = e.matches;
    applyTheme(e.matches);
  });

  load();
}

bg();
init();

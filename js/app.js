/* =========================================================
   PROOFS · app
   Content, motion, inline editor, cloud sync
   ========================================================= */
(() => {
  "use strict";

  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => Array.from(context.querySelectorAll(selector));

  const CONFIG = window.PROOFS_CONFIG || {};
  const CLOUD_URL = (CONFIG.supabaseUrl || "").replace(/\/+$/, "");
  const CLOUD_KEY = CONFIG.supabaseAnonKey || "";
  const HAS_CLOUD = /^https?:\/\//.test(CLOUD_URL) && CLOUD_KEY.length > 30;

  const DEMO_KEY = "proofs:demo-content:v1";
  const PASSWORD_KEY = "proofs:admin-password";
  const LOCAL_PASSWORD_KEY = "proofs:admin-password:local";
  const DEFAULT_PASSWORD = "13243546";
  const TRANSITION_KEY = "proofs:transition";
  const MAX_GALLERY = 12;
  const MAX_PAYLOAD = 4_200_000;
  const DAY_INDEX = {
    воскресенье: 0,
    понедельник: 1,
    вторник: 2,
    среда: 3,
    четверг: 4,
    пятница: 5,
    суббота: 6,
  };

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FINE_POINTER =
    window.matchMedia("(pointer: fine)").matches &&
    window.matchMedia("(hover: hover)").matches;
  const PAGE = document.body && document.body.dataset.page === "youth" ? "youth" : "church";
  const IS_CHURCH = PAGE === "church";
  const LOW_POWER = Boolean(
    (navigator.connection && navigator.connection.saveData) ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4)
  );
  if (LOW_POWER) document.documentElement.classList.add("is-low-power");

  const seed = window.PROOFS_SEED || {};
  const state = {
    content: clone(seed),
    snapshot: clone(seed),
    mode: "seed",
    cloudOk: true,
    editing: false,
    dirty: false,
    password: null,
    panel: null,
    pendingImage: null,
    assets: new Map(),
    lightboxIndex: 0,
    lastFocus: null,
    saving: false,
  };

  let revealObserver = null;
  let toastTimer = null;
  let navLastY = 0;
  let menuOpen = false;
  let suppressGalleryClick = false;
  let parallaxFrame = null;
  let mouseFrame = null;

  /* -------------------------------------------------------
     Utilities
     ------------------------------------------------------- */

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function merge(base, extra) {
    if (extra === undefined) return clone(base);
    if (Array.isArray(extra)) return clone(extra);
    if (extra && typeof extra === "object") {
      const out =
        base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
      for (const key of Object.keys(extra)) {
        out[key] = merge(base && base[key], extra[key]);
      }
      return out;
    }
    return extra;
  }

  function getPath(object, path) {
    if (!object || !path) return undefined;
    return path.split(".").reduce((value, part) => {
      if (value === null || value === undefined) return undefined;
      return value[part];
    }, object);
  }

  function setPath(object, path, value) {
    const parts = path.split(".");
    let current = object;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current[part] = value;
        return;
      }
      const nextIsIndex = /^\d+$/.test(parts[index + 1]);
      if (current[part] === undefined || current[part] === null) {
        current[part] = nextIsIndex ? [] : {};
      }
      current = current[part];
    });
  }

  function pageData() {
    if (!IS_CHURCH) return state.content;
    if (!state.content.church || typeof state.content.church !== "object") {
      state.content.church = {};
    }
    return state.content.church;
  }

  function ensureArray(container, key) {
    if (!Array.isArray(container[key])) container[key] = [];
    return container[key];
  }

  function pageSchedule() {
    return ensureArray(pageData(), "schedule");
  }

  function pageEvents() {
    return ensureArray(pageData(), "events");
  }

  function pageGallery() {
    return ensureArray(pageData(), "gallery");
  }

  function pageDefaultTime() {
    return IS_CHURCH ? "10:00" : "18:30";
  }

  function pageDefaultTitle() {
    return IS_CHURCH ? "Воскресное служение" : "Молодёжное служение";
  }

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function uid(prefix = "id") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function pad(number) {
    return String(number).padStart(2, "0");
  }

  function isEditableTarget(target) {
    return Boolean(
      target &&
        (target.closest("input, textarea, select, [contenteditable='true']") ||
          target.isContentEditable)
    );
  }

  function prefersReducedMotion() {
    return REDUCED;
  }

  /* -------------------------------------------------------
     Cloud (Supabase REST)
     ------------------------------------------------------- */

  function cloudHeaders() {
    return {
      apikey: CLOUD_KEY,
      Authorization: `Bearer ${CLOUD_KEY}`,
      "Content-Type": "application/json",
    };
  }

  async function readCloudError(response) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      return (
        parsed.message ||
        parsed.error_description ||
        parsed.error ||
        parsed.hint ||
        text.slice(0, 240)
      );
    } catch (error) {
      return text.slice(0, 240) || `HTTP ${response.status}`;
    }
  }

  async function loadCloud() {
    const response = await fetch(
      `${CLOUD_URL}/rest/v1/site_content?id=eq.1&select=data`,
      {
        headers: cloudHeaders(),
        cache: "no-store",
      }
    );
    if (!response.ok) throw new Error(await readCloudError(response));
    const rows = await response.json();
    state.cloudOk = true;
    return rows && rows[0] && rows[0].data ? rows[0].data : null;
  }

  async function verifyAdmin(password) {
    const response = await fetch(`${CLOUD_URL}/rest/v1/rpc/verify_admin`, {
      method: "POST",
      headers: cloudHeaders(),
      body: JSON.stringify({ p_password: password }),
    });
    if (!response.ok) throw new Error(await readCloudError(response));
    const result = await response.json();
    return result === true;
  }

  function getLocalPassword() {
    try {
      return localStorage.getItem(LOCAL_PASSWORD_KEY) || DEFAULT_PASSWORD;
    } catch (error) {
      return DEFAULT_PASSWORD;
    }
  }

  function setLocalPassword(value) {
    try {
      localStorage.setItem(LOCAL_PASSWORD_KEY, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  async function changeCloudPassword(oldPassword, newPassword) {
    const response = await fetch(`${CLOUD_URL}/rest/v1/rpc/change_admin_password`, {
      method: "POST",
      headers: cloudHeaders(),
      body: JSON.stringify({ p_old: oldPassword, p_new: newPassword }),
    });
    if (!response.ok) throw new Error(await readCloudError(response));
    return response.json();
  }

  async function saveCloud(password, data) {
    const response = await fetch(`${CLOUD_URL}/rest/v1/rpc/save_site_content`, {
      method: "POST",
      headers: cloudHeaders(),
      body: JSON.stringify({ p_password: password, p_data: data }),
    });
    if (!response.ok) throw new Error(await readCloudError(response));
    return response.json();
  }

  async function loadContent() {
    if (HAS_CLOUD) {
      try {
        const remote = await loadCloud();
        state.mode = "cloud";
        state.content = remote ? merge(clone(seed), remote) : clone(seed);
        await loadAssets(state.content);
        return;
      } catch (error) {
        state.cloudOk = false;
        console.warn("[PROOFS] Не удалось загрузить облако:", error);
      }
    }

    try {
      const demo = localStorage.getItem(DEMO_KEY);
      if (demo) {
        state.content = merge(clone(seed), JSON.parse(demo));
        state.mode = "local";
        return;
      }
    } catch (error) {
      console.warn("[PROOFS] localStorage недоступен:", error);
    }

    state.mode = "seed";
    state.content = clone(seed);
  }

  function isAssetRef(value) {
    return typeof value === "string" && value.startsWith("asset:");
  }

  function resolveSrc(value) {
    if (!isAssetRef(value)) return value;
    return state.assets.get(value.slice(6)) || "";
  }

  function collectAssetRefs(content) {
    const values = [content?.site?.heroImage, content?.site?.aboutImage];
    (content?.gallery || []).forEach((item) => values.push(item && item.src));
    return values.filter(isAssetRef).map((value) => value.slice(6));
  }

  async function loadAssets(content) {
    const ids = Array.from(new Set(collectAssetRefs(content)));
    if (!ids.length) return;
    try {
      const query = `${CLOUD_URL}/rest/v1/site_assets?id=in.(${ids.join(",")})&select=id,data`;
      const response = await fetch(query, { headers: cloudHeaders(), cache: "no-store" });
      if (!response.ok) throw new Error(await readCloudError(response));
      const rows = await response.json();
      rows.forEach((row) => {
        if (row && row.id && row.data) state.assets.set(row.id, row.data);
      });
    } catch (error) {
      console.warn("[PROOFS] Не удалось загрузить фотографии:", error);
    }
  }

  async function uploadAsset(password, id, data) {
    const response = await fetch(`${CLOUD_URL}/rest/v1/rpc/save_site_asset`, {
      method: "POST",
      headers: cloudHeaders(),
      body: JSON.stringify({ p_password: password, p_id: id, p_data: data }),
    });
    if (!response.ok) throw new Error(await readCloudError(response));
    return response.json();
  }

  /* -------------------------------------------------------
     Rendering content
     ------------------------------------------------------- */

  function applyContent() {
    const content = state.content;

    $$("[data-field]").forEach((element) => {
      const path = element.dataset.field;
      const value = getPath(content, path);
      if (value === undefined || value === null) return;
      if (document.activeElement === element) return;
      element.textContent = String(value);
    });

    $$("[data-ghost]").forEach((element) => {
      const value = getPath(content, element.dataset.ghost);
      if (value) element.textContent = String(value);
    });

    $$("[data-image]").forEach((image) => {
      const path = image.dataset.image;
      const raw = getPath(content, path);
      const src = resolveSrc(raw);
      if (src) setImage(image, src, path, raw);
      const altPath = image.dataset.imageAlt;
      const alt = altPath ? getPath(content, altPath) : null;
      if (alt) image.alt = String(alt);
    });

    $$("[data-href]").forEach((link) => {
      const path = link.dataset.href;
      let value = getPath(content, path);
      if (!value) return;
      value = String(value);
      if (/phoneHref/i.test(path) && !/^(tel:|https?:|mailto:)/i.test(value)) {
        value = `tel:${value.replace(/[^\d+]/g, "")}`;
      }
      link.setAttribute("href", value);
    });

    const year = $("#year");
    if (year) year.textContent = String(new Date().getFullYear());

    renderNextMeeting();
    renderEvents();
    renderGallery();
  }

  function setImage(image, value, path, rawValue = value) {
    image.removeAttribute("srcset");
    image.src = value;
    if (/\.heroImage$/.test(path) && String(rawValue).startsWith("assets/")) {
      image.srcset =
        "assets/img/church-exterior-480.webp 480w, assets/img/church-exterior-900.webp 900w, assets/img/church-exterior-1200.webp 1200w";
    }
  }

  function renderNextMeeting() {
    const schedule = pageSchedule();
    if (!schedule.length) return;

    const now = new Date();
    let next = null;
    let nextItem = null;

    schedule.forEach((item) => {
      const occurrence = nextOccurrence(Number(item.weekday), item.time || pageDefaultTime(), now);
      if (!occurrence) return;
      if (!next || occurrence < next) {
        next = occurrence;
        nextItem = item;
      }
    });

    if (!next || !nextItem) return;

    const time = $("#next-time");
    const day = $("#next-day");
    const date = $("#next-date");
    const title = $("#next-title");
    const relative = $("#next-in");

    if (time) time.textContent = nextItem.time || pageDefaultTime();
    if (day) day.textContent = String(nextItem.day || "").toLowerCase();
    if (date) {
      date.textContent = next.toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
      });
    }
    if (title) title.textContent = nextItem.title || pageDefaultTitle();
    if (relative) relative.textContent = relativeDay(next, now);
  }

  function nextOccurrence(weekday, time, now = new Date()) {
    if (!Number.isFinite(weekday)) return null;
    const [hours, minutes] = String(time || "18:30")
      .split(":")
      .map((part) => Number(part));
    const result = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number.isFinite(hours) ? hours : 18,
      Number.isFinite(minutes) ? minutes : 30,
      0,
      0
    );
    const delta = (weekday - result.getDay() + 7) % 7;
    result.setDate(result.getDate() + delta);
    if (result.getTime() <= now.getTime()) result.setDate(result.getDate() + 7);
    return result;
  }

  function relativeDay(target, now) {
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    const days = Math.round((b - a) / 86_400_000);
    if (days <= 0) return "сегодня";
    if (days === 1) return "завтра";
    if (days >= 2 && days <= 4) return `через ${days} дня`;
    return `через ${days} дней`;
  }

  function parseEventDate(event) {
    if (!event || !event.date) return null;
    const parts = String(event.date).split("-").map(Number);
    if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) {
      return null;
    }
    const [year, month, day] = parts;
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function eventTimestamp(event) {
    const date = parseEventDate(event);
    if (!date) return 0;
    const [hours, minutes] = String(event.time || "18:30")
      .split(":")
      .map(Number);
    date.setHours(Number.isFinite(hours) ? hours : 18, Number.isFinite(minutes) ? minutes : 30, 0, 0);
    return date.getTime();
  }

  function renderEvents() {
    const list = $("#events-list");
    const empty = $("#events-empty");
    if (!list || !empty) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const events = (pageEvents())
      .map((event) => ({ ...event }))
      .filter((event) => {
        const date = parseEventDate(event);
        return date && date.getTime() >= today;
      })
      .sort((a, b) => eventTimestamp(a) - eventTimestamp(b));

    list.replaceChildren();

    if (!events.length) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }

    list.hidden = false;
    empty.hidden = true;

    events.forEach((event) => {
      const date = parseEventDate(event);
      const day = String(date.getDate());
      const month = date
        .toLocaleDateString("ru-RU", { month: "short" })
        .replace(".", "");
      const weekday = date.toLocaleDateString("ru-RU", { weekday: "short" });
      const tag = (event.tag || weekday).trim();

      const row = make("article", "event");

      const dateBlock = make("div", "event__date");
      dateBlock.appendChild(make("span", "event__day", day));
      const monthBlock = make("div", "event__month");
      monthBlock.appendChild(make("b", null, month));
      monthBlock.appendChild(make("span", null, weekday));
      dateBlock.appendChild(monthBlock);

      const body = make("div", "event__body");
      if (tag) body.appendChild(make("span", "event__tag", tag));
      body.appendChild(make("h3", "event__title", event.title || "Событие"));
      if (event.desc) body.appendChild(make("p", "event__desc", event.desc));

      const side = make("div", "event__side");
      side.appendChild(make("span", "event__time", event.time || "18:30"));
      side.appendChild(make("span", null, event.place || "Быхов, Громова, 17"));
      side.appendChild(make("span", "event__arrow", "↗"));

      row.append(dateBlock, body, side);
      list.appendChild(row);
    });
  }

  function renderGallery() {
    const track = $("#gallery-track");
    if (!track) return;
    track.replaceChildren();

    const gallery = pageGallery();
    gallery.forEach((item, index) => {
      if (!item || !item.src) return;
      const src = resolveSrc(item.src);
      if (!src) return;
      const card = make("figure", "gallery-card");
      card.dataset.galleryIndex = String(index);
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute(
        "aria-label",
        `Открыть фото: ${item.caption || item.alt || (IS_CHURCH ? "Свет Миру" : "PROOFS")}`
      );
      card.dataset.cursorLabel = "открыть";

      const media = make("div", "gallery-card__media");
      const image = document.createElement("img");
      image.src = src;
      image.alt = item.alt || item.caption || (IS_CHURCH ? "Свет Миру" : "PROOFS");
      image.loading = "lazy";
      image.decoding = "async";
      media.appendChild(image);

      const caption = make("figcaption", "gallery-card__caption");
      caption.appendChild(make("span", null, item.caption || "PROOFS"));
      caption.appendChild(make("span", null, pad(index + 1)));
      card.append(media, caption);
      track.appendChild(card);
    });
  }

  /* -------------------------------------------------------
     Loader + reveals
     ------------------------------------------------------- */

  function boot() {
    let pageLoaded = document.readyState === "complete";
    let contentLoaded = false;
    let exiting = false;

    const loader = $("#loader");
    const counter = $("#loader-count");
    const startedAt = performance.now();

    loadContent()
      .then(() => {
        contentLoaded = true;
        if (exiting) applyContent();
        tryExit();
      })
      .catch((error) => {
        console.error("[PROOFS] Ошибка загрузки контента:", error);
        contentLoaded = true;
        tryExit();
      });

    window.addEventListener(
      "load",
      () => {
        pageLoaded = true;
        tryExit();
      },
      { once: true }
    );

    window.setTimeout(() => {
      contentLoaded = true;
      tryExit();
    }, 2200);

    function tryExit() {
      if (exiting) return;
      if (!pageLoaded || !contentLoaded) return;
      exiting = true;
      applyContent();
      startExit();
    }

    function startExit() {
      if (!loader || !counter) {
        document.body.classList.remove("is-loading");
        document.body.classList.add("is-loaded");
        startReveals();
        return;
      }

      const duration = REDUCED ? 0 : Math.max(520, 900 - (performance.now() - startedAt));
      counter.textContent = "00";

      if (duration === 0) {
        finishExit();
        return;
      }

      const start = performance.now();
      const tick = (now) => {
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        counter.textContent = pad(Math.round(eased * 100));
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          finishExit();
        }
      };
      requestAnimationFrame(tick);
    }

    function finishExit() {
      if (!loader) return;
      counter.textContent = "100";
      loader.classList.add("is-done");
      document.body.classList.remove("is-loading");
      document.body.classList.add("is-loaded");

      window.setTimeout(() => {
        loader.hidden = true;
        startReveals();
      }, REDUCED ? 0 : 1100);

      if (!REDUCED) {
        window.setTimeout(() => {
          updateParallax();
        }, 1200);
      }

    }
  }

  function startReveals() {
    const elements = $$("[data-reveal]");
    if (REDUCED || !("IntersectionObserver" in window)) {
      elements.forEach((element) => element.classList.add("is-in"));
      return;
    }

    $$(".hero [data-reveal]").forEach((element, index) => {
      element.style.setProperty("--d", `${0.08 + index * 0.06}s`);
    });

    revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -7% 0px" }
    );

    elements.forEach((element) => revealObserver.observe(element));
  }

  /* -------------------------------------------------------
     Navigation, menu, scroll
     ------------------------------------------------------- */

  function initNav() {
    const nav = $("#nav");
    const burger = $("#burger");
    const menu = $("#mobile-menu");

    if (burger) {
      burger.addEventListener("click", () => {
        menuOpen = !menuOpen;
        document.body.classList.toggle("menu-open", menuOpen);
        burger.setAttribute("aria-expanded", String(menuOpen));
        burger.setAttribute("aria-label", menuOpen ? "Закрыть меню" : "Открыть меню");
        if (menu) menu.setAttribute("aria-hidden", String(!menuOpen));
        updateLock();
      });
    }

    if (menu) {
      $$("a", menu).forEach((link) => {
        link.addEventListener("click", (event) => {
          if (state.editing && event.target.closest("[data-field]")) return;
          closeMenu();
        });
      });
    }

    const updateScroll = () => {
      const y = window.scrollY || window.pageYOffset;
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      const progress = Math.min(1, Math.max(0, y / max));
      const bar = $("#scroll-progress");
      if (bar) bar.style.transform = `scaleX(${progress})`;

      if (nav) {
        nav.classList.toggle("is-scrolled", y > 28);
        if (!menuOpen && y > 560 && y > navLastY + 4) {
          nav.classList.add("is-hidden");
        } else if (y < navLastY - 4 || y < 240) {
          nav.classList.remove("is-hidden");
        }
      }
      navLastY = y;
    };

    window.addEventListener("scroll", updateScroll, { passive: true });
    window.addEventListener("resize", updateScroll);
    updateScroll();

    document.addEventListener(
      "click",
      (event) => {
        const link = event.target.closest('a[href^="#"]');
        if (!link) return;
        if (state.editing && event.target.closest("[data-field]")) return;
        const href = link.getAttribute("href");
        if (!href || href === "#") return;
        const target = document.querySelector(href);
        if (!target) return;
        event.preventDefault();
        closeMenu();
        target.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "start",
        });
        history.pushState(null, "", href);
      },
      true
    );
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    document.body.classList.remove("menu-open");
    const burger = $("#burger");
    const menu = $("#mobile-menu");
    if (burger) {
      burger.setAttribute("aria-expanded", "false");
      burger.setAttribute("aria-label", "Открыть меню");
    }
    if (menu) menu.setAttribute("aria-hidden", "true");
    updateLock();
  }

  /* -------------------------------------------------------
     Motion: cursor, magnetic, parallax
     ------------------------------------------------------- */

  function initCursor() {
    if (!FINE_POINTER || REDUCED || LOW_POWER) return;
    const cursor = $("#cursor");
    if (!cursor) return;

    document.body.classList.add("has-cursor");

    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;

    const move = (event) => {
      mouseX = event.clientX;
      mouseY = event.clientY;
      cursor.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0)`;
    };

    window.addEventListener("mousemove", move, { passive: true });
    cursor.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0)`;

    document.addEventListener("mouseover", (event) => {
      const target = event.target.closest("a, button, [data-cursor], [data-cursor-label]");
      if (!target) {
        cursor.classList.remove("is-link", "has-label");
        return;
      }
      cursor.classList.add("is-link");
      const label = target.dataset.cursorLabel || "";
      const labelNode = $(".cursor__label", cursor);
      if (label && labelNode) {
        labelNode.textContent = label;
        cursor.classList.add("has-label");
      } else {
        cursor.classList.remove("has-label");
      }
    });

    document.addEventListener("mousedown", () => cursor.classList.add("is-down"));
    document.addEventListener("mouseup", () => cursor.classList.remove("is-down"));
    document.addEventListener("mouseleave", () => {
      cursor.style.opacity = "0";
    });
    document.addEventListener("mouseenter", () => {
      cursor.style.opacity = "1";
    });
  }

  function initMagnetic() {
    if (!FINE_POINTER || REDUCED || LOW_POWER) return;
    $$("[data-magnetic]").forEach((element) => {
      const strength = 7;
      element.addEventListener("mousemove", (event) => {
        const rect = element.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width - 0.5) * strength;
        const y = ((event.clientY - rect.top) / rect.height - 0.5) * strength;
        element.style.transform = `translate(${x}px, ${y}px)`;
      });
      element.addEventListener("mouseleave", () => {
        element.style.transform = "";
      });
    });
  }

  function updateParallax() {
    if (REDUCED || LOW_POWER) return;
    const viewport = window.innerHeight;
    $$("[data-parallax]").forEach((element) => {
      const rect = element.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const offset = (center - viewport / 2) * Number(element.dataset.parallax || 0.05);
      const clamped = Math.max(-52, Math.min(52, offset * -1));
      element.style.transform = `translate3d(0, ${clamped}px, 0)`;
    });
  }

  function initParallax() {
    if (REDUCED || LOW_POWER) return;
    const onScroll = () => {
      if (parallaxFrame) return;
      parallaxFrame = requestAnimationFrame(() => {
        updateParallax();
        parallaxFrame = null;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    updateParallax();
  }

  function initMouseParallax() {
    if (!FINE_POINTER || REDUCED || LOW_POWER) return;
    const element = $("[data-mouse]");
    if (!element) return;

    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let active = false;

    const loop = () => {
      x += (targetX - x) * 0.06;
      y += (targetY - y) * 0.06;
      element.style.transform = `translate3d(${x * 13}px, ${y * 9}px, 0)`;
      if (Math.abs(x - targetX) > 0.001 || Math.abs(y - targetY) > 0.001) {
        requestAnimationFrame(loop);
      } else {
        active = false;
      }
    };

    window.addEventListener(
      "mousemove",
      (event) => {
        targetX = (event.clientX / window.innerWidth - 0.5) * 2;
        targetY = (event.clientY / window.innerHeight - 0.5) * 2;
        if (!active) {
          active = true;
          requestAnimationFrame(loop);
        }
      },
      { passive: true }
    );
  }

  /* -------------------------------------------------------
     Gallery: drag, lightbox
     ------------------------------------------------------- */

  function initGallery() {
    const track = $("#gallery-track");
    if (!track) return;

    let dragging = false;
    let startX = 0;
    let startScroll = 0;
    let moved = false;
    let pointerId = null;
    let lastX = 0;
    let lastTime = 0;
    let velocity = 0;
    let inertiaFrame = null;

    const stopInertia = () => {
      if (inertiaFrame) cancelAnimationFrame(inertiaFrame);
      inertiaFrame = null;
    };

    track.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      stopInertia();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startScroll = track.scrollLeft;
      lastX = event.clientX;
      lastTime = performance.now();
      velocity = 0;
      pointerId = event.pointerId;
      track.classList.add("is-dragging");
    });

    track.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const delta = event.clientX - startX;
      if (Math.abs(delta) > 5) {
        moved = true;
        if (pointerId !== null && !track.hasPointerCapture(pointerId)) {
          track.setPointerCapture(pointerId);
        }
      }
      track.scrollLeft = startScroll - delta;
      const now = performance.now();
      const dt = now - lastTime;
      if (dt > 0) velocity = (event.clientX - lastX) / dt;
      lastX = event.clientX;
      lastTime = now;
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("is-dragging");
      if (pointerId !== null && track.hasPointerCapture(pointerId)) {
        track.releasePointerCapture(pointerId);
      }
      pointerId = null;
      if (moved) {
        suppressGalleryClick = true;
        window.setTimeout(() => {
          suppressGalleryClick = false;
        }, 80);
        const decay = () => {
          velocity *= 0.94;
          track.scrollLeft -= velocity * 16;
          if (Math.abs(velocity) > 0.02) {
            inertiaFrame = requestAnimationFrame(decay);
          }
        };
        inertiaFrame = requestAnimationFrame(decay);
      }
    };

    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    track.addEventListener("pointerleave", (event) => {
      if (dragging && event.pointerType === "mouse") endDrag();
    });

    track.addEventListener(
      "click",
      (event) => {
        if (!suppressGalleryClick) return;
        event.preventDefault();
        event.stopPropagation();
        suppressGalleryClick = false;
      },
      true
    );

    track.addEventListener("click", (event) => {
      if (state.editing) return;
      const card = event.target.closest(".gallery-card");
      if (!card) return;
      const index = Number(card.dataset.galleryIndex);
      if (Number.isFinite(index)) openLightbox(index);
    });

    track.addEventListener("keydown", (event) => {
      const card = event.target.closest(".gallery-card");
      if (card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openLightbox(Number(card.dataset.galleryIndex));
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const amount = Math.min(380, track.clientWidth * 0.7);
        track.scrollBy({
          left: event.key === "ArrowRight" ? amount : -amount,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      }
    });

    window.addEventListener("resize", stopInertia);
  }

  function openLightbox(index) {
    const gallery = pageGallery();
    if (!gallery.length) return;
    state.lightboxIndex = ((index % gallery.length) + gallery.length) % gallery.length;
    const item = gallery[state.lightboxIndex];
    if (!item) return;
    const src = resolveSrc(item.src);
    if (!src) return;

    state.lastFocus = document.activeElement;
    const lightbox = $("#lightbox");
    const image = $("#lightbox-img");
    const caption = $("#lightbox-caption");
    if (!lightbox || !image) return;

    image.src = src;
    image.alt = item.alt || item.caption || (IS_CHURCH ? "Свет Миру" : "PROOFS");
    if (caption) caption.textContent = item.caption || "";
    lightbox.hidden = false;
    lightbox.setAttribute("aria-hidden", "false");
    updateLock();
    const close = $(".lightbox__close", lightbox);
    if (close) close.focus({ preventScroll: true });
  }

  function closeLightbox() {
    const lightbox = $("#lightbox");
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    lightbox.setAttribute("aria-hidden", "true");
    updateLock();
    if (state.lastFocus && typeof state.lastFocus.focus === "function") {
      state.lastFocus.focus({ preventScroll: true });
    }
    state.lastFocus = null;
  }

  function stepLightbox(direction) {
    const gallery = pageGallery();
    if (!gallery.length) return;
    openLightbox(state.lightboxIndex + direction);
  }

  function initLightbox() {
    const lightbox = $("#lightbox");
    if (!lightbox) return;
    $$("[data-lightbox-close]", lightbox).forEach((element) => {
      element.addEventListener("click", closeLightbox);
    });
    const prev = $("#lightbox-prev");
    const next = $("#lightbox-next");
    if (prev) prev.addEventListener("click", () => stepLightbox(-1));
    if (next) next.addEventListener("click", () => stepLightbox(1));
  }

  /* -------------------------------------------------------
     Calendar
     ------------------------------------------------------- */

  function initCalendar() {
    $$("[data-calendar]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const index = Number(button.dataset.calendar);
        downloadCalendar(index);
      });
    });
  }

  function downloadCalendar(index) {
    const item = pageSchedule()[index];
    if (!item) return;

    const next = nextOccurrence(Number(item.weekday), item.time, new Date());
    if (!next) return;

    const end = new Date(next.getTime() + 2 * 60 * 60 * 1000);
    const stamp = new Date();
    const byDay = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][Number(item.weekday)] || "SU";

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//PROOFS//Svet Miru Bykhov//RU",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-TIMEZONE:Europe/Minsk",
      "BEGIN:VEVENT",
      `UID:proofs-${item.id || index}-${Date.now()}@proofs.eu.org`,
      `DTSTAMP:${icsDate(stamp)}T${icsTime(stamp)}`,
      `DTSTART;TZID=Europe/Minsk:${icsDate(next)}T${icsTime(next)}`,
      `DTEND;TZID=Europe/Minsk:${icsDate(end)}T${icsTime(end)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${byDay}`,
      `SUMMARY:${escapeIcs(item.title || "PROOFS")}`,
      `DESCRIPTION:${escapeIcs(
        `${item.desc || ""}\\n\\nЦерковь «Свет Миру», Быхов, ул. Громова, 17`
      )}`,
      "LOCATION:Быхов\\, ул. Громова\\, 17",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `proofs-${item.id || index}.ics`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast("Файл календаря скачан.");
  }

  function icsDate(date) {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  function icsTime(date) {
    return `${pad(date.getHours())}${pad(date.getMinutes())}00`;
  }

  function escapeIcs(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  }

  /* -------------------------------------------------------
     Inline editor
     ------------------------------------------------------- */

  function initInlineEditor() {
    document.addEventListener("input", (event) => {
      if (!state.editing) return;
      const element = event.target.closest("[data-field]");
      if (!element) return;
      const path = element.dataset.field;
      const value = element.innerText.replace(/\u00a0/g, " ");
      setPath(state.content, path, value);

      const phoneField = /(?:^|\.)phone$/i.test(path) || /womenPhone$/i.test(path);
      if (phoneField) {
        const tel = value.replace(/[^\d+]/g, "");
        const hrefPath = `${path}Href`;
        setPath(state.content, hrefPath, `tel:${tel}`);
        $$("[data-href]").forEach((link) => {
          if (link.dataset.href === hrefPath) link.setAttribute("href", `tel:${tel}`);
        });
      }

      const dayMatch = path.match(/^(?:church\.)?schedule\.(\d+)\.day$/);
      if (dayMatch) {
        const item = pageSchedule()[Number(dayMatch[1])];
        const weekday = DAY_INDEX[value.trim().toLowerCase()];
        if (item && weekday !== undefined) item.weekday = weekday;
      }

      $$("[data-field]").forEach((other) => {
        if (other === element) return;
        if (other.dataset.field === path) other.textContent = value;
      });

      if (path === "site.heroTitle") {
        const ghost = $("[data-ghost='site.heroTitle']");
        if (ghost) ghost.textContent = value;
      }

      if (element.dataset.href) {
        let href = getPath(state.content, element.dataset.href);
        if (href) {
          href = String(href);
          if (/phoneHref/i.test(element.dataset.href) && !/^(tel:|https?:|mailto:)/i.test(href)) {
            href = `tel:${href.replace(/[^\d+]/g, "")}`;
          }
          element.setAttribute("href", href);
        }
      }

      if (/schedule\./.test(path)) renderNextMeeting();
      markDirty();
    });

    document.addEventListener("keydown", (event) => {
      if (!state.editing) return;
      const element = event.target.closest("[data-field]");
      if (!element) return;
      if (event.key === "Enter" && !event.shiftKey && /^(H1|H2|H3|H4|A)$/.test(element.tagName)) {
        event.preventDefault();
        element.blur();
      }
    });

    document.addEventListener(
      "paste",
      (event) => {
        if (!state.editing) return;
        const element = event.target.closest("[data-field]");
        if (!element) return;
        event.preventDefault();
        const text = (event.clipboardData || window.clipboardData).getData("text/plain");
        document.execCommand("insertText", false, text);
      },
      true
    );

    document.addEventListener(
      "click",
      (event) => {
        if (!state.editing) return;
        const image = event.target.closest("[data-image]");
        if (image) {
          event.preventDefault();
          event.stopPropagation();
          state.pendingImage = { type: "field", path: image.dataset.image };
          const input = $("#image-input");
          if (input) {
            input.value = "";
            input.click();
          }
          return;
        }
        const field = event.target.closest("[data-field]");
        if (field && field.closest("a")) {
          event.preventDefault();
        }
      },
      true
    );
  }

  function enterEdit(mode) {
    state.editing = true;
    state.mode = mode === "cloud" ? "cloud" : "local";
    state.snapshot = clone(state.content);
    state.dirty = false;

    closeMenu();
    document.body.classList.add("is-editing");
    $$("[data-field]").forEach((element) => {
      if (!element.dataset.placeholder) {
        element.dataset.placeholder = element.textContent.trim().slice(0, 48) || "Текст";
      }
      element.setAttribute("contenteditable", "true");
      element.setAttribute("spellcheck", "false");
    });

    const bar = $("#admin-bar");
    if (bar) {
      bar.hidden = false;
      bar.setAttribute("aria-hidden", "false");
    }
    const modeLabel = $("#admin-mode");
    if (modeLabel) {
      modeLabel.textContent = state.mode === "cloud" ? "облако" : "локально";
      modeLabel.classList.toggle("is-local", state.mode !== "cloud");
    }

    updateLock();
    showToast(
      state.mode === "cloud"
        ? "Редактор включён. Кликай по тексту и фото, чтобы менять. В конце — «Опубликовать»."
        : "Локальный режим: кликай по тексту и фото. Правки сохранятся только в этом браузере.",
      state.mode === "cloud" ? "" : "warn"
    );
  }

  function exitEdit() {
    if (!state.editing) return;
    if (state.dirty) {
      const ok = window.confirm(
        "Выйти без публикации? Неопубликованные правки будут потеряны."
      );
      if (!ok) return;
      state.content = clone(state.snapshot);
      applyContent();
    }

    state.editing = false;
    state.dirty = false;
    state.password = null;
    state.pendingImage = null;
    try {
      sessionStorage.removeItem(PASSWORD_KEY);
    } catch (error) {
      /* no-op */
    }

    document.body.classList.remove("is-editing");
    $$("[data-field]").forEach((element) => {
      element.removeAttribute("contenteditable");
      element.removeAttribute("spellcheck");
    });
    const bar = $("#admin-bar");
    if (bar) {
      bar.hidden = true;
      bar.setAttribute("aria-hidden", "true");
    }
    closePanel();
    updateLock();
    showToast("Режим редактирования выключен.");
  }

  function markDirty() {
    if (!state.editing) return;
    state.dirty = true;
    const save = $('[data-admin-action="save"]');
    if (save) save.classList.add("has-changes");
  }

  function initAdminBar() {
    const bar = $("#admin-bar");
    if (!bar) return;

    bar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-admin-action]");
      if (!button) return;
      const action = button.dataset.adminAction;
      if (action === "events") openPanel("events");
      if (action === "gallery") openPanel("gallery");
      if (action === "password") openPanel("password");
      if (action === "save") saveContent();
      if (action === "exit") exitEdit();
    });

    window.addEventListener("beforeunload", (event) => {
      if (!state.editing || !state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });

    document.addEventListener("keydown", (event) => {
      if (!state.editing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveContent();
      }
    });
  }

  /* -------------------------------------------------------
     Save
     ------------------------------------------------------- */

  async function saveContent() {
    if (!state.editing || state.saving) return;

    const events = (pageEvents())
      .map((event) => ({
        ...event,
        id: event.id || uid("event"),
        title: String(event.title || "").trim(),
        desc: String(event.desc || "").trim(),
        tag: String(event.tag || "").trim(),
        place: String(event.place || "").trim(),
      }))
      .filter((event) => event.title || event.desc || event.date);

    for (const event of events) {
      if (!event.title || !event.date) {
        showToast("У события должны быть дата и название. Проверь раздел «События».", "error");
        openPanel("events");
        return;
      }
    }

    events.sort((a, b) => eventTimestamp(a) - eventTimestamp(b));
    pageData().events = events;

    const payload = JSON.stringify(state.content);
    if (payload.length > MAX_PAYLOAD) {
      showToast(
        "Слишком много фото для публикации. Удали пару кадров или замени их на ссылки.",
        "error"
      );
      return;
    }

    if (state.mode === "local") {
      try {
        localStorage.setItem(DEMO_KEY, payload);
      } catch (error) {
        showToast("Не хватает места в браузере. Удали пару фото и попробуй снова.", "error");
        return;
      }
      state.dirty = false;
      state.snapshot = clone(state.content);
      applyContent();
      showToast("Сохранено локально. Чтобы правки видели все, подключи Supabase (ADMIN.md).", "warn");
      return;
    }

    let password = state.password;
    if (!password) {
      try {
        password = sessionStorage.getItem(PASSWORD_KEY);
      } catch (error) {
        password = null;
      }
    }
    if (!password) {
      openGate();
      return;
    }

    setSaving(true);
    try {
      await saveCloud(password, state.content);
      state.password = password;
      state.dirty = false;
      state.snapshot = clone(state.content);
      applyContent();
      showToast("Опубликовано. Изменения уже видят все посетители.");
    } catch (error) {
      console.error("[PROOFS] Ошибка сохранения:", error);
      const message = String(error.message || error);
      if (/password|парол/i.test(message)) {
        state.password = null;
        showToast("Пароль не подошёл. Войди в редактор заново.", "error");
      } else if (/function|schema|relation|does not exist/i.test(message)) {
        showToast("База ещё не настроена. Выполни SQL из ADMIN.md.", "error");
      } else {
        showToast("Не удалось сохранить. Проверь интернет и попробуй снова.", "error");
      }
    } finally {
      setSaving(false);
    }
  }

  function setSaving(isSaving) {
    state.saving = isSaving;
    const button = $('[data-admin-action="save"]');
    if (!button) return;
    button.disabled = isSaving;
    button.setAttribute("aria-busy", String(isSaving));
    if (isSaving) {
      button.dataset.originalText = button.textContent;
      button.textContent = "Публикую…";
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
    }
  }

  function initImageInput() {
    const input = $("#image-input");
    if (!input) return;

    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      const pending = state.pendingImage;
      if (!file || !pending) {
        input.value = "";
        return;
      }
      if (!file.type.startsWith("image/")) {
        showToast("Это не похоже на изображение.", "error");
        input.value = "";
        return;
      }
      if (file.size > 18 * 1024 * 1024) {
        showToast("Файл слишком большой. Максимум 18 МБ.", "error");
        input.value = "";
        return;
      }

      showToast("Обрабатываю фото…");
      try {
        const maxSize = pending.type === "field" ? 1600 : 1200;
        const limit = pending.type === "field" ? 430_000 : 320_000;
        const data = await compressImage(file, maxSize, limit);
        let source = data;

        if (state.mode === "cloud") {
          const password = state.password;
          if (!password) {
            openGate();
            return;
          }
          const assetId = uid("asset");
          showToast("Загружаю фото в облако…");
          await uploadAsset(password, assetId, data);
          state.assets.set(assetId, data);
          source = `asset:${assetId}`;
        }

        if (pending.type === "field") {
          setPath(state.content, pending.path, source);
          $$("[data-image]").forEach((image) => {
            if (image.dataset.image === pending.path) {
              setImage(image, data, pending.path, source);
            }
          });
          markDirty();
          showToast("Фото обновлено. Не забудь нажать «Опубликовать».");
        }

        if (pending.type === "gallery-add") {
          if (pageGallery().length >= MAX_GALLERY) {
            showToast(`Максимум ${MAX_GALLERY} фото в галерее.`, "warn");
          } else {
            pageGallery().push({
              id: uid("photo"),
              src: source,
              alt: "Фото PROOFS",
              caption: "",
            });
            renderGallery();
            renderPanel();
            markDirty();
            showToast("Фото добавлено. Подпиши его и опубликуй.");
          }
        }

        if (pending.type === "gallery-replace") {
          const item = pageGallery()[pending.index];
          if (item) {
            item.src = source;
            renderGallery();
            renderPanel();
            markDirty();
            showToast("Фото заменено. Не забудь нажать «Опубликовать».");
          }
        }
      } catch (error) {
        console.error("[PROOFS] Не удалось обработать фото:", error);
        showToast(
          state.mode === "cloud"
            ? "Не удалось загрузить фото. Проверь интернет и попробуй снова."
            : "Не удалось обработать фото. Попробуй другой файл.",
          "error"
        );
      } finally {
        state.pendingImage = null;
        input.value = "";
      }
    });
  }

  function compressImage(file, maxSide, limit) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        try {
          let scale = Math.min(1, maxSide / Math.max(image.width, image.height));
          let quality = 0.8;
          let data = "";
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");

          for (let attempt = 0; attempt < 5; attempt += 1) {
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            context.fillStyle = "#f2ede4";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            data = canvas.toDataURL("image/webp", quality);
            if (!data.startsWith("data:image/webp")) {
              data = canvas.toDataURL("image/jpeg", quality);
            }
            if (data.length <= limit) break;
            scale *= 0.82;
            quality = Math.max(0.44, quality - 0.09);
          }

          URL.revokeObjectURL(url);
          resolve(data);
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Image load failed"));
      };
      image.src = url;
    });
  }

  /* -------------------------------------------------------
     Admin panels
     ------------------------------------------------------- */

  function initPanel() {
    const panel = $("#admin-panel");
    const body = $("#panel-body");
    if (!panel || !body) return;

    $$("[data-panel-close]", panel).forEach((element) => {
      element.addEventListener("click", closePanel);
    });

    body.addEventListener("click", (event) => {
      const addEvent = event.target.closest("[data-events-add]");
      if (addEvent) {
        pageEvents().push({
          id: uid("event"),
          date: isoDate(nextOccurrence(0, pageDefaultTime(), new Date())),
          time: pageDefaultTime(),
          title: "",
          desc: "",
          tag: "",
          place: "Быхов, ул. Громова, 17",
        });
        renderPanel();
        markDirty();
        return;
      }

      const deleteEvent = event.target.closest("[data-event-delete]");
      if (deleteEvent) {
        const index = Number(deleteEvent.dataset.eventDelete);
        if (Number.isFinite(index) && pageEvents()[index]) {
          if (window.confirm("Удалить это событие?")) {
            pageEvents().splice(index, 1);
            renderPanel();
            markDirty();
          }
        }
        return;
      }

      const addPhoto = event.target.closest("[data-gallery-add]");
      if (addPhoto) {
        if (pageGallery().length >= MAX_GALLERY) {
          showToast(`Максимум ${MAX_GALLERY} фото.`, "warn");
          return;
        }
        state.pendingImage = { type: "gallery-add" };
        const input = $("#image-input");
        if (input) {
          input.value = "";
          input.click();
        }
        return;
      }

      const move = event.target.closest("[data-gallery-move]");
      if (move) {
        const index = Number(move.dataset.galleryMove);
        const direction = Number(move.dataset.galleryDirection);
        const gallery = pageGallery();
        const target = index + direction;
        if (gallery && gallery[index] && gallery[target]) {
          [gallery[index], gallery[target]] = [gallery[target], gallery[index]];
          renderGallery();
          renderPanel();
          markDirty();
        }
        return;
      }

      const replace = event.target.closest("[data-gallery-replace]");
      if (replace) {
        const index = Number(replace.dataset.galleryReplace);
        if (Number.isFinite(index)) {
          state.pendingImage = { type: "gallery-replace", index };
          const input = $("#image-input");
          if (input) {
            input.value = "";
            input.click();
          }
        }
        return;
      }

      const remove = event.target.closest("[data-gallery-delete]");
      if (remove) {
        const index = Number(remove.dataset.galleryDelete);
        if (Number.isFinite(index) && window.confirm("Удалить это фото?")) {
          pageGallery().splice(index, 1);
          renderGallery();
          renderPanel();
          markDirty();
        }
      }
    });

    body.addEventListener("input", (event) => {
      const eventField = event.target.closest("[data-event-field]");
      if (eventField) {
        const index = Number(eventField.dataset.eventIndex);
        const key = eventField.dataset.eventField;
        const item = pageEvents()[index];
        if (item && key) {
          item[key] = eventField.value;
          markDirty();
        }
        return;
      }

      const caption = event.target.closest("[data-gallery-caption]");
      if (caption) {
        const index = Number(caption.dataset.galleryCaption);
        const item = pageGallery()[index];
        if (item) {
          item.caption = caption.value;
          markDirty();
        }
      }
    });
  }

  function openPanel(kind) {
    if (!state.editing) return;
    hideToast();
    state.panel = kind;
    const panel = $("#admin-panel");
    if (!panel) return;
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    const note = $("#panel-note");
    if (note) {
      note.textContent = kind === "password"
        ? "Пароль меняется сразу — публиковать не нужно."
        : "Изменения применятся после «Опубликовать».";
    }
    renderPanel();
    updateLock();
    const close = $(".panel__close", panel);
    if (close) close.focus({ preventScroll: true });
  }

  function closePanel() {
    const panel = $("#admin-panel");
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    state.panel = null;
    updateLock();
  }

  function renderPanel() {
    const body = $("#panel-body");
    const title = $("#panel-title");
    if (!body || !title || !state.panel) return;

    body.replaceChildren();

    if (state.panel === "events") {
      title.textContent = "События";
      renderEventsPanel(body);
    } else if (state.panel === "gallery") {
      title.textContent = "Фотографии";
      renderGalleryPanel(body);
    } else if (state.panel === "password") {
      title.textContent = "Пароль";
      renderPasswordPanel(body);
    }
  }

  function renderPasswordPanel(body) {
    const cloud = state.mode === "cloud";
    body.appendChild(
      make(
        "p",
        "panel__empty",
        cloud
          ? "Пароль хранится в Supabase в виде bcrypt-хеша. Смена сразу применится к следующему входу."
          : "Сейчас локальный режим. Новый пароль сохранится в этом браузере."
      )
    );

    const form = document.createElement("form");
    form.className = "password-form";
    form.innerHTML = `
      <label class="field">
        <span>Текущий пароль</span>
        <input type="password" name="current" autocomplete="current-password" required />
      </label>
      <label class="field">
        <span>Новый пароль</span>
        <input type="password" name="next" autocomplete="new-password" minlength="6" maxlength="200" required />
      </label>
      <label class="field">
        <span>Повторите новый пароль</span>
        <input type="password" name="repeat" autocomplete="new-password" minlength="6" maxlength="200" required />
      </label>
      <p class="gate__error" data-password-error role="alert"></p>
      <button class="btn btn--primary btn--small" type="submit"><span>Сменить пароль</span></button>
    `;
    body.appendChild(form);

    const error = $("[data-password-error]", form);
    const button = $("button[type=submit]", form);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const current = form.elements.current.value.trim();
      const next = form.elements.next.value.trim();
      const repeat = form.elements.repeat.value.trim();

      if (next.length < 6) {
        if (error) error.textContent = "Новый пароль — минимум 6 символов.";
        return;
      }
      if (next !== repeat) {
        if (error) error.textContent = "Новые пароли не совпадают.";
        return;
      }
      if (next === current) {
        if (error) error.textContent = "Новый пароль должен отличаться от текущего.";
        return;
      }
      if (error) error.textContent = "";
      if (button) button.disabled = true;

      try {
        if (cloud) {
          await changeCloudPassword(current, next);
        } else {
          if (current !== getLocalPassword()) {
            if (error) error.textContent = "Текущий пароль не подошёл.";
            return;
          }
          if (!setLocalPassword(next)) {
            if (error) error.textContent = "Браузер не разрешил сохранить пароль.";
            return;
          }
        }

        state.password = next;
        try {
          sessionStorage.setItem(PASSWORD_KEY, next);
        } catch (exception) {
          /* no-op */
        }
        closePanel();
        showToast("Пароль изменён. При следующем входе используйте новый.");
      } catch (exception) {
        console.error("[PROOFS] Ошибка смены пароля:", exception);
        const message = String(exception.message || exception);
        if (error) {
          error.textContent = /password|парол/i.test(message)
            ? "Текущий пароль не подошёл."
            : /function|schema|relation|does not exist/i.test(message)
              ? "База ещё не настроена. Выполни SQL из ADMIN.md."
              : "Не удалось сменить пароль. Проверь интернет и попробуй снова.";
        }
      } finally {
        if (button) button.disabled = false;
      }
    });
  }

  function renderEventsPanel(body) {
    const events = pageEvents();
    const head = make("div", "panel__group-title");
    head.appendChild(
      make(
        "span",
        null,
        `${events.length} ${plural(events.length, "событие", "события", "событий")} · показываются будущие`
      )
    );
    const add = make("button", "btn btn--ghost btn--small", "+ Добавить");
    add.type = "button";
    add.dataset.eventsAdd = "";
    head.appendChild(add);
    body.appendChild(head);

    if (!events.length) {
      body.appendChild(
        make(
          "div",
          "panel__empty",
          "Пока нет событий. Добавь выезд, концерт, адвент или любой другой повод собраться."
        )
      );
      return;
    }

    events.forEach((event, index) => {
      const card = make("div", "event-edit");
      const top = make("div", "event-edit__top");
      top.appendChild(make("span", null, `Событие ${pad(index + 1)}`));
      const remove = make("button", "icon-btn icon-btn--danger", "×");
      remove.type = "button";
      remove.dataset.eventDelete = String(index);
      remove.setAttribute("aria-label", "Удалить событие");
      top.appendChild(remove);
      card.appendChild(top);

      const grid = make("div", "event-edit__grid");
      grid.appendChild(
        fieldInput("Дата", "date", event.date || "", index, "date")
      );
      grid.appendChild(
        fieldInput("Время", "time", event.time || "18:30", index, "time")
      );
      card.appendChild(grid);

      const titleField = fieldInput(
        "Название",
        "text",
        event.title || "",
        index,
        "title",
        true
      );
      card.appendChild(titleField);

      const descField = fieldTextarea(
        "Описание",
        event.desc || "",
        index,
        "desc"
      );
      card.appendChild(descField);

      const metaGrid = make("div", "event-edit__grid");
      metaGrid.appendChild(fieldInput("Метка", "text", event.tag || "", index, "tag"));
      metaGrid.appendChild(fieldInput("Место", "text", event.place || "", index, "place"));
      card.appendChild(metaGrid);

      body.appendChild(card);
    });
  }

  function fieldInput(label, type, value, index, key, full = false) {
    const wrapper = make("label", `field${full ? " event-edit__full" : ""}`);
    wrapper.appendChild(make("span", null, label));
    const input = document.createElement("input");
    input.type = type;
    input.value = value || "";
    input.dataset.eventIndex = String(index);
    input.dataset.eventField = key;
    if (type === "time") input.step = "300";
    wrapper.appendChild(input);
    return wrapper;
  }

  function fieldTextarea(label, value, index, key) {
    const wrapper = make("label", "field event-edit__full");
    wrapper.appendChild(make("span", null, label));
    const textarea = document.createElement("textarea");
    textarea.value = value || "";
    textarea.rows = 3;
    textarea.dataset.eventIndex = String(index);
    textarea.dataset.eventField = key;
    wrapper.appendChild(textarea);
    return wrapper;
  }

  function renderGalleryPanel(body) {
    const gallery = pageGallery();
    const head = make("div", "panel__group-title");
    head.appendChild(make("span", null, `${gallery.length} / ${MAX_GALLERY} фото`));
    const add = make("button", "btn btn--ghost btn--small", "+ Добавить фото");
    add.type = "button";
    add.dataset.galleryAdd = "";
    if (gallery.length >= MAX_GALLERY) add.disabled = true;
    head.appendChild(add);
    body.appendChild(head);

    if (!gallery.length) {
      body.appendChild(
        make(
          "div",
          "panel__empty",
          "Галерея пустая. Добавь фотографии — они появятся в ленте на сайте."
        )
      );
      return;
    }

    const grid = make("div", "gallery-edit");
    gallery.forEach((item, index) => {
      const card = make("div", "gallery-edit__item");
      const thumb = make("div", "gallery-edit__thumb");
      const image = document.createElement("img");
      image.src = resolveSrc(item.src) || "assets/img/church-hall.webp";
      image.alt = item.alt || "PROOFS";
      image.loading = "lazy";
      thumb.appendChild(image);
      card.appendChild(thumb);

      const caption = document.createElement("input");
      caption.type = "text";
      caption.value = item.caption || "";
      caption.placeholder = "Подпись";
      caption.dataset.galleryCaption = String(index);
      card.appendChild(caption);

      const tools = make("div", "gallery-edit__tools");
      const up = make("button", "icon-btn", "←");
      up.type = "button";
      up.dataset.galleryMove = String(index);
      up.dataset.galleryDirection = "-1";
      up.setAttribute("aria-label", "Переместить фото влево");
      up.disabled = index === 0;

      const down = make("button", "icon-btn", "→");
      down.type = "button";
      down.dataset.galleryMove = String(index);
      down.dataset.galleryDirection = "1";
      down.setAttribute("aria-label", "Переместить фото вправо");
      down.disabled = index === gallery.length - 1;

      const replace = make("button", "icon-btn", "↻");
      replace.type = "button";
      replace.dataset.galleryReplace = String(index);
      replace.setAttribute("aria-label", "Заменить фото");

      const remove = make("button", "icon-btn icon-btn--danger", "×");
      remove.type = "button";
      remove.dataset.galleryDelete = String(index);
      remove.setAttribute("aria-label", "Удалить фото");

      tools.append(up, down, replace, remove);
      card.appendChild(tools);
      grid.appendChild(card);
    });
    body.appendChild(grid);
    body.appendChild(
      make(
        "p",
        "panel__note",
        "Фото сжимаются автоматически. На сайте они открываются в полноэкранном просмотре."
      )
    );
  }

  /* -------------------------------------------------------
     Admin gate + secret
     ------------------------------------------------------- */

  function initGate() {
    const gate = $("#admin-gate");
    const form = $("#gate-form");
    const password = $("#gate-password");
    const error = $("#gate-error");
    const local = $("#gate-local");

    if (!gate) return;

    $$("[data-gate-close]", gate).forEach((element) => {
      element.addEventListener("click", closeGate);
    });

    if (form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = password ? password.value.trim() : "";
        if (!value) {
          if (error) error.textContent = "Введите пароль.";
          return;
        }
        if (error) error.textContent = "";
        const submit = $(".gate__submit", form);
        if (submit) {
          submit.disabled = true;
          submit.classList.add("is-loading");
        }
        const cloud = HAS_CLOUD && state.cloudOk;
        try {
          let ok = false;
          if (cloud) {
            ok = await verifyAdmin(value);
          } else {
            ok = value === getLocalPassword();
          }
          if (!ok) {
            if (error) error.textContent = "Пароль не подошёл.";
            gate.classList.add("is-shaking");
            window.setTimeout(() => gate.classList.remove("is-shaking"), 380);
            return;
          }
          state.password = value;
          try {
            sessionStorage.setItem(PASSWORD_KEY, value);
          } catch (exception) {
            /* no-op */
          }
          closeGate();
          enterEdit(cloud ? "cloud" : "local");
        } catch (exception) {
          console.error("[PROOFS] Ошибка входа:", exception);
          const message = String(exception.message || exception);
          if (error) {
            error.textContent = /function|schema|relation|does not exist/i.test(message)
              ? "База ещё не настроена. Выполни SQL из ADMIN.md."
              : "Не удалось связаться с облаком. Проверь интернет.";
          }
        } finally {
          if (submit) {
            submit.disabled = false;
            submit.classList.remove("is-loading");
          }
        }
      });
    }

    const onKey = (event) => {
      if (event.key === "Escape") closeGate();
    };
    document.addEventListener("keydown", onKey);
  }

  function openGate() {
    const gate = $("#admin-gate");
    const form = $("#gate-form");
    const password = $("#gate-password");
    const error = $("#gate-error");
    const local = $("#gate-local");
    const text = $("#gate-text");
    if (!gate) return;

    hideToast();
    closeMenu();

    gate.hidden = false;
    gate.setAttribute("aria-hidden", "false");
    gate.classList.remove("is-shaking");
    if (error) error.textContent = "";
    if (password) password.value = "";

    if (form) form.hidden = false;
    if (local) local.hidden = true;
    if (text) {
      text.textContent =
        HAS_CLOUD && state.cloudOk
          ? "Введите пароль администратора, чтобы менять текст, фотографии и события прямо на сайте."
          : "Введите пароль. Сейчас локальный режим — правки сохранятся только в этом браузере.";
    }
    window.setTimeout(() => {
      if (password) password.focus({ preventScroll: true });
    }, 80);

    updateLock();
  }

  function closeGate() {
    const gate = $("#admin-gate");
    if (!gate || gate.hidden) return;
    gate.hidden = true;
    gate.setAttribute("aria-hidden", "true");
    const password = $("#gate-password");
    if (password) password.value = "";
    const error = $("#gate-error");
    if (error) error.textContent = "";
    updateLock();
  }

  function initSecret() {
    const dot = $("#secret-dot");
    if (dot) {
      let clicks = 0;
      let timer = null;
      dot.addEventListener("click", () => {
        clicks += 1;
        if (timer) clearTimeout(timer);
        timer = window.setTimeout(() => {
          clicks = 0;
        }, 2200);
        if (clicks >= 5) {
          clicks = 0;
          if (timer) clearTimeout(timer);
          if (!state.editing) openGate();
        }
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const video = $("#video-modal");
      if (video && !video.hidden && typeof window.PROOFS_CLOSE_VIDEO === "function") {
        window.PROOFS_CLOSE_VIDEO();
      } else if (!$("#lightbox")?.hidden) {
        closeLightbox();
      } else if (!$("#admin-panel")?.hidden) {
        closePanel();
      } else if (!$("#admin-gate")?.hidden) {
        closeGate();
      } else {
        closeMenu();
      }
    });
  }

  /* -------------------------------------------------------
     Church / youth transition
     ------------------------------------------------------- */

  function initPageTransition() {
    const overlay = $("#page-transition");
    if (!overlay) return;
    const word = $(".page-transition__word", overlay);
    const kicker = $(".page-transition__kicker", overlay);

    const setMode = (mode) => {
      const youth = mode === "youth";
      overlay.dataset.mode = youth ? "youth" : "church";
      if (word) word.textContent = youth ? "PROOFS" : "СВЕТ МИРУ";
      if (kicker) kicker.textContent = youth ? "молодёжное служение · быхов" : "церковь · быхов";
    };

    let stored = null;
    try {
      stored = sessionStorage.getItem(TRANSITION_KEY);
      if (stored) sessionStorage.removeItem(TRANSITION_KEY);
    } catch (error) {
      stored = null;
    }

    if (stored) {
      let info = null;
      try {
        info = JSON.parse(stored);
      } catch (error) {
        info = null;
      }
      const mode = info && info.mode === "youth" ? "youth" : "church";
      setMode(mode);
      document.documentElement.classList.remove("is-transitioning");
      overlay.classList.add("is-active", "is-revealing");
      overlay.setAttribute("aria-hidden", "false");
      document.body.classList.add("is-transitioning");
      window.setTimeout(() => {
        overlay.classList.add("is-done");
        document.body.classList.remove("is-transitioning");
        overlay.setAttribute("aria-hidden", "true");
        window.setTimeout(() => {
          overlay.classList.remove("is-active", "is-revealing", "is-done");
        }, 520);
      }, REDUCED ? 80 : 780);
    }

    $$("[data-page-switch]").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (state.editing) return;
        const mode = link.dataset.pageSwitch === "youth" ? "youth" : "church";
        const href = link.getAttribute("href");
        if (!href) return;
        event.preventDefault();
        if (REDUCED || LOW_POWER) {
          location.href = href;
          return;
        }
        setMode(mode);
        try {
          sessionStorage.setItem(TRANSITION_KEY, JSON.stringify({ mode, href }));
        } catch (error) {
          /* no-op */
        }
        overlay.classList.add("is-active", "is-covering");
        overlay.setAttribute("aria-hidden", "false");
        document.body.classList.add("is-transitioning");
        window.setTimeout(() => {
          location.href = href;
        }, 680);
      });
    });
  }

  /* -------------------------------------------------------
     YouTube facade
     ------------------------------------------------------- */

  function initVideos() {
    const modal = $("#video-modal");
    if (!modal) return;
    const frame = $("#video-frame");
    const title = $("#video-modal-title");
    let opener = null;

    const open = (button) => {
      const id = button.dataset.videoId;
      if (!id || !frame) return;
      const card = button.closest(".ch-video-card");
      const heading = card && card.querySelector("h3");
      const label = button.dataset.videoTitle || (heading && heading.textContent) || "Видео";
      opener = button;
      frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&modestbranding=1`;
      frame.title = label;
      if (title) title.textContent = label;
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
      updateLock();
      const close = $(".video-modal__close", modal);
      if (close) close.focus({ preventScroll: true });
    };

    document.addEventListener("click", (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest("[data-video-id]") : null;
      if (!button || modal.contains(button)) return;
      open(button);
    });

    $$("[data-video-close]", modal).forEach((element) => {
      element.addEventListener("click", closeVideo);
    });

    function closeVideo() {
      if (modal.hidden) return;
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
      if (frame) frame.removeAttribute("src");
      updateLock();
      if (opener && typeof opener.focus === "function") opener.focus({ preventScroll: true });
      opener = null;
    }

    window.PROOFS_CLOSE_VIDEO = closeVideo;
  }

  /* -------------------------------------------------------
     YouTube feed — данные обновляет GitHub Actions
     ------------------------------------------------------- */

  const YOUTUBE_FEED_URL =
    "https://raw.githubusercontent.com/davidmarkovskij1-stack/svetmirubykhov/main/data/youtube.json";

  function escapeText(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  }

  function ruDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" })
      .format(date)
      .replace(/\s*г\.$/, "");
  }

  async function fetchFeed(url, timeout) {
    if (typeof fetch !== "function") return null;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      return response.ok ? await response.json() : null;
    } catch (error) {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function videoCardMarkup(video) {
    const title = escapeText(video.title || "Видео");
    const id = encodeURIComponent(video.id || "");
    const thumb = escapeText(video.thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    const kind = video.kind ? `<span class="ch-video-card__kind">${escapeText(video.kind)}</span>` : "";
    const meta = [video.speaker, ruDate(video.published)]
      .filter(Boolean)
      .map(escapeText)
      .join(" · ");
    return `
      <article class="ch-video-card">
        <button class="ch-video-card__play" type="button" data-video-id="${id}" data-video-title="${title}" aria-label="Смотреть видео: ${title}">
          <img src="${thumb}" width="640" height="360" alt="Проповедь «${title}»" loading="lazy" decoding="async" />
          <span class="ch-video-card__shade" aria-hidden="true"></span>
          <span class="ch-video-card__button" aria-hidden="true"><span>▶</span></span>
        </button>
        <div class="ch-video-card__body">
          ${kind}
          <h3>${title}</h3>
          <p>${meta}</p>
          <a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">Смотреть на YouTube ↗</a>
        </div>
      </article>`;
  }

  function applyLiveState(live) {
    const link = document.getElementById("live-link");
    if (!link) return;
    const checked = live && live.checkedAt ? Date.parse(live.checkedAt) : 0;
    const fresh = Number.isFinite(checked) && Date.now() - checked < 25 * 60 * 1000;
    if (live && live.isLive && fresh) {
      const fallback = link.getAttribute("href");
      link.href = live.videoId
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(live.videoId)}`
        : fallback;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }

  async function initYoutubeFeed() {
    const grid = document.getElementById("video-grid");
    if (!grid) return;
    let data = await fetchFeed(`${YOUTUBE_FEED_URL}?t=${Date.now()}`, 7000);
    if (!data) data = await fetchFeed("data/youtube.json", 4000);
    if (!data) return;
    if (Array.isArray(data.videos) && data.videos.length) {
      grid.innerHTML = data.videos.slice(0, 3).map(videoCardMarkup).join("");
    }
    applyLiveState(data.live);
  }

  /* -------------------------------------------------------
     UI helpers
     ------------------------------------------------------- */

  function updateLock() {
    const gate = $("#admin-gate");
    const panel = $("#admin-panel");
    const lightbox = $("#lightbox");
    const video = $("#video-modal");
    const locked =
      (gate && !gate.hidden) ||
      (panel && !panel.hidden) ||
      (lightbox && !lightbox.hidden) ||
      (video && !video.hidden) ||
      document.body.classList.contains("menu-open");
    document.body.classList.toggle("is-locked", Boolean(locked));
  }

  function showToast(message, type = "") {
    const toast = $("#toast");
    if (!toast) return;
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast is-visible${type ? ` is-${type}` : ""}`;
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, type === "error" ? 5200 : 3800);
  }

  function hideToast() {
    const toast = $("#toast");
    if (!toast) return;
    if (toastTimer) clearTimeout(toastTimer);
    toast.classList.remove("is-visible");
  }

  function isoDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function plural(number, one, few, many) {
    const mod10 = number % 10;
    const mod100 = number % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  /* -------------------------------------------------------
     Init
     ------------------------------------------------------- */

  function init() {
    initNav();
    initMagnetic();
    initParallax();
    initMouseParallax();
    initGallery();
    initLightbox();
    initCalendar();
    initInlineEditor();
    initAdminBar();
    initImageInput();
    initPanel();
    initGate();
    initVideos();
    initSecret();
    initPageTransition();
    applyContent();
    renderNextMeeting();
    window.setInterval(renderNextMeeting, 60_000);
    boot();
    initYoutubeFeed();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

})();

/* =============================================
   YUMEAMI — app.js  (v2)
   =============================================

   📋 วิธีตั้งค่า Google Sheet:
   คอลัมน์ (แถวแรกเป็น header):
     A: name         ชื่อสินค้า
     B: sub          ชื่อ collection
     C: status       "ready" หรือ "preorder"
     D: price        ราคา (ตัวเลขอย่างเดียว เช่น 380)
     E: desc         รายละเอียดสินค้า
     F: details      ข้อมูลย่อย คั่นด้วย | เช่น 📏 18 ซม.|🎨 5 สี
     G: emoji        อีโมจิ fallback เผื่อไม่มีรูป
     H: bgColor      สี card เช่น #fce4ec
     I: image        รูปหลัก เช่น dool.jpg
     J: subImages    รูปเพิ่มเติม คั่นด้วย | เช่น a.jpg|b.jpg|c.jpg
     K: shopeeUrl    ลิงก์ Shopee
     L: lineUrl      ลิงก์ LINE

   🔧 ตั้งค่า:
     1. Publish Google Sheet → Share → Publish to web → CSV
     2. วาง URL ใน CONFIG.SHEET_CSV_URL
     3. วางรูปใน images/

   ⚡ Cache:
     - ข้อมูลถูกแคชไว้ใน sessionStorage (หาย เมื่อปิด tab)
     - CACHE_TTL_MS = อายุแคช (ปัจจุบัน 5 นาที)

   🔒 Security:
     - ทุก text ถูก escape ก่อนแทรก DOM
     - URL ที่ใช้ใน href ตรวจสอบ protocol ก่อน (https: และ line: เท่านั้น)
     - ไม่อนุญาต http: เพื่อป้องกัน mixed content
     - ไม่มี innerHTML จาก Sheet โดยตรง
   ============================================= */

"use strict";

/* ─── CONFIG ─── */
const CONFIG = Object.freeze({
  SHEET_CSV_URL:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vRbqT752aEW-oYP_qhqTUf1nhTE2qjvAdPO0-W9Gy_H3bFSdEJxs_Ip02R2bycAB5gfuwwS6WzNIZT-/pub?output=csv",
  IMAGE_FOLDER: "images/",
  DEFAULT_BG:   "#f9ede6",
  CACHE_KEY:    "yumeami_products_v2",
  CACHE_TTL_MS: 5 * 60 * 1000,   // 5 นาที
  ALLOWED_PROTOCOLS: ["https:", "line:"],
  MAX_NAME_LEN: 120,
  MAX_DESC_LEN: 800,
});

const STATUS_MAP = {
  ready:    { label: "พร้อมส่ง",   cls: "ready"    },
  preorder: { label: "พรีออเดอร์", cls: "preorder" },
};

/* ─── DOM ─── */
const grid        = document.getElementById("productGrid");
const skeletonGrid= document.getElementById("skeletonGrid");
const filterCount = document.getElementById("filterCount");
const errorEl     = document.getElementById("errorState");
const overlay     = document.getElementById("overlay");
const popupClose  = document.getElementById("popupClose");
const popupImgEl  = document.getElementById("popupImgEl");
const popupEmoji  = document.getElementById("popupEmoji");
const popupStatus = document.getElementById("popupStatus");
const popupColl   = document.getElementById("popupCollection");
const popupName   = document.getElementById("popupName");
const popupDesc   = document.getElementById("popupDesc");
const popupDetails= document.getElementById("popupDetails");
const popupPrice  = document.getElementById("popupPrice");
const shopeeBtn   = document.getElementById("shopeeBtn");
const lineBtn     = document.getElementById("lineBtn");
const thumbsWrap  = document.getElementById("popupThumbs");
const loadBar     = document.getElementById("loadBar");
const toast       = document.getElementById("toast");

let products      = [];
let activeFilter  = "all";
let toastTimer    = null;

/* ─── SECURITY HELPERS ─── */

/**
 * Escape HTML entities เพื่อป้องกัน XSS
 * ใช้ก่อนแทรก text ใดๆ ที่มาจาก external source
 */
function escapeHTML(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
}

/**
 * Sanitize URL — อนุญาตเฉพาะ protocol ที่กำหนด
 * ถ้าไม่ผ่านจะ return "#" แทน
 */
function sanitizeURL(url) {
  if (!url || typeof url !== "string") return "#";
  const trimmed = url.trim();
  if (trimmed === "#" || trimmed === "") return "#";
  try {
    const parsed = new URL(trimmed, window.location.href);
    if (CONFIG.ALLOWED_PROTOCOLS.includes(parsed.protocol)) return parsed.href;
    console.warn("[YUMEAMI] URL blocked (protocol not allowed):", trimmed);
    return "#";
  } catch {
    // ถ้า parse ไม่ได้ ให้ถือว่าเป็น path สัมพัทธ์ภายในโฟลเดอร์ images
    // เฉพาะ image path (ไม่มี protocol) เท่านั้นที่ผ่านได้
    return "#";
  }
}

/**
 * Sanitize image path: ถ้าเป็น URL เต็มให้ตรวจ protocol
 * ถ้าเป็น filename ธรรมดาให้ prefix ด้วย IMAGE_FOLDER
 */
function resolveImage(raw) {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // ถ้าเป็น URL เต็ม → ตรวจ protocol (https เท่านั้น)
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "https:") return parsed.href;
    } catch { /* ไม่ใช่ URL ที่ valid */ }
    return "";
  }

  // ป้องกัน path traversal — อนุญาตเฉพาะ filename (ไม่มี / .. ฯลฯ)
  const filename = trimmed.split(/[/\\]/).pop();
  if (!filename || filename !== trimmed || filename.includes("..")) return "";

  return CONFIG.IMAGE_FOLDER + filename;
}

/* ─── CACHE ─── */

function saveCache(data) {
  try {
    sessionStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify({
      ts:   Date.now(),
      data: data,
    }));
  } catch (e) {
    console.warn("[YUMEAMI] Cache write failed:", e);
  }
}

function loadCache() {
  try {
    const raw = sessionStorage.getItem(CONFIG.CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ts !== "number" || !Array.isArray(parsed.data)) return null;
    if (Date.now() - parsed.ts > CONFIG.CACHE_TTL_MS) {
      sessionStorage.removeItem(CONFIG.CACHE_KEY);
      return null;
    }
    // Validate schema: ตรวจว่าทุก item มี field ที่จำเป็น และ type ถูกต้อง
    const isValid = parsed.data.every(p =>
      p && typeof p === "object" &&
      typeof p.name === "string" &&
      typeof p.price === "number" && isFinite(p.price) &&
      typeof p.status === "string" &&
      Array.isArray(p.details) &&
      Array.isArray(p.subImages)
    );
    if (!isValid) {
      sessionStorage.removeItem(CONFIG.CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/* ─── LOAD BAR ─── */
function setLoadBar(state) {
  loadBar.classList.remove("loading", "done");
  if (state === "loading") loadBar.classList.add("loading");
  if (state === "done")    loadBar.classList.add("done");
  if (state === "done") setTimeout(() => { loadBar.classList.remove("done"); }, 600);
}

/* ─── TOAST ─── */
function showToast(msg, durationMs = 2500) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), durationMs);
}

/* ─── INIT ─── */
window.addEventListener("DOMContentLoaded", () => {
  setupFilters();
  loadProducts();

  popupClose.addEventListener("click", closePopup);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closePopup(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopup();
    if (e.key === "ArrowLeft")  navigatePopup(-1);
    if (e.key === "ArrowRight") navigatePopup(1);
  });
});

/* ─── LOAD PRODUCTS ─── */
async function loadProducts() {
  // 1. ลอง cache ก่อน
  const cached = loadCache();
  if (cached) {
    products = cached;
    renderGrid();
    showToast("⚡ โหลดจาก cache");
    return;
  }

  // 2. Fetch จาก Sheet
  setLoadBar("loading");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // timeout 15s

    const res = await fetch(CONFIG.SHEET_CSV_URL, {
      signal: controller.signal,
      cache:  "no-store",   // ให้ browser ไม่แคชเอง เพราะเราจัดการเอง
    });

    clearTimeout(timeout);

    if (!res.ok) throw new Error("HTTP " + res.status + " — โหลด Sheet ไม่สำเร็จ");

    const text = await res.text();
    products = parseCSV(text);

    if (products.length === 0) throw new Error("ไม่พบข้อมูลสินค้าใน Sheet");

    saveCache(products);
    setLoadBar("done");
    renderGrid();
    showToast("✅ โหลดข้อมูลสำเร็จ " + products.length + " ชิ้น");
  } catch (err) {
    setLoadBar("done");
    const msg = err.name === "AbortError" ? "หมดเวลาเชื่อมต่อ กรุณาลองใหม่" : err.message;
    showError(msg);
  }
}

/* ─── PARSE CSV ─── */
function parseCSV(text) {
  // รวม multiline quoted fields ก่อน split เป็น rows
  const rows = splitCSVRows(text.trim());
  if (rows.length < 2) return [];

  return rows.slice(1).map((line) => {
    const c = splitCSVLine(line);

    const price = parseFloat((c[3] || "0").replace(/[^0-9.]/g, ""));
    const safePrice = isFinite(price) && price >= 0 ? price : 0;

    // Truncate ฟิลด์ text เพื่อป้องกันข้อมูลที่ยาวผิดปกติ
    const name = String(c[0] || "").slice(0, CONFIG.MAX_NAME_LEN);
    const desc = String(c[4] || "").slice(0, CONFIG.MAX_DESC_LEN);

    return {
      name:      name,
      sub:       String(c[1] || "").slice(0, 80),
      status:    String(c[2] || "ready").trim().toLowerCase(),
      price:     safePrice,
      desc:      desc,
      details:   String(c[5] || "").split("|").map(s => s.trim()).filter(Boolean).slice(0, 10),
      emoji:     String(c[6] || "🧸").slice(0, 8),
      bgColor:   /^#[0-9a-fA-F]{3,6}$/.test((c[7] || "").trim())
                   ? c[7].trim()
                   : CONFIG.DEFAULT_BG,
      image:     String(c[8]  || "").trim(),
      subImages: String(c[9]  || "").split("|").map(s => s.trim()).filter(Boolean).slice(0, 6),
      shopeeUrl: String(c[10] || "#").trim(),
      lineUrl:   String(c[11] || "#").trim(),
    };
  }).filter(p => p.name.length > 0);
}

/* แยก CSV text เป็น rows โดยรองรับ newline ภายใน quoted field */
function splitCSVRows(text) {
  const rows = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQ && text[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
      cur += ch;
    } else if ((ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) && !inQ) {
      if (ch === "\r") i++; // skip \n of \r\n
      rows.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

/* RFC-compliant CSV splitter (รองรับ quoted fields + escaped quotes) */
function splitCSVLine(line) {
  const result = [];
  let cur = "";
  let inQ  = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

/* ─── FILTERS ─── */
function setupFilters() {
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      applyFilter();
    });
  });
}

function applyFilter() {
  let visible = 0;
  document.querySelectorAll(".product-card").forEach(card => {
    const match = activeFilter === "all" || card.dataset.status === activeFilter;
    card.classList.toggle("hidden", !match);
    if (match) visible++;
  });
  filterCount.textContent = visible + " ชิ้น";
}

/* ─── RENDER GRID ─── */
function renderGrid() {
  // ซ่อน skeleton
  skeletonGrid.style.display  = "none";
  skeletonGrid.setAttribute("aria-hidden", "true");
  grid.style.display          = "";
  filterCount.textContent     = products.length + " ชิ้น";

  // Clear grid ก่อน render ใหม่ (ป้องกัน card ซ้ำเมื่อ retry)
  grid.innerHTML = "";

  products.forEach((p, i) => {
    const card = document.createElement("article");
    card.className       = "product-card";
    card.dataset.index   = i;
    card.dataset.status  = p.status;
    card.tabIndex        = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", "ดูรายละเอียด " + p.name);

    const st     = STATUS_MAP[p.status] || STATUS_MAP["ready"];
    const imgSrc = resolveImage(p.image);
    const bg     = p.bgColor;

    // สร้าง card img area
    const cardImg = document.createElement("div");
    cardImg.className = "card-img";
    cardImg.style.background = bg;

    // status badge
    const statusDiv = document.createElement("div");
    statusDiv.className = "card-status";
    const badge = createStatusBadge(st);
    statusDiv.appendChild(badge);
    cardImg.appendChild(statusDiv);

    // รูปหรือ emoji
    if (imgSrc) {
      const img = document.createElement("img");
      img.className   = "card-photo";
      img.src         = imgSrc;
      img.alt         = p.name;
      img.loading     = "lazy";
      img.decoding    = "async";
      img.onerror     = function() {
        this.remove();
        cardImg.appendChild(createEmojiEl(p.emoji));
      };
      cardImg.appendChild(img);
    } else {
      cardImg.appendChild(createEmojiEl(p.emoji));
    }

    // card body
    const body = document.createElement("div");
    body.className = "card-body";

    const nameEl = document.createElement("div");
    nameEl.className   = "card-name";
    nameEl.textContent = p.name;

    const subEl = document.createElement("div");
    subEl.className   = "card-sub";
    subEl.textContent = p.sub;

    const priceEl = document.createElement("div");
    priceEl.className = "card-price";
    priceEl.textContent = "฿ " + p.price.toLocaleString("th-TH");
    const unitSpan = document.createElement("span");
    unitSpan.className   = "unit";
    unitSpan.textContent = " บาท";
    priceEl.appendChild(unitSpan);

    body.appendChild(nameEl);
    body.appendChild(subEl);
    body.appendChild(priceEl);

    card.appendChild(cardImg);
    card.appendChild(body);

    // Click & keyboard
    const openFn = () => openPopup(i);
    card.addEventListener("click", openFn);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFn(); }
    });

    grid.appendChild(card);
  });

  applyFilter();
}

function createStatusBadge(st) {
  const badge = document.createElement("span");
  badge.className = "status-badge " + st.cls;
  const dot = document.createElement("span");
  dot.className = "status-dot";
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(st.label));
  return badge;
}

function createEmojiEl(emoji) {
  const el = document.createElement("span");
  el.className   = "card-emoji-fallback";
  el.textContent = emoji;
  el.setAttribute("aria-hidden", "true");
  return el;
}

/* ─── POPUP ─── */
let currentIndex = -1;

function openPopup(i) {
  currentIndex = i;
  const p  = products[i];
  const st = STATUS_MAP[p.status] || STATUS_MAP["ready"];

  // Gallery images
  const mainSrc = resolveImage(p.image);
  const subSrcs = p.subImages.map(resolveImage).filter(Boolean);
  const allImgs = mainSrc ? [mainSrc, ...subSrcs] : subSrcs;

  // Popup img background
  const popupImgWrap = document.getElementById("popupImg");
  popupImgWrap.style.background = p.bgColor;

  // Main image
  if (allImgs.length > 0) {
    popupImgEl.src          = allImgs[0];
    popupImgEl.alt          = p.name;
    popupImgEl.style.display = "block";
    popupEmoji.style.display = "none";
    popupImgEl.onerror = function() {
      popupImgEl.style.display = "none";
      popupEmoji.style.display = "block";
      popupEmoji.textContent   = p.emoji;
    };
  } else {
    popupImgEl.style.display = "none";
    popupEmoji.style.display = "block";
    popupEmoji.textContent   = p.emoji;
  }

  // Thumbnails
  thumbsWrap.innerHTML = "";
  if (allImgs.length > 1) {
    thumbsWrap.style.display = "flex";
    allImgs.forEach((src, idx) => {
      const thumb = document.createElement("div");
      thumb.className  = "popup-thumb" + (idx === 0 ? " active" : "");
      thumb.setAttribute("role", "listitem");
      thumb.setAttribute("aria-label", "รูปที่ " + (idx + 1));
      thumb.tabIndex   = 0;

      const tImg   = document.createElement("img");
      tImg.src     = src;
      tImg.alt     = p.name + " รูปที่ " + (idx + 1);
      tImg.loading = "lazy";
      thumb.appendChild(tImg);

      const switchImg = () => {
        popupImgEl.src           = src;
        popupImgEl.style.display = "block";
        popupEmoji.style.display = "none";
        thumbsWrap.querySelectorAll(".popup-thumb").forEach(t => t.classList.remove("active"));
        thumb.classList.add("active");
      };
      thumb.addEventListener("click", switchImg);
      thumb.addEventListener("keydown", (e) => { if (e.key === "Enter") switchImg(); });
      thumbsWrap.appendChild(thumb);
    });
  } else {
    thumbsWrap.style.display = "none";
  }

  // Text content — ใช้ textContent ทั้งหมด ไม่มี innerHTML จาก data
  popupStatus.innerHTML  = "";
  popupStatus.appendChild(createStatusBadge(st));
  popupColl.textContent  = p.sub;
  popupName.textContent  = p.name;
  popupDesc.textContent  = p.desc;
  popupPrice.textContent = "฿ " + p.price.toLocaleString("th-TH") + " บาท";

  // Safe URL
  shopeeBtn.href = sanitizeURL(p.shopeeUrl);
  lineBtn.href   = sanitizeURL(p.lineUrl);

  // Detail chips (text only, no raw HTML)
  popupDetails.innerHTML = "";
  p.details.forEach(d => {
    const chip = document.createElement("div");
    chip.className   = "detail-chip";
    chip.setAttribute("role", "listitem");
    chip.textContent = d;
    popupDetails.appendChild(chip);
  });

  // Disable shopee/line btn if no real URL
  shopeeBtn.style.opacity = (shopeeBtn.href === "#" || !p.shopeeUrl || p.shopeeUrl === "#") ? ".4" : "1";
  lineBtn.style.opacity   = (lineBtn.href   === "#" || !p.lineUrl   || p.lineUrl   === "#") ? ".4" : "1";

  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  popupClose.focus();
}

function closePopup() {
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  // Return focus to the card that was clicked
  if (currentIndex >= 0) {
    const card = grid.querySelector('[data-index="' + currentIndex + '"]');
    if (card) card.focus();
  }
  currentIndex = -1;
}

function navigatePopup(dir) {
  if (!overlay.classList.contains("active")) return;
  const visibleCards = [...grid.querySelectorAll(".product-card:not(.hidden)")];
  const currentCard  = grid.querySelector('[data-index="' + currentIndex + '"]');
  const posInVisible = visibleCards.indexOf(currentCard);
  if (posInVisible === -1) return;
  const nextCard = visibleCards[posInVisible + dir];
  if (nextCard) openPopup(Number(nextCard.dataset.index));
}

/* ─── ERROR ─── */
function showError(msg) {
  skeletonGrid.style.display = "none";
  grid.style.display         = "none";
  errorEl.innerHTML          = "";
  errorEl.style.display      = "block";

  const icon = document.createElement("div");
  icon.className   = "error-icon";
  icon.textContent = "⚠️";

  const msgEl = document.createElement("div");
  msgEl.className   = "error-msg";
  msgEl.textContent = msg;

  const hint = document.createElement("div");
  hint.className   = "error-msg";
  hint.style.fontSize = "12px";
  hint.textContent = "ตรวจสอบ SHEET_CSV_URL ใน app.js หรือการเชื่อมต่ออินเทอร์เน็ต";

  const btn = document.createElement("button");
  btn.className   = "btn-retry";
  btn.textContent = "🔄 ลองใหม่อีกครั้ง";
  btn.addEventListener("click", () => {
    sessionStorage.removeItem(CONFIG.CACHE_KEY);
    errorEl.style.display = "none";
    skeletonGrid.style.display = "";
    skeletonGrid.removeAttribute("aria-hidden");
    loadProducts();
  });

  errorEl.appendChild(icon);
  errorEl.appendChild(msgEl);
  errorEl.appendChild(hint);
  errorEl.appendChild(btn);
}

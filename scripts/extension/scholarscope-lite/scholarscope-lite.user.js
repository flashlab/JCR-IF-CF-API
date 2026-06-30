// ==UserScript==
// @name         Scholarscope Lite
// @namespace    https://github.com/flashlab/JCR-IF-CF-API
// @version      0.2.0
// @description  PubMed / Google Scholar 期刊 IF/分区徽章、筛选排序、Abstract 预览、iCite 引用数；参考 Scholarscope 扩展 UI。
// @author       flashlab<zhengjuefei25@163.com>
// @homepageURL  https://github.com/flashlab/JCR-IF-CF-API
// @license      GPL-3.0
// @match        https://pubmed.ncbi.nlm.nih.gov/*
// @match        https://scholar.google.com/scholar*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      jcr-query-api.4cf.workers.dev
// @connect      icite.od.nih.gov
// @connect      eutils.ncbi.nlm.nih.gov
// @connect      scholar.google.com
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js
// ==/UserScript==

/* global DOMPurify */

(function () {
  "use strict";

  // =========================================================================
  // Config
  // =========================================================================
  const DEFAULTS = {
    quartileSource: "jcr",
    showCitation: true,
    autoFilter: false,
    autoSort: false,
    sortingMethod: 1,
    filter: { minIF: 0, maxIF: 2000, q1: 1, q2: 1, q3: 1, q4: 1 },
    pubmedApiKey: "",
  };
  const CFG = Object.assign({}, DEFAULTS, GM_getValue("cfg", {}));
  CFG.filter = Object.assign({}, DEFAULTS.filter, CFG.filter || {});
  const saveCfg = () => GM_setValue("cfg", CFG);

  function isScholarPage() {
    return (
      location.hostname === "scholar.google.com" &&
      location.pathname.startsWith("/scholar")
    );
  }

  const JCR_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
  const JCR_ENDPOINT = "https://jcr-query-api.4cf.workers.dev/api/jcr";
  const ICITE_ENDPOINT = "https://icite.od.nih.gov/api/pubs";
  // eutils endpoints accept api_key (CFG.pubmedApiKey); pubmed/scholar website bases do not.
  const EFETCH_ENDPOINT =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
  const ESEARCH_ENDPOINT =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
  const PUBMED_BASE = "https://pubmed.ncbi.nlm.nih.gov/";
  const SCHOLAR_BASE = "https://scholar.google.com/scholar";
  const JCR_DEFAULT_PARAMS = isScholarPage()
    ? null
    : { is_abbr: "1", is_med: "1" };

  // =========================================================================
  // Utilities
  // =========================================================================
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") n.className = attrs[k];
        else if (k === "style") n.setAttribute("style", attrs[k]);
        else if (k === "dataset") Object.assign(n.dataset, attrs[k]);
        else if (k.startsWith("on") && typeof attrs[k] === "function")
          n.addEventListener(k.slice(2), attrs[k]);
        else if (k === "checked" || k === "disabled") attrs[k] && (n[k] = true);
        else n.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return n;
  }

  function factorColor(f) {
    if (f === "" || f == null || isNaN(parseFloat(f))) return "#616161";
    const v = parseFloat(f);
    if (v >= 20) return "#D50000";
    if (v >= 10) return "#F4511E";
    if (v >= 3) return "#F6BF26";
    if (v >= 0) return "#33B679";
    return "#616161";
  }

  function quartileColor(q) {
    if (!q) return "#616161";
    const s = String(q).replace(/\s+/g, "").toUpperCase();
    if (s === "Q1" || s === "1区") return "#D50000";
    if (s === "Q2" || s === "2区") return "#F4511E";
    if (s === "Q3" || s === "3区") return "#F6BF26";
    if (s === "Q4" || s === "4区") return "#33B679";
    return "#616161";
  }

  function normalizeFenqu(v) {
    if (!v) return "";
    return String(v).replace(/\s+/g, "");
  }

  function pickDisplayQuartile(row) {
    if (!row) return "";
    if (CFG.quartileSource === "cas") return normalizeFenqu(row.fenqu);
    return row.jif_quartile || "";
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "json",
        timeout: 15000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300)
            resolve(r.response || JSON.parse(r.responseText || "null"));
          else reject(new Error("HTTP " + r.status));
        },
        onerror: (e) => reject(e),
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  function gmFetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 20000,
        onload: (r) =>
          r.status >= 200 && r.status < 300
            ? resolve(r.responseText)
            : reject(new Error("HTTP " + r.status)),
        onerror: reject,
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  function makeQueue(concurrency) {
    let active = 0;
    const q = [];
    const drain = () => {
      while (active < concurrency && q.length) {
        const { task, resolve, reject } = q.shift();
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            drain();
          });
      }
    };
    return (task) =>
      new Promise((resolve, reject) => {
        q.push({ task, resolve, reject });
        drain();
      });
  }
  const jcrQueue = makeQueue(4);
  const efetchQueue = makeQueue(2);
  const scholarQueue = makeQueue(2);

  // =========================================================================
  // Cache
  // =========================================================================
  function readJcrCache() {
    return GM_getValue("jcrCache", {});
  }
  function writeJcrCache(c) {
    GM_setValue("jcrCache", c);
  }
  function jcrCacheGet(key) {
    const c = readJcrCache();
    const hit = c[key];
    if (!hit) return null;
    if (Date.now() - hit.ts > JCR_CACHE_TTL_MS) return null;
    return { data: hit.data || [], medHit: !!hit.medHit };
  }
  function jcrCacheSet(key, payload) {
    const c = readJcrCache();
    c[key] = {
      data: payload.data || [],
      medHit: !!payload.medHit,
      ts: Date.now(),
    };
    writeJcrCache(c);
  }

  // =========================================================================
  // APIs
  // =========================================================================
  function buildJcrUrl(q, extraParams) {
    const u = new URL(JCR_ENDPOINT);
    u.searchParams.set("q", q);
    const params = Object.assign({}, JCR_DEFAULT_PARAMS);
    if (extraParams) {
      for (const k in extraParams) {
        const v = extraParams[k];
        if (v == null || v === "") delete params[k];
        else params[k] = String(v);
      }
    }
    for (const k in params) u.searchParams.set(k, params[k]);
    return u.toString();
  }

  async function jcrLookup(keyword, opts) {
    opts = opts || {};
    const norm = String(keyword || "").toLowerCase();
    if (!norm) return { data: [], errored: false, medHit: false };
    const cacheKey = norm;
    if (!opts.skipCache) {
      const cached = jcrCacheGet(cacheKey);
      if (cached)
        return {
          data: cached.data,
          medHit: cached.medHit,
          errored: false,
          cached: true,
        };
    }
    return jcrQueue(async () => {
      try {
        const url = buildJcrUrl(keyword, opts.extraParams);
        const resp = await gmFetch(url);
        const data = resp && Array.isArray(resp.data) ? resp.data : [];
        const medHit = !!(resp && resp.med_hit);
        if (!opts.skipCache && (data.length > 0 || medHit)) {
          jcrCacheSet(cacheKey, { data, medHit });
        }
        return { data, errored: false, medHit };
      } catch (e) {
        return { data: [], errored: true, medHit: false, error: e.message };
      }
    });
  }

  async function iciteBatch(pmids) {
    if (!pmids || !pmids.length) return {};
    const url = `${ICITE_ENDPOINT}?pmids=${pmids.join(",")}`;
    try {
      const resp = await gmFetch(url);
      const out = {};
      ((resp && resp.data) || []).forEach((r) => {
        out[String(r.pmid)] = r;
      });
      return out;
    } catch (e) {
      return {};
    }
  }

  async function efetchAbstractXml(pmid) {
    const u = new URL(EFETCH_ENDPOINT);
    u.searchParams.set("db", "pubmed");
    u.searchParams.set("rettype", "xml");
    u.searchParams.set("id", pmid);
    if (CFG.pubmedApiKey) u.searchParams.set("api_key", CFG.pubmedApiKey);
    const xmlText = await efetchQueue(() => gmFetchText(u.toString()));
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const tags = doc.getElementsByTagName("AbstractText");
    let abstractHtml = "";
    for (let i = 0; i < tags.length; i++) {
      const label = tags[i].getAttribute("Label");
      const inner = tags[i].innerHTML;
      abstractHtml += label
        ? `<p><b>${label}: </b>${inner}</p>`
        : `<p>${inner}</p>`;
    }
    if (!abstractHtml) abstractHtml = "<b>No abstract.</b>";
    const titleNode = doc.getElementsByTagName("ArticleTitle")[0];
    const journalNode = doc.getElementsByTagName("Journal")[0];
    const journalTitleNode =
      journalNode && journalNode.getElementsByTagName("Title")[0];
    const idsNodes = doc.getElementsByTagName("ELocationID");
    const doiNode =
      idsNodes &&
      Array.from(idsNodes || []).find(
        (node) => node.getAttribute("EIdType") === "doi",
      );
    return {
      abstractHtml,
      articleTitleHtml: titleNode ? titleNode.innerHTML : "",
      journalTitleHtml: journalTitleNode ? journalTitleNode.innerHTML : "",
      doiHtml: doiNode ? doiNode.innerHTML : "",
    };
  }

  // =========================================================================
  // Modal
  // =========================================================================
  function ensureModalRoot() {
    let root = document.getElementById("Scholarscope_Modal");
    if (root) return root;
    root = el("div", { id: "Scholarscope_Modal", style: "display:none" });
    const mask = el("div", {
      class: "Scholarscope_Modal_Mask",
      onclick: hideModal,
    });
    const box = el("div", { class: "Scholarscope_Modal_Box" });
    root.appendChild(mask);
    root.appendChild(box);
    document.body.appendChild(root);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideModal();
    });
    return root;
  }
  function showModal(content) {
    const root = ensureModalRoot();
    const box = root.querySelector(".Scholarscope_Modal_Box");
    box.innerHTML = "";
    if (typeof content === "string")
      box.appendChild(
        el("div", { class: "Scholarscope_Modal_Content" }, content),
      );
    else box.appendChild(content);
    root.style.display = "block";
  }
  function hideModal() {
    const root = document.getElementById("Scholarscope_Modal");
    if (root) root.style.display = "none";
  }

  function jcrResultsModal(rows, highlightIdx, options) {
    const baseHeaders = [
      "name",
      "abbr",
      "jif_2025",
      "jif_quartile",
      "fenqu",
      "is_top",
    ];
    const headerSet = new Set(baseHeaders);
    (rows || []).forEach((row) => {
      if (!row) return;
      Object.keys(row).forEach((key) => {
        if (row[key] != null) headerSet.add(key);
      });
    });
    const headers = Array.from(headerSet);
    const tbl = el("table", { class: "Scholarscope_Modal_Table" });
    const thead = el(
      "thead",
      {},
      el(
        "tr",
        {},
        headers.map((h) => el("th", {}, h)),
      ),
    );
    tbl.appendChild(thead);
    const tbody = el("tbody");
    (rows || []).forEach((r, i) => {
      const tr = el(
        "tr",
        i === highlightIdx
          ? { class: "Scholarscope_Modal_RowHighlight" }
          : null,
      );
      headers.forEach((h) =>
        tr.appendChild(el("td", {}, r && r[h] != null ? String(r[h]) : "—")),
      );
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    const wrap = el("div", { class: "Scholarscope_Modal_Content" });
    wrap.appendChild(
      el(
        "h3",
        {},
        `JCR lookup (${rows.length} result${rows.length === 1 ? "" : "s"})`,
      ),
    );
    wrap.appendChild(tbl);

    const buttonRow = el("div", { class: "Scholarscope_Modal_ButtonRow" });
    const factorEl = options && options.factorEl;
    const origKw = factorEl && factorEl.dataset && factorEl.dataset.origKw;
    if (factorEl && origKw) {
      const clearBtn = el(
        "div",
        { class: "Scholarscope_Modal_ClearCache" },
        "清除缓存",
      );
      clearBtn.addEventListener("click", () => {
        const cache = readJcrCache();
        delete cache[String(origKw).trim().toLowerCase()];
        writeJcrCache(cache);
        applyJcrToBadges(
          factorEl,
          getQuartileBadgeForFactor(factorEl),
          {},
          origKw,
        );
        hideModal();
      });
      buttonRow.appendChild(clearBtn);
    }
    buttonRow.appendChild(
      el(
        "div",
        { class: "Scholarscope_Modal_Close", onclick: hideModal },
        "关闭",
      ),
    );
    wrap.appendChild(buttonRow);
    return wrap;
  }

  function getQuartileBadgeForFactor(factorEl) {
    return (
      factorEl.parentElement &&
      factorEl.parentElement.querySelector(
        factorEl.classList.contains("Scholarscope_Appendix_Factor")
          ? ".Scholarscope_Appendix_Quartile"
          : ".Scholarscope_Quartile",
      )
    );
  }

  function getMetaContent(name) {
    const meta = document.querySelector(`meta[name="${name}"]`);
    return meta && meta.content ? meta.content.trim() : "";
  }

  function getDetailJournalTitle() {
    return getMetaContent("citation_journal_title");
  }

  function getManualLookupDefaultKeyword(factorEl) {
    if (factorEl && factorEl.classList.contains("Scholarscope_Factor")) {
      const title = getDetailJournalTitle();
      if (title) return title;
    }
    return factorEl && factorEl.dataset && factorEl.dataset.origKw
      ? factorEl.dataset.origKw.trim()
      : "";
  }

  function buildManualLookupSelect(id, options) {
    const select = el("select", {
      id,
      class: "Scholarscope_DropDownControl",
    });
    options.forEach((option) => {
      select.appendChild(el("option", { value: option.value }, option.label));
    });
    return select;
  }

  function serializeManualLookupForm(form) {
    const data = new FormData(form);
    return Object.fromEntries(
      Array.from(data.entries()), //.filter(([, value]) => String(value).trim() !== '')
    );
  }

  function buildManualLookupField(labelText, control) {
    return el("label", { class: "Scholarscope_DropDownField" }, [
      el("div", { class: "Scholarscope_DropDownLabel" }, labelText),
      control,
    ]);
  }

  function ensureManualLookupDropdown() {
    let dd = document.getElementById("Scholarscope_ManualLookupDropDown");
    if (dd) return dd;

    const keywordInput = el("input", {
      id: "Scholarscope_ManualLookupKeyword",
      name: "q",
      class: "Scholarscope_DropDownControl",
      type: "text",
      required: "required",
      minlength: "3",
      placeholder: "全称/缩写/ISSN",
    });
    const searchMode = buildManualLookupSelect(
      "Scholarscope_ManualLookupSearchMode",
      [
        { value: "", label: "精确" },
        { value: "1", label: "前缀" },
        { value: "2", label: "模糊" },
        { value: "3", label: "后缀" },
      ],
    );
    searchMode.name = "f";
    const isAbbr = buildManualLookupSelect("Scholarscope_ManualLookupIsAbbr", [
      { value: "", label: "不限" },
      { value: "1", label: "是" },
      { value: "0", label: "否" },
    ]);
    isAbbr.name = "is_abbr";
    const pageNo = buildManualLookupSelect("Scholarscope_ManualLookupPageNo", [
      { value: "", label: "1" },
      { value: "2", label: "2" },
      { value: "3", label: "3" },
      { value: "4", label: "4" },
      { value: "5", label: "5" },
    ]);
    pageNo.name = "page";
    const submit = el(
      "button",
      {
        type: "submit",
        class: "Scholarscope_DropDownButton Scholarscope_DropDownButtonPrimary",
      },
      "查询",
    );
    const reset = el(
      "button",
      {
        type: "reset",
        class: "Scholarscope_DropDownButton Scholarscope_DropDownButtonDanger",
      },
      "重置",
    );

    dd = el(
      "form",
      {
        id: "Scholarscope_ManualLookupDropDown",
        class: `Scholarscope_DropDown ${isScholarPage() ? "gs_query " : ""}notranslate`,
        style: "display:none",
        novalidate: "novalidate",
      },
      [
        el("div", { class: "Scholarscope_DropDownTitle" }, "JCR 手动查询"),
        keywordInput,
        el("div", { class: "Scholarscope_TermWrapper" }, [
          buildManualLookupField("搜索模式", searchMode),
          buildManualLookupField("缩写", isAbbr),
          buildManualLookupField("页数", pageNo),
        ]),
        el(
          "div",
          { class: "Scholarscope_TermWrapper Scholarscope_InlineCheck" },
          [
            el("div", {}, [
              el("input", {
                name: "is_med",
                id: "is_med",
                type: "checkbox",
                value: "0",
              }),
              el("label", { for: "is_med" }, "优先 JCR 数据库"),
            ]),
            el("div", {}, [
              el("input", {
                name: "show_all",
                id: "show_all",
                type: "checkbox",
                value: "1",
              }),
              el("label", { for: "show_all" }, "全部字段"),
            ]),
          ],
        ),
        el("div", { class: "Scholarscope_DropDownHint" }, [
          "参数详情查看",
          el(
            "a",
            {
              href: "https://github.com/flashlab/JCR-IF-CF-API",
              target: "_blank",
              rel: "noopener",
            },
            "flashlab/JCR-IF-CF-API",
          ),
        ]),
        el("div", { class: "Scholarscope_ButtonRow" }, [submit, reset]),
      ],
    );

    dd.addEventListener("click", (ev) => ev.stopPropagation());
    dd.addEventListener("submit", submitManualLookupForm);
    // close.addEventListener('click', closeManualLookupDropdown);

    document.body.appendChild(dd);
    document.addEventListener("click", (ev) => {
      const root = document.getElementById("Scholarscope_ManualLookupDropDown");
      if (root && root.style.display === "block" && !root.contains(ev.target))
        closeManualLookupDropdown();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeManualLookupDropdown();
    });
    return dd;
  }

  function positionManualLookupDropdown(dd, factorEl) {
    const rect = factorEl.getBoundingClientRect();
    const width = 340;
    const gap = 8;
    const maxLeft = window.scrollX + window.innerWidth - width - gap;
    const left = Math.max(
      window.scrollX + gap,
      Math.min(window.scrollX + rect.left, maxLeft),
    );
    dd.style.top = `${window.scrollY + rect.bottom + gap}px`;
    dd.style.left = `${left}px`;
  }

  function openManualLookupDropdown(factorEl) {
    const dd = ensureManualLookupDropdown();
    dd._factorEl = factorEl;
    dd.querySelector(".Scholarscope_DropDownTitle").textContent =
      factorEl.classList.contains("Scholarscope_MedHit")
        ? "JCR 手动查询（MedLine 已收录）"
        : "JCR 手动查询";
    const keywordInput = dd.querySelector("#Scholarscope_ManualLookupKeyword");
    keywordInput.value = keywordInput.defaultValue =
      getManualLookupDefaultKeyword(factorEl);
    positionManualLookupDropdown(dd, factorEl);
    dd.style.display = "block";
    keywordInput.focus();
    keywordInput.select();
  }

  function closeManualLookupDropdown() {
    const dd = document.getElementById("Scholarscope_ManualLookupDropDown");
    if (!dd) return;
    // dd.reset();
    dd.style.display = "none";
    dd._factorEl = null;
    dd.dataset.busy = "0";
    const submit = dd.querySelector(".Scholarscope_DropDownButtonPrimary");
    if (submit) {
      submit.textContent = "查询";
      submit.style.pointerEvents = "";
    }
  }

  async function submitManualLookupForm(ev) {
    ev.preventDefault();
    const dd = ensureManualLookupDropdown();
    if (dd.dataset.busy === "1") return;
    const factorEl = dd._factorEl;
    if (!factorEl) return;

    if (!dd.reportValidity()) {
      return;
    }

    const { q: rawKeyword = "", ...extraParams } =
      serializeManualLookupForm(dd);
    const keyword = String(rawKeyword).trim();
    const submit = dd.querySelector(".Scholarscope_DropDownButtonPrimary");
    dd.dataset.busy = "1";
    submit.textContent = "查询中…";
    submit.style.pointerEvents = "none";

    const result = await jcrLookup(keyword, { skipCache: true, extraParams });
    const quartileEl = getQuartileBadgeForFactor(factorEl);
    const origKw = factorEl.dataset.origKw || "";
    const origNorm = String(origKw).trim().toLowerCase();
    closeManualLookupDropdown();

    if (!result.errored && result.data && result.data.length > 0) {
      if (origNorm)
        jcrCacheSet(origNorm, { data: result.data, medHit: !!result.medHit });
      applyJcrToBadges(factorEl, quartileEl, result, origKw || keyword);
      if (isSearchResultsPage()) {
        if (CFG.autoFilter) applyFilter(true);
        if (CFG.autoSort) applySorting();
      }
      return;
    }
    if (!result.errored && result.medHit) {
      if (origNorm) jcrCacheSet(origNorm, { data: [], medHit: true });
      applyJcrToBadges(factorEl, quartileEl, result, origKw || keyword);
      window.alert("已被 MedLine 收录，无 IF/分区数据。");
      return;
    }
    if (result.errored) {
      window.alert("查询失败：" + (result.error || ""));
      return;
    }
    window.alert("未找到，请重试并调整关键词或搜索参数。");
  }

  // =========================================================================
  // Badge factories
  // =========================================================================
  const STATE_CLASSES = [
    "Scholarscope_NotFound",
    "Scholarscope_MedHit",
    "Scholarscope_IF_Ambiguous",
  ];
  function setBadge(el, text, color) {
    if (!el) return;
    el.textContent = text;
    el.style.backgroundColor = color;
  }
  function applyJcrToBadges(factorEl, quartileEl, result, journalKw) {
    result = result || {};
    const rows = result.data || [];
    const primary = rows[0];
    factorEl.classList.remove(...STATE_CLASSES);
    if (result.errored) {
      setBadge(factorEl, "N/A", "#616161");
      factorEl.dataset.jcrAll = "[]";
      setBadge(quartileEl, "N/A", "#616161");
      return;
    }
    if (result.medHit && (!rows || rows.length === 0)) {
      setBadge(factorEl, "No IF", "#0094DF");
      factorEl.classList.add("Scholarscope_MedHit");
      factorEl.dataset.origKw = journalKw || "";
      factorEl.dataset.jcrAll = "[]";
      factorEl.title =
        "已被 NLM/MedLine 收录，但 JCR/中科院分区表无此刊；点击可手动重试关键词";
      setBadge(quartileEl, "—", "#616161");
      return;
    }
    if (!rows || rows.length === 0) {
      setBadge(factorEl, "Not Found", "#616161");
      factorEl.classList.add("Scholarscope_NotFound");
      factorEl.dataset.origKw = journalKw || "";
      factorEl.dataset.jcrAll = "[]";
      setBadge(quartileEl, "N/A", "#616161");
      return;
    }
    const ifVal = primary.jif_2025;
    setBadge(
      factorEl,
      ifVal == null || ifVal === "" ? "N/A" : String(ifVal),
      factorColor(ifVal),
    );
    factorEl.dataset.jcrAll = JSON.stringify(rows);
    if (journalKw && !factorEl.dataset.origKw)
      factorEl.dataset.origKw = journalKw;
    if (rows.length >= 2) {
      factorEl.classList.add("Scholarscope_IF_Ambiguous");
      factorEl.title = "多个候选，点击查看";
    } else {
      factorEl.title = "点击查看 JCR 详情";
    }

    const q = pickDisplayQuartile(primary);
    setBadge(quartileEl, q || "N/A", q ? quartileColor(q) : "#616161");
  }

  function attachFactorClickHandler(factorEl) {
    factorEl.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (
        factorEl.classList.contains("Scholarscope_NotFound") ||
        factorEl.classList.contains("Scholarscope_MedHit")
      ) {
        openManualLookupDropdown(factorEl);
        return;
      }
      let rows = [];
      try {
        rows = JSON.parse(factorEl.dataset.jcrAll || "[]");
      } catch (e) {
        rows = [];
      }
      if (rows.length !== 0) showModal(jcrResultsModal(rows, 0, { factorEl }));
    });
  }

  function makeBadge(cls, clickable) {
    const attrs = clickable
      ? {
          class: `${cls} Scholarscope_Badge Scholarscope_BadgeClickable notranslate`,
          title: "点击查看 JCR 详情",
        }
      : { class: `${cls} Scholarscope_Badge notranslate` };
    const e = el("div", attrs);
    e.textContent = "…";
    if (clickable) attachFactorClickHandler(e);
    return e;
  }
  const makeFactorBadge = (cls) => makeBadge(cls, true);
  const makeQuartileBadge = (cls) => makeBadge(cls, false);

  // =========================================================================
  // Detail page
  // =========================================================================
  function getDetailJournalKeyword() {
    return getMetaContent("citation_publisher") || getDetailJournalTitle();
  }

  function getDetailPmid() {
    const m = location.pathname.match(/\/(\d+)\/?$/);
    return m ? m[1] : "";
  }

  async function renderDetailHeader() {
    const heading = document.getElementById("full-view-heading");
    if (!heading) return;
    const articleCitation = heading.querySelector(".article-citation");
    if (
      !articleCitation ||
      articleCitation.querySelector("#Scholarscope_JournalDetailFrame")
    )
      return;

    const frame = el("div", {
      id: "Scholarscope_JournalDetailFrame",
      class: "Scholarscope_JournalDetailFrame notranslate",
    });

    const pubTypeNode = heading.querySelector(".publication-type");
    if (pubTypeNode) {
      const at = el("div", {
        class:
          "Scholarscope_ArticleType Scholarscope_Badge Scholarscope_BadgeBlue",
      });
      at.textContent = pubTypeNode.textContent.trim();
      pubTypeNode.remove();
      frame.appendChild(at);
    }

    const factor = makeFactorBadge("Scholarscope_Factor");
    const quartile = makeQuartileBadge("Scholarscope_Quartile");
    frame.appendChild(factor);
    frame.appendChild(quartile);
    articleCitation.insertBefore(frame, articleCitation.firstChild);

    const source = articleCitation.querySelector(".article-source");
    if (source) {
      source.style.backgroundColor = "transparent";
      source.style.padding = "4px 0";
    }

    const kw = getDetailJournalKeyword();
    if (kw) {
      const result = await jcrLookup(kw);
      applyJcrToBadges(factor, quartile, result, kw);
    } else {
      factor.textContent = "N/A";
      quartile.textContent = "N/A";
    }
  }

  async function renderDetailTimesCited() {
    if (!CFG.showCitation) return;
    const ids = document.getElementById("full-view-identifiers");
    if (!ids || document.getElementById("Scholarscope_TimesCited")) return;
    const pmid = getDetailPmid();
    if (!pmid) return;
    const doi = getMetaContent("citation_doi");
    const title = (
      document.querySelector(".heading-title").textContent || ""
    ).trim();
    const res = await iciteBatch([pmid]);
    const info = res[pmid];
    const n =
      info && typeof info.citation_count === "number"
        ? info.citation_count
        : null;
    const wrap = el("ul", { class: "identifiers" });
    const href =
      n > 0
        ? `${PUBMED_BASE}?linkname=pubmed_pubmed_citedin&from_uid=${pmid}`
        : "#";
    const liCite = el(
      "li",
      { id: "Scholarscope_TimesCited" },
      el(
        "a",
        n > 0
          ? {
              href,
              target: "_blank",
              rel: "noopener",
              class: "Scholarscope_Action_Cited",
            }
          : { href: "#", class: "Scholarscope_Action_Cited" },
        `Cited: ${n}`,
      ),
    );
    const liGoogle = el(
      "li",
      null,
      el(
        "a",
        {
          href: `${SCHOLAR_BASE}?q=${encodeURIComponent(doi || title)}`,
          class: "Scholarscope_Action_GScholar",
          target: "_blank",
          rel: "noopener",
        },
        `Google Scholar`,
      ),
    );
    wrap.append(liCite, liGoogle);
    ids.parentNode.insertBefore(wrap, ids.nextSibling);
  }

  // =========================================================================
  // Appendix badge group (search page + detail page similar/cited-by lists)
  // =========================================================================
  function extractDocsumJournalYear(docsum) {
    const c = docsum.querySelector(
      ".docsum-journal-citation, .short-journal-citation",
    );
    if (!c) return { journal: "", year: "" };
    const raw = c.textContent || "";
    const firstDot = raw.indexOf(".");
    const journal = (firstDot > 0 ? raw.slice(0, firstDot) : raw).trim();
    const m = raw.match(/\b(19|20)\d{2}\b/);
    return { journal, year: m ? m[0] : "" };
  }
  function extractDocsumArticleType(docsum) {
    const c = docsum.querySelector(".publication-type");
    if (!c) return "";
    return (c.textContent || "").trim().replace(/\.+$/, "");
  }
  function extractDocsumPmid(docsum, pmidEl) {
    if (pmidEl && pmidEl.textContent) return pmidEl.textContent.trim();
    const dataId =
      docsum.getAttribute && docsum.getAttribute("data-article-id");
    if (dataId) return dataId;
    const link = docsum.querySelector("a.docsum-title");
    if (link) {
      const m = (link.getAttribute("href") || "").match(/\/(\d+)\/?/);
      if (m) return m[1];
    }
    return "";
  }

  function extractDocsumDoi(docsum) {
    const c = docsum.querySelector(".full-journal-citation");
    if (!c) return "";
    const text = c.textContent || "";
    const m = text.match(/doi:\s*(10\.\d{4,5}\/[^\s]+)/i);
    if (!m) return "";
    return m[1].replace(/[.;,]+$/, "");
  }

  function injectAppendixFrame(docsum) {
    if (docsum.querySelector(".Scholarscope_Appendix_JournalFrame"))
      return null;
    const content = docsum.querySelector(".docsum-content");
    const lcc = docsum.querySelector(".docsum-citation") || content;
    if (!lcc) return null;

    const { journal: journalKw, year } = extractDocsumJournalYear(docsum);
    const pmidEl = docsum.querySelector(".docsum-pmid");
    const pmid = extractDocsumPmid(docsum, pmidEl);
    const articleType = extractDocsumArticleType(docsum);
    const doi = extractDocsumDoi(docsum);
    const titleNode = docsum.querySelector("a.docsum-title");
    const articleTitle = ((titleNode && titleNode.textContent) || "").trim();

    const frame = el("div", {
      class: "Scholarscope_Appendix_JournalFrame notranslate",
    });
    frame.dataset.pmid = pmid;

    const journalDiv = el("div", {
      class: "Scholarscope_Appendix_Journal Scholarscope_Badge notranslate",
    });
    journalDiv.textContent = journalKw || "—";
    frame.appendChild(journalDiv);

    const factor = makeFactorBadge("Scholarscope_Appendix_Factor");
    frame.appendChild(factor);
    const quartile = makeQuartileBadge("Scholarscope_Appendix_Quartile");
    frame.appendChild(quartile);

    if (year) {
      const yd = el("div", {
        class:
          "Scholarscope_Appendix_Year Scholarscope_Badge Scholarscope_BadgeBlue",
      });
      yd.textContent = year;
      frame.appendChild(yd);
    }

    if (articleType) {
      const at = el("div", {
        class:
          "Scholarscope_Appendix_ArticleType Scholarscope_Badge Scholarscope_BadgeBlue notranslate",
      });
      at.textContent = articleType;
      frame.appendChild(at);
    }

    if (doi && pmidEl && pmidEl.parentNode) {
      const doiSpan = el("span", { class: "Scholarscope_DOI notranslate" });
      doiSpan.appendChild(document.createTextNode(" doi: "));
      doiSpan.appendChild(
        el(
          "a",
          {
            class: "Scholarscope_DOILink",
            href: "https://doi.org/" + doi,
            target: "_blank",
            rel: "noopener",
          },
          doi,
        ),
      );
      pmidEl.parentNode.insertBefore(doiSpan, pmidEl.nextSibling);
    }

    const pubType = docsum.querySelector(".publication-type");
    if (pubType) pubType.remove();
    const fullJournal = docsum.querySelector(".full-journal-citation");
    if (fullJournal) fullJournal.remove();

    lcc.insertBefore(frame, lcc.firstChild);

    if (content && pmid)
      injectActionRow(docsum, content, pmid, articleTitle, doi);

    return { docsum, frame, factor, quartile, journalKw, pmid };
  }

  function injectActionRow(docsum, content, pmid, articleTitle, doi) {
    if (docsum.querySelector(".Scholarscope_ActionRow")) return;
    const row = el("div", {
      class: "docsum-citation full-citation Scholarscope_ActionRow notranslate",
    });

    const citedHref = `${PUBMED_BASE}?linkname=pubmed_pubmed_citedin&from_uid=${pmid}`;
    const citedLink = el(
      "a",
      {
        class: "citation-part Scholarscope_Action_Cited",
        href: citedHref,
        target: "_blank",
        rel: "noopener",
      },
      CFG.showCitation ? "Cited: …" : "Cited: —",
    );
    row.appendChild(citedLink);

    const gsHref =
      `${SCHOLAR_BASE}?q=` + encodeURIComponent(doi || articleTitle || pmid);
    const gsLink = el(
      "a",
      {
        class:
          "spaced-citation-item citation-part Scholarscope_Action_GScholar",
        href: gsHref,
        target: "_blank",
        rel: "noopener",
      },
      "Google Scholar",
    );
    row.appendChild(gsLink);

    const absBtn = el(
      "div",
      {
        class:
          "spaced-citation-item citation-part Scholarscope_Action_Abstract",
        title: "点击展开/收起摘要",
      },
      "Full Abstract",
    );
    absBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleAbstract(docsum, pmid);
    });
    row.appendChild(absBtn);

    content.appendChild(row);
  }

  async function fillAppendixJcr(entry) {
    if (!entry?.journalKw) {
      entry.factor.textContent = "N/A";
      entry.quartile.textContent = "N/A";
      return;
    }
    const opts = entry.truncated
      ? { extraParams: { f: entry.truncated } }
      : undefined;
    // Keep '…' in the keyword: it differentiates the cache key per truncation mode
    // and preserves the original Scholar string in dataset.origKw. The JCR API
    // strips chars outside [A-Z0-9 &'()+,\-./:] server-side anyway.
    const result = await jcrLookup(entry.journalKw, opts);
    applyJcrToBadges(entry.factor, entry.quartile, result, entry.journalKw);
  }

  async function fillAppendixCitationBatch(entries) {
    if (!CFG.showCitation) return;
    const pmids = entries.map((e) => e.pmid).filter(Boolean);
    if (!pmids.length) return;
    const map = await iciteBatch(pmids);
    entries.forEach((e) => {
      const cc = e.docsum.querySelector(".Scholarscope_Action_Cited");
      if (!cc) return;
      const info = map[e.pmid];
      if (info && typeof info.citation_count === "number")
        cc.textContent = `Cited: ${info.citation_count}`;
      else cc.textContent = "Cited: —";
    });
  }

  // =========================================================================
  // Abstract toggle
  // =========================================================================
  async function toggleAbstract(docsum, pmid) {
    const content = docsum.querySelector(".docsum-content");
    if (!content) return;
    let snippet = content.querySelector(
      `.full-view-snippet[data-fullview-pmid="${pmid}"]`,
    );
    if (snippet) {
      snippet.remove();
      return;
    }
    snippet = el("div", {
      class: "full-view-snippet",
      dataset: { fullviewPmid: pmid },
    });
    snippet.textContent = "Loading…";
    snippet.style.opacity = "0.6";
    content.appendChild(snippet);
    try {
      const { abstractHtml } = await efetchAbstractXml(pmid);
      snippet.innerHTML = DOMPurify.sanitize(abstractHtml);
      snippet.style.opacity = "1";
      snippet.style.borderLeft = "solid 0.2rem #0094DF";
      snippet.style.paddingLeft = "1rem";
    } catch (e) {
      snippet.textContent = "加载摘要失败：" + e.message;
      snippet.style.opacity = "1";
    }
  }

  // =========================================================================
  // Google Scholar
  // =========================================================================
  const SCHOLAR_RESULT_SELECTOR = ".gs_r.gs_or.gs_scl";
  const DOCSUM_SELECTOR =
    ".search-results-chunk .full-docsum, #gs_res_ccl_mid .full-docsum";

  function extractScholarTitle(gsR) {
    const a = gsR.querySelector(".gs_rt > a");
    return a ? (a.textContent || "").trim() : "";
  }

  function parseScholarMeta(gsR) {
    const a = gsR.querySelector(".gs_a");
    const raw = a ? (a.textContent || "").trim() : "";
    let firstAuthor = "";
    let journal = "";
    let year = "";
    if (!raw) return { firstAuthor, journal, year, truncated: false };
    // Scholar uses NBSP ( ) before the hyphen that separates the truncated
    // author list from the journal segment; normalize to regular spaces so a
    // single split rule covers both truncated and non-truncated rows.
    const text = raw.replace(/ /g, " ");
    const parts = text.split(" - ");
    if (parts.length) {
      const head = parts[0].split(",")[0] || "";
      firstAuthor = head.replace(/[…\s]+$/, "").trim();
    }
    if (parts.length >= 3) {
      const middle = parts.slice(1, -1).join(" - ");
      const m = middle.match(/^(.*?),\s*((?:19|20)\d{2})\s*$/);
      if (m) {
        journal = m[1].trim();
        year = m[2];
      } else if (/^(?:19|20)\d{2}$/.test(middle.trim())) {
        year = middle.trim();
      }
    } else if (parts.length === 2) {
      const m = parts[1].match(/^(.*?),\s*((?:19|20)\d{2})\s*$/);
      if (m) {
        journal = m[1].trim();
        year = m[2];
      }
    }
    // 'JOURNAL…' → f=1 (prefix); '…JOURNAL…' → f=2 (substring); '…JOURNAL' → f=3 (suffix)
    let truncated = "";
    if (journal) {
      const startsTrunc = journal.startsWith("…");
      const endsTrunc = /…\s*$/.test(journal);
      if (startsTrunc && endsTrunc) truncated = "2";
      else if (endsTrunc) truncated = "1";
      else if (startsTrunc) truncated = "3";
    }
    return { firstAuthor, journal, year, truncated };
  }

  function extractScholarCitedCount(gsR) {
    const links = gsR.querySelectorAll(".gs_fl a");
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (href.indexOf("?cites=") >= 0 || href.indexOf("&cites=") >= 0) {
        const m = (link.textContent || "").match(/(\d[\d,]*)/);
        if (m) return parseInt(m[1].replace(/,/g, ""), 10);
      }
    }
    return null;
  }

  async function esearchPmid(title, journal) {
    const t = (title || "").trim();
    if (!t) throw new Error("no title");
    const j = (journal || "").trim();
    const isShortTitle = t.length < 12 || t.split(/\s+/).length < 8;
    const buildUrl = (term) => {
      const u = new URL(ESEARCH_ENDPOINT);
      u.searchParams.set("db", "pubmed");
      u.searchParams.set("retmax", "1");
      u.searchParams.set("retmode", "json");
      u.searchParams.set("term", term);
      if (CFG.pubmedApiKey) u.searchParams.set("api_key", CFG.pubmedApiKey);
      return u.toString();
    };
    const tryTerm = async (term) => {
      const r = await gmFetch(buildUrl(term));
      const ids = r && r.esearchresult && r.esearchresult.idlist;
      return Array.isArray(ids) && ids.length ? ids[0] : "";
    };
    return efetchQueue(async () => {
      if (isShortTitle) {
        if (j) {
          const id = await tryTerm(`(${t}[Title]) AND (${j}[Journal])`);
          if (id) return id;
        }
        const id2 = await tryTerm(`(${t}[Title])`);
        if (id2) return id2;
      }
      return await tryTerm(t);
    });
  }

  async function toggleScholarAbstract(gsR) {
    const ri = gsR.querySelector(".gs_ri") || gsR;
    const existing = ri.querySelector(
      '.full-view-snippet[data-fullview-scholar="1"]',
    );
    if (existing) {
      existing.remove();
      return;
    }
    const snippet = el("div", {
      class: "full-view-snippet",
      dataset: { fullviewScholar: "1" },
    });
    snippet.textContent = "Loading…";
    snippet.style.opacity = "0.6";
    const after = ri.querySelector(".gs_rs");
    if (after && after.parentNode === ri)
      ri.insertBefore(snippet, after.nextSibling);
    else ri.appendChild(snippet);
    try {
      const title = extractScholarTitle(gsR);
      const scholarMeta = parseScholarMeta(gsR);
      const pmid = await esearchPmid(
        title,
        scholarMeta.truncated ? "" : scholarMeta.journal,
      );
      if (!pmid) {
        snippet.textContent = "未找到 PubMed 记录";
        snippet.style.opacity = "1";
        return;
      }
      const { abstractHtml, articleTitleHtml, journalTitleHtml, doiHtml } =
        await efetchAbstractXml(pmid);
      const meta =
        `<div class="Scholarscope_AbstractMeta">` +
        `PMID: <a href="${PUBMED_BASE}${pmid}/" target="_blank" rel="noopener">${pmid}</a>` +
        (doiHtml
          ? `DOI: <a href="https://doi.org/${doiHtml}" target="_blank" rel="noopener">${doiHtml}</a>`
          : "") +
        (articleTitleHtml
          ? `<div class="Scholarscope_AbstractTitle">${articleTitleHtml}</div>`
          : "") +
        (journalTitleHtml
          ? `<div class="Scholarscope_AbstractJournal"><i>${journalTitleHtml}</i></div>`
          : "") +
        `</div>`;
      snippet.innerHTML = DOMPurify.sanitize(meta + abstractHtml);
      snippet.style.opacity = "1";
      snippet.style.borderLeft = "solid 0.2rem #0094DF";
      snippet.style.paddingLeft = "1rem";
    } catch (e) {
      snippet.textContent = "加载摘要失败：" + (e && e.message ? e.message : e);
      snippet.style.opacity = "1";
    }
  }

  async function fetchScholarCite(cid) {
    if (!cid) throw new Error("no cid");
    const url = `${SCHOLAR_BASE}?q=info:${encodeURIComponent(cid)}:scholar.google.com/&output=cite&hl=en`;
    return scholarQueue(() => gmFetchText(url));
  }

  function extractFromCite(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const citrs = doc.querySelectorAll(".gs_citr");
    let journal = "";
    let title = "";
    for (const citr of citrs) {
      const it = citr.querySelector("i");
      if (!journal) journal = it ? it.textContent.trim() : "";
      if (title) continue;
      let beforeText = "";
      for (const node of citr.childNodes) {
        if (node === it) break;
        beforeText += node.textContent || "";
      }
      // MLA / Chicago: "Title."
      const quoted = beforeText.match(/["“]([^"”]+)["”]/);
      if (quoted && quoted[1]) {
        title = quoted[1].trim().replace(/\.$/, "");
      } else {
        // APA / Harvard: ...). Title. <journal>
        const apa = beforeText.match(/\)\.\s+([^.]+?)\.\s*$/);
        if (apa && apa[1]) {
          title = apa[1].trim();
        } else {
          // Vancouver: "Smith J. Title. Journal."
          const vanc = beforeText.match(/[A-Z]\.\s+([^.]+?)\.\s*$/);
          if (vanc && vanc[1]) title = vanc[1].trim();
        }
      }
    }
    return { journal, title };
  }

  async function recoverScholarJournal(entry, journalDiv) {
    if (!entry || !entry.cid || !journalDiv) return false;
    try {
      const html = await fetchScholarCite(entry.cid);
      const { journal: fullName, title: fullTitle } = extractFromCite(html);
      let updated = false;

      // Recover truncated title
      if (fullTitle && entry.gsR) {
        const titleLink =
          entry.gsR.querySelector(".gs_rt > a") ||
          entry.gsR.querySelector(".gs_rt");
        if (titleLink) {
          const currentTitle = (titleLink.textContent || "").trim();
          if (currentTitle.includes("…") && !fullTitle.includes("…")) {
            titleLink.textContent = fullTitle;
            updated = true;
          }
        }
      }

      // Recover truncated journal
      if (fullName && fullName !== journalDiv.textContent) {
        journalDiv.textContent = entry.journalKw = fullName;
        entry.truncated = "";
        if (entry.factor) {
          entry.factor.textContent = "…";
          entry.factor.dataset.origKw = fullName;
          entry.factor.style.backgroundColor = "#616161";
          entry.factor.classList.remove(...STATE_CLASSES);
        }
        if (entry.quartile) {
          entry.quartile.textContent = "…";
          entry.quartile.style.backgroundColor = "#616161";
        }
        await fillAppendixJcr(entry);
        if (CFG.autoFilter) applyFilter(true);
        if (CFG.autoSort) applySorting();
        updated = true;
      }

      return updated;
    } catch (e) {
      return false;
    }
  }

  function injectScholarAppendix(gsR) {
    if (!gsR || gsR.dataset.scholarscopeSeen === "1") return null;
    gsR.dataset.scholarscopeSeen = "1";
    gsR.classList.add("full-docsum");

    const ri = gsR.querySelector(".gs_ri");
    if (!ri) return null;

    const meta = parseScholarMeta(gsR);
    const title = extractScholarTitle(gsR);
    const cited = extractScholarCitedCount(gsR);
    const titleTruncated = title.includes("…");

    const entry = {
      gsR,
      cid: gsR.getAttribute("data-cid") || gsR.getAttribute("data-aid") || "",
      factor: null,
      quartile: null,
      journalKw: meta.journal,
      truncated: meta.truncated,
    };

    const frame = el("div", {
      class: "Scholarscope_Appendix_JournalFrame notranslate",
    });
    frame.dataset.cid = entry.cid;

    const journalDiv = el("div", {
      class: "Scholarscope_Appendix_Journal Scholarscope_Badge notranslate",
    });
    journalDiv.textContent = meta.journal || "—";
    frame.appendChild(journalDiv);

    if ((entry.truncated || titleTruncated) && entry.cid) {
      journalDiv.classList.add("Scholarscope_BadgeClickable");
      journalDiv.title = "点击通过 Cite 弹窗补全完整杂志名或标题";
      journalDiv.addEventListener(
        "click",
        async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (journalDiv.dataset.busy === "1") return;
          journalDiv.dataset.busy = "1";
          journalDiv.classList.remove("Scholarscope_BadgeClickable");
          journalDiv.removeAttribute("title");
          journalDiv.style.opacity = "0.6";
          const ok = await recoverScholarJournal(entry, journalDiv);
          journalDiv.style.opacity = "";
          journalDiv.dataset.busy = "0";
          if (!ok) window.alert("未能从 Cite 弹窗恢复完整内容");
        },
        { once: true },
      );
    }

    const factor = makeFactorBadge("Scholarscope_Appendix_Factor");
    frame.appendChild(factor);
    const quartile = makeQuartileBadge("Scholarscope_Appendix_Quartile");
    frame.appendChild(quartile);
    entry.factor = factor;
    entry.quartile = quartile;

    if (meta.year) {
      const yd = el("div", {
        class:
          "Scholarscope_Appendix_Year Scholarscope_Badge Scholarscope_BadgeBlue",
      });
      yd.textContent = meta.year;
      frame.appendChild(yd);
    }

    const rt = ri.querySelector(".gs_rt");
    if (rt && rt.nextSibling) ri.insertBefore(frame, rt.nextSibling);
    else ri.insertBefore(frame, ri.firstChild);

    if (typeof cited === "number") {
      const citedSpan = el("span", {
        class: "Scholarscope_Action_Cited",
        hidden: "hidden",
        style: "display:none",
      });
      citedSpan.textContent = `Cited: ${cited}`;
      frame.appendChild(citedSpan);
    }

    const fl =
      gsR.querySelector(".gs_fl.gs_flb") || gsR.querySelector(".gs_fl");
    const sav = fl && fl.querySelector(".gs_or_sav");
    if (fl && sav) {
      const trimmedTitle = (title || "").trim();
      const pubmedHref = trimmedTitle
        ? `${PUBMED_BASE}?term=${encodeURIComponent(trimmedTitle).replace(/%20/g, "+")}`
        : "";
      if (pubmedHref) {
        const pmLink = el(
          "a",
          {
            class: "Scholarscope_Action_PubMedSearch gs_or_btn",
            href: pubmedHref,
            target: "_blank",
            rel: "noopener",
            role: "button",
            title: "在 PubMed 中搜索（标题）",
          },
          "PubMed",
        );
        fl.insertBefore(pmLink, sav);
        fl.insertBefore(document.createTextNode(" "), sav);
      }
      const absBtn = el(
        "a",
        {
          class: "Scholarscope_Action_Abstract gs_or_btn",
          href: "javascript:void(0)",
          role: "button",
          title: "获取 PubMed 第一条结果的完整摘要",
        },
        "Full Abstract",
      );
      absBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        toggleScholarAbstract(gsR);
      });
      fl.insertBefore(absBtn, sav);
      fl.insertBefore(document.createTextNode(" "), sav);
    }

    return entry;
  }

  async function processBatch(nodes, injectFn, withCitation) {
    const entries = [];
    nodes.forEach((n) => {
      const e = injectFn(n);
      if (e) entries.push(e);
    });
    if (!entries.length) return;
    const tasks = [Promise.all(entries.map(fillAppendixJcr))];
    if (withCitation) tasks.push(fillAppendixCitationBatch(entries));
    await Promise.all(tasks);
    if (CFG.autoFilter) applyFilter(true);
    if (CFG.autoSort) applySorting();
  }

  function injectShowMoreButton() {
    const mid = document.getElementById("gs_res_ccl_mid");
    if (!mid) return;
    const existing = document.getElementById("Scholarscope_ShowMoreButton");
    if (existing) return;
    const btn = el(
      "a",
      {
        id: "Scholarscope_ShowMoreButton",
        class: "Scholarscope_ShowMoreButton notranslate",
        href: "javascript:void(0)",
        role: "button",
      },
      "显示更多结果",
    );
    const initialStart =
      parseInt(new URLSearchParams(location.search).get("start") || "0", 10) ||
      0;
    btn.dataset.nextStart = String(initialStart + 10);
    const errBox = el("div", {
      id: "Scholarscope_ShowMoreError",
      class: "Scholarscope_ShowMoreError",
      style: "display:none",
    });
    const parent = mid.parentNode;
    parent.insertBefore(btn, mid.nextSibling);
    parent.insertBefore(errBox, btn.nextSibling);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      handleShowMoreClick(btn, errBox);
    });
  }

  async function handleShowMoreClick(btn, errBox) {
    if (btn.getAttribute("aria-disabled") === "true") return;
    const nextStart = parseInt(btn.dataset.nextStart || "10", 10);
    btn.setAttribute("aria-disabled", "true");
    const origText = btn.textContent;
    btn.textContent = "加载中…";
    errBox.style.display = "none";
    errBox.textContent = "";
    try {
      const u = new URL(location.href);
      u.searchParams.set("start", String(nextStart));
      const html = await gmFetchText(u.toString());
      const doc = new DOMParser().parseFromString(html, "text/html");
      const newNodes = Array.from(
        doc.querySelectorAll(SCHOLAR_RESULT_SELECTOR),
      );
      const hasNext = !!doc.querySelector(".gs_ico_nav_next");
      if (!newNodes.length) {
        errBox.textContent =
          "Google Scholar 已限制频繁请求或无更多结果，请稍后再试或在新标签直接打开下一页。";
        errBox.style.display = "block";
        btn.textContent = origText;
        btn.removeAttribute("aria-disabled");
        return;
      }
      const mid = document.getElementById("gs_res_ccl_mid");
      const adopted = [];
      newNodes.forEach((n) => {
        const node = document.adoptNode(n);
        mid.appendChild(node);
        adopted.push(node);
      });
      await processBatch(adopted, injectScholarAppendix, false);
      btn.dataset.nextStart = String(nextStart + 10);
      if (!hasNext) {
        btn.textContent = "已无更多结果";
        btn.setAttribute("aria-disabled", "true");
      } else {
        btn.textContent = origText;
        btn.removeAttribute("aria-disabled");
      }
    } catch (e) {
      errBox.textContent = "加载失败：" + (e && e.message ? e.message : e);
      errBox.style.display = "block";
      btn.textContent = origText;
      btn.removeAttribute("aria-disabled");
    }
  }

  function initScholar() {
    buildToolbar();
    const selectBtn = document.getElementById("Scholarscope_SelectShownFrame");
    if (selectBtn) selectBtn.style.display = "none";
    const initial = Array.from(
      document.querySelectorAll(`#gs_res_ccl_mid > ${SCHOLAR_RESULT_SELECTOR}`),
    );
    processBatch(initial, injectScholarAppendix, false);
    injectShowMoreButton();
  }

  // =========================================================================
  // Search page toolbar: filter + sort + select-shown
  // =========================================================================
  function isSearchResultsPage() {
    if (document.querySelector(".search-results-chunk")) return true;
    if (
      document.querySelector(".full-docsum") &&
      !document.getElementById("full-view-heading")
    )
      return true;
    return false;
  }
  function isDetailPage() {
    return !!document.getElementById("full-view-heading");
  }

  function buildToolbar() {
    if (document.getElementById("Scholarscope_Toolbar")) return;
    const anchor =
      document.getElementById("gs_ab_md") ||
      document.querySelector(".top-wrapper") ||
      document.querySelector(".search-results-view-switch") ||
      document.querySelector(".results-amount-container");
    if (!anchor) return;

    const bar = el("div", {
      id: "Scholarscope_Toolbar",
      class: "Scholarscope_Toolbar notranslate",
    });
    const filterBtn = el(
      "div",
      {
        id: "Scholarscope_FilterButton",
        class:
          "Scholarscope_ToolbarButton Scholarscope_FilterButton notranslate",
      },
      "页内筛选",
    );
    const sortBtn = el(
      "div",
      {
        id: "Scholarscope_SortButton",
        class: "Scholarscope_ToolbarButton Scholarscope_SortButton notranslate",
      },
      sortButtonLabel(),
    );
    const selectBtn = el(
      "div",
      {
        id: "Scholarscope_SelectShownFrame",
        class:
          "Scholarscope_ToolbarButton Scholarscope_SelectShownFrame notranslate",
      },
      "全选",
    );
    const dropdown = buildFilterDropdown();

    bar.appendChild(filterBtn);
    bar.appendChild(sortBtn);
    bar.appendChild(selectBtn);
    bar.appendChild(dropdown);

    anchor.parentNode.insertBefore(bar, anchor.nextSibling);

    filterBtn.addEventListener("click", () => {
      dropdown.style.display =
        dropdown.style.display === "block" ? "none" : "block";
    });
    sortBtn.addEventListener("click", () => {
      CFG.sortingMethod = CFG.sortingMethod === 1 ? 2 : 1;
      sortBtn.textContent = sortButtonLabel();
      saveCfg();
      applySorting();
    });
    selectBtn.addEventListener("click", selectShownDocsums);
  }

  function sortButtonLabel() {
    return CFG.sortingMethod === 2 ? "按引用量排序" : "按分数排序";
  }

  function buildFilterDropdown() {
    const dd = el("div", {
      id: "Scholarscope_FilterDropDown",
      class: `Scholarscope_DropDown${isScholarPage() ? " gs_query" : ""} notranslate`,
      style: "display:none",
    });

    const container = el("div", { class: "Scholarscope_FilterContainerFrame" });

    const inputs = el("div", { class: "Scholarscope_FilterValueInputFrame" }, [
      el("div", { class: "Scholarscope_TermWrapper" }, [
        document.createTextNode("IF最小值："),
        el("input", {
          id: "Scholarscope_FilterValueMinInput",
          class: "Scholarscope_FilterValueInput",
          type: "number",
          step: "0.1",
          min: "0",
          max: "2000",
          value: String(CFG.filter.minIF),
        }),
      ]),
      el("div", { class: "Scholarscope_TermWrapper" }, [
        document.createTextNode("IF最大值："),
        el("input", {
          id: "Scholarscope_FilterValueMaxInput",
          class: "Scholarscope_FilterValueInput",
          type: "number",
          step: "0.1",
          min: "0",
          max: "2000",
          value: String(CFG.filter.maxIF),
        }),
      ]),
    ]);

    const qs = el("div", { class: "Scholarscope_FilterQuartileInputFrame" });
    ["q1", "q2", "q3", "q4"].forEach((k, i) => {
      const line = el("div", {}, [
        el("input", {
          id: `Scholarscope_FilterValueQuartile${i + 1}Input`,
          type: "checkbox",
          checked: !!CFG.filter[k] ? true : false,
        }),
        el(
          "label",
          {
            class: "Scholarscope_FilterValueQuartileTexts",
            for: `Scholarscope_FilterValueQuartile${i + 1}Input`,
          },
          CFG.quartileSource === "cas" ? `${i + 1}区` : `Q${i + 1}`,
        ),
      ]);
      qs.appendChild(line);
    });

    container.appendChild(inputs);
    container.appendChild(qs);

    const autoCheckbox = el("div", { class: "Scholarscope_InlineCheck" }, [
      el("div", {}, [
        el("input", {
          id: "Scholarscope_FilterCheckbox",
          type: "checkbox",
          checked: !!CFG.autoFilter ? true : false,
        }),
        el("label", { for: "Scholarscope_FilterCheckbox" }, "自动筛选"),
      ]),
      el("div", {}, [
        el("input", {
          id: "Scholarscope_SortCheckbox",
          type: "checkbox",
          checked: !!CFG.autoSort ? true : false,
        }),
        el("label", { for: "Scholarscope_SortCheckbox" }, "自动排序"),
      ]),
    ]);

    const apply = el(
      "div",
      {
        class: "Scholarscope_DropDownButton Scholarscope_DropDownButtonPrimary",
      },
      "应用",
    );
    const close = el(
      "div",
      {
        class: "Scholarscope_DropDownButton Scholarscope_DropDownButtonDanger",
      },
      "取消筛选",
    );
    const buttonRow = el("div", { class: "Scholarscope_ButtonRow" }, [
      apply,
      close,
    ]);

    dd.appendChild(container);
    dd.appendChild(autoCheckbox);
    dd.appendChild(buttonRow);

    apply.addEventListener("click", () => {
      CFG.filter.minIF =
        parseFloat(
          dd.querySelector("#Scholarscope_FilterValueMinInput").value,
        ) || 0;
      CFG.filter.maxIF =
        parseFloat(
          dd.querySelector("#Scholarscope_FilterValueMaxInput").value,
        ) || 2000;
      ["q1", "q2", "q3", "q4"].forEach((k, i) => {
        CFG.filter[k] = dd.querySelector(
          `#Scholarscope_FilterValueQuartile${i + 1}Input`,
        ).checked
          ? 1
          : 0;
      });
      CFG.autoFilter = dd.querySelector("#Scholarscope_FilterCheckbox").checked;
      CFG.autoSort = dd.querySelector("#Scholarscope_SortCheckbox").checked;
      saveCfg();
      applyFilter(true);
      dd.style.display = "none";
    });
    close.addEventListener("click", () => {
      applyFilter(false);
      dd.style.display = "none";
    });

    return dd;
  }

  function applyFilter(enabled) {
    const docsums = document.querySelectorAll(DOCSUM_SELECTOR);
    const selectBtn = document.getElementById("Scholarscope_SelectShownFrame");
    let anyHidden = false;
    docsums.forEach((ds) => {
      if (!enabled) {
        ds.style.height = "";
        ds.style.marginBottom = "";
        return;
      }
      const f = ds.querySelector(".Scholarscope_Appendix_Factor");
      const q = ds.querySelector(".Scholarscope_Appendix_Quartile");
      if (!f || !q) return;
      const fv = parseFloat(f.textContent);
      const qv = (q.textContent || "").replace(/\s+/g, "").toUpperCase();
      const anyQSelected =
        CFG.filter.q1 + CFG.filter.q2 + CFG.filter.q3 + CFG.filter.q4 > 0;
      let qMatch = !anyQSelected;
      if (!qMatch) {
        if (CFG.filter.q1 && (qv === "Q1" || qv === "1区")) qMatch = true;
        else if (CFG.filter.q2 && (qv === "Q2" || qv === "2区")) qMatch = true;
        else if (CFG.filter.q3 && (qv === "Q3" || qv === "3区")) qMatch = true;
        else if (CFG.filter.q4 && (qv === "Q4" || qv === "4区")) qMatch = true;
      }
      const ifHit =
        !isNaN(fv) && fv >= CFG.filter.minIF && fv <= CFG.filter.maxIF;
      const visible = qMatch && ifHit;
      if (!visible) {
        ds.style.height = "0px";
        ds.style.margin = "0";
        ds.style.padding = "0";
        ds.style.overflow = "hidden";
        anyHidden = true;
      } else {
        ds.style.height = "";
        ds.style.marginBottom = "";
        ds.style.overflow = "";
      }
    });
    if (selectBtn)
      selectBtn.style.visibility = enabled && anyHidden ? "visible" : "hidden";
  }

  function applySorting() {
    const docsums = Array.from(document.querySelectorAll(DOCSUM_SELECTOR));
    if (docsums.length < 2) return;
    const holders = docsums.map(
      (ds) => ds.closest("li, article.full-docsum") || ds,
    );
    const target = holders[0].parentElement;
    if (!target) return;
    holders.sort((a, b) => readSortValue(b) - readSortValue(a));
    holders.forEach((h) => target.appendChild(h));
  }
  function readSortValue(holder) {
    const ds =
      holder.classList && holder.classList.contains("full-docsum")
        ? holder
        : holder.querySelector(".full-docsum") || holder;
    if (CFG.sortingMethod === 2) {
      const cc = ds.querySelector(".Scholarscope_Action_Cited");
      if (cc) {
        const m = (cc.textContent || "").match(/(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : -1;
      }
      return -1;
    }
    const f = ds.querySelector(".Scholarscope_Appendix_Factor");
    if (f) {
      const v = parseFloat(f.textContent);
      return isNaN(v) ? -1 : v;
    }
    return -1;
  }

  function selectShownDocsums() {
    const docsums = document.querySelectorAll(DOCSUM_SELECTOR);
    docsums.forEach((ds) => {
      if (ds.style.height === "0px") return;
      const cb = ds.querySelector(
        '.search-result-selector input[type="checkbox"], input.search-result-selector',
      );
      if (cb && !cb.checked) cb.click();
    });
  }

  // =========================================================================
  // Bootstrap per page type
  // =========================================================================
  function watchDocsumList() {
    const processNew = () => {
      const fresh = Array.from(
        document.querySelectorAll(".full-docsum"),
      ).filter((ds) => !ds.dataset.scholarscopeSeen);
      fresh.forEach((ds) => (ds.dataset.scholarscopeSeen = "1"));
      if (fresh.length) processBatch(fresh, injectAppendixFrame, true);
    };
    processNew();
    const target =
      document.querySelector(".search-results-chunk") ||
      document.querySelector("main") ||
      document.body;
    const obs = new MutationObserver((muts) => {
      let need = false;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (
            n.nodeType === 1 &&
            ((n.classList && n.classList.contains("full-docsum")) ||
              (n.querySelector && n.querySelector(".full-docsum")))
          ) {
            need = true;
            break;
          }
        }
        if (need) break;
      }
      if (need) processNew();
    });
    obs.observe(target, { childList: true, subtree: true });
  }

  function init() {
    if (isScholarPage()) {
      initScholar();
      return;
    }
    if (isDetailPage()) {
      renderDetailHeader();
      renderDetailTimesCited();
      watchDocsumList();
    } else if (isSearchResultsPage()) {
      buildToolbar();
      if (!document.getElementById("Scholarscope_Toolbar")) {
        const obs = new MutationObserver(() => {
          buildToolbar();
          if (document.getElementById("Scholarscope_Toolbar")) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
      }
      watchDocsumList();
    }
  }

  // =========================================================================
  // Menu commands
  // =========================================================================
  GM_registerMenuCommand(
    "切换分区来源 (当前：" +
      (CFG.quartileSource === "cas" ? "中科院" : "JCR") +
      ")",
    () => {
      CFG.quartileSource = CFG.quartileSource === "cas" ? "jcr" : "cas";
      saveCfg();
      alert("下次加载页面生效。");
    },
  );
  GM_registerMenuCommand("清空 JCR 缓存", () => {
    if (!window.confirm("确定清空 JCR 缓存吗？此操作不可撤销。")) return;
    GM_setValue("jcrCache", {});
    alert("已清空 JCR 缓存。");
  });
  GM_registerMenuCommand("设置 PubMed API Key", () => {
    const v = window.prompt(
      "输入 NCBI eutils API Key（留空则清除）：",
      CFG.pubmedApiKey || "",
    );
    if (v == null) return;
    CFG.pubmedApiKey = v.trim();
    saveCfg();
    alert(CFG.pubmedApiKey ? "已保存。" : "已清除。");
  });

  // =========================================================================
  // Styles
  // =========================================================================
  GM_addStyle(`
/* Detail page */
.Scholarscope_JournalDetailFrame{display:inline-block;width:max-content;line-height:1.6;position:relative;top:10px;overflow:hidden}
.Scholarscope_Badge{
  color:#fff;padding:0 .5em;width:max-content;float:left;height:2em;line-height:2em;background:#616161;user-select:none}
.Scholarscope_BadgeClickable{cursor:pointer}
.Scholarscope_BadgeBlue{background:#225390}

/* Appendix (search + detail-list) badge group */
.Scholarscope_Appendix_JournalFrame{width:100%;min-height:2em;overflow:hidden;margin-top:.3em;margin-bottom:.3em}
.Scholarscope_Appendix_Journal{border-right:1px solid}

/* IF ambiguity warning */
.Scholarscope_IF_Ambiguous:before{content:"\u26A0\uFE0F";vertical-align:bottom;font-size:11px}

/* Not Found visual */
.Scholarscope_NotFound{background:#616161 !important}

/* MedLine 命中但无 IF/分区 */
.Scholarscope_MedHit{background-color:#0094DF !important;color:#fff}

/* DOI inline */
.Scholarscope_DOI{display:inline-block;margin-left:.5em;font-size:.92em;color:#5B616B}
.Scholarscope_DOILink{color:#0071BC;text-decoration:none}
.Scholarscope_DOILink:hover{text-decoration:underline}

/* Action row (Cited / Google Scholar / Full Abstract) */
.Scholarscope_ActionRow{margin-top:.4em;display:flex;column-gap:1em;flex-wrap:wrap}
.Scholarscope_Action_Cited:before,.Scholarscope_Action_Abstract:before{width:14px;height:14px}
.Scholarscope_Action_Cited:before{content:"\uD83D\uDD25"}
.Scholarscope_Action_Abstract{cursor:pointer}
.Scholarscope_Action_Abstract:before{content:"\uD83D\uDCD6"}
.full-view-snippet{overflow:auto;transition:opacity .3s;margin-top:.5rem}
#adjacent-navigation .full-view-snippet{max-height:200px;}

/* Toolbar */
.Scholarscope_Toolbar{position:relative;margin:.5rem 0;display:flex;gap:0;align-items:center}
.Scholarscope_ToolbarButton{
  display:inline-flex;align-items:center;
  padding:5px 15px 5px 12px;border:1px solid #aeb0b5;font-size:14px;color:#212121;cursor:pointer;
  background:#fff;margin-right:8px;transition:color .3s,border-color .3s,background-color .3s;user-select:none}
.Scholarscope_ToolbarButton:hover{border-color:#046B99}
.Scholarscope_ToolbarButton:active{background:#205493;color:#fff}
.Scholarscope_ToolbarButton:before{content:"";width:14px;height:14px;margin-right:3px;fill:#5B616B}
.Scholarscope_FilterButton:before{background:url("data:image/svg+xml,%3Csvg viewBox='0 0 32 32' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M29.815 6.168A1.991 1.991 0 0 0 27.986 5H4.014c-.797 0-1.498.448-1.83 1.168a1.972 1.972 0 0 0 .297 2.128l.001.001L12 19.371V28a1 1 0 0 0 1.555.832l6-4c.278-.186.445-.498.445-.832v-4.629l9.519-11.074a1.972 1.972 0 0 0 .296-2.129z'/%3E%3C/svg%3E")}
.Scholarscope_SortButton:before{background:url("data:image/svg+xml,%3Csvg height='14' viewBox='0 0 28 28' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M24.244 18.373l-2.951 2.95.02-10.323a1 1 0 1 0-2 0l-.02 10.253-2.879-2.88A1 1 0 0 0 15 19.788l4.115 4.115a1.498 1.498 0 0 0 2.188.224c.039-.03.076-.062.111-.097l4.244-4.242a1 1 0 0 0-1.414-1.415zM2 20.7a.8.8 0 0 0 .8.8h7.9a.797.797 0 0 0 .8-.8v-.4a.8.8 0 0 0-.8-.8H2.8a.8.8 0 0 0-.8.8v.4zM2.506 13.443A.798.798 0 0 1 2 12.7v-.4a.8.8 0 0 1 .8-.8h12.4a.8.8 0 0 1 .8.8v.4a.8.8 0 0 1-.8.8H2.8a.805.805 0 0 1-.294-.057zM2.074 5.035A.797.797 0 0 1 2 4.7v-.4a.8.8 0 0 1 .8-.8h21.4a.8.8 0 0 1 .8.8v.4a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.726-.465z'/%3E%3C/svg%3E")}
.Scholarscope_SelectShownFrame{visibility:hidden}
.Scholarscope_SelectShownFrame:before{background:url("data:image/svg+xml,%3Csvg viewBox='0 0 1024 1024' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M374.656 713.344a32 32 0 0 1 3.648 40.832l-3.648 4.48-128 128a32 32 0 0 1-40.832 3.648l-4.48-3.648-64-64a32 32 0 0 1 40.832-48.96l4.48 3.648L224 818.752l105.344-105.408a32 32 0 0 1 45.312 0zM864 768a32 32 0 1 1 0 64H480a32 32 0 1 1 0-64h384zM374.656 457.344a32 32 0 0 1 3.648 40.832l-3.648 4.48-128 128a32 32 0 0 1-40.832 3.648l-4.48-3.648-64-64a32 32 0 0 1 40.832-48.96l4.48 3.648L224 562.752l105.344-105.408a32 32 0 0 1 45.312 0zM864 512a32 32 0 1 1 0 64H480a32 32 0 0 1 0-64h384zM374.656 201.344a32 32 0 0 1 3.648 40.832l-3.648 4.48-128 128a32 32 0 0 1-40.832 3.648l-4.48-3.648-64-64a32 32 0 0 1 40.832-48.96l4.48 3.648L224 306.752l105.344-105.408a32 32 0 0 1 45.312 0zM864 256a32 32 0 1 1 0 64H480a32 32 0 0 1 0-64h384z'/%3E%3C/svg%3E")}
@media (max-width:600px){
  #gs_ab .Scholarscope_ToolbarButton{font-size:0 !important;width:20px;padding:5px !important}
  #gs_ab .Scholarscope_DropDown{transform:translateX(-50%)}
}

/* Dropdown */
.Scholarscope_DropDown{
  min-width:300px;background:#fff;border:1px solid #aeb0b5;box-shadow:0 3px 14px -4px #8E8E8E;
  position:absolute;top:44px;left:0;z-index:1000;padding:12px;box-sizing:border-box;font-size:14px;margin:0}
.Scholarscope_DropDown label{margin-top:0}
.Scholarscope_FilterContainerFrame{display:flex;border-bottom:1px dashed #DDD;padding-bottom:10px;margin-bottom:10px}
.Scholarscope_FilterValueInputFrame{width:62%}
.Scholarscope_FilterQuartileInputFrame{width:38%;border-left:1px dashed #DDD;padding-left:10px;margin-top:1em}
.Scholarscope_FilterValueQuartileTexts{font-weight:bold}
.Scholarscope_InlineCheck{display:flex;align-items:center;gap:12px!important;margin:10px 0}
.Scholarscope_ButtonRow{display:flex;gap:10px;margin-top:8px}
.Scholarscope_DropDownButton{
  flex:0 0 110px;min-width:110px;text-align:center;padding:8px 0;line-height:1;color:#fff;cursor:pointer;user-select:none;
  display:inline-block !important;visibility:visible !important;opacity:1 !important;pointer-events:auto !important;
  border:0;font:inherit}
.Scholarscope_DropDownButtonPrimary,.Scholarscope_Modal_Close{background:#0071BC}
.Scholarscope_DropDownButtonPrimary:hover,.Scholarscope_Modal_Close:hover{background:#20558A}
.Scholarscope_DropDownButtonDanger,.Scholarscope_Modal_ClearCache{background:#E66666}
.Scholarscope_DropDownButtonDanger:hover,.Scholarscope_Modal_ClearCache:hover{background:#D50000}
.Scholarscope_DropDown input[type="checkbox"]{display:none}
.Scholarscope_DropDownTitle{font-weight:bold;margin-bottom:10px}
.Scholarscope_DropDownField{display:block;flex:auto;margin:8px 0}
.Scholarscope_DropDownLabel{font-weight:bold;margin-bottom:4px}
.Scholarscope_FilterValueInput,.Scholarscope_DropDownControl{padding:4px;border:1px solid #bbb}
.Scholarscope_FilterValueInput{width:50px}
.Scholarscope_DropDownControl{width:100%;box-sizing:border-box}
.Scholarscope_DropDownHint{margin-top:4px;color:#5B616B;line-height:1.4}
.Scholarscope_TermWrapper{display:flex;gap:6px;margin-top:1em;align-items:center}

/* Modal */
#Scholarscope_Modal{position:fixed;inset:0;z-index:9999}
.Scholarscope_Modal_Mask{position:absolute;inset:0;background:rgba(0,0,0,.4)}
.Scholarscope_Modal_Box{position:relative;margin:10vh auto 0;max-width:720px;background:#fff;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.3);font-size:14px;max-height:80vh;overflow:auto}
.Scholarscope_Modal_Content h3{margin-top:0}
.Scholarscope_Modal_Table{width:100%;border-collapse:collapse;margin-top:10px}
.Scholarscope_Modal_Table th,.Scholarscope_Modal_Table td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:13px}
.Scholarscope_Modal_Table th{background:#f4f6f8}
.Scholarscope_Modal_RowHighlight{background:#FFF8E1}
.Scholarscope_Modal_Close,.Scholarscope_Modal_ClearCache{display:inline-block;margin-top:12px;padding:8px 16px;color:#fff;cursor:pointer;user-select:none}
.Scholarscope_Modal_ButtonRow{display:flex;gap:10px;margin-top:12px}
.Scholarscope_Modal_ButtonRow .Scholarscope_Modal_Close,
.Scholarscope_Modal_ButtonRow .Scholarscope_Modal_ClearCache{margin-top:0}

/* Float clearfix */
.Scholarscope_Appendix_JournalFrame::after,.Scholarscope_JournalDetailFrame::after{content:"";display:block;clear:both}

/* Google Scholar */
.gs_ri .Scholarscope_Appendix_JournalFrame{margin:.4em 0;width:auto}
.gs_ri .Scholarscope_Appendix_Journal{max-width:24em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.Scholarscope_Action_PubMedSearch:before,.Scholarscope_Action_GScholar:before{vertical-align:middle;margin-right:2px}
.Scholarscope_Action_PubMedSearch:before{content:url("data:image/svg+xml,%3Csvg viewBox='0 0 1024 1024' xmlns='http://www.w3.org/2000/svg' width='13' height='13'%3E%3Cpath d='M128 64h448l192 448-192 448H128A128 128 0 0 1 0 832V192A128 128 0 0 1 128 64z' fill='%23205992'/%3E%3Cpath d='M704 64h128l192 448-192 448H704l192-448z' fill='%23205992'/%3E%3C/svg%3E")}
.Scholarscope_Action_GScholar:before{content:url("data:image/svg+xml,%3Csvg viewBox='0 0 1024 1024' xmlns='http://www.w3.org/2000/svg' width='13' height='13'%3E%3Cpath d='M512 822.24L0 405.334 512 0z' fill='%234285F4'/%3E%3Cpath d='M512 822.24l512-416.906L512 0z' fill='%23356AC3'/%3E%3Cpath d='M213.334 725.334a298.666 298.666 0 1 0 597.332 0 298.666 298.666 0 1 0-597.332 0z' fill='%23A0C3FF'/%3E%3Cpath d='M242.074 597.334C290.01 496.428 392.858 426.666 512 426.666s221.99 69.762 269.926 170.668H242.074z' fill='%2376A7FA'/%3E%3C/svg%3E")}
.Scholarscope_AbstractMeta{font-size:.92em;color:#5B616B;margin-bottom:.4em}
.Scholarscope_AbstractMeta a{color:#1a0dab;margin-right:5px;text-decoration:none}
.Scholarscope_AbstractMeta a:hover{text-decoration:underline}
.Scholarscope_AbstractTitle{font-weight:600;color:#212121;margin-top:.15em}
.Scholarscope_AbstractJournal{margin-top:.05em}
.Scholarscope_ShowMoreButton{
  display:block;width:max-content;margin:1em auto;padding:8px 24px;
  border:1px solid #aeb0b5;background:#fff;color:#1a0dab;font-size:14px;
  text-decoration:none;cursor:pointer;user-select:none}
.Scholarscope_ShowMoreButton:hover{border-color:#046B99;background:#f4f6f8;text-decoration:none}
.Scholarscope_ShowMoreButton[aria-disabled="true"]{opacity:.55;cursor:default;pointer-events:none}
.Scholarscope_ShowMoreError{margin:.5em auto;color:#D50000;text-align:center;font-size:13px}
.gs_query input[type="checkbox"]+label{display:inline-flex;cursor:pointer}
.gs_query input[type="checkbox"]+label:before{display:inline-block;content:"";width:14px;height:14px;margin-right:4px;border:1px solid #c6c6c6;border-radius:1px;color:#222}
.gs_query [type=checkbox]:checked+label::before{background:no-repeat url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAwAAAAJCAQAAACssQXfAAAAiklEQVR4AT3PNUFGARAA4MO1AFRgQVrgTEgNXBZ0Z0aLQI0XANf594932LlLROjQHgmhM9mVwlhkMJO/4S7noMjghKEIPcmuUNNyGpa8uzUcYdA1qjjJ+ntwY8Q16jiIBCte0fSmUUr2Mio3W/BJqwQt2xHaZFhXhBnPqFr7D6eRKVMereeIv5++AKLreD06aLBkAAAAAElFTkSuQmCC") 50% #0071bc}

`);

  // =========================================================================
  // Entry
  // =========================================================================
  init();
  // Handle SPA navigations in PubMed (Scholar uses full reloads, no polling needed)
  if (!isScholarPage()) {
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        setTimeout(init, 400);
      }
    }, 800);
  }
})();

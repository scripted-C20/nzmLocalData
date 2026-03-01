function byId(id) {
  return document.getElementById(id);
}

const state = {
  endpoints: {},
  fixed: {},
  activePanel: "stats",
  activeCollection: "weapons",
  stats: null,
  collection: null,
  detailCache: new Map(),
  historyPage: 1,
  historyPageSize: 10,
  historyFilters: {
    mode: "all",
    difficulty: "all"
  },
  historyRemote: {
    list: [],
    page: 1,
    limit: 10,
    totalPages: null,
    totalCount: null,
    hasMore: false,
    configMapping: {}
  },
  localStats: null,
  logWindowVisible: false,
  imageObserver: null,
  loadingCount: 0,
  toastTimer: null,
  localOnlyWithData: true,
  localBattlePage: 1,
  localBattlePageSize: 10,
  localBattleFilters: {
    mode: "all",
    difficulty: "all",
    mapKey: "all"
  },
  latestNotice: null,
  noticeAutoShownHash: "",
  accounts: [],
  activeUin: "",
  qiniuConfig: {
    accessKey: "",
    secretKey: "",
    protocol: "https",
    domain: "",
    path: "",
    bucket: ""
  }
};

const LOCAL_BATTLE_PAGE_SIZE = 10;

function toNumber(value) {
  const normalized =
    typeof value === "string"
      ? value.replace(/,/g, "").replace(/%/g, "").trim()
      : value;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function formatNumber(value) {
  return toNumber(value).toLocaleString("zh-CN");
}

function formatPercent(value) {
  return `${toNumber(value).toFixed(1)}%`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(toNumber(seconds)));
  if (!total) return "--";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}分${s}秒`;
}

function parseDateTimeToMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function resolveLocalBattleDurationSeconds(game) {
  const directDuration = toNumber(
    pick(game, ["iUseTime", "useTime", "duration", "iDuration", "costTime"], 0)
  );
  if (directDuration > 0) {
    return Math.floor(directDuration);
  }

  const startMs = parseDateTimeToMs(
    pick(game, ["dtGameStartTime", "startTime"], "")
  );
  const endMs = parseDateTimeToMs(
    pick(game, ["dtEventTime", "eventTime"], "")
  );
  if (startMs > 0 && endMs > startMs) {
    return Math.floor((endMs - startMs) / 1000);
  }
  return 0;
}

function formatTime(value) {
  if (!value) return "--";
  const raw = String(value);
  if (/^\d{10}$/.test(raw)) {
    const date = new Date(Number(raw) * 1000);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN");
  }
  if (/^\d{13}$/.test(raw)) {
    const date = new Date(Number(raw));
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN");
  }
  return raw;
}

function clearToastTimer() {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }
}

function showToast(message, type = "info", timeoutMs = 5000) {
  const toast = byId("global-toast");
  if (!toast) {
    return;
  }

  clearToastTimer();
  const level = String(type || "info").toLowerCase();
  toast.textContent = String(message || "").trim();
  toast.classList.remove("hidden", "success", "error", "info", "loading");
  toast.classList.add(level);

  if (!toast.textContent) {
    toast.classList.add("hidden");
    return;
  }

  if (timeoutMs > 0) {
    state.toastTimer = setTimeout(() => {
      toast.classList.add("hidden");
      state.toastTimer = null;
    }, timeoutMs);
  }
}

function hideToast() {
  clearToastTimer();
  const toast = byId("global-toast");
  if (toast) {
    toast.classList.add("hidden");
    toast.classList.remove("success", "error", "info", "loading");
  }
}

function setStatus(text, ok = true) {
  if (!text) {
    hideToast();
    return;
  }
  let level = "info";
  if (typeof ok === "string") {
    level = ok;
  } else if (ok === true) {
    level = "success";
  } else if (ok === false) {
    level = "error";
  }
  showToast(text, level, 5000);
}

function setLoading(flag, text = "加载数据中...") {
  if (flag) {
    state.loadingCount += 1;
    showToast(text, "loading", 0);
    return;
  }

  state.loadingCount = Math.max(0, state.loadingCount - 1);
  if (state.loadingCount > 0) {
    showToast(text, "loading", 0);
    return;
  }

  const toast = byId("global-toast");
  if (toast?.classList.contains("loading")) {
    hideToast();
  }
}

function setLogToggle(visible) {
  state.logWindowVisible = Boolean(visible);
  const checkbox = byId("log-window-toggle");
  if (checkbox) {
    checkbox.checked = state.logWindowVisible;
  }
}

function formatAccountLabel(account) {
  const uin = String(account?.uin || "").trim();
  const nickname = String(account?.nickname || "").trim();
  if (nickname) {
    return nickname;
  }
  return uin || "未命名账号";
}

function renderAccountSelect() {
  const select = byId("account-select");
  if (!select) {
    return;
  }
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  select.innerHTML = "";

  if (!accounts.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "暂无已保存账号";
    select.appendChild(empty);
    select.value = "";
    return;
  }

  accounts.forEach((account) => {
    const option = document.createElement("option");
    option.value = String(account?.uin || "").trim();
    option.textContent = formatAccountLabel(account);
    select.appendChild(option);
  });

  const active =
    String(state.activeUin || "").trim() ||
    String(accounts[0]?.uin || "").trim();
  if ([...select.options].some((x) => x.value === active)) {
    select.value = active;
  }
}

function fillQiniuConfigInputs(config = {}) {
  const data = config && typeof config === "object" ? config : {};
  const mapping = [
    ["qiniu-access-key-input", "accessKey"],
    ["qiniu-secret-key-input", "secretKey"],
    ["qiniu-protocol-select", "protocol"],
    ["qiniu-domain-input", "domain"],
    ["qiniu-path-input", "path"],
    ["qiniu-bucket-input", "bucket"]
  ];
  mapping.forEach(([id, key]) => {
    const input = byId(id);
    if (!input) return;
    const raw = String(data?.[key] || "").trim();
    if (key === "protocol") {
      input.value = raw.toLowerCase() === "http" ? "http" : "https";
      return;
    }
    input.value = raw;
  });
}

function readQiniuConfigInputs() {
  const protocolRaw = String(byId("qiniu-protocol-select")?.value || "https")
    .trim()
    .toLowerCase();
  const protocol = protocolRaw === "http" ? "http" : "https";
  return {
    accessKey: String(byId("qiniu-access-key-input")?.value || "").trim(),
    secretKey: String(byId("qiniu-secret-key-input")?.value || "").trim(),
    protocol,
    domain: String(byId("qiniu-domain-input")?.value || "").trim(),
    path: String(byId("qiniu-path-input")?.value || "").trim(),
    bucket: String(byId("qiniu-bucket-input")?.value || "").trim()
  };
}

function openQiniuModal() {
  const modal = byId("qiniu-modal");
  if (!modal) {
    return;
  }
  fillQiniuConfigInputs(state.qiniuConfig || {});
  modal.classList.remove("hidden");
}

function closeQiniuModal() {
  const modal = byId("qiniu-modal");
  if (!modal) {
    return;
  }
  modal.classList.add("hidden");
}

function setLocalMetaInfo(localMapStats = {}) {
  const metaEl = byId("local-meta-info");
  if (!metaEl) {
    return;
  }
  const total = toNumber(localMapStats?.totalRecords);
  const manual = toNumber(localMapStats?.manualRows);
  const towerMaps = getTowerMapNames();
  const towerText = towerMaps.length ? `，塔防地图 ${formatNumber(towerMaps.length)} 张` : "";
  metaEl.textContent = `本地记录 ${formatNumber(total)} 场，导入 ${formatNumber(manual)} 场${towerText}`;
  metaEl.title = towerMaps.length ? `塔防地图：${towerMaps.join("、")}` : "";
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderNoticeInline(text) {
  let html = escapeHtml(text);
  html = html.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    '<img src="$2" alt="$1" loading="lazy" />'
  );
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let codeBuffer = [];
  let listType = "";
  let listItems = [];

  const flushCode = () => {
    if (!codeBuffer.length) return;
    out.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
    codeBuffer = [];
  };
  const flushList = () => {
    if (!listItems.length || !listType) return;
    out.push(`<${listType}>${listItems.join("")}</${listType}>`);
    listItems = [];
    listType = "";
  };

  lines.forEach((rawLine) => {
    const line = String(rawLine || "");
    if (/^```/.test(line.trim())) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeBuffer = [];
      } else {
        inCode = false;
        flushCode();
      }
      return;
    }

    if (inCode) {
      codeBuffer.push(line);
      return;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderNoticeInline(heading[2])}</h${level}>`);
      return;
    }

    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    if (ul) {
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(`<li>${renderNoticeInline(ul[1])}</li>`);
      return;
    }

    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(`<li>${renderNoticeInline(ol[1])}</li>`);
      return;
    }

    const quote = line.match(/^\s*>\s?(.+)$/);
    if (quote) {
      flushList();
      out.push(`<blockquote>${renderNoticeInline(quote[1])}</blockquote>`);
      return;
    }

    if (!line.trim()) {
      flushList();
      out.push("");
      return;
    }

    flushList();
    out.push(`<p>${renderNoticeInline(line)}</p>`);
  });

  if (inCode) {
    flushCode();
  }
  flushList();
  return out.join("\n");
}

function formatNoticeTime(ts) {
  const value = Number(ts || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "--";
  }
  return new Date(value).toLocaleString("zh-CN");
}

function setNoticePayload(payload) {
  state.latestNotice = payload && typeof payload === "object" ? payload : null;

  const metaEl = byId("notice-meta");
  const bodyEl = byId("notice-body");
  if (!metaEl || !bodyEl) {
    return;
  }

  if (!state.latestNotice?.content) {
    metaEl.textContent = "暂无公告";
    bodyEl.innerHTML = "<p>暂无公告内容</p>";
    return;
  }

  const fetchedAt = formatNoticeTime(state.latestNotice.fetchedAt);
  metaEl.textContent = `获取时间：${fetchedAt}`;
  bodyEl.innerHTML = markdownToHtml(state.latestNotice.content);
}

function openNoticeImageViewer(src, alt = "") {
  const viewer = byId("notice-image-viewer");
  const image = byId("notice-image-viewer-img");
  if (!viewer || !image || !src) {
    return;
  }
  image.src = src;
  image.alt = alt || "公告图片";
  viewer.classList.remove("hidden");
}

function closeNoticeImageViewer() {
  const viewer = byId("notice-image-viewer");
  const image = byId("notice-image-viewer-img");
  if (!viewer || !image) {
    return;
  }
  viewer.classList.add("hidden");
  image.src = "";
  image.alt = "";
}

async function markNoticeOpenedIfNeeded() {
  const hash = String(state.latestNotice?.hash || "").trim();
  if (!hash) return;
  try {
    await window.nzmApi.markNoticeOpened();
  } catch (_) {
    // no-op
  }
}

async function openNoticeModal(autoPopup = false) {
  const modal = byId("notice-modal");
  if (!modal) return;
  const hash = String(state.latestNotice?.hash || "").trim();
  if (autoPopup && hash && state.noticeAutoShownHash === hash) {
    return;
  }
  if (autoPopup && hash) {
    state.noticeAutoShownHash = hash;
  }
  modal.classList.remove("hidden");
  await markNoticeOpenedIfNeeded();
}

function closeNoticeModal() {
  const modal = byId("notice-modal");
  closeNoticeImageViewer();
  if (modal) {
    modal.classList.add("hidden");
  }
}

async function refreshNotice({ autoPopup = false } = {}) {
  try {
    const result = await window.nzmApi.checkNotice();
    if (result?.data) {
      setNoticePayload(result.data);
    } else {
      setNoticePayload(null);
    }
    if (result?.shouldPopup || autoPopup) {
      await openNoticeModal(Boolean(result?.shouldPopup));
    }
  } catch (_) {
    // no-op
  }
}

function pick(obj, keys, fallback = "") {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return fallback;
}

function boolLike(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function resolveImage(pathLike) {
  const raw = String(pathLike || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:image/")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;

  const host = String(state.endpoints?.officialImageHost || "").trim();
  if (!host) return raw;

  const base = host.endsWith("/") ? host.slice(0, -1) : host;
  const suffix = raw.startsWith("/") ? raw : `/${raw}`;
  return `${base}${suffix}`;
}

function collectStringValues(data, output, depth = 0, maxDepth = 3) {
  if (!data || depth > maxDepth) return;

  if (typeof data === "string") {
    const value = data.trim();
    if (value) {
      output.push(value);
    }
    return;
  }

  if (Array.isArray(data)) {
    data.forEach((item) => collectStringValues(item, output, depth + 1, maxDepth));
    return;
  }

  if (typeof data === "object") {
    Object.values(data).forEach((value) => collectStringValues(value, output, depth + 1, maxDepth));
  }
}

function extractImageCandidates(item) {
  const explicit = [
    "sIcon",
    "icon",
    "sImg",
    "image",
    "img",
    "sPic",
    "sImage",
    "sAvatar",
    "sLogo",
    "weaponIcon",
    "weaponImg",
    "sWeaponImg",
    "sResIcon",
    "sCardImg",
    "sBgImg",
    "bgImg",
    "sMapImg",
    "mapImg",
    "pic",
    "picUrl",
    "imgUrl"
  ]
    .map((key) => item?.[key])
    .filter(Boolean)
    .map((value) => String(value).trim());

  const discovered = [];
  collectStringValues(item, discovered, 0, 2);

  const urlLike = discovered.filter((value) => {
    if (/^(https?:)?\/\//i.test(value)) return true;
    if (/\.(png|jpg|jpeg|webp|gif|bmp|avif)(\?|$)/i.test(value)) return true;
    if (/\/upload|\/resource|\/weapon|\/images?\//i.test(value)) return true;
    return false;
  });

  const all = [...explicit, ...urlLike]
    .map((value) => resolveImage(value))
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);

  return all;
}

function createInfoCard(label, value) {
  const card = document.createElement("div");
  card.className = "info-card";

  const labelEl = document.createElement("div");
  labelEl.className = "label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "value";
  valueEl.textContent = value;

  card.append(labelEl, valueEl);
  return card;
}

function renderPlaceholder(container, text) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty-placeholder";
  div.textContent = text;
  container.appendChild(div);
}

function flattenNumericEntries(obj, prefix = "", depth = 0, maxDepth = 2, output = []) {
  if (!obj || depth > maxDepth) return output;

  if (typeof obj !== "object") return output;

  Object.entries(obj).forEach(([key, value]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      flattenNumericEntries(value, nextKey, depth + 1, maxDepth, output);
      return;
    }

    const num = Number(value);
    if (Number.isFinite(num)) {
      output.push({ key: nextKey.toLowerCase(), value: num });
    }
  });

  return output;
}

function findSummaryNumber(summary, regexes, fallback = 0) {
  const entries = flattenNumericEntries(summary);
  const hit = entries.find((entry) => regexes.some((reg) => reg.test(entry.key)));
  return hit ? hit.value : fallback;
}

function mapModeTypeToName(value) {
  const modeType = String(value || "").trim();
  if (!modeType) return "";
  if (modeType === "65") return "排位";
  if (modeType === "134") return "僵尸猎场";
  if (modeType === "136") return "时空追猎";
  if (modeType === "139") return "塔防";
  return "";
}

function normalizeModeName(rawMode) {
  const text = String(rawMode || "").trim();
  if (!text) return "";
  const byType = mapModeTypeToName(text);
  if (byType) return byType;
  if (text.includes("塔防")) return "塔防";
  if (text.includes("时空") || text.includes("追猎")) return "时空追猎";
  if (text === "猎场" || text === "僵尸猎场") return "僵尸猎场";
  if (text.includes("猎场竞速")) return "猎场竞速";
  if (text.includes("僵尸")) return "僵尸猎场";
  if (text.includes("机甲") || text.includes("排位")) return "排位";
  return text;
}

function toDisplayModeName(rawMode) {
  return normalizeModeName(rawMode);
}

function normalizeDifficultyName(rawDifficulty) {
  const text = String(rawDifficulty || "").trim();
  if (!text) return "";
  if (text.includes("炼狱")) return "炼狱";
  if (
    text === "折磨" ||
    /折磨\s*(?:I|1|Ⅰ)$/i.test(text) ||
    /折磨\s*(?:I|1|Ⅰ)\b/i.test(text)
  ) {
    return "折磨I";
  }
  return text;
}

function getDifficultyInfoMap() {
  const fromStats = getConfigRoot()?.difficultyInfo;
  const historyRoot =
    state.historyRemote?.configMapping && typeof state.historyRemote.configMapping === "object"
      ? state.historyRemote.configMapping?.config && typeof state.historyRemote.configMapping.config === "object"
        ? state.historyRemote.configMapping.config
        : state.historyRemote.configMapping
      : {};
  const fromHistory = historyRoot?.difficultyInfo;
  return {
    ...(fromStats && typeof fromStats === "object" ? fromStats : {}),
    ...(fromHistory && typeof fromHistory === "object" ? fromHistory : {})
  };
}

function getConfiguredDifficultyNames(configMapping = null) {
  const root =
    configMapping && typeof configMapping === "object"
      ? configMapping?.config && typeof configMapping.config === "object"
        ? configMapping.config
        : configMapping
      : getConfigRoot();
  const difficultyInfo =
    root?.difficultyInfo && typeof root.difficultyInfo === "object"
      ? root.difficultyInfo
      : {};
  const set = new Set();
  Object.values(difficultyInfo).forEach((node) => {
    const mapped = normalizeDifficultyName(
      pick(node, ["diffName", "difficultyName", "name", "title", "displayName"], "")
    );
    if (mapped) {
      set.add(mapped);
    }
  });
  return set;
}

function getConfigRootByMapping(configMapping = null) {
  if (configMapping && typeof configMapping === "object") {
    if (configMapping.config && typeof configMapping.config === "object") {
      return configMapping.config;
    }
    return configMapping;
  }
  return getConfigRoot();
}

function getModeOptionMap(configMapping = null) {
  const root = getConfigRootByMapping(configMapping);
  const modeInfo =
    (root?.modeInfo && typeof root.modeInfo === "object"
      ? root.modeInfo
      : root?.modeTypeInfo && typeof root.modeTypeInfo === "object"
      ? root.modeTypeInfo
      : {}) || {};

  const map = new Map([
    ["65", "排位"],
    ["134", "僵尸猎场"],
    ["136", "时空追猎"],
    ["139", "塔防"]
  ]);
  Object.entries(modeInfo).forEach(([id, node]) => {
    const idText = String(id || "").trim();
    if (!idText) return;
    const name = pick(node, ["modeName", "name", "title", "displayName"], "");
    if (name) {
      map.set(idText, toDisplayModeName(name) || name);
    }
  });
  return map;
}

function resolveModeNameFromMapNode(node, modeOptionMap) {
  if (!node || typeof node !== "object") {
    return "";
  }
  const directModeText = String(
    pick(node, ["modeName", "sModeName", "typeName", "mode", "sTypeName"], "")
  ).trim();
  if (directModeText && !/^\d+$/.test(directModeText)) {
    return toDisplayModeName(directModeText);
  }

  const modeId = String(
    pick(node, ["modeType", "iModeType", "modeID", "modeId", "mode"], "")
  ).trim();
  if (modeId && modeOptionMap.has(modeId)) {
    return toDisplayModeName(modeOptionMap.get(modeId) || "");
  }
  return "";
}

function getAllMapsFromHistoryConfig(configMapping = null) {
  const root = getConfigRootByMapping(configMapping);
  const mapInfo =
    (root?.mapInfo && typeof root.mapInfo === "object" ? root.mapInfo : {}) || {};
  const modeOptionMap = getModeOptionMap(configMapping);

  return Object.entries(mapInfo)
    .map(([id, node]) => {
      const mapId = String(id || "").trim();
      if (!mapId) return null;
      const mapName = pick(node, ["mapName", "sMapName", "name", "title", "displayName"], "");
      const modeName = resolveModeNameFromMapNode(node, modeOptionMap);
      const icon = String(
        pick(node, ["icon", "sIcon", "mapImg", "sMapImg", "pic", "picUrl"], "")
      ).trim();
      const baseName = mapName || `地图${mapId}`;
      return {
        mapId,
        mapName: baseName,
        modeName,
        icon,
        label: modeName ? `${baseName}（${modeName}）` : baseName
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function buildLocalMapFilterKey(mapName, modeName) {
  const normalizedMapName = String(mapName || "").trim();
  const normalizedModeName = toDisplayModeName(modeName || "");
  return `${normalizedMapName}__mode__${normalizedModeName}`;
}

function formatLocalMapFilterLabel(mapName, modeName) {
  const normalizedMapName = String(mapName || "").trim() || "未知地图";
  const normalizedModeName = toDisplayModeName(modeName || "");
  return normalizedModeName
    ? `${normalizedMapName}（${normalizedModeName}）`
    : normalizedMapName;
}

function getLocalBattleAllGames() {
  return Array.isArray(state.localStats?.localRecords) ? state.localStats.localRecords : [];
}

function renderLocalBattleFilterOptions() {
  const modeSelect = byId("local-battle-mode-select");
  const diffSelect = byId("local-battle-diff-select");
  const mapSelect = byId("local-battle-map-select");
  if (!modeSelect || !diffSelect || !mapSelect) {
    return;
  }

  const allGames = getLocalBattleAllGames();
  const allMapList = getAllMapsFromHistoryConfig(
    state.historyRemote?.configMapping || getStatsPayload()?.configMapping || null
  );

  const optionMap = new Map();
  allMapList.forEach((item) => {
    const mapName = String(item?.mapName || "").trim();
    if (!mapName) return;
    const modeName = toDisplayModeName(item?.modeName || "");
    const key = buildLocalMapFilterKey(mapName, modeName);
    if (!optionMap.has(key)) {
      optionMap.set(key, {
        value: key,
        label: formatLocalMapFilterLabel(mapName, modeName)
      });
    }
  });
  allGames.forEach((item) => {
    const mapName = inferMapName(item);
    const modeName = inferModeName(item);
    const key = buildLocalMapFilterKey(mapName, modeName);
    if (!optionMap.has(key)) {
      optionMap.set(key, {
        value: key,
        label: formatLocalMapFilterLabel(mapName, modeName)
      });
    }
  });

  const optionList = [...optionMap.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "zh-CN")
  );

  const modeSet = new Set();
  const diffSet = new Set();
  allGames.forEach((game) => {
    const modeName = inferModeName(game);
    if (modeName) {
      modeSet.add(modeName);
    }
    const diffName = inferDifficultyName(game);
    if (diffName) {
      diffSet.add(diffName);
    }
  });
  const modeOptions = ["all", ...[...modeSet].sort((a, b) => a.localeCompare(b, "zh-CN"))];
  const diffOptions = ["all", ...[...diffSet].sort((a, b) => a.localeCompare(b, "zh-CN"))];

  modeSelect.innerHTML = "";
  modeOptions.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "all" ? "全部模式" : value;
    modeSelect.appendChild(option);
  });

  diffSelect.innerHTML = "";
  diffOptions.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "all" ? "全部难度" : value;
    diffSelect.appendChild(option);
  });

  mapSelect.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "全部地图";
  mapSelect.appendChild(allOption);

  optionList.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    mapSelect.appendChild(option);
  });

  state.localBattleFilters.mode = modeOptions.includes(state.localBattleFilters.mode)
    ? state.localBattleFilters.mode
    : "all";
  state.localBattleFilters.difficulty = diffOptions.includes(state.localBattleFilters.difficulty)
    ? state.localBattleFilters.difficulty
    : "all";
  state.localBattleFilters.mapKey =
    state.localBattleFilters.mapKey &&
    [...mapSelect.options].some((x) => x.value === state.localBattleFilters.mapKey)
      ? state.localBattleFilters.mapKey
      : "all";
  modeSelect.value = state.localBattleFilters.mode;
  diffSelect.value = state.localBattleFilters.difficulty;
  mapSelect.value = state.localBattleFilters.mapKey;
}

function isOnlyHuntDifficulties(configMapping = null) {
  const set = getConfiguredDifficultyNames(configMapping);
  if (!set.size) return false;
  const allow = new Set(["折磨I", "炼狱"]);
  return [...set].every((item) => allow.has(item));
}

function getDifficultyCheckText(configMapping = null) {
  const set = getConfiguredDifficultyNames(configMapping);
  if (!set.size) {
    return "";
  }
  if (isOnlyHuntDifficulties(configMapping)) {
    return "难度映射：折磨I / 炼狱";
  }
  const names = [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
  return `难度映射：${names.join(" / ")}`;
}

function getTowerMapNames(payload = null) {
  const mapping =
    state.historyRemote?.configMapping && typeof state.historyRemote.configMapping === "object"
      ? state.historyRemote.configMapping
      : getStatsPayload()?.configMapping || payload?.configMapping || null;
  const set = new Set();
  getAllMapsFromHistoryConfig(mapping).forEach((item) => {
    const mode = normalizeModeName(item?.modeName || "");
    if (mode.includes("塔防")) {
      set.add(String(item?.mapName || "").trim());
    }
  });
  return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function getTowerMapCheckText(payload = null) {
  const names = getTowerMapNames(payload);
  if (!names.length) return "";
  return `塔防地图 ${names.length} 张`;
}

function inferModeName(game) {
  const modeType = String(
    pick(game, ["iModeType", "modeType", "iGameMode", "gameMode", "iMode"], "")
  ).trim();
  const mappedMode = mapModeTypeToName(modeType);
  if (mappedMode) return mappedMode;

  const direct = pick(
    game,
    [
      "sModeName",
      "modeName",
      "sGameTypeName",
      "sTypeName",
      "sBattleType",
      "sGameName",
      "sMode",
      "mode"
    ],
    ""
  );

  const normalized = normalizeModeName(direct);
  if (normalized) {
    return normalized;
  }

  const mapName = pick(game, ["sMapName", "mapName", "sRoomName"], "");
  const mapBased = normalizeModeName(mapName);
  if (mapBased) {
    return mapBased;
  }

  return "僵尸猎场";
}

function inferDifficultyName(game) {
  const direct = normalizeDifficultyName(
    pick(
      game,
      [
        "diffName",
        "difficultyName",
        "sDiffName",
        "difficulty",
        "diff",
        "levelName"
      ],
      ""
    )
  );
  if (direct) {
    return direct;
  }

  const diffId = String(
    pick(game, ["iSubModeType", "subModeType", "iDiffId", "difficultyId", "iDifficulty"], "")
  ).trim();
  if (diffId) {
    const difficultyInfo = getDifficultyInfoMap();
    const node = difficultyInfo?.[diffId];
    const mapped = normalizeDifficultyName(
      pick(node, ["diffName", "difficultyName", "name", "title", "displayName"], "")
    );
    if (mapped) {
      return mapped;
    }
  }

  const fallbackRaw = pick(
    game,
    [
      "diffName",
      "difficultyName",
      "sDiffName",
      "difficulty",
      "diff",
      "levelName"
    ],
    ""
  );
  const fallback = normalizeDifficultyName(fallbackRaw);
  return fallback || "未知难度";
}

function inferMapName(game) {
  const direct = pick(
    game,
    [
      "mapName",
      "sMapName",
      "map",
      "mapTitle",
      "sRoomName",
      "sMissionName",
      "missionName",
      "stageName",
      "chapterName",
      "sceneName",
      "sSceneName"
    ],
    ""
  );

  if (String(direct).trim()) {
    return String(direct).trim();
  }

  const mapId = String(pick(game, ["iMapId", "mapId", "mapID", "iMapID"], "")).trim();
  if (mapId) {
    const alias = getAllGames().find((item) => {
      const id = String(pick(item, ["iMapId", "mapId", "mapID", "iMapID"], "")).trim();
      if (id !== mapId) return false;
      const name = pick(item, ["mapName", "sMapName", "map", "mapTitle", "sRoomName"], "");
      return Boolean(String(name).trim());
    });
    if (alias) {
      const aliasName = pick(alias, ["mapName", "sMapName", "map", "mapTitle", "sRoomName"], "");
      if (String(aliasName).trim()) {
        return String(aliasName).trim();
      }
    }
    return `地图${mapId}`;
  }

  const mode = inferModeName(game);
  if (mode.includes("塔防")) return "塔防地图";
  if (mode.includes("时空") || mode.includes("追猎")) return "时空追猎地图";
  if (mode.includes("机甲") || mode.includes("排位")) return "排位地图";
  return "僵尸猎场地图";
}

function inferLocalRecordSourceType(game) {
  const raw = String(
    pick(game, ["sourceType", "recordSource", "dataSource", "source"], "")
  )
    .trim()
    .toLowerCase();
  if (!raw) {
    return "official-sync";
  }
  if (
    raw === "json-transfer" ||
    raw === "json-import" ||
    raw === "json_import" ||
    raw === "local-export-import" ||
    raw === "local-json"
  ) {
    return "json-transfer";
  }
  return "official-sync";
}

function inferLocalRecordSourceLabel(game) {
  const sourceType = inferLocalRecordSourceType(game);
  if (sourceType === "json-transfer") {
    return "JSON导入";
  }
  return "官方同步";
}

function getAllGames() {
  return Array.isArray(state.stats?.data?.gameList) ? state.stats.data.gameList : [];
}

function getRecentGames(limit = 100) {
  return getAllGames().slice(0, limit);
}

function getStatsPayload() {
  return state.stats?.data || {};
}

function getConfigRoot(payload = null) {
  const target = payload || getStatsPayload();
  const mapping = target?.configMapping;
  if (!mapping || typeof mapping !== "object") {
    return {};
  }
  if (mapping.config && typeof mapping.config === "object") {
    return mapping.config;
  }
  return mapping;
}

function buildMapLookup(payload = null) {
  const root = getConfigRoot(payload);
  const mapInfo = root?.mapInfo && typeof root.mapInfo === "object" ? root.mapInfo : {};
  const byId = new Map();
  const byName = new Map();
  Object.entries(mapInfo).forEach(([id, node]) => {
    const mapId = String(id || "").trim();
    if (!mapId) return;
    const mapName = String(
      pick(node, ["mapName", "sMapName", "name", "title", "displayName"], `地图${mapId}`)
    ).trim();
    const modeName = String(
      pick(node, ["mode", "modeName", "sModeName", "typeName", "sTypeName"], "")
    ).trim();
    const icon = String(
      pick(node, ["icon", "sIcon", "mapImg", "sMapImg", "pic", "picUrl"], "")
    ).trim();
    const item = { mapId, mapName, modeName, icon };
    byId.set(mapId, item);
    if (!byName.has(mapName)) {
      byName.set(mapName, []);
    }
    byName.get(mapName).push(item);
  });
  return { byId, byName };
}

function getOfficialSummary() {
  return (
    getStatsPayload()?.officialSummary ||
    getStatsPayload()?.overview?.officialSummary ||
    {}
  );
}

function getBossDamage(game) {
  const direct = pick(
    game,
    [
      "iBossDamage",
      "bossDamage",
      "iBossHurt",
      "bossHurt",
      "iBossDmg",
      "iDamage",
      "damage",
      "iHurt",
      "hurt",
      "totalDamage"
    ],
    0
  );
  if (toNumber(direct) > 0) {
    return toNumber(direct);
  }

  const dynamic = Object.entries(game || {}).find(([key, value]) => {
    const low = key.toLowerCase();
    if (low.includes("boss") && (low.includes("damage") || low.includes("hurt") || low.includes("dmg"))) {
      return toNumber(value) > 0;
    }
    if ((low.includes("damage") || low.includes("hurt") || low.includes("dmg")) && toNumber(value) > 0) {
      return true;
    }
    return false;
  });

  if (dynamic) {
    return toNumber(dynamic[1]);
  }

  const score = toNumber(pick(game, ["iScore", "score"], 0));
  if (score > 0) {
    return Math.floor(score / 10);
  }

  return 0;
}

function getModeGroup(modeName) {
  if (modeName.includes("塔防")) return "tower";
  if (modeName.includes("机甲") || modeName.includes("排位")) return "mecha";
  if (modeName.includes("时空") || modeName.includes("追猎")) return "timehunt";
  return "zombie";
}

function renderStatsCards() {
  const container = byId("stats-cards");
  container.innerHTML = "";

  const overview = getStatsPayload()?.overview || {};
  const summary = getOfficialSummary();
  const games = getAllGames();

  if (!games.length && !overview) {
    renderPlaceholder(container, "暂无统计数据");
    return;
  }

  const zombieTotal =
    toNumber(summary?.huntGameCount) ||
    findSummaryNumber(summary, [/僵尸.*场次/, /zombie/, /hunter/, /pve/], 0);
  const towerTotal =
    toNumber(summary?.towerGameCount) ||
    findSummaryNumber(summary, [/塔防.*场次/, /tower/], 0);
  const mechaTotal =
    toNumber(summary?.mechaGameCount) ||
    findSummaryNumber(summary, [/机甲.*场次/, /排位.*场次/, /rank/, /mecha/], 0);
  const timehuntTotal =
    toNumber(summary?.timeHuntGameCount) ||
    findSummaryNumber(summary, [/时空.*场次/, /追猎.*场次/, /timehunt/, /hunt/], 0);
  const playtimeRaw =
    toNumber(summary?.playtime) ||
    findSummaryNumber(summary, [/在线.*时长/, /online.*time/, /play.*time/, /hour/], 0);
  let onlineHours = 0;
  if (playtimeRaw > 0) {
    // External stats playtime is minute-based in practice.
    onlineHours = playtimeRaw >= 60 ? Math.floor(playtimeRaw / 60) : Math.floor(playtimeRaw);
  } else {
    const totalDuration = toNumber(getStatsPayload()?.overview?.totalDuration);
    onlineHours = totalDuration > 0 ? Math.floor(totalDuration / 3600) : 0;
  }

  const cards = [
    { label: "僵尸猎场总场次", value: formatNumber(zombieTotal) },
    { label: "塔防总场次", value: formatNumber(towerTotal) },
    { label: "机甲排位总场次", value: formatNumber(mechaTotal) },
    { label: "时空追猎总场次", value: formatNumber(timehuntTotal) },
    { label: "在线时长", value: `${formatNumber(onlineHours)}时` }
  ];

  cards.forEach((item) => {
    container.appendChild(createInfoCard(item.label, item.value));
  });
}

function renderRecentCards() {
  const container = byId("recent-cards");
  container.innerHTML = "";

  const overview = getStatsPayload()?.overview || {};
  const recent = getRecentGames(100);
  const totalGames = toNumber(overview?.totalGames) || recent.length;

  if (!totalGames) {
    renderPlaceholder(container, "暂无近期战绩");
    return;
  }

  const wins =
    toNumber(overview?.totalWin) ||
    recent.filter((g) => toNumber(pick(g, ["iIsWin", "isWin"])) === 1).length;
  const winRate = toNumber(overview?.winRate) || (wins / Math.max(1, totalGames)) * 100;
  const avgScore =
    toNumber(overview?.avgScore) ||
    recent.reduce((sum, item) => sum + toNumber(pick(item, ["iScore", "score"])), 0) /
      Math.max(1, recent.length);

  const recent10 = recent.slice(0, 10);
  const bossSamples = recent10.map((item) => getBossDamage(item)).filter((x) => x > 0);
  const bossAvg =
    bossSamples.reduce((sum, item) => sum + item, 0) / Math.max(1, bossSamples.length);

  const cards = [
    { label: "近期场次", value: formatNumber(totalGames) },
    { label: "近期通关率", value: formatPercent(winRate) },
    { label: "场均综合评分", value: formatNumber(Math.floor(avgScore)) },
    { label: "场均BOSS伤害(近10场)", value: formatNumber(Math.floor(bossAvg)) }
  ];

  cards.forEach((item) => {
    container.appendChild(createInfoCard(item.label, item.value));
  });
}

function renderModeCards() {
  const container = byId("mode-cards");
  container.innerHTML = "";

  const modeStats = getStatsPayload()?.modeStats || {};
  let list = Object.entries(modeStats)
    .map(([mode, data]) => ({
      mode: normalizeModeName(mode) || mode,
      total: toNumber(data?.total),
      win: toNumber(data?.win),
      lose: toNumber(data?.loss),
      rate: (toNumber(data?.win) / Math.max(1, toNumber(data?.total))) * 100
    }))
    .filter((item) => item.total > 0 && !item.mode.includes("排位"));

  if (!list.length) {
    const recent = getRecentGames(100);
    if (!recent.length) {
      renderPlaceholder(container, "暂无模式数据");
      return;
    }

    const grouped = new Map();
    recent.forEach((game) => {
      const mode = inferModeName(game);
      if (mode.includes("排位")) return;
      if (!grouped.has(mode)) {
        grouped.set(mode, { total: 0, win: 0, lose: 0 });
      }
      const entry = grouped.get(mode);
      entry.total += 1;
      if (toNumber(pick(game, ["iIsWin", "isWin"])) === 1) {
        entry.win += 1;
      } else {
        entry.lose += 1;
      }
    });

    list = [...grouped.entries()].map(([mode, data]) => ({
      mode,
      ...data,
      rate: (data.win / Math.max(1, data.total)) * 100
    }));
  }

  list = list
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);

  if (!list.length) {
    renderPlaceholder(container, "暂无模式数据");
    return;
  }

  list.forEach((item) => {
    const card = document.createElement("div");
    card.className = "mode-card";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.mode;

    const count = document.createElement("div");
    count.className = "count";
    count.textContent = formatNumber(item.total);
    const countUnit = document.createElement("span");
    countUnit.textContent = "场";
    count.appendChild(countUnit);

    const extra = document.createElement("div");
    extra.className = "extra";
    const win = document.createElement("span");
    win.className = "win";
    win.textContent = `通关 ${formatNumber(item.win)}`;

    const lose = document.createElement("span");
    lose.className = "lose";
    lose.textContent = `未通关 ${formatNumber(item.lose)}`;

    const rate = document.createElement("span");
    rate.textContent = formatPercent(item.rate);

    extra.append(win, lose, rate);

    card.append(name, count, extra);
    container.appendChild(card);
  });
}

function renderMapCards() {
  const container = byId("map-cards");
  container.innerHTML = "";
  const mapLookup = buildMapLookup();

  const mapStats = getStatsPayload()?.mapStats || {};
  let list = Object.entries(mapStats)
    .map(([map, detail]) => {
      if (detail && typeof detail === "object" && toNumber(detail?.total) > 0) {
        const total = toNumber(detail?.total);
        const win = toNumber(detail?.win);
        return {
          map: map || "未知地图",
          total,
          win,
          rate: (win / Math.max(1, total)) * 100,
          modeList: [
            {
              label: "总计",
              total,
              win,
              rate: (win / Math.max(1, total)) * 100
            }
          ]
        };
      }

      const subEntries =
        detail && typeof detail === "object"
          ? Object.entries(detail)
              .map(([subMode, subData]) => ({
                label: normalizeDifficultyName(String(subMode || "").trim()) || "未知难度",
                total: toNumber(subData?.total),
                win: toNumber(subData?.win),
                rate:
                  (toNumber(subData?.win) / Math.max(1, toNumber(subData?.total))) * 100
              }))
              .filter((x) => x.total > 0)
          : [];

      const total = subEntries.reduce((sum, x) => sum + x.total, 0);
      const win = subEntries.reduce((sum, x) => sum + x.win, 0);
      return {
        map: map || "未知地图",
        total,
        win,
        rate: (win / Math.max(1, total)) * 100,
        modeList: subEntries
          .sort((a, b) => b.total - a.total)
          .slice(0, 3)
      };
    })
    .filter((item) => item.total > 0);

  if (!list.length) {
    const recent = getRecentGames(100);
    if (!recent.length) {
      renderPlaceholder(container, "暂无地图详情");
      return;
    }

    const grouped = new Map();
    recent.forEach((game) => {
      const mapName = inferMapName(game);
      if (!grouped.has(mapName)) {
        grouped.set(mapName, { total: 0, win: 0, sample: game, diffMap: new Map() });
      }
      const entry = grouped.get(mapName);
      entry.total += 1;
      const isWin = toNumber(pick(game, ["iIsWin", "isWin"])) === 1;
      if (isWin) {
        entry.win += 1;
      }

      const diff = inferDifficultyName(game);
      if (!entry.diffMap.has(diff)) {
        entry.diffMap.set(diff, { total: 0, win: 0 });
      }
      const diffEntry = entry.diffMap.get(diff);
      diffEntry.total += 1;
      if (isWin) {
        diffEntry.win += 1;
      }
    });

    list = [...grouped.entries()].map(([map, data]) => ({
      map,
      ...data,
      rate: (data.win / Math.max(1, data.total)) * 100,
      modeList: [...data.diffMap.entries()]
        .map(([label, diffData]) => ({
          label,
          total: diffData.total,
          win: diffData.win,
          rate: (diffData.win / Math.max(1, diffData.total)) * 100
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 3)
    }));
  }

  list = list.sort((a, b) => b.total - a.total).slice(0, 6);

  if (!list.length) {
    renderPlaceholder(container, "暂无地图详情");
    return;
  }

  list.forEach((item) => {
    const card = document.createElement("article");
    card.className = "map-card";

    const mapName = String(item?.map || "").trim();
    const mappedList = mapLookup.byName.get(mapName) || [];
    const mappedBg = resolveImage(mappedList[0]?.icon || "");
    const bgCandidates = extractImageCandidates(item.sample || {});
    const bgImage = mappedBg || bgCandidates[0] || "";
    if (bgImage) {
      const bg = document.createElement("div");
      bg.className = "map-bg";
      bg.style.backgroundImage = `url('${bgImage}')`;
      card.appendChild(bg);
    }

    const overlay = document.createElement("div");
    overlay.className = "map-overlay";

    const content = document.createElement("div");
    content.className = "map-content";

    const title = document.createElement("div");
    title.className = "map-name";
    title.textContent = item.map;

    const main = document.createElement("div");
    main.className = "map-main";
    main.textContent = `${formatNumber(item.total)}场 - ${formatPercent(item.rate)} 通关率`;

    content.append(title, main);

    item.modeList.forEach((part) => {
      const line = document.createElement("div");
      line.className = "map-sub";
      const left = document.createElement("span");
      left.textContent = part.label;
      const right = document.createElement("span");
      right.textContent = `${formatNumber(part.total)}场 (${formatPercent(part.rate)})`;
      line.append(left, right);
      content.appendChild(line);
    });

    card.append(overlay, content);
    container.appendChild(card);
  });
}

function renderLocalMapCards() {
  const container = byId("local-map-cards");
  if (!container) {
    return;
  }
  container.innerHTML = "";

  const payload = getStatsPayload();
  const localMapStats = state.localStats?.localMapStats || payload?.localMapStats || {};
  setLocalMetaInfo(localMapStats);
  const localList = Array.isArray(localMapStats?.maps) ? localMapStats.maps : [];
  const historyMapping =
    state.historyRemote?.configMapping && typeof state.historyRemote.configMapping === "object"
      ? state.historyRemote.configMapping
      : payload?.configMapping || null;
  const allMapList = getAllMapsFromHistoryConfig(historyMapping);

  const localByMapId = new Map();
  const localByNameMode = new Map();
  localList.forEach((item) => {
    const mapIdText = String(item?.mapId || "").trim();
    const mapName = String(item?.mapName || "").trim();
    const modeName = toDisplayModeName(item?.modeName || "");
    if (mapIdText) {
      localByMapId.set(mapIdText, item);
    }
    if (mapName) {
      localByNameMode.set(`${mapName}|${modeName}`, item);
    }
  });

  const consumedLocal = new Set();
  let list = [];
  if (allMapList.length) {
    list = allMapList.map((mapItem) => {
      const localItem =
        localByMapId.get(mapItem.mapId) ||
        localByNameMode.get(`${mapItem.mapName}|${toDisplayModeName(mapItem.modeName)}`);
      if (localItem) {
        consumedLocal.add(localItem);
      }
      return {
        mapId: toNumber(mapItem.mapId) || toNumber(localItem?.mapId) || 0,
        mapName: mapItem.mapName || localItem?.mapName || "未知地图",
        modeName: mapItem.modeName || toDisplayModeName(localItem?.modeName) || "",
        icon: mapItem.icon || localItem?.icon || "",
        total: toNumber(localItem?.total),
        win: toNumber(localItem?.win),
        localTotal: toNumber(localItem?.localTotal),
        localWin: toNumber(localItem?.localWin),
        importTotal: toNumber(localItem?.importTotal),
        importWin: toNumber(localItem?.importWin),
        rate: toNumber(localItem?.rate),
        localRate: toNumber(localItem?.localRate),
        importRate: toNumber(localItem?.importRate),
        lastTime: localItem?.lastTime || "",
        difficulties: Array.isArray(localItem?.difficulties) ? localItem.difficulties : [],
        importBatches: Array.isArray(localItem?.importBatches) ? localItem.importBatches : []
      };
    });

    localList.forEach((item) => {
      if (consumedLocal.has(item)) return;
      list.push(item);
    });
  } else {
    list = localList;
  }

  if (state.localOnlyWithData) {
    list = list.filter((item) => toNumber(item?.total) > 0 || toNumber(item?.importTotal) > 0);
  }

  if (!list.length) {
    renderPlaceholder(container, "暂无本地地图数据");
    return;
  }

  const mapLookup = buildMapLookup(payload);

  list.forEach((item) => {
    const card = document.createElement("article");
    card.className = "map-card";

    const mapIdText = String(item?.mapId || "").trim();
    const byId = mapLookup.byId.get(mapIdText);
    const byName = (mapLookup.byName.get(String(item?.mapName || "")) || [])[0];
    const mapBg = resolveImage(item?.icon || byId?.icon || byName?.icon || "");
    if (mapBg) {
      const bg = document.createElement("div");
      bg.className = "map-bg";
      bg.style.backgroundImage = `url('${mapBg}')`;
      card.appendChild(bg);
    }

    const overlay = document.createElement("div");
    overlay.className = "map-overlay";

    const content = document.createElement("div");
    content.className = "map-content";

    const title = document.createElement("div");
    title.className = "map-name";
    const modeText = toDisplayModeName(item?.modeName);
    title.textContent = modeText
      ? `${String(item?.mapName || "未知地图")}（${modeText}）`
      : String(item?.mapName || "未知地图");

    const main = document.createElement("div");
    main.className = "map-main";
    main.textContent = `${formatNumber(item?.total || 0)}场 - ${formatPercent(item?.rate || 0)} 通关率`;
    content.append(title, main);

    const localLine = document.createElement("div");
    localLine.className = "map-sub";
    const localLeft = document.createElement("span");
    localLeft.textContent = "本地数据";
    const localRight = document.createElement("span");
    localRight.textContent = `${formatNumber(item?.localTotal || 0)}场 (${formatPercent(item?.localRate || 0)})`;
    localLine.append(localLeft, localRight);
    content.appendChild(localLine);

    const importLine = document.createElement("div");
    importLine.className = "map-sub map-sub-action";
    const importLeft = document.createElement("span");
    importLeft.textContent = "本地导入数据";
    const importRight = document.createElement("div");
    importRight.className = "map-sub-right";
    const importStat = document.createElement("span");
    importStat.textContent = `${formatNumber(item?.importTotal || 0)}场 (${formatPercent(item?.importRate || 0)})`;
    importRight.append(importStat);
    if (toNumber(item?.importTotal) > 0) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "local-import-clear-btn";
      clearBtn.textContent = "清空";
      clearBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearBtn.disabled = true;
        try {
          await onLocalClear();
        } finally {
          clearBtn.disabled = false;
        }
      });
      importRight.appendChild(clearBtn);
    }
    importLine.append(importLeft, importRight);
    content.appendChild(importLine);

    const importBatches = Array.isArray(item?.importBatches) ? item.importBatches : [];
    importBatches
      .filter((batch) => toNumber(batch?.total) > 0)
      .forEach((batch) => {
        const row = document.createElement("div");
        row.className = "map-sub map-sub-action";

        const left = document.createElement("span");
        left.textContent = `第${formatNumber(batch?.batchIndex || 0)}次导入`;

        const right = document.createElement("div");
        right.className = "map-sub-right";

        const stats = document.createElement("span");
        stats.textContent = `${formatNumber(batch?.total || 0)}场 (${formatPercent(batch?.rate || 0)})`;
        right.append(stats);
        row.append(left, right);
        content.appendChild(row);
      });

    const diffList = Array.isArray(item?.difficulties) ? item.difficulties : [];
    diffList.slice(0, 3).forEach((diff) => {
      const line = document.createElement("div");
      line.className = "map-sub";
      const left = document.createElement("span");
      left.textContent = String(diff?.diffName || "未知难度");
      const right = document.createElement("span");
      right.textContent = `${formatNumber(diff?.total || 0)}场 (${formatPercent(diff?.rate || 0)})`;
      line.append(left, right);
      content.appendChild(line);
    });

    card.append(overlay, content);
    container.appendChild(card);
  });
}

function extractFragmentData(item) {
  const name = pick(
    item,
    [
      "weaponName",
      "weapon_name",
      "trap_name",
      "plugin_name",
      "trapName",
      "pluginName",
      "sTrapName",
      "sPluginName",
      "collectionName",
      "sName",
      "name",
      "sWeaponName",
      "sItemName",
      "itemName",
      "title"
    ],
    "武器碎片"
  );
  const owned = boolLike(pick(item, ["owned", "iOwned", "has", "isOwned"], false));
  const progress = item?.itemProgress && typeof item.itemProgress === "object" ? item.itemProgress : null;

  const numericEntries = Object.entries(item || {})
    .map(([key, value]) => ({ key: key.toLowerCase(), value: toNumber(value) }))
    .filter((x) => x.value > 0);

  const currentKeyHit = numericEntries.find((x) =>
    /(cur|current|num|piece|chip|progress|owned|have|count)/.test(x.key)
  );
  const totalKeyHit = numericEntries.find((x) =>
    /(need|max|total|target|full|limit|require)/.test(x.key)
  );

  const current =
    toNumber(
      pick(
        item,
        [
          "itemProgressCurrent",
          "currentNum",
          "current",
          "curNum",
          "weaponNum",
          "pieceNum",
          "iPieceNum",
          "chipNum",
          "progressNum",
          "num",
          "iNum"
        ],
        toNumber(progress?.current) ||
          toNumber(progress?.cur) ||
          toNumber(progress?.value) ||
          currentKeyHit?.value ||
          0
      )
    ) || 0;

  let total =
    toNumber(
      pick(
        item,
        [
          "itemProgressRequired",
          "totalNum",
          "needNum",
          "targetNum",
          "maxNum",
          "iNeedNum",
          "iTotal",
          "total",
          "iMaxNum"
        ],
        toNumber(progress?.required) ||
          toNumber(progress?.need) ||
          toNumber(progress?.target) ||
          totalKeyHit?.value ||
          0
      )
    ) || 0;

  if (!total) {
    total = current > 0 ? Math.max(current, 100) : 100;
  }

  if (owned && current <= 0) {
    return { name, current: total, total, owned, iconCandidates: extractImageCandidates(item) };
  }

  return { name, current, total, owned, iconCandidates: extractImageCandidates(item) };
}

function renderFragmentList() {
  const container = byId("fragment-list");
  container.innerHTML = "";

  const homeList = Array.isArray(state.collection?.data?.home) ? state.collection.data.home : [];

  if (!homeList.length) {
    renderPlaceholder(container, "暂无武器碎片数据");
    return;
  }

  homeList.slice(0, 6).forEach((raw) => {
    const item = extractFragmentData(raw);
    const progress = Math.min(100, Math.max(0, (item.current / Math.max(1, item.total)) * 100));

    const wrapper = document.createElement("div");
    wrapper.className = "fragment-item";

    const head = document.createElement("div");
    head.className = "fragment-head";

    const iconCandidates = item.iconCandidates;
    if (iconCandidates.length) {
      const img = document.createElement("img");
      img.alt = item.name;
      img.src = iconCandidates[0];
      head.appendChild(img);
    }

    const name = document.createElement("div");
    name.className = "fragment-name";
    name.textContent = item.name;
    head.appendChild(name);

    const bar = document.createElement("div");
    bar.className = "fragment-bar";
    const fill = document.createElement("span");
    fill.style.width = `${progress}%`;
    bar.appendChild(fill);

    const text = document.createElement("div");
    text.className = "fragment-text";
    text.textContent = `${formatNumber(item.current)}/${formatNumber(item.total)}`;

    wrapper.append(head, bar, text);
    container.appendChild(wrapper);
  });
}

function ensureImageObserver() {
  if (state.imageObserver) {
    return state.imageObserver;
  }

  state.imageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        loadLazyImage(img);
        state.imageObserver.unobserve(img);
      });
    },
    {
      root: null,
      rootMargin: "120px 0px",
      threshold: 0.01
    }
  );

  return state.imageObserver;
}

function loadLazyImage(img) {
  if (!img || img.dataset.loaded === "1") return;
  const src = img.dataset.src;
  if (!src) return;
  img.src = src;
  img.dataset.loaded = "1";
}

function attachLazyImage(img) {
  if (typeof IntersectionObserver === "undefined") {
    loadLazyImage(img);
    return;
  }

  const observer = ensureImageObserver();
  observer.observe(img);
}

function createLazyImage(candidates, name) {
  const img = document.createElement("img");
  img.alt = name;
  img.loading = "lazy";
  img.decoding = "async";
  img.dataset.candidates = JSON.stringify(candidates);
  img.dataset.index = "0";
  img.dataset.src = candidates[0] || "";
  img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

  img.addEventListener("error", () => {
    const list = JSON.parse(img.dataset.candidates || "[]");
    const nextIndex = Number(img.dataset.index || "0") + 1;
    if (nextIndex >= list.length) {
      return;
    }
    img.dataset.index = String(nextIndex);
    img.dataset.src = list[nextIndex];
    img.dataset.loaded = "0";
    loadLazyImage(img);
  });

  attachLazyImage(img);
  return img;
}

function renderCollectionSummary() {
  const container = byId("collection-summary");
  container.innerHTML = "";

  const summary = state.collection?.data?.summary;
  if (!summary) {
    renderPlaceholder(container, "暂无图鉴汇总");
    return;
  }

  const blocks = [
    { label: "武器", value: summary.weapons },
    { label: "陷阱", value: summary.traps },
    { label: "插件", value: summary.plugins }
  ];

  blocks.forEach((item) => {
    const owned = toNumber(item.value?.owned);
    const total = toNumber(item.value?.total);
    const rate = total ? ((owned / total) * 100).toFixed(1) : "0.0";
    container.appendChild(createInfoCard(`${item.label}拥有率`, `${owned}/${total} (${rate}%)`));
  });
}

function renderCollectionGrid() {
  const container = byId("collection-grid");
  container.innerHTML = "";

  const data = state.collection?.data || {};
  const list = Array.isArray(data[state.activeCollection]) ? data[state.activeCollection] : [];

  if (!list.length) {
    renderPlaceholder(container, "暂无图鉴数据");
    return;
  }

  list.forEach((item) => {
    const name = pick(
      item,
      [
        "weaponName",
        "weapon_name",
        "trap_name",
        "plugin_name",
        "trapName",
        "pluginName",
        "sTrapName",
        "sPluginName",
        "collectionName",
        "itemName",
        "sName",
        "name",
        "sWeaponName",
        "sItemName",
        "title"
      ],
      "未命名武器"
    );
    const imageCandidates = extractImageCandidates(item);

    const card = document.createElement("article");
    card.className = "collect-card";

    const imageWrap = document.createElement("div");
    imageWrap.className = "collect-image";

    if (imageCandidates.length) {
      imageWrap.appendChild(createLazyImage(imageCandidates, name));
    } else {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "无预览图";
      imageWrap.appendChild(empty);
    }

    const body = document.createElement("div");
    body.className = "collect-body";

    const nameEl = document.createElement("div");
    nameEl.className = "collect-name";
    nameEl.textContent = name;
    body.append(nameEl);
    card.append(imageWrap, body);
    container.appendChild(card);
  });
}

function getRoomId(game) {
  return String(
    pick(
      game,
      ["roomID", "DsRoomId", "dsRoomId", "sRoomID", "roomId", "iRoomId", "roomid", "id"],
      ""
    )
  ).trim();
}

function getFilteredHistoryGames() {
  const allGames = Array.isArray(state.historyRemote.list) ? state.historyRemote.list : [];
  const diffFilter = state.historyFilters.difficulty;

  return allGames.filter((game) => {
    const diff = inferDifficultyName(game);
    if (diffFilter !== "all" && diff !== diffFilter) {
      return false;
    }
    return true;
  });
}

function renderHistoryFilterOptions() {
  const modeSelect = byId("history-mode-select");
  const diffSelect = byId("history-diff-select");
  if (!modeSelect || !diffSelect) {
    return;
  }

  const allGames = Array.isArray(state.historyRemote.list) ? state.historyRemote.list : [];
  const configMapping = state.historyRemote.configMapping || {};
  const diffSet = new Set();
  const configDiffSet = getConfiguredDifficultyNames(configMapping);

  allGames.forEach((game) => {
    diffSet.add(inferDifficultyName(game));
  });

  const modeOptionMap = getModeOptionMap(configMapping);

  const modeOptions = ["all", ...[...modeOptionMap.keys()]];
  const dynamicDiffList = [...diffSet].filter(Boolean);
  const onlyHuntDiff = isOnlyHuntDifficulties(configMapping);
  const diffValues = onlyHuntDiff
    ? ["折磨I", "炼狱"]
    : [...new Set([...configDiffSet, ...dynamicDiffList])].sort((a, b) =>
        a.localeCompare(b, "zh-CN")
      );
  const diffOptions = ["all", ...diffValues];

  modeSelect.innerHTML = "";
  diffSelect.innerHTML = "";

  modeOptions.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent =
      value === "all" ? "全部模式" : modeOptionMap.get(value) || `模式${value}`;
    modeSelect.appendChild(option);
  });

  diffOptions.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "all" ? "全部难度" : value;
    diffSelect.appendChild(option);
  });

  modeSelect.value = modeOptions.includes(state.historyFilters.mode)
    ? state.historyFilters.mode
    : "all";
  diffSelect.value = diffOptions.includes(state.historyFilters.difficulty)
    ? state.historyFilters.difficulty
    : "all";
}

function getHistoryPageCount() {
  const totalPages = Number(state.historyRemote.totalPages);
  if (Number.isFinite(totalPages) && totalPages > 0) {
    return totalPages;
  }
  if (state.historyRemote.hasMore) {
    return state.historyPage + 1;
  }
  return Math.max(1, state.historyPage);
}

function renderHistoryPager() {
  const pageCount = getHistoryPageCount();
  state.historyPage = Math.max(1, state.historyPage);

  byId("history-page-info").textContent =
    state.historyRemote.totalPages && state.historyRemote.totalPages > 0
      ? `第 ${state.historyPage} 页 / 共 ${pageCount} 页`
      : `第 ${state.historyPage} 页`;
  byId("history-prev-btn").disabled = state.historyPage <= 1;
  if (state.historyRemote.totalPages && state.historyRemote.totalPages > 0) {
    byId("history-next-btn").disabled = state.historyPage >= pageCount;
  } else {
    byId("history-next-btn").disabled = !state.historyRemote.hasMore;
  }
}

function renderHistoryList() {
  const container = byId("history-list");
  container.innerHTML = "";

  renderHistoryFilterOptions();

  const currentList = getFilteredHistoryGames();
  if (!currentList.length) {
    renderPlaceholder(container, "暂无历史对局记录");
    renderHistoryPager();
    return;
  }

  currentList.forEach((game) => {
    const isWin = toNumber(pick(game, ["iIsWin", "isWin"])) === 1;
    const mode = inferModeName(game);
    const diff = inferDifficultyName(game);
    const map = inferMapName(game);
    const score = formatNumber(pick(game, ["iScore", "score"]));
    const duration = formatDuration(
      pick(game, ["iUseTime", "useTime", "duration", "iDuration", "costTime"])
    );
    const timeText = formatTime(
      pick(game, ["dtEventTime", "sGameTime", "time", "createTime", "eventTime"])
    );
    const roomId = getRoomId(game);

    const row = document.createElement("div");
    row.className = "history-row";
    row.dataset.roomId = roomId;

    const top = document.createElement("div");
    top.className = "history-top";

    const title = document.createElement("div");
    title.className = "history-title";

    const resultTag = document.createElement("span");
    resultTag.className = isWin ? "tag-win" : "tag-lose";
    resultTag.textContent = isWin ? "胜利" : "失败";

    const modeTag = document.createElement("span");
    modeTag.textContent = mode;

    title.append(resultTag, modeTag);

    const scoreEl = document.createElement("div");
    scoreEl.className = "history-score";
    scoreEl.textContent = score;

    top.append(title, scoreEl);

    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = `${map} | ${diff} | ${timeText} | ${duration}`;

    row.append(top, meta);

    if (roomId) {
      const expand = document.createElement("button");
      expand.className = "expand-btn";
      expand.textContent = "展开详细数据";
      expand.dataset.roomId = roomId;
      row.appendChild(expand);
    }

    container.appendChild(row);
  });

  renderHistoryPager();
}

function getFilteredLocalBattleGames() {
  const allGames = getLocalBattleAllGames();
  const modeFilter = String(state.localBattleFilters.mode || "all").trim();
  const diffFilter = String(state.localBattleFilters.difficulty || "all").trim();
  const mapKeyFilter = String(state.localBattleFilters.mapKey || "all").trim();

  return allGames.filter((game) => {
    const mode = inferModeName(game);
    if (modeFilter !== "all" && mode !== modeFilter) {
      return false;
    }
    const diff = inferDifficultyName(game);
    if (diffFilter !== "all" && diff !== diffFilter) {
      return false;
    }
    if (mapKeyFilter !== "all") {
      const key = buildLocalMapFilterKey(inferMapName(game), mode);
      if (key !== mapKeyFilter) {
        return false;
      }
    }
    return true;
  });
}

function getLocalBattlePageCount(totalCount) {
  return Math.max(1, Math.ceil(Math.max(0, Number(totalCount) || 0) / LOCAL_BATTLE_PAGE_SIZE));
}

function renderLocalBattlePager(totalCount) {
  const pageCount = getLocalBattlePageCount(totalCount);
  state.localBattlePage = Math.min(Math.max(1, state.localBattlePage), pageCount);

  const info = byId("local-battle-page-info");
  const prevBtn = byId("local-battle-prev-btn");
  const nextBtn = byId("local-battle-next-btn");
  if (info) {
    info.textContent = `第 ${state.localBattlePage} 页 / 共 ${pageCount} 页`;
  }
  if (prevBtn) {
    prevBtn.disabled = state.localBattlePage <= 1;
  }
  if (nextBtn) {
    nextBtn.disabled = state.localBattlePage >= pageCount;
  }
}

function renderLocalBattleList() {
  const container = byId("local-battle-list");
  if (!container) {
    return;
  }
  container.innerHTML = "";

  renderLocalBattleFilterOptions();

  const parseEventTime = (game) => {
    const raw = String(
      pick(game, ["dtEventTime", "eventTime", "dtGameStartTime", "startTime"], "")
    ).trim();
    if (!raw) return 0;
    const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
    const ts = Date.parse(normalized);
    return Number.isFinite(ts) ? ts : 0;
  };
  const filtered = getFilteredLocalBattleGames().sort((a, b) => parseEventTime(b) - parseEventTime(a));
  const pageCount = getLocalBattlePageCount(filtered.length);
  state.localBattlePage = Math.min(Math.max(1, state.localBattlePage), pageCount);
  const start = (state.localBattlePage - 1) * LOCAL_BATTLE_PAGE_SIZE;
  const currentList = filtered.slice(start, start + LOCAL_BATTLE_PAGE_SIZE);

  if (!currentList.length) {
    renderPlaceholder(container, "暂无本地对局记录");
    renderLocalBattlePager(filtered.length);
    return;
  }

  currentList.forEach((game) => {
    const isWin = toNumber(pick(game, ["isWin", "iIsWin"])) === 1;
    const mode = inferModeName(game);
    const diff = inferDifficultyName(game);
    const map = inferMapName(game);
    const scoreRaw = pick(game, ["iScore", "score"], "");
    const score = scoreRaw === "" ? "--" : formatNumber(scoreRaw);
    const durationSeconds = resolveLocalBattleDurationSeconds(game);
    const duration = durationSeconds > 0 ? formatDuration(durationSeconds) : "--";
    const timeText = formatTime(
      pick(game, ["dtEventTime", "eventTime", "dtGameStartTime", "startTime", "sGameTime", "time", "createTime"], "")
    );
    const roomId = getRoomId(game);

    const row = document.createElement("div");
    row.className = "history-row";
    row.dataset.roomId = roomId;

    const top = document.createElement("div");
    top.className = "history-top";

    const title = document.createElement("div");
    title.className = "history-title";

    const resultTag = document.createElement("span");
    resultTag.className = isWin ? "tag-win" : "tag-lose";
    resultTag.textContent = isWin ? "胜利" : "失败";

    const modeTag = document.createElement("span");
    modeTag.textContent = mode;

    const sourceTag = document.createElement("span");
    const sourceType = inferLocalRecordSourceType(game);
    sourceTag.className =
      sourceType === "json-transfer"
        ? "tag-source tag-source-json"
        : "tag-source tag-source-official";
    sourceTag.textContent = inferLocalRecordSourceLabel(game);

    title.append(resultTag, modeTag, sourceTag);

    const scoreEl = document.createElement("div");
    scoreEl.className = "history-score";
    scoreEl.textContent = score;

    top.append(title, scoreEl);

    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = `${map} | ${diff} | ${timeText} | ${duration}`;
    row.append(top, meta);

    if (roomId) {
      const expand = document.createElement("button");
      expand.className = "expand-btn";
      expand.textContent = "展开详细数据";
      expand.dataset.roomId = roomId;
      row.appendChild(expand);
    }

    container.appendChild(row);
  });

  renderLocalBattlePager(filtered.length);
}

async function loadHistoryPage(page = 1) {
  const tokenText = byId("token-input")?.value?.trim();
  if (!tokenText) {
    state.historyRemote = {
      list: [],
      page: 1,
      limit: state.historyPageSize,
      totalPages: null,
      totalCount: null,
      hasMore: false,
      configMapping: {}
    };
    renderHistoryList();
    return;
  }

  const modeType = String(state.historyFilters.mode || "").trim();
  const query = {
    page,
    limit: state.historyPageSize
  };
  if (modeType && modeType !== "all") {
    query.modeType = modeType;
  }

  const result = await window.nzmApi.getHistory(query);
  if (!result?.success) {
    throw new Error(result?.message || "history fetch failed");
  }

  const data = result.data || {};
  state.historyRemote = {
    list: Array.isArray(data.list) ? data.list : [],
    page: Number(data.page) > 0 ? Number(data.page) : page,
    limit: Number(data.limit) > 0 ? Number(data.limit) : state.historyPageSize,
    totalPages: Number(data.totalPages) > 0 ? Number(data.totalPages) : null,
    totalCount: Number(data.totalCount) > 0 ? Number(data.totalCount) : null,
    hasMore: Boolean(data.hasMore),
    configMapping:
      data.configMapping && typeof data.configMapping === "object"
        ? data.configMapping
        : {}
  };
  state.historyPage = state.historyRemote.page;
  renderHistoryList();
}

function renderAllPanels() {
  renderStatsCards();
  renderRecentCards();
  renderModeCards();
  renderMapCards();
  renderLocalBattleList();
  renderLocalMapCards();
  renderFragmentList();
  renderHistoryList();
  renderCollectionSummary();
  renderCollectionGrid();
}

async function loadLocalStats() {
  const result = await window.nzmApi.getLocalStats();
  if (!result?.success) {
    throw new Error(result?.message || "本地统计加载失败");
  }
  state.localStats = result.data || null;
  renderLocalBattleList();
  renderLocalMapCards();
}

function switchPanel(panel) {
  state.activePanel = panel;

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.panel === panel);
  });

  document.querySelectorAll(".panel").forEach((section) => {
    section.classList.toggle("active", section.id === `panel-${panel}`);
  });

  const panelTitle = byId("panel-title");
  if (panelTitle) {
    const activeBtn = document.querySelector(`.nav-btn[data-panel=\"${panel}\"]`);
    panelTitle.textContent = activeBtn?.textContent?.trim() || "官方历史数据（小程序）";
  }
}

function switchCollectionTab(type) {
  state.activeCollection = type;
  document.querySelectorAll(".chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.collection === type);
  });
  renderCollectionGrid();
}

async function refreshAllData() {
  const openid = byId("openid-input")?.value?.trim();
  const tokenText = byId("token-input")?.value?.trim();
  if (!openid || !tokenText) {
    setStatus("请先绑定 openid 和 token", false);
    return;
  }

  setLoading(true);

  try {
    const [statsResult, collectionResult, historyResult] = await Promise.allSettled([
      window.nzmApi.getStats(),
      window.nzmApi.getCollection(),
      loadHistoryPage(1)
    ]);
    let difficultyText = "";
    let towerText = "";

    let hasSuccess = false;

    if (statsResult.status === "fulfilled" && statsResult.value?.success) {
      state.stats = statsResult.value;
      state.localStats = {
        localMapStats: statsResult.value?.data?.localMapStats || null,
        localStatsMeta: statsResult.value?.data?.localStatsMeta || null,
        localRecords: Array.isArray(statsResult.value?.data?.localRecords)
          ? statsResult.value.data.localRecords
          : []
      };
      state.historyPage = 1;
      hasSuccess = true;
      difficultyText = getDifficultyCheckText(statsResult.value?.data?.configMapping || null);
      towerText = getTowerMapCheckText(statsResult.value?.data || null);
    }

    if (collectionResult.status === "fulfilled" && collectionResult.value?.success) {
      state.collection = collectionResult.value;
      hasSuccess = true;
    }

    if (historyResult.status === "fulfilled") {
      hasSuccess = true;
    }

    renderAllPanels();

    if (hasSuccess) {
      const parts = [difficultyText, towerText].filter(Boolean);
      setStatus(parts.length ? `数据已更新，${parts.join("，")}` : "数据已更新", true);
      return;
    }

    const message =
      statsResult.status === "rejected"
        ? statsResult.reason?.message
        : historyResult.status === "rejected"
        ? historyResult.reason?.message
        : collectionResult.status === "rejected"
        ? collectionResult.reason?.message
        : "加载失败";

    setStatus(`加载失败: ${message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onSaveToken() {
  const openid = byId("openid-input")?.value?.trim();
  const token = byId("token-input")?.value?.trim();
  if (!openid || !token) {
    setStatus("openid 和 token 不能为空", false);
    return;
  }

  try {
    setLoading(true);
    const result = await window.nzmApi.bindAccessToken({
      openid,
      accessToken: token
    });
    const accounts = Array.isArray(result?.data?.accounts) ? result.data.accounts : [];
    if (accounts.length) {
      state.accounts = accounts;
      state.activeUin = String(result?.data?.uin || "").trim();
      renderAccountSelect();
    }
    setStatus(result.message || "账号信息已保存", true);
    await refreshAllData();
  } catch (error) {
    setStatus(`保存失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onClearToken() {
  await window.nzmApi.clearAccessToken();
  byId("token-input").value = "";
  try {
    const config = await window.nzmApi.getSessionConfig();
    state.accounts = Array.isArray(config?.data?.accounts) ? config.data.accounts : state.accounts;
    state.activeUin = String(config?.data?.activeUin || state.activeUin || "").trim();
    renderAccountSelect();
  } catch (_) {
    // no-op
  }
  state.stats = null;
  state.collection = null;
  state.detailCache.clear();
  state.historyPage = 1;
  state.historyFilters.mode = "all";
  state.historyFilters.difficulty = "all";
  state.localBattlePage = 1;
  state.localBattleFilters.mode = "all";
  state.localBattleFilters.difficulty = "all";
  state.localBattleFilters.mapKey = "all";
  state.historyRemote = {
    list: [],
    page: 1,
    limit: state.historyPageSize,
    totalPages: null,
    totalCount: null,
    hasMore: false,
    configMapping: {}
  };
  renderAllPanels();
  setStatus("已清空本地 token", true);
}

async function onLocalClear() {
  try {
    setLoading(true);
    const result = await window.nzmApi.clearLocalStats();
    if (!result?.success) {
      throw new Error(result?.message || "清除导入数据失败");
    }
    await loadLocalStats();
    setStatus("已清除全部导入数据", true);
  } catch (error) {
    setStatus(`清除导入数据失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onLocalResetAll() {
  const confirmed = window.confirm(
    "将清空本地全部数据（含本地战绩与导入数据），并从历史战绩重新保存到本地，是否继续？"
  );
  if (!confirmed) {
    return;
  }

  try {
    setLoading(true, "正在从历史战绩重建本地数据...");
    const result = await window.nzmApi.resetLocalStatsFromHistory();
    if (!result?.success) {
      throw new Error(result?.message || "重建本地数据失败");
    }
    state.localStats = {
      localMapStats: result?.data?.localMapStats || null,
      localRecords: Array.isArray(result?.data?.localRecords) ? result.data.localRecords : [],
      localStatsMeta: result?.data?.localStatsMeta || null
    };
    renderLocalBattleList();
    renderLocalMapCards();
    setStatus(result?.message || "本地数据已重建", true);
  } catch (error) {
    setStatus(`清空并重建失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onLocalImport() {
  try {
    setLoading(true);
    const result = await window.nzmApi.importLocalStatsXlsx();
    if (!result?.success) {
      if (result?.message === "已取消导入") {
        setStatus("已取消导入", false);
        return;
      }
      throw new Error(result?.message || "导入失败");
    }
    await loadLocalStats();
    setStatus(result.message || "本地统计导入完成", true);
  } catch (error) {
    setStatus(`导入本地统计失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onLocalExportXlsx() {
  try {
    setLoading(true);
    const result = await window.nzmApi.exportLocalStatsXlsx();
    if (!result?.success) {
      if (result?.message === "已取消导出") {
        setStatus("已取消导出", false);
        return;
      }
      throw new Error(result?.message || "导出失败");
    }
    setStatus(result.message || "导出完成", true);
  } catch (error) {
    setStatus(`导出本地统计失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onLocalTemplateDownload() {
  try {
    setLoading(true);
    const result = await window.nzmApi.downloadLocalTemplateXlsx();
    if (!result?.success) {
      if (result?.message === "已取消下载模板") {
        setStatus("已取消下载模板", false);
        return;
      }
      throw new Error(result?.message || "下载模板失败");
    }
    setStatus(
      result?.message || `模板已下载: ${result?.data?.filePath || ""}`,
      true
    );
  } catch (error) {
    setStatus(`下载模板失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onLocalJsonImport() {
  try {
    setLoading(true);
    const result = await window.nzmApi.importLocalRecordsJson();
    if (!result?.success) {
      if (result?.message === "已取消导入") {
        setStatus("已取消导入", false);
        return;
      }
      throw new Error(result?.message || "JSON导入失败");
    }
    state.localStats = {
      localMapStats: result?.data?.localMapStats || null,
      localRecords: Array.isArray(result?.data?.localRecords) ? result.data.localRecords : [],
      localStatsMeta: result?.data?.localStatsMeta || null
    };
    renderLocalBattleList();
    renderLocalMapCards();
    setStatus(result.message || "JSON导入完成", true);
  } catch (error) {
    setStatus(`JSON导入失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onLocalJsonExport() {
  try {
    setLoading(true);
    const result = await window.nzmApi.exportLocalRecordsJson();
    if (!result?.success) {
      if (result?.message === "已取消导出") {
        setStatus("已取消导出", false);
        return;
      }
      throw new Error(result?.message || "JSON导出失败");
    }
    setStatus(result.message || "JSON导出完成", true);
  } catch (error) {
    setStatus(`JSON导出失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onSaveQiniuConfig() {
  try {
    setLoading(true, "正在保存并测试七牛云连通性...");
    const payload = readQiniuConfigInputs();
    const result = await window.nzmApi.saveQiniuConfig(payload);
    const nextConfig =
      result?.data?.config && typeof result.data.config === "object"
        ? result.data.config
        : result?.data && typeof result.data === "object"
          ? result.data
          : payload;
    state.qiniuConfig = nextConfig;
    fillQiniuConfigInputs(state.qiniuConfig);
    if (!result?.success) {
      setStatus(result?.message || "七牛云配置已保存，但连通性校验失败", false);
      return;
    }
    closeQiniuModal();
    setStatus(result?.message || "七牛云配置已保存，连通性校验通过（未上传）", true);
  } catch (error) {
    setStatus(`保存或测试失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onLocalCloudSync() {
  try {
    setLoading(true, "正在同步本地统计到七牛云...");
    const result = await window.nzmApi.syncLocalStatsToCloud();
    if (!result?.success) {
      throw new Error(result?.message || "云同步失败");
    }
    const url = String(result?.data?.url || "").trim();
    setStatus(
      url ? `${result?.message || "云同步成功"}，${url}` : result?.message || "云同步成功",
      true
    );
  } catch (error) {
    setStatus(`云同步失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onLocalCloudPull() {
  try {
    setLoading(true, "正在从七牛云拉取本地统计...");
    const result = await window.nzmApi.pullLocalStatsFromCloud();
    if (!result?.success) {
      throw new Error(result?.message || "云拉取失败");
    }
    state.localStats = {
      localMapStats: result?.data?.localMapStats || null,
      localRecords: Array.isArray(result?.data?.localRecords) ? result.data.localRecords : [],
      localStatsMeta: result?.data?.localStatsMeta || null
    };
    renderLocalBattleList();
    renderLocalMapCards();
    setStatus(result?.message || "云拉取完成", true);
  } catch (error) {
    setStatus(`云拉取失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

async function onRefreshLocalByRoomId() {
  try {
    setLoading(true, "正在根据 dsRoomId 更新本地战绩...");
    const result = await window.nzmApi.refreshLocalRecordsByRoomId();
    if (!result?.success) {
      throw new Error(result?.message || "更新失败");
    }
    state.localStats = {
      localMapStats: result?.data?.localMapStats || null,
      localRecords: Array.isArray(result?.data?.localRecords) ? result.data.localRecords : [],
      localStatsMeta: result?.data?.localStatsMeta || null
    };
    if (state.stats?.data) {
      state.stats.data.localMapStats = result?.data?.localMapStats || state.stats.data.localMapStats;
      state.stats.data.localRecords = Array.isArray(result?.data?.localRecords)
        ? result.data.localRecords
        : state.stats.data.localRecords;
      state.stats.data.localStatsMeta = result?.data?.localStatsMeta || state.stats.data.localStatsMeta;
    }
    renderLocalBattleList();
    renderLocalMapCards();
    setStatus(result?.message || "本地战绩更新完成", true);
  } catch (error) {
    setStatus(`本地战绩更新失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

function decodeText(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function resolveDetailImage(urlLike) {
  const decoded = decodeText(urlLike);
  if (!decoded) return "";
  if (/^https?:\/\//i.test(decoded)) return decoded;
  return resolveImage(decoded);
}

function toDisplayNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  return formatNumber(num);
}

function createHuntingMetricsGrid(huntingDetails) {
  const grid = document.createElement("div");
  grid.className = "history-drawer-metrics";
  const metrics = [
    {
      label: "总金币",
      value: pick(huntingDetails, ["totalCoin", "coin", "totalCoins"], "")
    },
    {
      label: "BOSS伤害",
      value: pick(huntingDetails, ["damageTotalOnBoss", "bossDamage", "damageBoss"], "")
    },
    {
      label: "小怪伤害",
      value: pick(huntingDetails, ["damageTotalOnMobs", "mobsDamage", "damageMobs"], "")
    }
  ];

  metrics.forEach((item) => {
    const cell = document.createElement("div");
    cell.className = "history-drawer-metric-card";
    const label = document.createElement("div");
    label.className = "history-drawer-metric-label";
    label.textContent = item.label;
    const value = document.createElement("div");
    value.className = "history-drawer-metric-value";
    value.textContent = toDisplayNumber(item.value);
    cell.append(label, value);
    grid.appendChild(cell);
  });
  return grid;
}

function createCommonItemsRow(items) {
  const row = document.createElement("div");
  row.className = "history-drawer-common-items";

  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("span");
    empty.className = "history-drawer-common-item-empty";
    empty.textContent = "无道具";
    row.appendChild(empty);
    return row;
  }

  items.forEach((item) => {
    const node = document.createElement("div");
    node.className = "history-drawer-common-item";
    const iconUrl = resolveDetailImage(
      pick(item, ["pic", "icon", "itemIcon", "img", "image"], "")
    );
    if (iconUrl) {
      const icon = document.createElement("img");
      icon.src = iconUrl;
      icon.alt = decodeText(pick(item, ["itemName", "name"], "道具"));
      node.appendChild(icon);
    }

    const name = document.createElement("span");
    name.textContent = decodeText(pick(item, ["itemName", "name"], "")) || "未命名道具";
    node.appendChild(name);
    row.appendChild(node);
  });

  return row;
}

function createEquipmentCard(equipmentItem) {
  const card = document.createElement("div");
  card.className = "history-drawer-equip-card";

  const picUrl = resolveDetailImage(pick(equipmentItem, ["pic", "icon", "weaponIcon"], ""));
  const imageWrap = document.createElement("div");
  imageWrap.className = "history-drawer-equip-image-wrap";
  if (picUrl) {
    const image = document.createElement("img");
    image.className = "history-drawer-equip-image";
    image.src = picUrl;
    image.alt = decodeText(pick(equipmentItem, ["weaponName", "name"], "武器"));
    imageWrap.appendChild(image);
  }
  card.appendChild(imageWrap);

  const name = document.createElement("div");
  name.className = "history-drawer-equip-name";
  name.textContent = decodeText(pick(equipmentItem, ["weaponName", "name"], "")) || "未命名武器";
  card.appendChild(name);

  const commonItems = Array.isArray(equipmentItem?.commonItems) ? equipmentItem.commonItems : [];
  card.appendChild(createCommonItemsRow(commonItems));

  return card;
}

function createEquipmentSection(equipmentScheme) {
  const section = document.createElement("div");
  section.className = "history-drawer-equipment-section";

  const title = document.createElement("div");
  title.className = "history-drawer-section-title";
  title.textContent = "本局配装";
  section.appendChild(title);

  const list = document.createElement("div");
  list.className = "history-drawer-equip-list";
  if (Array.isArray(equipmentScheme) && equipmentScheme.length) {
    equipmentScheme.forEach((item) => {
      list.appendChild(createEquipmentCard(item || {}));
    });
  } else {
    const empty = document.createElement("div");
    empty.className = "history-drawer-empty";
    empty.textContent = "无配装数据";
    list.appendChild(empty);
  }
  section.appendChild(list);

  return section;
}

function normalizeDetailResult(detailResult) {
  if (!detailResult || typeof detailResult !== "object") {
    return { success: false, message: "空数据", payload: {} };
  }
  if (detailResult.success === false) {
    return {
      success: false,
      message: detailResult.message || "详情接口返回失败",
      payload: detailResult.data && typeof detailResult.data === "object" ? detailResult.data : {}
    };
  }
  return {
    success: true,
    message: "",
    payload: detailResult.data && typeof detailResult.data === "object" ? detailResult.data : {}
  };
}

function createHistoryDetailDrawer(roomId, detailResult) {
  const drawer = document.createElement("div");
  drawer.className = "history-detail-drawer";

  const summary = normalizeDetailResult(detailResult);
  const payload = summary.payload || {};
  const list = Array.isArray(payload.list) ? payload.list : [];

  const head = document.createElement("div");
  head.className = "history-drawer-head";
  head.textContent = `玩家数: ${list.length}`;
  drawer.appendChild(head);

  if (!summary.success) {
    const error = document.createElement("div");
    error.className = "history-drawer-error";
    error.textContent = `详情加载失败: ${summary.message || "未知错误"}`;
    drawer.appendChild(error);
    return drawer;
  }

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "history-drawer-empty";
    empty.textContent = "该对局无玩家详情数据";
    drawer.appendChild(empty);
  } else {
    const players = document.createElement("div");
    players.className = "history-drawer-player-list";

    list.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "history-drawer-player-card";

      const nickname = decodeText(pick(item, ["nickname", "name"], "")) || `玩家${index + 1}`;
      const avatarRaw = decodeText(pick(item, ["avatar", "avatarUrl", "headUrl"], ""));
      const header = document.createElement("div");
      header.className = "history-drawer-player-head";

      if (/^https?:\/\//i.test(avatarRaw)) {
        const avatar = document.createElement("img");
        avatar.className = "history-drawer-avatar";
        avatar.src = avatarRaw;
        avatar.alt = nickname;
        header.appendChild(avatar);
      }

      const title = document.createElement("div");
      title.className = "history-drawer-player-name";
      title.textContent = nickname;
      header.appendChild(title);
      card.appendChild(header);

      card.appendChild(createHuntingMetricsGrid(item?.huntingDetails || {}));
      card.appendChild(createEquipmentSection(item?.equipmentScheme || []));
      players.appendChild(card);
    });

    drawer.appendChild(players);
  }

  return drawer;
}

async function onHistoryExpandClick(button) {
  const roomId = button.dataset.roomId;
  const row = button.closest(".history-row");
  if (!row || !roomId) return;

  const existing = row.querySelector(".history-detail-drawer");
  if (existing) {
    existing.classList.toggle("hidden");
    button.textContent = existing.classList.contains("hidden") ? "展开详细数据" : "收起详细数据";
    return;
  }

  const loading = document.createElement("div");
  loading.className = "history-detail-drawer";
  loading.textContent = "加载详情中...";
  row.appendChild(loading);

  button.disabled = true;

  try {
    if (!state.detailCache.has(roomId)) {
      const detail = await window.nzmApi.getDetail(roomId);
      state.detailCache.set(roomId, detail);
    }
    const drawer = createHistoryDetailDrawer(roomId, state.detailCache.get(roomId));
    loading.replaceWith(drawer);
    button.textContent = "收起详细数据";
  } catch (error) {
    const drawer = createHistoryDetailDrawer(roomId, {
      success: false,
      message: error.message || "详情加载失败",
      data: {}
    });
    loading.replaceWith(drawer);
    button.textContent = "展开详细数据";
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  byId("save-token-btn").addEventListener("click", onSaveToken);
  const accountSelect = byId("account-select");
  if (accountSelect) {
    accountSelect.addEventListener("change", async (event) => {
      const uin = String(event.target.value || "").trim();
      if (!uin) {
        return;
      }
      try {
        setLoading(true);
        const result = await window.nzmApi.switchAccount(uin);
        if (!result?.success) {
          throw new Error(result?.message || "切换账号失败");
        }
        state.accounts = Array.isArray(result?.data?.accounts) ? result.data.accounts : state.accounts;
        state.activeUin = String(result?.data?.uin || uin).trim();
        renderAccountSelect();
        if (result?.data?.openid) {
          byId("openid-input").value = result.data.openid;
        }
        if (result?.data?.accessToken !== undefined) {
          byId("token-input").value = String(result.data.accessToken || "");
        }
        state.stats = null;
        state.collection = null;
        state.detailCache.clear();
        state.historyPage = 1;
        state.historyFilters.mode = "all";
        state.historyFilters.difficulty = "all";
        state.localBattlePage = 1;
        state.localBattleFilters.mode = "all";
        state.localBattleFilters.difficulty = "all";
        state.localBattleFilters.mapKey = "all";
        state.historyRemote = {
          list: [],
          page: 1,
          limit: state.historyPageSize,
          totalPages: null,
          totalCount: null,
          hasMore: false,
          configMapping: {}
        };
        await loadLocalStats();
        setStatus(`已切换账号 ${state.activeUin}`, true);
        if (String(result?.data?.accessToken || "").trim()) {
          await refreshAllData();
        }
      } catch (error) {
        setStatus(`切换账号失败: ${error.message}`, false);
      } finally {
        setLoading(false);
      }
    });
  }
  const clearBtn = byId("clear-token-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", onClearToken);
  }
  byId("refresh-all-btn").addEventListener("click", refreshAllData);
  byId("refresh-short-btn").addEventListener("click", refreshAllData);
  byId("refresh-local-by-room-btn").addEventListener("click", onRefreshLocalByRoomId);
  byId("local-clear-btn").addEventListener("click", onLocalClear);
  byId("local-reset-btn").addEventListener("click", onLocalResetAll);
  byId("local-template-btn").addEventListener("click", onLocalTemplateDownload);
  byId("local-import-btn").addEventListener("click", onLocalImport);
  byId("local-export-btn").addEventListener("click", onLocalExportXlsx);
  byId("local-json-import-btn").addEventListener("click", onLocalJsonImport);
  byId("local-json-export-btn").addEventListener("click", onLocalJsonExport);
  byId("local-cloud-sync-btn").addEventListener("click", onLocalCloudSync);
  byId("local-cloud-pull-btn").addEventListener("click", onLocalCloudPull);
  byId("local-cloud-settings-btn").addEventListener("click", openQiniuModal);
  byId("qiniu-save-btn").addEventListener("click", onSaveQiniuConfig);
  byId("qiniu-close-btn").addEventListener("click", closeQiniuModal);
  byId("qiniu-modal").addEventListener("click", (event) => {
    if (event.target === byId("qiniu-modal")) {
      closeQiniuModal();
    }
  });
  byId("notice-toggle-btn").addEventListener("click", async () => {
    const modal = byId("notice-modal");
    if (!modal) return;
    if (!modal.classList.contains("hidden")) {
      closeNoticeModal();
      return;
    }
    if (!state.latestNotice?.content) {
      const latest = await window.nzmApi.getLatestNotice().catch(() => null);
      setNoticePayload(latest?.data || null);
      if (!latest?.data) {
        await refreshNotice({ autoPopup: false });
      }
    }
    await openNoticeModal(false);
  });
  byId("notice-close-btn").addEventListener("click", closeNoticeModal);
  byId("notice-modal").addEventListener("click", (event) => {
    if (event.target === byId("notice-modal")) {
      closeNoticeModal();
    }
  });
  byId("notice-body").addEventListener("click", (event) => {
    const image = event.target.closest("img");
    if (!image) {
      return;
    }
    openNoticeImageViewer(image.src, image.alt);
  });
  byId("notice-image-viewer").addEventListener("click", (event) => {
    if (event.target === byId("notice-image-viewer")) {
      closeNoticeImageViewer();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeNoticeImageViewer();
      closeQiniuModal();
    }
  });
  byId("local-only-data-toggle").addEventListener("change", (event) => {
    state.localOnlyWithData = Boolean(event.target.checked);
    renderLocalMapCards();
  });

  byId("main-nav").addEventListener("click", (event) => {
    const btn = event.target.closest(".nav-btn");
    if (!btn) return;
    switchPanel(btn.dataset.panel);
  });

  byId("collection-tabs").addEventListener("click", (event) => {
    const btn = event.target.closest(".chip");
    if (!btn) return;
    switchCollectionTab(btn.dataset.collection);
  });

  byId("history-list").addEventListener("click", (event) => {
    const btn = event.target.closest(".expand-btn");
    if (!btn) return;
    onHistoryExpandClick(btn);
  });
  byId("local-battle-list").addEventListener("click", (event) => {
    const btn = event.target.closest(".expand-btn");
    if (!btn) return;
    onHistoryExpandClick(btn);
  });

  byId("history-prev-btn").addEventListener("click", () => {
    if (state.historyPage <= 1) return;
    loadHistoryPage(state.historyPage - 1).catch((error) => {
      setStatus(`历史数据加载失败: ${error.message}`, false);
    });
  });

  byId("history-next-btn").addEventListener("click", () => {
    if (byId("history-next-btn").disabled) return;
    loadHistoryPage(state.historyPage + 1).catch((error) => {
      setStatus(`历史数据加载失败: ${error.message}`, false);
    });
  });

  byId("history-mode-select").addEventListener("change", (event) => {
    state.historyFilters.mode = event.target.value || "all";
    state.historyPage = 1;
    loadHistoryPage(1).catch((error) => {
      setStatus(`历史数据加载失败: ${error.message}`, false);
    });
  });

  byId("history-diff-select").addEventListener("change", (event) => {
    state.historyFilters.difficulty = event.target.value || "all";
    state.historyPage = 1;
    renderHistoryList();
  });

  byId("local-battle-prev-btn").addEventListener("click", () => {
    if (state.localBattlePage <= 1) return;
    state.localBattlePage -= 1;
    renderLocalBattleList();
  });
  byId("local-battle-next-btn").addEventListener("click", () => {
    if (byId("local-battle-next-btn").disabled) return;
    state.localBattlePage += 1;
    renderLocalBattleList();
  });
  byId("local-battle-mode-select").addEventListener("change", (event) => {
    state.localBattleFilters.mode = event.target.value || "all";
    state.localBattlePage = 1;
    renderLocalBattleList();
  });
  byId("local-battle-diff-select").addEventListener("change", (event) => {
    state.localBattleFilters.difficulty = event.target.value || "all";
    state.localBattlePage = 1;
    renderLocalBattleList();
  });
  byId("local-battle-map-select").addEventListener("change", (event) => {
    state.localBattleFilters.mapKey = String(event.target.value || "all").trim() || "all";
    state.localBattlePage = 1;
    renderLocalBattleList();
  });

  byId("log-window-toggle").addEventListener("change", async (event) => {
    const nextVisible = Boolean(event.target.checked);
    try {
      const result = await window.nzmApi.setLogWindowVisible(nextVisible);
      setLogToggle(result?.data?.logWindowVisible ?? nextVisible);
    } catch (error) {
      setLogToggle(!nextVisible);
      setStatus(`日志窗口开关失败: ${error.message}`, false);
    }
  });

  window.nzmApi.onLogWindowVisibleChange((visible) => {
    setLogToggle(visible);
  });
  window.nzmApi.onNoticeUpdate((payload) => {
    if (payload?.data) {
      setNoticePayload(payload.data);
    }
    if (payload?.shouldPopup) {
      openNoticeModal(true).catch(() => {});
    }
  });
}

async function loadInitialConfig() {
  setLoading(true);
  try {
    const [endpoints, config] = await Promise.all([
      window.nzmApi.getOfficialEndpoints(),
      window.nzmApi.getSessionConfig()
    ]);

    state.endpoints = endpoints || {};
    state.fixed = config?.data?.fixed || {};
    state.accounts = Array.isArray(config?.data?.accounts) ? config.data.accounts : [];
    state.activeUin = String(config?.data?.activeUin || config?.data?.uin || "").trim();
    state.qiniuConfig =
      config?.data?.qiniuConfig && typeof config.data.qiniuConfig === "object"
        ? config.data.qiniuConfig
        : {};
    renderAccountSelect();
    fillQiniuConfigInputs(state.qiniuConfig);

    const openidFromSession =
      String(config?.data?.openid || config?.data?.fixed?.openid || "").trim();
    if (openidFromSession) {
      byId("openid-input").value = openidFromSession;
    }
    if (config?.data?.accessToken) {
      byId("token-input").value = config.data.accessToken;
    }
    const localToggle = byId("local-only-data-toggle");
    if (localToggle) {
      localToggle.checked = true;
      state.localOnlyWithData = true;
    }
    setLogToggle(Boolean(config?.data?.logWindowVisible));

    renderAllPanels();
    await loadLocalStats();
    const latestNotice = await window.nzmApi.getLatestNotice().catch(() => null);
    setNoticePayload(latestNotice?.data || null);
    await refreshNotice({ autoPopup: false });

    if (config?.data?.hasAccessToken) {
      await refreshAllData();
    } else {
      setStatus("请输入 openid 和 token，保存后会自动加载数据", "info");
    }
  } catch (error) {
    setStatus(`初始化失败: ${error.message}`, false);
  } finally {
    setLoading(false);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  switchPanel("stats");
  switchCollectionTab("weapons");
  await loadInitialConfig();
});

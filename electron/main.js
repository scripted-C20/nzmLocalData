const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const {
  OFFICIAL_ENDPOINTS,
  FIXED_COOKIE_FIELDS,
  buildFixedCookie,
  normalizeCookie,
  setApiLogHandler,
  fetchUserInfo,
  fetchConfigList,
  fetchStats,
  fetchHistory,
  fetchCollection,
  fetchDetail
} = require("./official-api");

const SESSION_FILE = "session.json";
const ACCOUNT_BIND_FILE = "account-binding.json";
const NOTICE_STATE_FILE = "notice-state.json";
const QINIU_CONFIG_FILE = "qiniu-config.json";
const LOCAL_STATS_FILE = "local-stats.json";
const LOCAL_STATS_FILE_PREFIX = "local-stats";
const LEGACY_LOCAL_STATS_FILE_SEPARATOR = "+";
const LOCAL_JSON_TRANSFER_MARK = "本地导出导入";
const LOCAL_RECORD_SOURCE = Object.freeze({
  OFFICIAL: "official-sync",
  JSON_TRANSFER: "json-transfer"
});
const NOTICE_MARKDOWN_URL = "https://gitee.com/returnee/nzm-notice/raw/master/README.md";
const APP_ICON_PATH = path.join(__dirname, "..", "app", "bitbug_favicon.ico");

let currentAccessToken = "";
let currentOpenId = "";
let currentUin = "";
let currentNickname = "";
let currentAvatar = "";
let accountStore = { activeUin: "", accounts: [] };
let logWindow = null;
let logWindowVisible = false;
let mainWindowRef = null;
let latestNoticePayload = null;
let latestConfigMapping = {};
let localStatsRuntime = null;
let qiniuConfigStore = {
  accessKey: "",
  secretKey: "",
  protocol: "https",
  domain: "",
  path: "",
  bucket: "",
  updatedAt: 0
};
const apiLogBuffer = [];

function appendApiLog(entry) {
  const item = {
    ts: Number(entry?.ts) || Date.now(),
    kind: String(entry?.kind || "unknown"),
    payload: entry?.payload ?? {}
  };

  apiLogBuffer.push(item);
  if (apiLogBuffer.length > 300) {
    apiLogBuffer.splice(0, apiLogBuffer.length - 300);
  }

  BrowserWindow.getAllWindows().forEach((window) => {
    try {
      window.webContents.send("api:log", item);
    } catch (_) {
      // no-op
    }
  });
}

function getSessionPath() {
  return path.join(app.getPath("userData"), SESSION_FILE);
}

function getProjectDataRoot() {
  const root = path.join(process.cwd(), "data");
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

function getAccountBindPath() {
  return path.join(getProjectDataRoot(), ACCOUNT_BIND_FILE);
}

function getNoticeStatePath() {
  return path.join(getProjectDataRoot(), NOTICE_STATE_FILE);
}

function getQiniuConfigPath() {
  return path.join(getProjectDataRoot(), QINIU_CONFIG_FILE);
}

function normalizeUin(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const digits = text.replace(/[^\d]/g, "");
  return digits || text;
}

function getLocalStatsFileNameByUin(uin = currentUin) {
  const normalized = normalizeUin(uin);
  if (!normalized) {
    return LOCAL_STATS_FILE;
  }
  // Canonical format: local-stats{uin}.json
  return `${LOCAL_STATS_FILE_PREFIX}${normalized}.json`;
}

function getCompatLegacyUinStatsFileName(uin = currentUin) {
  const normalized = normalizeUin(uin);
  if (!normalized) {
    return LOCAL_STATS_FILE;
  }
  // Compatibility with old format: local-stats+{uin}.json
  return `${LOCAL_STATS_FILE_PREFIX}${LEGACY_LOCAL_STATS_FILE_SEPARATOR}${normalized}.json`;
}

function getLocalStatsPath(uin = currentUin) {
  return path.join(app.getPath("userData"), getLocalStatsFileNameByUin(uin));
}

function getCompatLegacyUinStatsPath(uin = currentUin) {
  return path.join(app.getPath("userData"), getCompatLegacyUinStatsFileName(uin));
}

function getLegacyLocalStatsPath() {
  return path.join(app.getPath("userData"), LOCAL_STATS_FILE);
}

function mergeLegacyRecordList(targetRecords = [], sourceRecords = []) {
  const list = Array.isArray(targetRecords) ? [...targetRecords] : [];
  const seen = new Set(
    list
      .map((item) => String(item?.dsRoomId || "").trim())
      .filter(Boolean)
  );
  if (Array.isArray(sourceRecords)) {
    sourceRecords.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const key = String(item?.dsRoomId || "").trim();
      if (key && seen.has(key)) {
        return;
      }
      if (key) {
        seen.add(key);
      }
      list.push(item);
    });
  }
  return list;
}

function deleteLegacyLocalStatsFileIfSafe() {
  const legacyPath = getLegacyLocalStatsPath();
  if (!fs.existsSync(legacyPath)) {
    return false;
  }
  const resolvedLegacy = path.resolve(legacyPath);
  const resolvedUserData = path.resolve(app.getPath("userData"));
  const userDataFolderName = path.basename(resolvedUserData).toLowerCase();
  if (path.dirname(resolvedLegacy) !== resolvedUserData) {
    return false;
  }
  if (!userDataFolderName.includes("nzm-official-electron")) {
    return false;
  }
  if (path.basename(resolvedLegacy).toLowerCase() !== LOCAL_STATS_FILE.toLowerCase()) {
    return false;
  }
  try {
    fs.unlinkSync(resolvedLegacy);
    return true;
  } catch (_) {
    return false;
  }
}

function safeDecode(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function normalizeAccountEntry(entry = {}) {
  const uin = normalizeUin(entry?.uin);
  if (!uin) {
    return null;
  }
  return {
    uin,
    openid: normalizeOpenId(entry?.openid),
    accessToken: String(entry?.accessToken || entry?.token || "").trim(),
    nickname: safeDecode(entry?.nickname),
    avatar: String(entry?.avatar || "").trim(),
    updatedAt: Number(entry?.updatedAt) || Date.now()
  };
}

function normalizeAccountStore(raw = {}) {
  const accountList = [];
  const seen = new Set();

  if (Array.isArray(raw?.accounts)) {
    raw.accounts.forEach((item) => {
      const normalized = normalizeAccountEntry(item);
      if (!normalized || seen.has(normalized.uin)) {
        return;
      }
      seen.add(normalized.uin);
      accountList.push(normalized);
    });
  }

  const legacy = normalizeAccountEntry({
    uin: raw?.uin,
    openid: raw?.openid,
    accessToken: raw?.accessToken || raw?.token,
    nickname: raw?.nickname,
    avatar: raw?.avatar,
    updatedAt: raw?.updatedAt
  });
  if (legacy && !seen.has(legacy.uin)) {
    seen.add(legacy.uin);
    accountList.push(legacy);
  }

  let activeUin = normalizeUin(raw?.activeUin);
  if (!activeUin || !accountList.find((x) => x.uin === activeUin)) {
    activeUin = accountList[0]?.uin || "";
  }

  return {
    activeUin,
    accounts: accountList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  };
}

function getPublicAccounts() {
  return (accountStore?.accounts || []).map((item) => ({
    uin: item.uin,
    openid: item.openid,
    nickname: item.nickname || "",
    avatar: item.avatar || "",
    updatedAt: item.updatedAt || 0,
    hasAccessToken: Boolean(item.accessToken)
  }));
}

function applyCurrentAccountByUin(uin) {
  const target = (accountStore?.accounts || []).find((item) => item.uin === normalizeUin(uin));
  if (!target) {
    return false;
  }
  currentUin = target.uin;
  currentOpenId = normalizeOpenId(target.openid);
  currentAccessToken = String(target.accessToken || "").trim();
  currentNickname = String(target.nickname || "").trim();
  currentAvatar = String(target.avatar || "").trim();
  accountStore.activeUin = currentUin;
  localStatsRuntime = null;
  ensureLocalStatsStoreFile();
  return true;
}

function ensureDirByFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDirByFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function pickFirst(data, keys, fallback = "") {
  for (const key of keys) {
    const value = data?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return fallback;
}

function toPositiveInt(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    return 0;
  }
  const num = Number(text);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function toTimestamp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (/^\d{10}$/.test(raw)) {
    return Number(raw) * 1000;
  }
  if (/^\d{13}$/.test(raw)) {
    return Number(raw);
  }
  const ts = Date.parse(raw.replace(" ", "T"));
  return Number.isFinite(ts) ? ts : 0;
}

function getConfigRoot(configMapping) {
  if (!configMapping || typeof configMapping !== "object") {
    return {};
  }
  if (configMapping.config && typeof configMapping.config === "object") {
    return configMapping.config;
  }
  return configMapping;
}

function getMapModeText(node, modeInfo) {
  if (!node || typeof node !== "object") {
    return "";
  }

  const directText = String(
    pickFirst(node, ["mode", "modeName", "sModeName", "typeName", "sTypeName"], "")
  ).trim();
  if (directText && !/^\d+$/.test(directText)) {
    return directText;
  }

  const modeId = String(
    pickFirst(node, ["modeType", "iModeType", "modeID", "modeId", "mode"], "")
  ).trim();
  if (!modeId) {
    return "";
  }

  const modeNode = modeInfo?.[modeId];
  const modeText = String(
    pickFirst(modeNode, ["modeName", "name", "title", "displayName"], "")
  ).trim();
  if (modeText) {
    return modeText;
  }
  return mapModeTypeToName(modeId);
}

function mapModeTypeToName(value) {
  const modeType = String(value || "").trim();
  if (!modeType) return "";
  if (modeType === "139") return "塔防";
  if (modeType === "134") return "猎场";
  if (modeType === "136") return "时空追猎";
  if (modeType === "65") return "排位";
  return "";
}

function normalizeModeName(text) {
  const raw = String(text || "").trim();
  const byType = mapModeTypeToName(raw);
  if (byType) return byType;
  if (!raw) return "未知";
  if (raw.includes("塔防")) return "塔防";
  if (raw.includes("猎场") || raw.includes("僵尸")) return "猎场";
  if (raw.includes("时空") || raw.includes("追猎")) return "时空追猎";
  if (raw.includes("机甲") || raw.includes("排位")) return "排位";
  return raw;
}

function inferModeNameFromGame(game) {
  const modeType = String(
    pickFirst(game, ["iModeType", "modeType", "iGameMode", "gameMode", "iMode"], "")
  ).trim();
  const modeByType = mapModeTypeToName(modeType);
  if (modeByType) {
    return modeByType;
  }
  const direct = pickFirst(
    game,
    ["modeName", "sModeName", "sTypeName", "mode", "sBattleType", "sGameName"],
    ""
  );
  return normalizeModeName(direct);
}

function resolveRawModeNameFromGame(game, mapNode = null) {
  const direct = String(
    pickFirst(game, ["modeName", "sModeName", "sTypeName", "mode", "sBattleType", "sGameName"], "")
  ).trim();
  if (direct && direct !== "未知") {
    return direct;
  }

  const mappedRaw = String(mapNode?.rawModeName || mapNode?.modeName || "").trim();
  if (mappedRaw) {
    return mappedRaw;
  }

  const inferred = inferModeNameFromGame(game);
  return inferred && inferred !== "未知" ? inferred : "";
}

function shouldUpgradeStoredModeName(currentMode, nextMode) {
  const currentRaw = String(currentMode || "").trim();
  const nextRaw = String(nextMode || "").trim();
  if (!nextRaw || nextRaw === "未知") {
    return false;
  }
  if (!currentRaw || currentRaw === "未知") {
    return true;
  }
  if (currentRaw === nextRaw) {
    return false;
  }
  const normalizedCurrent = normalizeModeName(currentRaw);
  const normalizedNext = normalizeModeName(nextRaw);
  // Category mismatch means stored mode is wrong (e.g. 塔防 -> 猎场竞速), force overwrite.
  if (normalizedCurrent !== normalizedNext && normalizedNext !== "未知") {
    return true;
  }
  if (normalizedCurrent === normalizedNext && nextRaw.length > currentRaw.length) {
    return true;
  }
  const genericModes = new Set(["猎场", "塔防", "时空追猎", "排位", "僵尸猎场"]);
  if (genericModes.has(currentRaw) && !genericModes.has(nextRaw)) {
    return true;
  }
  return false;
}

function normalizeDifficultyName(text) {
  const raw = String(text || "").trim();
  if (!raw) return "未知难度";
  if (raw.includes("炼狱")) return "炼狱";
  if (
    raw === "折磨" ||
    /折磨\s*(?:I|1|Ⅰ)$/i.test(raw) ||
    /折磨\s*(?:I|1|Ⅰ)\b/i.test(raw)
  ) {
    return "折磨I";
  }
  return raw;
}

function normalizeLocalRecordSource(value, fallback = LOCAL_RECORD_SOURCE.OFFICIAL) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  const lower = raw.toLowerCase();
  if (
    lower === LOCAL_RECORD_SOURCE.JSON_TRANSFER ||
    lower === "json-import" ||
    lower === "json_import" ||
    lower === "local-export-import" ||
    lower === "local-json" ||
    raw === LOCAL_JSON_TRANSFER_MARK
  ) {
    return LOCAL_RECORD_SOURCE.JSON_TRANSFER;
  }
  if (
    lower === LOCAL_RECORD_SOURCE.OFFICIAL ||
    lower === "official" ||
    lower === "api" ||
    raw === "历史战绩同步"
  ) {
    return LOCAL_RECORD_SOURCE.OFFICIAL;
  }
  return fallback;
}

function buildMapLookup(configMapping) {
  const root = getConfigRoot(configMapping);
  const mapInfo =
    root?.mapInfo && typeof root.mapInfo === "object" ? root.mapInfo : {};
  const modeInfo =
    root?.modeInfo && typeof root.modeInfo === "object"
      ? root.modeInfo
      : root?.modeTypeInfo && typeof root.modeTypeInfo === "object"
        ? root.modeTypeInfo
        : {};

  const byId = new Map();
  const byName = new Map();

  Object.entries(mapInfo).forEach(([mapId, node]) => {
    const mapIdText = String(mapId || "").trim();
    if (!mapIdText) return;
    const mapName = String(
      pickFirst(node, ["mapName", "sMapName", "name", "title", "displayName"], `地图${mapIdText}`)
    ).trim();
    const rawModeName = String(getMapModeText(node, modeInfo) || "").trim();
    const modeName = normalizeModeName(rawModeName);
    const item = {
      mapId: toPositiveInt(mapIdText) || 0,
      mapName: mapName || `地图${mapIdText}`,
      modeName,
      rawModeName,
      icon: String(
        pickFirst(node, ["icon", "sIcon", "mapImg", "sMapImg", "pic", "picUrl"], "")
      ).trim()
    };
    byId.set(mapIdText, item);
    const nameKey = item.mapName;
    if (!byName.has(nameKey)) {
      byName.set(nameKey, []);
    }
    byName.get(nameKey).push(item);
  });

  return { byId, byName };
}

function pickMapByName(mapLookup, mapName, modeHint = "") {
  const list = mapLookup?.byName?.get(mapName) || [];
  if (!list.length) {
    return null;
  }
  const rawHint = String(modeHint || "").trim();
  if (rawHint) {
    const exactRaw = list.find((x) => String(x.rawModeName || "").trim() === rawHint);
    if (exactRaw) return exactRaw;
  }
  const modeText = normalizeModeName(modeHint);
  if (modeText && modeText !== "未知") {
    const exact = list.find((x) => normalizeModeName(x.modeName) === modeText);
    if (exact) return exact;
  }
  const towerFirst = list.find((x) => normalizeModeName(x.modeName) === "塔防");
  if (towerFirst) return towerFirst;
  const huntFirst = list.find((x) => normalizeModeName(x.modeName) === "猎场");
  if (huntFirst) return huntFirst;
  return list[0];
}

function loadLocalStatsStore() {
  const filePath = getLocalStatsPath();
  let raw = readJsonFile(filePath, null);
  const normalizedUin = normalizeUin(currentUin);
  const legacyPath = getLegacyLocalStatsPath();
  const legacySameAsCurrent = path.resolve(legacyPath) === path.resolve(filePath);
  let shouldDeleteLegacyFile = false;

  if (!raw && normalizedUin) {
    const compatLegacyUinPath = getCompatLegacyUinStatsPath(normalizedUin);
    const compatLegacyUinStore = readJsonFile(compatLegacyUinPath, null);
    if (compatLegacyUinStore && typeof compatLegacyUinStore === "object") {
      raw = {
        ...compatLegacyUinStore,
        uin: normalizeUin(compatLegacyUinStore?.uin) || normalizedUin
      };
      writeJsonFile(filePath, raw);
    }
  }

  if (normalizedUin && !legacySameAsCurrent) {
    const legacyStore = readJsonFile(legacyPath, null);
    if (legacyStore && typeof legacyStore === "object") {
      const legacyRecords = Array.isArray(legacyStore?.records) ? legacyStore.records : [];
      shouldDeleteLegacyFile = true;
      if (legacyRecords.length > 0) {
        if (!raw || typeof raw !== "object") {
          raw = {};
        }
        raw.records = mergeLegacyRecordList(raw?.records, legacyRecords);
        raw.uin = normalizeUin(raw?.uin) || normalizedUin;
        raw.updatedAt = Date.now();
        writeJsonFile(filePath, raw);
      }
    }
  }

  if (shouldDeleteLegacyFile) {
    deleteLegacyLocalStatsFileIfSafe();
  }

  if (!raw || typeof raw !== "object") {
    raw = {};
  }
  const records = Array.isArray(raw?.records)
    ? raw.records
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          dsRoomId: String(item.dsRoomId || "").trim(),
          mapName: String(item.mapName || "").trim() || "未知地图",
          mapId: toPositiveInt(item.mapId) || 0,
          diffName: normalizeDifficultyName(item.diffName),
          eventTime: String(item.eventTime || "").trim(),
          startTime: String(pickFirst(item, ["startTime", "dtGameStartTime"], "")).trim(),
          score: toPositiveInt(pickFirst(item, ["score", "iScore"], 0)) || 0,
          duration:
            toPositiveInt(
              pickFirst(item, ["duration", "iDuration", "iUseTime", "useTime", "costTime"], 0)
            ) || 0,
          isWin: Number(item.isWin) === 1 ? 1 : 0,
          modeName: String(item.modeName || "").trim() || "未知",
          sourceType: normalizeLocalRecordSource(
            pickFirst(item, ["sourceType", "recordSource", "dataSource", "source"], ""),
            LOCAL_RECORD_SOURCE.OFFICIAL
          )
        }))
        .filter((item) => item.dsRoomId)
    : [];
  const manual = Array.isArray(raw?.manual)
    ? raw.manual
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: String(item.id || "").trim(),
          mapName: String(item.mapName || "").trim() || "未知地图",
          mapId: toPositiveInt(item.mapId) || 0,
          diffName: normalizeDifficultyName(item.diffName),
          modeName: String(item.modeName || "").trim() || "未知",
          batchIndex: toPositiveInt(item.batchIndex) || 1,
          count: toPositiveInt(item.count) || 0,
          winCount: toPositiveInt(item.winCount) || toPositiveInt(item.count) || 0,
          eventTime: String(item.eventTime || "").trim(),
          source: String(item.source || "xlsx")
        }))
        .filter((item) => item.id && item.count > 0)
    : [];

  const maxBatch = manual.reduce(
    (max, item) => Math.max(max, toPositiveInt(item.batchIndex) || 0),
    0
  );
  const importCounter = Math.max(toPositiveInt(raw?.importCounter) || 0, maxBatch);

  return {
    uin: normalizeUin(raw?.uin) || normalizeUin(currentUin) || "",
    version: 3,
    updatedAt: Number(raw?.updatedAt) || 0,
    records,
    manual,
    importCounter
  };
}

function saveLocalStatsStore(store) {
  const filePath = getLocalStatsPath();
  writeJsonFile(filePath, {
    uin: normalizeUin(store?.uin) || normalizeUin(currentUin) || "",
    version: 3,
    updatedAt: Number(store?.updatedAt) || Date.now(),
    records: Array.isArray(store?.records) ? store.records : [],
    manual: Array.isArray(store?.manual) ? store.manual : [],
    importCounter: toPositiveInt(store?.importCounter) || 0
  });
}

function ensureLocalStatsStoreFile() {
  const filePath = getLocalStatsPath();
  if (fs.existsSync(filePath)) {
    return;
  }
  saveLocalStatsStore({
    uin: normalizeUin(currentUin) || "",
    version: 3,
    updatedAt: Date.now(),
    records: [],
    manual: [],
    importCounter: 0
  });
}

function buildAggKey(modeName, mapId, mapName) {
  return `${modeName}|${mapId || 0}|${mapName || "未知地图"}`;
}

function buildRuntimeFromStore(store) {
  const idSet = new Set();
  const aggMap = new Map();

  const applyAgg = (record, totalCount, winCount, source, batchIndex = 0) => {
    const normalizedMode = normalizeModeName(record?.modeName);
    const modeName = normalizedMode;
    if (modeName !== "猎场" && modeName !== "塔防") {
      return;
    }
    const mapId = toPositiveInt(record?.mapId) || 0;
    const mapName = String(record?.mapName || "未知地图").trim() || "未知地图";
    const diffName = normalizeDifficultyName(record?.diffName);
    const key = buildAggKey(modeName, mapId, mapName);

    if (!aggMap.has(key)) {
      aggMap.set(key, {
        mapId,
        mapName,
        modeName,
        total: 0,
        win: 0,
        localTotal: 0,
        localWin: 0,
        importTotal: 0,
        importWin: 0,
        lastTime: "",
        lastTs: 0,
        diffMap: new Map(),
        batchMap: new Map()
      });
    }
    const item = aggMap.get(key);
    item.total += totalCount;
    item.win += winCount;
    if (source === "manual") {
      item.importTotal += totalCount;
      item.importWin += winCount;
      const batch = toPositiveInt(batchIndex) || 0;
      if (batch > 0) {
        if (!item.batchMap.has(batch)) {
          item.batchMap.set(batch, { batchIndex: batch, total: 0, win: 0 });
        }
        const batchItem = item.batchMap.get(batch);
        batchItem.total += totalCount;
        batchItem.win += winCount;
      }
    } else {
      item.localTotal += totalCount;
      item.localWin += winCount;
    }
    const ts = toTimestamp(record?.eventTime);
    if (ts >= item.lastTs) {
      item.lastTs = ts;
      item.lastTime = String(record?.eventTime || "");
    }
    if (!item.diffMap.has(diffName)) {
      item.diffMap.set(diffName, { diffName, total: 0, win: 0, localTotal: 0, importTotal: 0 });
    }
    const diffItem = item.diffMap.get(diffName);
    diffItem.total += totalCount;
    diffItem.win += winCount;
    if (source === "manual") {
      diffItem.importTotal += totalCount;
    } else {
      diffItem.localTotal += totalCount;
    }
  };

  (store?.records || []).forEach((record) => {
    idSet.add(record.dsRoomId);
    applyAgg(record, 1, Number(record.isWin) === 1 ? 1 : 0, "record");
  });
  (store?.manual || []).forEach((entry) => {
    applyAgg(
      entry,
      entry.count,
      Math.min(entry.winCount, entry.count),
      "manual",
      entry.batchIndex
    );
  });

  return { store, idSet, aggMap };
}

function ensureLocalRuntime() {
  if (localStatsRuntime) {
    return localStatsRuntime;
  }
  localStatsRuntime = buildRuntimeFromStore(loadLocalStatsStore());
  return localStatsRuntime;
}

function buildLocalMapStatsFromRuntime(configMapping = {}) {
  const runtime = ensureLocalRuntime();
  const mapLookup = buildMapLookup(configMapping);

  const maps = [...runtime.aggMap.values()]
    .map((item) => {
      const diffList = [...item.diffMap.values()]
        .map((diff) => ({
          diffName: diff.diffName,
          total: diff.total,
          win: diff.win,
          rate: Number(((diff.win / Math.max(1, diff.total)) * 100).toFixed(1))
        }))
        .sort((a, b) => b.total - a.total);

      const mapById = mapLookup.byId.get(String(item.mapId || ""));
      const importBatches = [...item.batchMap.values()]
        .map((batch) => ({
          batchIndex: batch.batchIndex,
          total: batch.total,
          win: batch.win,
          rate: Number(((batch.win / Math.max(1, batch.total)) * 100).toFixed(1))
        }))
        .sort((a, b) => b.batchIndex - a.batchIndex);
      return {
        mapId: item.mapId,
        mapName: item.mapName,
        modeName: item.modeName,
        icon: mapById?.icon || "",
        total: item.total,
        win: item.win,
        localTotal: item.localTotal || 0,
        localWin: item.localWin || 0,
        importTotal: item.importTotal || 0,
        importWin: item.importWin || 0,
        rate: Number(((item.win / Math.max(1, item.total)) * 100).toFixed(1)),
        localRate: Number((((item.localWin || 0) / Math.max(1, item.localTotal || 0)) * 100).toFixed(1)),
        importRate: Number((((item.importWin || 0) / Math.max(1, item.importTotal || 0)) * 100).toFixed(1)),
        lastTime: item.lastTime,
        difficulties: diffList,
        importBatches
      };
    })
    .sort((a, b) => {
      if (b.total !== a.total) {
        return b.total - a.total;
      }
      return toTimestamp(b.lastTime) - toTimestamp(a.lastTime);
    });

  const manualRows = runtime.store.manual.reduce((sum, item) => sum + (item.count || 0), 0);
  return {
    totalRecords: runtime.store.records.length,
    manualRows,
    maps
  };
}

function buildLocalRecordListFromRuntime(runtimeInput = null) {
  const runtime = runtimeInput && typeof runtimeInput === "object" ? runtimeInput : ensureLocalRuntime();
  const list = Array.isArray(runtime?.store?.records) ? runtime.store.records : [];
  return [...list]
    .filter((item) => {
      const roomId = String(item?.dsRoomId || "").trim();
      // Template import should not appear in "本地战绩"; also filter legacy manual-like ids.
      if (!roomId || roomId.startsWith("manual:")) {
        return false;
      }
      return true;
    })
    .map((item) => ({
      ...item,
      roomID: String(item?.dsRoomId || "").trim(),
      iIsWin: Number(item?.isWin) === 1 ? 1 : 0,
      iScore: toPositiveInt(item?.score) || 0,
      iDuration: toPositiveInt(item?.duration) || 0,
      dtGameStartTime: String(item?.startTime || "").trim(),
      dtEventTime: String(item?.eventTime || "").trim()
    }))
    .sort((a, b) => toTimestamp(b?.eventTime) - toTimestamp(a?.eventTime));
}

function normalizeLocalGameRecord(game, configMapping, prepared = null) {
  if (!game || typeof game !== "object") {
    return null;
  }

  const dsRoomId = String(
    pickFirst(game, ["DsRoomId", "dsRoomId", "sRoomID", "roomID", "roomId", "roomid"], "")
  ).trim();
  if (!dsRoomId) {
    return null;
  }

  const root = prepared?.root || getConfigRoot(configMapping);
  const mapLookup = prepared?.mapLookup || buildMapLookup(root);
  const difficultyInfo =
    prepared?.difficultyInfo ||
    (root?.difficultyInfo && typeof root.difficultyInfo === "object"
      ? root.difficultyInfo
      : {});

  const mapIdRaw = String(
    pickFirst(game, ["iMapId", "mapId", "mapID", "iMapID", "map_id"], "")
  ).trim();
  const mapId = toPositiveInt(mapIdRaw);
  const mapNode = mapLookup.byId.get(mapIdRaw || "");
  const modeName = resolveRawModeNameFromGame(game, mapNode) || "未知";

  const mapName = String(
    pickFirst(
      game,
      ["mapName", "sMapName", "map", "mapTitle", "sRoomName"],
      mapNode?.mapName || "未知地图"
    )
  ).trim();

  const diffIdRaw = String(
    pickFirst(game, ["iSubModeType", "subModeType", "iDiffId", "difficultyId", "iDifficulty"], "")
  ).trim();
  const diffNode = diffIdRaw ? difficultyInfo?.[diffIdRaw] : null;
  const diffName = normalizeDifficultyName(
    pickFirst(
      game,
      ["diffName", "difficultyName", "sDiffName", "difficulty", "diff"],
      pickFirst(diffNode, ["diffName", "difficultyName", "name", "title", "displayName"], "未知难度")
    )
  );

  const eventTime = String(
    pickFirst(game, ["dtEventTime", "dtGameStartTime", "sGameTime", "time", "eventTime"], "")
  ).trim();
  const startTime = String(
    pickFirst(game, ["dtGameStartTime", "startTime", "gameStartTime"], "")
  ).trim();
  const score = toPositiveInt(pickFirst(game, ["iScore", "score"], 0)) || 0;
  const duration =
    toPositiveInt(pickFirst(game, ["iDuration", "iUseTime", "duration", "useTime", "costTime"], 0)) ||
    0;

  const isWin = Number(pickFirst(game, ["iIsWin", "isWin"], 0)) === 1 ? 1 : 0;
  const sourceType = normalizeLocalRecordSource(
    pickFirst(game, ["sourceType", "recordSource", "dataSource", "source"], ""),
    LOCAL_RECORD_SOURCE.OFFICIAL
  );

  return {
    dsRoomId,
    mapName: mapName || "未知地图",
    mapId: mapId > 0 ? mapId : 0,
    diffName: diffName || "未知难度",
    eventTime,
    startTime,
    score,
    duration,
    isWin,
    modeName,
    sourceType
  };
}

function mergeLocalStats(games, configMapping) {
  if (configMapping && typeof configMapping === "object") {
    latestConfigMapping = configMapping;
  }
  remapStoredModeByConfig(latestConfigMapping);
  const runtime = ensureLocalRuntime();
  const root = getConfigRoot(latestConfigMapping);
  const prepared = {
    root,
    mapLookup: buildMapLookup(root),
    difficultyInfo:
      root?.difficultyInfo && typeof root.difficultyInfo === "object"
        ? root.difficultyInfo
        : {}
  };
  let inserted = 0;
  let upgraded = 0;
  if (Array.isArray(games)) {
    games.forEach((game) => {
      const record = normalizeLocalGameRecord(game, latestConfigMapping, prepared);
      if (!record) {
        return;
      }
      const key = String(record.dsRoomId);
      if (runtime.idSet.has(key)) {
        const existing = runtime.store.records.find((x) => String(x?.dsRoomId || "") === key);
        if (existing) {
          let changed = false;
          if (shouldUpgradeStoredModeName(existing.modeName, record.modeName)) {
            existing.modeName = String(record.modeName || "").trim() || existing.modeName;
            changed = true;
          }
          const nextScore = toPositiveInt(record?.score) || 0;
          const prevScore = toPositiveInt(existing?.score) || 0;
          if (nextScore > 0 && nextScore !== prevScore) {
            existing.score = nextScore;
            changed = true;
          }
          const nextStartTime = String(record?.startTime || "").trim();
          const prevStartTime = String(existing?.startTime || "").trim();
          if (nextStartTime && nextStartTime !== prevStartTime) {
            existing.startTime = nextStartTime;
            changed = true;
          }
          const nextDuration = toPositiveInt(record?.duration) || 0;
          const prevDuration = toPositiveInt(existing?.duration) || 0;
          if (nextDuration > 0 && nextDuration !== prevDuration) {
            existing.duration = nextDuration;
            changed = true;
          }
          if (!String(existing?.eventTime || "").trim() && String(record?.eventTime || "").trim()) {
            existing.eventTime = String(record.eventTime || "").trim();
            changed = true;
          }
          const nextSource = normalizeLocalRecordSource(
            record?.sourceType,
            LOCAL_RECORD_SOURCE.OFFICIAL
          );
          const prevSource = normalizeLocalRecordSource(
            existing?.sourceType,
            LOCAL_RECORD_SOURCE.OFFICIAL
          );
          // Keep stronger source label when importing from JSON transfer.
          if (
            nextSource === LOCAL_RECORD_SOURCE.JSON_TRANSFER &&
            prevSource !== LOCAL_RECORD_SOURCE.JSON_TRANSFER
          ) {
            existing.sourceType = LOCAL_RECORD_SOURCE.JSON_TRANSFER;
            changed = true;
          }
          if (changed) {
            upgraded += 1;
          }
        }
        return;
      }
      runtime.idSet.add(key);
      runtime.store.records.push(record);
      const modeName = normalizeModeName(record.modeName);
      if (modeName === "猎场" || modeName === "塔防") {
        const aggKey = buildAggKey(modeName, record.mapId || 0, record.mapName || "未知地图");
        if (!runtime.aggMap.has(aggKey)) {
          runtime.aggMap.set(aggKey, {
            mapId: record.mapId || 0,
            mapName: record.mapName || "未知地图",
            modeName,
            total: 0,
            win: 0,
            localTotal: 0,
            localWin: 0,
            importTotal: 0,
            importWin: 0,
            lastTime: "",
            lastTs: 0,
            diffMap: new Map(),
            batchMap: new Map()
          });
        }
        const item = runtime.aggMap.get(aggKey);
        item.total += 1;
        item.win += Number(record.isWin) === 1 ? 1 : 0;
        item.localTotal += 1;
        item.localWin += Number(record.isWin) === 1 ? 1 : 0;
        const ts = toTimestamp(record.eventTime);
        if (ts >= item.lastTs) {
          item.lastTs = ts;
          item.lastTime = record.eventTime || "";
        }
        const diffName = normalizeDifficultyName(record.diffName);
        if (!item.diffMap.has(diffName)) {
          item.diffMap.set(diffName, {
            diffName,
            total: 0,
            win: 0,
            localTotal: 0,
            importTotal: 0
          });
        }
        const diff = item.diffMap.get(diffName);
        diff.total += 1;
        diff.win += Number(record.isWin) === 1 ? 1 : 0;
        diff.localTotal += 1;
      }
      inserted += 1;
    });
  }

  if (inserted > 0 || upgraded > 0) {
    runtime.store.records.sort((a, b) => toTimestamp(b.eventTime) - toTimestamp(a.eventTime));
    runtime.store.updatedAt = Date.now();
    saveLocalStatsStore(runtime.store);
  }

  return {
    inserted,
    upgraded,
    totalRecords: runtime.store.records.length,
    localMapStats: buildLocalMapStatsFromRuntime(latestConfigMapping),
    localRecords: buildLocalRecordListFromRuntime(runtime),
    localStatsPath: getLocalStatsPath()
  };
}

function remapStoredModeByConfig(configMapping) {
  const runtime = ensureLocalRuntime();
  const mapLookup = buildMapLookup(configMapping);
  let changed = 0;

  const resolveByStored = (mapId, mapName, currentMode) => {
    const current = normalizeModeName(currentMode);
    const mapIdText = String(mapId || "").trim();
    if (mapIdText) {
      const byId = mapLookup.byId.get(mapIdText);
      const byIdMode = normalizeModeName(byId?.modeName || "");
      if (byIdMode === "猎场" || byIdMode === "塔防") {
        return byIdMode;
      }
    }
    const list = mapLookup.byName.get(String(mapName || "").trim()) || [];
    if (list.length === 1) {
      const uniqueMode = normalizeModeName(list[0]?.modeName || "");
      if (uniqueMode === "猎场" || uniqueMode === "塔防") {
        return uniqueMode;
      }
    }
    if (current === "猎场" || current === "塔防") {
      return current;
    }
    return current;
  };

  runtime.store.records.forEach((record) => {
    const nextMode = resolveByStored(record?.mapId, record?.mapName, record?.modeName);
    if (nextMode !== normalizeModeName(record?.modeName)) {
      record.modeName = nextMode;
      changed += 1;
    }
  });

  runtime.store.manual.forEach((entry) => {
    const nextMode = resolveByStored(entry?.mapId, entry?.mapName, entry?.modeName);
    if (nextMode !== normalizeModeName(entry?.modeName)) {
      entry.modeName = nextMode;
      changed += 1;
    }
  });

  if (changed > 0) {
    runtime.store.updatedAt = Date.now();
    localStatsRuntime = buildRuntimeFromStore(runtime.store);
    saveLocalStatsStore(localStatsRuntime.store);
  }
}

function clearLocalStats() {
  localStatsRuntime = {
    store: {
      uin: normalizeUin(currentUin) || "",
      version: 3,
      updatedAt: Date.now(),
      records: [],
      manual: [],
      importCounter: 0
    },
    idSet: new Set(),
    aggMap: new Map()
  };
  saveLocalStatsStore(localStatsRuntime.store);
  return {
    success: true,
    data: {
      localMapStats: buildLocalMapStatsFromRuntime(latestConfigMapping),
      localStatsMeta: {
        uin: normalizeUin(currentUin) || "",
        inserted: 0,
        totalRecords: 0,
        path: getLocalStatsPath()
      }
    }
  };
}

function clearImportedStats() {
  const runtime = ensureLocalRuntime();
  runtime.store.manual = [];
  runtime.store.importCounter = 0;
  runtime.store.updatedAt = Date.now();
  localStatsRuntime = buildRuntimeFromStore(runtime.store);
  saveLocalStatsStore(localStatsRuntime.store);
  const localMapStats = buildLocalMapStatsFromRuntime(latestConfigMapping);
  return {
    success: true,
    data: {
      localMapStats,
      localStatsMeta: {
        uin: normalizeUin(currentUin) || "",
        totalRecords: Number(localMapStats?.totalRecords) || 0,
        manualRows: Number(localMapStats?.manualRows) || 0,
        path: getLocalStatsPath()
      }
    }
  };
}

function clearImportedStatsByMap(payload = {}) {
  const modeName = normalizeModeName(payload?.modeName);
  const mapId = toPositiveInt(payload?.mapId) || 0;
  const batchIndex = toPositiveInt(payload?.batchIndex) || 0;
  const mapName = String(payload?.mapName || "").trim();
  if (!mapName) {
    return { success: false, message: "mapName is required" };
  }
  if (modeName !== "猎场" && modeName !== "塔防") {
    return { success: false, message: "modeName is required" };
  }

  const runtime = ensureLocalRuntime();
  const before = runtime.store.manual.length;
  runtime.store.manual = runtime.store.manual.filter((item) => {
    const sameMode = normalizeModeName(item.modeName) === modeName;
    const currentMapId = toPositiveInt(item.mapId) || 0;
    const sameMapId = mapId > 0 && currentMapId === mapId;
    const sameMapName = String(item.mapName || "").trim() === mapName;
    const sameBatch = batchIndex > 0 ? toPositiveInt(item.batchIndex) === batchIndex : true;
    if (sameMode && sameBatch && (sameMapId || sameMapName)) {
      return false;
    }
    return true;
  });
  const removed = before - runtime.store.manual.length;
  if (!runtime.store.manual.length) {
    runtime.store.importCounter = 0;
  }
  runtime.store.updatedAt = Date.now();
  localStatsRuntime = buildRuntimeFromStore(runtime.store);
  saveLocalStatsStore(localStatsRuntime.store);
  const localMapStats = buildLocalMapStatsFromRuntime(latestConfigMapping);

  return {
    success: true,
    message:
      removed > 0
        ? batchIndex > 0
          ? `已清除第${batchIndex}次导入数据 ${removed} 条`
          : `已清除导入数据 ${removed} 条`
        : batchIndex > 0
          ? `当前卡片无第${batchIndex}次导入数据`
          : "当前卡片无导入数据",
    data: {
      removed,
      localMapStats,
      localStatsMeta: {
        uin: normalizeUin(currentUin) || "",
        totalRecords: Number(localMapStats?.totalRecords) || 0,
        manualRows: Number(localMapStats?.manualRows) || 0,
        path: getLocalStatsPath()
      }
    }
  };
}

function parseCount(value) {
  const count = toPositiveInt(value);
  return count > 0 ? count : 0;
}

function getXlsxModule() {
  try {
    return require("xlsx");
  } catch (_) {
    throw new Error("缺少依赖 xlsx，请先执行 npm install");
  }
}

function readXlsxRows(filePath) {
  const xlsx = getXlsxModule();
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) {
    return [];
  }
  const sheet = workbook.Sheets[firstSheetName];
  return xlsx.utils.sheet_to_json(sheet, { defval: "" });
}

function readRowUin(row = {}) {
  const raw = String(
    pickFirst(row, ["uin", "UIN", "账号UIN", "账号uin", "账号", "用户UIN"], "")
  ).trim();
  return normalizeUin(raw.replace(/^'+/, ""));
}

function formatUinForSheet(uin) {
  const normalized = normalizeUin(uin);
  if (!normalized) {
    return "";
  }
  // Prefix apostrophe to keep long numeric uin as text in Excel.
  return `'${normalized}`;
}

function ensureRowsUinMatch(rows = [], expectedUin = "") {
  const target = normalizeUin(expectedUin);
  if (!target) {
    return;
  }
  const uinList = (Array.isArray(rows) ? rows : [])
    .map((row) => readRowUin(row))
    .filter(Boolean);
  if (!uinList.length) {
    throw new Error("导入文件缺少 uin 字段");
  }
  const invalid = uinList.find((uin) => uin !== target);
  if (invalid) {
    throw new Error(`导入文件 uin(${invalid}) 与当前账号(${target})不一致`);
  }
}

function buildTemplateRowsFromConfig(configMapping = {}, options = {}) {
  const root = getConfigRoot(configMapping);
  const expectedUin = normalizeUin(options?.uin || currentUin);
  const mapInfo =
    root?.mapInfo && typeof root.mapInfo === "object" ? root.mapInfo : {};
  const difficultyInfo =
    root?.difficultyInfo && typeof root.difficultyInfo === "object"
      ? root.difficultyInfo
      : {};
  const modeInfo =
    root?.modeInfo && typeof root.modeInfo === "object"
      ? root.modeInfo
      : root?.modeTypeInfo && typeof root.modeTypeInfo === "object"
        ? root.modeTypeInfo
        : {};

  const maps = Object.entries(mapInfo)
    .map(([mapId, node]) => {
      const mapIdText = String(mapId || "").trim();
      const mapName = String(
        pickFirst(node, ["mapName", "sMapName", "name", "title", "displayName"], "")
      ).trim();
      const modeName = String(getMapModeText(node, modeInfo) || "").trim();
      if (!mapName) {
        return null;
      }
      return {
        mapId: mapIdText,
        mapName,
        modeName
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const nameCompare = a.mapName.localeCompare(b.mapName, "zh-CN");
      if (nameCompare !== 0) return nameCompare;
      return String(a.modeName || "").localeCompare(String(b.modeName || ""), "zh-CN");
    });

  const diffSet = new Set();
  Object.values(difficultyInfo).forEach((node) => {
    const diffName = normalizeDifficultyName(
      pickFirst(node, ["diffName", "difficultyName", "name", "title", "displayName"], "")
    );
    if (diffName) {
      diffSet.add(diffName);
    }
  });
  const difficulties = [...diffSet].sort((a, b) => a.localeCompare(b, "zh-CN"));

  const rows = [];
  if (maps.length && difficulties.length) {
    maps.forEach((mapItem) => {
      difficulties.forEach((diffName) => {
        rows.push({
          uin: formatUinForSheet(expectedUin),
          地图名称: mapItem.mapName,
          模式: mapItem.modeName,
          通关难度: diffName,
          场数: 0
        });
      });
    });
  }

  return {
    rows,
    mapCount: maps.length,
    difficultyCount: difficulties.length
  };
}

function buildLocalCountLookupFromRuntime(runtimeInput = null) {
  const runtime = runtimeInput && typeof runtimeInput === "object" ? runtimeInput : ensureLocalRuntime();
  const lookup = new Map();
  [...(runtime?.aggMap?.values?.() || [])].forEach((item) => {
    const mapName = String(item?.mapName || "").trim();
    const modeName = normalizeModeName(item?.modeName);
    if (!mapName || !modeName) return;
    const diffMap = item?.diffMap instanceof Map ? item.diffMap : new Map();
    [...diffMap.values()].forEach((diff) => {
      const diffName = normalizeDifficultyName(diff?.diffName);
      const total = toPositiveInt(diff?.total) || 0;
      const key = `${mapName}|${modeName}|${diffName}`;
      lookup.set(key, total);
    });
  });
  return lookup;
}

function createXlsxTemplate(filePath, configMapping = {}, options = {}) {
  const xlsx = getXlsxModule();
  const template = buildTemplateRowsFromConfig(configMapping, options);
  const rows = template.rows;
  const sheet = xlsx.utils.json_to_sheet(rows, {
    header: ["uin", "地图名称", "模式", "通关难度", "场数"]
  });
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, "导入模板");
  xlsx.writeFile(workbook, filePath);
  return {
    rowCount: rows.length,
    mapCount: template.mapCount,
    difficultyCount: template.difficultyCount
  };
}

function createXlsxExportFromTemplate(filePath, configMapping = {}, runtimeInput = null, uin = "") {
  const xlsx = getXlsxModule();
  const exportUin = normalizeUin(uin || currentUin);
  const template = buildTemplateRowsFromConfig(configMapping, { uin: exportUin });
  const countLookup = buildLocalCountLookupFromRuntime(runtimeInput);
  let rows = template.rows.map((row) => {
    const mapName = String(row?.地图名称 || "").trim();
    const modeName = normalizeModeName(String(row?.模式 || "").trim());
    const diffName = normalizeDifficultyName(String(row?.通关难度 || "").trim());
    const key = `${mapName}|${modeName}|${diffName}`;
    return {
      ...row,
      uin: formatUinForSheet(exportUin),
      场数: countLookup.get(key) || 0
    };
  });
  if (!rows.length) {
    rows = [...countLookup.entries()].map(([key, total]) => {
      const [mapName, modeName, diffName] = key.split("|");
      return {
        uin: formatUinForSheet(exportUin),
        地图名称: mapName || "未知地图",
        模式: modeName || "未知",
        通关难度: diffName || "未知难度",
        场数: total || 0
      };
    });
  }
  const sheet = xlsx.utils.json_to_sheet(rows, {
    header: ["uin", "地图名称", "模式", "通关难度", "场数"]
  });
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, "本地统计导出");
  xlsx.writeFile(workbook, filePath);
  return {
    rowCount: rows.length,
    mapCount: template.mapCount,
    difficultyCount: template.difficultyCount
  };
}

function importLocalStatsFromRows(rows, sourceFile) {
  ensureRowsUinMatch(rows, currentUin);
  const runtime = ensureLocalRuntime();
  const mapLookup = buildMapLookup(latestConfigMapping);
  const now = Date.now();
  const batchIndexForImport = (toPositiveInt(runtime.store.importCounter) || 0) + 1;
  let importedRows = 0;
  let importedCount = 0;
  let maxBatchIndex = batchIndexForImport - 1;
  const batchSet = new Set();

  rows.forEach((row, rowIndex) => {
    const mapName = String(
      pickFirst(row, ["地图名称", "地图", "mapName", "map", "名称"], "")
    ).trim();
    if (!mapName) {
      return;
    }
    const diffName = normalizeDifficultyName(
      pickFirst(row, ["通关难度", "难度", "diffName", "difficulty"], "未知难度")
    );
    const modeHint = String(
      pickFirst(row, ["模式", "mode", "modeName", "类型"], "")
    ).trim();
    const totalCount = parseCount(
      pickFirst(row, ["场数", "次数", "count", "total"], 0)
    );
    if (totalCount <= 0) {
      return;
    }
    const winCount = parseCount(
      pickFirst(row, ["通关场数", "通过场数", "win", "winCount"], totalCount)
    );

    const mapped = pickMapByName(mapLookup, mapName, modeHint);
    const modeName = normalizeModeName(mapped?.modeName || modeHint || "猎场");
    if (modeName !== "猎场" && modeName !== "塔防") {
      return;
    }
    const entry = {
      id: `manual:${now}:${rowIndex}:${Math.random().toString(36).slice(2, 8)}`,
      mapName: mapped?.mapName || mapName,
      mapId: mapped?.mapId || 0,
      diffName,
      modeName,
      batchIndex: batchIndexForImport,
      count: totalCount,
      winCount: Math.min(winCount || totalCount, totalCount),
      eventTime: new Date(now).toISOString(),
      source: sourceFile || "xlsx"
    };
    runtime.store.manual.push(entry);

    const aggKey = buildAggKey(modeName, entry.mapId || 0, entry.mapName || "未知地图");
    if (!runtime.aggMap.has(aggKey)) {
      runtime.aggMap.set(aggKey, {
        mapId: entry.mapId || 0,
        mapName: entry.mapName || "未知地图",
        modeName,
        total: 0,
        win: 0,
        localTotal: 0,
        localWin: 0,
        importTotal: 0,
        importWin: 0,
        lastTime: "",
        lastTs: 0,
        diffMap: new Map(),
        batchMap: new Map()
      });
    }
    const mapAgg = runtime.aggMap.get(aggKey);
    mapAgg.total += entry.count;
    mapAgg.win += entry.winCount;
    mapAgg.importTotal += entry.count;
    mapAgg.importWin += entry.winCount;
    if (!mapAgg.batchMap) {
      mapAgg.batchMap = new Map();
    }
    if (!mapAgg.batchMap.has(batchIndexForImport)) {
      mapAgg.batchMap.set(batchIndexForImport, {
        batchIndex: batchIndexForImport,
        total: 0,
        win: 0
      });
    }
    const batch = mapAgg.batchMap.get(batchIndexForImport);
    batch.total += entry.count;
    batch.win += entry.winCount;
    const ts = toTimestamp(entry.eventTime);
    if (ts >= mapAgg.lastTs) {
      mapAgg.lastTs = ts;
      mapAgg.lastTime = entry.eventTime;
    }
    if (!mapAgg.diffMap.has(entry.diffName)) {
      mapAgg.diffMap.set(entry.diffName, {
        diffName: entry.diffName,
        total: 0,
        win: 0,
        localTotal: 0,
        importTotal: 0
      });
    }
    const diff = mapAgg.diffMap.get(entry.diffName);
    diff.total += entry.count;
    diff.win += entry.winCount;
    diff.importTotal += entry.count;

    importedRows += 1;
    importedCount += totalCount;
    maxBatchIndex = Math.max(maxBatchIndex, batchIndexForImport);
    batchSet.add(batchIndexForImport);
  });

  runtime.store.importCounter = maxBatchIndex;
  runtime.store.updatedAt = Date.now();
  saveLocalStatsStore(runtime.store);

  return {
    importedRows,
    importedCount,
    batchIndexes: [...batchSet].sort((a, b) => a - b),
    localMapStats: buildLocalMapStatsFromRuntime(latestConfigMapping)
  };
}

function normalizeImportedJsonRecord(item = {}) {
  const record = item && typeof item === "object" ? item : {};
  const dsRoomId = String(
    pickFirst(record, ["dsRoomId", "DsRoomId", "roomID", "roomId", "sRoomID"], "")
  ).trim();
  if (!dsRoomId) {
    return null;
  }
  return {
    dsRoomId,
    mapName: String(pickFirst(record, ["mapName", "sMapName", "地图名称"], "未知地图")).trim() || "未知地图",
    mapId: toPositiveInt(pickFirst(record, ["mapId", "iMapId", "地图ID"], 0)) || 0,
    modeName: String(pickFirst(record, ["modeName", "mode", "模式"], "未知")).trim() || "未知",
    diffName: normalizeDifficultyName(
      pickFirst(record, ["diffName", "difficultyName", "通关难度"], "未知难度")
    ),
    eventTime: String(pickFirst(record, ["eventTime", "dtEventTime", "结束时间"], "")).trim(),
    startTime: String(pickFirst(record, ["startTime", "dtGameStartTime", "开始时间"], "")).trim(),
    score: toPositiveInt(pickFirst(record, ["score", "iScore", "伤害"], 0)) || 0,
    duration: toPositiveInt(
      pickFirst(record, ["duration", "iDuration", "本局时长"], 0)
    ) || 0,
    isWin: Number(pickFirst(record, ["isWin", "iIsWin", "是否胜利"], 0)) === 1 ? 1 : 0,
    sourceType: normalizeLocalRecordSource(
      pickFirst(record, ["sourceType", "recordSource", "dataSource", "source"], ""),
      LOCAL_RECORD_SOURCE.JSON_TRANSFER
    )
  };
}

function importLocalStatsFromJsonPayload(payload = {}) {
  const data = payload && typeof payload === "object" ? payload : {};
  const payloadMarker = String(
    pickFirst(data, ["transferMarker", "transferType", "marker"], "")
  ).trim();
  const isLocalTransferPayload =
    payloadMarker === LOCAL_JSON_TRANSFER_MARK ||
    payloadMarker.toLowerCase() === "local-export-import";
  const payloadUin = normalizeUin(pickFirst(data, ["uin", "UIN"], ""));
  const targetUin = normalizeUin(currentUin);
  if (!targetUin) {
    throw new Error("当前账号缺少 uin，无法导入 JSON");
  }
  if (!payloadUin) {
    throw new Error("JSON 文件缺少 uin 字段");
  }
  if (payloadUin !== targetUin) {
    throw new Error(`JSON 文件 uin(${payloadUin}) 与当前账号(${targetUin})不一致`);
  }
  const recordList = Array.isArray(data?.records)
    ? data.records
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(payload)
        ? payload
        : [];
  const gameList = recordList
    .map((item) => normalizeImportedJsonRecord(item))
    .filter(Boolean)
    .map((item) => ({
      DsRoomId: item.dsRoomId,
      mapName: item.mapName,
      iMapId: item.mapId,
      modeName: item.modeName,
      diffName: item.diffName,
      dtEventTime: item.eventTime,
      dtGameStartTime: item.startTime,
      iScore: item.score,
      iDuration: item.duration,
      iIsWin: item.isWin,
      recordSource: isLocalTransferPayload
        ? LOCAL_RECORD_SOURCE.JSON_TRANSFER
        : item.sourceType
    }));
  const merged = mergeLocalStats(gameList, latestConfigMapping);
  return {
    inserted: merged.inserted,
    upgraded: merged.upgraded,
    totalRecords: merged.totalRecords,
    localMapStats: merged.localMapStats,
    localRecords: merged.localRecords
  };
}

function exportLocalRecordsToJson(filePath) {
  const runtime = ensureLocalRuntime();
  const records = Array.isArray(runtime?.store?.records)
    ? runtime.store.records.map((item) => ({
        ...item,
        sourceType: normalizeLocalRecordSource(
          item?.sourceType,
          LOCAL_RECORD_SOURCE.OFFICIAL
        )
      }))
    : [];
  const payload = {
    transferMarker: LOCAL_JSON_TRANSFER_MARK,
    transferType: "local-export-import",
    uin: normalizeUin(currentUin) || "",
    exportedAt: Date.now(),
    count: records.length,
    records
  };
  writeJsonFile(filePath, payload);
  return payload;
}

function extractTokenFromCookie(cookie) {
  const match = String(cookie || "").match(/(?:^|;\s*)access_token=([^;]+)/i);
  return match?.[1]?.trim() || "";
}

function extractOpenIdFromCookie(cookie) {
  const match = String(cookie || "").match(/(?:^|;\s*)openid=([^;]+)/i);
  return match?.[1]?.trim() || "";
}

function normalizeOpenId(value) {
  return String(value ?? "").trim();
}

function normalizeDomain(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) {
    return "";
  }
  return text.replace(/^https?:\/\//i, "");
}

function normalizeCloudPath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  return text.replace(/^\/+|\/+$/g, "");
}

function normalizeQiniuConfig(input = {}) {
  const protocolRaw = String(input?.protocol || input?.scheme || "https")
    .trim()
    .toLowerCase();
  const protocol = protocolRaw === "http" ? "http" : "https";
  return {
    accessKey: String(input?.accessKey || "").trim(),
    secretKey: String(input?.secretKey || "").trim(),
    protocol,
    domain: normalizeDomain(input?.domain),
    path: normalizeCloudPath(input?.path),
    bucket: String(input?.bucket || input?.bucketName || "").trim(),
    updatedAt: Number(input?.updatedAt) || Date.now()
  };
}

function getPublicQiniuConfig() {
  return {
    accessKey: String(qiniuConfigStore?.accessKey || "").trim(),
    secretKey: String(qiniuConfigStore?.secretKey || "").trim(),
    protocol: String(qiniuConfigStore?.protocol || "https").trim() || "https",
    domain: String(qiniuConfigStore?.domain || "").trim(),
    path: String(qiniuConfigStore?.path || "").trim(),
    bucket: String(qiniuConfigStore?.bucket || "").trim(),
    updatedAt: Number(qiniuConfigStore?.updatedAt) || 0
  };
}

function loadPersistedQiniuConfig() {
  const file = getQiniuConfigPath();
  const raw = readJsonFile(file, null);
  if (!raw || typeof raw !== "object") {
    qiniuConfigStore = normalizeQiniuConfig({});
    writeJsonFile(file, qiniuConfigStore);
    return;
  }
  qiniuConfigStore = normalizeQiniuConfig(raw);
}

function persistQiniuConfig() {
  const file = getQiniuConfigPath();
  qiniuConfigStore = normalizeQiniuConfig({
    ...qiniuConfigStore,
    updatedAt: Date.now()
  });
  writeJsonFile(file, qiniuConfigStore);
}

function getQiniuSdk() {
  try {
    return require("qiniu");
  } catch (_) {
    throw new Error("未安装 qiniu 依赖，请先安装后再使用云同步");
  }
}

function buildQiniuFileUrl(protocol, domain, key, withTs = false) {
  const safeProtocol = String(protocol || "https").toLowerCase() === "http" ? "http" : "https";
  const rawDomain = normalizeDomain(domain);
  const base = `${safeProtocol}://${rawDomain}`;
  const encodedKey = String(key || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const ts = Date.now();
  const suffix = withTs ? `?e=${ts}` : "";
  return `${base}/${encodedKey}${suffix}`;
}

function buildQiniuPrivateDownloadUrl(config, key, expireEpoch) {
  const safeExpire = Number(expireEpoch) > 0 ? Number(expireEpoch) : Math.floor(Date.now() / 1000) + 300;
  const qiniu = getQiniuSdk();
  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const publicUrl = buildQiniuFileUrl(config.protocol, config.domain, key, false);
  if (qiniu?.util && typeof qiniu.util.privateDownloadUrl === "function") {
    return qiniu.util.privateDownloadUrl(publicUrl, safeExpire, mac);
  }
  const separator = publicUrl.includes("?") ? "&" : "?";
  const downloadUrl = `${publicUrl}${separator}e=${safeExpire}`;
  const digest = crypto
    .createHmac("sha1", config.secretKey)
    .update(downloadUrl)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${downloadUrl}&token=${config.accessKey}:${digest}`;
}

function buildCloudStatsObject(configInput = {}) {
  const config = normalizeQiniuConfig(configInput);
  if (!config.accessKey || !config.secretKey || !config.domain || !config.bucket) {
    throw new Error("请先完整填写七牛云配置（AccessKey/SecretKey/域名/存储空间名称）");
  }

  ensureLocalStatsStoreFile();
  const localPath = getLocalStatsPath();
  if (!fs.existsSync(localPath)) {
    throw new Error("本地统计文件不存在");
  }

  const currentStats = readJsonFile(localPath, null);
  if (!currentStats || typeof currentStats !== "object") {
    throw new Error("本地统计文件读取失败");
  }

  const uin = normalizeUin(currentUin) || normalizeUin(currentStats?.uin) || "unknown";
  const fileName = `local-stats${uin}-cloud.json`;
  const key = config.path ? `${config.path}/${fileName}` : fileName;
  const records = Array.isArray(currentStats?.records)
    ? currentStats.records.map((item) => ({
        ...item,
        sourceType: normalizeLocalRecordSource(
          item?.sourceType,
          LOCAL_RECORD_SOURCE.OFFICIAL
        )
      }))
    : [];
  const now = Date.now();
  const cloudPayload = {
    ...currentStats,
    uin,
    transferMarker: LOCAL_JSON_TRANSFER_MARK,
    transferType: "cloud",
    sourceType: LOCAL_RECORD_SOURCE.JSON_TRANSFER,
    exportedAt: now,
    cloudSyncedAt: now,
    count: records.length,
    records
  };
  return {
    config,
    uin,
    fileName,
    key,
    localPath,
    cloudPayload
  };
}

function createQiniuUploadToken(config, key) {
  const qiniu = getQiniuSdk();
  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const putPolicy = new qiniu.rs.PutPolicy({
    scope: `${config.bucket}:${key}`,
    insertOnly: 0
  });
  return putPolicy.uploadToken(mac);
}

function testQiniuConnectivityNoUpload(configInput = {}) {
  const prepared = buildCloudStatsObject(configInput);
  const uploadToken = createQiniuUploadToken(prepared.config, prepared.key);
  if (!uploadToken || typeof uploadToken !== "string") {
    throw new Error("上传 token 生成失败");
  }
  const downloadExpire = Math.floor(Date.now() / 1000) + 300;
  const privateUrl = buildQiniuPrivateDownloadUrl(prepared.config, prepared.key, downloadExpire);
  return {
    bucket: prepared.config.bucket,
    key: prepared.key,
    fileName: prepared.fileName,
    url: privateUrl,
    expireAt: downloadExpire,
    tokenGenerated: true
  };
}

async function syncLocalStatsToQiniu() {
  const prepared = buildCloudStatsObject(qiniuConfigStore);
  const config = prepared.config;
  const key = prepared.key;
  const fileName = prepared.fileName;
  const body = JSON.stringify(prepared.cloudPayload, null, 2);
  const qiniu = getQiniuSdk();
  const uploadToken = createQiniuUploadToken(config, key);
  const qnConfig = new qiniu.conf.Config();
  const formUploader = new qiniu.form_up.FormUploader(qnConfig);
  const putExtra = new qiniu.form_up.PutExtra();

  const uploaded = await new Promise((resolve, reject) => {
    formUploader.put(uploadToken, key, body, putExtra, (respErr, respBody, respInfo) => {
      if (respErr) {
        reject(respErr);
        return;
      }
      const statusCode = Number(respInfo?.statusCode) || 0;
      if (statusCode !== 200) {
        reject(new Error(respBody?.error || `七牛云上传失败: HTTP ${statusCode || "unknown"}`));
        return;
      }
      resolve(respBody || {});
    });
  });
  const expireAt = Math.floor(Date.now() / 1000) + 300;
  const privateUrl = buildQiniuPrivateDownloadUrl(config, key, expireAt);

  return {
    key,
    fileName,
    bucket: config.bucket,
    url: privateUrl,
    expireAt,
    uploadScope: `${config.bucket}:${key}`,
    overwrite: true,
    response: uploaded
  };
}

async function pullLocalStatsFromQiniu() {
  const prepared = buildCloudStatsObject(qiniuConfigStore);
  const expireAt = Math.floor(Date.now() / 1000) + 300;
  const url = buildQiniuPrivateDownloadUrl(prepared.config, prepared.key, expireAt);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`云拉取失败: HTTP ${response.status}`);
  }
  let payload = null;
  try {
    payload = JSON.parse(bodyText || "{}");
  } catch (_) {
    throw new Error("云端文件不是有效 JSON");
  }

  const imported = importLocalStatsFromJsonPayload(payload);
  return {
    key: prepared.key,
    fileName: prepared.fileName,
    url,
    inserted: imported.inserted,
    upgraded: imported.upgraded,
    totalRecords: imported.totalRecords,
    localMapStats: imported.localMapStats,
    localRecords: imported.localRecords
  };
}

function buildAccountPayload() {
  const active = (accountStore?.accounts || []).find((item) => item.uin === currentUin);
  const activeOpenid = normalizeOpenId(active?.openid) || normalizeOpenId(currentOpenId);
  const activeToken = String(active?.accessToken || currentAccessToken || "").trim();
  const activeNickname = String(active?.nickname || currentNickname || "").trim();
  const activeAvatar = String(active?.avatar || currentAvatar || "").trim();
  return {
    activeUin: normalizeUin(currentUin) || "",
    uin: normalizeUin(currentUin) || "",
    openid: activeOpenid,
    accessToken: activeToken,
    nickname: activeNickname,
    avatar: activeAvatar,
    accounts: Array.isArray(accountStore?.accounts)
      ? accountStore.accounts.map((item) => ({
          uin: normalizeUin(item.uin),
          openid: normalizeOpenId(item.openid),
          accessToken: String(item.accessToken || "").trim(),
          nickname: String(item.nickname || "").trim(),
          avatar: String(item.avatar || "").trim(),
          updatedAt: Number(item.updatedAt) || Date.now()
        }))
      : [],
    updatedAt: Date.now()
  };
}

function loadPersistedAccount() {
  const file = getAccountBindPath();

  if (!fs.existsSync(file)) {
    writeJsonFile(file, buildAccountPayload());
    return;
  }

  try {
    const text = fs.readFileSync(file, "utf8");
    const json = JSON.parse(text);
    accountStore = normalizeAccountStore(json || {});
    if (!applyCurrentAccountByUin(accountStore.activeUin)) {
      currentUin = normalizeUin(json?.uin) || "";
      currentOpenId = normalizeOpenId(json?.openid) || "";
      currentAccessToken = String(json?.accessToken || json?.token || "").trim();
      currentNickname = safeDecode(json?.nickname);
      currentAvatar = String(json?.avatar || "").trim();
      if (currentUin) {
        ensureLocalStatsStoreFile();
      }
      if (!currentUin && !currentOpenId && !currentAccessToken) {
        currentUin = "";
        currentOpenId = "";
        currentAccessToken = "";
        currentNickname = "";
        currentAvatar = "";
      }
    }
  } catch (error) {
    console.error("Failed to load account binding:", error);
    accountStore = { activeUin: "", accounts: [] };
    currentUin = "";
    currentOpenId = "";
    currentAccessToken = "";
    currentNickname = "";
    currentAvatar = "";
    writeJsonFile(file, buildAccountPayload());
  }
}

function persistAccount() {
  writeJsonFile(getAccountBindPath(), buildAccountPayload());
}

function extractUserProfileFromUserInfo(data) {
  const payload =
    data?.data && typeof data.data === "object"
      ? data.data
      : data && typeof data === "object"
        ? data
        : {};
  return {
    uin: normalizeUin(pickFirst(payload, ["uin", "uid", "qqUin"], "")),
    nickname: safeDecode(pickFirst(payload, ["nickname", "name", "nickName"], "")),
    avatar: String(pickFirst(payload, ["avatar", "avatarUrl", "headUrl"], "")).trim()
  };
}

function extractUserProfileFromGameDetail(detailData) {
  const payload =
    detailData?.data && typeof detailData.data === "object"
      ? detailData.data
      : detailData && typeof detailData === "object"
        ? detailData
        : {};
  const loginUserDetail =
    payload?.loginUserDetail && typeof payload.loginUserDetail === "object"
      ? payload.loginUserDetail
      : {};
  return {
    nickname: safeDecode(pickFirst(loginUserDetail, ["nickname", "name", "nickName"], "")),
    avatar: safeDecode(pickFirst(loginUserDetail, ["avatar", "avatarUrl", "headUrl"], ""))
  };
}

async function resolveProfileFromLatestGameDetail(cookie) {
  const historyResult = await fetchHistory(cookie, { page: 1, limit: 1 });
  const firstGame = Array.isArray(historyResult?.data?.list) ? historyResult.data.list[0] : null;
  if (!firstGame || typeof firstGame !== "object") {
    return {};
  }
  const roomId = String(
    pickFirst(firstGame, [
      "roomID",
      "DsRoomId",
      "dsRoomId",
      "sRoomID",
      "roomId",
      "roomid",
      "id"
    ])
  ).trim();
  if (!roomId) {
    return {};
  }
  const detailResult = await fetchDetail(cookie, roomId);
  return extractUserProfileFromGameDetail(detailResult);
}

function upsertBoundAccount(accountData = {}) {
  const normalized = normalizeAccountEntry(accountData);
  if (!normalized) {
    throw new Error("uin is required");
  }
  const currentList = Array.isArray(accountStore?.accounts) ? [...accountStore.accounts] : [];
  const index = currentList.findIndex((item) => item.uin === normalized.uin);
  if (index >= 0) {
    currentList[index] = {
      ...currentList[index],
      ...normalized,
      updatedAt: Date.now()
    };
  } else {
    currentList.push({
      ...normalized,
      updatedAt: Date.now()
    });
  }
  accountStore = normalizeAccountStore({
    activeUin: normalized.uin,
    accounts: currentList
  });
  applyCurrentAccountByUin(normalized.uin);
  persistAccount();
  return normalized.uin;
}

function loadPersistedSession() {
  const file = getSessionPath();
  if (!fs.existsSync(file)) {
    return;
  }

  try {
    const text = fs.readFileSync(file, "utf8");
    const json = JSON.parse(text);
    logWindowVisible = Boolean(json?.logWindowVisible);
  } catch (error) {
    console.error("Failed to load session:", error);
    logWindowVisible = false;
  }
}

function persistSession() {
  const file = getSessionPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        logWindowVisible,
        updatedAt: Date.now()
      },
      null,
      2
    ),
    "utf8"
  );
}

function loadNoticeState() {
  const fallback = {
    lastHash: "",
    lastOpenedHash: "",
    lastCheckedAt: 0,
    lastOpenedAt: 0
  };
  const state = readJsonFile(getNoticeStatePath(), fallback);
  const migrated = {
    lastHash: String(state?.lastHash || "").trim(),
    lastOpenedHash: String(
      state?.lastOpenedHash || (state?.hasOpened ? state?.lastHash : "")
    ).trim(),
    lastCheckedAt: Number(state?.lastCheckedAt) || 0,
    lastOpenedAt: Number(state?.lastOpenedAt) || 0
  };
  return migrated;
}

function persistNoticeState(state) {
  writeJsonFile(getNoticeStatePath(), {
    lastHash: String(state?.lastHash || "").trim(),
    lastOpenedHash: String(state?.lastOpenedHash || "").trim(),
    lastCheckedAt: Number(state?.lastCheckedAt) || Date.now(),
    lastOpenedAt: Number(state?.lastOpenedAt) || 0
  });
}

function hashNoticeContent(content) {
  return crypto.createHash("sha256").update(String(content || "")).digest("hex");
}

async function fetchNoticeMarkdown() {
  const response = await fetch(NOTICE_MARKDOWN_URL, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "text/markdown,text/plain;q=0.9,*/*;q=0.8"
    }
  });
  if (!response.ok) {
    throw new Error(`notice fetch failed: ${response.status}`);
  }
  return response.text();
}

function emitNoticeUpdate(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  BrowserWindow.getAllWindows().forEach((window) => {
    try {
      window.webContents.send("notice:update", data);
    } catch (_) {
      // no-op
    }
  });
}

function markNoticeOpened() {
  const state = loadNoticeState();
  state.lastOpenedAt = Date.now();
  if (latestNoticePayload?.hash) {
    state.lastOpenedHash = latestNoticePayload.hash;
  }
  state.lastCheckedAt = Date.now();
  persistNoticeState(state);
  return { success: true, data: state };
}

async function checkNoticeInBackground() {
  const state = loadNoticeState();
  try {
    const content = await fetchNoticeMarkdown();
    const hash = hashNoticeContent(content);
    latestNoticePayload = {
      url: NOTICE_MARKDOWN_URL,
      content,
      hash,
      fetchedAt: Date.now()
    };

    const changed = state.lastHash !== hash;
    const shouldPopup = hash !== state.lastOpenedHash;

    state.lastHash = hash;
    state.lastCheckedAt = Date.now();
    persistNoticeState(state);

    emitNoticeUpdate({
      success: true,
      shouldPopup,
      changed,
      data: latestNoticePayload
    });
    return { success: true, shouldPopup, changed, data: latestNoticePayload };
  } catch (error) {
    appendApiLog({
      kind: "notice:error",
      payload: { error: error?.message || String(error), url: NOTICE_MARKDOWN_URL }
    });
    emitNoticeUpdate({
      success: false,
      shouldPopup: false,
      changed: false,
      error: error?.message || String(error),
      data: latestNoticePayload
    });
    return {
      success: false,
      shouldPopup: false,
      changed: false,
      error: error?.message || String(error),
      data: latestNoticePayload
    };
  }
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    icon: APP_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  window.removeMenu();
  window.loadFile(path.join(__dirname, "..", "app", "index.html"));
  mainWindowRef = window;
  window.on("closed", () => {
    if (mainWindowRef === window) {
      mainWindowRef = null;
    }
  });
}

function createLogWindow() {
  if (!logWindowVisible) {
    return null;
  }

  if (logWindow && !logWindow.isDestroyed()) {
    return logWindow;
  }

  logWindow = new BrowserWindow({
    width: 720,
    height: 860,
    minWidth: 560,
    minHeight: 520,
    icon: APP_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  logWindow.removeMenu();
  logWindow.loadFile(path.join(__dirname, "..", "app", "logs.html"));
  logWindow.on("closed", () => {
    logWindow = null;
    if (logWindowVisible) {
      logWindowVisible = false;
      persistSession();
      BrowserWindow.getAllWindows().forEach((window) => {
        try {
          window.webContents.send("session:log-window-visible", false);
        } catch (_) {
          // no-op
        }
      });
    }
  });
  return logWindow;
}

function setLogWindowVisible(visible) {
  const nextVisible = Boolean(visible);
  const changed = logWindowVisible !== nextVisible;
  logWindowVisible = Boolean(visible);
  persistSession();
  if (logWindowVisible) {
    createLogWindow();
  } else if (logWindow && !logWindow.isDestroyed()) {
    logWindow.close();
  }
  if (changed) {
    BrowserWindow.getAllWindows().forEach((window) => {
      try {
        window.webContents.send("session:log-window-visible", logWindowVisible);
      } catch (_) {
        // no-op
      }
    });
  }
}

function requireCookie() {
  if (!currentOpenId || !currentAccessToken) {
    throw new Error("Please bind openid and token first");
  }
  return buildFixedCookie({
    appid: FIXED_COOKIE_FIELDS.appid,
    openid: currentOpenId,
    accessToken: currentAccessToken
  });
}

function syncLocalRecordsFromStatsData(statsData = {}) {
  if (!statsData || typeof statsData !== "object") {
    return { success: false, message: "同步失败：缺少统计数据" };
  }
  if (statsData.configMapping && typeof statsData.configMapping === "object") {
    latestConfigMapping = statsData.configMapping;
  }

  const merged = mergeLocalStats(
    Array.isArray(statsData.gameList) ? statsData.gameList : [],
    latestConfigMapping
  );
  return {
    success: true,
    message: `本地战绩已更新：新增 ${merged.inserted}，更新 ${merged.upgraded}`,
    data: {
      localMapStats: merged.localMapStats,
      localRecords: Array.isArray(merged.localRecords) ? merged.localRecords : [],
      localStatsMeta: {
        uin: normalizeUin(currentUin) || "",
        inserted: merged.inserted,
        updated: merged.upgraded,
        totalRecords: merged.totalRecords,
        path: merged.localStatsPath
      }
    }
  };
}

async function syncLocalRecordsByDsRoomId() {
  const result = await fetchStats(requireCookie());
  if (!result?.success || !result?.data) {
    return { success: false, message: result?.message || "同步失败" };
  }
  return syncLocalRecordsFromStatsData(result.data);
}

async function resetAllLocalStatsFromHistory() {
  const limit = 10;
  const maxPages = 200;
  let page = 1;
  let hasMore = true;
  let fetchedPages = 0;
  let sourceCount = 0;
  const allGames = [];
  let configMapping = {};

  while (hasMore && page <= maxPages) {
    const result = await fetchHistory(requireCookie(), { page, limit });
    if (!result?.success) {
      throw new Error(result?.message || `历史战绩第 ${page} 页获取失败`);
    }

    fetchedPages += 1;
    const data = result?.data || {};
    if (data?.configMapping && typeof data.configMapping === "object") {
      configMapping = data.configMapping;
    }

    const list = Array.isArray(data?.list) ? data.list : [];
    sourceCount += list.length;
    if (list.length) {
      allGames.push(...list);
    }

    const totalPages = Number(data?.totalPages) || 0;
    if (totalPages > 0) {
      hasMore = page < totalPages;
    } else {
      hasMore = Boolean(data?.hasMore) && list.length >= limit;
    }
    page += 1;
  }

  clearLocalStats();
  if (configMapping && typeof configMapping === "object") {
    latestConfigMapping = configMapping;
  }

  const merged = mergeLocalStats(allGames, latestConfigMapping);
  return {
    success: true,
    message:
      merged.totalRecords > 0
        ? `已清空并重建本地数据：${merged.totalRecords} 场（历史 ${sourceCount} 条）`
        : "已清空本地数据：历史战绩暂无可同步记录",
    data: {
      fetchedPages,
      sourceCount,
      localMapStats: merged.localMapStats,
      localRecords: Array.isArray(merged.localRecords) ? merged.localRecords : [],
      localStatsMeta: {
        uin: normalizeUin(currentUin) || "",
        inserted: merged.inserted,
        updated: merged.upgraded,
        totalRecords: merged.totalRecords,
        path: merged.localStatsPath
      }
    }
  };
}

ipcMain.handle("official:get-endpoints", () => OFFICIAL_ENDPOINTS);

ipcMain.handle("api-log:get-buffer", () => ({
  success: true,
  data: apiLogBuffer
}));

ipcMain.handle("api-log:clear", () => {
  apiLogBuffer.length = 0;
  BrowserWindow.getAllWindows().forEach((window) => {
    try {
      window.webContents.send("api:log-clear");
    } catch (_) {
      // no-op
    }
  });
  return { success: true };
});

ipcMain.handle("session:get-config", () => ({
  success: true,
  data: {
    fixed: {
      ...FIXED_COOKIE_FIELDS,
      openid: currentOpenId
    },
    uin: normalizeUin(currentUin) || "",
    nickname: String(currentNickname || "").trim(),
    avatar: String(currentAvatar || "").trim(),
    openid: currentOpenId,
    accessToken: currentAccessToken,
    accounts: getPublicAccounts(),
    activeUin: normalizeUin(accountStore?.activeUin) || normalizeUin(currentUin) || "",
    hasAccessToken: Boolean(currentAccessToken),
    logWindowVisible,
    qiniuConfig: getPublicQiniuConfig(),
    accountBindPath: getAccountBindPath(),
    localStatsPath: getLocalStatsPath()
  }
}));

ipcMain.handle("session:set-log-window-visible", (_, visible) => {
  setLogWindowVisible(Boolean(visible));
  return {
    success: true,
    data: {
      logWindowVisible
    }
  };
});

ipcMain.handle("qiniu:get-config", () => ({
  success: true,
  data: getPublicQiniuConfig()
}));

ipcMain.handle("qiniu:save-config", (_, payload) => {
  qiniuConfigStore = normalizeQiniuConfig(payload || {});
  persistQiniuConfig();
  try {
    const testResult = testQiniuConnectivityNoUpload(qiniuConfigStore);
    return {
      success: true,
      message: "七牛云配置已保存，连通性校验通过（未上传）",
      data: {
        config: getPublicQiniuConfig(),
        test: testResult
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `七牛云配置已保存，但连通性校验失败: ${error?.message || "未知错误"}`,
      data: {
        config: getPublicQiniuConfig()
      }
    };
  }
});

ipcMain.handle("qiniu:test-config", (_, payload) => {
  try {
    const normalized = normalizeQiniuConfig(payload || qiniuConfigStore);
    const testResult = testQiniuConnectivityNoUpload(normalized);
    return {
      success: true,
      message: "连通性校验通过（未上传）",
      data: testResult
    };
  } catch (error) {
    return {
      success: false,
      message: error?.message || "连通性校验失败"
    };
  }
});

ipcMain.handle("session:switch-account", (_, uin) => {
  const targetUin = normalizeUin(uin);
  if (!targetUin) {
    return { success: false, message: "uin is required" };
  }
  const switched = applyCurrentAccountByUin(targetUin);
  if (!switched) {
    return { success: false, message: `uin ${targetUin} not found` };
  }
  persistAccount();
  return {
    success: true,
    data: {
      uin: currentUin,
      nickname: currentNickname,
      avatar: currentAvatar,
      openid: currentOpenId,
      accessToken: currentAccessToken,
      accounts: getPublicAccounts(),
      localStatsPath: getLocalStatsPath()
    }
  };
});

ipcMain.handle("notice:get-latest", () => ({
  success: true,
  data: latestNoticePayload || null
}));

ipcMain.handle("notice:mark-opened", () => markNoticeOpened());

ipcMain.handle("notice:check", async () => {
  return checkNoticeInBackground();
});

ipcMain.handle("local:get-stats", () => {
  const runtime = ensureLocalRuntime();
  const localMapStats = buildLocalMapStatsFromRuntime(latestConfigMapping);
  return {
    success: true,
    data: {
      localMapStats,
      localRecords: buildLocalRecordListFromRuntime(runtime),
      localStatsMeta: {
        uin: normalizeUin(currentUin) || "",
        totalRecords: Number(localMapStats?.totalRecords) || 0,
        manualRows: Number(localMapStats?.manualRows) || 0,
        path: getLocalStatsPath()
      }
    }
  };
});

ipcMain.handle("local:refresh-by-roomid", async () => {
  return syncLocalRecordsByDsRoomId();
});

ipcMain.handle("local:cloud-sync", async () => {
  try {
    const uploaded = await syncLocalStatsToQiniu();
    return {
      success: true,
      message: `云同步成功：${uploaded.key}`,
      data: uploaded
    };
  } catch (error) {
    return {
      success: false,
      message: error?.message || "云同步失败"
    };
  }
});

ipcMain.handle("local:cloud-pull", async () => {
  try {
    const pulled = await pullLocalStatsFromQiniu();
    return {
      success: true,
      message: `云拉取完成：新增 ${pulled.inserted}，更新 ${pulled.upgraded}`,
      data: {
        key: pulled.key,
        fileName: pulled.fileName,
        url: pulled.url,
        localMapStats: pulled.localMapStats,
        localRecords: Array.isArray(pulled.localRecords) ? pulled.localRecords : [],
        localStatsMeta: {
          uin: normalizeUin(currentUin) || "",
          inserted: pulled.inserted,
          updated: pulled.upgraded,
          totalRecords: pulled.totalRecords,
          path: getLocalStatsPath()
        }
      }
    };
  } catch (error) {
    return {
      success: false,
      message: error?.message || "云拉取失败"
    };
  }
});

ipcMain.handle("local:clear-stats", () => {
  return clearImportedStats();
});

ipcMain.handle("local:reset-all-from-history", async () => {
  try {
    return await resetAllLocalStatsFromHistory();
  } catch (error) {
    return {
      success: false,
      message: error?.message || "清空并重建失败"
    };
  }
});

ipcMain.handle("local:clear-imported-map", (_, payload) => {
  return clearImportedStatsByMap(payload || {});
});

ipcMain.handle("local:import-xlsx", async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const result = await dialog.showOpenDialog(focusedWindow, {
    title: "导入本地统计（xlsx）",
    properties: ["openFile"],
    filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }]
  });

  if (result.canceled || !result.filePaths?.length) {
    return { success: false, message: "已取消导入" };
  }

  const filePath = result.filePaths[0];
  const rows = readXlsxRows(filePath);
  const imported = importLocalStatsFromRows(rows, path.basename(filePath));
  const batchText = Array.isArray(imported?.batchIndexes) && imported.batchIndexes.length
    ? `第${imported.batchIndexes.join("、")}次导入`
    : "导入";

  return {
    success: true,
    message: `${batchText}完成：${imported.importedRows} 行，累计 ${imported.importedCount} 场`,
    data: {
      localMapStats: imported.localMapStats,
      localStatsMeta: {
        uin: normalizeUin(currentUin) || "",
        totalRecords: Number(imported?.localMapStats?.totalRecords) || 0,
        manualRows: Number(imported?.localMapStats?.manualRows) || 0,
        path: getLocalStatsPath()
      },
      importedRows: imported.importedRows,
      importedCount: imported.importedCount,
      batchIndexes: imported.batchIndexes || [],
      filePath
    }
  };
});

ipcMain.handle("local:export-xlsx", async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const saveResult = await dialog.showSaveDialog(focusedWindow, {
    title: "导出本地统计（xlsx）",
    defaultPath: path.join(
      app.getPath("downloads"),
      `本地统计导出-${normalizeUin(currentUin) || "unknown"}.xlsx`
    ),
    filters: [{ name: "Excel", extensions: ["xlsx"] }]
  });
  if (saveResult.canceled || !saveResult.filePath) {
    return { success: false, message: "已取消导出" };
  }
  const runtime = ensureLocalRuntime();
  const exportInfo = createXlsxExportFromTemplate(
    saveResult.filePath,
    latestConfigMapping,
    runtime,
    currentUin
  );
  return {
    success: true,
    message: `导出完成：${exportInfo.rowCount}行（uin: ${normalizeUin(currentUin) || "unknown"}）`,
    data: {
      filePath: saveResult.filePath,
      exportInfo
    }
  };
});

ipcMain.handle("local:export-json", async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const saveResult = await dialog.showSaveDialog(focusedWindow, {
    title: "导出本地记录（json）",
    defaultPath: path.join(
      app.getPath("downloads"),
      `local-records-${normalizeUin(currentUin) || "unknown"}.json`
    ),
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (saveResult.canceled || !saveResult.filePath) {
    return { success: false, message: "已取消导出" };
  }
  const payload = exportLocalRecordsToJson(saveResult.filePath);
  return {
    success: true,
    message: `JSON导出完成：${payload.count}条（uin: ${payload.uin || "unknown"}）`,
    data: {
      filePath: saveResult.filePath,
      count: payload.count,
      uin: payload.uin
    }
  };
});

ipcMain.handle("local:import-json", async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const result = await dialog.showOpenDialog(focusedWindow, {
    title: "导入本地记录（json）",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePaths?.length) {
    return { success: false, message: "已取消导入" };
  }
  const filePath = result.filePaths[0];
  const json = readJsonFile(filePath, null);
  if (!json) {
    return { success: false, message: "JSON文件读取失败" };
  }
  const imported = importLocalStatsFromJsonPayload(json);
  return {
    success: true,
    message: `JSON导入完成：新增 ${imported.inserted}，更新 ${imported.upgraded}`,
    data: {
      filePath,
      localMapStats: imported.localMapStats,
      localRecords: imported.localRecords,
      localStatsMeta: {
        uin: normalizeUin(currentUin) || "",
        inserted: imported.inserted,
        updated: imported.upgraded,
        totalRecords: imported.totalRecords,
        path: getLocalStatsPath()
      }
    }
  };
});

ipcMain.handle("local:download-template-xlsx", async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const saveResult = await dialog.showSaveDialog(focusedWindow, {
    title: "下载导入模板（xlsx）",
    defaultPath: path.join(app.getPath("downloads"), "本地统计导入模板.xlsx"),
    filters: [{ name: "Excel", extensions: ["xlsx"] }]
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: false, message: "已取消下载模板" };
  }

  let configMapping = {};
  let configSource = "empty";
  let configError = "";
  try {
    configMapping = await fetchConfigList(requireCookie());
    latestConfigMapping =
      configMapping && typeof configMapping === "object" ? configMapping : {};
    configSource = "api";
  } catch (error) {
    configMapping = {};
    configSource = "api_failed";
    configError = error?.message || String(error);
  }

  const templateInfo = createXlsxTemplate(saveResult.filePath, configMapping, {
    uin: currentUin
  });
  const isEmpty = Number(templateInfo?.rowCount) <= 0;
  const message = isEmpty
    ? configSource === "api_failed"
      ? `模板已下载（空数据）：API获取失败，${configError || "请稍后重试"}`
      : "模板已下载（空数据）：未获取到地图/难度映射"
    : `模板下载完成：${templateInfo.mapCount}张地图，${templateInfo.difficultyCount}个难度，${templateInfo.rowCount}行`;

  return {
    success: true,
    message,
    data: {
      filePath: saveResult.filePath,
      configSource,
      configError,
      templateInfo
    }
  };
});

async function bindAccountAndLoadUserInfo(rawInput) {
  const payload =
    rawInput && typeof rawInput === "object"
      ? rawInput
      : { accessToken: rawInput };

  const openid =
    normalizeOpenId(payload?.openid) ||
    normalizeOpenId(currentOpenId) ||
    "";
  const tokenInput = payload?.accessToken || payload?.token || payload?.cookie || payload?.raw || "";

  const normalized = normalizeCookie({
    appid: FIXED_COOKIE_FIELDS.appid,
    openid,
    accessToken: tokenInput
  });
  const accessToken = extractTokenFromCookie(normalized);
  const normalizedOpenId = normalizeOpenId(extractOpenIdFromCookie(normalized)) || openid;
  if (!accessToken) {
    throw new Error("access_token is required");
  }
  if (!normalizedOpenId) {
    throw new Error("openid is required");
  }

  const [userInfoResult, detailProfileResult] = await Promise.allSettled([
    fetchUserInfo(normalized),
    resolveProfileFromLatestGameDetail(normalized)
  ]);
  if (userInfoResult.status !== "fulfilled") {
    throw userInfoResult.reason;
  }
  const profile = extractUserProfileFromUserInfo(userInfoResult.value);
  if (!profile.uin) {
    throw new Error("user.info missing uin");
  }
  const detailProfile =
    detailProfileResult.status === "fulfilled" &&
    detailProfileResult.value &&
    typeof detailProfileResult.value === "object"
      ? detailProfileResult.value
      : {};
  const preferredNickname = String(detailProfile.nickname || profile.nickname || "").trim();
  let resolvedNickname = preferredNickname;
  // If nickname remains URL-encoded or decode failed, fallback to uin to avoid garbled account labels.
  if (!resolvedNickname || /%[0-9A-Fa-f]{2}/.test(resolvedNickname)) {
    resolvedNickname = profile.uin;
  }
  const resolvedAvatar = String(detailProfile.avatar || profile.avatar || "").trim();

  upsertBoundAccount({
    uin: profile.uin,
    openid: normalizedOpenId,
    accessToken,
    nickname: resolvedNickname,
    avatar: resolvedAvatar
  });
  persistSession();

  return {
    success: true,
    message: "账号已保存并切换",
    data: {
      uin: currentUin,
      nickname: currentNickname,
      avatar: currentAvatar,
      openid: currentOpenId,
      accessToken: currentAccessToken,
      accounts: getPublicAccounts(),
      localStatsPath: getLocalStatsPath()
    },
    cookiePreview: `${normalized.slice(0, 72)}...`
  };
}

ipcMain.handle("session:bind-access-token", async (_, rawInput) => {
  return bindAccountAndLoadUserInfo(rawInput);
});

// Backward compatibility with old renderer API.
ipcMain.handle("session:bind-cookie", async (_, rawCookie) => {
  return bindAccountAndLoadUserInfo(rawCookie);
});

ipcMain.handle("session:clear-access-token", () => {
  currentAccessToken = "";
  if (currentUin) {
    const idx = (accountStore?.accounts || []).findIndex((x) => x.uin === currentUin);
    if (idx >= 0) {
      accountStore.accounts[idx].accessToken = "";
      accountStore.accounts[idx].updatedAt = Date.now();
    }
  }
  persistAccount();
  persistSession();
  return { success: true };
});

ipcMain.handle("session:clear-cookie", () => {
  currentAccessToken = "";
  if (currentUin) {
    const idx = (accountStore?.accounts || []).findIndex((x) => x.uin === currentUin);
    if (idx >= 0) {
      accountStore.accounts[idx].accessToken = "";
      accountStore.accounts[idx].updatedAt = Date.now();
    }
  }
  persistAccount();
  persistSession();
  return { success: true };
});

ipcMain.handle("stats:get", async () => {
  const result = await fetchStats(requireCookie());
  if (!result?.success || !result?.data) {
    return result;
  }
  const syncResult = syncLocalRecordsFromStatsData(result.data);
  if (syncResult?.success) {
    result.data.localMapStats = syncResult.data.localMapStats;
    result.data.localRecords = syncResult.data.localRecords;
    result.data.localStatsMeta = syncResult.data.localStatsMeta;
  }
  return result;
});

ipcMain.handle("history:get", async (_, query) => {
  return fetchHistory(requireCookie(), query || {});
});

ipcMain.handle("collection:get", async () => {
  return fetchCollection(requireCookie());
});

ipcMain.handle("detail:get", async (_, roomId) => {
  return fetchDetail(requireCookie(), roomId);
});

app.whenReady().then(() => {
  setApiLogHandler(appendApiLog);
  loadPersistedSession();
  loadPersistedAccount();
  loadPersistedQiniuConfig();
  createMainWindow();
  checkNoticeInBackground().catch(() => {});
  if (logWindowVisible) {
    createLogWindow();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      checkNoticeInBackground().catch(() => {});
      if (logWindowVisible) {
        createLogWindow();
      }
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});


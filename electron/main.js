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
  fetchConfigList,
  fetchStats,
  fetchHistory,
  fetchCollection,
  fetchDetail
} = require("./official-api");

const SESSION_FILE = "session.json";
const ACCOUNT_BIND_FILE = "account-binding.json";
const NOTICE_STATE_FILE = "notice-state.json";
const LOCAL_STATS_FILE = "local-stats.json";
const NOTICE_MARKDOWN_URL = "https://gitee.com/returnee/nzm-notice/raw/master/README.md";
const APP_ICON_PATH = path.join(__dirname, "..", "app", "bitbug_favicon.ico");

let currentAccessToken = "";
let currentOpenId = "";
let logWindow = null;
let logWindowVisible = false;
let mainWindowRef = null;
let latestNoticePayload = null;
let latestConfigMapping = {};
let localStatsRuntime = null;
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

function getLocalStatsPath() {
  return path.join(app.getPath("userData"), LOCAL_STATS_FILE);
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
  const raw = readJsonFile(filePath, {});
  const records = Array.isArray(raw?.records)
    ? raw.records
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          dsRoomId: String(item.dsRoomId || "").trim(),
          mapName: String(item.mapName || "").trim() || "未知地图",
          mapId: toPositiveInt(item.mapId) || 0,
          diffName: normalizeDifficultyName(item.diffName),
          eventTime: String(item.eventTime || "").trim(),
          isWin: Number(item.isWin) === 1 ? 1 : 0,
          modeName: normalizeModeName(item.modeName)
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
          modeName: normalizeModeName(item.modeName),
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
    version: 3,
    updatedAt: Number(store?.updatedAt) || Date.now(),
    records: Array.isArray(store?.records) ? store.records : [],
    manual: Array.isArray(store?.manual) ? store.manual : [],
    importCounter: toPositiveInt(store?.importCounter) || 0
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
  const mappedMode = normalizeModeName(mapNode?.modeName || "");
  const inferredMode = inferModeNameFromGame(game);
  const modeName = mappedMode !== "未知" ? mappedMode : inferredMode;

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

  const isWin = Number(pickFirst(game, ["iIsWin", "isWin"], 0)) === 1 ? 1 : 0;

  return {
    dsRoomId,
    mapName: mapName || "未知地图",
    mapId: mapId > 0 ? mapId : 0,
    diffName: diffName || "未知难度",
    eventTime,
    isWin,
    modeName
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
  if (Array.isArray(games)) {
    games.forEach((game) => {
      const record = normalizeLocalGameRecord(game, latestConfigMapping, prepared);
      if (!record) {
        return;
      }
      const key = String(record.dsRoomId);
      if (runtime.idSet.has(key)) {
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

  if (inserted > 0) {
    runtime.store.records.sort((a, b) => toTimestamp(b.eventTime) - toTimestamp(a.eventTime));
    runtime.store.updatedAt = Date.now();
    saveLocalStatsStore(runtime.store);
  }

  return {
    inserted,
    totalRecords: runtime.store.records.length,
    localMapStats: buildLocalMapStatsFromRuntime(latestConfigMapping),
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
    store: { version: 3, updatedAt: Date.now(), records: [], manual: [], importCounter: 0 },
    idSet: new Set(),
    aggMap: new Map()
  };
  saveLocalStatsStore(localStatsRuntime.store);
  return {
    success: true,
    data: {
      localMapStats: buildLocalMapStatsFromRuntime(latestConfigMapping),
      localStatsMeta: {
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

function buildTemplateRowsFromConfig(configMapping = {}) {
  const root = getConfigRoot(configMapping);
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

function createXlsxTemplate(filePath, configMapping = {}) {
  const xlsx = getXlsxModule();
  const template = buildTemplateRowsFromConfig(configMapping);
  const rows = template.rows;
  const sheet = xlsx.utils.json_to_sheet(rows, {
    header: ["地图名称", "模式", "通关难度", "场数"]
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

function importLocalStatsFromRows(rows, sourceFile) {
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

function buildAccountPayload() {
  return {
    openid: normalizeOpenId(currentOpenId),
    accessToken: String(currentAccessToken || "").trim(),
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
    currentOpenId =
      normalizeOpenId(json?.openid) ||
      normalizeOpenId(currentOpenId) ||
      "";
    currentAccessToken = String(
      json?.accessToken || json?.token || currentAccessToken || ""
    ).trim();
  } catch (error) {
    console.error("Failed to load account binding:", error);
    writeJsonFile(file, buildAccountPayload());
  }
}

function persistAccount() {
  writeJsonFile(getAccountBindPath(), buildAccountPayload());
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
    openid: currentOpenId,
    accessToken: currentAccessToken,
    hasAccessToken: Boolean(currentAccessToken),
    logWindowVisible,
    accountBindPath: getAccountBindPath()
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

ipcMain.handle("notice:get-latest", () => ({
  success: true,
  data: latestNoticePayload || null
}));

ipcMain.handle("notice:mark-opened", () => markNoticeOpened());

ipcMain.handle("notice:check", async () => {
  return checkNoticeInBackground();
});

ipcMain.handle("local:get-stats", () => {
  const localMapStats = buildLocalMapStatsFromRuntime(latestConfigMapping);
  return {
    success: true,
    data: {
      localMapStats,
      localStatsMeta: {
        totalRecords: Number(localMapStats?.totalRecords) || 0,
        manualRows: Number(localMapStats?.manualRows) || 0,
        path: getLocalStatsPath()
      }
    }
  };
});

ipcMain.handle("local:clear-stats", () => {
  return clearImportedStats();
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

  const templateInfo = createXlsxTemplate(saveResult.filePath, configMapping);
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

ipcMain.handle("session:bind-access-token", (_, rawInput) => {
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

  currentOpenId = normalizedOpenId;
  currentAccessToken = accessToken;
  persistAccount();
  persistSession();

  return {
    success: true,
    message: "openid/token saved locally",
    cookiePreview: `${normalized.slice(0, 72)}...`
  };
});

// Backward compatibility with old renderer API.
ipcMain.handle("session:bind-cookie", (_, rawCookie) => {
  const normalized = normalizeCookie(rawCookie);
  const accessToken = extractTokenFromCookie(normalized);
  const openid =
    normalizeOpenId(extractOpenIdFromCookie(normalized)) ||
    normalizeOpenId(currentOpenId) ||
    "";
  if (!accessToken) {
    throw new Error("access_token is required");
  }
  if (!openid) {
    throw new Error("openid is required");
  }

  currentOpenId = openid;
  currentAccessToken = accessToken;
  persistAccount();
  persistSession();

  return {
    success: true,
    message: "openid/token saved locally",
    cookiePreview: `${normalized.slice(0, 72)}...`
  };
});

ipcMain.handle("session:clear-access-token", () => {
  currentAccessToken = "";
  persistAccount();
  persistSession();
  return { success: true };
});

ipcMain.handle("session:clear-cookie", () => {
  currentAccessToken = "";
  persistAccount();
  persistSession();
  return { success: true };
});

ipcMain.handle("stats:get", async () => {
  const result = await fetchStats(requireCookie());
  if (!result?.success || !result?.data) {
    return result;
  }

  if (result.data.configMapping && typeof result.data.configMapping === "object") {
    latestConfigMapping = result.data.configMapping;
  }

  const merged = mergeLocalStats(
    Array.isArray(result.data.gameList) ? result.data.gameList : [],
    latestConfigMapping
  );

  result.data.localMapStats = merged.localMapStats;
  result.data.localStatsMeta = {
    inserted: merged.inserted,
    totalRecords: merged.totalRecords,
    path: merged.localStatsPath
  };
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


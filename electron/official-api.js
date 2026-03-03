const OFFICIAL_ENDPOINTS = {
  dataApi: "https://comm.ams.game.qq.com/ide/",
  miniProgramReferer:
    "https://servicewechat.com/wx4e8cbe4fb0eca54c/13/page-frame.html",
  miniProgramRecordPage: "http://wechatmini.qq.com/-/-/pages/record/record/",
  miniProgramRecordInfoPage:
    "http://wechatmini.qq.com/-/-/pages/recordinfo/recordinfo/",
  miniProgramHandbookPage:
    "http://wechatmini.qq.com/-/-/pages/handbook/handbook/",
  officialImageHost: "https://nzm.playerhub.qq.com/"
};

const EXTERNAL_ENDPOINTS = {
};

const FIXED_COOKIE_FIELDS = Object.freeze({
  appid: "1112451898",
  openid: "",
  acctype: "qc"
});

const COMMON_HEADERS = {
  Host: "comm.ams.game.qq.com",
  "Content-Type": "application/x-www-form-urlencoded;",
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254171e) XWEB/18787",
  Referer: OFFICIAL_ENDPOINTS.miniProgramReferer,
  xweb_xhr: "1"
};

function extractAccessToken(input) {
  const raw = String(input || "")
    .replace(/[\r\n]/g, " ")
    .trim();

  if (!raw) {
    throw new Error("access_token is required");
  }

  if (!raw.includes("=")) {
    return raw;
  }

  const match = raw.match(/(?:^|;\s*)access_token=([^;]+)/i);
  if (!match?.[1]) {
    throw new Error("Cookie missing access_token");
  }

  return match[1].trim();
}

function extractAppId(input) {
  const raw = String(input || "")
    .replace(/[\r\n]/g, " ")
    .trim();
  if (!raw || !raw.includes("=")) {
    return "";
  }
  const match = raw.match(/(?:^|;\s*)appid=(\d+)/i);
  return match?.[1]?.trim() || "";
}

function extractOpenId(input) {
  const raw = String(input || "")
    .replace(/[\r\n]/g, " ")
    .trim();
  if (!raw || !raw.includes("=")) {
    return "";
  }
  const match = raw.match(/(?:^|;\s*)openid=([^;]+)/i);
  return match?.[1]?.trim() || "";
}

function normalizeAppId(appid) {
  const text = String(appid || "").trim();
  if (!/^\d+$/.test(text)) {
    return "";
  }
  return text;
}

function normalizeOpenId(openid) {
  return String(openid || "").trim();
}

function resolveAuthFields(input) {
  if (input && typeof input === "object") {
    const appid =
      normalizeAppId(input.appid) ||
      normalizeAppId(FIXED_COOKIE_FIELDS.appid);
    const openid =
      normalizeOpenId(input.openid) || "";
    const accessToken = extractAccessToken(
      input.accessToken || input.token || input.cookie || input.raw || ""
    );
    return { appid, openid, accessToken };
  }

  const accessToken = extractAccessToken(input);
  const appid =
    normalizeAppId(extractAppId(input)) ||
    normalizeAppId(FIXED_COOKIE_FIELDS.appid);
  const openid =
    normalizeOpenId(extractOpenId(input)) || "";
  return { appid, openid, accessToken };
}

function buildFixedCookie(input) {
  const { appid, openid, accessToken } = resolveAuthFields(input);
  return [
    `appid=${appid}`,
    `openid=${openid}`,
    `acctype=${FIXED_COOKIE_FIELDS.acctype}`,
    `access_token=${accessToken}`
  ].join("; ");
}

function normalizeCookie(input) {
  return buildFixedCookie(input);
}

function buildBody(method, param, easUrl) {
  return new URLSearchParams({
    iChartId: "430662",
    iSubChartId: "430662",
    sIdeToken: "NoOapI",
    eas_url: easUrl,
    method,
    from_source: "2",
    param: JSON.stringify(param)
  }).toString();
}

let apiLogHandler = null;

function setApiLogHandler(handler) {
  apiLogHandler = typeof handler === "function" ? handler : null;
}

function logApiRequest(kind, payload) {
  if (!apiLogHandler) {
    return;
  }
  try {
    apiLogHandler({
      ts: Date.now(),
      kind,
      payload
    });
  } catch (_) {
    // no-op
  }
}

function summarizePayload(data) {
  if (Array.isArray(data)) {
    return { type: "array", length: data.length };
  }
  if (!data || typeof data !== "object") {
    return { type: typeof data };
  }
  const summary = { type: "object", keys: Object.keys(data) };
  if (Array.isArray(data?.gameList)) {
    summary.gameList = data.gameList.length;
  }
  if (Array.isArray(data?.list)) {
    summary.list = data.list.length;
  }
  if (Array.isArray(data?.weaponList)) {
    summary.weaponList = data.weaponList.length;
  }
  if (Array.isArray(data?.home)) {
    summary.home = data.home.length;
  }
  return summary;
}

function normalizePositiveIntString(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    return "";
  }
  return Number(text) > 0 ? text : "";
}

function normalizePositiveInt(value) {
  const text = normalizePositiveIntString(value);
  if (!text) {
    return 0;
  }
  return Number(text);
}

async function postOfficialApi(cookie, method, param, easUrl) {
  const requestInfo = {
    endpoint: OFFICIAL_ENDPOINTS.dataApi,
    method,
    easUrl,
    param
  };
  logApiRequest("official:request", requestInfo);

  const body = buildBody(method, param, easUrl);
  try {
    const response = await fetch(OFFICIAL_ENDPOINTS.dataApi, {
      method: "POST",
      headers: { ...COMMON_HEADERS, Cookie: cookie },
      body
    });

    const data = await response.json();
    const payload = data?.jData?.data?.data ?? null;
    logApiRequest("official:response", {
      ...requestInfo,
      status: response.status,
      iRet: data?.iRet ?? null,
      sMsg: data?.sMsg || "",
      summary: summarizePayload(payload),
      data: payload
    });

    if (data.iRet !== 0) {
      throw new Error(data.sMsg || `Official API request failed: iRet=${data.iRet}`);
    }
    return payload;
  } catch (error) {
    logApiRequest("official:error", {
      ...requestInfo,
      error: error?.message || String(error)
    });
    throw error;
  }
}

async function fetchUserSummary(cookie) {
  return postOfficialApi(
    cookie,
    "center.user.stats",
    { seasonID: 1 },
    OFFICIAL_ENDPOINTS.miniProgramRecordPage
  );
}

async function fetchUserInfo(cookie) {
  const data = await postOfficialApi(
    cookie,
    "user.info",
    { seasonID: 1 },
    OFFICIAL_ENDPOINTS.miniProgramRecordPage
  );

  if (data?.data && typeof data.data === "object") {
    return data.data;
  }
  return data && typeof data === "object" ? data : {};
}

function buildGameListParam(page, limit = 10, options = {}) {
  const param = {
    seasonID: 1,
    page: Number(page) > 0 ? Number(page) : 1,
    limit: Number(limit) > 0 ? Number(limit) : 10
  };

  const modeType = normalizePositiveIntString(options?.modeType);
  if (modeType) {
    param.modeType = modeType;
  }

  const mapId = normalizePositiveInt(options?.mapId);
  if (mapId > 0) {
    param.mapId = mapId;
  }

  return param;
}

async function fetchGamePageRaw(cookie, page, limit = 10, options = {}) {
  return postOfficialApi(
    cookie,
    "center.user.game.list",
    buildGameListParam(page, limit, options),
    OFFICIAL_ENDPOINTS.miniProgramRecordPage
  );
}

async function fetchGamePage(cookie, page, limit = 10, options = {}) {
  const data = await fetchGamePageRaw(cookie, page, limit, options);
  return Array.isArray(data?.gameList) ? data.gameList : [];
}

async function fetchAllGames(cookie, maxPages = 10, delayMs = 0) {
  const list = [];
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1 && delayMs > 0) {
      await delay(delayMs);
    }
    const current = await fetchGamePage(cookie, page, 10);
    if (!current.length) break;
    list.push(...current);
  }
  return list;
}

async function fetchConfigList(cookie) {
  return postOfficialApi(
    cookie,
    "center.config.list",
    { seasonID: 1, configType: "all" },
    OFFICIAL_ENDPOINTS.miniProgramRecordPage
  );
}

function normalizeConfigPayload(configPayload) {
  if (!configPayload || typeof configPayload !== "object") {
    return {};
  }

  const config =
    configPayload?.config && typeof configPayload.config === "object"
      ? configPayload.config
      : configPayload;

  return {
    raw: config,
    difficultyInfo:
      config?.difficultyInfo && typeof config.difficultyInfo === "object"
        ? config.difficultyInfo
        : {},
    mapInfo:
      config?.mapInfo && typeof config.mapInfo === "object" ? config.mapInfo : {},
    huntingFieldPartitionArea:
      config?.huntingFieldPartitionArea && typeof config.huntingFieldPartitionArea === "object"
        ? config.huntingFieldPartitionArea
        : config?.huntingFielartitionArea && typeof config.huntingFielartitionArea === "object"
          ? config.huntingFielartitionArea
          : config?.huntingPartitionArea && typeof config.huntingPartitionArea === "object"
            ? config.huntingPartitionArea
            : {},
    modeInfo:
      config?.modeInfo && typeof config.modeInfo === "object"
        ? config.modeInfo
        : config?.modeTypeInfo && typeof config.modeTypeInfo === "object"
          ? config.modeTypeInfo
          : {},
    subModeInfo:
      config?.subModeInfo && typeof config.subModeInfo === "object"
        ? config.subModeInfo
        : config?.subModeTypeInfo && typeof config.subModeTypeInfo === "object"
          ? config.subModeTypeInfo
          : {}
  };
}

function firstText(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function parseJsonIfString(value) {
  if (typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (!text) {
    return value;
  }
  const first = text[0];
  const last = text[text.length - 1];
  const maybeJson =
    (first === "{" && last === "}") ||
    (first === "[" && last === "]");
  if (!maybeJson) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return value;
  }
}

function toPartitionAreaList(value) {
  const parsed = parseJsonIfString(value);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed).map(([id, node]) => {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        return {
          ...node,
          areaId: firstText(node, ["areaId", "iAreaId", "id"]) || String(id || "").trim()
        };
      }
      return {
        areaId: String(id || "").trim(),
        areaName: String(node || "").trim()
      };
    });
  }
  return [];
}

function buildPartitionAreaNameMap(configPayload) {
  const cfg = normalizeConfigPayload(configPayload);
  const map = {};
  toPartitionAreaList(cfg.huntingFieldPartitionArea).forEach((item, index) => {
    const areaId = firstText(item, ["areaId", "iAreaId", "id"]) || String(index + 1);
    if (!areaId) {
      return;
    }
    const areaName =
      firstText(item, ["areaName", "name", "partitionName", "displayName", "label"]) ||
      `区域${areaId}`;
    map[areaId] = areaName;
  });
  return map;
}

function normalizeDifficultyName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (raw.includes("炼狱")) {
    return "炼狱";
  }
  if (
    raw === "折磨" ||
    /折磨\s*(?:I|1|Ⅰ)$/i.test(raw) ||
    /折磨\s*(?:I|1|Ⅰ)\b/i.test(raw)
  ) {
    return "折磨I";
  }
  return raw;
}

function extractBossDamage(game) {
  const direct =
    Number(game?.iBossDamage || 0) ||
    Number(game?.bossDamage || 0) ||
    Number(game?.iBossHurt || 0) ||
    Number(game?.bossHurt || 0) ||
    Number(game?.iBossDmg || 0) ||
    Number(game?.damageTotalOnBoss || 0) ||
    Number(game?.iDamage || 0) ||
    Number(game?.iTotalDamage || 0) ||
    Number(game?.damage || 0) ||
    Number(game?.iHurt || 0) ||
    Number(game?.hurt || 0) ||
    0;
  if (direct > 0) {
    return direct;
  }

  const lowPairs = Object.entries(game || {});
  for (const [key, value] of lowPairs) {
    const text = String(key || "").toLowerCase();
    if (!text.includes("boss")) {
      continue;
    }
    if (!text.includes("damage") && !text.includes("hurt") && !text.includes("dmg")) {
      continue;
    }
    const num = Number(value || 0);
    if (num > 0) {
      return num;
    }
  }
  return 0;
}

function toObjectSafe(value) {
  const parsed = parseJsonIfString(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return {};
}

function toArraySafe(value) {
  const parsed = parseJsonIfString(value);
  return Array.isArray(parsed) ? parsed : [];
}

function getRoomIdFromGame(game) {
  return firstText(game, [
    "roomID",
    "DsRoomId",
    "dsRoomId",
    "sRoomID",
    "roomId",
    "iRoomId",
    "roomid",
    "id"
  ]);
}

function getRecentTargetGames(gameList) {
  const targetModes = ["猎场", "僵尸", "塔防", "时空追捕"];
  return gameList.filter(g => {
    const rawMode = String(g?.modeName || g?.sModeName || g?.sTypeName || "").toLowerCase();
    return targetModes.some(t => rawMode.includes(t));
  });
}

function calculateAvgBossDamageFromGames(validGames) {
  const recent10 = validGames.slice(0, 10);
  const bossDamageSamples = recent10
    .map((g) => extractBossDamage(g))
    .filter((x) => Number(x) > 0);
  if (!bossDamageSamples.length) {
    return 0;
  }
  return Math.floor(
    bossDamageSamples.reduce((acc, x) => acc + Number(x), 0) / bossDamageSamples.length
  );
}

function findSelfPlayerFromDetailPayload(detailPayload) {
  const payload = toObjectSafe(detailPayload);
  const list = toArraySafe(payload?.list);
  if (!list.length) {
    return null;
  }
  const markedSelf = list.find((item) => {
    const node = toObjectSafe(item);
    return (
      Number(node?.isSelf) === 1 ||
      Number(node?.self) === 1 ||
      Number(node?.isMe) === 1 ||
      Number(node?.iSelf) === 1
    );
  });
  if (markedSelf) {
    return markedSelf;
  }

  const loginUser = toObjectSafe(payload?.loginUserDetail);
  const loginUin = firstText(loginUser, ["uin", "iUin", "uid", "roleId", "openId", "openid"]);
  const loginNick = firstText(loginUser, ["nickname", "name", "nickName"]);

  if (loginUin) {
    const byUin = list.find((item) => {
      const node = toObjectSafe(item);
      const playerUin = firstText(node, ["uin", "iUin", "uid", "roleId", "openId", "openid"]);
      return playerUin && playerUin === loginUin;
    });
    if (byUin) {
      return byUin;
    }
  }

  if (loginNick) {
    const byNick = list.find((item) => {
      const node = toObjectSafe(item);
      const playerNick = firstText(node, ["nickname", "name", "nickName"]);
      return playerNick && playerNick === loginNick;
    });
    if (byNick) {
      return byNick;
    }
  }

  return list[0];
}

function extractBossDamageFromDetailPayload(detailPayload) {
  const payload = toObjectSafe(detailPayload);
  const rootHuntingDetails = toObjectSafe(
    payload?.huntingDetails || payload?.huntingDetail || payload?.huntingData
  );
  const rootBossDamage =
    Number(rootHuntingDetails?.damageTotalOnBoss || 0) ||
    Number(rootHuntingDetails?.bossDamage || 0) ||
    Number(rootHuntingDetails?.damageBoss || 0) ||
    0;
  if (rootBossDamage > 0) {
    return rootBossDamage;
  }

  const loginUser = toObjectSafe(payload?.loginUserDetail);
  const loginHuntingDetails = toObjectSafe(
    loginUser?.huntingDetails || loginUser?.huntingDetail || loginUser?.huntingData
  );
  const loginBossDamage =
    Number(loginHuntingDetails?.damageTotalOnBoss || 0) ||
    Number(loginHuntingDetails?.bossDamage || 0) ||
    Number(loginHuntingDetails?.damageBoss || 0) ||
    extractBossDamage(loginUser);
  if (loginBossDamage > 0) {
    return loginBossDamage;
  }

  const player = findSelfPlayerFromDetailPayload(payload);
  if (player) {
    const playerNode = toObjectSafe(player);
    const huntingDetails = toObjectSafe(
      playerNode?.huntingDetails || playerNode?.huntingDetail || playerNode?.huntingData
    );
    const fromSelf =
      Number(huntingDetails?.damageTotalOnBoss || 0) ||
      Number(huntingDetails?.bossDamage || 0) ||
      Number(huntingDetails?.damageBoss || 0) ||
      extractBossDamage(playerNode);
    if (fromSelf > 0) {
      return fromSelf;
    }
  }

  const list = toArraySafe(payload?.list);
  const samples = list
    .map((item) => {
      const node = toObjectSafe(item);
      const huntingDetails = toObjectSafe(
        node?.huntingDetails || node?.huntingDetail || node?.huntingData
      );
      return (
        Number(huntingDetails?.damageTotalOnBoss || 0) ||
        Number(huntingDetails?.bossDamage || 0) ||
        Number(huntingDetails?.damageBoss || 0) ||
        extractBossDamage(node)
      );
    })
    .filter((value) => Number(value) > 0);

  if (samples.length > 0) {
    return Math.max(...samples);
  }
  return 0;
}

async function calculateAvgBossDamageFromDetails(cookie, validGames) {
  const roomIds = [...new Set(
    validGames
      .slice(0, 10)
      .map((game) => getRoomIdFromGame(game))
      .filter((roomId) => roomId)
  )];
  if (!roomIds.length) {
    return 0;
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const samples = [];
  for (const roomId of roomIds) {
    try {
      const detail = await postOfficialApi(
        cookie,
        "center.game.detail",
        { seasonID: 1, roomID: roomId },
        OFFICIAL_ENDPOINTS.miniProgramRecordInfoPage
      );
      const damage = extractBossDamageFromDetailPayload(detail);
      if (Number(damage) > 0) {
        samples.push(Number(damage));
      }
    } catch (_) {
      // ignore single-room detail failure
    }
    await delay(120);
  }

  if (!samples.length) {
    return 0;
  }
  return Math.floor(samples.reduce((acc, x) => acc + Number(x), 0) / samples.length);
}

function applyConfigMappingToGames(gameList, configPayload) {
  const cfg = normalizeConfigPayload(configPayload);
  if (!Array.isArray(gameList) || !gameList.length) {
    return [];
  }

  return gameList.map((game) => {
    const mapId = String(game?.iMapId ?? game?.mapId ?? game?.mapID ?? "").trim();
    const diffId = String(
      game?.iSubModeType ?? game?.iDiffId ?? game?.difficulty ?? game?.iDifficulty ?? ""
    ).trim();
    const modeId = String(game?.iModeType ?? game?.iGameMode ?? game?.modeType ?? "").trim();
    const subModeId = String(game?.iSubModeType ?? game?.subModeType ?? "").trim();

    const mapNode = mapId ? cfg.mapInfo?.[mapId] : null;
    const diffNode = diffId ? cfg.difficultyInfo?.[diffId] : null;
    const modeNode = modeId ? cfg.modeInfo?.[modeId] : null;
    const subModeNode = subModeId ? cfg.subModeInfo?.[subModeId] : null;

    const mappedMapName = firstText(mapNode, [
      "mapName",
      "sMapName",
      "name",
      "title",
      "displayName"
    ]);
    const mappedDiffName = normalizeDifficultyName(
      firstText(diffNode, [
        "diffName",
        "difficultyName",
        "name",
        "title",
        "displayName"
      ])
    );
    const mappedModeName =
      firstText(subModeNode, ["modeName", "name", "title", "displayName"]) ||
      firstText(modeNode, ["modeName", "name", "title", "displayName"]);
    const rawDiffName =
      firstText(game, ["diffName", "difficultyName"]) || mappedDiffName || game?.diffName;
    const resolvedRoomId = firstText(game, [
      "roomID",
      "DsRoomId",
      "dsRoomId",
      "sRoomID",
      "roomId",
      "iRoomId",
      "roomid",
      "id"
    ]);

    return {
      ...game,
      roomID: resolvedRoomId || game?.roomID,
      mapName: firstText(game, ["mapName", "sMapName"]) || mappedMapName || game?.mapName,
      diffName: normalizeDifficultyName(rawDiffName) || rawDiffName,
      modeName:
        firstText(game, ["modeName", "sModeName", "sTypeName"]) ||
        mappedModeName ||
        game?.modeName
    };
  });
}

function buildOverview(summary, gameList) {
  const totalGames = gameList.length;
  const winCount = gameList.filter((g) => Number(g?.iIsWin) === 1).length;
  const totalScore = gameList.reduce((acc, g) => acc + Number(g?.iScore || 0), 0);
  return {
    totalGames,
    winRate: totalGames ? Number(((winCount / totalGames) * 100).toFixed(2)) : 0,
    avgScore: totalGames ? Math.floor(totalScore / totalGames) : 0,
    officialSummary: summary
  };
}

function calculateRecentStats(validGames) {
  const total = validGames.length;
  if (total === 0) return { totalGames: 0, winRate: 0, avgScore: 0 };
  
  const winCount = validGames.filter(g => Number(g.iIsWin) === 1 || Number(g.iIsWin) === 2).length;
  const totalScore = validGames.reduce((acc, g) => acc + Number(g.iScore || 0), 0);

  return {
    totalGames: total,
    winRate: Number(((winCount / total) * 100).toFixed(2)),
    avgScore: Math.floor(totalScore / total)
  };
}

function calculateModeStats(gameList) {
  const result = {};
  gameList.forEach(g => {
    const rawMode = String(g.modeName || g.sModeName || g.sTypeName || "").toLowerCase();
    let category = "";
    if (rawMode.includes("猎场") || rawMode.includes("僵尸")) category = "僵尸猎场";
    else if (rawMode.includes("塔防")) category = "塔防";
    else if (rawMode.includes("时空追捕")) category = "时空追捕";
    
    if (category) {
      if (!result[category]) {
        result[category] = { matchCount: 0, winCount: 0, lossCount: 0 };
      }
      result[category].matchCount++;
      if (Number(g.iIsWin) === 1 || Number(g.iIsWin) === 2) {
        result[category].winCount++;
      } else {
        result[category].lossCount++;
      }
    }
  });

  return Object.keys(result).map(key => {
    const data = result[key];
    return {
      modeName: key,
      matchCount: data.matchCount,
      winCount: data.winCount,
      lossCount: data.lossCount,
      winRate: data.matchCount > 0 ? Number(((data.winCount / data.matchCount) * 100).toFixed(2)) : 0
    };
  });
}

function calculateMapStats(gameList) {
  const mapGroups = {};
  gameList.forEach(g => {
    const rawMode = String(g.modeName || g.sModeName || g.sTypeName || "").toLowerCase();
    const isTargetMode = ["猎场", "僵尸", "塔防", "时空追捕"].some(t => rawMode.includes(t));
    if (!isTargetMode) return;

    const mapName = g.mapName || "未知地图";
    const diffName = g.diffName || "未知难度";
    
    if (!mapGroups[mapName]) {
      mapGroups[mapName] = { mapName, matchCount: 0, winCount: 0, difficulties: {} };
    }
    const group = mapGroups[mapName];
    group.matchCount++;
    const isWin = Number(g.iIsWin) === 1 || Number(g.iIsWin) === 2;
    if (isWin) group.winCount++;

    if (!group.difficulties[diffName]) {
      group.difficulties[diffName] = { diffName, matchCount: 0, winCount: 0 };
    }
    group.difficulties[diffName].matchCount++;
    if (isWin) group.difficulties[diffName].winCount++;
  });

  return Object.keys(mapGroups).map(key => {
    const group = mapGroups[key];
    const diffList = Object.keys(group.difficulties).map(dk => {
      const d = group.difficulties[dk];
      return {
        diffName: d.diffName,
        matchCount: d.matchCount,
        winCount: d.winCount,
        winRate: d.matchCount > 0 ? Number(((d.winCount / d.matchCount) * 100).toFixed(2)) : 0
      };
    });

    return {
      mapName: group.mapName,
      matchCount: group.matchCount,
      winCount: group.winCount,
      winRate: group.matchCount > 0 ? Number(((group.winCount / group.matchCount) * 100).toFixed(2)) : 0,
      difficulties: diffList
    };
  }).sort((a, b) => b.matchCount - a.matchCount);
}

async function fetchStats(cookie) {
  const normalized = normalizeCookie(cookie);
  logApiRequest("stats:query", {
    endpoint: "stats:get",
    cookieFixed: true
  });

  // Fetch recent 100 games directly from official API (paginated, 2s delay)
  let gameList = await fetchAllGames(normalized, 10, 2000);

  let configMapping = {};
  try {
    configMapping = await fetchConfigList(normalized);
  } catch (_) {
    configMapping = {};
  }

  gameList = applyConfigMappingToGames(gameList, configMapping);

  // Use center.user.stat for Official Summary
  let summary = {};
  try {
    summary = await fetchUserSummary(normalized);
  } catch (_) {}

  // Calculate stats natively
  const recentTargetGames = getRecentTargetGames(gameList);
  const recentStats = calculateRecentStats(recentTargetGames);
  const avgBossDamage = calculateAvgBossDamageFromGames(recentTargetGames);
  const modeStats = calculateModeStats(gameList);
  const mapStats = calculateMapStats(gameList);

  const result = {
    success: true,
    data: {
      gameList,
      overview: {
        totalGames: recentStats.totalGames,
        winRate: recentStats.winRate,
        avgScore: recentStats.avgScore,
        avgBossDamage
      },
      modeStats,
      mapStats,
      configMapping: normalizeConfigPayload(configMapping).raw || {},
      officialSummary: summary
    }
  };
  
  logApiRequest("stats:response", {
    endpoint: "stats:get",
    summary: summarizePayload(result?.data),
    data: result.data
  });
  return result;
}

async function fetchHistory(cookie, query = {}) {
  const normalized = normalizeCookie(cookie);
  const page = Number(query?.page) > 0 ? Number(query.page) : 1;
  const limit = Number(query?.limit) > 0 ? Number(query.limit) : 10;
  const modeType = normalizePositiveIntString(query?.modeType);
  const mapId = normalizePositiveInt(query?.mapId);

  const options = {};
  if (modeType) {
    options.modeType = modeType;
  }
  if (mapId > 0) {
    options.mapId = mapId;
  }

  logApiRequest("history:query", {
    endpoint: "history:get",
    page,
    limit,
    modeType: options?.modeType || null,
    mapId: options?.mapId || null
  });

  const [raw, configPayload] = await Promise.all([
    fetchGamePageRaw(normalized, page, limit, options),
    fetchConfigList(normalized).catch(() => ({}))
  ]);

  const gameList = Array.isArray(raw?.gameList) ? raw.gameList : [];
  const mappedList = applyConfigMappingToGames(gameList, configPayload);

  const totalPages =
    Number(raw?.totalPage) ||
    Number(raw?.pageCount) ||
    Number(raw?.totalPages) ||
    Number(raw?.lastPage) ||
    0;
  const totalCount =
    Number(raw?.totalCount) ||
    Number(raw?.count) ||
    Number(raw?.allCount) ||
    0;

  const result = {
    success: true,
    data: {
      list: mappedList,
      page,
      limit,
      modeType: options?.modeType || null,
      mapId: options?.mapId || null,
      totalPages: totalPages > 0 ? totalPages : null,
      totalCount: totalCount > 0 ? totalCount : null,
      hasMore:
        totalPages > 0
          ? page < totalPages
          : mappedList.length >= limit,
      configMapping: normalizeConfigPayload(configPayload).raw || {}
    }
  };

  logApiRequest("history:response", {
    endpoint: "history:get",
    summary: summarizePayload(result?.data),
    data: result.data
  });
  return result;
}



async function fetchCollection(cookie) {
  const normalized = normalizeCookie(cookie);
  logApiRequest("collection:query", {
    endpoint: "collection:get",
    cookieFixed: true
  });

  const [weaponListResult, trapListResult, pluginListResult] = await Promise.allSettled([
    postOfficialApi(
      normalized,
      "collection.weapon.list",
      { seasonID: 1, queryTime: true },
      OFFICIAL_ENDPOINTS.miniProgramHandbookPage
    ),
    postOfficialApi(
      normalized,
      "collection.trap.list",
      { seasonID: 1 },
      OFFICIAL_ENDPOINTS.miniProgramHandbookPage
    ),
    postOfficialApi(
      normalized,
      "collection.plugin.list",
      { seasonID: 1 },
      OFFICIAL_ENDPOINTS.miniProgramHandbookPage
    )
  ]);

  const weaponList =
    weaponListResult.status === "fulfilled" ? weaponListResult.value : null;
  const trapList =
    trapListResult.status === "fulfilled" ? trapListResult.value : null;
  const pluginList =
    pluginListResult.status === "fulfilled" ? pluginListResult.value : null;

  const weapons = Array.isArray(weaponList?.list) ? weaponList.list : [];
  const traps = Array.isArray(trapList?.list) ? trapList.list : [];
  const plugins = Array.isArray(pluginList?.list) ? pluginList.list : [];

  let homeWeapons = [];

  if (!homeWeapons.length) {
    try {
      const home = await postOfficialApi(
        normalized,
        "collection.home",
        { seasonID: 1, limit: 8 },
        OFFICIAL_ENDPOINTS.miniProgramHandbookPage
      );
      const rawHome = Array.isArray(home?.weaponList) ? home.weaponList : (Array.isArray(home?.home) ? home.home : []);
      homeWeapons = rawHome.filter(item => {
        const prog = item?.itemProgress;
        return prog && typeof prog === "object" && Object.keys(prog).length > 0;
      });
    } catch (_) {
      homeWeapons = [];
    }
  }

  const result = {
    success: true,
    data: {
      summary: {
        weapons: { total: weapons.length, owned: weapons.filter((x) => x?.owned).length },
        traps: { total: traps.length, owned: traps.filter((x) => x?.owned).length },
        plugins: { total: plugins.length, owned: plugins.filter((x) => x?.owned).length }
      },
      home: homeWeapons,
      weapons,
      traps,
      plugins
    }
  };
  logApiRequest("collection:response", {
    endpoint: "collection:get",
    summary: summarizePayload(result?.data),
    data: result.data
  });
  return result;
}

async function fetchDetail(cookie, roomId) {
  const normalized = normalizeCookie(cookie);
  const room = String(roomId || "").trim();
  if (!room) {
    throw new Error("roomId is required");
  }
  logApiRequest("detail:query", {
    endpoint: "detail:get",
    roomId: room
  });

  const [detail, configPayload] = await Promise.all([
    postOfficialApi(
      normalized,
      "center.game.detail",
      { seasonID: 1, roomID: room },
      OFFICIAL_ENDPOINTS.miniProgramRecordInfoPage
    ),
    fetchConfigList(normalized).catch(() => ({}))
  ]);
  const payload = detail && typeof detail === "object" ? detail : {};
  const partitionAreaMap = buildPartitionAreaNameMap(configPayload);

  const result = {
    success: true,
    data: {
      ...payload,
      partitionAreaMap
    }
  };
  logApiRequest("detail:response", {
    endpoint: "detail:get",
    roomId: room,
    summary: summarizePayload(result?.data),
    data: result.data
  });
  return result;
}

module.exports = {
  OFFICIAL_ENDPOINTS,
  EXTERNAL_ENDPOINTS,
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
};

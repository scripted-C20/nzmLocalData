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
  stats: "https://nzm.haman.moe/api/stats",
  homeCollection: "https://nzm.haman.moe/api/collection?type=home"
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

async function fetchAllGames(cookie, maxPages = 10) {
  const list = [];
  for (let page = 1; page <= maxPages; page += 1) {
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

async function fetchExternalStats(cookie) {
  const requestInfo = {
    endpoint: EXTERNAL_ENDPOINTS.stats,
    method: "GET"
  };
  logApiRequest("external:request", requestInfo);
  try {
    const response = await fetch(EXTERNAL_ENDPOINTS.stats, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie
      }
    });

    if (!response.ok) {
      throw new Error(`Stats endpoint failed: ${response.status}`);
    }

    const data = await response.json();
    if (data?.success === false) {
      throw new Error(data?.message || "Stats endpoint returned failure");
    }

    const payload = data?.data || {};
    logApiRequest("external:response", {
      ...requestInfo,
      status: response.status,
      success: data?.success !== false,
      summary: summarizePayload(payload),
      data: payload
    });

    return payload;
  } catch (error) {
    logApiRequest("external:error", {
      ...requestInfo,
      error: error?.message || String(error)
    });
    throw error;
  }
}

async function fetchStats(cookie) {
  const normalized = normalizeCookie(cookie);
  logApiRequest("stats:query", {
    endpoint: "stats:get",
    cookieFixed: true
  });

  let externalData = {};
  try {
    externalData = await fetchExternalStats(normalized);
  } catch (_) {
    externalData = {};
  }

  const externalGameList = Array.isArray(externalData?.gameList) ? externalData.gameList : [];
  let gameList = externalGameList.length
    ? externalGameList
    : await fetchAllGames(normalized, 10);

  let configMapping = {};
  try {
    configMapping = await fetchConfigList(normalized);
  } catch (_) {
    configMapping = {};
  }

  gameList = applyConfigMappingToGames(gameList, configMapping);

  const summary =
    externalData?.officialSummary && typeof externalData.officialSummary === "object"
      ? externalData.officialSummary
      : await fetchUserSummary(normalized);

  const builtOverview = buildOverview(summary, gameList);

  const result = {
    success: true,
    data: {
      overview: {
        ...builtOverview,
        totalGames: Number(externalData?.totalGames) || builtOverview.totalGames,
        winRate: Number(externalData?.winRate) || builtOverview.winRate,
        avgScore:
          Number(externalData?.avgDamage) ||
          Number(externalData?.avgScore) ||
          Number(externalData?.averageScore) ||
          builtOverview.avgScore,
        totalDamage: Number(externalData?.totalDamage) || 0,
        totalDuration: Number(externalData?.totalDuration) || 0,
        totalWin: Number(externalData?.totalWin) || 0,
        totalLoss: Number(externalData?.totalLoss) || 0
      },
      gameList,
      modeStats:
        externalData?.modeStats && typeof externalData.modeStats === "object"
          ? externalData.modeStats
          : {},
      mapStats:
        externalData?.mapStats && typeof externalData.mapStats === "object"
          ? externalData.mapStats
          : {},
      configMapping: normalizeConfigPayload(configMapping).raw || {},
      officialSummary:
        externalData?.officialSummary && typeof externalData.officialSummary === "object"
          ? externalData.officialSummary
          : summary
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

async function fetchExternalHomeCollection(cookie) {
  const requestInfo = {
    endpoint: EXTERNAL_ENDPOINTS.homeCollection,
    method: "GET"
  };
  logApiRequest("external:request", requestInfo);
  try {
    const response = await fetch(EXTERNAL_ENDPOINTS.homeCollection, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie
      }
    });

    if (!response.ok) {
      throw new Error(`Home collection endpoint failed: ${response.status}`);
    }

    const data = await response.json();
    if (data?.success === false) {
      throw new Error(data?.message || "Home collection endpoint returned failure");
    }

    const payload = data?.data;
    const homeList = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.home)
        ? payload.home
        : [];

    logApiRequest("external:response", {
      ...requestInfo,
      status: response.status,
      success: data?.success !== false,
      summary: summarizePayload(homeList),
      data: homeList
    });

    return homeList;
  } catch (error) {
    logApiRequest("external:error", {
      ...requestInfo,
      error: error?.message || String(error)
    });
    throw error;
  }
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
  try {
    homeWeapons = await fetchExternalHomeCollection(normalized);
  } catch (_) {
    homeWeapons = [];
  }

  if (!homeWeapons.length) {
    try {
      const home = await postOfficialApi(
        normalized,
        "collection.home",
        { seasonID: 1, limit: 8 },
        OFFICIAL_ENDPOINTS.miniProgramHandbookPage
      );
      homeWeapons = Array.isArray(home?.weaponList) ? home.weaponList : [];
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

  const detail = await postOfficialApi(
    normalized,
    "center.game.detail",
    { seasonID: 1, roomID: room },
    OFFICIAL_ENDPOINTS.miniProgramRecordInfoPage
  );

  const result = {
    success: true,
    data: detail
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
  fetchConfigList,
  fetchStats,
  fetchHistory,
  fetchCollection,
  fetchDetail
};

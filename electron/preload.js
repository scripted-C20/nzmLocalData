const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nzmApi", {
  getOfficialEndpoints: () => ipcRenderer.invoke("official:get-endpoints"),
  getApiLogBuffer: () => ipcRenderer.invoke("api-log:get-buffer"),
  clearApiLog: () => ipcRenderer.invoke("api-log:clear"),
  onApiLog: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_, entry) => handler(entry);
    ipcRenderer.on("api:log", listener);
    return () => ipcRenderer.removeListener("api:log", listener);
  },
  onApiLogClear: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = () => handler();
    ipcRenderer.on("api:log-clear", listener);
    return () => ipcRenderer.removeListener("api:log-clear", listener);
  },
  getSessionConfig: () => ipcRenderer.invoke("session:get-config"),
  getLatestNotice: () => ipcRenderer.invoke("notice:get-latest"),
  checkNotice: () => ipcRenderer.invoke("notice:check"),
  markNoticeOpened: () => ipcRenderer.invoke("notice:mark-opened"),
  setLogWindowVisible: (visible) =>
    ipcRenderer.invoke("session:set-log-window-visible", visible),
  getLocalStats: () => ipcRenderer.invoke("local:get-stats"),
  clearLocalStats: () => ipcRenderer.invoke("local:clear-stats"),
  clearImportedStatsByMap: (payload) =>
    ipcRenderer.invoke("local:clear-imported-map", payload),
  importLocalStatsXlsx: () => ipcRenderer.invoke("local:import-xlsx"),
  downloadLocalTemplateXlsx: () =>
    ipcRenderer.invoke("local:download-template-xlsx"),
  onLogWindowVisibleChange: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_, visible) => handler(Boolean(visible));
    ipcRenderer.on("session:log-window-visible", listener);
    return () => ipcRenderer.removeListener("session:log-window-visible", listener);
  },
  onNoticeUpdate: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_, payload) => handler(payload);
    ipcRenderer.on("notice:update", listener);
    return () => ipcRenderer.removeListener("notice:update", listener);
  },
  bindAccessToken: (accessTokenOrCookie) =>
    ipcRenderer.invoke("session:bind-access-token", accessTokenOrCookie),
  clearAccessToken: () => ipcRenderer.invoke("session:clear-access-token"),

  // Backward compatibility with older renderer calls.
  bindCookie: (cookie) => ipcRenderer.invoke("session:bind-cookie", cookie),
  clearCookie: () => ipcRenderer.invoke("session:clear-cookie"),

  getStats: () => ipcRenderer.invoke("stats:get"),
  getHistory: (query) => ipcRenderer.invoke("history:get", query),
  getCollection: () => ipcRenderer.invoke("collection:get"),
  getDetail: (roomId) => ipcRenderer.invoke("detail:get", roomId)
});

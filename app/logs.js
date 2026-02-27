function byId(id) {
  return document.getElementById(id);
}

function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("zh-CN");
}

function toPrettyText(value) {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function createLogNode(entry) {
  const item = document.createElement("article");
  item.className = "item";

  const meta = document.createElement("div");
  meta.className = "meta";

  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = String(entry?.kind || "unknown");

  const time = document.createElement("span");
  time.textContent = formatTime(entry?.ts);

  meta.append(kind, time);

  const body = document.createElement("pre");
  body.textContent = toPrettyText(entry?.payload);

  item.append(meta, body);
  return item;
}

function renderEmpty() {
  const list = byId("log-list");
  list.innerHTML = "";

  const empty = document.createElement("div");
  empty.className = "item";
  empty.textContent = "暂无接口日志";
  list.appendChild(empty);
}

function renderBuffer(entries) {
  const list = byId("log-list");
  list.innerHTML = "";

  if (!Array.isArray(entries) || !entries.length) {
    renderEmpty();
    return;
  }

  const ordered = [...entries].sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
  ordered.forEach((entry) => {
    list.appendChild(createLogNode(entry));
  });

  list.scrollTop = list.scrollHeight;
}

function appendEntry(entry) {
  const list = byId("log-list");
  if (!list) return;

  const maybeEmpty = list.firstElementChild;
  if (maybeEmpty && maybeEmpty.textContent === "暂无接口日志") {
    list.innerHTML = "";
  }

  list.appendChild(createLogNode(entry));
  list.scrollTop = list.scrollHeight;
}

async function init() {
  const clearBtn = byId("clear-btn");

  try {
    const bufferResult = await window.nzmApi.getApiLogBuffer();
    renderBuffer(Array.isArray(bufferResult?.data) ? bufferResult.data : []);
  } catch (error) {
    renderBuffer([
      {
        ts: Date.now(),
        kind: "log:error",
        payload: { message: `加载日志失败: ${error?.message || String(error)}` }
      }
    ]);
  }

  window.nzmApi.onApiLog((entry) => {
    appendEntry(entry);
  });

  window.nzmApi.onApiLogClear(() => {
    renderEmpty();
  });

  clearBtn.addEventListener("click", async () => {
    try {
      await window.nzmApi.clearApiLog();
    } catch (error) {
      appendEntry({
        ts: Date.now(),
        kind: "log:error",
        payload: { message: `清空日志失败: ${error?.message || String(error)}` }
      });
    }
  });
}

window.addEventListener("DOMContentLoaded", init);

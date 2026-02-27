# 逆战未来数据统计（Electron）

基于官方接口的桌面客户端，提供数据统计、历史战绩、游戏图鉴、本地历史累计与公告通知。

## 功能概览

- 账号绑定
  - 仅使用 `openid + token(access_token)` 绑定。
  - 账号信息保存在项目目录：`data/account-binding.json`。
- 数据统计
  - 官方历史数据卡片、近期战绩统计、近期模式统计、近期地图详情。
  - 地图/难度映射来自 `center.config.list`。
  - 武器碎片进度显示。
- 历史战绩
  - 接口：`center.user.game.list`。
  - 支持分页、模式筛选、难度筛选、地图筛选（暂不支持）。
  - 支持展开单局详情。
- 本地历史
  - 支持 `xlsx/xls` 导入、模板下载、批次统计、按地图清除导入数据。
  - 支持“仅显示有数据”开关（默认开启）。
- 游戏图鉴
  - 武器/陷阱/插件图鉴与拥有率展示

## 项目结构

- `app/`
  - `index.html` 主界面
  - `renderer.js` 前端逻辑（统计/历史/本地/公告渲染）
  - `styles.css` 样式
  - `logs.html` / `logs.js` 接口日志窗口
- `electron/`
  - `main.js` 主进程、IPC、公告检查、本地文件读写
  - `official-api.js` 官方接口与外部接口封装
  - `preload.js` 安全桥接 API
- `data/`
  - `account-binding.json` 账号绑定信息
  - `notice-state.json` 公告已读状态
- `package.json` 启动与打包配置

## 本地运行

```bash
npm install
npm run start
```

## 打包 EXE（Windows）

```bash
npm run build:win
```

输出目录：`dist/`

## 接口说明（当前）

- 使用的是官方数据接口

## 公告与赞助

通知弹窗支持 Markdown 语法，可直接在公告内容中使用以下赞助二维码：

- 微信赞助  
  ![微信赞助](https://gitee.com/returnee/nzm-notice/raw/master/109ca48c174d1c4960861cc0cba7b114.png)
- 支付宝赞助  
  ![支付宝赞助](https://gitee.com/returnee/nzm-notice/raw/master/5adfe08bd18914fa701ab08bb319915f.jpg)

## 免责声明

本项目仅用于学习和个人研究，非官方客户端。

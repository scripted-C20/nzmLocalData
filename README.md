# 逆战未来数据统计（Electron）

基于官方接口的桌面客户端，提供数据统计、历史战绩、游戏图鉴、本地历史累计与公告通知。
所有数据均来自逆战未来工具箱小程序

## 关于openid和token的获取

- 工具非本人写的 从nzm.haman.moe 里面得到的 注意辨别 自己有更好的抓包方式请勿使用
- 不要把Cookie发送&暴露给任何人！
- 有梯子的
- [工具下载地址](https://1drv.ms/u/c/1ebfb8cb31d9e48a/IQAnCJV8iVLoR5wb9IWGpL_bAeyPHND3ZTXBUyP8eUuxisg?e=DkkS1I)
- 移动云盘
- [下载地址](https://yun.139.com/shareweb/#/w/i/2sUfJiUmha9p0)

## 工具exe下载

- 有梯子的
- [下载地址](https://1drv.ms/u/c/1ebfb8cb31d9e48a/IQDY6zw3MDP2QI7hV6CuXUMHAaap-nNQezsd0jGJ58qtISc?e=ZhCW1o)
- 移动云盘
- [下载地址](https://yun.139.com/shareweb/#/w/i/2sUfJ6TsfFxxs)

## 功能截图

![应用截图1](screenshot/1.png)
![应用截图2](screenshot/2.png)
![应用截图3](screenshot/3.png)

## 功能概览（数据都在本地）

- 隐私保护
  - 所有数据处理均在客户端完成或仅通过代理转发 无服务器运行（公告也是开源公开的）
- 账号绑定
  - 仅使用 `openid + token(access_token)` 绑定。
  - 账号信息保存在项目目录：`data/account-binding.json`。
- 数据统计
  - 官方历史数据卡片、近期战绩统计、近期模式统计、近期地图详情。
  - 武器碎片进度显示。
- 历史战绩
  - 支持分页、模式筛选、难度筛选、地图筛选（暂不支持）。
  - 支持展开单局详情。
- 本地历史
  - 支持 `xlsx/xls` 导入、模板下载、批次统计、按地图清除导入数据。
  - 支持“仅显示有数据”开关（默认开启）。
- 游戏图鉴
  - 武器/陷阱/插件图鉴与拥有率展示

## 本地运行

·已安装 Node.js 环境

```bash
npm install
npm run start
```

## 打包

```bash
npm run build:win
npm run build:mac（没设备自测）
```

输出目录：`dist/`

## 接口说明（当前）

- 使用的是官方数据接口

## 免责声明

本项目仅用于学习和个人研究，非官方客户端。

## 赞助

可直接在公告内容中使用以下赞助二维码：

- 微信赞助  
  ![微信赞助](screenshot/wx.png)
- 支付宝赞助  
  ![支付宝赞助](screenshot/zfb.jpg)

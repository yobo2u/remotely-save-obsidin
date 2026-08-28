# 直连同步（Client Direct Sync）

[English](./README.md) | 中文

Obsidian 插件：把库和 **Google 云端硬盘**、**群晖 NAS**、**QNAP NAS** 做**双向同步**。

跑在 **Obsidian 进程里**。HTTP 用官方 `requestUrl`（绕过 CORS）。**没有作者服务器，也没有本机 Go 旁路。** 远端只有 Google API 和你自己的 NAS。

Apache 2.0。本目录**没有**复制 `pro/`（PolyForm Strict）。

**请先备份库。**

## 安装

1. 编译：`cd clientsync && npm test && npm run build`
2. 把 `manifest.json`、`main.js`、`styles.css` 拷到 `<库>/.obsidian/plugins/client-direct-sync/`
3. 在第三方插件里启用 **Client Direct Sync**

## Google 云盘

1. [启用 Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
2. [凭据](https://console.cloud.google.com/apis/credentials) → OAuth **桌面应用**
3. 重定向 URI：`http://127.0.0.1`（必须和插件里一致）
4. 填入 client ID（不少 Desktop 客户端密钥可空）
5. 打开授权页，浏览器打不开页面时，把**地址栏整段 URL**贴回插件

权限：`drive.file`（只能看到本应用创建的文件）。

## 群晖

走 **DSM File Station**（每台 DSM 都有）。局域网默认 HTTP **5000**（HTTPS **5001**）。桌面可忽略自签证书。

填用户名密码，点 **探测**（仅桌面、只扫本机 RFC1918 /24）或手填 IP，再点 **登录并创建目录**。

## QNAP

走 **QTS File Station**（`authLogin.cgi` + `utilRequest.cgi`）。默认 HTTP **8080**（HTTPS **443**）。操作与群晖相同。

远程目录示例：`/Public/MyVault`、`/home/MyVault`。

## 同步规则

- 默认同步时跳过 `.obsidian`、`.git`、`.trash`
- 删除只有在上一轮快照里对端有过该文件时才会传播
- 冲突默认留较新的；另一份存成 `name.conflict-时间戳.ext`
- Google 和 NAS 可以同时启用（分别做一对双向同步）

## 限制

- 手机：Google 粘贴授权码可用；NAS 必须和手机在同一局域网。后台自动同步可能被系统挂起。
- 第一版没有端到端加密。
- 把插件的 `data.json` 当机密（NAS 密码、Google refresh token）。

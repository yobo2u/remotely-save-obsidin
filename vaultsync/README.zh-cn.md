# vaultsync

[English](./README.md) | 中文

本仓库的 Go 同步引擎：**Obsidian 库 ↔ 群晖 NAS ↔ Google 云端硬盘**，双向同步。

Obsidian 社区插件必须是 JavaScript。真正干活的是这个引擎。可选的桌面助手插件在 [`../obsidian-vaultsync/`](../obsidian-vaultsync/)。手机跑不了 Go 旁路进程，请继续用 TypeScript 版插件。

代码为 **Apache 2.0**，**没有**复制或改写 `pro/`（PolyForm Strict）。

**使用前务必备份库。**

## 做什么

- 读写本地库（默认跳过 `.git`、`.trash`、`vaultsync.json`、`.obsidian`）。
- 分别与下面两端做双向同步：
  - **群晖 DSM File Station**（每台 DSM 都有；WebDAV Server 是可选套件）。
  - **Google Drive**，使用你自己的 OAuth Desktop 客户端（`drive.file` 权限）。
- 两边都配好后，`remote` 为 `all`，各自一份状态文件。
- 删除只有在上一轮快照证明对端曾经有过该文件时才会传播。
- 冲突：`keep_newer`（默认）、`keep_local`、`keep_remote`。败方保存为 `name.conflict-时间戳.ext`。

## 编译

需要 Go 1.22+。

```bash
cd vaultsync
go test ./...
go build -o bin/vaultsync ./cmd/vaultsync
```

## 自动配置

在库目录内运行，或传 `-vault`：

```bash
./bin/vaultsync init -vault /path/to/vault
./bin/vaultsync setup google -vault /path/to/vault -client-id "$GOOGLE_CLIENT_ID"
./bin/vaultsync setup synology -vault /path/to/vault -user "$SYNOLOGY_USER" -password "$SYNOLOGY_PASSWORD"
```

配置写到 `<vault>/.obsidian/vaultsync.json`，权限 `0600`。

### Google 云端硬盘

1. 打开 [启用 Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) 和 [凭据](https://console.cloud.google.com/apis/credentials)。
2. 创建 OAuth **桌面应用**。回调是本机 `http://127.0.0.1`，端口由 `vaultsync` 自动分配。
3. 运行 `setup google`，浏览器授权后本地保存 refresh token。
4. 权限范围是 `drive.file`（只能看到本应用创建/打开的文件）。库对应的云端文件夹由本应用创建。

环境变量：`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`（不少 Desktop 客户端密钥可为空）。

### 群晖 NAS

`setup synology` **只扫描本机网卡的 RFC1918 /24**（不会扫公网），探测 `http://IP:5000/webapi/query.cgi` 是否为 DSM。

登录 File Station，列出共享，并创建 `/home/<库名>`（或 `/homes`、`/docker`，否则第一个共享）。

- DSM HTTPS：端口 **5001**（默认接受自签证书）。
- DSM HTTP：端口 **5000**。
- 可选 `-webdav`：WebDAV Server 套件，端口 **5006** / **5005**。

用 `-host 192.168.1.10` 可跳过扫描。环境变量：`SYNOLOGY_HOST`、`SYNOLOGY_USER`、`SYNOLOGY_PASSWORD`。

## 同步

```bash
./bin/vaultsync sync -vault /path/to/vault
./bin/vaultsync watch -vault /path/to/vault
./bin/vaultsync serve -vault /path/to/vault   # 给 Obsidian 助手用，127.0.0.1:19827
./bin/vaultsync doctor -vault /path/to/vault
```

本机 HTTP（仅回环）：

- `GET /health`
- `POST /sync`
- `GET /config`（不含密钥）

## 限制

- 桌面 / NAS / 自己的机器。不是 Obsidian 手机插件。
- 第一版没有端到端加密。
- Google `drive.file` 看不到其它应用创建的文件。
- File Station 使用你提供的 DSM 账号，把 `vaultsync.json` 当机密保管。

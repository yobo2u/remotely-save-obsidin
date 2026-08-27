# 群晖 Webdav Server

[English](./README.md) | 中文

## 链接

<https://kb.synology.cn/zh-cn/DSM/tutorial/How_to_access_files_on_Synology_NAS_with_WebDAV>

## 注意

教程作者（Remotely Save 作者）**不是** NAS、群晖专家。请仔细阅读文档，并自行改动以适应您自身需求。

**没有设置防火墙和其他保护措施的话，将 NAS 暴露到公网上非常危险。**

## 步骤

本教程有用到群晖 DSM 7。

1. 创建共享文件夹。本教程示例创建了 `share2`。你需要允许某个账号对此的读写权限。

   ![](./synology_create_shared_folder.png)

2. 假设之后你想同步你的库到子文件夹，`哈哈哈/sub folder`，请先在共享文件夹 `share2` 底下创建好。

3. 从套件中心安装 webdav server 。
   ![](./synology_install_webdav_server.png)

4. 进入 webdav server 设置。

5. 如果你知道如何正确配置 https 证书的话，强烈建议开启 https。

   本教程简化示例，开启了 http。

   也设置“Enable DavDepthInfinity”，这可以加速插件连接速度。

   “Apply”。

   ![](./synology_webdav_server_settings.png)

6. 在 Remotely Save 设置页，远程服务选择 **WebDAV**，再把 **服务器预设** 设为 **群晖 NAS（WebDAV Server）**，然后填写：

   - 协议：`https`（端口 **5006**）或 `http`（端口 **5005**）
   - NAS 主机：局域网 IP 或域名（QuickConnect 通常 **不能** 用于 WebDAV）
   - 共享文件夹路径：`share2/哈哈哈/sub folder`

   用户名和密码是对 `share2` 有读写权限的 DSM 账号。

   选择群晖预设后，Depth 会自动设为 “supports depth=infinity”。请在 WebDAV Server 套件中勾选 **DavDepthInfinity**。

   如果更想用通用 WebDAV 模式，也可以直接把完整地址填进「服务器地址」：

   `https://<your synology ip or domain>:5006/<shared folder>/<sub folders>`

   检查连接！

   ![](./synology_remotely_save_settings.png)

7. 同步！

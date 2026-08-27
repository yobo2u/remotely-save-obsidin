# Google 云端硬盘（自建 OAuth 客户端）

这是 `src/` 下、Apache-2.0 许可的适配器，**没有**使用 `pro/` 里原版 PRO Google Drive 实现（PolyForm Strict）。

本插件不是 Google 官方产品，只调用公开的 Drive API，权限范围为 `drive.file`。

## 要求

- Obsidian 1.5.0 或更新（含 1.13；设置页仍用经典 `display()`，因为授权流程需要自定义控件）
- 你自己的 Google Cloud 项目

## Google Cloud 设置

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)。
2. 创建项目。
3. 启用 **Google Drive API**。
4. 配置 OAuth 同意屏幕（个人使用选 External / Testing 即可），把你的 Google 账号加为测试用户。
5. 创建 OAuth 客户端：
   - 类型：**桌面应用**（推荐）或 **Web 应用**
   - 授权重定向 URI：`http://127.0.0.1`（必须与插件设置完全一致）
6. 复制 Client ID。如果 Google 发放了 Client Secret，一并复制。

## 插件设置

1. 在 Remotely Save 中选择 **Google 云端硬盘（自建 OAuth）**。
2. 填入 Client ID、可选 Client Secret、Redirect URI。
3. 点击 **鉴权**，打开链接并允许访问。
4. Google 会跳转到 `http://127.0.0.1/?code=...`。页面可能打不开，从地址栏复制 `code`（或整段 URL）粘贴回插件。
5. 点 **检查连接**，再同步。

插件会在「我的云端硬盘」创建以库名（或自定义远程根目录）命名的文件夹。

## 限制

- `drive.file` 只能看到这个 OAuth 客户端创建的文件。你在 drive.google.com 网页上手工上传的文件插件看不见。
- 请不要在网页上手动创建库文件夹。
- Google Drive 允许同目录重名；插件会选用最近修改的那个。
- 令牌保存在本机。如需断开，访问 https://myaccount.google.com/permissions 。

## 为什么不直接用原版 PRO Google Drive？

原实现位于 `pro/`，协议为 PolyForm Strict 1.0.0，不允许修改或再分发。这个分支另写了一套客户端，因此可以在不订阅 Remotely Save PRO 的情况下同步 Google 云端硬盘。

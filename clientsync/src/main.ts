import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import { discoverNas, pickShare, probeNas } from "./discover";
import { GoogleDriveBackend, exchangeGoogleCode, googleAuthUrl } from "./google";
import { nasTransport, obsidianTransport } from "./http";
import { LocalVault } from "./localVault";
import { obsidianAdapter, vaultFolderName } from "./obsidianFs";
import { QnapBackend } from "./qnap";
import { emptySnapshot, Engine } from "./sync";
import { SynologyBackend } from "./synology";
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
  type Snapshot,
  type SyncResult,
} from "./types";

interface SavedData {
  settings?: PluginSettings;
  snapshots?: Record<string, Snapshot>;
}

export default class ClientDirectSyncPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  snapshots: Record<string, Snapshot> = {};
  private timer: number | null = null;
  private busy = false;

  async onload() {
    await this.loadStore();
    this.addRibbonIcon("sync", "直连同步", () => void this.syncNow());
    this.addCommand({
      id: "client-direct-sync-now",
      name: "立即同步（Google / NAS）",
      callback: () => void this.syncNow(),
    });
    this.addSettingTab(new DirectSyncSettingTab(this.app, this));
    this.resetTimer();
  }

  onunload() {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  resetTimer() {
    if (this.timer !== null) window.clearInterval(this.timer);
    const mins = this.settings.autoSyncMinutes;
    if (mins > 0) {
      this.timer = window.setInterval(() => void this.syncNow(true), mins * 60 * 1000);
    }
  }

  async loadStore() {
    const raw = ((await this.loadData()) ?? {}) as SavedData;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? raw as PluginSettings) };
    this.settings.google = { ...DEFAULT_SETTINGS.google, ...this.settings.google };
    this.settings.synology = { ...DEFAULT_SETTINGS.synology, ...this.settings.synology };
    this.settings.qnap = { ...DEFAULT_SETTINGS.qnap, ...this.settings.qnap };
    this.snapshots = raw.snapshots ?? {};
  }

  async saveStore() {
    await this.saveData({ settings: this.settings, snapshots: this.snapshots } satisfies SavedData);
  }

  http() {
    return obsidianTransport(requestUrl);
  }

  async syncNow(quiet = false) {
    if (this.busy) {
      if (!quiet) new Notice("直连同步正在进行");
      return;
    }
    this.busy = true;
    try {
      const results = await this.runAll();
      const summary = results
        .map(
          (r) =>
            `${r.remote}: +${r.pushed}/↓${r.pulled} 冲突${r.conflicts}` +
            (r.errors.length ? ` 错误${r.errors.length}` : ""),
        )
        .join("；") || "没有已启用的远端";
      new Notice(summary);
      console.log("client-direct-sync", results);
    } catch (e) {
      new Notice("同步失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      this.busy = false;
    }
  }

  private async runAll(): Promise<SyncResult[]> {
    const local = new LocalVault(obsidianAdapter(this.app), this.settings.ignoreDotObsidian);
    const skip = Math.max(0, this.settings.skipLargeMB) * 1024 * 1024;
    const out: SyncResult[] = [];
    const jobs: { key: string; backend: import("./types").Backend }[] = [];
    const http = this.http();

    if (this.settings.google.enabled) {
      if (!this.settings.google.refreshToken) throw new Error("请先完成 Google 授权");
      jobs.push({
        key: "gdrive",
        backend: new GoogleDriveBackend(http, this.settings.google, async (cfg) => {
          this.settings.google = cfg;
          await this.saveStore();
        }),
      });
    }
    if (this.settings.synology.enabled) {
      if (!this.settings.synology.host || !this.settings.synology.username) {
        throw new Error("请先配置群晖");
      }
      jobs.push({
        key: "synology",
        backend: new SynologyBackend(
          nasTransport(http, this.settings.synology.insecureTLS),
          this.settings.synology,
        ),
      });
    }
    if (this.settings.qnap.enabled) {
      if (!this.settings.qnap.host || !this.settings.qnap.username) {
        throw new Error("请先配置 QNAP");
      }
      jobs.push({
        key: "qnap",
        backend: new QnapBackend(
          nasTransport(http, this.settings.qnap.insecureTLS),
          this.settings.qnap,
        ),
      });
    }
    for (const job of jobs) {
      const eng = new Engine(local, job.backend, this.settings.conflict, skip);
      const prev = this.snapshots[job.key] ?? emptySnapshot();
      const { result, next } = await eng.run(prev);
      this.snapshots[job.key] = next;
      await this.saveStore();
      out.push(result);
    }
    return out;
  }
}

class DirectSyncSettingTab extends PluginSettingTab {
  constructor(
    app: import("obsidian").App,
    private plugin: ClientDirectSyncPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "直连同步（Google / 群晖 / QNAP）" });
    containerEl.createEl("p", {
      text: "插件在 Obsidian 进程内直连远端 API（requestUrl 绕过 CORS），不经过作者服务器，也不需要本机 Go 旁路。请先备份库。不要复制 pro/ 代码。",
    });

    new Setting(containerEl)
      .setName("跳过 .obsidian")
      .setDesc("不同步插件配置与工作区（推荐）")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.ignoreDotObsidian).onChange(async (v) => {
          this.plugin.settings.ignoreDotObsidian = v;
          await this.plugin.saveStore();
        }),
      );

    new Setting(containerEl)
      .setName("冲突策略")
      .addDropdown((d) =>
        d
          .addOption("keep_newer", "保留较新")
          .addOption("keep_local", "保留本地")
          .addOption("keep_remote", "保留远端")
          .setValue(this.plugin.settings.conflict)
          .onChange(async (v) => {
            this.plugin.settings.conflict = v as PluginSettings["conflict"];
            await this.plugin.saveStore();
          }),
      );

    new Setting(containerEl)
      .setName("自动同步（分钟）")
      .setDesc("0 表示仅手动。手机在后台可能被系统挂起。")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.autoSyncMinutes)).onChange(async (v) => {
          this.plugin.settings.autoSyncMinutes = Math.max(0, Number(v) || 0);
          await this.plugin.saveStore();
          this.plugin.resetTimer();
        }),
      );

    new Setting(containerEl)
      .setName("跳过大文件（MB）")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.skipLargeMB)).onChange(async (v) => {
          this.plugin.settings.skipLargeMB = Math.max(0, Number(v) || 0);
          await this.plugin.saveStore();
        }),
      );

    new Setting(containerEl).setName("立即同步").addButton((b) =>
      b.setButtonText("同步").setCta().onClick(() => void this.plugin.syncNow()),
    );

    this.googleSection(containerEl);
    this.synologySection(containerEl);
    this.qnapSection(containerEl);
  }

  private googleSection(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Google Drive" });
    containerEl.createEl("p", {
      text: "自备 OAuth 桌面客户端。启用 Drive API → 凭据 → 桌面应用。重定向 URI 填 http://127.0.0.1（与下面一致）。授权后浏览器会打不开页面，请复制地址栏整段 URL 贴回来。",
    });
    const g = this.plugin.settings.google;
    new Setting(containerEl).setName("启用 Google").addToggle((t) =>
      t.setValue(g.enabled).onChange(async (v) => {
        g.enabled = v;
        await this.plugin.saveStore();
      }),
    );
    new Setting(containerEl).setName("OAuth client ID").addText((t) =>
      t.setValue(g.clientId).onChange(async (v) => {
        g.clientId = v.trim();
        await this.plugin.saveStore();
      }),
    );
    new Setting(containerEl)
      .setName("OAuth client secret")
      .setDesc("不少 Desktop 客户端可留空")
      .addText((t) =>
        t.setValue(g.clientSecret).onChange(async (v) => {
          g.clientSecret = v.trim();
          await this.plugin.saveStore();
        }),
      );
    new Setting(containerEl).setName("Redirect URI").addText((t) =>
      t.setValue(g.redirectUri).onChange(async (v) => {
        g.redirectUri = v.trim() || "http://127.0.0.1";
        await this.plugin.saveStore();
      }),
    );
    new Setting(containerEl)
      .setName("云端文件夹名")
      .setDesc("drive.file 只能看到本应用创建的文件夹")
      .addText((t) =>
        t.setPlaceholder(vaultFolderName(this.app)).setValue(g.remoteDir).onChange(async (v) => {
          g.remoteDir = v.trim();
          await this.plugin.saveStore();
        }),
      );
    new Setting(containerEl).setName("打开 Google 授权").addButton((b) =>
      b.setButtonText("打开浏览器").onClick(async () => {
        try {
          const { authUrl, verifier } = await googleAuthUrl({
            clientId: g.clientId,
            redirectUri: g.redirectUri,
          });
          g.pkceVerifier = verifier;
          await this.plugin.saveStore();
          window.open(authUrl);
          new Notice("授权后把地址栏 URL 贴到下面");
        } catch (e) {
          new Notice(e instanceof Error ? e.message : String(e));
        }
      }),
    );
    let code = "";
    new Setting(containerEl)
      .setName("粘贴授权码 / 回调 URL")
      .addText((t) =>
        t.setPlaceholder("http://127.0.0.1/?code=...").onChange((v) => {
          code = v;
        }),
      )
      .addButton((b) =>
        b.setButtonText("交换令牌").onClick(async () => {
          try {
            if (!g.pkceVerifier) throw new Error("请先点「打开浏览器」");
            this.plugin.settings.google = await exchangeGoogleCode(
              this.plugin.http(),
              g,
              code,
              g.pkceVerifier,
            );
            if (!this.plugin.settings.google.remoteDir) {
              this.plugin.settings.google.remoteDir = vaultFolderName(this.app);
            }
            await this.plugin.saveStore();
            new Notice("Google 授权成功");
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );
    containerEl.createEl("p", {
      text: g.refreshToken ? "状态：已授权" : "状态：未授权",
    });
  }

  private synologySection(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "群晖 NAS（File Station）" });
    const s = this.plugin.settings.synology;
    this.nasFields(containerEl, "群晖", s, 5000, async () => {
      const http = nasTransport(this.plugin.http(), s.insecureTLS);
      const backend = new SynologyBackend(http, s);
      const shares = await backend.listShares();
      if (!s.remoteDir) {
        s.remoteDir = pickShare(shares, vaultFolderName(this.app));
      }
      s.enabled = true;
      await backend.ensureRemote();
      await this.plugin.saveStore();
      new Notice("群晖已登录，远程目录 " + s.remoteDir + "；共享: " + shares.join(", "));
      this.display();
    });
  }

  private qnapSection(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "QNAP NAS（File Station）" });
    const s = this.plugin.settings.qnap;
    this.nasFields(containerEl, "QNAP", s, 8080, async () => {
      const http = nasTransport(this.plugin.http(), s.insecureTLS);
      const backend = new QnapBackend(http, s);
      const shares = await backend.listShares();
      if (!s.remoteDir) {
        s.remoteDir = pickShare(shares, vaultFolderName(this.app));
      }
      s.enabled = true;
      await backend.ensureRemote();
      await this.plugin.saveStore();
      new Notice("QNAP 已登录，远程目录 " + s.remoteDir + "；共享: " + shares.join(", "));
      this.display();
    });
  }

  private nasFields(
    containerEl: HTMLElement,
    label: string,
    s: PluginSettings["synology"],
    defaultPort: number,
    onLogin: () => Promise<void>,
  ) {
    new Setting(containerEl).setName("启用 " + label).addToggle((t) =>
      t.setValue(s.enabled).onChange(async (v) => {
        s.enabled = v;
        await this.plugin.saveStore();
      }),
    );
    new Setting(containerEl).setName("地址").addText((t) =>
      t.setPlaceholder("192.168.1.10").setValue(s.host).onChange(async (v) => {
        s.host = v.trim();
        await this.plugin.saveStore();
      }),
    );
    new Setting(containerEl).setName("端口").addText((t) =>
      t.setValue(String(s.port || defaultPort)).onChange(async (v) => {
        s.port = Number(v) || defaultPort;
        await this.plugin.saveStore();
      }),
    );
    new Setting(containerEl).setName("HTTPS").addToggle((t) =>
      t.setValue(s.https).onChange(async (v) => {
        s.https = v;
        if (v && s.port === defaultPort) {
          s.port = label === "QNAP" ? 443 : 5001;
        }
        await this.plugin.saveStore();
      }),
    );
    new Setting(containerEl)
      .setName("允许自签证书（仅桌面）")
      .addToggle((t) =>
        t.setValue(s.insecureTLS).onChange(async (v) => {
          s.insecureTLS = v;
          await this.plugin.saveStore();
        }),
      );
    new Setting(containerEl).setName("用户名").addText((t) =>
      t.setValue(s.username).onChange(async (v) => {
        s.username = v.trim();
        await this.plugin.saveStore();
      }),
    );
    new Setting(containerEl).setName("密码").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(s.password).onChange(async (v) => {
        s.password = v;
        await this.plugin.saveStore();
      });
    });
    new Setting(containerEl)
      .setName("远程目录")
      .setDesc("例如 /home/MyVault 或 /Public/MyVault")
      .addText((t) =>
        t.setValue(s.remoteDir).onChange(async (v) => {
          s.remoteDir = v.trim();
          await this.plugin.saveStore();
        }),
      );
    new Setting(containerEl)
      .setName("局域网探测（仅桌面）")
      .setDesc("只扫本机网卡 RFC1918 /24，不会扫公网")
      .addButton((b) =>
        b.setButtonText("探测").onClick(async () => {
          try {
            const found = await discoverNas(this.plugin.http(), (m) => new Notice(m, 3000));
            if (!found.length) {
              new Notice("没找到 NAS，请手动填 IP");
              return;
            }
            const hit =
              found.find((x) => (label === "QNAP" ? x.kind === "qnap" : x.kind === "synology")) ??
              found[0];
            s.host = hit.host;
            s.port = hit.httpPort;
            s.https = false;
            await this.plugin.saveStore();
            new Notice(
              `发现 ${found.map((x) => x.kind + " " + x.host).join(", ")}，已填入 ${hit.host}`,
            );
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      )
      .addButton((b) =>
        b.setButtonText("登录并创建目录").onClick(async () => {
          try {
            if (s.host) {
              const probed = await probeNas(this.plugin.http(), s.host);
              if (probed) {
                if (!s.port) s.port = probed.httpPort;
              }
            }
            await onLogin();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );
  }
}

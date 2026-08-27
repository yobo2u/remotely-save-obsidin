const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, FileSystemAdapter } = require("obsidian");

const DEFAULT_SETTINGS = {
	sidecarUrl: "http://127.0.0.1:19827",
	binaryPath: "",
	autoStart: true,
};

class VaultsyncPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.child = null;
		this.status = this.addStatusBarItem();
		this.status.addClass("vaultsync-status");
		this.setStatus("idle");

		this.addRibbonIcon("sync", "Vaultsync: sync now", () => {
			void this.syncNow();
		});
		this.addCommand({
			id: "vaultsync-now",
			name: "Sync vault now",
			callback: () => {
				void this.syncNow();
			},
		});
		this.addCommand({
			id: "vaultsync-health",
			name: "Check sidecar health",
			callback: () => {
				void this.checkHealth(true);
			},
		});
		this.addSettingTab(new VaultsyncSettingTab(this.app, this));

		if (this.settings.autoStart) {
			await this.ensureSidecar();
		} else {
			await this.checkHealth(false);
		}
	}

	onunload() {
		if (this.child) {
			try {
				this.child.kill();
			} catch (_) {
				/* ignore */
			}
			this.child = null;
		}
	}

	vaultPath() {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		if (typeof adapter.getBasePath === "function") {
			return adapter.getBasePath();
		}
		return "";
	}

	setStatus(text) {
		this.status.setText("vaultsync: " + text);
	}

	async checkHealth(notify) {
		try {
			const res = await requestUrl({
				url: this.settings.sidecarUrl.replace(/\/$/, "") + "/health",
				method: "GET",
			});
			const body = typeof res.json === "object" && res.json ? res.json : {};
			this.setStatus("ready");
			if (notify) {
				new Notice("vaultsync sidecar is running (" + (body.remote || "?") + ")");
			}
			return true;
		} catch (err) {
			this.setStatus("offline");
			if (notify) {
				new Notice("vaultsync sidecar is not running. Start: vaultsync serve --vault <path>");
			}
			return false;
		}
	}

	async ensureSidecar() {
		if (await this.checkHealth(false)) {
			return true;
		}
		if (!this.settings.binaryPath) {
			this.setStatus("offline");
			return false;
		}
		const vault = this.vaultPath();
		if (!vault) {
			new Notice("vaultsync: this helper is desktop-only and needs a local vault path");
			return false;
		}
		try {
			const { spawn } = require("child_process");
			this.child = spawn(this.settings.binaryPath, ["serve", "--vault", vault], {
				detached: false,
				stdio: "ignore",
			});
			this.child.on("exit", () => {
				this.child = null;
				this.setStatus("offline");
			});
			await sleep(800);
			return await this.checkHealth(false);
		} catch (err) {
			new Notice("vaultsync: failed to start sidecar: " + err);
			return false;
		}
	}

	async syncNow() {
		const ok = await this.ensureSidecar();
		if (!ok) {
			new Notice("vaultsync sidecar is offline. Run `vaultsync serve` or set the binary path in settings.");
			return;
		}
		this.setStatus("syncing");
		try {
			const res = await requestUrl({
				url: this.settings.sidecarUrl.replace(/\/$/, "") + "/sync",
				method: "POST",
			});
			const body = typeof res.json === "object" && res.json ? res.json : {};
			if (!body.ok) {
				this.setStatus("error");
				new Notice("vaultsync error: " + (body.error || JSON.stringify(body)));
				return;
			}
			this.setStatus("ok");
			new Notice("vaultsync finished: " + summarize(body.result));
		} catch (err) {
			this.setStatus("error");
			new Notice("vaultsync request failed: " + err);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class VaultsyncSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Vaultsync (Go sidecar)" });
		containerEl.createEl("p", {
			text: "This plugin does not sync by itself. It talks to a local vaultsync process on 127.0.0.1. Mobile is not supported.",
		});

		new Setting(containerEl)
			.setName("Sidecar URL")
			.setDesc("Must match vaultsync.json listen (default http://127.0.0.1:19827)")
			.addText((text) =>
				text.setValue(this.plugin.settings.sidecarUrl).onChange(async (value) => {
					this.plugin.settings.sidecarUrl = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("vaultsync binary")
			.setDesc("Optional. Absolute path to the vaultsync executable so Obsidian can start `vaultsync serve`.")
			.addText((text) =>
				text.setValue(this.plugin.settings.binaryPath).onChange(async (value) => {
					this.plugin.settings.binaryPath = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Start sidecar automatically")
			.setDesc("If the binary path is set, spawn vaultsync serve when Obsidian opens.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
					this.plugin.settings.autoStart = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Sync now")
			.addButton((btn) =>
				btn.setButtonText("Run").onClick(() => {
					void this.plugin.syncNow();
				}),
			);
	}
}

function summarize(result) {
	if (!result || !result.results) {
		return JSON.stringify(result || {});
	}
	const parts = [];
	for (const [name, r] of Object.entries(result.results)) {
		parts.push(
			name +
				" + " +
				(r.pushed || 0) +
				" / - " +
				(r.pulled || 0) +
				" conflict " +
				(r.conflicts || 0),
		);
	}
	return parts.join("; ") || "no changes";
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = VaultsyncPlugin;

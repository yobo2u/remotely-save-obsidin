import cloneDeep from "lodash/cloneDeep";
import { type App, Modal, Notice, Setting } from "obsidian";
import {
  DEFAULT_GDRIVE_CONFIG,
  sendGDriveAuthReq,
  setGDriveConfigBySuccessfulAuth,
} from "./fsGDrive";
import { getClient } from "./fsGetter";
import { generateGDriveAuthUrl } from "./gdriveAuth";
import type { TransItemType } from "./i18n";
import type RemotelySavePlugin from "./main";
import { stringToFragment } from "./misc";
import { ChangeRemoteBaseDirModal, wrapTextWithPasswordHide } from "./settings";

class GDriveAuthModal extends Modal {
  readonly plugin: RemotelySavePlugin;
  readonly authDiv: HTMLDivElement;
  readonly revokeAuthDiv: HTMLDivElement;
  readonly t: (x: TransItemType, vars?: any) => string;
  constructor(
    app: App,
    plugin: RemotelySavePlugin,
    authDiv: HTMLDivElement,
    revokeAuthDiv: HTMLDivElement,
    t: (x: TransItemType, vars?: any) => string
  ) {
    super(app);
    this.plugin = plugin;
    this.authDiv = authDiv;
    this.revokeAuthDiv = revokeAuthDiv;
    this.t = t;
  }

  async onOpen() {
    const { contentEl } = this;
    const t = this.t;
    const cfg = this.plugin.settings.gdrive;
    if (cfg.clientID.trim() === "") {
      contentEl.createEl("p", { text: t("modal_gdriveauth_need_clientid") });
      return;
    }

    const { authUrl, verifier } = await generateGDriveAuthUrl({
      clientID: cfg.clientID,
      redirectUri: cfg.redirectUri,
    });

    contentEl.createEl("p", {
      text: t("modal_gdriveauth_tutorial"),
    });
    contentEl.createEl("p").createEl("a", {
      href: authUrl,
      text: authUrl,
    });
    new Setting(contentEl)
      .setName(t("modal_gdriveauth_copybutton"))
      .addButton((button) => {
        button.setButtonText(t("modal_gdriveauth_copybutton"));
        button.onClick(async () => {
          await navigator.clipboard.writeText(authUrl);
          new Notice(t("modal_gdriveauth_copynotice"));
        });
      });

    let pasted = "";
    new Setting(contentEl)
      .setName(t("modal_gdriveauth_manualinput"))
      .setDesc(t("modal_gdriveauth_manualinput_desc"))
      .addText((text) =>
        text.setPlaceholder("4/0A...").onChange((val) => {
          pasted = val.trim();
        })
      )
      .addButton((button) => {
        button.setButtonText(t("submit"));
        button.onClick(async () => {
          new Notice(t("modal_gdriveauth_manualinput_notice"));
          try {
            const token = await sendGDriveAuthReq(
              cfg.clientID,
              cfg.clientSecret,
              cfg.redirectUri,
              verifier,
              pasted
            );
            setGDriveConfigBySuccessfulAuth(cfg, token, Date.now());
            await this.plugin.saveSettings();
            this.authDiv.toggleClass(
              "gdrive-auth-button-hide",
              cfg.refreshToken !== ""
            );
            this.revokeAuthDiv.toggleClass(
              "gdrive-revoke-auth-button-hide",
              cfg.refreshToken === ""
            );
            new Notice(t("modal_gdriveauth_manualinput_succ_notice"));
            this.close();
          } catch (e) {
            console.error(e);
            new Notice(`${t("modal_gdriveauth_manualinput_fail_notice")} ${e}`);
          }
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export const generateGDriveSettingsPart = (
  containerEl: HTMLElement,
  t: (x: TransItemType, vars?: any) => string,
  app: App,
  plugin: RemotelySavePlugin,
  saveUpdatedConfigFunc: () => Promise<any>
) => {
  const gdriveDiv = containerEl.createEl("div", { cls: "gdrive-hide" });
  gdriveDiv.toggleClass(
    "gdrive-hide",
    plugin.settings.serviceType !== "gdrive"
  );
  gdriveDiv.createEl("h2", { text: t("settings_gdrive") });

  const longDesc = gdriveDiv.createEl("div", { cls: "settings-long-desc" });
  for (const c of [
    t("settings_gdrive_disclaimer1"),
    t("settings_gdrive_disclaimer2"),
  ]) {
    longDesc.createEl("p", { text: c, cls: "gdrive-disclaimer" });
  }
  longDesc.createEl("p", {
    text: t("settings_gdrive_folder", {
      remoteBaseDir:
        plugin.settings.gdrive.remoteBaseDir || app.vault.getName(),
    }),
  });
  longDesc.createEl("p", {
    text: stringToFragment(t("settings_gdrive_oauth_help")),
  });

  new Setting(gdriveDiv)
    .setName(t("settings_gdrive_clientid"))
    .setDesc(t("settings_gdrive_clientid_desc"))
    .addText((text) =>
      text
        .setPlaceholder("xxxxx.apps.googleusercontent.com")
        .setValue(plugin.settings.gdrive.clientID)
        .onChange(async (value) => {
          plugin.settings.gdrive.clientID = value.trim();
          await plugin.saveSettings();
        })
    );

  new Setting(gdriveDiv)
    .setName(t("settings_gdrive_clientsecret"))
    .setDesc(t("settings_gdrive_clientsecret_desc"))
    .addText((text) => {
      wrapTextWithPasswordHide(text);
      text
        .setPlaceholder("")
        .setValue(plugin.settings.gdrive.clientSecret)
        .onChange(async (value) => {
          plugin.settings.gdrive.clientSecret = value.trim();
          await plugin.saveSettings();
        });
    });

  new Setting(gdriveDiv)
    .setName(t("settings_gdrive_redirect"))
    .setDesc(t("settings_gdrive_redirect_desc"))
    .addText((text) =>
      text
        .setPlaceholder("http://127.0.0.1")
        .setValue(plugin.settings.gdrive.redirectUri)
        .onChange(async (value) => {
          plugin.settings.gdrive.redirectUri =
            value.trim() || "http://127.0.0.1";
          await plugin.saveSettings();
        })
    );

  const authDiv = gdriveDiv.createDiv({
    cls: "gdrive-auth-button-hide settings-auth-related",
  });
  const revokeAuthDiv = gdriveDiv.createDiv({
    cls: "gdrive-revoke-auth-button-hide settings-auth-related",
  });

  new Setting(revokeAuthDiv)
    .setName(t("settings_gdrive_revoke"))
    .setDesc(t("settings_gdrive_revoke_desc"))
    .addButton((button) => {
      button.setButtonText(t("settings_gdrive_revoke_button"));
      button.onClick(async () => {
        try {
          const client = getClient(
            plugin.settings,
            app.vault.getName(),
            saveUpdatedConfigFunc
          );
          await client.revokeAuth();
        } catch (e) {
          console.error(e);
        }
        const keptClientID = plugin.settings.gdrive.clientID;
        const keptSecret = plugin.settings.gdrive.clientSecret;
        const keptRedirect = plugin.settings.gdrive.redirectUri;
        plugin.settings.gdrive = cloneDeep(DEFAULT_GDRIVE_CONFIG);
        plugin.settings.gdrive.clientID = keptClientID;
        plugin.settings.gdrive.clientSecret = keptSecret;
        plugin.settings.gdrive.redirectUri = keptRedirect;
        await plugin.saveSettings();
        authDiv.toggleClass(
          "gdrive-auth-button-hide",
          plugin.settings.gdrive.refreshToken !== ""
        );
        revokeAuthDiv.toggleClass(
          "gdrive-revoke-auth-button-hide",
          plugin.settings.gdrive.refreshToken === ""
        );
        new Notice(t("settings_gdrive_revoke_notice"));
      });
    });

  new Setting(authDiv)
    .setName(t("settings_gdrive_auth"))
    .setDesc(t("settings_gdrive_auth_desc"))
    .addButton((button) => {
      button.setButtonText(t("settings_gdrive_auth_button"));
      button.onClick(() => {
        new GDriveAuthModal(app, plugin, authDiv, revokeAuthDiv, t).open();
      });
    });

  authDiv.toggleClass(
    "gdrive-auth-button-hide",
    plugin.settings.gdrive.refreshToken !== ""
  );
  revokeAuthDiv.toggleClass(
    "gdrive-revoke-auth-button-hide",
    plugin.settings.gdrive.refreshToken === ""
  );

  let newRemoteBaseDir = plugin.settings.gdrive.remoteBaseDir || "";
  new Setting(gdriveDiv)
    .setName(t("settings_remotebasedir"))
    .setDesc(t("settings_remotebasedir_desc"))
    .addText((text) =>
      text
        .setPlaceholder(app.vault.getName())
        .setValue(newRemoteBaseDir)
        .onChange((value) => {
          newRemoteBaseDir = value.trim();
        })
    )
    .addButton((button) => {
      button.setButtonText(t("confirm"));
      button.onClick(() => {
        new ChangeRemoteBaseDirModal(
          app,
          plugin,
          newRemoteBaseDir,
          "gdrive"
        ).open();
      });
    });

  new Setting(gdriveDiv)
    .setName(t("settings_checkonnectivity"))
    .setDesc(t("settings_checkonnectivity_desc"))
    .addButton((button) => {
      button.setButtonText(t("settings_checkonnectivity_button"));
      button.onClick(async () => {
        new Notice(t("settings_checkonnectivity_checking"));
        const client = getClient(
          plugin.settings,
          app.vault.getName(),
          saveUpdatedConfigFunc
        );
        const errors = { msg: "" };
        const res = await client.checkConnect((err: any) => {
          errors.msg = `${err}`;
        });
        if (res) {
          new Notice(t("settings_gdrive_connect_succ"));
        } else {
          new Notice(t("settings_gdrive_connect_fail"));
          new Notice(errors.msg);
        }
      });
    });

  return { gdriveDiv };
};

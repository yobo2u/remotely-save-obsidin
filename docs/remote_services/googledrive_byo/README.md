# Google Drive (Bring Your Own OAuth client)

This is an Apache-2.0 adapter in `src/`. It does **not** use the original PRO Google Drive implementation under `pro/` (PolyForm Strict).

It is **not** an official Google product. It uses the public Drive API with the `drive.file` scope.

## Requirements

- Obsidian 1.5.0 or newer (1.13 is supported; settings still use the classic `display()` UI because the OAuth flow needs custom controls)
- A Google Cloud project that you own

## Google Cloud setup

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project.
3. Enable **Google Drive API**.
4. Configure the OAuth consent screen (External / Testing is enough for personal use). Add your Google account as a test user.
5. Create OAuth client ID:
   - Type: **Desktop app** (recommended) or **Web application**
   - Authorized redirect URI: `http://127.0.0.1` (must match the plugin setting exactly)
6. Copy Client ID. Copy Client Secret if Google issued one.

## Plugin setup

1. In Remotely Save, choose **Google Drive (self OAuth)**.
2. Paste Client ID, optional Client Secret, and Redirect URI.
3. Click **Auth**, open the URL, allow access.
4. Google redirects to `http://127.0.0.1/?code=...`. The page may fail to load. Copy the `code` value (or the whole URL) and paste it back.
5. Click **Check connectivity**, then sync.

The plugin creates a folder named after your vault (or your custom remote base dir) in My Drive.

## Limits

- `drive.file` only sees files created by this OAuth client. Files you upload on drive.google.com are invisible.
- Do not create the vault folder manually on the website.
- Google Drive allows duplicate names in one folder; the plugin keeps the newest match.
- Tokens stay on your device. Revoke at https://myaccount.google.com/permissions if needed.

## Why not the original PRO Google Drive?

The original adapter lives in `pro/` under PolyForm Strict License 1.0.0, which forbids modifying or redistributing that code. This fork implements a separate client so Google Drive sync works without a Remotely Save PRO subscription.

# QH OpenWorker fork identity

This fork keeps upstream-compatible internal names where they reduce merge friction, but
public product, bundle, data, and release identities are qh-owned.

## Product and bundle identity

- Product name: `QH OpenWorker`
- macOS / Windows bundle identifier: `com.qianhaoq.qhopenworker`
- Rust crate/internal sidecar names may remain `openworker-*` for upstream compatibility.
- The Python sidecar executable remains `openworker-server` so existing launcher paths and
  PyInstaller specs continue to work.

## Local state directory

State directory resolution is shared by Python and the Tauri shell:

1. `QH_OPENWORKER_STATE_DIR`
2. legacy-compatible `COWORKER_STATE_DIR`
3. Windows default: `%APPDATA%\qh-openworker`
4. macOS / Linux default: `~/.config/qh-openworker`

## Release artifact identity

Stable public artifact names use the `QH-OpenWorker` prefix:

- `QH-OpenWorker-macos-arm64.dmg`
- `QH-OpenWorker-macos-x64.dmg`
- `QH-OpenWorker-windows-setup.exe`
- `QH-OpenWorker-windows.msi`

Lowercase service/directory identifiers should use `qh-openworker`.

## Update strategy

The updater is disabled by default. The app must not check, download, generate, or upload
`latest.json` until qh owns both:

- a qh-controlled updater endpoint, and
- a qh-owned Tauri updater signing key.

`packaging/make_update_manifest.py` therefore exits without writing a manifest unless
explicitly invoked with `--enabled`. Release CI also removes/avoids `dist/latest.json`.

## Signing secrets

Apple notarization/signing and Windows Authenticode signing must use qh-owned secrets.
Do not reuse upstream OpenWorker signing material.

Expected secret categories:

- Apple Developer ID certificate and App Store Connect notarization key.
- Windows Authenticode certificate/key material.
- Future Tauri updater private key, only after updater endpoint ownership is established.

This document intentionally contains no real keys, tokens, certificates, or passwords.

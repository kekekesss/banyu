# Third-party notices

This repository is the developer-source edition. It contains no bundled Node.js runtime, installed dependencies, QQ/DSH clients, LLBot/PMHQ binaries, login state or user configuration. Install dependencies using the lockfile; their own license files are retained by npm. References below to Windows packages describe the separately prepared distribution, not files included in this source repository.

This project does not contain SnowLuma or its proprietary native components.

Version 1.1.0 adds an independently written LocalQQ manager that controls a separately installed, unmodified LuckyLilliaBot 8.3.2 release over fixed loopback management and OneBot APIs. The source repository is https://github.com/LLOneBot/LuckyLilliaBot (GPL-2.0). Bundled native signing components and authorization services remain third-party components under their respective terms; this project does not assert that those components were independently implemented or that their use is offline. The release ZIP excludes components/, all QQ binaries and all login material. Install-QQCore.ps1 downloads the original upstream archive with a pinned SHA-256. No upstream code is copied into this manager, and no upstream notices are removed.

Version 1.2.0 also manages the unchanged PMHQ executable and DLL from the same pinned upstream archive in explicit inline mode. QQ remains separately installed; its original login data and licenses are retained. Neither QQ nor PMHQ binaries are included in the workbench release ZIP. The desktop manager checks each PMHQ file against the official archive hash before use.

The 2.0 edition uses Banyu's original in-process QQ chat engine, management UI, OneBot transport and process supervisor. It does not ship or run the qq-bridge chat engine, SnowLuma SDK or SnowLuma MCP. The DSH-only connection adapter listed below is retained under its MIT license; no claim of independent authorship is made for that adapter.

The local installation may migrate the owner's existing roles and configuration into its protected data directories. Packaging selects code and dependencies only and does not include that migrated data. LLBot/PMHQ, QQ and DSH applications are still obtained separately; each user supplies their own accounts and authorization. The Share ZIP does not contain anyone's configuration or login state. The QQ integration runs one chat responder and does not copy native SnowLuma components.

- `vendor/dsh-client.js` is adapted from Derpyu520/qq-bridge (MIT), copyright 2026 Derpyu520 and qq-bridge / QSH contributors. Full notice: `vendor/LICENSE-qq-bridge`.
- `@tencent-connect/qqbot-nodejs`: Tencent QQ official Node.js SDK, MIT. https://github.com/tencent-connect/qqbot-nodejs
- The Weixin channel is an independently implemented text adapter using the documented protocol of Tencent/openclaw-weixin (MIT). Protocol reference and upstream notice: https://github.com/Tencent/openclaw-weixin ; `vendor/LICENSE-openclaw-weixin`.
- `qrcode`: MIT; `js-yaml`: MIT; `@deepseek-ai/dsh-host-apiproxy`: see the license shipped with that dependency. Dependency license files remain in the installed packages.
- The Windows package includes Node.js 24.14.0. Node.js and its bundled components retain the full notices in `runtime/LICENSE-node.txt`. The installed dependency inventory is in `DEPENDENCIES.json` (MIT, ISC and Python-2.0 licenses). All original dependency license files are retained.

Weixin protocol compatibility was checked against upstream 2.4.10 on 2026-10-18. This adapter is an independent client, not an official Tencent desktop application.

Open-source software licenses do not grant platform accounts, API permissions, or exemption from platform usage rules. The optional official QQ bot connector uses QQ Open Platform credentials; ordinary QQ account integration uses a separately installed client and third-party components. The Weixin connector implements direct conversations; ordinary Weixin group conversations are not enabled.

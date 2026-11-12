# Linux Shell third-party sources

- iSH ARM64: OpenMinis/ish-arm64, commit `0fd17a135e78b7a0cf08a4f5831217bbb76ed22f`. Copyright notices and authors: `ish-GPL-3.0.md`. License: GPLv3 and `LICENSE.IOS`.
- PRoot: OpenMinis/proot, commit `8b31a69345730692f2f49a88694fdcaec78b2031`. Copyright STMicroelectronics and contributors. License and authors: `proot-GPL-2.0.txt`.
- Termux PRoot loader: proot 5.1.107-70, supplied by OpenMinis commit `1a71df0f381cefde80bf912b723de6f9831bc177`; exact SHA-256 is in `sources.lock.json`.
- talloc 2.4.2: Copyright Andrew Tridgell (2004), Stefan Metzmacher (2006), Samba contributors. LGPLv3 or later; see `LGPL-3.0.txt`. Source: https://download.samba.org/pub/talloc/talloc-2.4.2.tar.gz
- Alpine Linux 3.21.3 aarch64 minirootfs: package authors retain their individual licenses. Distribution and matching sources: https://dl-cdn.alpinelinux.org/alpine/v3.21/ and https://pkgs.alpinelinux.org/packages?branch=v3.21&arch=aarch64
- Codex CLI 0.167.2, Linux ARM64 musl: Copyright OpenAI. Apache-2.0; see `codex-Apache-2.0.txt`. Official source: https://github.com/openai/codex/tree/rust-v0.167.2 ; the official npm artifact is pinned in `sources.lock.json`.

The Super LOOI iSH host bridge is `apps/nsh/native/linux/ish_host.m`. Complete application source and build instructions are described in `docs/nsh-linux-shell.md`.

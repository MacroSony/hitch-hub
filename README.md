# Remote Agent Hub

A lightweight, self-hosted, chat-native control plane for local coding agents.

This repository is currently implementing Iteration 1 from `implementation_steps.md`: a minimal local control path with config loading, session state, a fake adapter for repeatable testing, and the Pi RPC backend boundary.

## Development

Use `npm.cmd` from PowerShell on Windows if script execution policy blocks npm's `.ps1` shim.

```powershell
& 'C:\Program Files\nodejs\npm.cmd' install
& 'C:\Program Files\nodejs\npm.cmd' run typecheck
& 'C:\Program Files\nodejs\npm.cmd' run smoke:fake
```

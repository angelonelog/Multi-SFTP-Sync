# Multi SFTP Sync

Secure multi-server SFTP sync for VS Code.

Upload, download, compare, and synchronize files across multiple servers with security-first defaults and predictable transfer behavior.

Author: **YIBIN WU**

Repository: **https://github.com/angelonelog/Multi-SFTP-Sync**

## Why This Extension

- Manage multiple SFTP targets in one workspace.
- Keep deployment workflow simple: save, sync, verify.
- Get safer defaults out of the box (host key verification, credential migration, path and delete guards).

## Features

### Daily Workflow

- Upload current file to all configured servers
- Upload workspace to all servers
- Download file or directory from remote server
- Compare local file with remote file
- Sync local to remote and remote to local
- Browse remote files in the sidebar

### Multi-Server Sync Modes

This extension supports multiple SFTP servers in one workspace, including:

1. **Same directory on multiple servers**
   - Deploy the same local files to the same remote path across different servers (for example, production cluster nodes).

2. **Different directory per server**
   - Deploy to different remote paths on each server (for example, `/var/www/site-a` on Server A and `/srv/app` on Server B).

You can also define `pathMappings` per server when different local folders must be synced to different remote folders.

### Security and Safety

- Host key policy: `tofu` (default), `strict`, or `off`
- Auto-migrate plaintext `password` and `passphrase` to VS Code SecretStorage
- Block local and remote path traversal
- Block dangerous deletes for critical remote paths (including `/`)
- Manual host trust and trust removal commands

### Reliability and Performance

- Connection reuse with pooling
- Global transfer concurrency cap (`maxConcurrent`)
- Runtime retry and timeout support
- Cooperative cancellation for long-running operations
- Remote explorer list cache with refresh invalidation
- Short-window duplicate operation deduplication

## Quick Start (3 Steps)

1. Install **Multi SFTP Sync** from VS Code Marketplace.
2. Create `.vscode/sftp.json` in your workspace.
3. Run `Multi SFTP: Upload Current File`.

Example `.vscode/sftp.json`:

```json
[
  {
    "name": "Production",
    "host": "example.com",
    "port": 22,
    "username": "deploy",
    "password": "bootstrap-only",
    "remotePath": "/var/www/app",
    "ignore": [
      ".vscode/**",
      ".git/**",
      "node_modules/**"
    ],
    "pathMappings": [
      {
        "local": "frontend/dist",
        "remote": "/var/www/html"
      },
      {
        "local": "backend",
        "remote": "/var/www/api"
      }
    ]
  }
]
```

## Most Used Commands

- `Multi SFTP: Upload Current File`
- `Multi SFTP: Upload All to Servers`
- `Multi SFTP: Download File from Server`
- `Multi SFTP: Compare with Remote`
- `Multi SFTP: Sync Local to Remote`
- `Multi SFTP: Sync Remote to Local`
- `Multi SFTP Security: Trust Host Key Now`

## Security Model

### Host Key Policy

- `tofu`: trust first-seen key and store it; block mismatches later.
- `strict`: block unknown hosts until manually trusted.
- `off`: disable host key verification (compatibility fallback).

### Credential Handling

- Plaintext values in `.vscode/sftp.json` are auto-migrated to SecretStorage when enabled.
- Runtime always prefers SecretStorage values when present.
- Migration does not rewrite `.vscode/sftp.json`.

## Configuration

### Transfer Settings

- `multiSftpSync.autoUpload` (default: `true`)
- `multiSftpSync.autoDelete` (default: `true`)
- `multiSftpSync.autoDownload` (default: `false`)
- `multiSftpSync.showProgress` (default: `true`)
- `multiSftpSync.maxConcurrent` (default: `5`)
- `multiSftpSync.retryTimes` (default: `3`)
- `multiSftpSync.connectionTimeout` (default: `10000`)

### Security Settings

- `multiSftpSync.security.hostKeyPolicy` (default: `tofu`)
- `multiSftpSync.security.autoMigrateCredentials` (default: `true`)
- `multiSftpSync.security.trustStorePath` (default: empty, uses extension global storage)

### Safety Settings

- `multiSftpSync.safety.blockPathTraversal` (default: `true`)
- `multiSftpSync.safety.blockCriticalDeletes` (default: `true`)
- `multiSftpSync.safety.criticalRemotePaths` (default: `["/", "/root", "/etc", "/var", "/home"]`)

## Troubleshooting

### Host Key Mismatch

1. Verify the server host key changed intentionally.
2. Run `Multi SFTP Security: Remove Trusted Host`.
3. Reconnect, or run `Multi SFTP Security: Trust Host Key Now`.

### Credential Migration Warning

- The extension copied plaintext credentials to SecretStorage.
- Keep `.vscode/sftp.json` out of version control.
- Remove plaintext credentials when your workflow allows.

## License

MIT License. See [LICENSE](https://github.com/angelonelog/Multi-SFTP-Sync/blob/HEAD/LICENSE).

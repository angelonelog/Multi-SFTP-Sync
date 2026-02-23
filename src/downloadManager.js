const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const {
    assertLocalPathInsideWorkspace,
    assertRemotePathSafe
} = require('./security/pathGuard');

class DownloadManager {
    constructor(options = {}) {
        this.connectionManager = options.connectionManager;
        this.outputChannel = options.outputChannel;
        this.getSafetyConfig = options.getSafetyConfig || (() => ({ blockPathTraversal: true }));
        this.logger = options.logger || (() => {});
    }

    _log(message) {
        if (this.outputChannel) {
            this.outputChannel.appendLine(message);
        }
    }

    _throwIfCanceled(token) {
        if (token && token.isCancellationRequested) {
            const error = new Error('Operation canceled');
            error.code = 'OPERATION_CANCELED';
            throw error;
        }
    }

    _applyPathGuard(config, remotePath, localPath, workspaceRoot) {
        const safety = this.getSafetyConfig();
        const guardedRemotePath = assertRemotePathSafe(
            config.remotePath,
            remotePath,
            { enabled: safety.blockPathTraversal !== false }
        );

        const guardedLocalPath = workspaceRoot
            ? assertLocalPathInsideWorkspace(workspaceRoot, localPath, { enabled: safety.blockPathTraversal !== false })
            : path.resolve(localPath);

        return { guardedRemotePath, guardedLocalPath };
    }

    async downloadFile(config, remotePath, localPath, options = {}) {
        const serverName = config.name || config.host;
        const token = options.token;
        const workspaceRoot = options.workspaceRoot;

        try {
            this._throwIfCanceled(token);
            const guarded = this._applyPathGuard(config, remotePath, localPath, workspaceRoot);
            const guardedRemotePath = guarded.guardedRemotePath;
            const guardedLocalPath = guarded.guardedLocalPath;

            this._log(`\n[${serverName}] Download: ${guardedRemotePath}`);
            this._log(`  → ${guardedLocalPath}`);

            const sftp = await this.connectionManager.getConnection(config);
            this._throwIfCanceled(token);

            const localDir = path.dirname(guardedLocalPath);
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }

            await sftp.get(guardedRemotePath, guardedLocalPath);
            this._throwIfCanceled(token);

            this._log('  ✓ Download successful');
            return { success: true, localPath: guardedLocalPath };
        } catch (error) {
            this._log(`  ✗ Download failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async downloadDirectory(config, remotePath, localPath, progress, options = {}) {
        const serverName = config.name || config.host;
        const token = options.token;
        const workspaceRoot = options.workspaceRoot;

        try {
            this._throwIfCanceled(token);
            const guarded = this._applyPathGuard(config, remotePath, localPath, workspaceRoot);
            const guardedRemotePath = guarded.guardedRemotePath;
            const guardedLocalPath = guarded.guardedLocalPath;

            this._log(`\n[${serverName}] Download directory: ${guardedRemotePath}`);
            this._log(`  → ${guardedLocalPath}`);

            const sftp = await this.connectionManager.getConnection(config);
            if (!fs.existsSync(guardedLocalPath)) {
                fs.mkdirSync(guardedLocalPath, { recursive: true });
            }

            const files = await sftp.list(guardedRemotePath);
            let downloaded = 0;

            for (const file of files) {
                this._throwIfCanceled(token);

                const remoteFilePath = path.posix.join(guardedRemotePath, file.name);
                const localFilePath = path.join(guardedLocalPath, file.name);

                if (file.type === 'd') {
                    const subResult = await this.downloadDirectory(
                        config,
                        remoteFilePath,
                        localFilePath,
                        progress,
                        options
                    );
                    if (!subResult.success) {
                        return subResult;
                    }
                    downloaded += subResult.downloaded || 0;
                } else {
                    await sftp.get(remoteFilePath, localFilePath);
                    downloaded++;

                    if (progress) {
                        progress.report({
                            increment: 1,
                            message: `${downloaded} files downloaded`
                        });
                    }
                }
            }

            this._log('  ✓ Directory download completed');
            return { success: true, downloaded };
        } catch (error) {
            this._log(`  ✗ Download failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async downloadCurrentFile(workspaceRoot, getSftpConfigFn, options = {}) {
        const token = options.token;
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this._log('No file is currently open');
            return;
        }

        const configs = getSftpConfigFn();
        if (!configs || configs.length === 0) {
            this._log('SFTP configuration not found');
            return;
        }

        const selected = configs[0];
        if (configs.length > 1) {
            const serverName = selected.name || selected.host;
            this._log(`Default download server selected: ${serverName}`);
        }

        this._throwIfCanceled(token);
        const relativePath = path.relative(workspaceRoot, editor.document.uri.fsPath);
        const remotePath = path.posix.join(selected.remotePath, relativePath.replace(/\\/g, '/'));

        const result = await this.downloadFile(
            selected,
            remotePath,
            editor.document.uri.fsPath,
            { token, workspaceRoot }
        );

        if (result.success) {
            this._log('✓ File downloaded successfully');
            await vscode.commands.executeCommand('workbench.action.files.revert');
        } else {
            this._log(`✗ Download failed: ${result.error}`);
        }
    }
}

module.exports = DownloadManager;

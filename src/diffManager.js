const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { assertRemotePathSafe } = require('./security/pathGuard');

class DiffManager {
    constructor(options = {}) {
        this.connectionManager = options.connectionManager;
        this.outputChannel = options.outputChannel;
        this.getSafetyConfig = options.getSafetyConfig || (() => ({ blockPathTraversal: true }));
        this.tempDir = path.join(os.tmpdir(), 'multi-sftp-sync');

        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
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

    _createSecureTempFile(serverName, remotePath) {
        const basename = path.basename(remotePath).replace(/[^\w.\-]/g, '_');
        const nonce = crypto.randomBytes(8).toString('hex');
        return path.join(this.tempDir, `${serverName}_${nonce}_${basename}`);
    }

    async compareWithRemote(localPath, config, remotePath, options = {}) {
        const serverName = config.name || config.host;
        const token = options.token;

        try {
            this._throwIfCanceled(token);
            const safety = this.getSafetyConfig();
            const guardedRemotePath = assertRemotePathSafe(
                config.remotePath,
                remotePath,
                { enabled: safety.blockPathTraversal !== false }
            );

            this._log(`\n[${serverName}] Compare file: ${guardedRemotePath}`);

            const sftp = await this.connectionManager.getConnection(config);
            const tempFilePath = this._createSecureTempFile(serverName, guardedRemotePath);

            await sftp.get(guardedRemotePath, tempFilePath);
            this._throwIfCanceled(token);

            const localUri = vscode.Uri.file(localPath);
            const remoteUri = vscode.Uri.file(tempFilePath);

            await vscode.commands.executeCommand(
                'vscode.diff',
                remoteUri,
                localUri,
                `${path.basename(localPath)} ↔ ${serverName}`
            );

            this._log('  ✓ Diff view opened');
            return { success: true };
        } catch (error) {
            this._log(`  ✗ Compare failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    cleanup() {
        try {
            if (fs.existsSync(this.tempDir)) {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            }
        } catch (error) {
            this._log(`Failed to clean temporary files: ${error.message}`);
        }
    }
}

module.exports = DiffManager;

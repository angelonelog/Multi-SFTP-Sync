const vscode = require('vscode');
const path = require('path');

/**
 * Remote file explorer tree view
 */
class RemoteExplorerProvider {
    constructor(connectionManager, getSftpConfig, outputChannel, options = {}) {
        this.connectionManager = connectionManager;
        this.getSftpConfig = getSftpConfig;
        this.outputChannel = outputChannel;
        this.cacheTtlMs = options.cacheTtlMs || 5000;
        this.listCache = new Map();
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    refresh() {
        this.listCache.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (!element) {
            // Root node: show all servers
            const configs = this.getSftpConfig();
            if (!configs || configs.length === 0) {
                return [];
            }

            return configs.map(config => {
                const serverName = config.name || config.host;
                const item = new vscode.TreeItem(
                    serverName,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.contextValue = 'remoteServer';
                item.iconPath = new vscode.ThemeIcon('server');
                item.tooltip = `${config.host}:${config.port || 22}`;
                item.config = config;
                return item;
            });
        } else if (element.contextValue === 'remoteServer') {
            // Server node: show remote root directory
            return await this.getRemoteFiles(element.config, element.config.remotePath);
        } else if (element.contextValue === 'remoteDirectory') {
            // Directory node: show directory contents
            return await this.getRemoteFiles(element.config, element.remotePath);
        }

        return [];
    }

    async getRemoteFiles(config, remotePath) {
        try {
            const cacheKey = `${config.host}:${config.port || 22}:${config.username}:${remotePath}`;
            const cached = this.listCache.get(cacheKey);
            let files;

            if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
                files = cached.files;
            } else {
                const sftp = await this.connectionManager.getConnection(config);
                files = await sftp.list(remotePath);
                this.listCache.set(cacheKey, { ts: Date.now(), files });
            }

            return files.map(file => {
                const isDirectory = file.type === 'd';
                const item = new vscode.TreeItem(
                    file.name,
                    isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );

                item.contextValue = isDirectory ? 'remoteDirectory' : 'remoteFile';
                item.iconPath = isDirectory 
                    ? new vscode.ThemeIcon('folder') 
                    : vscode.ThemeIcon.File;
                
                item.remotePath = path.posix.join(remotePath, file.name);
                item.config = config;
                item.fileInfo = file;

                if (!isDirectory) {
                    // File item can be clicked to open
                    item.command = {
                        command: 'multi-sftp-sync.openRemoteFile',
                        title: 'Open Remote File',
                        arguments: [item]
                    };
                }

                // Add file size and modified time to tooltip
                const size = this.formatFileSize(file.size);
                const modifyTime = new Date(file.modifyTime).toLocaleString();
                item.tooltip = `${item.remotePath}\nSize: ${size}\nModified: ${modifyTime}`;
                item.description = size;

                return item;
            });
        } catch (error) {
            if (this.outputChannel) {
                this.outputChannel.appendLine(`Failed to read remote directory: ${error.message}`);
            }
            return [];
        }
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
}

module.exports = RemoteExplorerProvider;

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const micromatch = require('micromatch');

const ConnectionManager = require('./src/connectionManager');
const RemoteExplorerProvider = require('./src/remoteExplorer');
const DownloadManager = require('./src/downloadManager');
const DiffManager = require('./src/diffManager');
const ProgressManager = require('./src/progressManager');
const StatusBarManager = require('./src/statusBarManager');
const CredentialStore = require('./src/security/credentialStore');
const HostTrustStore = require('./src/security/hostTrustStore');
const TransferQueue = require('./src/transferQueue');
const {
    normalizeRemotePath,
    assertLocalPathInsideWorkspace,
    assertRemotePathSafe,
    isCriticalRemotePath
} = require('./src/security/pathGuard');

let extensionContext;
let outputChannel;
let serversTreeDataProvider;
let remoteExplorerProvider;
let connectionManager;
let downloadManager;
let diffManager;
let progressManager;
let statusBarManager;
let credentialStore;
let hostTrustStore;
let transferQueue;

const OPERATION_DEDUPE_TTL_MS = 1500;
const operationDedupe = new Map();
let configCache = null;

class ServersTreeDataProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (element) {
            return Promise.resolve([]);
        }
        return Promise.resolve(this.getServers());
    }

    getServers() {
        const configs = getSftpConfig();
        if (!configs || configs.length === 0) {
            return [new vscode.TreeItem('SFTP configuration not found')];
        }

        return configs.map(config => {
            const serverName = config.name || config.host;
            const treeItem = new vscode.TreeItem(serverName, vscode.TreeItemCollapsibleState.None);
            treeItem.description = `${config.host}:${config.port || 22}`;
            treeItem.tooltip = `Host: ${config.host}\nPort: ${config.port || 22}\nUser: ${config.username}\nPath: ${config.remotePath}`;
            treeItem.contextValue = 'server';
            treeItem.iconPath = new vscode.ThemeIcon('server');
            treeItem.command = {
                command: 'multi-sftp-sync.showServerInfo',
                title: 'Show Server Info',
                arguments: [config]
            };
            return treeItem;
        });
    }
}

function logTagged(tag, message) {
    if (outputChannel) {
        outputChannel.appendLine(`[${tag}] ${message}`);
    }
}

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return null;
    }
    return folders[0].uri.fsPath;
}

function getWorkspaceId() {
    return getWorkspaceRoot() || 'unknown-workspace';
}

function getTransferConfig() {
    const config = vscode.workspace.getConfiguration('multiSftpSync');
    return {
        maxConcurrent: Math.max(1, Number(config.get('maxConcurrent', 5)) || 5),
        retryTimes: Math.max(0, Number(config.get('retryTimes', 3)) || 3),
        connectionTimeout: Math.max(1000, Number(config.get('connectionTimeout', 10000)) || 10000),
        showProgress: config.get('showProgress', true)
    };
}

function getSecurityConfig() {
    const config = vscode.workspace.getConfiguration('multiSftpSync');
    const hostKeyPolicy = String(config.get('security.hostKeyPolicy', 'tofu')).toLowerCase();
    return {
        hostKeyPolicy: ['tofu', 'strict', 'off'].includes(hostKeyPolicy) ? hostKeyPolicy : 'tofu',
        autoMigrateCredentials: config.get('security.autoMigrateCredentials', true),
        trustStorePath: config.get('security.trustStorePath', '')
    };
}

function getSafetyConfig() {
    const config = vscode.workspace.getConfiguration('multiSftpSync');
    return {
        blockPathTraversal: config.get('safety.blockPathTraversal', true),
        blockCriticalDeletes: config.get('safety.blockCriticalDeletes', true),
        criticalRemotePaths: config.get('safety.criticalRemotePaths', ['/', '/root', '/etc', '/var', '/home'])
    };
}

function invalidateConfigCache() {
    configCache = null;
}

function compileIgnoreEntries(ignorePatterns) {
    if (!Array.isArray(ignorePatterns)) {
        return [];
    }

    const entries = [];
    for (const rawPattern of ignorePatterns) {
        if (typeof rawPattern !== 'string' || rawPattern.trim().length === 0) {
            continue;
        }

        const original = rawPattern.trim().replace(/\\/g, '/');
        const normalized = original.endsWith('/') ? `${original}**` : original;
        try {
            const regex = micromatch.makeRe(normalized, { dot: true });
            const hasSlash = normalized.includes('/');
            entries.push({
                raw: original,
                match: normalizedPath => {
                    if (hasSlash) {
                        return regex.test(normalizedPath);
                    }
                    return regex.test(path.posix.basename(normalizedPath)) || regex.test(normalizedPath);
                }
            });
        } catch (error) {
            logTagged('SECURITY', `invalid ignore pattern "${original}": ${error.message}`);
        }
    }

    return entries;
}

function prepareConfig(config) {
    const prepared = { ...config };
    prepared.ignore = Array.isArray(prepared.ignore) ? prepared.ignore : [];
    prepared.pathMappings = Array.isArray(prepared.pathMappings) ? prepared.pathMappings : [];
    prepared.__ignoreEntries = compileIgnoreEntries(prepared.ignore);
    return prepared;
}

function getSftpConfig() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return null;
    }

    const configPath = path.join(workspaceRoot, '.vscode', 'sftp.json');
    if (!fs.existsSync(configPath)) {
        return null;
    }

    const stat = fs.statSync(configPath);
    if (
        configCache &&
        configCache.path === configPath &&
        configCache.mtimeMs === stat.mtimeMs &&
        Array.isArray(configCache.configs)
    ) {
        return configCache.configs;
    }

    try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(configContent);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const configs = list.filter(Boolean).map(prepareConfig);
        configCache = {
            path: configPath,
            mtimeMs: stat.mtimeMs,
            configs
        };
        return configs;
    } catch (error) {
        logTagged('SECURITY', `failed to read configuration file: ${error.message}`);
        return null;
    }
}

function guardLocalPath(workspaceRoot, localPath) {
    const safety = getSafetyConfig();
    return assertLocalPathInsideWorkspace(workspaceRoot, localPath, {
        enabled: safety.blockPathTraversal !== false
    });
}

function getRemotePath(localPath, workspaceRoot, config) {
    const guardedLocalPath = guardLocalPath(workspaceRoot, localPath);
    const relativePath = path.relative(workspaceRoot, guardedLocalPath);
    const normalizedRelative = relativePath.replace(/\\/g, '/');

    let selectedMapping = null;
    for (const mapping of config.pathMappings || []) {
        const localPattern = String(mapping.local || '').replace(/\\/g, '/');
        if (!localPattern) {
            continue;
        }
        if (normalizedRelative === localPattern || normalizedRelative.startsWith(localPattern + '/')) {
            selectedMapping = mapping;
            break;
        }
    }

    let remoteBase = config.remotePath;
    let remotePath;
    if (selectedMapping) {
        const localPattern = String(selectedMapping.local || '').replace(/\\/g, '/');
        const subPath = normalizedRelative.substring(localPattern.length).replace(/^\//, '');
        remoteBase = selectedMapping.remote;
        remotePath = path.posix.join(selectedMapping.remote, subPath);
    } else {
        remotePath = path.posix.join(config.remotePath, normalizedRelative);
    }

    const safety = getSafetyConfig();
    return assertRemotePathSafe(remoteBase, remotePath, {
        enabled: safety.blockPathTraversal !== false
    });
}

function shouldProcessFile(relativePath, config) {
    if (!config.pathMappings || config.pathMappings.length === 0) {
        return true;
    }

    const normalizedRelative = relativePath.replace(/\\/g, '/');
    for (const mapping of config.pathMappings) {
        const localPattern = String(mapping.local || '').replace(/\\/g, '/');
        if (!localPattern) {
            continue;
        }
        if (normalizedRelative === localPattern || normalizedRelative.startsWith(localPattern + '/')) {
            return true;
        }
    }
    return false;
}

function getIgnoreMatch(config, filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const entries = config.__ignoreEntries || [];
    for (const entry of entries) {
        try {
            if (entry.match(normalizedPath)) {
                return entry.raw;
            }
        } catch (error) {
            logTagged('SECURITY', `ignore match failed for "${entry.raw}": ${error.message}`);
        }
    }
    return null;
}

function shouldIgnore(config, filePath) {
    return Boolean(getIgnoreMatch(config, filePath));
}

function cleanupOperationDedupe() {
    const now = Date.now();
    for (const [key, ts] of operationDedupe.entries()) {
        if (now - ts > OPERATION_DEDUPE_TTL_MS) {
            operationDedupe.delete(key);
        }
    }
}

function shouldSkipDuplicateOperation(opType, config, relativePath) {
    cleanupOperationDedupe();
    const key = `${opType}:${config.host}:${config.port || 22}:${config.username}:${relativePath}`;
    const lastSeen = operationDedupe.get(key);
    const now = Date.now();
    if (lastSeen && now - lastSeen <= OPERATION_DEDUPE_TTL_MS) {
        return true;
    }
    operationDedupe.set(key, now);
    return false;
}

function checkDeleteSafety(remotePath) {
    const safety = getSafetyConfig();
    const normalized = normalizeRemotePath(remotePath);
    if (normalized === '/') {
        return { blocked: true, reason: 'Root path deletion is blocked.' };
    }

    if (safety.blockCriticalDeletes !== false && isCriticalRemotePath(normalized, safety.criticalRemotePaths || [])) {
        return { blocked: true, reason: `Critical remote path deletion is blocked: ${normalized}` };
    }

    return { blocked: false, normalized };
}

function createNoopToken() {
    return {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} })
    };
}

async function runWithOptionalProgress(title, task) {
    const transfer = getTransferConfig();
    if (transfer.showProgress === false) {
        return task({ report: () => {} }, createNoopToken());
    }
    return progressManager.withProgress(title, task);
}

function selectDefaultConfig(configs, purpose) {
    if (!configs || configs.length === 0) {
        outputChannel.appendLine('SFTP configuration not found');
        return null;
    }

    const selected = configs[0];
    if (configs.length > 1) {
        outputChannel.appendLine(`${purpose} default server selected: ${selected.name || selected.host}`);
    }
    return selected;
}

async function pickConfig(configs, title) {
    if (!configs || configs.length === 0) {
        return null;
    }
    if (configs.length === 1) {
        return configs[0];
    }

    const items = configs.map(config => ({
        label: config.name || config.host,
        description: `${config.host}:${config.port || 22}`,
        config
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title,
        placeHolder: 'Select a server'
    });
    return picked ? picked.config : null;
}

async function resolveConfigFromTreeOrPrompt(treeItem, title) {
    const configs = getSftpConfig();
    if (!configs || configs.length === 0) {
        outputChannel.appendLine('SFTP configuration not found');
        return null;
    }

    if (treeItem && treeItem.label) {
        const byTree = configs.find(config => (config.name || config.host) === treeItem.label);
        if (byTree) {
            return byTree;
        }
    }

    return pickConfig(configs, title);
}

async function maybeShowMigrationWarningOnce() {
    const key = 'multiSftpSync.security.migrationNoticeShown';
    if (!extensionContext) {
        return;
    }
    if (extensionContext.globalState.get(key)) {
        return;
    }
    await extensionContext.globalState.update(key, true);
    await vscode.window.showWarningMessage(
        'Plaintext credentials were auto-migrated to VS Code SecretStorage. You can keep sftp.json unchanged, but storing plaintext secrets is discouraged.'
    );
}

async function activate(context) {
    extensionContext = context;
    try {
        outputChannel = vscode.window.createOutputChannel('Multi SFTP Sync');
        progressManager = new ProgressManager();
        statusBarManager = new StatusBarManager(outputChannel);

        credentialStore = new CredentialStore({
            context,
            logger: message => logTagged('SECURITY', message),
            onAutoMigrated: () => {
                maybeShowMigrationWarningOnce().catch(() => {});
            }
        });

        hostTrustStore = new HostTrustStore({
            context,
            getSecurityConfig,
            logger: message => logTagged('HOSTKEY', message)
        });

        connectionManager = new ConnectionManager({
            getTransferConfig,
            getSecurityConfig,
            credentialStore,
            hostTrustStore,
            getWorkspaceId,
            logger: message => outputChannel.appendLine(message)
        });

        transferQueue = new TransferQueue({
            concurrency: getTransferConfig().maxConcurrent,
            logger: message => outputChannel.appendLine(message)
        });

        downloadManager = new DownloadManager({
            connectionManager,
            outputChannel,
            getSafetyConfig,
            logger: message => outputChannel.appendLine(message)
        });

        diffManager = new DiffManager({
            connectionManager,
            outputChannel,
            getSafetyConfig
        });

        serversTreeDataProvider = new ServersTreeDataProvider();
        const treeView = vscode.window.createTreeView('sftpServers', {
            treeDataProvider: serversTreeDataProvider
        });

        remoteExplorerProvider = new RemoteExplorerProvider(
            connectionManager,
            getSftpConfig,
            outputChannel,
            { cacheTtlMs: 5000 }
        );
        const remoteExplorerView = vscode.window.createTreeView('remoteExplorer', {
            treeDataProvider: remoteExplorerProvider
        });

        const pendingChanges = new Map();
        const recentlySaved = new Map();
        const SAVE_COOLDOWN_MS = 1000;

        const saveDisposable = vscode.workspace.onDidSaveTextDocument(async document => {
            const config = vscode.workspace.getConfiguration('multiSftpSync');
            if (!config.get('autoUpload', true)) {
                return;
            }

            const filePath = document.uri.fsPath;
            recentlySaved.set(filePath, Date.now());
            const now = Date.now();
            for (const [savedPath, savedAt] of recentlySaved.entries()) {
                if (now - savedAt > 10000) {
                    recentlySaved.delete(savedPath);
                }
            }

            await uploadFile(filePath, { skipOnFailure: true, silent: true });
        });

        const deleteWatcher = vscode.workspace.createFileSystemWatcher('**/*');

        deleteWatcher.onDidCreate(async uri => {
            const config = vscode.workspace.getConfiguration('multiSftpSync');
            if (!config.get('autoUpload', true)) {
                return;
            }

            try {
                const stat = await fs.promises.stat(uri.fsPath);
                if (stat.isDirectory()) {
                    await createRemoteDirectory(uri.fsPath, { skipOnFailure: true, silent: true });
                } else if (stat.isFile()) {
                    await uploadFile(uri.fsPath, { skipOnFailure: true, silent: true });
                }
            } catch (error) {
                // Ignore filesystem races.
            }
        });

        deleteWatcher.onDidDelete(async uri => {
            const config = vscode.workspace.getConfiguration('multiSftpSync');
            if (!config.get('autoDelete', true)) {
                return;
            }
            await deleteFile(uri.fsPath, { skipOnFailure: true, silent: true, manual: false });
        });

        deleteWatcher.onDidChange(async uri => {
            const config = vscode.workspace.getConfiguration('multiSftpSync');
            if (!config.get('autoUpload', true)) {
                return;
            }

            const filePath = uri.fsPath;
            if (recentlySaved.has(filePath)) {
                const lastSave = recentlySaved.get(filePath);
                if (Date.now() - lastSave < SAVE_COOLDOWN_MS) {
                    return;
                }
            }

            if (pendingChanges.has(filePath)) {
                clearTimeout(pendingChanges.get(filePath));
            }

            pendingChanges.set(filePath, setTimeout(async () => {
                pendingChanges.delete(filePath);
                try {
                    const stat = await fs.promises.stat(filePath);
                    if (stat.isFile()) {
                        await uploadFile(filePath, { skipOnFailure: true, silent: true });
                    }
                } catch (error) {
                    // Ignore filesystem races.
                }
            }, 200));
        });

        const configWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/sftp.json');
        const refreshConfig = () => {
            invalidateConfigCache();
            serversTreeDataProvider.refresh();
            remoteExplorerProvider.refresh();
        };
        configWatcher.onDidChange(refreshConfig);
        configWatcher.onDidCreate(refreshConfig);
        configWatcher.onDidDelete(refreshConfig);

        const settingsWatcher = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('multiSftpSync')) {
                transferQueue.setConcurrency(getTransferConfig().maxConcurrent);
            }
            if (
                event.affectsConfiguration('multiSftpSync.safety') ||
                event.affectsConfiguration('multiSftpSync.security') ||
                event.affectsConfiguration('multiSftpSync.maxConcurrent')
            ) {
                invalidateConfigCache();
            }
        });

        const refreshServersDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.refreshServers',
            () => {
                serversTreeDataProvider.refresh();
                outputChannel.appendLine('Server list refreshed');
            }
        );

        const uploadCurrentDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.uploadCurrent',
            async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    outputChannel.appendLine('No file is currently open');
                    return;
                }
                await uploadFile(editor.document.uri.fsPath);
            }
        );

        const uploadAllDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.uploadAll',
            async () => {
                await runWithOptionalProgress('Upload Workspace', async (progress, token) => {
                    await uploadWorkspace({ progress, token });
                });
            }
        );

        const deleteCurrentDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.deleteCurrent',
            async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    outputChannel.appendLine('No file is currently open');
                    return;
                }
                await deleteFile(editor.document.uri.fsPath, { manual: true });
            }
        );

        const uploadToServerDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.uploadToServer',
            async treeItem => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    outputChannel.appendLine('No file is currently open');
                    return;
                }

                const config = await resolveConfigFromTreeOrPrompt(treeItem, 'Upload to selected server');
                if (!config) {
                    return;
                }

                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    outputChannel.appendLine('Please open a workspace first');
                    return;
                }

                const filePath = editor.document.uri.fsPath;
                const relativePath = path.relative(workspaceRoot, filePath);
                let remotePath;
                try {
                    remotePath = getRemotePath(filePath, workspaceRoot, config);
                } catch (error) {
                    logTagged('PATH_GUARD', error.message);
                    outputChannel.appendLine(`✗ Upload blocked: ${error.message}`);
                    return;
                }

                await uploadToServer(filePath, relativePath, config, workspaceRoot, remotePath, { manual: true });
            }
        );

        const testConnectionDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.testConnection',
            async treeItem => {
                const config = await resolveConfigFromTreeOrPrompt(treeItem, 'Test server connection');
                if (!config) {
                    return;
                }

                outputChannel.appendLine(`\nTesting connection: ${config.name || config.host}`);
                try {
                    await connectionManager.getConnection(config);
                    outputChannel.appendLine(`✓ ${(config.name || config.host)} connected`);
                } catch (error) {
                    outputChannel.appendLine(`✗ ${(config.name || config.host)} connection failed: ${error.message}`);
                }
            }
        );

        const showServerInfoDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.showServerInfo',
            config => {
                const info = `
Server Name: ${config.name || 'Unnamed'}
Host: ${config.host}
Port: ${config.port || 22}
Username: ${config.username}
Remote Path: ${config.remotePath}
Auto Upload: ${config.uploadOnSave !== false ? 'Yes' : 'No'}
Ignore Rules: ${Array.isArray(config.ignore) ? config.ignore.length : 0} rules
                `.trim();
                outputChannel.appendLine(info);
            }
        );

        const downloadFileDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.downloadFile',
            async treeItem => {
                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    outputChannel.appendLine('Please open a workspace first');
                    return;
                }

                if (treeItem && treeItem.remotePath && treeItem.config) {
                    const relativePath = path.relative(treeItem.config.remotePath, treeItem.remotePath);
                    const localPath = path.join(workspaceRoot, relativePath);

                    await runWithOptionalProgress('Download File', async (progress, token) => {
                        const result = await downloadManager.downloadFile(
                            treeItem.config,
                            treeItem.remotePath,
                            localPath,
                            { token, workspaceRoot }
                        );
                        if (result.success) {
                            const doc = await vscode.workspace.openTextDocument(result.localPath);
                            await vscode.window.showTextDocument(doc);
                        } else {
                            outputChannel.appendLine(`✗ Download failed: ${result.error}`);
                        }
                    });
                    return;
                }

                await runWithOptionalProgress('Download Current File', async (progress, token) => {
                    await downloadManager.downloadCurrentFile(workspaceRoot, getSftpConfig, { token });
                });
            }
        );

        const downloadDirectoryDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.downloadDirectory',
            async treeItem => {
                if (!treeItem || !treeItem.remotePath || !treeItem.config) {
                    outputChannel.appendLine('Please select a directory from the remote explorer');
                    return;
                }

                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    outputChannel.appendLine('Please open a workspace first');
                    return;
                }

                const relativePath = path.relative(treeItem.config.remotePath, treeItem.remotePath);
                const localPath = path.join(workspaceRoot, relativePath);

                await runWithOptionalProgress('Download Directory', async (progress, token) => {
                    const result = await downloadManager.downloadDirectory(
                        treeItem.config,
                        treeItem.remotePath,
                        localPath,
                        progress,
                        { token, workspaceRoot }
                    );
                    if (!result.success) {
                        outputChannel.appendLine(`✗ Download failed: ${result.error}`);
                    }
                });
            }
        );

        const compareWithRemoteDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.compareWithRemote',
            async treeItem => {
                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    outputChannel.appendLine('Please open a workspace first');
                    return;
                }

                if (treeItem && treeItem.remotePath && treeItem.config) {
                    const relativePath = path.relative(treeItem.config.remotePath, treeItem.remotePath);
                    const localPath = path.join(workspaceRoot, relativePath);
                    if (!fs.existsSync(localPath)) {
                        outputChannel.appendLine(`Local file not found for compare: ${localPath}`);
                        return;
                    }

                    await runWithOptionalProgress('Compare with Remote', async (progress, token) => {
                        const result = await diffManager.compareWithRemote(localPath, treeItem.config, treeItem.remotePath, {
                            token
                        });
                        if (!result.success) {
                            outputChannel.appendLine(`✗ Compare failed: ${result.error}`);
                        }
                    });
                    return;
                }

                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    outputChannel.appendLine('No file is currently open');
                    return;
                }

                const configs = getSftpConfig();
                const config = selectDefaultConfig(configs, 'Compare');
                if (!config) {
                    return;
                }

                const localPath = editor.document.uri.fsPath;
                let remotePath;
                try {
                    remotePath = getRemotePath(localPath, workspaceRoot, config);
                } catch (error) {
                    logTagged('PATH_GUARD', error.message);
                    outputChannel.appendLine(`✗ Compare blocked: ${error.message}`);
                    return;
                }

                await runWithOptionalProgress('Compare with Remote', async (progress, token) => {
                    const result = await diffManager.compareWithRemote(localPath, config, remotePath, { token });
                    if (!result.success) {
                        outputChannel.appendLine(`✗ Compare failed: ${result.error}`);
                    }
                });
            }
        );

        const openRemoteFileDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.openRemoteFile',
            async treeItem => {
                if (!treeItem || !treeItem.remotePath || !treeItem.config) {
                    outputChannel.appendLine('Please select a remote file');
                    return;
                }

                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    outputChannel.appendLine('Please open a workspace first');
                    return;
                }

                const relativePath = path.relative(treeItem.config.remotePath, treeItem.remotePath);
                const localPath = path.join(workspaceRoot, relativePath);

                await runWithOptionalProgress('Open Remote File', async (progress, token) => {
                    const result = await downloadManager.downloadFile(
                        treeItem.config,
                        treeItem.remotePath,
                        localPath,
                        { token, workspaceRoot }
                    );
                    if (result.success) {
                        const document = await vscode.workspace.openTextDocument(result.localPath);
                        await vscode.window.showTextDocument(document);
                    } else {
                        outputChannel.appendLine(`✗ Download failed: ${result.error}`);
                    }
                });
            }
        );

        const syncToRemoteDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.syncToRemote',
            async () => {
                await runWithOptionalProgress('Sync Local to Remote', async (progress, token) => {
                    await uploadWorkspace({ progress, token, manual: true });
                });
            }
        );

        const syncFromRemoteDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.syncFromRemote',
            async treeItem => {
                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    outputChannel.appendLine('Please open a workspace first');
                    return;
                }

                const config = await resolveConfigFromTreeOrPrompt(treeItem, 'Sync from selected server');
                if (!config) {
                    return;
                }

                await runWithOptionalProgress('Sync Remote to Local', async (progress, token) => {
                    const result = await downloadManager.downloadDirectory(
                        config,
                        config.remotePath,
                        workspaceRoot,
                        progress,
                        { token, workspaceRoot }
                    );
                    if (!result.success) {
                        outputChannel.appendLine(`✗ Sync from remote failed: ${result.error}`);
                    } else {
                        outputChannel.appendLine(`✓ Sync from remote completed (${result.downloaded || 0} files)`);
                    }
                });
            }
        );

        const refreshRemoteExplorerDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.refreshRemoteExplorer',
            () => {
                remoteExplorerProvider.refresh();
                outputChannel.appendLine('Remote explorer refreshed');
            }
        );

        const showStatusDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.showStatus',
            () => {
                statusBarManager.showStatus();
            }
        );

        const trustHostKeyNowDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.security.trustHostKeyNow',
            async treeItem => {
                const config = await resolveConfigFromTreeOrPrompt(treeItem, 'Trust host key for server');
                if (!config) {
                    return;
                }

                try {
                    const fingerprint = await connectionManager.trustHostKeyNow(config);
                    outputChannel.appendLine(`✓ Trusted host key for ${config.host}:${config.port || 22} (${fingerprint})`);
                } catch (error) {
                    outputChannel.appendLine(`✗ Failed to trust host key: ${error.message}`);
                }
            }
        );

        const removeTrustedHostDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.security.removeTrustedHost',
            async treeItem => {
                let hostKey = null;

                if (treeItem && treeItem.config) {
                    hostKey = `${treeItem.config.host}:${treeItem.config.port || 22}`;
                } else {
                    const entries = hostTrustStore.listEntries();
                    if (entries.length === 0) {
                        outputChannel.appendLine('No trusted hosts found');
                        return;
                    }

                    const picked = await vscode.window.showQuickPick(
                        entries.map(entry => ({
                            label: entry.key,
                            description: entry.fingerprint,
                            detail: `Trusted at ${entry.trustedAt} (${entry.source})`,
                            entry
                        })),
                        {
                            title: 'Select trusted host to remove'
                        }
                    );

                    if (!picked) {
                        return;
                    }
                    hostKey = picked.entry.key;
                }

                const removed = hostTrustStore.removeTrust(hostKey);
                if (removed) {
                    outputChannel.appendLine(`✓ Removed trusted host: ${hostKey}`);
                } else {
                    outputChannel.appendLine(`No trusted host entry found: ${hostKey}`);
                }
            }
        );

        const migrateCredentialsNowDisposable = vscode.commands.registerCommand(
            'multi-sftp-sync.security.migrateCredentialsNow',
            async () => {
                const configs = getSftpConfig();
                if (!configs || configs.length === 0) {
                    outputChannel.appendLine('SFTP configuration not found');
                    return;
                }

                const migrated = await credentialStore.migrateAll(configs, getWorkspaceId(), { overwrite: true });
                if (migrated > 0) {
                    await maybeShowMigrationWarningOnce();
                }
                outputChannel.appendLine(`Credential migration completed. Updated entries: ${migrated}`);
            }
        );

        const disposableCleanup = {
            dispose: () => {
                for (const timeout of pendingChanges.values()) {
                    clearTimeout(timeout);
                }
                pendingChanges.clear();
                recentlySaved.clear();
            }
        };

        context.subscriptions.push(
            treeView,
            remoteExplorerView,
            saveDisposable,
            deleteWatcher,
            configWatcher,
            settingsWatcher,
            refreshServersDisposable,
            uploadCurrentDisposable,
            uploadAllDisposable,
            deleteCurrentDisposable,
            uploadToServerDisposable,
            testConnectionDisposable,
            showServerInfoDisposable,
            downloadFileDisposable,
            downloadDirectoryDisposable,
            compareWithRemoteDisposable,
            openRemoteFileDisposable,
            syncToRemoteDisposable,
            syncFromRemoteDisposable,
            refreshRemoteExplorerDisposable,
            showStatusDisposable,
            trustHostKeyNowDisposable,
            removeTrustedHostDisposable,
            migrateCredentialsNowDisposable,
            outputChannel,
            statusBarManager,
            disposableCleanup
        );

        const startupConfigs = getSftpConfig();
        if (startupConfigs && startupConfigs.length > 0) {
            connectionManager.preConnectAll(startupConfigs).then(results => {
                const failed = results.filter(item => !item.success);
                if (failed.length > 0) {
                    outputChannel.appendLine(`Preconnect completed with ${failed.length} failure(s)`);
                } else {
                    outputChannel.appendLine(`Preconnect completed: ${results.length} server(s) ready`);
                }
            }).catch(error => {
                outputChannel.appendLine(`Preconnect failed: ${error.message}`);
            });
        }
    } catch (error) {
        const message = `Extension activation failed: ${error.message}`;
        if (outputChannel) {
            outputChannel.appendLine(message);
        }
        vscode.window.showErrorMessage(message);
    }
}

function createCancellationError() {
    const error = new Error('Operation canceled');
    error.code = 'OPERATION_CANCELED';
    return error;
}

function throwIfCanceled(token) {
    if (token && token.isCancellationRequested) {
        throw createCancellationError();
    }
}

function appendOperationLog(line) {
    if (outputChannel) {
        outputChannel.appendLine(line);
    }
    if (statusBarManager && typeof statusBarManager.addLogLine === 'function') {
        statusBarManager.addLogLine(line);
    }
}

async function uploadFile(filePath, options = {}) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        if (!options.silent) {
            appendOperationLog('Please open a workspace first');
        }
        return [];
    }

    let guardedFilePath;
    try {
        guardedFilePath = guardLocalPath(workspaceRoot, filePath);
    } catch (error) {
        logTagged('PATH_GUARD', error.message);
        if (!options.silent) {
            appendOperationLog(`✗ Upload blocked: ${error.message}`);
        }
        if (!options.skipOnFailure) {
            throw error;
        }
        return [];
    }

    let stat;
    try {
        stat = await fs.promises.stat(guardedFilePath);
    } catch (error) {
        return [];
    }
    if (!stat.isFile()) {
        return [];
    }

    const relativePath = path.relative(workspaceRoot, guardedFilePath).replace(/\\/g, '/');
    const configs = options.configs || getSftpConfig();
    if (!configs || configs.length === 0) {
        if (!options.silent) {
            appendOperationLog('SFTP configuration not found');
        }
        return [];
    }

    const tasks = [];
    for (const config of configs) {
        if (!shouldProcessFile(relativePath, config)) {
            continue;
        }

        const ignoreMatch = getIgnoreMatch(config, relativePath);
        if (ignoreMatch) {
            continue;
        }

        if (!options.manual && shouldSkipDuplicateOperation('upload', config, relativePath)) {
            continue;
        }

        let remotePath;
        try {
            remotePath = getRemotePath(guardedFilePath, workspaceRoot, config);
        } catch (error) {
            logTagged('PATH_GUARD', error.message);
            if (!options.silent) {
                appendOperationLog(`✗ Upload blocked: ${error.message}`);
            }
            if (!options.skipOnFailure) {
                throw error;
            }
            continue;
        }

        tasks.push(
            uploadToServer(
                guardedFilePath,
                relativePath,
                config,
                workspaceRoot,
                remotePath,
                options
            )
        );
    }

    const results = await Promise.allSettled(tasks);
    const failures = results.filter(item => item.status === 'rejected');
    if (failures.length > 0 && !options.skipOnFailure) {
        throw failures[0].reason;
    }
    return results;
}

async function deleteFile(filePath, options = {}) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        if (!options.silent) {
            appendOperationLog('Please open a workspace first');
        }
        return [];
    }

    let guardedFilePath;
    try {
        guardedFilePath = guardLocalPath(workspaceRoot, filePath);
    } catch (error) {
        logTagged('PATH_GUARD', error.message);
        if (!options.silent) {
            appendOperationLog(`✗ Delete blocked: ${error.message}`);
        }
        if (!options.skipOnFailure) {
            throw error;
        }
        return [];
    }

    const relativePath = path.relative(workspaceRoot, guardedFilePath).replace(/\\/g, '/');
    const configs = options.configs || getSftpConfig();
    if (!configs || configs.length === 0) {
        if (!options.silent) {
            appendOperationLog('SFTP configuration not found');
        }
        return [];
    }

    const tasks = [];
    for (const config of configs) {
        if (!shouldProcessFile(relativePath, config)) {
            continue;
        }

        if (shouldIgnore(config, relativePath) || shouldIgnore(config, `${relativePath}/`)) {
            continue;
        }

        if (!options.manual && shouldSkipDuplicateOperation('delete', config, relativePath)) {
            continue;
        }

        let remotePath;
        try {
            remotePath = getRemotePath(guardedFilePath, workspaceRoot, config);
        } catch (error) {
            logTagged('PATH_GUARD', error.message);
            if (!options.silent) {
                appendOperationLog(`✗ Delete blocked: ${error.message}`);
            }
            if (!options.skipOnFailure) {
                throw error;
            }
            continue;
        }

        tasks.push(deleteFromServer(relativePath, config, remotePath, options));
    }

    const results = await Promise.allSettled(tasks);
    const failures = results.filter(item => item.status === 'rejected');
    if (failures.length > 0 && !options.skipOnFailure) {
        throw failures[0].reason;
    }
    return results;
}

async function uploadToServer(filePath, relativePath, config, workspaceRoot, remotePath, options = {}) {
    const serverName = config.name || config.host;
    const label = `upload:${serverName}:${relativePath}`;
    const token = options.token;

    return transferQueue.enqueue(async () => {
        throwIfCanceled(token);
        statusBarManager.startUpload(relativePath);

        try {
            const sftp = await connectionManager.getConnection(config);
            throwIfCanceled(token);

            const remoteDir = path.posix.dirname(remotePath);
            await connectionManager.ensureDir(config, remoteDir, sftp);
            throwIfCanceled(token);

            await sftp.put(filePath, remotePath);
            throwIfCanceled(token);

            statusBarManager.finishUpload(relativePath, true);
            appendOperationLog(`✓ [${serverName}] Uploaded ${relativePath} -> ${remotePath}`);
            return { success: true, config, relativePath, remotePath };
        } catch (error) {
            statusBarManager.finishUpload(relativePath, false, error.message);
            appendOperationLog(`✗ [${serverName}] Upload failed for ${relativePath}: ${error.message}`);
            if (options.skipOnFailure) {
                return { success: false, config, relativePath, remotePath, error: error.message };
            }
            throw error;
        }
    }, { token, label });
}

async function deleteFromServer(relativePath, config, remotePath, options = {}) {
    const serverName = config.name || config.host;
    const label = `delete:${serverName}:${relativePath}`;
    const token = options.token;
    const safetyResult = checkDeleteSafety(remotePath);
    if (safetyResult.blocked) {
        logTagged('PATH_GUARD', safetyResult.reason);
        appendOperationLog(`✗ [${serverName}] Delete blocked for ${relativePath}: ${safetyResult.reason}`);
        return { success: false, blocked: true, reason: safetyResult.reason };
    }

    const guardedRemotePath = safetyResult.normalized;

    return transferQueue.enqueue(async () => {
        throwIfCanceled(token);

        try {
            const sftp = await connectionManager.getConnection(config);
            throwIfCanceled(token);

            const existsType = await sftp.exists(guardedRemotePath);
            if (!existsType) {
                appendOperationLog(`- [${serverName}] Skip delete (not found): ${guardedRemotePath}`);
                return { success: true, skipped: true, reason: 'not_found' };
            }

            const isDirectory = existsType === 'd';
            if (options.manual && isDirectory) {
                const confirm = await vscode.window.showWarningMessage(
                    `Delete remote directory "${guardedRemotePath}" on ${serverName}? This action cannot be undone.`,
                    { modal: true },
                    'Delete Directory'
                );
                if (confirm !== 'Delete Directory') {
                    appendOperationLog(`- [${serverName}] Delete canceled for directory: ${guardedRemotePath}`);
                    return { success: false, canceled: true };
                }
            }

            statusBarManager.startDelete(relativePath);
            if (isDirectory) {
                await sftp.rmdir(guardedRemotePath, true);
            } else {
                await sftp.delete(guardedRemotePath);
            }
            throwIfCanceled(token);

            statusBarManager.finishDelete(relativePath, true);
            appendOperationLog(`✓ [${serverName}] Deleted ${guardedRemotePath}`);
            return { success: true, config, relativePath, remotePath: guardedRemotePath };
        } catch (error) {
            statusBarManager.finishDelete(relativePath, false, error.message);
            appendOperationLog(`✗ [${serverName}] Delete failed for ${guardedRemotePath}: ${error.message}`);
            if (options.skipOnFailure) {
                return { success: false, config, relativePath, remotePath: guardedRemotePath, error: error.message };
            }
            throw error;
        }
    }, { token, label });
}

async function collectWorkspaceFiles(workspaceRoot, token) {
    const files = [];
    const stack = [workspaceRoot];

    while (stack.length > 0) {
        throwIfCanceled(token);
        const currentDir = stack.pop();
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            throwIfCanceled(token);
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile()) {
                files.push(fullPath);
            }
        }
    }

    return files;
}

async function uploadWorkspace(options = {}) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        appendOperationLog('Please open a workspace first');
        return [];
    }

    const configs = getSftpConfig();
    if (!configs || configs.length === 0) {
        appendOperationLog('SFTP configuration not found');
        return [];
    }

    const token = options.token;
    const progress = options.progress;
    const files = await collectWorkspaceFiles(workspaceRoot, token);
    const tasks = [];

    for (const filePath of files) {
        throwIfCanceled(token);

        let guardedPath;
        try {
            guardedPath = guardLocalPath(workspaceRoot, filePath);
        } catch (error) {
            logTagged('PATH_GUARD', error.message);
            continue;
        }

        const relativePath = path.relative(workspaceRoot, guardedPath).replace(/\\/g, '/');
        for (const config of configs) {
            if (!shouldProcessFile(relativePath, config)) {
                continue;
            }

            if (shouldIgnore(config, relativePath)) {
                continue;
            }

            let remotePath;
            try {
                remotePath = getRemotePath(guardedPath, workspaceRoot, config);
            } catch (error) {
                logTagged('PATH_GUARD', error.message);
                continue;
            }

            tasks.push({ filePath: guardedPath, relativePath, config, remotePath });
        }
    }

    if (tasks.length === 0) {
        appendOperationLog('No files matched for upload');
        return [];
    }

    let completed = 0;
    const increment = 100 / tasks.length;
    const results = await Promise.allSettled(
        tasks.map(task =>
            uploadToServer(
                task.filePath,
                task.relativePath,
                task.config,
                workspaceRoot,
                task.remotePath,
                { ...options, skipOnFailure: true, silent: true, manual: true }
            ).finally(() => {
                completed++;
                if (progress) {
                    progress.report({
                        increment,
                        message: `${completed}/${tasks.length} transfers`
                    });
                }
            })
        )
    );

    const failedCount = results.filter(item => item.status === 'rejected').length;
    if (failedCount > 0) {
        appendOperationLog(`Upload workspace completed with ${failedCount} failed transfer(s)`);
    } else {
        appendOperationLog(`Upload workspace completed (${tasks.length} transfers)`);
    }

    return results;
}

async function createRemoteDirectory(localPath, options = {}) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return [];
    }

    let guardedLocalPath;
    try {
        guardedLocalPath = guardLocalPath(workspaceRoot, localPath);
    } catch (error) {
        logTagged('PATH_GUARD', error.message);
        return [];
    }

    const relativePath = path.relative(workspaceRoot, guardedLocalPath).replace(/\\/g, '/');
    const configs = getSftpConfig();
    if (!configs || configs.length === 0) {
        return [];
    }

    const tasks = [];
    for (const config of configs) {
        if (!shouldProcessFile(relativePath, config)) {
            continue;
        }
        if (shouldIgnore(config, relativePath) || shouldIgnore(config, `${relativePath}/`)) {
            continue;
        }
        if (!options.manual && shouldSkipDuplicateOperation('mkdir', config, relativePath)) {
            continue;
        }

        let remotePath;
        try {
            remotePath = getRemotePath(guardedLocalPath, workspaceRoot, config);
        } catch (error) {
            logTagged('PATH_GUARD', error.message);
            continue;
        }
        tasks.push(createDirectoryOnServer(relativePath, config, remotePath, options));
    }
    return Promise.allSettled(tasks);
}

async function createDirectoryOnServer(relativePath, config, remotePath, options = {}) {
    const serverName = config.name || config.host;
    const label = `mkdir:${serverName}:${relativePath}`;
    const token = options.token;

    return transferQueue.enqueue(async () => {
        throwIfCanceled(token);
        const sftp = await connectionManager.getConnection(config);
        throwIfCanceled(token);
        await connectionManager.ensureDir(config, remotePath, sftp);
        appendOperationLog(`✓ [${serverName}] Ensured directory ${remotePath}`);
        return { success: true, config, remotePath };
    }, { token, label });
}

async function deactivate() {
    try {
        transferQueue?.clearPending('Extension deactivated');
    } catch (error) {
        // Best effort queue cleanup.
    }

    try {
        diffManager?.cleanup();
    } catch (error) {
        // Best effort temp cleanup.
    }

    try {
        if (connectionManager) {
            await connectionManager.dispose();
        }
    } catch (error) {
        // Best effort connection cleanup.
    }

    try {
        statusBarManager?.dispose();
    } catch (error) {
        // Best effort UI cleanup.
    }
}

module.exports = {
    activate,
    deactivate
};

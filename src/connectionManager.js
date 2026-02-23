const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');

class ConnectionManager {
    constructor(options = {}) {
        this.connections = new Map();
        this.connecting = new Map();
        this.dirCache = new Map();
        this.lastHostKeyValidation = new Map();

        this.getTransferConfig = options.getTransferConfig || (() => ({
            maxConcurrent: 5,
            retryTimes: 3,
            connectionTimeout: 10000
        }));
        this.getSecurityConfig = options.getSecurityConfig || (() => ({
            hostKeyPolicy: 'tofu'
        }));
        this.getWorkspaceId = options.getWorkspaceId || (() => 'unknown-workspace');
        this.credentialStore = options.credentialStore;
        this.hostTrustStore = options.hostTrustStore;
        this.logger = options.logger || (() => {});

        this.cleanupInterval = setInterval(() => {
            this._cleanupIdleConnections();
        }, 60000);
        this.maxIdleTime = 5 * 60 * 1000;
    }

    _log(tag, message) {
        this.logger(`[${tag}] ${message}`);
    }

    _cleanupIdleConnections() {
        const now = Date.now();
        for (const [key, conn] of this.connections.entries()) {
            if (now - conn.lastUsed > this.maxIdleTime) {
                this._safeCloseConnection(key, conn);
                this._log('QUEUE', `closed idle connection ${key}`);
            }
        }
    }

    _safeCloseConnection(key, conn) {
        try {
            if (conn && conn.sftp) {
                conn.sftp.end().catch(() => {});
            }
        } catch (e) {
            // Best effort close.
        }
        this.connections.delete(key);
        this.dirCache.delete(key);
    }

    _isConnectionAlive(conn) {
        try {
            if (!conn || !conn.sftp) {
                return false;
            }

            const sftp = conn.sftp;
            if (sftp.client && typeof sftp.client.end === 'function') {
                const client = sftp.client;
                if (client._sock && client._sock.destroyed) {
                    return false;
                }
                if (client._sock && !client._sock.writable) {
                    return false;
                }
            }

            if (sftp.sftp && sftp.sftp._stream && sftp.sftp._stream.destroyed) {
                return false;
            }

            return true;
        } catch (e) {
            return false;
        }
    }

    _connectionKey(config) {
        return `${config.host}:${config.port || 22}:${config.username}`;
    }

    async _resolveCredentials(config) {
        if (!this.credentialStore) {
            return config;
        }

        const workspaceId = this.getWorkspaceId();
        const security = this.getSecurityConfig();
        const result = await this.credentialStore.resolve(config, workspaceId, {
            autoMigrate: security.autoMigrateCredentials !== false
        });
        return result.config;
    }

    _createHostVerifier(config, connectionKey, policy) {
        return fingerprint => {
            if (!this.hostTrustStore) {
                return true;
            }

            const result = this.hostTrustStore.verifyFingerprint(config, fingerprint, policy);
            this.lastHostKeyValidation.set(connectionKey, result);

            if (result.allowed) {
                if (result.reason === 'trusted_now') {
                    this._log('HOSTKEY', `trusted new host key for ${connectionKey} via TOFU`);
                }
                return true;
            }

            this._log('HOSTKEY', `blocked host key for ${connectionKey}: ${result.reason}`);
            return false;
        };
    }

    async _buildConnectOptions(config, connectionKey, options = {}) {
        const resolvedConfig = await this._resolveCredentials(config);
        const transfer = this.getTransferConfig();
        const security = this.getSecurityConfig();

        const connectionTimeout = Math.max(1000, Number(transfer.connectionTimeout) || 10000);
        const retryTimes = Math.max(0, Number(transfer.retryTimes) || 0);
        const policy = options.hostKeyPolicy || security.hostKeyPolicy || 'tofu';

        let privateKey;
        if (resolvedConfig.privateKey) {
            privateKey = fs.readFileSync(resolvedConfig.privateKey);
        }

        const connectOptions = {
            host: resolvedConfig.host,
            port: resolvedConfig.port || 22,
            username: resolvedConfig.username,
            password: resolvedConfig.password,
            privateKey,
            passphrase: resolvedConfig.passphrase,
            readyTimeout: connectionTimeout,
            connectionTimeout,
            retries: retryTimes,
            retry_minTimeout: 1000,
            retry_maxTimeout: Math.max(1000, Math.min(connectionTimeout, 10000)),
            tryKeyboard: true,
            strictHostKey: policy !== 'off',
            keepaliveInterval: 30000,
            keepaliveCountMax: 3
        };

        if (policy !== 'off' && this.hostTrustStore) {
            connectOptions.hostHash = 'sha256';
            connectOptions.hostVerifier = this._createHostVerifier(resolvedConfig, connectionKey, policy);
        }

        if (options.captureFingerprint === true) {
            let capturedFingerprint = null;
            connectOptions.strictHostKey = false;
            connectOptions.hostHash = 'sha256';
            connectOptions.hostVerifier = fingerprint => {
                capturedFingerprint = fingerprint;
                return true;
            };
            return { connectOptions, resolvedConfig, getCapturedFingerprint: () => capturedFingerprint };
        }

        return { connectOptions, resolvedConfig };
    }

    _wrapHostKeyError(connectionKey, error) {
        const validation = this.lastHostKeyValidation.get(connectionKey);
        if (!validation || validation.allowed !== false) {
            return error;
        }

        if (validation.reason === 'unknown_host') {
            return new Error(`Host key is unknown for ${connectionKey}. Trust it manually or switch to TOFU mode.`);
        }

        if (validation.reason === 'mismatch') {
            return new Error(
                `Host key mismatch for ${connectionKey}. Expected ${validation.expected}, got ${validation.actual}.`
            );
        }

        return new Error(`Host key validation failed for ${connectionKey}.`);
    }

    async getConnection(config) {
        const key = this._connectionKey(config);

        if (this.connecting.has(key)) {
            try {
                return await this.connecting.get(key);
            } catch (e) {
                this.connecting.delete(key);
            }
        }

        if (this.connections.has(key)) {
            const conn = this.connections.get(key);
            if (this._isConnectionAlive(conn)) {
                conn.lastUsed = Date.now();
                return conn.sftp;
            }
            this._safeCloseConnection(key, conn);
        }

        const connectPromise = this._createConnection(config, key);
        this.connecting.set(key, connectPromise);

        try {
            const sftp = await connectPromise;
            return sftp;
        } catch (error) {
            this.connecting.delete(key);
            throw error;
        } finally {
            this.connecting.delete(key);
        }
    }

    async _createConnection(config, key) {
        const sftp = new SftpClient();

        sftp.on('error', err => {
            this._handleConnectionError(key, err);
        });

        sftp.on('end', () => {
            this._handleConnectionClose(key);
        });

        sftp.on('close', () => {
            this._handleConnectionClose(key);
        });

        try {
            const { connectOptions, resolvedConfig } = await this._buildConnectOptions(config, key);
            await sftp.connect(connectOptions);
            this.lastHostKeyValidation.delete(key);

            this.connections.set(key, { sftp, config: resolvedConfig, lastUsed: Date.now() });
            this.dirCache.set(key, new Set());
            return sftp;
        } catch (error) {
            try {
                await sftp.end();
            } catch (e) {
                // Best effort close.
            }
            throw this._wrapHostKeyError(key, error);
        }
    }

    async trustHostKeyNow(config) {
        if (!this.hostTrustStore) {
            throw new Error('Host trust store is not initialized.');
        }

        const key = this._connectionKey(config);
        const tempClient = new SftpClient();
        try {
            const options = await this._buildConnectOptions(config, key, { captureFingerprint: true });
            await tempClient.connect(options.connectOptions);
            const fingerprint = options.getCapturedFingerprint();
            if (!fingerprint) {
                throw new Error('Failed to capture host fingerprint.');
            }
            this.hostTrustStore.trustFingerprint(config, fingerprint, 'manual');
            this._log('HOSTKEY', `manually trusted host key for ${config.host}:${config.port || 22}`);
            return fingerprint;
        } finally {
            try {
                await tempClient.end();
            } catch (e) {
                // Best effort close.
            }
        }
    }

    _handleConnectionError(key, err) {
        const conn = this.connections.get(key);
        if (conn) {
            this._safeCloseConnection(key, conn);
        }
        this._log('SECURITY', `connection error for ${key}: ${err && err.message ? err.message : String(err)}`);
    }

    _handleConnectionClose(key) {
        if (this.connections.has(key)) {
            this.connections.delete(key);
            this.dirCache.delete(key);
        }
    }

    async ensureDir(config, remoteDir, sftp) {
        const key = this._connectionKey(config);
        if (!this.dirCache.has(key)) {
            this.dirCache.set(key, new Set());
        }

        const cache = this.dirCache.get(key);
        if (cache.has(remoteDir)) {
            return;
        }

        try {
            await sftp.mkdir(remoteDir, true);
            cache.add(remoteDir);

            const parts = remoteDir.split('/').filter(Boolean);
            let currentPath = '';
            for (const part of parts) {
                currentPath += '/' + part;
                cache.add(currentPath);
            }
        } catch (e) {
            cache.add(remoteDir);
        }
    }

    async preConnectAll(configs) {
        if (!configs || configs.length === 0) {
            return [];
        }

        const connectPromises = configs.map(async config => {
            try {
                await this.getConnection(config);
                return { success: true, server: config.name || config.host };
            } catch (error) {
                return { success: false, server: config.name || config.host, error: error.message };
            }
        });

        return Promise.all(connectPromises);
    }

    async closeConnection(config) {
        const key = this._connectionKey(config);
        if (this.connections.has(key)) {
            const conn = this.connections.get(key);
            this.connections.delete(key);
            this.dirCache.delete(key);

            try {
                await Promise.race([
                    conn.sftp.end(),
                    new Promise(resolve => setTimeout(resolve, 5000))
                ]);
            } catch (e) {
                // Best effort close.
            }
        }
    }

    async closeAll() {
        const closePromises = [];
        for (const [, conn] of this.connections) {
            closePromises.push(
                Promise.race([
                    conn.sftp.end().catch(() => {}),
                    new Promise(resolve => setTimeout(resolve, 3000))
                ])
            );
        }

        await Promise.all(closePromises);
        this.connections.clear();
        this.dirCache.clear();
    }

    async dispose() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        await this.closeAll();
    }

    getConnectionStatus() {
        const status = [];
        for (const [key, conn] of this.connections) {
            status.push({
                key,
                server: conn.config.name || conn.config.host,
                lastUsed: conn.lastUsed,
                connected: true
            });
        }
        return status;
    }

    isConnected(config) {
        const key = this._connectionKey(config);
        return this.connections.has(key);
    }
}

module.exports = ConnectionManager;

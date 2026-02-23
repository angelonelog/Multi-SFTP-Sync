const fs = require('fs');
const path = require('path');

class HostTrustStore {
    constructor(options = {}) {
        this.context = options.context;
        this.getSecurityConfig = options.getSecurityConfig || (() => ({}));
        this.logger = options.logger || (() => {});
        this.state = { entries: {} };
        this.loadedPath = null;
    }

    _hostKey(config) {
        return `${config.host}:${config.port || 22}`;
    }

    _resolveStorePath() {
        const security = this.getSecurityConfig();
        const customPath = security.trustStorePath;
        if (typeof customPath === 'string' && customPath.trim().length > 0) {
            return path.resolve(customPath.trim());
        }

        const root = this.context && this.context.globalStorageUri
            ? this.context.globalStorageUri.fsPath
            : path.resolve('.');
        return path.join(root, 'host-trust-store.json');
    }

    _ensureLoaded() {
        const storePath = this._resolveStorePath();
        if (this.loadedPath === storePath) {
            return;
        }

        this.loadedPath = storePath;
        this.state = { entries: {} };

        try {
            const dir = path.dirname(storePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            if (fs.existsSync(storePath)) {
                const content = fs.readFileSync(storePath, 'utf8');
                const parsed = JSON.parse(content);
                if (parsed && typeof parsed === 'object' && parsed.entries) {
                    this.state = parsed;
                }
            }
        } catch (error) {
            this.logger(`[HOSTKEY] failed to load trust store: ${error.message}`);
            this.state = { entries: {} };
        }
    }

    _persist() {
        if (!this.loadedPath) {
            this._ensureLoaded();
        }
        fs.writeFileSync(this.loadedPath, JSON.stringify(this.state, null, 2), 'utf8');
    }

    getTrustedEntry(config) {
        this._ensureLoaded();
        return this.state.entries[this._hostKey(config)] || null;
    }

    trustFingerprint(config, fingerprint, source = 'manual') {
        this._ensureLoaded();
        const key = this._hostKey(config);
        this.state.entries[key] = {
            host: config.host,
            port: config.port || 22,
            fingerprint,
            source,
            trustedAt: new Date().toISOString()
        };
        this._persist();
    }

    removeTrust(hostKey) {
        this._ensureLoaded();
        if (this.state.entries[hostKey]) {
            delete this.state.entries[hostKey];
            this._persist();
            return true;
        }
        return false;
    }

    listEntries() {
        this._ensureLoaded();
        return Object.entries(this.state.entries).map(([key, value]) => ({
            key,
            ...value
        }));
    }

    verifyFingerprint(config, fingerprint, policy = 'tofu') {
        this._ensureLoaded();
        if (policy === 'off') {
            return { allowed: true, policy, reason: 'policy_off' };
        }

        const key = this._hostKey(config);
        const current = this.state.entries[key];

        if (!current) {
            if (policy === 'strict') {
                return {
                    allowed: false,
                    policy,
                    reason: 'unknown_host',
                    message: `No trusted host key exists for ${key}.`
                };
            }

            this.trustFingerprint(config, fingerprint, 'tofu');
            this.logger(`[HOSTKEY] trusted new host fingerprint via TOFU for ${key}`);
            return { allowed: true, policy, reason: 'trusted_now' };
        }

        if (current.fingerprint === fingerprint) {
            return { allowed: true, policy, reason: 'match' };
        }

        return {
            allowed: false,
            policy,
            reason: 'mismatch',
            expected: current.fingerprint,
            actual: fingerprint,
            message: `Host key mismatch for ${key}.`
        };
    }
}

module.exports = HostTrustStore;

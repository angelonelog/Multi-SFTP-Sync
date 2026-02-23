class CredentialStore {
    constructor(options = {}) {
        this.context = options.context;
        this.logger = options.logger || (() => {});
        this.onAutoMigrated = options.onAutoMigrated || (() => {});
        this.didNotifyMigration = false;
    }

    _secretKey(workspaceId, config, field) {
        const host = config.host || 'unknown-host';
        const port = config.port || 22;
        const username = config.username || 'unknown-user';
        const workspace = workspaceId || 'unknown-workspace';
        return `${workspace}:${host}:${port}:${username}:${field}`;
    }

    async resolve(config, workspaceId, options = {}) {
        const autoMigrate = options.autoMigrate !== false;
        const overwrite = options.overwrite === true;
        const result = { ...config };

        const migratedFields = [];
        for (const field of ['password', 'passphrase']) {
            const key = this._secretKey(workspaceId, config, field);
            const secretValue = this.context ? await this.context.secrets.get(key) : undefined;
            const plainValue = config[field];

            if (typeof secretValue === 'string' && secretValue.length > 0 && !overwrite) {
                result[field] = secretValue;
                continue;
            }

            if (typeof plainValue === 'string' && plainValue.length > 0 && autoMigrate && this.context) {
                await this.context.secrets.store(key, plainValue);
                result[field] = plainValue;
                migratedFields.push(field);
                this.logger(`[SECURITY] auto-migrated ${field} to SecretStorage for ${config.host}:${config.port || 22}`);
                continue;
            }

            if (typeof secretValue === 'string' && secretValue.length > 0 && overwrite) {
                result[field] = secretValue;
            }
        }

        if (migratedFields.length > 0 && !this.didNotifyMigration) {
            this.didNotifyMigration = true;
            this.onAutoMigrated(migratedFields);
        }

        return {
            config: result,
            migratedFields
        };
    }

    async migrateFromPlaintext(config, workspaceId, options = {}) {
        const overwrite = options.overwrite !== false;
        let migratedCount = 0;

        for (const field of ['password', 'passphrase']) {
            const plainValue = config[field];
            if (typeof plainValue !== 'string' || plainValue.length === 0 || !this.context) {
                continue;
            }

            const key = this._secretKey(workspaceId, config, field);
            if (!overwrite) {
                const secretValue = await this.context.secrets.get(key);
                if (typeof secretValue === 'string' && secretValue.length > 0) {
                    continue;
                }
            }

            await this.context.secrets.store(key, plainValue);
            migratedCount++;
        }

        return migratedCount;
    }

    async migrateAll(configs, workspaceId, options = {}) {
        let migrated = 0;
        for (const config of configs || []) {
            migrated += await this.migrateFromPlaintext(config, workspaceId, options);
        }
        return migrated;
    }
}

module.exports = CredentialStore;

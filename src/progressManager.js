const vscode = require('vscode');

/**
 * Progress manager
 */
class ProgressManager {
    constructor() {
        this.activeOperations = new Map();
    }

    createCancellationError() {
        const error = new Error('Operation canceled');
        error.code = 'OPERATION_CANCELED';
        return error;
    }

    isCanceled(token) {
        return Boolean(token && token.isCancellationRequested);
    }

    throwIfCanceled(token) {
        if (this.isCanceled(token)) {
            throw this.createCancellationError();
        }
    }

    /**
     * Show upload progress
     */
    async withProgress(title, task) {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: title,
                cancellable: true
            },
            async (progress, token) => {
                const operation = {
                    title,
                    canceled: false
                };
                this.activeOperations.set(title, operation);
                token.onCancellationRequested(() => {
                    operation.canceled = true;
                });

                try {
                    return await task(progress, token);
                } finally {
                    this.activeOperations.delete(title);
                }
            }
        );
    }

    /**
     * Batch operation progress
     */
    async batchProgress(title, items, processor) {
        return this.withProgress(title, async (progress, token) => {
            const total = items.length;
            const results = [];

            for (let i = 0; i < total; i++) {
                if (token.isCancellationRequested) {
                    break;
                }

                this.throwIfCanceled(token);

                progress.report({
                    increment: (100 / total),
                    message: `${i + 1}/${total}`
                });

                const result = await processor(items[i], progress, token);
                results.push(result);
            }

            return results;
        });
    }
}

module.exports = ProgressManager;

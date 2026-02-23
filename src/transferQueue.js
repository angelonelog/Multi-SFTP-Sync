function createCancellationError() {
    const error = new Error('Operation canceled');
    error.code = 'OPERATION_CANCELED';
    return error;
}

class TransferQueue {
    constructor(options = {}) {
        this.concurrency = Math.max(1, Number(options.concurrency) || 1);
        this.logger = options.logger || (() => {});
        this.queue = [];
        this.activeCount = 0;
    }

    setConcurrency(value) {
        this.concurrency = Math.max(1, Number(value) || 1);
        this._drain();
    }

    stats() {
        return {
            active: this.activeCount,
            queued: this.queue.length,
            concurrency: this.concurrency
        };
    }

    clearPending(reason = 'Queue cleared') {
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            item.reject(new Error(reason));
            item.disposeCancel?.();
        }
    }

    enqueue(task, options = {}) {
        return new Promise((resolve, reject) => {
            const token = options.token;
            const item = {
                task,
                resolve,
                reject,
                token,
                label: options.label || 'task',
                started: false,
                canceled: false,
                disposeCancel: null
            };

            if (token && token.isCancellationRequested) {
                reject(createCancellationError());
                return;
            }

            if (token && typeof token.onCancellationRequested === 'function') {
                item.disposeCancel = token.onCancellationRequested(() => {
                    if (item.started) {
                        return;
                    }
                    item.canceled = true;
                    this.queue = this.queue.filter(queued => queued !== item);
                    reject(createCancellationError());
                    this.logger(`[QUEUE] canceled before start: ${item.label}`);
                });
            }

            this.queue.push(item);
            this.logger(`[QUEUE] enqueued: ${item.label} (active=${this.activeCount} queued=${this.queue.length})`);
            this._drain();
        });
    }

    _drain() {
        while (this.activeCount < this.concurrency && this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item || item.canceled) {
                continue;
            }

            item.started = true;
            this.activeCount++;
            this.logger(`[QUEUE] started: ${item.label} (active=${this.activeCount})`);

            Promise.resolve()
                .then(() => item.task(item.token))
                .then(result => item.resolve(result))
                .catch(error => item.reject(error))
                .finally(() => {
                    this.activeCount = Math.max(0, this.activeCount - 1);
                    item.disposeCancel?.();
                    this.logger(`[QUEUE] finished: ${item.label} (active=${this.activeCount} queued=${this.queue.length})`);
                    this._drain();
                });
        }
    }
}

module.exports = TransferQueue;

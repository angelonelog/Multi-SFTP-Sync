const vscode = require('vscode');

/**
 * Status bar manager
 * Display SFTP sync status in the lower-left corner
 */
class StatusBarManager {
    constructor(outputChannel) {
        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        
        // Initial state
        this.statusBarItem.text = '$(cloud) SFTP';
        this.statusBarItem.tooltip = 'Multi SFTP Sync - Click to view operation logs';
        this.statusBarItem.command = 'multi-sftp-sync.showStatus';
        this.statusBarItem.show();

        // Create dedicated status output channel (for history display)
        this.statusOutputChannel = vscode.window.createOutputChannel('SFTP Operation Log');
        
        // Track whether output channel has been opened
        this.isOutputChannelVisible = false;

        // Status statistics
        this.stats = {
            uploading: 0,
            downloading: 0,
            deleting: 0,
            totalUploaded: 0,
            totalDownloaded: 0,
            totalDeleted: 0,
            lastOperation: null,
            errors: []
        };

        // List of files currently being processed
        this.currentFiles = [];

        // Operation log lines (latest 50)
        this.logLines = [];
        this.maxLogLines = 50;

        // Operation history (latest 50) - deprecated, use logLines
        this.history = [];
        this.maxHistory = 50;
    }

    /**
     * Update status bar display
     */
    updateDisplay() {
        const { uploading, downloading, deleting } = this.stats;
        const currentFile = this.currentFiles.length > 0 ? this.currentFiles[this.currentFiles.length - 1] : null;
        
        if (uploading > 0) {
            const displayName = currentFile ? `${currentFile}` : `${uploading} files`;
            this.statusBarItem.text = `$(sync~spin) SFTP (${displayName})`;
            this.statusBarItem.tooltip = `Uploading: ${displayName}\nClick to view operation logs`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (downloading > 0) {
            const displayName = currentFile ? `${currentFile}` : `${downloading} files`;
            this.statusBarItem.text = `$(sync~spin) SFTP (${displayName})`;
            this.statusBarItem.tooltip = `Downloading: ${displayName}\nClick to view operation logs`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (deleting > 0) {
            const displayName = currentFile ? `${currentFile}` : `${deleting} files`;
            this.statusBarItem.text = `$(sync~spin) SFTP (${displayName})`;
            this.statusBarItem.tooltip = `Deleting: ${displayName}\nClick to view operation logs`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            // Idle state
            this.statusBarItem.text = '$(cloud) SFTP';
            this.statusBarItem.tooltip = this.getIdleTooltip();
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    /**
     * Get idle-state tooltip text
     */
    getIdleTooltip() {
        const { totalUploaded, totalDownloaded, totalDeleted, lastOperation } = this.stats;
        
        let tooltip = 'Multi SFTP Sync\n\n';
        tooltip += `Totals:\n`;
        tooltip += `  Uploaded: ${totalUploaded} files\n`;
        tooltip += `  Downloaded: ${totalDownloaded} files\n`;
        tooltip += `  Deleted: ${totalDeleted} files\n`;
        
        if (lastOperation) {
            tooltip += `\nLast operation: ${lastOperation}`;
        }
        
        tooltip += '\n\nClick to view details';
        
        return tooltip;
    }

    /**
     * Start upload
     */
    startUpload(fileName) {
        this.stats.uploading++;
        this.currentFiles.push(fileName);
        this.addHistory('upload', fileName, 'start');
        this.updateDisplay();
    }

    /**
     * Finish upload
     */
    finishUpload(fileName, success = true, error = null) {
        this.stats.uploading = Math.max(0, this.stats.uploading - 1);
        // Remove from current file list
        const index = this.currentFiles.indexOf(fileName);
        if (index > -1) {
            this.currentFiles.splice(index, 1);
        }
        
        if (success) {
            this.stats.totalUploaded++;
            this.stats.lastOperation = `Upload: ${fileName}`;
            this.addHistory('upload', fileName, 'success');
        } else {
            this.addHistory('upload', fileName, 'error', error);
            this.stats.errors.push({ type: 'upload', file: fileName, error, time: new Date() });
        }
        
        this.updateDisplay();
    }

    /**
     * Start download
     */
    startDownload(fileName) {
        this.stats.downloading++;
        this.currentFiles.push(fileName);
        this.addHistory('download', fileName, 'start');
        this.updateDisplay();
    }

    /**
     * Finish download
     */
    finishDownload(fileName, success = true, error = null) {
        this.stats.downloading = Math.max(0, this.stats.downloading - 1);
        // Remove from current file list
        const index = this.currentFiles.indexOf(fileName);
        if (index > -1) {
            this.currentFiles.splice(index, 1);
        }
        
        if (success) {
            this.stats.totalDownloaded++;
            this.stats.lastOperation = `Download: ${fileName}`;
            this.addHistory('download', fileName, 'success');
        } else {
            this.addHistory('download', fileName, 'error', error);
            this.stats.errors.push({ type: 'download', file: fileName, error, time: new Date() });
        }
        
        this.updateDisplay();
    }

    /**
     * Start delete
     */
    startDelete(fileName) {
        this.stats.deleting++;
        this.currentFiles.push(fileName);
        this.addHistory('delete', fileName, 'start');
        this.updateDisplay();
    }

    /**
     * Finish delete
     */
    finishDelete(fileName, success = true, error = null) {
        this.stats.deleting = Math.max(0, this.stats.deleting - 1);
        // Remove from current file list
        const index = this.currentFiles.indexOf(fileName);
        if (index > -1) {
            this.currentFiles.splice(index, 1);
        }
        
        if (success) {
            this.stats.totalDeleted++;
            this.stats.lastOperation = `Delete: ${fileName}`;
            this.addHistory('delete', fileName, 'success');
        } else {
            this.addHistory('delete', fileName, 'error', error);
            this.stats.errors.push({ type: 'delete', file: fileName, error, time: new Date() });
        }
        
        this.updateDisplay();
    }

    /**
     * Add operation history - record only success/failure, not start
     */
    addHistory(type, fileName, status, error = null) {
        // Skip start status and record only final results
        if (status === 'start') {
            return;
        }

        const record = {
            type,
            fileName,
            status,
            error,
            time: new Date()
        };

        this.history.unshift(record);
        
        // Keep history size bounded
        if (this.history.length > this.maxHistory) {
            this.history = this.history.slice(0, this.maxHistory);
        }
    }
    
    /**
     * Add log line (full format)
     */
    addLogLine(logLine) {
        const record = {
            line: logLine,
            time: new Date()
        };
        
        this.logLines.unshift(record);
        
        // Keep log size bounded
        if (this.logLines.length > this.maxLogLines) {
            this.logLines = this.logLines.slice(0, this.maxLogLines);
        }
        
        // If output channel is open, refresh automatically
        if (this.isOutputChannelVisible) {
            this.refreshOutputChannel();
        }
    }
    
    /**
     * Refresh output channel content (without changing visibility)
     */
    refreshOutputChannel() {
        const channel = this.statusOutputChannel;

        channel.clear();
        channel.appendLine('='.repeat(70));
        channel.appendLine('Multi SFTP Sync Operation Log');
        channel.appendLine(`Updated at: ${new Date().toLocaleString('en-US')}`);
        channel.appendLine('='.repeat(70));
        channel.appendLine('');

        if (this.logLines.length === 0) {
            channel.appendLine('  (No operation records yet)');
        } else {
            // Display in chronological order (latest at bottom)
            this.logLines.slice().reverse().forEach(record => {
                const time = record.time.toLocaleTimeString('en-US');
                channel.appendLine(`[${time}] ${record.line}`);
            });
        }

        channel.appendLine('');
        channel.appendLine('='.repeat(70));
    }

    /**
     * Show status details - detailed operation logs (up to 50)
     */
    showStatus() {
        this.isOutputChannelVisible = true;
        this.refreshOutputChannel();
        this.statusOutputChannel.show(true);
    }

    /**
     * Get operation type text
     */
    getOperationText(type) {
        const texts = {
            'upload': 'Upload',
            'download': 'Download',
            'delete': 'Delete'
        };
        return texts[type] || type;
    }

    /**
     * Get status text
     */
    getStatusText(status) {
        const texts = {
            'start': 'Start',
            'success': 'Success',
            'error': 'Failed'
        };
        return texts[status] || status;
    }

    /**
     * Generate status page HTML
     */
    getStatusHtml() {
        const { uploading, downloading, deleting, totalUploaded, totalDownloaded, totalDeleted } = this.stats;

        let historyHtml = '';
        if (this.history.length > 0) {
            historyHtml = this.history.map(record => {
                const icon = this.getOperationIcon(record.type, record.status);
                const statusClass = record.status === 'error' ? 'error' : record.status === 'success' ? 'success' : 'pending';
                const time = record.time.toLocaleTimeString('en-US');
                
                return `
                    <div class="history-item ${statusClass}">
                        <span class="icon">${icon}</span>
                        <span class="file">${record.fileName}</span>
                        <span class="time">${time}</span>
                        ${record.error ? `<div class="error-msg">${record.error}</div>` : ''}
                    </div>
                `;
            }).join('');
        } else {
            historyHtml = '<div class="empty">No operation records yet</div>';
        }

        let errorsHtml = '';
        if (this.stats.errors.length > 0) {
            errorsHtml = `
                <div class="section">
                    <h2>❌ Error Records (${this.stats.errors.length})</h2>
                    ${this.stats.errors.slice(0, 5).map(err => `
                        <div class="error-item">
                            <div class="error-header">
                                <span class="error-type">${err.type}</span>
                                <span class="error-file">${err.file}</span>
                            </div>
                            <div class="error-message">${err.error}</div>
                            <div class="error-time">${err.time.toLocaleString('en-US')}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                        padding: 20px;
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    h1 {
                        color: var(--vscode-foreground);
                        border-bottom: 2px solid var(--vscode-panel-border);
                        padding-bottom: 10px;
                    }
                    h2 {
                        color: var(--vscode-foreground);
                        margin-top: 20px;
                        font-size: 18px;
                    }
                    .section {
                        margin-bottom: 30px;
                    }
                    .stats {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                        gap: 15px;
                        margin: 20px 0;
                    }
                    .stat-card {
                        background: var(--vscode-editor-inactiveSelectionBackground);
                        padding: 15px;
                        border-radius: 8px;
                        border-left: 4px solid var(--vscode-button-background);
                    }
                    .stat-card.active {
                        border-left-color: var(--vscode-editorWarning-foreground);
                        background: var(--vscode-inputValidation-warningBackground);
                    }
                    .stat-label {
                        font-size: 12px;
                        opacity: 0.8;
                        margin-bottom: 5px;
                    }
                    .stat-value {
                        font-size: 24px;
                        font-weight: bold;
                    }
                    .history-item {
                        display: flex;
                        align-items: center;
                        padding: 10px;
                        margin: 5px 0;
                        background: var(--vscode-editor-inactiveSelectionBackground);
                        border-radius: 4px;
                        gap: 10px;
                    }
                    .history-item.success {
                        border-left: 3px solid #4caf50;
                    }
                    .history-item.error {
                        border-left: 3px solid #f44336;
                    }
                    .history-item.pending {
                        border-left: 3px solid #ff9800;
                    }
                    .history-item .icon {
                        font-size: 16px;
                    }
                    .history-item .file {
                        flex: 1;
                        font-family: 'Courier New', monospace;
                        font-size: 13px;
                    }
                    .history-item .time {
                        font-size: 11px;
                        opacity: 0.7;
                    }
                    .error-msg {
                        width: 100%;
                        margin-top: 5px;
                        padding: 5px;
                        background: var(--vscode-inputValidation-errorBackground);
                        border-radius: 3px;
                        font-size: 11px;
                    }
                    .error-item {
                        background: var(--vscode-inputValidation-errorBackground);
                        padding: 10px;
                        margin: 10px 0;
                        border-radius: 4px;
                        border-left: 3px solid var(--vscode-inputValidation-errorBorder);
                    }
                    .error-header {
                        display: flex;
                        gap: 10px;
                        margin-bottom: 5px;
                    }
                    .error-type {
                        background: var(--vscode-badge-background);
                        color: var(--vscode-badge-foreground);
                        padding: 2px 8px;
                        border-radius: 3px;
                        font-size: 11px;
                        text-transform: uppercase;
                    }
                    .error-file {
                        font-family: 'Courier New', monospace;
                        font-size: 12px;
                    }
                    .error-message {
                        margin: 5px 0;
                        font-size: 12px;
                    }
                    .error-time {
                        font-size: 11px;
                        opacity: 0.7;
                    }
                    .empty {
                        text-align: center;
                        padding: 40px;
                        opacity: 0.5;
                    }
                </style>
            </head>
            <body>
                <h1>📊 Multi SFTP Sync Status</h1>
                
                <div class="section">
                    <h2>📈 Live Status</h2>
                    <div class="stats">
                        <div class="stat-card ${uploading > 0 ? 'active' : ''}">
                            <div class="stat-label">⬆️ Uploading</div>
                            <div class="stat-value">${uploading}</div>
                        </div>
                        <div class="stat-card ${downloading > 0 ? 'active' : ''}">
                            <div class="stat-label">⬇️ Downloading</div>
                            <div class="stat-value">${downloading}</div>
                        </div>
                        <div class="stat-card ${deleting > 0 ? 'active' : ''}">
                            <div class="stat-label">🗑️ Deleting</div>
                            <div class="stat-value">${deleting}</div>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <h2>📊 Statistics</h2>
                    <div class="stats">
                        <div class="stat-card">
                            <div class="stat-label">✅ Uploaded</div>
                            <div class="stat-value">${totalUploaded}</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">✅ Downloaded</div>
                            <div class="stat-value">${totalDownloaded}</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">✅ Deleted</div>
                            <div class="stat-value">${totalDeleted}</div>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <h2>📝 Operation History (latest ${this.history.length})</h2>
                    ${historyHtml}
                </div>

                ${errorsHtml}
            </body>
            </html>
        `;
    }

    /**
     * Get operation icon
     */
    getOperationIcon(type, status) {
        if (status === 'error') return '❌';
        if (status === 'start') return '⏳';
        
        // Use only ✅ for successful operations
        return '✅';
    }

    /**
     * Reset statistics
     */
    reset() {
        this.stats = {
            uploading: 0,
            downloading: 0,
            deleting: 0,
            totalUploaded: 0,
            totalDownloaded: 0,
            totalDeleted: 0,
            lastOperation: null,
            errors: []
        };
        this.history = [];
        this.updateDisplay();
    }

    /**
     * Dispose
     */
    dispose() {
        this.statusBarItem.dispose();
    }
}

module.exports = StatusBarManager;

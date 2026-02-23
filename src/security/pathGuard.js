const path = require('path');

function normalizeRemotePath(inputPath) {
    const value = typeof inputPath === 'string' ? inputPath : '';
    const normalized = path.posix.normalize(value);
    if (!normalized.startsWith('/')) {
        return path.posix.normalize('/' + normalized);
    }
    return normalized;
}

function assertLocalPathInsideWorkspace(workspaceRoot, localPath, options = {}) {
    if (options.enabled === false) {
        return path.resolve(localPath);
    }

    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedPath = path.resolve(localPath);
    const relative = path.relative(resolvedRoot, resolvedPath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        const reason = `Local path traversal blocked: ${resolvedPath}`;
        const error = new Error(reason);
        error.code = 'PATH_GUARD_LOCAL_TRAVERSAL';
        throw error;
    }

    return resolvedPath;
}

function assertRemotePathSafe(remoteBase, remotePath, options = {}) {
    if (options.enabled === false) {
        return normalizeRemotePath(remotePath);
    }

    const normalizedBase = normalizeRemotePath(remoteBase || '/');
    const normalizedTarget = normalizeRemotePath(remotePath || '/');

    const relative = path.posix.relative(normalizedBase, normalizedTarget);
    if (relative.startsWith('..') || path.posix.isAbsolute(relative)) {
        const reason = `Remote path traversal blocked: ${normalizedTarget} is outside ${normalizedBase}`;
        const error = new Error(reason);
        error.code = 'PATH_GUARD_REMOTE_TRAVERSAL';
        throw error;
    }

    return normalizedTarget;
}

function isCriticalRemotePath(remotePath, criticalPaths = []) {
    const target = normalizeRemotePath(remotePath || '/');
    return criticalPaths.some(item => normalizeRemotePath(item) === target);
}

module.exports = {
    normalizeRemotePath,
    assertLocalPathInsideWorkspace,
    assertRemotePathSafe,
    isCriticalRemotePath
};

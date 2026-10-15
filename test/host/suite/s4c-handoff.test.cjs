// Configured-scope import and pending-scope restart in the real Extension Host.
// Directory event boundaries are explicit; later file edits arrive via fs.watch.
// No workspace FileSystemWatcher can mask a missing persistent direct owner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { DiffTracker } = require('../../../out/diffTracker.js');
const { validateAndCanonicalizeScope } = require('../../../out/monitoringScope.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(description, predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) { throw new Error(`Timed out waiting for ${description}`); }
        await delay(50);
    }
}

module.exports = async function s4cHandoffHost(workspace) {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-s4c-host-'));
    // Stage outside every workspace while retaining a genuine same-filesystem
    // move, avoiding exposure of staging to workspace-scoped observers.
    const source = fs.mkdtempSync(path.join(path.dirname(workspace), 's4c-import-source-'));
    // Keep the configured include present while its imported child disappears.
    // Otherwise Reset refuses the missing include before reaching the refresh race.
    const includedParent = vscode.Uri.file(path.join(workspace, 's4c-import-owner')).fsPath;
    fs.mkdirSync(includedParent);
    const root = path.join(includedParent, 'imported');
    const nested = path.join(root, 'deep');
    const directories = [root, nested];
    const files = [path.join(root, 'readme.txt'), path.join(nested, 'tracked.txt')];
    let tracker = new DiffTracker(vscode.Uri.file(storage));
    const nativeWatch = fs.watch;
    const handles = [];
    // Observe only resource lifetimes. Forward the production callback unchanged
    // to the real native watcher; never synthesize or invoke a watcher event.
    fs.watch = function (directory, ...args) {
        const watcher = nativeWatch.call(this, directory, ...args);
        if (directories.includes(String(directory))) {
            const handle = { directory: String(directory), watcher, closed: false };
            handles.push(handle);
            watcher.once('close', () => { handle.closed = true; });
        }
        return watcher;
    };
    try {
        assert.equal(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(source)), undefined);
        assert.equal(fs.statSync(source).dev, fs.statSync(workspace).dev,
            'staging must remain on the destination filesystem');
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspace));
        assert.ok(folder, 'the imported tree must have an actual workspace owner');
        // This scenario imports into one folder. An all-roots include would
        // also request an absent tree in the Host suite's second workspace,
        // whose ordinary watcher exclusions correctly make restore fail closed.
        const include = { scope: 'folder', folder: folder.name, path: 's4c-import-owner' };
        const requested = validateAndCanonicalizeScope({
            mode: 'rules', includes: [include], excludes: []
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        tracker.effectiveMonitoringScope = { kind: 'configured', ...requested.scope };
        tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
        tracker.isRecording = true;
        tracker.externalWatcherEnabled = true;
        tracker.snapshotInitialized = true;
        assert.equal(tracker.getBaselineState(), 'ready');
        assert.equal(tracker.fileWatchers.length, 0);

        fs.mkdirSync(path.join(source, 'deep'));
        fs.writeFileSync(path.join(source, 'readme.txt'), 'imported root text\n');
        fs.writeFileSync(path.join(source, 'deep', 'tracked.txt'), 'imported nested text\n');
        fs.renameSync(source, root);
        await tracker.onExternalFileCreated(vscode.Uri.file(root));

        assert.equal(tracker.importedDirectoryWatchers.size, 0,
            'successful configured import must release its temporary bridge owners');
        assert.deepEqual([...tracker.supplementalDirectoryWatchers.keys()].sort(), [...directories].sort(),
            'each imported directory must have an independently established persistent owner');
        for (const directory of directories) {
            const owner = tracker.supplementalDirectoryWatchers.get(directory);
            assert.equal(owner.epoch, tracker.sessionEpoch);
            assert.equal(owner.coverageRoot, root);
            const acquired = handles.filter(handle => handle.directory === directory);
            assert.equal(acquired.length, 2, 'bridge and replacement must acquire separate native handles');
            assert.notEqual(acquired[0].watcher, acquired[1].watcher);
        }
        await until('temporary imported bridge handles to close', () =>
            handles.filter(handle => handle.closed).length === directories.length);
        assert.equal(handles.filter(handle => !handle.closed).length, directories.length);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);

        for (const [index, filePath] of files.entries()) {
            const content = index === 0 ? 'imported root text\n' : 'imported nested text\n';
            const change = tracker.getTrackedChanges().find(item => item.filePath === filePath);
            assert.equal(change?.baselineExists, false, 'imported text must enter review with an absent baseline');
            assert.equal(change.currentContent, content);
            assert.equal(change.unavailableReason, undefined);
            const token = tracker.getReviewToken(filePath);
            assert.ok(token, 'the imported text must expose a real review token');
            const kept = await tracker.keepAllChangesInFile(filePath, token);
            assert.equal(kept.status, 'success', JSON.stringify(kept));
            assert.equal(tracker.getOriginalContent(filePath), content);
            assert.equal(tracker.getTrackedChanges().some(item => item.filePath === filePath), false);
        }

        // These writes are the only source of subsequent change notifications.
        // In particular, do not call dispatchExternalEvent or a native listener.
        await delay(250);
        for (const filePath of files) { fs.writeFileSync(filePath, 'native edit after Keep\n'); }
        await until('persistent direct owners to observe native edits after Keep', () =>
            files.every(filePath => tracker.getTrackedChanges().some(change =>
                change.filePath === filePath && change.currentContent === 'native edit after Keep\n')));
        for (const [index, filePath] of files.entries()) {
            const change = tracker.getTrackedChanges().find(item => item.filePath === filePath);
            assert.equal(change.baselineExists, true);
            assert.equal(change.unavailableReason, undefined);
            assert.equal(tracker.getOriginalContent(filePath),
                index === 0 ? 'imported root text\n' : 'imported nested text\n');
        }
        assert.equal(tracker.importedDirectoryWatchers.size, 0);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0,
            'restart uncertainty must not be presented as a current runtime coverage gap');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(saved.version, 4);
        assert.equal(new Map(saved.coverageGaps).get(root)?.subtree?.reasonCode,
            'imported-coverage-restart-required', 'saved review must not claim that an OS handle survives restart');
        assert.equal(new Map(saved.coverageGaps).get(root)?.importedCoverageRequired, true);

        const pending = validateAndCanonicalizeScope({
            mode: 'rules', includes: [include],
            excludes: [{ scope: 'folder', folder: folder.name, pattern: 's4c-import-owner' }]
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(pending.ok, true);
        tracker.setPendingMonitoringScope(pending.scope);
        await tracker.onExternalFileCreated(vscode.Uri.file(root));
        await tracker.dispose();
        await until('old session owners to close before restore', () => handles.every(handle => handle.closed));
        tracker = new DiffTracker(vscode.Uri.file(storage));
        tracker.setPendingMonitoringScope(pending.scope);
        assert.equal(await tracker.restorePersistedState(), 'restored', tracker.getPersistenceIssue());
        assert.ok(tracker.supplementalDirectoryWatchers.get(root)?.epoch === tracker.sessionEpoch,
            'pending control must not hide the imported persistent owner during restore');
        tracker.setPendingMonitoringScope(undefined);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === root));
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        // Restore/Reset exercise their normal host-watch setup. Close only those
        // general watches before the proof edit so they cannot mask owner loss.
        tracker.fileWatchers.forEach(watcher => watcher.dispose());
        tracker.fileWatchers = [];
        await delay(250);
        for (const filePath of files) { fs.writeFileSync(filePath, 'native edit after pending restart and Reset\n'); }
        await until('restored owners to observe edits after pending restart and Reset', () =>
            files.every(filePath => tracker.getTrackedChanges().some(change =>
                change.filePath === filePath && change.currentContent === 'native edit after pending restart and Reset\n')));
        for (const filePath of files) {
            assert.equal(tracker.getOriginalContent(filePath), 'native edit after Keep\n');
            assert.equal(tracker.getTrackedChanges().find(change => change.filePath === filePath)?.unavailableReason, undefined);
        }
        assert.equal(tracker.fileWatchers.length, 0);

        tracker.stopRecording();
        await until('Stop to release every imported native handle', () => handles.every(handle => handle.closed));
        assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch), 0);
        assert.equal(tracker.supplementalIdentityTimer, undefined);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const stopped = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(stopped.isRecording, false);
        assert.equal(new Map(stopped.coverageGaps).get(root)?.subtree?.reasonCode,
            'imported-coverage-restart-required');

        // Issue #45: real Extension Host, stopped Clear followed by
        // same-process tracker disposal/restoration. The old restart
        // obligation is future Start work, not a live stopped-state warning.
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const cleared = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(cleared.isRecording, false);
        assert.equal(new Map(cleared.coverageGaps).get(root)?.importedCoverageRequired, true);
        await tracker.dispose();
        tracker = new DiffTracker(vscode.Uri.file(storage));
        assert.equal(await tracker.restorePersistedState(), 'restored', tracker.getPersistenceIssue());
        assert.equal(tracker.getIsRecording(), false);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.deepEqual(tracker.getCoverageGaps(), []);
        const { DiffTreeDataProvider } = require('../../../out/diffTreeView.js');
        const { StatusBarManager } = require('../../../out/statusBarManager.js');
        const tree = new DiffTreeDataProvider(tracker);
        const status = new StatusBarManager(tracker);
        try {
            assert.equal((await tree.getChildren()).some(item => item.label === 'Monitoring Coverage Limited'), false);
            assert.equal(status.statusBarItem.text, '$(circle-outline) Not Recording');
        } finally {
            tree.dispose();
            status.dispose();
        }
        assert.equal(tracker.startRecording(), true);
        await until('fresh baseline after stopped Clear and restore', () => tracker.getBaselineState() === 'ready');
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        for (const directory of directories) {
            assert.equal(tracker.supplementalDirectoryWatchers.get(directory)?.epoch, tracker.sessionEpoch,
                'the new recording must independently restore each imported native watcher');
        }
        tracker.fileWatchers.forEach(watcher => watcher.dispose());
        tracker.fileWatchers = [];
        await delay(250);
        fs.writeFileSync(files[0], 'native edit after stopped Clear reload Start\n');
        await until('native-only edit after Issue #45 restart', () =>
            tracker.getTrackedChanges().some(change =>
                change.filePath === files[0] && change.currentContent === 'native edit after stopped Clear reload Start\n'));
        // A retired-path decision must not survive an asynchronous refresh.
        // Use actual filesystem moves and native owners; do not synthesize a
        // directory notification to make the missing watcher appear covered.
        // Windows prevents renaming a directory while native watch handles
        // are open. Release OS handles only for the filesystem move; retain
        // the imported obligation and require Reset to install real owners.
        if (process.platform === 'win32') {
            tracker.disposeFileWatchers();
            await until('native handles to release the Windows move', () => handles.every(handle => handle.closed));
        }
        fs.renameSync(root, source);
        const refresh = tracker.refreshIgnoreMatchers.bind(tracker);
        let recreated = false;
        tracker.refreshIgnoreMatchers = async (...args) => {
            await refresh(...args);
            if (!recreated) {
                recreated = true;
                fs.renameSync(source, root);
            }
        };
        try { assert.equal(await tracker.resetBaselineToCurrentState(), false); }
        finally { tracker.refreshIgnoreMatchers = refresh; }
        assert.equal(recreated, true);
        assert.equal(tracker.importedCoverageObligations.has(root), true);
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        for (const directory of directories) {
            assert.equal(tracker.supplementalDirectoryWatchers.get(directory)?.epoch, tracker.sessionEpoch,
                'retry must acquire each current-epoch imported owner');
            assert.ok(handles.some(handle => handle.directory === directory && !handle.closed),
                'retry must retain an open native handle for each imported directory');
        }
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        tracker.fileWatchers.forEach(watcher => watcher.dispose());
        tracker.fileWatchers = [];
        await delay(250);
        fs.writeFileSync(files[1], 'native edit after rejected stale retirement and retry\n');
        try {
            await until('native-only nested edit after stale retirement refusal', () =>
                tracker.getTrackedChanges().some(change => change.filePath === files[1] &&
                    change.currentContent === 'native edit after rejected stale retirement and retry\n'));
        } catch (error) {
            console.error('S4-C retirement retry diagnostics:', JSON.stringify({
                recording: tracker.isRecording, epoch: tracker.sessionEpoch,
                externalWatcherEnabled: tracker.externalWatcherEnabled,
                baseline: tracker.getBaselineState(), gaps: tracker.getSubtreeCoverageGaps(),
                owners: [...tracker.supplementalDirectoryWatchers].map(([directory, owner]) =>
                    ({ directory, epoch: owner.epoch, eventRevision: owner.eventRevision })),
                handles: handles.map(({ directory, closed }) => ({ directory, closed })),
                changes: tracker.getTrackedChanges().map(change =>
                    ({ filePath: change.filePath, currentContent: change.currentContent, unavailableReason: change.unavailableReason }))
            }));
            throw error;
        }
        tracker.stopRecording();
        console.log('PASS HOST-S4-C imported handoff and Issue #45 stopped Clear → Reload → Start retain native observation');
    } finally {
        fs.watch = nativeWatch;
        await tracker.dispose();
        await fs.promises.rm(includedParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.promises.rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.promises.rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
};

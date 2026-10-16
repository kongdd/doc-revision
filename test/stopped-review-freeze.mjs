/** Stop freezes the captured review until an explicit new capture operation.
 * Production tracker and persistence, real bounded temporary workspaces, mocked
 * VS Code boundary only. Explicit archive restore is intentionally different:
 * archived-git-review.mjs retains its current-filesystem reconciliation contract.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function registerStoppedReviewFreeze(h) {
    const { test, Uri, DiffTracker, vscode, file, document, counters, pause, emitWatcher,
        waitUntil, watcherInstances, getTracker, setTracker, setListedFiles,
        setWatchExclude, setVsCodeExcludes, fireConfigurationChanged } = h;
    const pending = (tracker, target) => tracker.getTrackedChanges().find(change => change.filePath === target);
    const review = (tracker, includeTimestamp = false) => tracker.getTrackedChanges()
        .map(({ timestamp, ...change }) => JSON.parse(JSON.stringify({ ...change,
            ...(includeTimestamp ? { timestamp } : {}) })))
        .sort((a, b) => a.filePath.localeCompare(b.filePath));
    const contents = target => fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
    const saved = storage => JSON.parse(contents(path.join(storage, 'session-state.json')));
    const stateFiles = ['session-state.json', 'session-state.last-good.json'];
    const storageImage = storage => fs.readdirSync(storage).sort()
        .map(name => [name, fs.readFileSync(path.join(storage, name)).toString('base64')]);
    async function bounded(promise, description) {
        let timer;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 2000);
            })]);
        } finally { clearTimeout(timer); }
    }

    async function fixture(run, { targetOnly = false } = {}) {
        await getTracker().dispose();
        const previousFolders = vscode.workspace.workspaceFolders;
        const previousGetFolder = vscode.workspace.getWorkspaceFolder;
        const workspace = file('stopped-review-workspace');
        const storage = file('stopped-review-storage');
        fs.mkdirSync(workspace);
        const folder = { uri: Uri.file(workspace), name: 'stopped-review-fixture' };
        vscode.workspace.workspaceFolders = [folder];
        vscode.workspace.getWorkspaceFolder = uri => {
            const relative = path.relative(workspace, uri.fsPath);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
                ? folder : undefined;
        };
        const paths = Object.fromEntries(['target', 'cleanEdit', 'cleanDelete', 'cleanRename',
            'renamedTarget', 'renamedClean', 'newFile'].map(name => [name, path.join(workspace, `${name}.txt`)]));
        for (const target of targetOnly ? [paths.target] : [paths.target, paths.cleanEdit, paths.cleanDelete, paths.cleanRename]) {
            fs.writeFileSync(target, 'baseline\n');
        }
        const listCurrentFiles = () => setListedFiles(fs.readdirSync(workspace)
            .map(name => Uri.file(path.join(workspace, name))));
        listCurrentFiles();
        let tracker = new DiffTracker(Uri.file(storage));
        setTracker(tracker);
        try {
            assert.equal(tracker.startRecording(), true);
            await waitUntil(() => tracker.getBaselineState() === 'ready', 2000);
            fs.writeFileSync(paths.target, 'captured before Stop\n');
            await tracker.readFileAndUpdate(paths.target, Uri.file(paths.target));
            assert.equal(pending(tracker, paths.target)?.currentContent, 'captured before Stop\n');
            const ctx = {
                ...paths, workspace, storage, tracker, listCurrentFiles,
                currentTracker: () => tracker,
                stop: async () => {
                    tracker.stopRecording();
                    assert.equal(tracker.getIsRecording(), false);
                    assert.equal(await tracker.flushPendingPersistence(), true);
                },
                restart: async ({ expected = 'restored', beforeLoad } = {}) => {
                    assert.equal(await tracker.flushPendingPersistence(), true);
                    await tracker.dispose();
                    await beforeLoad?.();
                    listCurrentFiles();
                    tracker = new DiffTracker(Uri.file(storage));
                    setTracker(tracker);
                    assert.equal(await tracker.restorePersistedState(), expected, tracker.getPersistenceIssue());
                    return tracker;
                }
            };
            await run(ctx);
        } finally {
            await tracker.dispose();
            vscode.workspace.workspaceFolders = previousFolders;
            vscode.workspace.getWorkspaceFolder = previousGetFolder;
        }
    }

    for (const policy of ['diffTracker.watchExclude', 'files.exclude', 'search.exclude']) {
        for (const reloadBeforeRefresh of [false, true]) {
            test(`STOP-FREEZE policy refresh preserves captured review (${policy}, reloaded=${reloadBeforeRefresh})`, () => fixture(async ctx => {
                await ctx.stop();
                let tracker = reloadBeforeRefresh ? await ctx.restart() : ctx.tracker;
                const captured = review(tracker, true);
                const baseline = tracker.getOriginalContent(ctx.target);
                if (policy === 'diffTracker.watchExclude') setWatchExclude([path.basename(ctx.target)]);
                else setVsCodeExcludes({ [policy]: { [path.basename(ctx.target)]: true } });
                fireConfigurationChanged(policy);
                await tracker.refreshIgnoreMatchers();
                assert.equal(tracker.isPathIgnored(Uri.file(ctx.target)), true, 'the new matcher must take effect');
                assert.deepEqual(review(tracker, true), captured, 'ordinary policy cannot discard or recapture stopped review');
                assert.equal(tracker.getOriginalContent(ctx.target), baseline);
                assert.equal(await tracker.flushPendingPersistence(), true);
                assert.equal(saved(ctx.storage).stoppedReviews.length, captured.length);
                tracker = await ctx.restart();
                await tracker.refreshIgnoreMatchers();
                assert.deepEqual(review(tracker, true), captured, 'reload and another refresh retain the exact projection');
                assert.equal(tracker.getIsRecording(), false);
            }, { targetOnly: true }));
        }
    }

    test('STOP-FREEZE active legacy policy exclusion still prunes live review', () => fixture(async ctx => {
        setWatchExclude([path.basename(ctx.target)]);
        fireConfigurationChanged('diffTracker.watchExclude');
        await ctx.tracker.refreshIgnoreMatchers();
        assert.equal(pending(ctx.tracker, ctx.target), undefined);
        assert.equal(ctx.tracker.getIsRecording(), true);
    }, { targetOnly: true }));

    const configuredScope = (tracker, excludes = []) => {
        const scope = { kind: 'configured', mode: 'rules', roots: tracker.currentWorkspaceRootIdentities(),
            includes: [], excludes, scopeRevision: '' };
        scope.scopeRevision = createHash('sha256').update(JSON.stringify({ model: 1, mode: scope.mode,
            roots: scope.roots, includes: scope.includes, excludes: scope.excludes })).digest('hex');
        return scope;
    };
    test('STOP-FREEZE configured identity loss preserves capture while actions remain blocked', () => fixture(async ctx => {
        await ctx.stop();
        assert.equal((await ctx.tracker.applyConfiguredMonitoringScope(configuredScope(ctx.tracker), false, () => true)).status, 'applied');
        const captured = review(ctx.tracker, true);
        const token = ctx.tracker.getReviewToken(ctx.target);
        const originalIdentity = ctx.tracker.workspaceRootIdentityForFolder.bind(ctx.tracker);
        // Model an unavailable filesystem identity probe, not a replacement
        // pruning or action algorithm. Both paths still run production guards.
        ctx.tracker.workspaceRootIdentityForFolder = folder => ({ ...originalIdentity(folder), caseSensitive: undefined });
        try {
            await ctx.tracker.refreshIgnoreMatchers();
            assert.deepEqual(review(ctx.tracker, true), captured, 'identity loss must not rewrite frozen content as unavailable');
            const before = contents(ctx.target);
            const result = await ctx.tracker.revertFile(ctx.target, token);
            assert.notEqual(result.status, 'success', JSON.stringify(result));
            assert.equal(contents(ctx.target), before);
            assert.deepEqual(review(ctx.tracker, true), captured);
        } finally { ctx.tracker.workspaceRootIdentityForFolder = originalIdentity; }
        assert.equal(await ctx.tracker.flushPendingPersistence(), true);
        assert.deepEqual(review(await ctx.restart(), true), captured);
    }, { targetOnly: true }));

    for (const discard of [false, true]) {
        test(`STOP-FREEZE explicit stopped scope Apply still honors discard=${discard}`, () => fixture(async ctx => {
            await ctx.stop();
            const captured = review(ctx.tracker, true);
            const scope = configuredScope(ctx.tracker, [{ scope: 'all', pattern: path.basename(ctx.target) }]);
            const result = await ctx.tracker.applyConfiguredMonitoringScope(scope, discard, () => true);
            assert.equal(result.status, discard ? 'applied' : 'conflict', JSON.stringify(result));
            if (!discard) assert.match(result.reason, /confirm discard/i);
            assert.equal(result.capturedBaselines, 0);
            assert.equal(result.discardedReviews, discard ? 1 : 0);
            assert.equal(ctx.tracker.getIsRecording(), false);
            assert.deepEqual(review(ctx.tracker, true), discard ? [] : captured);
            assert.equal(await ctx.tracker.flushPendingPersistence(), true);
            const restored = await ctx.restart();
            assert.deepEqual(review(restored, true), discard ? [] : captured);
        }, { targetOnly: true }));
    }

    async function changeWhileStopped(ctx, targetChange = 'edit') {
        const tracker = ctx.currentTracker();
        if (targetChange === 'delete') fs.unlinkSync(ctx.target);
        else if (targetChange === 'rename') fs.renameSync(ctx.target, ctx.renamedTarget);
        else fs.writeFileSync(ctx.target, 'target edited after Stop\n');
        fs.writeFileSync(ctx.cleanEdit, 'clean file edited after Stop\n');
        fs.unlinkSync(ctx.cleanDelete);
        fs.renameSync(ctx.cleanRename, ctx.renamedClean);
        fs.writeFileSync(ctx.newFile, 'created after Stop\n');
        ctx.listCurrentFiles();
        for (const [kind, target] of [
            [targetChange === 'edit' ? 'change' : 'delete', ctx.target],
            ['change', ctx.cleanEdit], ['delete', ctx.cleanDelete], ['delete', ctx.cleanRename],
            ['create', ctx.renamedClean], ['create', ctx.newFile],
            ...(targetChange === 'rename' ? [['create', ctx.renamedTarget]] : [])
        ]) {
            // Exercise both disposed watcher delivery and public event entrypoints.
            emitWatcher(kind, Uri.file(target));
            if (kind === 'create') await tracker.onExternalFileCreated(Uri.file(target));
            else if (kind === 'delete') await tracker.onExternalFileDeleted(Uri.file(target));
            else await tracker.onExternalFileChanged(Uri.file(target));
        }
    }

    for (const targetChange of ['edit', 'delete', 'rename']) {
        test(`STOP-FREEZE live ${targetChange} keeps captured review and ignores other stopped paths`, () => fixture(async ctx => {
            await ctx.stop();
            const captured = review(ctx.tracker, true);
            const token = ctx.tracker.getReviewToken(ctx.target);
            await changeWhileStopped(ctx, targetChange);
            if (targetChange === 'edit') {
                const doc = document(ctx.target);
                doc.text = 'unsaved editor change after Stop\n'; doc.isDirty = true; doc.version++;
                ctx.tracker.onDocumentChanged({ document: doc, contentChanges: [{ text: doc.text }] });
                ctx.tracker.processDocumentChange(doc);
            }
            assert.deepEqual(review(ctx.tracker, true), captured, 'Stop retains the captured pending review without new paths');
            assert.deepEqual(ctx.tracker.getReviewToken(ctx.target), token, 'stopped events do not silently refresh the review token');
            assert.equal(watcherInstances.some(watcher => watcher.active), false);
            assert.equal(await ctx.tracker.flushPendingPersistence(), true);
        }));

        test(`STOP-FREEZE ordinary reload after ${targetChange} preserves capture across repeated reloads`, () => fixture(async ctx => {
            await ctx.stop();
            const captured = review(ctx.tracker);
            const baselines = [...ctx.tracker.fileSnapshots.entries()].sort();
            await changeWhileStopped(ctx, targetChange);
            const diskBefore = fs.readdirSync(ctx.workspace).sort().map(name => [name, contents(path.join(ctx.workspace, name))]);
            for (let reload = 0; reload < 2; reload++) {
                const restored = await ctx.restart();
                assert.equal(restored.getIsRecording(), false);
                assert.deepEqual(review(restored), captured,
                    'ordinary stopped reload must restore the captured review, not reconcile stopped disk changes');
                assert.deepEqual([...restored.fileSnapshots.entries()].sort(), baselines);
                assert.equal(watcherInstances.some(watcher => watcher.active), false);
                assert.deepEqual(fs.readdirSync(ctx.workspace).sort().map(name => [name, contents(path.join(ctx.workspace, name))]), diskBefore);
            }
        }));
    }

    for (const action of ['Keep', 'Revert']) {
        for (const change of ['disk edit', 'disk deletion', 'disk rename', 'dirty editor']) {
            test(`STOP-FREEZE stale ${action} with ${change} rejects without refreshing review or changing work`, () => fixture(async ctx => {
                await ctx.stop();
                const captured = review(ctx.tracker, true);
                const token = ctx.tracker.getReviewToken(ctx.target);
                assert.ok(token, 'the frozen text review remains inspectable');
                let doc;
                if (change === 'disk deletion') fs.unlinkSync(ctx.target);
                else if (change === 'disk rename') fs.renameSync(ctx.target, ctx.renamedTarget);
                else {
                    fs.writeFileSync(ctx.target, 'disk work after Stop\n');
                    if (change === 'dirty editor') {
                        doc = document(ctx.target);
                        doc.text = 'unsaved work after Stop\n'; doc.isDirty = true; doc.version++;
                    }
                }
                const diskBefore = contents(ctx.target);
                const renamedBefore = contents(ctx.renamedTarget);
                const bufferBefore = doc && { text: doc.getText(), dirty: doc.isDirty, version: doc.version };
                const before = { apply: counters.apply, save: counters.save };
                const result = action === 'Keep'
                    ? await ctx.tracker.keepAllChangesInFile(ctx.target, token)
                    : await ctx.tracker.revertFile(ctx.target, token);
                assert.equal(result.status, 'conflict', JSON.stringify(result));
                assert.equal(contents(ctx.target), diskBefore, 'stale action must preserve disk content and existence');
                assert.equal(contents(ctx.renamedTarget), renamedBefore, 'stale action must preserve the rename destination');
                assert.deepEqual(doc && { text: doc.getText(), dirty: doc.isDirty, version: doc.version }, bufferBefore);
                assert.deepEqual({ apply: counters.apply, save: counters.save }, before);
                assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'baseline\n');
                assert.deepEqual(review(ctx.tracker, true), captured, 'rejection must not refresh a stopped review from disk or buffer');
                assert.deepEqual(ctx.tracker.getReviewToken(ctx.target), token);
                assert.equal(await ctx.tracker.flushPendingPersistence(), true);
            }));
        }

        test(`STOP-FREEZE unchanged ${action} remains available for captured stopped review`, () => fixture(async ctx => {
            await ctx.stop();
            const token = ctx.tracker.getReviewToken(ctx.target);
            const result = action === 'Keep'
                ? await ctx.tracker.keepAllChangesInFile(ctx.target, token)
                : await ctx.tracker.revertFile(ctx.target, token);
            assert.equal(result.status, 'success', JSON.stringify(result));
            assert.equal(pending(ctx.tracker, ctx.target), undefined);
            assert.equal(ctx.tracker.getIsRecording(), false);
            assert.equal(contents(ctx.target), action === 'Keep' ? 'captured before Stop\n' : 'baseline\n');
        }));
    }

    test('STOP-FREEZE explicit Start establishes current baseline and resumes new capture', () => fixture(async ctx => {
        await ctx.stop();
        await changeWhileStopped(ctx);
        assert.equal(ctx.tracker.startRecording(), true);
        await waitUntil(() => ctx.tracker.getBaselineState() === 'ready', 2000);
        assert.equal(ctx.tracker.getIsRecording(), true);
        assert.equal(ctx.tracker.getTrackedChanges().length, 0, 'Start explicitly replaces the frozen review with a fresh baseline');
        for (const target of [ctx.target, ctx.cleanEdit, ctx.renamedClean, ctx.newFile]) {
            assert.equal(ctx.tracker.getOriginalContent(target), contents(target));
        }
        assert.equal(ctx.tracker.getOriginalContent(ctx.cleanDelete), undefined);
        assert.equal(ctx.tracker.getOriginalContent(ctx.cleanRename), undefined);
        fs.writeFileSync(ctx.target, 'new work after explicit Start\n');
        emitWatcher('change', Uri.file(ctx.target));
        await waitUntil(() => pending(ctx.tracker, ctx.target)?.currentContent === 'new work after explicit Start\n', 2000);
        assert.equal(pending(ctx.tracker, ctx.target)?.originalContent, 'target edited after Stop\n');
    }));

    test('STOP-FREEZE active session reload still reconciles current filesystem', () => fixture(async ctx => {
        assert.equal(await ctx.tracker.flushPendingPersistence(), true);
        await ctx.tracker.dispose();
        fs.writeFileSync(ctx.target, 'offline edit while recording remains active\n');
        fs.writeFileSync(ctx.cleanEdit, 'offline edit of clean baseline\n');
        const restored = await ctx.restart();
        assert.equal(restored.getIsRecording(), true);
        assert.equal(pending(restored, ctx.target)?.currentContent, 'offline edit while recording remains active\n');
        assert.equal(pending(restored, ctx.cleanEdit)?.currentContent, 'offline edit of clean baseline\n');
    }));

    test('STOP-FREEZE in-flight watcher read cannot publish bytes across the Stop boundary', () => fixture(async ctx => {
        const captured = review(ctx.tracker, true);
        const gate = pause(ctx.target, 'read');
        fs.writeFileSync(ctx.target, 'uncaptured event before Stop\n');
        await ctx.tracker.onExternalFileChanged(Uri.file(ctx.target));
        try {
            await bounded(gate.entered, 'watcher read reaches the actual file-read boundary');
            assert.ok(ctx.tracker.pendingSnapshotReads.has(ctx.target));
            await ctx.stop();
            fs.writeFileSync(ctx.target, 'new bytes after Stop\n');
            gate.release();
            await waitUntil(() => !ctx.tracker.pendingSnapshotReads.has(ctx.target), 2000);
            assert.deepEqual(review(ctx.tracker, true), captured, 'an older event must not publish after Stop');
            assert.equal(contents(ctx.target), 'new bytes after Stop\n');
            const restored = await ctx.restart();
            assert.deepEqual(review(restored, true), captured, 'the late read must not leak into durable frozen review');
        } finally { gate.release(); }
    }));

    test('STOP-FREEZE queued document debounce cannot capture newer editor bytes after Stop', () => fixture(async ctx => {
        const captured = review(ctx.tracker, true);
        const doc = document(ctx.target);
        doc.text = 'queued but unpublished editor edit\n'; doc.isDirty = true; doc.version++;
        ctx.tracker.onDocumentChanged({ document: doc, contentChanges: [{ text: doc.text }] });
        assert.ok(ctx.tracker.documentChangeTimers.has(ctx.target), 'fixture has a real pending document debounce');
        await ctx.stop();
        doc.text = 'newer editor bytes after Stop\n'; doc.version++;
        await new Promise(resolve => setTimeout(resolve, 160));
        assert.equal(ctx.tracker.documentChangeTimers.size, 0);
        assert.deepEqual(review(ctx.tracker, true), captured);
        assert.equal(doc.getText(), 'newer editor bytes after Stop\n');
        assert.equal(doc.isDirty, true);
        const restored = await ctx.restart();
        assert.deepEqual(review(restored, true), captured, 'reload must not use the still-dirty buffer to refresh stopped review');
        assert.equal(doc.getText(), 'newer editor bytes after Stop\n');
    }));

    test('STOP-FREEZE V5 empty captured review remains empty despite later baseline mutations', () => fixture(async ctx => {
        assert.equal((await ctx.tracker.keepAllChangesInFile(ctx.target)).status, 'success');
        await ctx.stop();
        const state = saved(ctx.storage);
        assert.equal(state.version, 5);
        assert.deepEqual(state.stoppedReviews, [], 'an intentionally empty snapshot is distinct from legacy missing data');
        const baselines = [...ctx.tracker.fileSnapshots.entries()].sort();
        await changeWhileStopped(ctx);
        for (let reload = 0; reload < 2; reload++) {
            const restored = await ctx.restart();
            assert.equal(restored.getIsRecording(), false);
            assert.deepEqual(review(restored), [], 'baseline existence alone must not regenerate stopped diffs');
            assert.deepEqual([...restored.fileSnapshots.entries()].sort(), baselines);
            assert.equal(await restored.flushPendingPersistence(), true);
            assert.deepEqual(saved(ctx.storage).stoppedReviews, []);
        }
    }));

    const malformedSnapshots = [
        ['missing snapshot field', state => { delete state.stoppedReviews; }],
        ['non-array snapshots', state => { state.stoppedReviews = {}; }],
        ['path outside workspace', (state, ctx) => { state.stoppedReviews[0].filePath = path.join(path.dirname(ctx.workspace), 'outside.txt'); }],
        ['duplicate review path', state => { state.stoppedReviews.push({ ...state.stoppedReviews[0] }); }],
        ['missing associated before-image', (state, ctx) => {
            state.fileSnapshots = state.fileSnapshots.filter(([target]) => target !== ctx.target);
            state.baselineExistingFiles = state.baselineExistingFiles.filter(target => target !== ctx.target);
            state.fileModes = state.fileModes.filter(([target]) => target !== ctx.target);
        }],
        ['text review with only unknown before-image', (state, ctx) => {
            state.fileSnapshots = state.fileSnapshots.filter(([target]) => target !== ctx.target);
            state.baselineExistingFiles = state.baselineExistingFiles.filter(target => target !== ctx.target);
            state.fileModes = state.fileModes.filter(([target]) => target !== ctx.target);
            state.unresolvedBaselineFiles.push([ctx.target, 'No known text before-image']);
        }],
        ['missing current content', state => { delete state.stoppedReviews[0].currentContent; }],
        ['invalid timestamp', state => { state.stoppedReviews[0].timestamp = 'yesterday'; }],
        ['contradictory current existence', state => { state.stoppedReviews[0].currentExists = false; }]
    ];
    for (const [name, corrupt] of malformedSnapshots) {
        test(`STOP-FREEZE V5 rejects ${name} without silently rebuilding stopped review`, () => fixture(async ctx => {
            await ctx.stop();
            const state = saved(ctx.storage);
            assert.equal(state.version, 5);
            assert.equal(state.stoppedReviews.length, 1);
            corrupt(state, ctx);
            assert.equal(ctx.tracker.parsePersistedState(state), undefined, 'invalid frozen state must fail schema validation');
            fs.writeFileSync(ctx.target, 'post-Stop work must not be imported or overwritten\n');
            let before;
            const restored = await ctx.restart({ expected: 'blocked', beforeLoad: () => {
                for (const name of stateFiles) fs.writeFileSync(path.join(ctx.storage, name), JSON.stringify(state));
                before = storageImage(ctx.storage);
            } });
            assert.equal(restored.getIsRecording(), false);
            assert.deepEqual(review(restored), []);
            assert.equal(restored.startRecording(), false, 'blocked corrupted storage requires recovery before replacement');
            assert.equal(await restored.flushPendingPersistence(), false);
            await restored.dispose();
            assert.deepEqual(storageImage(ctx.storage), before, 'both invalid files remain available for recovery');
            assert.equal(contents(ctx.target), 'post-Stop work must not be imported or overwritten\n');
        }));
    }

    test('STOP-FREEZE V5 invalid primary recovers frozen last-good snapshot without live reconciliation', () => fixture(async ctx => {
        await ctx.stop();
        const captured = review(ctx.tracker, true);
        const good = saved(ctx.storage);
        const bad = structuredClone(good);
        bad.stoppedReviews.push({ ...bad.stoppedReviews[0] });
        await changeWhileStopped(ctx);
        const restored = await ctx.restart({ expected: 'recovered', beforeLoad: () => {
            fs.writeFileSync(path.join(ctx.storage, stateFiles[0]), JSON.stringify(bad));
            fs.writeFileSync(path.join(ctx.storage, stateFiles[1]), JSON.stringify(good));
        } });
        assert.equal(restored.getIsRecording(), false);
        assert.deepEqual(review(restored, true), captured);
        assert.equal(contents(ctx.target), 'target edited after Stop\n');
        assert.equal(pending(restored, ctx.cleanEdit), undefined);
    }));

    for (const hadPendingReview of [false, true]) {
        test(`STOP-FREEZE legacy V4 missing snapshots is incomplete until explicit Start (pending=${hadPendingReview})`, () => fixture(async ctx => {
            if (!hadPendingReview) {
                fs.writeFileSync(ctx.target, 'baseline\n');
                await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
                assert.deepEqual(review(ctx.tracker), []);
            }
            await ctx.stop();
            const legacy = saved(ctx.storage);
            legacy.version = 4;
            delete legacy.stoppedReviews;
            const baselines = [...ctx.tracker.fileSnapshots.entries()].sort();
            await changeWhileStopped(ctx);
            let restored = await ctx.restart({ expected: 'incomplete', beforeLoad: () => {
                for (const name of stateFiles) fs.writeFileSync(path.join(ctx.storage, name), JSON.stringify(legacy));
            } });
            assert.equal(restored.getIsRecording(), false);
            assert.deepEqual(review(restored), [], 'legacy baselines cannot reveal what was captured before Stop');
            assert.deepEqual([...restored.fileSnapshots.entries()].sort(), baselines);
            assert.match(restored.getPersistenceIssue(), /older stopped session|pending review snapshots/i);
            assert.equal(watcherInstances.some(watcher => watcher.active), false);
            restored = await ctx.restart({ expected: 'incomplete' });
            assert.deepEqual(review(restored), []);
            assert.deepEqual([...restored.fileSnapshots.entries()].sort(), baselines);
            assert.equal(restored.startRecording(), true, 'explicit Start may replace the incomplete legacy capture');
            await waitUntil(() => restored.getBaselineState() === 'ready', 2000);
            assert.equal(restored.getIsRecording(), true);
            assert.equal(restored.getOriginalContent(ctx.target), 'target edited after Stop\n');
            assert.equal(restored.getOriginalContent(ctx.newFile), 'created after Stop\n');
            assert.deepEqual(review(restored), []);
            fs.writeFileSync(ctx.target, 'fresh work after explicit Start\n');
            emitWatcher('change', Uri.file(ctx.target));
            await waitUntil(() => pending(restored, ctx.target)?.currentContent === 'fresh work after explicit Start\n', 2000);
        }));
    }

    test('STOP-FREEZE V5 unknown before-image cannot be promoted to opaque acknowledgement by saved review metadata', () => fixture(async ctx => {
        fs.writeFileSync(ctx.newFile, 'current unknown content\n');
        ctx.tracker.markFileUnavailable(ctx.newFile, 'No captured before-image');
        await ctx.stop();
        const state = saved(ctx.storage);
        const snapshot = state.stoppedReviews.find(change => change.filePath === ctx.newFile);
        assert.equal(snapshot.reviewKind, 'unknown');
        assert.ok(state.unresolvedBaselineFiles.some(([target]) => target === ctx.newFile));
        assert.equal(state.fileSnapshots.some(([target]) => target === ctx.newFile), false);
        assert.equal(state.opaqueBaselineFiles.some(([target]) => target === ctx.newFile), false);
        snapshot.reviewKind = 'opaque';
        delete snapshot.unavailableReason;
        snapshot.currentExists = true;
        snapshot.currentSize = Buffer.byteLength(contents(ctx.newFile), 'utf8');
        snapshot.currentFingerprint = createHash('sha256').update(contents(ctx.newFile)).digest('hex');
        assert.equal(ctx.tracker.parsePersistedState(state), undefined,
            'projection metadata must not bypass the explicit Unknown Reset confirmation');
        const restored = await ctx.restart({ expected: 'blocked', beforeLoad: () => {
            for (const name of stateFiles) fs.writeFileSync(path.join(ctx.storage, name), JSON.stringify(state));
        } });
        assert.equal(restored.getOpaqueReviewToken(ctx.newFile), undefined);
        assert.notEqual((await restored.acknowledgeOpaqueChange(ctx.newFile)).status, 'success');
        assert.equal(contents(ctx.newFile), 'current unknown content\n');
    }));

    test('STOP-FREEZE added file replaced by a directory after Stop retains frozen evidence and durable unrelated reviews', () => fixture(async ctx => {
        fs.writeFileSync(ctx.newFile, 'captured new file\n');
        await ctx.tracker.onExternalFileCreated(Uri.file(ctx.newFile));
        assert.equal(pending(ctx.tracker, ctx.newFile)?.reviewKind, 'text');
        assert.equal(ctx.tracker.getOriginalContent(ctx.newFile), '');
        assert.equal(ctx.tracker.baselineExistingFiles.has(ctx.newFile), false);
        await ctx.stop();
        const captured = review(ctx.tracker, true);
        const snapshots = saved(ctx.storage).stoppedReviews;
        fs.unlinkSync(ctx.newFile);
        fs.mkdirSync(ctx.newFile);
        for (let reload = 0; reload < 2; reload++) {
            const restored = await ctx.restart();
            assert.equal(restored.getOriginalContent(ctx.newFile), '',
                'a new disk directory must not be mistaken for a legacy baseline sentinel');
            assert.deepEqual(review(restored, true), captured);
            assert.deepEqual(saved(ctx.storage).stoppedReviews, snapshots,
                'restore must not publish an empty projection before loading frozen reviews');
            assert.equal(fs.statSync(ctx.newFile).isDirectory(), true);
            assert.equal(contents(ctx.target), 'captured before Stop\n');
        }
    }));

    for (const changedDuringCommit of [false, true]) {
        test(`STOP-FREEZE large-file acknowledgement ${changedDuringCommit ? 'rollback restores exact stopped projection' : 'durably retires the pending reminder'}`, () => fixture(async ctx => {
            fs.truncateSync(ctx.target, 65 * 1024 * 1024);
            await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
            assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
            await ctx.stop();
            const captured = review(ctx.tracker, true);
            const token = ctx.tracker.getLargeFileReminderToken(ctx.target);
            const gate = changedDuringCommit ? pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write') : undefined;
            const operation = ctx.tracker.acknowledgeLargeFileReminder(ctx.target, token);
            try {
                if (gate) {
                    await bounded(gate.entered, 'large-file acknowledgement reaches candidate persistence');
                    fs.truncateSync(ctx.target, 66 * 1024 * 1024);
                    gate.release();
                }
                const result = await operation;
                if (changedDuringCommit) {
                    assert.notEqual(result.status, 'success');
                    assert.deepEqual(review(ctx.tracker, true), captured,
                        'rollback restores the exact frozen review, including its timestamp');
                } else {
                    assert.equal(result.status, 'success', JSON.stringify(result));
                    assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, false);
                    assert.equal(saved(ctx.storage).stoppedReviews.find(change => change.filePath === ctx.target)
                        ?.largeFileReminder?.pending, false,
                    'the durable commit itself cannot restore an already-acknowledged reminder as pending');
                    const restored = await ctx.restart();
                    assert.equal(pending(restored, ctx.target)?.largeFileReminder?.pending, false);
                    assert.equal(restored.getLargeFileReminderToken(ctx.target), undefined);
                }
            } finally { gate?.release(); }
        }));
    }


    test('STOP-FREEZE mixed baseline categories keep their independent persistence capacity after Stop', () => fixture(async ctx => {
        fs.writeFileSync(ctx.newFile, Buffer.from([0, 1]));
        await ctx.tracker.onExternalFileCreated(Uri.file(ctx.newFile));
        assert.equal((await ctx.tracker.acknowledgeOpaqueChange(ctx.newFile)).status, 'success');
        fs.writeFileSync(ctx.newFile, Buffer.from([0, 2]));
        await ctx.tracker.readFileAndUpdate(ctx.newFile, Uri.file(ctx.newFile));
        assert.equal(pending(ctx.tracker, ctx.target)?.reviewKind, 'text');
        assert.equal(pending(ctx.tracker, ctx.newFile)?.reviewKind, 'opaque');
        // Scale the existing per-category limit down without changing production
        // validation. Each category fits, while their pending union has two paths.
        ctx.tracker.maxPersistedSnapshots = 1;
        assert.equal(ctx.tracker.fileSnapshots.size, 1);
        assert.equal(ctx.tracker.opaqueBaselineFiles.size, 1);
        assert.equal(await ctx.tracker.flushPendingPersistence(), true, 'the active session is within supported capacity');
        await ctx.stop();
        const state = saved(ctx.storage);
        assert.equal(state.stoppedReviews.length, 2);
        assert.ok(ctx.tracker.parsePersistedState(state),
            'stopped review capacity follows the validated baseline path union');
        const captured = review(ctx.tracker, true);
        const restored = await ctx.restart();
        assert.deepEqual(review(restored, true), captured);
        assert.equal(restored.getIsRecording(), false);
    }, { targetOnly: true }));


    for (const reminderPending of [false, true]) for (const retainedReview of [false, true]) {
        test(`STOP-FREEZE legacy V4 reminder-only ledger retains missing-review status (pending=${reminderPending}, retained=${retainedReview})`, () => fixture(async ctx => {
            await ctx.stop();
            const legacy = saved(ctx.storage);
            legacy.version = 4;
            delete legacy.stoppedReviews;
            // V4 can record oversized-file metadata without any text, opaque,
            // or unresolved before-image. Its independent ledger still carries
            // pending observation changes and retained-review obligations.
            legacy.fileSnapshots = [];
            legacy.fileModes = [];
            legacy.baselineExistingFiles = [];
            legacy.opaqueBaselineFiles = [];
            legacy.unresolvedBaselineFiles = [];
            legacy.revertHistory = [];
            const observed = { exists: true, size: 66 * 1024 * 1024 };
            const acknowledged = reminderPending ? { exists: true, size: 65 * 1024 * 1024 } : { ...observed };
            legacy.largeFileReminders = [[ctx.target, { observed, acknowledged, retainedReview }]];
            assert.ok(ctx.tracker.parsePersistedState(legacy), 'the reminder-only legacy payload is valid');
            fs.writeFileSync(ctx.target, 'unrecorded replacement after Stop\n');
            fs.writeFileSync(ctx.newFile, 'unrecorded addition after Stop\n');
            const missingReview = reminderPending || retainedReview;
            const expected = missingReview ? 'incomplete' : 'restored';
            let restored = await ctx.restart({ expected, beforeLoad: () => {
                for (const name of stateFiles) fs.writeFileSync(path.join(ctx.storage, name), JSON.stringify(legacy));
            } });
            if (missingReview) {
                assert.match(restored.getPersistenceIssue(), /older stopped session|pending review snapshots/i);
            } else {
                assert.equal(restored.getPersistenceIssue(), undefined,
                    'an acknowledged-only metadata ledger has no missing pending review');
            }
            for (let reload = 0; reload < 2; reload++) {
                if (reload > 0) { restored = await ctx.restart({ expected }); }
                assert.equal(restored.getIsRecording(), false);
                assert.equal(restored.getBaselineState(), missingReview ? 'building' : 'idle');
                assert.deepEqual(review(restored), [], 'legacy metadata must not fabricate a stopped text snapshot');
                assert.deepEqual([...restored.largeFileReminders], legacy.largeFileReminders,
                    'preserve both acknowledged and observed identities plus the retained-review flag');
                if (missingReview) { assert.ok(restored.getPersistenceIssue(), 'the incomplete warning survives reload'); }
                assert.equal(await restored.flushPendingPersistence(), true);
                const upgraded = saved(ctx.storage);
                assert.equal(upgraded.version, 5);
                assert.equal(upgraded.baselineState, missingReview ? 'building' : 'ready',
                    'V5 upgrade must retain incomplete evidence on the next reload');
                assert.deepEqual(upgraded.largeFileReminders, legacy.largeFileReminders);
                assert.deepEqual(upgraded.stoppedReviews, []);
                assert.equal(contents(ctx.target), 'unrecorded replacement after Stop\n');
                assert.equal(contents(ctx.newFile), 'unrecorded addition after Stop\n');
                assert.equal(watcherInstances.some(watcher => watcher.active), false);
            }
        }, { targetOnly: true }));
    }

}

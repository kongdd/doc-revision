import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function registerStoppedReviewActions(h) {
    const { test, Uri, file, seed, scan, pending, pause, document, counters, getTracker } = h;
    const snapshot = tracker => JSON.parse(JSON.stringify(tracker.getTrackedChanges()));
    const baseline = 'first old\nmiddle\nlast old\n';
    const reviewed = 'first new\nmiddle\nlast new\n';

    async function stoppedText() {
        const tracker = getTracker();
        const target = file('stopped-action.txt');
        seed(target, baseline, reviewed);
        await scan(target);
        const storage = file('stopped-action-storage');
        tracker.storageUri = Uri.file(storage);
        tracker.stopRecording();
        assert.equal(await tracker.flushPendingPersistence(), true);
        return { tracker, target, storage };
    }

    for (const action of ['file', 'block']) {
        for (const change of ['disk', 'dirty buffer']) {
            test(`STOP-ACTION ${action} Keep rejects ${change} racing persistence without replacing frozen review`, async () => {
                const { tracker, target, storage } = await stoppedText();
                const before = snapshot(tracker);
                const token = tracker.getReviewToken(target);
                const doc = change === 'dirty buffer' ? document(target) : undefined;
                const gate = pause(path.join(storage, 'session-state.tmp.json'), 'write');
                const operation = action === 'file'
                    ? tracker.keepAllChangesInFile(target, token)
                    : tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, token);
                await gate.entered;
                if (doc) { doc.text = 'new unsaved work\n'; doc.isDirty = true; doc.version++; }
                else { fs.writeFileSync(target, 'new disk work\n'); }
                gate.release();
                const result = await operation;
                assert.notEqual(result.status, 'success', JSON.stringify(result));
                assert.equal(tracker.getOriginalContent(target), baseline);
                assert.deepEqual(snapshot(tracker), before, 'failure keeps exact snapshot including timestamp');
                assert.deepEqual(tracker.getReviewToken(target), token);
                assert.equal(fs.readFileSync(target, 'utf8'), doc ? reviewed : 'new disk work\n');
                if (doc) assert.equal(doc.getText(), 'new unsaved work\n');
            });
        }
    }

    test('STOP-ACTION successful partial Keep changes only the approved frozen block', async () => {
        const { tracker, target, storage } = await stoppedText();
        assert.equal(tracker.getChangeBlocks(target).length, 2);
        const result = await tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId);
        assert.equal(result.status, 'success', JSON.stringify(result));
        assert.equal(tracker.getOriginalContent(target), 'first new\nmiddle\nlast old\n');
        assert.equal(pending(target)?.currentContent, reviewed);
        const frozen = snapshot(tracker);
        fs.writeFileSync(target, 'later disk work\n');
        assert.equal(await tracker.flushPendingPersistence(), true);
        assert.deepEqual(snapshot(tracker), frozen);
        const state = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(state.stoppedReviews.find(review => review.filePath === target)?.currentContent, reviewed);
    });

    test('STOP-ACTION successful file Keep persists an empty stopped pending set', async () => {
        const { tracker, target, storage } = await stoppedText();
        assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
        assert.equal(pending(target), undefined);
        fs.writeFileSync(target, 'later disk work\n');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const state = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.deepEqual(state.stoppedReviews, []);
        assert.equal(tracker.getOriginalContent(target), reviewed);
    });

    test('STOP-ACTION successful partial Revert freezes only its authorized buffer result', async () => {
        const { tracker, target } = await stoppedText();
        const result = await tracker.revertBlock(target, tracker.getChangeBlocks(target)[0].blockId);
        assert.equal(result.status, 'success', JSON.stringify(result));
        const doc = document(target);
        assert.equal(doc.getText(), 'first old\nmiddle\nlast new\n');
        assert.equal(pending(target)?.currentContent, doc.getText());
        assert.equal(fs.readFileSync(target, 'utf8'), reviewed, 'partial Revert remains a buffer edit');
        const frozen = snapshot(tracker);
        doc.text = 'newer unrelated unsaved work\n'; doc.isDirty = true; doc.version++;
        tracker.processDocumentChange(doc);
        const beforeCounters = { apply: counters.apply, save: counters.save };
        assert.equal((await tracker.revertBlock(target, tracker.getChangeBlocks(target)[0].blockId)).status, 'conflict');
        assert.deepEqual(snapshot(tracker), frozen);
        assert.deepEqual({ apply: counters.apply, save: counters.save }, beforeCounters);
        assert.equal(doc.getText(), 'newer unrelated unsaved work\n');
    });

    test('STOP-ACTION stale opaque Acknowledge rejects without changing the frozen identity', async () => {
        const tracker = getTracker();
        const target = file('stopped-opaque.bin');
        seed(target, 'text baseline\n');
        fs.writeFileSync(target, Buffer.from([1, 0, 2, 3]));
        await scan(target);
        assert.equal(pending(target)?.reviewKind, 'opaque');
        tracker.stopRecording();
        const before = snapshot(tracker);
        const token = tracker.getOpaqueReviewToken(target);
        fs.writeFileSync(target, Buffer.from([4, 0, 5, 6]));
        assert.equal((await tracker.acknowledgeOpaqueChange(target, token)).status, 'conflict');
        assert.deepEqual(snapshot(tracker), before);
        assert.deepEqual(fs.readFileSync(target), Buffer.from([4, 0, 5, 6]));
    });

    test('STOP-ACTION opaque Acknowledge persistence race preserves exact frozen review and baseline', async () => {
        const tracker = getTracker();
        const target = file('stopped-opaque-race.bin');
        seed(target, 'text baseline\n');
        fs.writeFileSync(target, Buffer.from([1, 0, 2, 3]));
        await scan(target);
        const storage = file('stopped-opaque-storage');
        tracker.storageUri = Uri.file(storage);
        tracker.stopRecording();
        assert.equal(await tracker.flushPendingPersistence(), true);
        const before = snapshot(tracker);
        const gate = pause(path.join(storage, 'session-state.tmp.json'), 'write');
        const operation = tracker.acknowledgeOpaqueChange(target);
        await gate.entered;
        fs.writeFileSync(target, Buffer.from([4, 0, 5, 6]));
        gate.release();
        assert.notEqual((await operation).status, 'success');
        assert.equal(tracker.getOriginalContent(target), 'text baseline\n');
        assert.deepEqual(snapshot(tracker), before);
        assert.deepEqual(fs.readFileSync(target), Buffer.from([4, 0, 5, 6]));
    });

    for (const action of ['file', 'block', 'opaque']) {
        test(`STOP-ACTION ${action} acceptance does not capture a write just after the durable commit`, async () => {
            const { tracker, target } = await stoppedText();
            if (action === 'opaque') {
                // Set up the opaque review while observing, then freeze it.
                tracker.isRecording = true;
                fs.writeFileSync(target, Buffer.from([1, 0, 2, 3]));
                await scan(target);
                tracker.stopRecording();
                assert.equal(await tracker.flushPendingPersistence(), true);
            }
            const end = tracker.endBaselineTransaction.bind(tracker);
            let injected = false;
            tracker.endBaselineTransaction = (transaction, committed) => {
                end(transaction, committed);
                if (committed && !injected) {
                    injected = true;
                    fs.writeFileSync(target, 'new work after acceptance\n');
                }
            };
            const result = action === 'opaque' ? await tracker.acknowledgeOpaqueChange(target)
                : action === 'file' ? await tracker.keepAllChangesInFile(target)
                : await tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId);
            assert.equal(result.status, 'success', JSON.stringify(result));
            assert.equal(injected, true);
            assert.equal(fs.readFileSync(target, 'utf8'), 'new work after acceptance\n');
            if (action === 'block') {
                assert.equal(pending(target)?.currentContent, reviewed);
                assert.equal(tracker.getOriginalContent(target), 'first new\nmiddle\nlast old\n');
            } else { assert.equal(pending(target), undefined); }
        });
    }

    for (const current of ['text', 'missing']) {
        test(`STOP-ACTION opaque-to-${current} Acknowledge commits no obsolete stopped pending review`, async () => {
            const tracker = getTracker();
            const target = file('stopped-opaque-transition.bin');
            seed(target, 'text baseline\n');
            fs.writeFileSync(target, Buffer.from([1, 0, 2, 3]));
            await scan(target);
            assert.equal((await tracker.acknowledgeOpaqueChange(target)).status, 'success');
            if (current === 'text') fs.writeFileSync(target, 'supported text\n');
            else fs.unlinkSync(target);
            await scan(target);
            assert.equal(pending(target)?.reviewKind, 'opaque');
            const storage = file('stopped-transition-storage');
            tracker.storageUri = Uri.file(storage);
            tracker.stopRecording();
            assert.equal(await tracker.flushPendingPersistence(), true);
            const end = tracker.endBaselineTransaction.bind(tracker);
            let committedState;
            tracker.endBaselineTransaction = (transaction, committed) => {
                end(transaction, committed);
                if (committed) committedState = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
            };
            assert.equal((await tracker.acknowledgeOpaqueChange(target)).status, 'success');
            assert.deepEqual(committedState.stoppedReviews, [], 'the durable commit itself cannot resurrect the accepted opaque review');
            assert.equal(pending(target), undefined);
        });
    }

    test('STOP-ACTION explicit Unknown reset commits the accepted baseline without the old stopped review', async () => {
        const tracker = getTracker();
        const target = file('stopped-unknown.txt');
        fs.writeFileSync(target, 'explicitly accepted new baseline\n');
        tracker.markFileUnavailable(target, 'Previous content is unknown');
        const storage = file('stopped-unknown-storage');
        tracker.storageUri = Uri.file(storage);
        tracker.stopRecording();
        assert.equal(await tracker.flushPendingPersistence(), true);
        const end = tracker.endBaselineTransaction.bind(tracker);
        let committedState;
        tracker.endBaselineTransaction = (transaction, committed) => {
            end(transaction, committed);
            if (committed) committedState = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        };
        const result = await tracker.resetUnknownBaseline(target);
        assert.equal(result.status, 'success', JSON.stringify(result));
        assert.deepEqual(committedState.stoppedReviews, []);
        assert.equal(tracker.getOriginalContent(target), 'explicitly accepted new baseline\n');
        assert.equal(pending(target), undefined);
    });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectDeletedLineGhosts, diffModifiedLine, getInlineRevisions, shortenDeletedText } = require('../out/utils/liveDeletedText');

test('removed words render at valid offsets in the current document', () => {
    const before = 'The model considers only precipitation.';
    const after = 'The model considers precipitation and ET.';
    const { removed, added } = diffModifiedLine(before, after);
    assert.ok(removed.some(part => part.text.includes('only')));
    assert.ok(added.some(part => after.slice(part.start, part.end).includes('and ET')));
    assert.ok(removed.every(part => part.column >= 0 && part.column <= after.length));
});

test('CJK deletions are character-accurate', () => {
    const before = '土壤水分主要由降水决定';
    const after = '土壤水分受降水与蒸散发共同控制';
    const { removed, added } = diffModifiedLine(before, after);
    assert.ok(removed.map(part => part.text).join('').includes('主要由'));
    assert.ok(added.map(part => after.slice(part.start, part.end)).join('').includes('受'));
    assert.ok(removed.every(part => part.column <= after.length));
});

test('repeated CJK character stays with the following text in display and revision offsets', () => {
    const before = '😀针对模型，难以充分考虑水利工程调节等影响的问题，以步骤S4计算';
    const after = '😀针对模型，以步骤S4计算';
    const deleted = '难以充分考虑水利工程调节等影响的问题，';
    const column = after.indexOf('以步骤');
    const revisions = getInlineRevisions(before, after);
    assert.deepEqual(revisions, [{ oldStart: column, oldEnd: column + deleted.length,
        newStart: column, newEnd: column, oldText: deleted, newText: '' }]);
    assert.deepEqual(diffModifiedLine(before, after), { added: [], removed: [{ column, text: deleted }] });
    assert.equal(after.slice(0, column) + deleted + after.slice(column), before);
});

test('independent deletions and additions remain separate', () => {
    const before = '前甲中乙后';
    const after = '前中后新';
    const revisions = getInlineRevisions(before, after);
    assert.deepEqual(revisions.map(item => [item.oldText, item.newText]), [['甲', ''], ['乙', ''], ['', '新']]);
    assert.deepEqual(diffModifiedLine(before, after), {
        added: [{ start: 3, end: 4 }], removed: [{ column: 1, text: '甲' }, { column: 2, text: '乙' }]
    });
});

test('inline offsets reconstruct both texts and match displayed changes', () => {
    let seed = 7;
    const chars = ['甲', '以', '乙', '，', '😀'];
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
    const sample = () => Array.from({ length: next() % 9 }, () => chars[next() % chars.length]).join('');
    for (let i = 0; i < 500; i++) {
        const before = sample();
        const after = sample();
        const revisions = getInlineRevisions(before, after);
        let restored = after;
        for (const item of [...revisions].reverse()) {
            assert.equal(before.slice(item.oldStart, item.oldEnd), item.oldText);
            assert.equal(after.slice(item.newStart, item.newEnd), item.newText);
            restored = restored.slice(0, item.newStart) + item.oldText + restored.slice(item.newEnd);
        }
        assert.equal(restored, before);
        const { added, removed } = diffModifiedLine(before, after);
        assert.deepEqual(added, revisions.filter(item => item.newText).map(item => ({ start: item.newStart, end: item.newEnd })));
        assert.deepEqual(removed, revisions.filter(item => item.oldText).map(item => ({ column: item.newStart, text: item.oldText })));
    }
});

test('group multiline deletion without losing beginning/middle/end anchors', () => {
    const rows = [
        { type: 'deleted', lineNumber: 1, anchorLineNumber: 0, originalLineNumber: 1, segmentId: 1, oldText: 'title' },
        { type: 'deleted', lineNumber: 2, anchorLineNumber: 1, originalLineNumber: 3, segmentId: 2, oldText: 'first' },
        { type: 'deleted', lineNumber: 2, anchorLineNumber: 1, originalLineNumber: 4, segmentId: 2, oldText: 'second' },
        { type: 'deleted', lineNumber: 3, anchorLineNumber: 2, originalLineNumber: 6, segmentId: 3, oldText: 'tail' }
    ];
    assert.deepEqual(collectDeletedLineGhosts(rows), [
        { anchorLine: 0, lineCount: 1, text: 'title' },
        { anchorLine: 1, lineCount: 2, text: 'first ↵ second' },
        { anchorLine: 2, lineCount: 1, text: 'tail' }
    ]);
});

test('long deletions are shortened without mutating tracked original text', () => {
    const input = 'x'.repeat(500) + '\t\n';
    const visual = shortenDeletedText(input, 30);
    assert.equal(visual.length, 31);
    assert.equal(visual.endsWith('…'), true);
    assert.equal(visual.includes('\n'), false);
    assert.equal(input.length, 502);
});

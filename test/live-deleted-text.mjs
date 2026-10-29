const test = require('node:test');
const assert = require('node:assert/strict');
const { collectDeletedLineGhosts, diffModifiedLine, shortenDeletedText } = require('../out/utils/liveDeletedText');

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

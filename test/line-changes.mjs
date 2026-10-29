import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getLineChanges } = require('../out/lineChanges');

test('pairs changed lines and anchors additional deletions', () => {
    const changes = getLineChanges('before\nold\nremoved\nafter\n', 'before\nnew\nafter\n');
    assert.deepEqual(changes.map(c => c.type), ['unchanged', 'modified', 'deleted', 'unchanged']);
    assert.equal(changes[1].originalLineNumber, 2);
    assert.equal(changes[1].lineNumber, 2);
    assert.equal(changes[2].anchorLineNumber, 1);
});

test('preserves additions, deletions, CRLF and unchanged final newline', () => {
    assert.deepEqual(getLineChanges('a\r\nb\r\n', 'a\nb\n').map(c => c.type), ['unchanged', 'unchanged']);
    const added = getLineChanges('a\n', 'a\nb\n');
    assert.equal(added[1].type, 'added');
    assert.equal(added[1].lineNumber, 2);
    const deleted = getLineChanges('a\nb\n', 'b\n');
    assert.equal(deleted[0].anchorLineNumber, 0);
    assert.equal(deleted[0].oldText, 'a');
});

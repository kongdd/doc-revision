import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getInlineRevisions } = require('../out/utils/liveDeletedText');

test('separate Chinese deletions retain baseline and current offsets', () => {
    const original = '设置多组超参数组合，根据统计洪峰时刻流量合格率，检验效果。';
    const current = '设置多组，根据统计洪峰时刻流，检验效果。';
    const revisions = getInlineRevisions(original, current);
    assert.equal(revisions.length, 2);
    assert.deepEqual(revisions.map(item => item.oldText), ['超参数组合', '量合格率']);
    for (const item of revisions) {
        assert.equal(original.slice(item.oldStart, item.oldEnd), item.oldText);
        assert.equal(current.slice(item.newStart, item.newEnd), item.newText);
    }
});

test('long lines do not offer misleading coarse-grained actions', () => {
    assert.deepEqual(getInlineRevisions('a'.repeat(4097), 'b'), []);
});

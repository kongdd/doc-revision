import * as Diff from 'diff';

export interface LineChange {
    type: 'unchanged' | 'added' | 'deleted' | 'modified';
    lineNumber: number;
    originalLineNumber?: number;
    anchorLineNumber?: number;
    oldText?: string;
    newText?: string;
    segmentId?: number;
}

function lines(content: string): string[] {
    const normalized = content.replace(/\r\n|\r/g, '\n');
    if (!normalized) { return []; }
    const result = normalized.split('\n');
    if (normalized.endsWith('\n')) { result.pop(); }
    return result;
}

/** Compare text lines, pairing adjacent removed and added lines as modifications. */
export function getLineChanges(original: string, current: string): LineChange[] {
    const changes: LineChange[] = [];
    let oldLine = 1;
    let newLine = 1;
    let anchor = 0;
    let segment = 0;
    let removed: Array<{ text: string; line: number }> = [];
    const flush = () => {
        for (const item of removed) {
            changes.push({ type: 'deleted', lineNumber: newLine, originalLineNumber: item.line,
                oldText: item.text, anchorLineNumber: anchor, segmentId: segment });
        }
        removed = [];
    };
    for (const part of Diff.diffArrays(lines(original), lines(current))) {
        if (part.removed) {
            segment++;
            removed = part.value.map(text => ({ text, line: oldLine++ }));
        } else if (part.added) {
            if (!removed.length) { segment++; }
            const paired = Math.min(removed.length, part.value.length);
            for (let i = 0; i < paired; i++) {
                changes.push({ type: 'modified', lineNumber: newLine + i, originalLineNumber: removed[i].line,
                    oldText: removed[i].text, newText: part.value[i], segmentId: segment });
            }
            removed = removed.slice(paired);
            flush();
            for (let i = paired; i < part.value.length; i++) {
                changes.push({ type: 'added', lineNumber: newLine + i, newText: part.value[i], segmentId: segment });
            }
            newLine += part.value.length;
        } else {
            flush();
            for (const _line of part.value) {
                changes.push({ type: 'unchanged', lineNumber: newLine, originalLineNumber: oldLine });
                anchor = newLine++;
                oldLine++;
            }
        }
    }
    flush();
    return changes;
}

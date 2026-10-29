import * as Diff from 'diff';

/** Change metadata computed by DiffTracker. Virtual text never modifies the source file. */
export interface DeletedLineChange {
    type: string;
    lineNumber: number;
    originalLineNumber?: number;
    anchorLineNumber?: number;
    oldText?: string;
    segmentId?: number;
}

export interface DeletedLineGhost {
    anchorLine: number; // zero means before the first line
    lineCount: number;
    text: string;
}

export function shortenDeletedText(value: string, limit = 200): string {
    const safe = value.replace(/\t/g, '⇥').replace(/[\r\n\x00-\x08\x0b-\x1f]/g, ' ');
    const maxLength = Math.max(16, limit);
    return safe.length > maxLength ? safe.slice(0, maxLength) + '…' : safe;
}

/** Combine consecutive deletions at the same actual diff-engine anchor. */
export function collectDeletedLineGhosts(changes: readonly DeletedLineChange[]): DeletedLineGhost[] {
    const deleted = changes.filter(change => change.type === 'deleted')
        .sort((a, b) => (a.originalLineNumber ?? 0) - (b.originalLineNumber ?? 0));
    const groups: Array<{
        anchorLine: number;
        segmentId?: number;
        lastOriginalLine?: number;
        texts: string[];
    }> = [];
    for (const change of deleted) {
        const anchorLine = Math.max(0, change.anchorLineNumber ?? change.lineNumber - 1);
        const last = groups[groups.length - 1];
        if (last &&
            last.anchorLine === anchorLine &&
            last.segmentId === change.segmentId &&
            last.lastOriginalLine !== undefined &&
            change.originalLineNumber === last.lastOriginalLine + 1) {
            last.texts.push(change.oldText ?? '');
            last.lastOriginalLine = change.originalLineNumber;
        } else {
            groups.push({
                anchorLine,
                segmentId: change.segmentId,
                lastOriginalLine: change.originalLineNumber,
                texts: [change.oldText ?? '']
            });
        }
    }
    return groups.map(group => ({
        anchorLine: group.anchorLine,
        lineCount: group.texts.length,
        text: shortenDeletedText(group.texts.map(text => text || '∅').join(' ↵ '))
    }));
}

export interface ModifiedLineGhosts {
    added: Array<{ start: number; end: number }>;
    removed: Array<{ column: number; text: string }>;
}

export interface InlineRevision {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    oldText: string;
    newText: string;
}

/** Adjacent insertions and deletions form one independently reviewable revision. */
export function getInlineRevisions(oldText: string, newText: string): InlineRevision[] {
    if (oldText.length + newText.length > 4096) { return []; }
    const isCjk = /[\u2e80-\u9fff\uf900-\ufaff]/.test(oldText + newText);
    const parts = isCjk ? Diff.diffChars(oldText, newText) : Diff.diffWordsWithSpace(oldText, newText);
    const revisions: InlineRevision[] = [];
    let oldOffset = 0;
    let newOffset = 0;
    let revision: InlineRevision | undefined;
    for (const part of parts) {
        if (!part.added && !part.removed) {
            revision = undefined;
            oldOffset += part.value.length;
            newOffset += part.value.length;
            continue;
        }
        if (!revision) {
            revision = { oldStart: oldOffset, oldEnd: oldOffset, newStart: newOffset, newEnd: newOffset, oldText: '', newText: '' };
            revisions.push(revision);
        }
        if (part.removed) {
            revision.oldText += part.value;
            revision.oldEnd = oldOffset += part.value.length;
        } else {
            revision.newText += part.value;
            revision.newEnd = newOffset += part.value.length;
        }
    }
    return revisions;
}

/** Current document columns use UTF-16 offsets, as required by VS Code. */
export function diffModifiedLine(oldText: string, newText: string): ModifiedLineGhosts {
    if (oldText === newText) { return { added: [], removed: [] }; }
    if (oldText.length + newText.length > 4096) {
        return {
            added: newText ? [{ start: 0, end: newText.length }] : [],
            removed: oldText ? [{ column: 0, text: oldText }] : []
        };
    }
    const isCjk = /[\u2e80-\u9fff\uf900-\ufaff]/.test(oldText + newText);
    const parts = isCjk ? Diff.diffChars(oldText, newText) : Diff.diffWordsWithSpace(oldText, newText);
    const added: ModifiedLineGhosts['added'] = [];
    const removed: ModifiedLineGhosts['removed'] = [];
    let column = 0;
    for (const part of parts) {
        if (part.added) {
            added.push({ start: column, end: column + part.value.length });
            column += part.value.length;
        } else if (part.removed) {
            const last = removed[removed.length - 1];
            if (last && last.column === column) { last.text += part.value; }
            else { removed.push({ column, text: part.value }); }
        } else {
            column += part.value.length;
        }
    }
    return { added, removed };
}

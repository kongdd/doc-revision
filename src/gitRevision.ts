import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import * as Diff from 'diff';
import { getInlineRevisions } from './utils/liveDeletedText';
import { DecorationManager } from './decorationManager';
import { DiffTracker, LineChange } from './diffTracker';

interface Repository {
    rootUri: vscode.Uri;
    state: { HEAD?: { commit?: string }; onDidChange: vscode.Event<void> };
    show(ref: string, path: string): Promise<string>;
}

interface GitApi {
    git: { path: string };
    getRepository(uri: vscode.Uri): Repository | null;
}

export interface GitInlineRevision {
    request: number;
    version: number;
    line: number;
    originalLine: number;
    index: number;
    block?: number;
}

interface GitTextBlock {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

function getPureBlocks(original: string, current: string): GitTextBlock[] {
    const blocks: GitTextBlock[] = [];
    let oldOffset = 0;
    let newOffset = 0;
    let block: GitTextBlock | undefined;
    const finish = () => {
        if (block && (block.oldStart === block.oldEnd || block.newStart === block.newEnd)) { blocks.push(block); }
        block = undefined;
    };
    for (const part of Diff.diffLines(original, current)) {
        if (!part.added && !part.removed) {
            finish();
            oldOffset += part.value.length;
            newOffset += part.value.length;
        } else {
            block ??= { oldStart: oldOffset, oldEnd: oldOffset, newStart: newOffset, newEnd: newOffset };
            if (part.removed) { block.oldEnd = oldOffset += part.value.length; }
            else { block.newEnd = newOffset += part.value.length; }
        }
    }
    finish();
    return blocks;
}

export class GitRevision implements vscode.Disposable {
    private enabled = false;
    private request = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private repositoryListener?: vscode.Disposable;
    private repository?: Repository;
    private baseline?: { key: string; content: string };
    private current?: { document: vscode.TextDocument; version: number; changes: LineChange[]; original: string;
        request: number; repository: Repository; commit: string; file: string; gitPath: string };
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    private readonly subscriptions: vscode.Disposable[];

    constructor(private tracker: DiffTracker, private decorations: DecorationManager, private refreshCodeLens: () => void = () => {}) {
        this.status.command = 'diffTracker.toggleGitRevisions';
        this.status.text = '$(git-compare) Git Revisions: Off';
        this.status.tooltip = 'Click to show unstaged Git changes.';
        this.status.show();
        this.subscriptions = [
            vscode.commands.registerCommand('diffTracker.toggleGitRevisions', () => this.toggle()),
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
            tracker.onDidTrackChanges(() => this.schedule()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('diffTracker')) { this.schedule(); }
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document === vscode.window.activeTextEditor?.document) { this.schedule(); }
            })
        ];
    }

    private async toggle() {
        this.enabled = !this.enabled;
        this.decorations.gitRevisionMode = this.enabled;
        void vscode.commands.executeCommand('setContext', 'diffTracker.gitRevisions', this.enabled);
        this.refreshCodeLens();
        this.status.text = `$(git-compare) Git Revisions: ${this.enabled ? 'On' : 'Off'}`;
        this.status.tooltip = this.enabled ? 'Click to hide Git revisions.' : 'Click to show unstaged Git changes.';
        if (this.enabled) {
            await this.refresh(true);
        } else {
            this.request++;
            this.repositoryListener?.dispose();
            this.repositoryListener = undefined;
            this.repository = undefined;
            this.baseline = undefined;
            this.current = undefined;
            this.decorations.clearAllDecorations();
            vscode.window.visibleTextEditors.forEach(editor => this.decorations.updateDecorations(editor));
        }
    }

    private schedule() {
        if (!this.enabled) { return; }
        this.request++;
        this.current = undefined;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), 150);
    }

    private async refresh(notify = false) {
        if (!this.enabled) { return; }
        const request = ++this.request;
        this.current = undefined;
        this.decorations.clearAllDecorations();
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') { return; }
        const version = editor.document.version;
        try {
            const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git');
            if (!extension) { throw new Error('VS Code Git extension is unavailable.'); }
            const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
            if (!this.enabled || request !== this.request) { return; }
            const repository = api.getRepository(editor.document.uri);
            const commit = repository?.state.HEAD?.commit;
            if (!repository || !commit) { throw new Error('The current file is not in a Git repository with a commit.'); }
            if (repository !== this.repository) {
                this.repositoryListener?.dispose();
                this.repository = repository;
                this.repositoryListener = repository.state.onDidChange(() => {
                    this.baseline = undefined;
                    this.schedule();
                });
            }
            const file = path.relative(repository.rootUri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/');
            const key = `${commit}\0${editor.document.uri.toString()}`;
            // Compare against the index so staged revisions are no longer pending.
            const original = await repository.show('', file);
            if (!this.enabled || request !== this.request || editor !== vscode.window.activeTextEditor || version !== editor.document.version) { return; }
            if (original.length > 1024 * 1024 || editor.document.getText().length > 1024 * 1024) {
                throw new Error('Git revisions are limited to files of 1 MiB.');
            }
            this.baseline = { key, content: original };
            const changes = this.tracker.buildDiffViewFromContents(original, editor.document.getText()).lineChanges;
            this.current = { document: editor.document, version, changes, original, request, repository, commit, file, gitPath: api.git.path };
            this.status.tooltip = 'Showing unstaged changes against the Git index. Click to hide.';
            this.decorations.renderLineChanges(editor, changes);
        } catch (error) {
            if (this.enabled && request === this.request) {
                this.status.tooltip = `Git revisions unavailable: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (notify && this.enabled && request === this.request) {
                void vscode.window.showWarningMessage(`Git revisions unavailable for this file: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    public getInlineRevision(document: vscode.TextDocument, position: vscode.Position): GitInlineRevision | undefined {
        const current = this.current;
        if (!current || current.document !== document || current.version !== document.version || !this.enabled) { return; }
        for (const change of current.changes) {
            if (change.type !== 'modified' || change.lineNumber !== position.line + 1 || change.originalLineNumber === undefined ||
                change.oldText === undefined || change.newText !== document.lineAt(position.line).text) { continue; }
            const index = getInlineRevisions(change.oldText, change.newText).findIndex(item =>
                position.character >= item.newStart && position.character <= item.newEnd);
            if (index >= 0) { return { request: current.request, version: current.version, line: position.line,
                originalLine: change.originalLineNumber - 1, index }; }
        }
        const offset = document.offsetAt(position);
        const blocks = getPureBlocks(current.original, document.getText());
        const block = blocks.findIndex(item => item.newStart === item.newEnd
            ? offset === item.newStart || (item.newStart > 0 && offset === item.newStart - 1)
            : offset >= item.newStart && offset <= item.newEnd);
        if (block >= 0) { return { request: current.request, version: current.version, line: position.line,
            originalLine: 0, index: 0, block }; }
        return;
    }

    public async applyInlineRevision(ref: GitInlineRevision, action: 'accept' | 'reject'): Promise<void> {
        const current = this.current;
        const editor = vscode.window.activeTextEditor;
        if (!this.enabled || !current || !editor || editor.document !== current.document || current.version !== ref.version ||
            current.request !== ref.request || current.document.version !== ref.version || current.repository.state.HEAD?.commit !== current.commit) {
            throw new Error('Revision is stale; review it again.');
        }
        const text = current.document.getText();
        let oldStart: number, oldEnd: number, newStart: number, newEnd: number;
        if (ref.block !== undefined) {
            const block = getPureBlocks(current.original, text)[ref.block];
            if (!block) { throw new Error('Revision is stale; review it again.'); }
            ({ oldStart, oldEnd, newStart, newEnd } = block);
        } else {
            const change = current.changes.find(item => item.type === 'modified' && item.lineNumber === ref.line + 1 &&
                item.originalLineNumber === ref.originalLine + 1);
            if (!change || change.oldText === undefined || change.newText === undefined || current.document.lineAt(ref.line).text !== change.newText) {
                throw new Error('Revision is stale; review it again.');
            }
            const revision = getInlineRevisions(change.oldText, change.newText)[ref.index];
            if (!revision || current.original.split(/\r\n|\r|\n/)[ref.originalLine] !== change.oldText) {
                throw new Error('Index changed; review again.');
            }
            let offset = 0;
            for (let i = 0; i < ref.originalLine; i++) {
                const match = /\r\n|\r|\n/g;
                match.lastIndex = offset;
                const eol = match.exec(current.original);
                if (!eol) { throw new Error('Index changed; review again.'); }
                offset = eol.index + eol[0].length;
            }
            oldStart = offset + revision.oldStart;
            oldEnd = offset + revision.oldEnd;
            newStart = current.document.offsetAt(new vscode.Position(ref.line, revision.newStart));
            newEnd = current.document.offsetAt(new vscode.Position(ref.line, revision.newEnd));
        }
        const indexText = await current.repository.show('', current.file);
        if (this.current !== current || current.document.version !== ref.version ||
            current.repository.state.HEAD?.commit !== current.commit || indexText !== current.original) {
            throw new Error('Index or document changed; review again.');
        }
        if (action === 'reject') {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(current.document.uri, new vscode.Range(current.document.positionAt(newStart), current.document.positionAt(newEnd)),
                current.original.slice(oldStart, oldEnd));
            if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Could not discard the revision.'); }
            return;
        }
        if (/[\x00\r\n\t\\]/.test(current.file) || current.file.startsWith('/') || current.file.startsWith('../')) {
            throw new Error('This path cannot be staged safely.');
        }
        const next = current.original.slice(0, oldStart) + text.slice(newStart, newEnd) + current.original.slice(oldEnd);
        const patch = Diff.createTwoFilesPatch(`a/${current.file}`, `b/${current.file}`, current.original, next, '', '');
        await new Promise<void>((resolve, reject) => {
            const child = spawn(current.gitPath, ['apply', '--cached', '--whitespace=nowarn', '-'], { cwd: current.repository.rootUri.fsPath });
            let error = '';
            child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-4096); });
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || 'Git could not stage this revision.')));
            child.stdin.on('error', () => {});
            child.stdin.end(patch);
        });
        this.schedule();
    }

    public getChanges(document: vscode.TextDocument): readonly LineChange[] {
        return this.enabled && this.current?.document === document && this.current.version === document.version
            ? this.current.changes : [];
    }

    dispose() {
        this.request++;
        clearTimeout(this.timer);
        this.repositoryListener?.dispose();
        this.subscriptions.forEach(subscription => subscription.dispose());
        this.status.dispose();
    }
}

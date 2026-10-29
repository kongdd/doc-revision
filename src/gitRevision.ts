import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import * as Diff from 'diff';
import { getInlineRevisions } from './utils/liveDeletedText';
import { DecorationManager } from './decorationManager';
import { getLineChanges, LineChange } from './lineChanges';
import { revisionConfig, revisionEditor, setRevisionSetting } from './revisionSettings';

interface Repository {
    rootUri: vscode.Uri;
    state: { HEAD?: { commit?: string }; onDidChange: vscode.Event<void> };
    show(ref: string, path: string): Promise<string>;
}

interface GitApi {
    git: { path: string };
    onDidOpenRepository: vscode.Event<Repository>;
    onDidChangeState: vscode.Event<string>;
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

export interface GitAllRevisions {
    request: number;
    version: number;
    staged: boolean;
    file: string;
}

interface GitTextBlock {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

function getPureBlocks(original: string, current: string, all = false): GitTextBlock[] {
    const blocks: GitTextBlock[] = [];
    let oldOffset = 0;
    let newOffset = 0;
    let block: GitTextBlock | undefined;
    const finish = () => {
        if (block && (all || block.oldStart === block.oldEnd || block.newStart === block.newEnd)) { blocks.push(block); }
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
    private renderedEditor?: vscode.TextEditor;
    // Index/HEAD contents only change with Git state, so typing must not spawn Git reads.
    private cache?: { repository: Repository; commit: string; file: string; showAll: boolean; index: string; head?: string };
    private epoch = 0;
    private repository?: Repository;
    private api?: GitApi;
    private apiListeners: vscode.Disposable[] = [];
    private current?: { document: vscode.TextDocument; version: number; changes: LineChange[]; original: string;
        staged: boolean; mixed: boolean; index: string; request: number; repository: Repository; commit: string; file: string; gitPath: string };
    private readonly log = vscode.window.createOutputChannel('Git Revisions', { log: true });
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    private readonly subscriptions: vscode.Disposable[];

    constructor(private decorations: DecorationManager, private onChange: () => void = () => {}) {
        this.status.command = 'diffTracker.toggleGitRevisions';
        this.status.text = '$(git-compare) Git Revisions: Off';
        this.status.tooltip = 'Click to show unstaged Git changes.';
        this.status.show();
        this.subscriptions = [
            vscode.commands.registerCommand('diffTracker.toggleGitRevisions', () => this.toggle()),
            vscode.window.onDidChangeActiveTextEditor(() => void this.sync()),
            vscode.window.onDidChangeVisibleTextEditors(() => void this.sync()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('diffTracker.showRevisions')) { void this.sync(); }
                else if (event.affectsConfiguration('diffTracker.showAllChanges')) { void this.sync(true); }
                else if (event.affectsConfiguration('diffTracker')) { this.invalidate(); }
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document === revisionEditor()?.document) { this.schedule(); }
            })
        ];
        void this.sync();
    }

    private async toggle() {
        if (await setRevisionSetting('showRevisions')) { await this.sync(true); }
    }

    private async sync(notify = false) {
        this.enabled = revisionConfig().get<boolean>('showRevisions', false);
        this.log.info(`sync enabled=${this.enabled} editor=${revisionEditor()?.document.uri.toString() ?? 'none'}`);
        this.decorations.gitRevisionMode = this.enabled;
        void vscode.commands.executeCommand('setContext', 'diffTracker.gitRevisions', this.enabled);
        this.onChange();
        this.status.text = `$(git-compare) Git Revisions: ${this.enabled ? 'On' : 'Off'}`;
        this.status.tooltip = this.enabled ? 'Click to hide Git revisions.' : 'Click to show unstaged Git changes.';
        if (this.enabled) {
            await this.refresh(notify);
        } else {
            this.request++;
            this.cache = undefined;
            clearTimeout(this.timer);
            this.repositoryListener?.dispose();
            this.repositoryListener = undefined;
            this.repository = undefined;
            this.current = undefined;
            this.decorations.clearAllDecorations();
            this.renderedEditor = undefined;
        }
    }

    private invalidate(delay = 50) {
        this.cache = undefined;
        this.epoch++;
        this.schedule(delay);
    }

    private schedule(delay = 50) {
        if (!this.enabled) { return; }
        this.request++;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), delay);
    }

    private async refresh(notify = false) {
        if (!this.enabled) { return; }
        const request = ++this.request;
        const editor = revisionEditor();
        if (this.renderedEditor && this.renderedEditor !== editor) {
            this.decorations.clearAllDecorations();
            this.renderedEditor = undefined;
        }
        if (!editor || editor.document.uri.scheme !== 'file') {
            this.current = undefined;
            this.onChange();
            return;
        }
        const version = editor.document.version;
        const started = Date.now();
        this.log.info(`refresh #${request} start`);
        try {
            const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git');
            if (!extension) { throw new Error('VS Code Git extension is unavailable.'); }
            const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
            if (!this.enabled || request !== this.request) { return; }
            if (api !== this.api) {
                this.apiListeners.forEach(listener => listener.dispose());
                this.api = api;
                this.apiListeners = [api.onDidOpenRepository(() => this.invalidate(0)), api.onDidChangeState(() => this.invalidate(0))];
            }
            const repository = api.getRepository(editor.document.uri);
            if (!repository) { throw new Error('The current file is not in an open Git repository.'); }
            if (repository !== this.repository) {
                this.repositoryListener?.dispose();
                this.repository = repository;
                this.repositoryListener = repository.state.onDidChange(() => this.invalidate(this.current ? 50 : 0));
            }
            const commit = repository.state.HEAD?.commit;
            if (!commit) { throw new Error('The Git repository has no commit yet.'); }
            const file = path.relative(repository.rootUri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/');
            const showAll = revisionConfig().get<boolean>('showAllChanges', false);
            let base = this.cache;
            if (!base || base.repository !== repository || base.commit !== commit || base.file !== file || base.showAll !== showAll) {
                const epoch = this.epoch;
                const [index, head] = await Promise.all([repository.show('', file), showAll ? repository.show(commit, file) : undefined]);
                base = { repository, commit, file, showAll, index, head };
                if (epoch === this.epoch) { this.cache = base; }
            }
            const { index, head } = base;
            const original = head ?? index;
            this.log.info(`refresh #${request} Git read ${Date.now() - started}ms`);
            if (!this.enabled || request !== this.request || editor !== revisionEditor() || version !== editor.document.version) { return; }
            const staged = showAll && index === editor.document.getText();
            const mixed = showAll && index !== original && index !== editor.document.getText();
            if (original.length > 1024 * 1024 || editor.document.getText().length > 1024 * 1024) {
                throw new Error('Git revisions are limited to files of 1 MiB.');
            }
            const changes = getLineChanges(original, editor.document.getText());
            this.current = { document: editor.document, version, changes, original, staged, mixed, index, request, repository, commit, file, gitPath: api.git.path };
            this.status.tooltip = showAll ? 'Showing net changes against HEAD. Click to hide.' :
                'Showing unstaged changes against the Git index. Click to hide.';
            this.decorations.renderLineChanges(editor, changes);
            this.renderedEditor = editor;
            this.log.info(`refresh #${request} rendered ${changes.length} changes in ${Date.now() - started}ms`);
            this.onChange();
        } catch (error) {
            this.log.warn(`refresh #${request}: ${error instanceof Error ? error.message : String(error)}`);
            if (this.enabled && request === this.request) {
                this.current = undefined;
                this.onChange();
                this.decorations.clearAllDecorations();
                this.renderedEditor = undefined;
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

    public getDeletedText(document: vscode.TextDocument, position: vscode.Position, ref?: GitInlineRevision): string | undefined {
        const current = this.current;
        if (!this.enabled || !current || current.document !== document || current.version !== document.version) { return; }
        if (ref?.block !== undefined) {
            const block = getPureBlocks(current.original, document.getText())[ref.block];
            return block && current.original.slice(block.oldStart, block.oldEnd) || undefined;
        }
        const change = current.changes.find(item => item.type === 'modified' && item.lineNumber === position.line + 1 &&
            item.newText === document.lineAt(position.line).text && (ref ? item.originalLineNumber === ref.originalLine + 1 : true));
        if (!change || change.oldText === undefined || change.newText === undefined) { return; }
        if (ref) { return getInlineRevisions(change.oldText, change.newText)[ref.index]?.oldText || undefined; }
        if (change.oldText.length + change.newText.length > 4096) { return change.oldText || undefined; }
        return;
    }

    public async applyInlineRevision(ref: GitInlineRevision, action: 'accept' | 'reject'): Promise<void> {
        const current = this.current;
        const editor = vscode.window.activeTextEditor;
        if (!this.enabled || !current || !editor || editor.document !== current.document || current.version !== ref.version ||
            current.request !== ref.request || current.document.version !== ref.version || current.repository.state.HEAD?.commit !== current.commit) {
            throw new Error('Revision is stale; review it again.');
        }
        if (current.staged && action === 'accept') { throw new Error('Staged revisions cannot be accepted again.'); }
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
        await this.applyRange(current, action, [{ oldStart, oldEnd, newStart, newEnd }]);
    }

    public getAllRevisions(document: vscode.TextDocument): GitAllRevisions | undefined {
        const current = this.current;
        if (!this.enabled || !current || current.document !== document || current.version !== document.version || !current.changes.some(change => change.type !== 'unchanged')) { return; }
        return { request: current.request, version: current.version, staged: current.staged, file: current.file };
    }

    public async applyAllRevisions(ref: GitAllRevisions, action: 'accept' | 'reject', selections?: readonly vscode.Range[]): Promise<void> {
        const current = this.current;
        if (!this.enabled || !current || revisionEditor()?.document !== current.document || current.request !== ref.request ||
            current.version !== ref.version || current.document.version !== ref.version || current.repository.state.HEAD?.commit !== current.commit) {
            throw new Error('修订已变化，请重新操作。');
        }
        if (current.staged && action === 'accept') { throw new Error('修订已暂存，无法再次接受。'); }
        const document = current.document;
        const lines = selections?.map(range => [range.start.line, range.end.line > range.start.line && !range.end.character ? range.end.line - 1 : range.end.line]);
        const spans = lines?.map(([start, end]) => [document.offsetAt(new vscode.Position(start, 0)), document.offsetAt(document.lineAt(end).rangeIncludingLineBreak.end)]);
        const blocks = getPureBlocks(current.original, document.getText(), true).filter(block => !spans || spans.some(([start, end]) =>
            block.newStart === block.newEnd ? start <= block.newStart && block.newStart <= end : start < block.newEnd && end > block.newStart));
        if (!blocks.length) { throw new Error('选区内没有修订。'); }
        await this.applyRange(current, action, blocks);
    }

    private async applyRange(current: NonNullable<GitRevision['current']>, action: 'accept' | 'reject',
        blocks: readonly GitTextBlock[]): Promise<void> {
        const text = current.document.getText();
        const indexText = await current.repository.show('', current.file);
        if (this.current !== current || current.document.version !== current.version ||
            current.repository.state.HEAD?.commit !== current.commit || indexText !== current.index) {
            throw new Error('Index or document changed; review again.');
        }
        if (/[\x00\r\n\t\\]/.test(current.file) || current.file.startsWith('/') || current.file.startsWith('../')) {
            throw new Error('This path cannot be staged safely.');
        }
        const git = (args: string[], input?: string) => new Promise<void>((resolve, reject) => {
            const child = spawn(current.gitPath, args, { cwd: current.repository.rootUri.fsPath });
            let error = '';
            child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-4096); });
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || 'Git could not stage this revision.')));
            child.stdin.on('error', () => {});
            child.stdin.end(input);
        });
        // Mixed changes: the index differs from the patch base, so keep context small and let Git relocate hunks.
        const context = current.mixed ? 1 : 4;
        const patch = (from: string, to: string) => Diff.createTwoFilesPatch(`a/${current.file}`, `b/${current.file}`, from, to, '', '', { context });
        const apply = (...args: string[]) => ['apply', ...args, '--whitespace=nowarn', ...current.mixed ? ['-C1'] : [], '-'];
        // Replace each revision in the editor text with its HEAD/index baseline.
        let reverted = text;
        for (const { oldStart, oldEnd, newStart, newEnd } of [...blocks].reverse()) {
            reverted = reverted.slice(0, newStart) + current.original.slice(oldStart, oldEnd) + reverted.slice(newEnd);
        }
        if (action === 'reject' && !current.staged) {
            // Staged and unstaged changes coexist: also unstage this revision when the index still holds it.
            if (current.mixed) {
                await git(apply('--cached', '--check'), patch(text, reverted)).then(() => git(apply('--cached'), patch(text, reverted)), () => undefined);
            }
            const edit = new vscode.WorkspaceEdit();
            for (const { oldStart, oldEnd, newStart, newEnd } of blocks) {
                edit.replace(current.document.uri, new vscode.Range(current.document.positionAt(newStart), current.document.positionAt(newEnd)),
                    current.original.slice(oldStart, oldEnd));
            }
            if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Could not discard the revision.'); }
            return;
        }
        let accepted = current.original;
        for (const { oldStart, oldEnd, newStart, newEnd } of [...blocks].reverse()) {
            accepted = accepted.slice(0, oldStart) + text.slice(newStart, newEnd) + accepted.slice(oldEnd);
        }
        if (current.staged) {
            if (current.document.isDirty) { throw new Error('请先保存或处理未暂存的修改。'); }
            const disk = await vscode.workspace.fs.readFile(current.document.uri);
            if (this.current !== current || current.document.isDirty || current.document.version !== current.version ||
                current.repository.state.HEAD?.commit !== current.commit || !Buffer.from(disk).equals(Buffer.from(text, 'utf8'))) {
                throw new Error('工作区文件已变更；未丢弃修订。');
            }
            // Rewritten files with unchanged content leave stale stat data, which `git apply --index` rejects.
            await git(['update-index', '-q', '--refresh']);
        }
        await git(apply(current.staged ? '--index' : '--cached'), current.staged ? patch(text, reverted) : patch(current.original, accepted))
            .catch(error => { throw current.mixed ? new Error('该修订与暂存区中相邻的修改冲突，无法单独接受。') : error; });
        this.current = undefined;
        this.invalidate();
        if (current.staged && current.document.isDirty) {
            throw new Error('已丢弃暂存区和磁盘中的修订；编辑器有未保存的修改，请检查后保存。');
        }
    }

    public isStaged(document: vscode.TextDocument): boolean {
        return this.enabled && this.current?.document === document && this.current.version === document.version && this.current.staged;
    }

    public getNavigationChanges(document: vscode.TextDocument): readonly LineChange[] | undefined {
        if (this.enabled && this.current?.document === document && this.current.version !== document.version) { return; }
        return this.getChanges(document);
    }

    public getChanges(document: vscode.TextDocument): readonly LineChange[] {
        return this.enabled && this.current?.document === document && this.current.version === document.version
            ? this.current.changes : [];
    }

    dispose() {
        this.request++;
        clearTimeout(this.timer);
        this.repositoryListener?.dispose();
        this.apiListeners.forEach(listener => listener.dispose());
        this.subscriptions.forEach(subscription => subscription.dispose());
        this.status.dispose();
        this.log.dispose();
    }
}

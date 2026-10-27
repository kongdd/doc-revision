import * as vscode from 'vscode';
import { ActionResult, DiffTracker } from './diffTracker';

/** UI-only navigation; batches deliberately never call this wrapper. */
export async function withReviewNavigation(
    tracker: DiffTracker, filePath: string, action: () => Promise<ActionResult>
): Promise<ActionResult> {
    if (!vscode.workspace.getConfiguration('diffTracker').get<boolean>('autoOpenNextPendingFile', false)) {
        return action();
    }
    const paths = tracker.getTrackedChanges().map(change => change.filePath).sort((a, b) => a.localeCompare(b));
    const index = paths.indexOf(filePath);
    const candidates = index < 0 ? [] : [...paths.slice(index + 1), ...paths.slice(0, index)];
    const editor = vscode.window.activeTextEditor;
    const tab = vscode.window.tabGroups?.activeTabGroup.activeTab;
    let switched = false;
    const listener = vscode.window.onDidChangeActiveTextEditor(() => { switched = true; });
    const tabListener = vscode.window.tabGroups?.onDidChangeTabs(event => {
        if ([...event.opened, ...event.changed].some(changed => changed.isActive && changed !== tab)) { switched = true; }
    });
    const groupListener = vscode.window.tabGroups?.onDidChangeTabGroups(() => {
        if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) { switched = true; }
    });
    const canOpen = () => !switched && vscode.window.activeTextEditor === editor &&
        vscode.window.tabGroups?.activeTabGroup.activeTab === tab;
    try {
        const result = await action();
        if (result.status !== 'success' || tracker.getPausedGitRepositories().length > 0 || switched || vscode.window.activeTextEditor !== editor ||
            vscode.window.tabGroups?.activeTabGroup.activeTab !== tab || tracker.getTrackedChange(filePath) ||
            !vscode.workspace.getConfiguration('diffTracker').get<boolean>('autoOpenNextPendingFile', false)) { return result; }
        const next = candidates.find(candidate => tracker.getTrackedChange(candidate));
        if (next) {
            try { await vscode.commands.executeCommand('diffTracker.openDiffDefault', next, canOpen); }
            catch { void vscode.window.showWarningMessage('Code Diff Tracker: Review completed, but the next file could not be opened.'); }
        }
        return result;
    } finally { listener.dispose(); tabListener?.dispose(); groupListener?.dispose(); }
}

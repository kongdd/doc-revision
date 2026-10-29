# Code Diff Tracker

Review unstaged Git changes in the current file using a Word-style revision mode.

## Usage

1. Open an indexed file in a Git repository with an existing commit.
2. Enable revisions from the sidebar or status bar, or press `Shift+Option+G` on macOS (`Shift+Alt+G` on Windows/Linux).
3. Click a revision and use the arrows to navigate, or use the sidebar navigation.
4. **Accept** stages the selected revision. **Reject** reverts it in the editor buffer; save the file to persist the revert. Use **Accept All** or **Reject All** in the revision navigation view to process the current file after confirmation, or select lines and choose **Accept/Reject Selected Revisions** from the editor context menu.
5. For deleted text, select and copy from the revision hover.

Choose **Show Unstaged** or **Show All Changes** (net changes against HEAD). For staged revisions, Accept is disabled and Reject discards the selected change from both index and disk. When staged and unstaged changes coexist, Accept stages a revision and Reject reverts it in both the buffer and, when present, the index; if adjacent staged edits conflict, Git reports it.

Sidebar settings are saved in the current workspace folder's `.vscode/settings.json` and restored on reopening. Backgrounds are off by default; inline revision markers remain visible.

## Limitations

- The built-in VS Code Git extension must be enabled. Files not yet in the index, or files absent from HEAD in the all-changes view, are not supported. Staged changes reversed in the working tree have no net difference and are not shown.
- Files are limited to 1 MiB. Deleted text in the editor is virtual; copy it from the revision hover instead.
- The former recording workflow has been removed. Existing recording data is not deleted, but is no longer read or displayed.

## Development

```sh
npm install
npm test
npm run lint
npm run package
```

[中文说明](README_CN.md)

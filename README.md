# Code Diff Tracker

Review unstaged Git changes in the current file using a Word-style revision mode.

## Usage

1. Open an indexed file in a Git repository with an existing commit.
2. Enable revisions from the sidebar or status bar, or press `Shift+Option+G` on macOS (`Shift+Alt+G` on Windows/Linux).
3. Click a revision and use the arrows to navigate, or use the sidebar navigation.
4. **Accept** stages the selected revision. **Reject** reverts it in the editor buffer; save the file to persist the revert.

Staged changes disappear from the revision display. Modified-line backgrounds are off by default and can be enabled in the sidebar; inline revision markers remain visible.

## Limitations

- The built-in VS Code Git extension must be enabled. Files not yet in the index are not supported.
- Files are limited to 1 MiB. Deleted text is virtual and cannot be selected or copied.
- The former recording workflow has been removed. Existing recording data is not deleted, but is no longer read or displayed.

## Development

```sh
npm install
npm test
npm run lint
npm run package
```

[中文说明](README_CN.md)

# Working with Codex and Claude simultaneously

Each active task needs its own folder AND branch. Branches alone do not isolate files.
The existing checkout has uncommitted work: finish and checkpoint that work before
creating worktrees that need to include it. Worktrees start from committed files.
Never reset, stash, or discard another session's work to make a checkout clean.

From the site repository, create task folders with unique names:

```powershell
git worktree add ../codex-task -b codex/task-name HEAD
git worktree add ../claude-task -b claude/task-name HEAD
```

Open Codex in `codex-task` and Claude in `claude-task`. Tell each tool its folder.
Assign separate preview ports, such as 4173 and 4174. Check the preview URL before
reviewing changes. Keep the original checkout as the release folder; only one
designated session should integrate and deploy. These are conventions, not access
controls: direct Vercel commands can bypass them.

## Release checklist for the designated deployer

1. Obtain explicit permission to deploy. Pause edits in the release folder.
2. Review and commit intended task changes, then integrate the approved commits
   into the release branch. Do not include unrelated dirty work automatically.
3. Check `git status --short`, the branch, the reviewed commit, and the intended
   Vercel project. A release should have a clean working tree.
4. Run relevant checks and review desktop, tablet, and mobile previews.
5. Deploy using an explicit absolute folder, avoiding ambiguity about the shell's
   current directory: `npx vercel C:\milehighjunkremovalsite\site --prod --yes`.
   If releasing from another folder, use that folder instead.
6. Wait for READY, then run `npm run verify:live` in that exact release checkout.
   It compares live homepage and CSS bytes with local files and exits with an
   error on a mismatch. To check additional public files:
   `npm run verify:live -- https://www.milehighjunkremoval.net index.html styles.css book/book.css`.
7. Inspect the production page. Report the URL and verification results. An upload
   success alone does not establish that the intended files are live.

This verification detects mismatches; it does not diagnose which session caused
them or invalidate a phone's cache. If live verification passes but a phone remains
stale, compare a private browser tab before changing cache settings.

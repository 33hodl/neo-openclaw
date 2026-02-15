# Codex GitHub Workflow

## Branch and PR policy

- Start from `main` and create a feature branch (for example: `chore/my-change`).
- Push branch to `origin`.
- Open a PR to `main`.
- Avoid direct commits to `main` unless explicitly required.

## Triggering automerge

- Add the `automerge` label to a PR.
- The `codex-automerge-helper` workflow enables squash auto-merge with branch deletion.
- Merge happens after required checks pass.

## If checks fail

- Open the failing workflow run in the Actions tab.
- Read the failing step logs.
- Push fixes to the same branch.
- Keep PR open; once checks pass, auto-merge proceeds if `automerge` label remains.

## Optional codex-ops dispatch

- Run `codex-ops` workflow manually from Actions.
- Provide:
  - `base_branch` (usually `main`)
  - `new_branch`
  - `patch_file` (a committed `.patch` file path)
  - `pr_title`
- The workflow creates the branch, applies patch, opens PR, and labels `automerge`.

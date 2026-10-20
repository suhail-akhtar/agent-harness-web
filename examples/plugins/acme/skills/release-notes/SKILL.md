---
name: release-notes
description: Write release notes for a version from the git log or a list of changes. Use when asked for release notes or a changelog summary.
---
# Release notes

1. Collect the changes (`git log --oneline <last-tag>..HEAD`, or the list you were given).
2. Group them under **Added**, **Changed**, **Fixed**, **Removed** (omit empty groups).
3. One line per change, user-facing wording, no commit hashes.
4. Start with a one-sentence summary of the release.

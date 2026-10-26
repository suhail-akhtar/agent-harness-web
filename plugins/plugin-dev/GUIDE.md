---
description: Build plugins for the harness and its desktop app - start from a template, test, and review deeply.
---
# Plugin development

- **plugin_new** (name, folder?, language?): a complete working plugin in the workspace to change into the one asked for.
- **plugin_test** (folder): runs its tests (the test kit).
- **plugin_review** (folder): the deep review: OK / NOT READY, a score, each finding with what to do. Fix every error.
- The **build-a-plugin** skill has the procedure and the whole SDK reference (API.md, MANIFEST.md, PAGES.md, TESTING.md, PATTERNS.md): load it before writing a plugin.
- plugin_test and plugin_review run the plugin's code on this computer: only in a session on this computer without a sandbox.
- The person loads the finished folder in the desktop app (Plugins > Developer > Load a plugin folder): it is reviewed, loaded, and shown under Custom.

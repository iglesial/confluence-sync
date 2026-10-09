# Confluence Sync

A GitHub Action that publishes Markdown files from a repository to **Confluence Cloud pages**, creating the ones that don't exist yet.

- **On push:** converts the mapped Markdown files and updates their pages. Pages whose content didn't change are skipped, so page history stays clean.
- **On pull requests:** runs as a **check** and writes nothing. It validates the mapping, converts every page, verifies the pages exist and the token can read them, and renders the diagrams. It then posts one PR comment saying which pages *will update* or *will be created* on merge. Errors fail the check.

The repository is the source of truth. Each page starts with an info panel saying where it comes from, and edits made in Confluence are overwritten by the next sync.

## Setup

### 1. Write the mapping
Add `docs/confluence.json` to your repo. Each entry maps a Markdown file to a page: an **existing** one by its `pageId`, or a **new** one by its `title` and `parent`:

```json
{
  "$schema": "https://raw.githubusercontent.com/iglesial/confluence-sync/v1/schema.json",
  "baseUrl": "https://your-site.atlassian.net/wiki",
  "pages": [
    { "file": "docs/architecture.md", "pageId": "123456" },
    { "file": "docs/runbook.md", "title": "Runbook", "parent": "docs/architecture.md" },
    { "file": "docs/runbook/alerts.md", "title": "Alerts", "parent": "docs/runbook.md" }
  ]
}
```

- **Only the top page needs to exist.** Copy its id from its URL: `…/wiki/spaces/ABC/pages/`**`123456`**`/Title`. Any page can also be given by id, and an id is the most robust reference.
- **Without `pageId`, `title` and `parent` are required.**
  - The page is looked up by `title` in its parent's space. If it's found, it's used as is (and moved under its parent if needed). If it isn't, it's **created under the parent** on merge.
  - Pull request checks show *will create under …*.
  - Two pages with that title in the space is an error: give the entry its `pageId`.
  - A new page can be the parent of another new page: parents are created first.
  - Re-runs find the created pages by title, so nothing is created twice. To record their ids in the mapping, see `pin-created-ids`.
- `file` is relative to the repository root.
- `title` is optional when `pageId` is set: without it the page keeps its current title.
- A leading `# Heading` identical to the page title is dropped, so the title doesn't appear twice.
- `parent` is optional. It's where the page belongs in the page tree: another **mapped file** or a **page id**. A page found elsewhere is moved under its parent at the next sync, as the parent's last child, and PR checks show *will move under …*. The parent must be in the same space. Unmapped parents, a page that is its own parent, and cycles are mapping errors. Without `parent`, the page stays wherever it is in Confluence.

### 2. Add the token
1. Create an API token at **id.atlassian.com → Security → API tokens → Create API token** (the classic kind, without scopes). Use an account that can edit the pages.
2. Store it in the repo: `gh secret set CONFLUENCE_TOKEN`.
3. Store that account's email: `gh variable set CONFLUENCE_EMAIL -b you@example.com`.

### 3. Add the workflow
`.github/workflows/confluence.yml`:

```yaml
name: confluence

on:
  push:
    branches: [main]
    paths: ['docs/**']
  pull_request:
    paths: ['docs/**']
  workflow_dispatch:
    inputs:
      dry_run:
        type: boolean
        default: false

permissions:
  contents: read # contents: write with pin-created-ids
  pull-requests: write # PR preview comment (and the pin PR)

concurrency:
  group: confluence-${{ github.ref }}

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: iglesial/confluence-sync@v1
        with:
          token: ${{ secrets.CONFLUENCE_TOKEN }}
          email: ${{ vars.CONFLUENCE_EMAIL }}
          dry-run: ${{ inputs.dry_run || false }}
```

Pull requests are always checks, whatever `dry-run` says. Unmerged docs never go live.

## Markdown support

| Markdown | In Confluence |
|---|---|
| Headings, emphasis, lists, tables (with alignment), horizontal rules, autolinks | Native formatting |
| ` ```lang ` code blocks, indented code | Code macro with syntax highlighting |
| `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` | Info / tip / info / note / warning panels |
| `- [ ] task` / `- [x] done` (whole list) | Confluence task list |
| `![alt](./img/diagram.png)` | Image uploaded as an attachment (hash-named, uploaded once) |
| `![alt](https://…)` | External image |
| ` ```mermaid ` | Diagram rendered to PNG **on the runner** (no external service) and attached |
| Link to another **mapped** `.md` file | Link to its Confluence page |
| Link to any other repo file | Link to the file on GitHub (default branch) |
| Raw HTML | Escaped and shown as text (Confluence storage must be valid XHTML) |
| YAML front matter | Removed |

Broken image paths, broken relative links, invalid Mermaid and mapping mistakes all fail the run, and on PRs the check, with a clear message per page. Each page is synced independently: one failure doesn't stop the others.

Mermaid rendering downloads `@mermaid-js/mermaid-cli` (headless Chromium) the first time a page needs it, which adds about a minute. Set `mermaid: code` to keep diagrams as code blocks instead.

## Inputs

| Input | Default | Description |
|---|---|---|
| `token` | — | Atlassian API token (with `email`) or bearer PAT. Required to publish; without it the action runs offline checks only, e.g. on PRs from forks. |
| `email` | — | Atlassian account email for basic auth (Confluence Cloud). |
| `config` | `docs/confluence.json` | Mapping file, relative to `working-directory`. |
| `working-directory` | `.` | Folder treated as the repository root (monorepos). |
| `base-url` | — | Overrides `baseUrl` from the mapping. |
| `dry-run` | `false` | Convert, check and read pages, but write nothing. Always on for pull requests. |
| `mermaid` | `local` | `local` renders diagrams; `code` leaves them as code blocks. |
| `banner` | `true` | Info panel "Generated from … Edits made here will be overwritten". |
| `pr-comment` | `true` | One preview comment per PR, updated on each push. |
| `github-token` | `github.token` | Token for the PR comment (`pull-requests: write`), and for the pin PR (`contents: write` too). |
| `pin-created-ids` | `false` | After publishing, open **one pull request** that writes the ids of pages found or created (entries without `pageId`) into the mapping. Needs `contents: write` and `pull-requests: write`. A PR opened with `github.token` doesn't trigger other workflows. |

**Output** `results`: JSON array of `{ file, pageId, url, status, title, error, uploads, createdUnder, foundByTitle, movedUnder }`.
- Each `status` is one of `created`, `will-create`, `updated`, `unchanged`, `will-update`, `checked` or `error`.
- A page to be created has an empty `pageId` and `url` in checks.

## How it works
0. **Pages without `pageId`, parents first:**
   - each is looked up by title in its parent's space (`GET /wiki/api/v2/pages?space-id=…&title=…`);
   - a missing page is validated, then created under its parent with a placeholder body;
   - its content is published in step 3 of the same run.
1. The action reads the page (`GET /wiki/api/v2/pages/{id}`) for its title and version, converts the Markdown to Confluence storage format, and uploads any attachments the page doesn't have yet.
2. It hashes the converted page (title, body, attachment names; the banner's commit is excluded) and compares it with the hash stored in the page's `confluence-sync` content property. If they're equal, the page is skipped.
3. Otherwise it updates the page with the version message `Synced from owner/repo@abc1234`, then stores the new hash.

## Limitations
- Confluence Cloud only: it uses the v2 REST API.
- It creates missing pages, updates existing ones, and moves them when `parent` says so. It never deletes pages, even when they're removed from the mapping.
- A page found or created by title is matched by title on later runs. Renaming it in Confluence, or its `title` in the mapping, creates a new page, unless its `pageId` is pinned.
- Edits made directly in Confluence are overwritten. The banner tells readers this.
- Anchor links (`#section`) are kept as-is. Confluence generates its own heading anchors, so they may not resolve.

## Development

```sh
npm ci
npm test          # converter snapshots, XHTML validity, config and sync logic
npm run build     # bundles to dist/index.js; CI fails if dist/ is stale
```

Release: tag `v1.x.y` and move the `v1` tag.

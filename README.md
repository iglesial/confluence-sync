# Confluence Sync

A GitHub Action that publishes Markdown files from a repository to **existing Confluence Cloud pages**.

- **On push:** converts the mapped Markdown files and updates their pages. Pages whose content didn't change are skipped, so page history stays clean.
- **On pull requests:** runs as a **check** and writes nothing. It validates the mapping, converts every page, verifies the pages exist and the token can read them, and renders the diagrams. It then posts one PR comment saying which pages *will update* on merge. Errors fail the check.

The repository is the source of truth. Each page starts with an info panel saying where it comes from, and edits made in Confluence are overwritten by the next sync.

## Setup

### 1. Create the pages and the mapping
1. Create each target page in Confluence; it can be empty.
2. Copy its id from the URL: `…/wiki/spaces/ABC/pages/`**`123456`**`/Title`.
3. Add `docs/confluence.json` to your repo:

```json
{
  "$schema": "https://raw.githubusercontent.com/iglesial/confluence-sync/v1/schema.json",
  "baseUrl": "https://your-site.atlassian.net/wiki",
  "pages": [
    { "file": "docs/architecture.md", "pageId": "123456" },
    { "file": "docs/runbook.md", "pageId": "123457", "title": "Runbook" }
  ]
}
```

- `file` is relative to the repository root.
- `title` is optional: without it the page keeps its current title.
- A leading `# Heading` identical to the page title is dropped, so the title doesn't appear twice.

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
  contents: read
  pull-requests: write # PR preview comment

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
| `github-token` | `github.token` | Token for the PR comment (`pull-requests: write`). |

**Output** `results`: JSON array of `{ file, pageId, url, status, title, error, uploads }`. Each `status` is one of `updated`, `unchanged`, `will-update`, `checked` or `error`.

## How it works
1. The action reads the page (`GET /wiki/api/v2/pages/{id}`) for its title and version, converts the Markdown to Confluence storage format, and uploads any attachments the page doesn't have yet.
2. It hashes the converted page (title, body, attachment names; the banner's commit is excluded) and compares it with the hash stored in the page's `confluence-sync` content property. If they're equal, the page is skipped.
3. Otherwise it updates the page with the version message `Synced from owner/repo@abc1234`, then stores the new hash.

## Limitations
- Confluence Cloud only: it uses the v2 REST API.
- It updates existing pages; it doesn't create or move pages, or delete pages that were removed from the mapping.
- Edits made directly in Confluence are overwritten. The banner tells readers this.
- Anchor links (`#section`) are kept as-is. Confluence generates its own heading anchors, so they may not resolve.

## Development

```sh
npm ci
npm test          # converter snapshots, XHTML validity, config and sync logic
npm run build     # bundles to dist/index.js; CI fails if dist/ is stale
```

Release: tag `v1.x.y` and move the `v1` tag.

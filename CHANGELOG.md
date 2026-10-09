# Changelog

## v1.2.0

- **Creates missing pages.**
  - `pageId` is now optional. An entry without it needs `title` and `parent`, and is looked up by title in its parent's space: used if found, created under the parent on merge if not.
  - A new page can be the parent of another new page; parents are created first.
  - Re-runs find the created pages by title, so nothing is duplicated.
- **Checks** show *will create under …*, and two pages with the same title in a space is an error.
- **New `pin-created-ids` input** (default `false`): after publishing, opens one pull request that writes the found or created page ids into the mapping. It needs `contents: write` and `pull-requests: write`.
- **New statuses** `created` and `will-create`, and new result fields `createdUnder` and `foundByTitle`.
- Backward compatible: mappings with a `pageId` on every entry behave exactly as before.

## v1.1.0

- Optional `parent` on each entry: the page is moved under it, keeping the Confluence page tree in the mapping.

## v1.0.0

- First release: publish mapped Markdown files to existing Confluence pages, with a check and a preview comment on pull requests.

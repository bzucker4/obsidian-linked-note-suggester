# Linked Note Suggester

Suggest related notes from your vault based on content similarity. Review suggestions in a modal before inserting `[[wikilinks]]`.

[![Sponsor](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=%23EA4AAA)](https://github.com/sponsors/bzucker4)

## Features

- Command and ribbon icon: **Suggest links for current note**
- Keyword similarity (no API required) or optional embeddings API
- Review modal with checkboxes and short reasons
- Insert at cursor or into a `## Related` section
- Exclude folders, adjustable max suggestions and minimum score

## Setup

1. Build: `npm install && npm run build`
2. Copy the folder into `.obsidian/plugins/`
3. Enable the plugin
4. Open a note and use the command or ribbon icon
5. Optionally enable embeddings and set an API key for better results

## Privacy

In keyword mode, nothing leaves your vault. In embeddings mode, note content is sent to the endpoint you configure.

## License

MIT

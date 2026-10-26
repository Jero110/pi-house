# Third-party skills

Skills copied into this folder keep their authors' licenses. Their text is unchanged, except one frontmatter line,
`disable-model-invocation: true`, which keeps them out of the model's automatic skill list: pihouse loads them only when
the plan or the user names them.

| Skills | Source | Commit | License |
| --- | --- | --- | --- |
| Every skill marked "Addy" in `catalog.json`, and `../references/` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | `aeac41d4d005999432bb7312f7ff06383a91d59d` | MIT, [addyosmani-agent-skills.txt](addyosmani-agent-skills.txt) |
| `grilling`, `handoff` | [mattpocock/skills](https://github.com/mattpocock/skills) | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT, [mattpocock-skills.txt](mattpocock-skills.txt) |
| `impeccable` (from `.agents/skills/impeccable`, without its Codex-only `agents/` folder) | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `fdb532263578a179721be817fca6fae6917506c0` | Apache-2.0, [pbakaus-impeccable.txt](pbakaus-impeccable.txt) |

Impeccable's `scripts/impeccable` launcher downloads its engine binary on first use; without it the skill still works
from its Markdown references.

To update: copy the folders from a newer commit of the source, run `npm run skills`, and update the
commit above.

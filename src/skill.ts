// src/skill.ts
//
// The Amdahl capability map (an agent skill), bundled into the CLI from
// skill/SKILL.md. `pnpm sync:skill` refreshes that file from SKILL_URL and
// records the outgoing copy's hash in skill/shipped.json.

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import SKILL from '../skill/SKILL.md'
import SHIPPED from '../skill/shipped.json'

/** Where the capability map is published. */
export const SKILL_URL = 'https://docs.amdahl.ai/skills/amdahl/SKILL.md'

/** The bundled SKILL.md text. */
export const SKILL_TEXT: string = SKILL

/** sha256 of every SKILL.md an earlier release bundled. */
export const SHIPPED_SKILL_SHA256: readonly string[] = SHIPPED

/**
 * True when `text` is a SKILL.md an earlier release installed, byte for byte:
 * an old copy the user never edited, safe to replace with the current one.
 */
export function isShippedSkill(text: string): boolean {
  return SHIPPED_SKILL_SHA256.includes(createHash('sha256').update(text).digest('hex'))
}

/**
 * Each client's documented user-level skills directory:
 * Claude Code `~/.claude/skills` (code.claude.com/docs/en/skills),
 * Codex `$HOME/.agents/skills` (developers.openai.com/codex/skills),
 * Cursor `~/.cursor/skills` (cursor.com/docs/skills).
 */
const SKILL_DIRS: Record<'claude-code' | 'codex' | 'cursor', string[]> = {
  'claude-code': ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
  cursor: ['.cursor', 'skills'],
}

/** Where `amdahl install <client>` writes the skill. */
export function skillPath(client: keyof typeof SKILL_DIRS, home: string): string {
  return join(home, ...SKILL_DIRS[client], 'amdahl', 'SKILL.md')
}

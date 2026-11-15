import { expect, test } from 'bun:test';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

const skillsDir = join(root, '.agents/skills');

test('every shared skill resolves, and harness relays point at the same directory', () => {
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => entry.name);

  expect(names).toContain('poteto-mode');
  expect(names).toContain('compatibility-audit');

  for (const name of names) {
    const canonical = join(skillsDir, name);

    expect(realpathSync(join(canonical, 'SKILL.md')).endsWith(`${name}/SKILL.md`)).toBe(true);

    if (name === 'compatibility-audit') {
      expect(lstatSync(canonical).isSymbolicLink()).toBe(true);
      expect(realpathSync(canonical)).toBe(
        realpathSync(join(root, '.claude/skills/compatibility-audit'))
      );
      continue;
    }

    for (const harness of ['.claude/skills', '.cursor/skills']) {
      const relay = join(root, harness, name);

      expect(lstatSync(relay).isSymbolicLink()).toBe(true);
      expect(realpathSync(relay)).toBe(realpathSync(canonical));
    }
  }
});

test('pstack skill links stay valid from the vendored plugin root', () => {
  const fromSkill = join(skillsDir, 'poteto-help/../../docs/harness/claude-code.md');

  expect(realpathSync(fromSkill)).toBe(
    realpathSync(join(root, '.agents/docs/harness/claude-code.md'))
  );
  expect(readFileSync(join(skillsDir, 'poteto-mode/SKILL.md'), 'utf8')).toContain(
    'name: poteto-mode'
  );
});

test('vendored pstack keeps its MIT notice and the recorded version', () => {
  const vendor = JSON.parse(readFileSync(join(root, '.agents/VENDOR.json'), 'utf8')) as {
    name: string;
    version: string;
    license: string;
  };
  const plugin = JSON.parse(readFileSync(join(root, '.agents/plugin.json'), 'utf8')) as {
    name: string;
    version: string;
    license: string;
  };

  expect(vendor.name).toBe('pstack');
  expect(vendor.version).toBe(plugin.version);
  expect(plugin.license).toBe('MIT');
  expect(readFileSync(join(root, '.agents/LICENSE'), 'utf8')).toContain(
    'Copyright (c) 2026 Lauren Tan'
  );
});

test('pstack subagent briefs resolve for Claude Code and Cursor', () => {
  for (const name of ['poteto-agent', 'comment-sicko']) {
    const canonical = join(root, `.agents/agents/${name}.md`);

    expect(readFileSync(canonical, 'utf8').length).toBeGreaterThan(0);

    for (const relay of [`.claude/agents/${name}.md`, `.cursor/agents/${name}.md`]) {
      const path = join(root, relay);

      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(realpathSync(path)).toBe(realpathSync(canonical));
    }
  }
});

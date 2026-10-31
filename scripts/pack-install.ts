// Packs the package, installs the tarball into an empty temp project and runs `nightjar --help` there.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (cwd: string, cmd: string, args: string[]) =>
	execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const work = mkdtempSync(join(tmpdir(), 'nightjar-pack-'));
try {
	const packed = JSON.parse(
		run(process.cwd(), 'npm', ['pack', '--json', '--pack-destination', work])
	) as { filename: string }[];
	const tarball = join(work, packed[0]?.filename ?? '');
	const project = join(work, 'project');
	run(work, 'mkdir', [project]);
	writeFileSync(join(project, 'package.json'), '{"name":"installed","private":true}\n');
	run(project, 'npm', ['install', '--no-audit', '--no-fund', tarball]);

	const help = run(project, join(project, 'node_modules', '.bin', 'nightjar'), ['--help']);
	if (!/nightjar/i.test(help)) throw new Error('nightjar --help printed nothing about nightjar');

	const pkg = join(project, 'node_modules', '@nonameolsson', 'nightjar');
	for (const file of [
		'plugin/nightjar-status/.claude-plugin/plugin.json',
		'README.md',
		'LICENSE'
	]) {
		if (!existsSync(join(pkg, file))) throw new Error(`the installed package lacks ${file}`);
	}
	console.log('pack and install: nightjar --help works from the tarball');
} finally {
	rmSync(work, { recursive: true, force: true });
}

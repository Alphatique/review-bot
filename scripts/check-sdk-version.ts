import rootPkg from '../package.json' with { type: 'json' };
import runtimePkg from '../dist/package.json' with { type: 'json' };

const SDK = '@anthropic-ai/claude-agent-sdk';

const root = rootPkg.devDependencies[SDK];
const runtime = runtimePkg.dependencies[SDK];

if (root !== runtime) {
	console.error(
		`SDK version mismatch: package.json=${root} dist/package.json=${runtime}`,
	);
	process.exit(1);
}

console.log(`SDK version OK: ${root}`);

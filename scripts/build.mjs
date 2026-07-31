import { stripTypeScriptTypes } from 'node:module';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(projectDir, 'src');
const outputPath = path.join(projectDir, 'handler.js');
const tempPath = `${outputPath}.${process.pid}.tmp`;

const sourceFiles = (await fs.readdir(sourceDir))
  .filter((fileName) => fileName.endsWith('.ts'))
  .sort();
if (sourceFiles.length === 0) throw new Error('No TypeScript source files found under src/');

const sourceParts = await Promise.all(
  sourceFiles.map(async (fileName) => {
    const content = await fs.readFile(path.join(sourceDir, fileName), 'utf-8');
    return `// Source: src/${fileName}\n${content.trimEnd()}`;
  }),
);
const source = `${sourceParts.join('\n\n')}\n`;
const compiled = stripTypeScriptTypes(source, {
  mode: 'transform',
  sourceMap: false,
});
const banner = '// Generated from the ordered src/*.ts files by scripts/build.mjs. Do not edit directly.\n';

try {
  await fs.writeFile(tempPath, `${banner}${compiled}`, 'utf-8');
  await fs.rename(tempPath, outputPath);
} catch (error) {
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
  throw error;
}

console.log(`Built ${path.relative(projectDir, outputPath)}`);

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { clearRuntimeCaches } from '../handler.js';

const temporaryDirectories = [];

export async function makeWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-machine-test-'));
  temporaryDirectories.push(workspace);
  await fs.mkdir(path.join(workspace, 'memory', 'contacts'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'memory', 'groups'), { recursive: true });
  return workspace;
}

export async function write(workspace, relativePath, content) {
  const filePath = path.join(workspace, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

export function hookConfig(overrides = {}) {
  return {
    hooks: {
      internal: {
        entries: {
          'profile-injector': {
            identityResolution: { enabled: true, cacheTtlMs: 60_000, maxFiles: 100 },
            ...overrides,
          },
        },
      },
    },
  };
}

export function registerCleanup() {
  test.afterEach(() => {
    clearRuntimeCaches();
  });

  test.after(async () => {
    clearRuntimeCaches();
    await Promise.all(
      temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });
}

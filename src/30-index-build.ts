async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T);
    }
  }

  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function buildContactIndex(
  contactsDir: string,
  options: { maxFiles?: number; scanConcurrency?: number } = {},
): Promise<ContactIndex> {
  const started = process.hrtime.bigint();
  const maxFiles = boundedInteger(
    options.maxFiles,
    DEFAULT_IDENTITY_MAX_FILES,
    1,
    100_000,
  );
  const directoryEntries = await fs.readdir(contactsDir, { withFileTypes: true });
  const files = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();

  if (files.length > maxFiles) {
    throw new Error(`contact index limit exceeded (${files.length} > ${maxFiles})`);
  }

  const scanConcurrency = boundedInteger(
    options.scanConcurrency,
    DEFAULT_IDENTITY_SCAN_CONCURRENCY,
    1,
    16,
  );
  const parsedFiles = await mapWithConcurrency(files, scanConcurrency, async (fileName) => {
    const filePath = path.join(contactsDir, fileName);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const identities = extractContactIdentities(content);
      const rawFrontmatter = extractFrontmatter(content);
      const rawCandidateCount = rawFrontmatter
        ? (getFrontmatterScalar(rawFrontmatter, 'id') ? 1 : 0) +
          getFrontmatterList(rawFrontmatter, 'identities').length
        : 0;
      return { filePath, identities, ignored: Math.max(0, rawCandidateCount - identities.length) };
    } catch {
      return null;
    }
  });

  const claims = new Map<string, Set<string>>();
  let parsedFileCount = 0;
  let ignoredIdentityCount = 0;

  for (const parsed of parsedFiles) {
    if (!parsed) continue;
    parsedFileCount += 1;
    ignoredIdentityCount += parsed.ignored;

    for (const identity of parsed.identities) {
      const identityClaims = claims.get(identity) ?? new Set<string>();
      identityClaims.add(parsed.filePath);
      claims.set(identity, identityClaims);
    }
  }

  const byIdentity = new Map<string, string>();
  const collisions = new Map<string, string[]>();

  for (const [identity, paths] of claims) {
    const sortedPaths = [...paths].sort();
    if (sortedPaths.length === 1 && sortedPaths[0]) {
      byIdentity.set(identity, sortedPaths[0]);
    } else if (sortedPaths.length > 1) {
      collisions.set(identity, sortedPaths);
    }
  }

  const buildMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    byIdentity,
    collisions,
    fileCount: files.length,
    parsedFileCount,
    identityCount: byIdentity.size,
    ignoredIdentityCount,
    buildMs,
  };
}

async function handleBootstrap(event: any) {
  const context = event.context || {};
  const { sessionKey, workspaceDir, bootstrapFiles, cfg } = context;
  if (!sessionKey || !workspaceDir || !Array.isArray(bootstrapFiles)) return;

  const address = parseSessionAddress(sessionKey);
  if (!address) return;

  const hookConfig = cfg?.hooks?.internal?.entries?.['profile-injector'] || {};
  const createOnMiss = hookConfig.createOnMiss === true;
  const identityOptions = identityResolutionOptions(hookConfig);
  const directories = resolveProfileDirectories(workspaceDir, hookConfig);
  const filesToInject: InjectionItem[] = [];

  if (address.type === 'direct') {
    const resolution = await resolveContactProfile({
      contactsDir: directories.contactsDir,
      channel: address.channel,
      id: address.id,
      options: identityOptions,
    });

    if (resolution.status === 'collision' || resolution.status === 'invalid') return;
    if (resolution.status === 'missing' && createOnMiss && resolution.filePath) {
      await createProfileIfMissing({
        filePath: resolution.filePath,
        templatePath: templatePath(workspaceDir, hookConfig, 'contact'),
        workspaceDir,
        contactsDir: directories.contactsDir,
        channel: address.channel,
        id: address.id,
        kind: 'contact',
      });
    }

    if (resolution.filePath && (await fileExists(resolution.filePath))) {
      filesToInject.push({
        name: 'CONTACT_PROFILE.md',
        filePath: resolution.filePath,
        depth: 'full',
        kind: 'contact',
      });
    }
  } else {
    const groupFilePath = safeProfileFilePath(
      directories.groupsDir,
      address.channel,
      address.id,
    );
    if (!groupFilePath) return;

    if (!(await fileExists(groupFilePath)) && createOnMiss) {
      await createProfileIfMissing({
        filePath: groupFilePath,
        templatePath: templatePath(workspaceDir, hookConfig, 'group'),
        workspaceDir,
        channel: address.channel,
        id: address.id,
        kind: 'group',
      });
    }

    if (await fileExists(groupFilePath)) {
      filesToInject.push({
        name: 'CHANNEL_PROFILE.md',
        filePath: groupFilePath,
        depth: 'full',
        kind: 'channel',
      });

      const groupInclusion = hookConfig.groupInclusion || {};
      if (groupInclusion.enabled === true) {
        try {
          const groupContent = await fs.readFile(groupFilePath, 'utf-8');
          const memberIds = getMemberIds(groupContent);
          const maxContacts = boundedInteger(
            groupInclusion.maxContacts,
            DEFAULT_GROUP_MAX_CONTACTS,
            0,
            100,
          );
          const seenCanonicalPaths = new Set<string>();

          for (const memberId of memberIds.slice(0, maxContacts)) {
            const resolution = await resolveContactProfile({
              contactsDir: directories.contactsDir,
              channel: address.channel,
              id: memberId,
              options: identityOptions,
            });

            if (resolution.status === 'collision' || resolution.status === 'invalid') continue;
            if (resolution.status === 'missing' && createOnMiss && resolution.filePath) {
              await createProfileIfMissing({
                filePath: resolution.filePath,
                templatePath: templatePath(workspaceDir, hookConfig, 'contact'),
                workspaceDir,
                contactsDir: directories.contactsDir,
                channel: address.channel,
                id: memberId,
                kind: 'contact',
              });
            }

            if (
              resolution.filePath &&
              !seenCanonicalPaths.has(resolution.filePath) &&
              (await fileExists(resolution.filePath))
            ) {
              seenCanonicalPaths.add(resolution.filePath);
              filesToInject.push({
                name: memberBootstrapName(memberId),
                filePath: resolution.filePath,
                depth: profileDepth(groupInclusion.profileDepth),
                kind: 'member',
              });
            }
          }
        } catch (error) {
          console.error('[profile-injector] Group member loading failed:', error);
        }
      }
    }
  }

  const maxMemberChars = boundedInteger(
    hookConfig?.groupInclusion?.maxTotalChars,
    DEFAULT_GROUP_MAX_TOTAL_CHARS,
    0,
    1_000_000,
  );
  let injectedMemberChars = 0;

  for (const item of filesToInject) {
    if (
      bootstrapFiles.some(
        (file: any) => file?.name === item.name || path.resolve(file?.path ?? '') === item.filePath,
      )
    ) {
      continue;
    }

    if (item.kind === 'member' && injectedMemberChars >= maxMemberChars) continue;

    try {
      let content = await fs.readFile(item.filePath, 'utf-8');
      const remainingMemberChars =
        item.kind === 'member' ? maxMemberChars - injectedMemberChars : Number.POSITIVE_INFINITY;
      content = capContent(content, item.depth, remainingMemberChars);
      if (item.kind === 'member') injectedMemberChars += content.length;

      bootstrapFiles.push({
        name: item.name,
        path: item.filePath,
        content,
        missing: false,
      });
    } catch (error) {
      console.error(`[profile-injector] Failed to inject ${item.filePath}:`, error);
    }
  }
}

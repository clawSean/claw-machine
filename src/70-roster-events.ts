async function handleRosterEvent(event: any, senderId: unknown, metadata: any = {}) {
  const sessionKey = event.sessionKey;
  if (!sessionKey || senderId === undefined || senderId === null) return;

  const address = parseSessionAddress(sessionKey);
  if (!address || (address.type !== 'group' && address.type !== 'channel')) return;

  const sender = String(senderId).trim();
  if (!isSafeProfileId(sender)) return;

  const context = event.context || {};
  const runtime = await resolveRuntime(context.cfg, context.workspaceDir);
  const hookConfig = runtime.hookConfig;
  if (hookConfig.autoRoster === false) return;

  const directories = resolveProfileDirectories(runtime.workspaceDir, hookConfig);
  const groupFilePath = safeProfileFilePath(
    directories.groupsDir,
    address.channel,
    address.id,
  );
  if (!groupFilePath || !(await fileExists(groupFilePath))) return;

  try {
    const changed = await withFileMutationLock(groupFilePath, async () => {
      const groupContent = await fs.readFile(groupFilePath, 'utf-8');
      const updated = addMemberToFrontmatter(groupContent, sender);
      if (!updated) return false;
      await writeFileAtomically(groupFilePath, updated);
      return true;
    });

    if (changed) {
      console.log(
        `[profile-injector] Auto-rostered ${sender} into ${path.basename(groupFilePath)}`,
      );
    }

    if (hookConfig.createOnMiss === true) {
      const identityOptions = identityResolutionOptions(hookConfig);
      const resolution = await resolveContactProfile({
        contactsDir: directories.contactsDir,
        channel: address.channel,
        id: sender,
        options: identityOptions,
      });

      if (resolution.status === 'missing' && resolution.filePath) {
        const senderName =
          metadata?.senderName ||
          metadata?.sender_name ||
          metadata?.displayName ||
          metadata?.display_name ||
          '';
        await createProfileIfMissing({
          filePath: resolution.filePath,
          templatePath: templatePath(runtime.workspaceDir, hookConfig, 'contact'),
          workspaceDir: runtime.workspaceDir,
          contactsDir: directories.contactsDir,
          channel: address.channel,
          id: sender,
          kind: 'contact',
          displayName: senderName,
        });
      }
    }
  } catch (error) {
    console.error('[profile-injector] Auto-roster failed:', error);
  }
}

async function handleMessageReceived(event: any) {
  const metadata = event.context?.metadata || {};
  const senderId = metadata.senderId ?? metadata.sender_id;
  await handleRosterEvent(event, senderId, metadata);
}

async function handleCommandNew(event: any) {
  await handleRosterEvent(event, event.context?.senderId, event.context || {});
}

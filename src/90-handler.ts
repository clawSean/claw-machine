const handler = async (event: any) => {
  if (event.type === 'agent' && event.action === 'bootstrap') {
    return handleBootstrap(event);
  }
  if (event.type === 'message' && event.action === 'received') {
    return handleMessageReceived(event);
  }
  if (event.type === 'command' && event.action === 'new') {
    return handleCommandNew(event);
  }
};

export {
  addMemberToFrontmatter,
  buildContactIndex,
  capContent,
  clearRuntimeCaches,
  extractContactIdentities,
  getMemberIds,
  invalidateContactIndex,
  normalizeIdentity,
  parseSessionAddress,
  renderProfileTemplate,
  resolveContactProfile,
};

export default handler;

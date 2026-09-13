function configurePermissions(session, ownsContents) {
  const allowed = (contents, permission) => !!contents && ownsContents(contents) && ['media', 'display-capture', 'fullscreen'].includes(permission);
  session.setPermissionCheckHandler(allowed);
  session.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
}
module.exports = { configurePermissions };
